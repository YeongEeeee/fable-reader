/**
 * src/reader.js
 * ───────────────────────────────────────────────────────────────
 * EpubReader — epub.js 인스턴스 생성 · 렌더링 · 타임아웃 가드 · 자원 해제
 * 전용 샌드박스 레이어
 *
 * 보존된 스펙:
 *   - [B1] 비동기 런타임 가드 (window.ePub + window.JSZip 동시 검사, 3s 재시도)
 *   - book.ready 타임아웃 가드 (awaitBookReady) — 멈춤 방지
 *   - 테마 등록 / FOUC 스타일 주입 / 다크 이미지 감쇄
 *   - rendition 엔진 초기화 / relocated 진행률 / CFI 메모이제이션
 *   - 자원 해제 파이프라인 (destroyCurrentRenditionContext)
 *   - NavGuard (스와이프 관성 + 리사이즈 마스크), locations 백그라운드 생성
 *   - 가로↔세로 flow 전환 (CFI 보정)
 *
 * ※ Vite/ESM 인터롭:
 *   epub.js(0.3.x)는 전역 window.JSZip을 요구하는 UMD 빌드이므로,
 *   ensureEpubRuntime()이 'jszip'·'epubjs'를 동적 import 하여
 *   window.JSZip / window.ePub 전역에 1회 주입한다.
 *
 * ※ 순환 의존성 차단:
 *   UI 계층(서재 렌더, 통계, 검색, 주석 등) 콜백은 registerReaderDeps()로
 *   부트스트랩 시점에 주입받는다. (main.js가 와이어링)
 * ─────────────────────────────────────────────────────────────── */

'use strict';

import {
  store, ReactiveStore, DOMProxy, ErrorBoundary, Toast,
  setTextSafe, LH_MAP, ResourceRegistry,
  showViewerScreen, showUploaderScreen, LoadingOverlay, ResizeMask,
} from './store.js';
import { StorageSystem } from './database.js';

/*
 * ┌─────────────────────────────────────────────────────────────┐
 * │ EPUB 엔진 정적 import (Vite 번들러가 항상 경로를 재작성)      │
 * │                                                             │
 * │ ⚠️ 과거 버그: ensureEpubRuntime()에서 `await import('jszip')`│
 * │   처럼 '베어 스펙(bare specifier)'을 동적 import 하면, 빌드   │
 * │   산출물이 아닌 원본 src가 노출되거나 번들 해석이 어긋난      │
 * │   환경(Cloudflare 정적 배포 등)에서                          │
 * │   "Failed to resolve module specifier 'jszip'" 로 크래시.    │
 * │                                                             │
 * │ ✅ 해결: 정적 import로 전환. Vite는 정적 import 경로를 빌드   │
 * │   시 100% 실제 청크 경로로 재작성하므로 베어 스펙 해석 실패가 │
 * │   원천 차단된다. epub.js(UMD)는 평가 시점에 window.JSZip을    │
 * │   읽으므로, JSZip 전역을 epubjs 평가 이전에 주입해야 한다.    │
 * │   → 본 파일 상단에서 jszip을 먼저 import·전역 주입한 뒤        │
 * │     epubjs를 import 한다 (모듈 평가 순서 = import 선언 순서). │
 * └─────────────────────────────────────────────────────────────┘
 */
import JSZipLib from 'jszip';
/* epubjs 평가 이전에 JSZip 전역을 확정 주입 (UMD 의존성 체인 보존) */
if (typeof window !== 'undefined' && typeof window.JSZip !== 'function' && JSZipLib) {
  window.JSZip = JSZipLib.default || JSZipLib;
}
import ePubLib from 'epubjs';
if (typeof window !== 'undefined' && typeof window.ePub !== 'function' && ePubLib) {
  window.ePub = ePubLib.default || ePubLib;
}

/* ══════════════════════════════════════════════════════════
   의존성 주입 레지스트리 (순환 import 차단)
   ══════════════════════════════════════════════════════════ */
const deps = {
  renderTocSidebar:   () => {},
  updateTocActiveItem: () => {},
  ReadingStatsTracker: { startSession() {}, stopSession() {}, markPosition() {} },
  SearchEngine:        { build() {}, destroy() {} },
  VirtualSearchList:   { destroy() {} },
  AnnotationManager:   { init() {}, restoreAll() {}, reset() {} },
  HashWorker:          { compute: async () => '' },
  refreshLibraryData:  async () => {},
  handleKeyDown:       () => {},
  bindScrollTopButton: () => {},
};

export function registerReaderDeps(overrides) {
  Object.assign(deps, overrides);
}

/* ══════════════════════════════════════════════════════════
   epub.js 런타임 부트 — 전역 주입 확인 + CDN 폴백
   ══════════════════════════════════════════════════════════ */
let _epubRuntimePromise = null;

/* 마지막 안전망: 정적 import가 어떤 이유로든 전역을 주입하지 못한
   극단적 환경에서, CDN UMD 스크립트를 주입해 window 전역을 복구한다. */
function _loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('script load failed: ' + src));
    document.head.appendChild(s);
  });
}

async function _cdnFallback() {
  /* JSZip → epub.js 순서 보장 (UMD 의존성) */
  if (typeof window.JSZip !== 'function') {
    try { await _loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'); }
    catch (_) { try { await _loadScript('https://unpkg.com/jszip@3.10.1/dist/jszip.min.js'); } catch (_) {} }
  }
  if (typeof window.ePub !== 'function') {
    try { await _loadScript('https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js'); }
    catch (_) { try { await _loadScript('https://unpkg.com/epubjs@0.3.93/dist/epub.min.js'); } catch (_) {} }
  }
}

export function ensureEpubRuntime() {
  if (_epubRuntimePromise) return _epubRuntimePromise;
  _epubRuntimePromise = (async () => {
    try {
      /* 1차: 정적 import가 이미 전역을 주입했는지 확인 */
      if (typeof window.JSZip !== 'function' && JSZipLib) {
        window.JSZip = JSZipLib.default || JSZipLib;
      }
      if (typeof window.ePub !== 'function' && ePubLib) {
        window.ePub = ePubLib.default || ePubLib;
      }
      /* 2차: 그래도 비어 있으면 CDN UMD 폴백 (모듈 해석 실패 환경 복구) */
      if (!isEpubRuntimeReady()) {
        await _cdnFallback();
      }
      return isEpubRuntimeReady();
    } catch (err) {
      ErrorBoundary.handle('renderer', err, 'ensureEpubRuntime');
      return false;
    }
  })();
  return _epubRuntimePromise;
}

/* ══════════════════════════════════════════════════════════
   §16. [B1] ePub 비동기 런타임 가드
   ══════════════════════════════════════════════════════════ */
export function isEpubRuntimeReady() {
  /* epub.js 0.3.x는 JSZip 전역을 요구하므로 둘 다 검사 */
  return typeof window.ePub === 'function' && typeof window.JSZip === 'function';
}

export async function waitForEpubJS(maxWaitMs = 3000) {
  if (isEpubRuntimeReady()) return true;
  /* ESM 환경: 동적 import로 런타임 부트 시도 */
  await ensureEpubRuntime();
  if (isEpubRuntimeReady()) return true;

  return new Promise((resolve) => {
    const start    = Date.now();
    const interval = setInterval(() => {
      if (isEpubRuntimeReady()) {
        clearInterval(interval);
        resolve(true);
        return;
      }
      if (Date.now() - start >= maxWaitMs) {
        clearInterval(interval);
        if (typeof window.ePub === 'function' && typeof window.JSZip !== 'function') {
          console.warn('[Fable] JSZip 전역이 로드되지 않았습니다. EPUB 압축 해제가 실패할 수 있습니다.');
        }
        resolve(false);
      }
    }, 50);
  });
}

/**
 * book.ready 타임아웃 가드 — 영원히 pending 되는 멈춤 방지
 */
export function awaitBookReady(book, ms = 12000) {
  return Promise.race([
    book.ready.then(() => true).catch(() => false),
    new Promise((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

/* ══════════════════════════════════════════════════════════
   [2]-6 CFI 디코딩 메모이제이션 (위치 역산 가속)
   ══════════════════════════════════════════════════════════ */
export const CFICache = (() => {
  let cfiToPct = new Map();
  let pctToCfi = new Map();

  function getPct(cfi, computeFn) {
    if (cfiToPct.has(cfi)) return cfiToPct.get(cfi);
    const v = computeFn();
    if (typeof v === 'number' && !isNaN(v)) cfiToPct.set(cfi, v);
    return v;
  }
  function getCfi(pct, computeFn) {
    const key = Math.round(pct * 1000);
    if (pctToCfi.has(key)) return pctToCfi.get(key);
    const v = computeFn();
    if (v) pctToCfi.set(key, v);
    return v;
  }
  function clear() { cfiToPct.clear(); pctToCfi.clear(); }
  return { getPct, getCfi, clear };
})();

/* ══════════════════════════════════════════════════════════
   §14. 진행률 UI + 퍼센트 IndexedDB 동기화
   ══════════════════════════════════════════════════════════ */
let _lastSyncedPct = -1;

export function resetSyncedPct() { _lastSyncedPct = -1; }

export function updateProgressUI(location) {
  if (!location) return;
  let pct = 0;

  if (store.totalLocations > 0 && store.book?.locations) {
    try {
      /* [2]-6 메모이제이션된 CFI→퍼센트 역산 */
      const ratio = CFICache.getPct(location.start.cfi, () => store.book.locations.percentageFromCfi(location.start.cfi));
      if (typeof ratio === 'number' && !isNaN(ratio)) pct = Math.round(ratio * 100);
    } catch (_) {}
  }
  if (pct === 0 && location.start.index >= 0) {
    pct = Math.round((location.start.index / (store.book?.spine?.items?.length || 1)) * 100);
  }
  pct = Math.min(100, Math.max(0, pct));

  DOMProxy.get('progress-bar-fill').style.width = `${pct}%`;
  DOMProxy.q('.progress-bar-track').setAttribute('aria-valuenow', pct);
  setTextSafe(DOMProxy.get('viewer-progress-text'), `${pct}%`);

  /* [요구3] 퍼센트 이동 드래그 바 동기화 (드래그 중이 아닐 때만) */
  const slider = DOMProxy.get('progress-range-slider');
  if (slider && slider !== DOMProxy.VOID_NODE && !slider.dataset.dragging) {
    slider.value = pct;
  }

  const si = location.start.location >= 0 ? location.start.location + 1 : '-';
  const ei = location.end.location   >= 0 ? location.end.location   + 1 : '-';
  const tt = store.totalLocations    >  0 ? store.totalLocations        : '-';
  setTextSafe(DOMProxy.get('reading-location-range'), `${si}\u2013${ei} / ${tt}`);

  /* [요구2] 읽은 기록 동기화 — updateBookProgress 내부 300ms 디바운스 가드가 처리 */
  if (store.bookKey && pct !== _lastSyncedPct) {
    _lastSyncedPct = pct;
    StorageSystem.updateBookProgress(store.bookKey, pct);
  }
}

/* ══════════════════════════════════════════════════════════
   §15. [L1] 표지 이미지 추출
   ══════════════════════════════════════════════════════════ */
export async function extractCoverDataUrl(book) {
  try {
    const coverPath = await book.loaded.cover;
    if (!coverPath) return null;

    const coverUrl = await book.archive.createUrl(coverPath, { base64: true });
    if (!coverUrl) return null;

    if (coverUrl.startsWith('data:')) return coverUrl;

    return await new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const MAX = 200;
          const ratio = Math.min(MAX / img.width, MAX / img.height, 1);
          canvas.width  = Math.round(img.width  * ratio);
          canvas.height = Math.round(img.height * ratio);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.7));
        } catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = coverUrl;
    });
  } catch (_) {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════
   §16. 책 열기 (메인 진입)
   ══════════════════════════════════════════════════════════ */
export async function openEpubBook(fileData, isBuffer = false) {
  /* [B1] ePub 가드 */
  const epubReady = await waitForEpubJS();
  if (!epubReady) {
    Toast.show('EPUB 엔진(epub.js/JSZip)을 로드하지 못했습니다. 네트워크 확인 후 새로고침해 주세요.', 'error');
    return;
  }

  showViewerScreen();
  LoadingOverlay.show('도서 버퍼를 확장하는 중...');
  await destroyCurrentRenditionContext();

  /* [B2] 전체 파싱 스트림을 ErrorBoundary.wrap('renderer')으로 완전 래핑 */
  const result = await ErrorBoundary.wrap('renderer', async () => {
    /* 타임아웃 가드 15s */
    const book = await Promise.race([
      new Promise((res, rej) => {
        try {
          const b = window.ePub(fileData);
          b.ready.then(() => res(b)).catch(rej);
        } catch (e) { rej(e); }
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('도서 디코딩 타임아웃 (15s)')), 15000)),
    ]);
    store.book = book;

    let title = '제목 없음', creator = '';
    try {
      const meta = await book.loaded.metadata;
      title   = meta.title   || '제목 없음';
      creator = meta.creator || '';
    } catch (_) {}

    let toc = [];
    try {
      const nav = await book.loaded.navigation;
      toc = nav.toc || [];
    } catch (_) {}

    setTextSafe(DOMProxy.get('nav-book-title'), title);
    store.bookKey = 'fable_cfi_' + (title + creator).replace(/[^a-zA-Z0-9가-힣]/g, '_').slice(0, 50);
    _lastSyncedPct = -1; /* 새 책 — 진행률 동기화 캐시 초기화 */

    /* [L1] 서재 저장 (표지 + 파일 해시 포함) */
    if (!isBuffer && fileData instanceof File) {
      const buf          = await fileData.arrayBuffer();
      const coverDataUrl = await extractCoverDataUrl(book);
      const fileHash     = await deps.HashWorker.compute(fileData);
      await StorageSystem.saveBook(store.bookKey, buf, title, creator, coverDataUrl, fileHash);
      await deps.refreshLibraryData();
    }

    deps.renderTocSidebar(toc);
    initRenditionEngine(book);
    generateLocationsBackground(book);
    deps.ReadingStatsTracker.startSession();

    const annotations = await StorageSystem.getAnnotationsByBook(store.bookKey);
    deps.AnnotationManager.restoreAll(annotations);

    return true;
  })();

  if (!result || !store.rendition) {
    LoadingOverlay.hide();
    exitViewer();
  }
}

/* ── 테마 등록 ── */
export function registerEpubThemes(rendition) {
  const BASE = { 'font-family': "'Gowun Batang','Noto Serif KR',Georgia,serif", 'word-break': 'keep-all', 'overflow-wrap': 'break-word' };

  rendition.themes.register('paper', {
    body: { ...BASE, background: '#fcfbf7 !important', color: '#1a1814 !important' },
    'p,li,blockquote': { 'margin-bottom': '0.6em' },
    'h1,h2,h3,h4': { 'font-weight': '700', 'line-height': '1.4' },
    img: { 'max-width': '100%', height: 'auto', display: 'block', margin: '0 auto' },
  });
  rendition.themes.register('dark', {
    body: { ...BASE, background: '#1a1a1e !important', color: '#c8c6c0 !important', filter: 'contrast(0.92)', 'font-weight': '300' },
    'p,li,blockquote': { 'margin-bottom': '0.6em' },
    'h1,h2,h3,h4': { 'font-weight': '600', 'line-height': '1.4', color: '#e0dede !important' },
    a: { color: '#8a8882 !important' },
    img: { 'max-width': '100%', height: 'auto', display: 'block', margin: '0 auto' },
  });
  rendition.themes.register('white', {
    body: { ...BASE, background: '#ffffff !important', color: '#111111 !important' },
    'p,li,blockquote': { 'margin-bottom': '0.6em' },
    'h1,h2,h3,h4': { 'font-weight': '700', 'line-height': '1.4' },
    img: { 'max-width': '100%', height: 'auto', display: 'block', margin: '0 auto' },
  });
  rendition.themes.register('custom', {
    body: { ...BASE, background: store.userBg + ' !important', color: store.userInk + ' !important',
            'letter-spacing': store.userSpacing + 'em', 'line-height': String(store.userLeading) },
    img: { 'max-width': '100%', height: 'auto', display: 'block', margin: '0 auto' },
  });
}

/* FOUC 방지 스타일 주입 (+ 다크 이미지 감쇄) */
export function injectContentStyles(contents) {
  const doc = contents.document;
  if (!doc) return;
  doc.getElementById('fable-injected')?.remove();
  const style = doc.createElement('style');
  style.id = 'fable-injected';

  /*
   * [버그 3B] 해시화된 외부 CSS에 의존하지 않는 '인라인 테마 주입'.
   * ───────────────────────────────────────────────────────────
   * Vite 빌드 후 style.css는 index-[hash].css로 파일명이 바뀌므로,
   * iframe 내부에서 상대경로 <link>로 테마 CSS를 불러오면 404가 난다.
   * → 모든 독서 테마(배경/글자색/서체/폰트크기/행간/자간/다크 이미지
   *   반전 감쇄)를 외부 파일 없이 인라인 <style>로 직접 주입한다.
   */
  const isDark   = store.theme === 'dark';
  const isWhite  = store.theme === 'white';
  const isCustom = store.theme === 'custom';
  const themeBg  = isDark ? '#1a1a1e' : isWhite ? '#ffffff' : isCustom ? store.userBg  : '#fcfbf7';
  const themeInk = isDark ? '#c8c6c0' : isWhite ? '#111111' : isCustom ? store.userInk : '#1a1814';

  /* 서체 매핑 (settings.js FontLazyLoader와 동일 패밀리) */
  const FONT_FAMILY = {
    gowun:  "'Gowun Batang','Noto Serif KR',Georgia,serif",
    noto:   "'Noto Serif KR',Georgia,serif",
    sans:   "'Noto Sans KR',system-ui,sans-serif",
    nanum:  "'Nanum Myeongjo',serif",
    system: 'system-ui,-apple-system,sans-serif',
  };
  const fontFamily = FONT_FAMILY[store.fontFamily] || FONT_FAMILY.gowun;
  const fontSize   = `${store.fontSize || 100}%`;
  const lineHeight = ({ narrow: '1.5', normal: '1.85', wide: '2.3' })[store.lineHeight] || '1.85';
  const spacing    = isCustom ? `${store.userSpacing || 0}em` : '0';

  /* [3]-7 다크 모드: 본문 내 흰 배경 이미지 대비 감쇄 */
  const darkImg = isDark
    ? 'img,svg,image{filter:brightness(0.8) contrast(1.2);opacity:0.92;}'
    : '';

  style.textContent = `
    html,body {
      background:${themeBg} !important;
      color:${themeInk} !important;
      font-family:${fontFamily} !important;
      font-size:${fontSize} !important;
      line-height:${lineHeight} !important;
      letter-spacing:${spacing} !important;
      -webkit-font-smoothing:antialiased;
      text-rendering:optimizeLegibility;
      word-break:keep-all; overflow-wrap:break-word;
    }
    p,li,blockquote,span,div,td { color:${themeInk} !important; line-height:${lineHeight} !important; }
    a { color:${isDark ? '#8a8882' : 'inherit'} !important; }
    *,*::before,*::after { box-sizing:border-box; }
    p,div,span,li,td { page-break-inside:avoid; break-inside:avoid; }
    img { max-width:100% !important; height:auto !important; }
    ${darkImg}
    mark.fable-search-mark { background:rgba(255,220,50,0.55); border-radius:2px; animation:fable-mark-pulse 1.2s ease-out forwards; }
    @keyframes fable-mark-pulse { 0% { background:rgba(255,165,0,0.75); } 100% { background:rgba(255,220,50,0.45); } }
    .hl-yellow { background:rgba(255,235,59,0.45)!important; border-bottom:2px solid #f5c800!important; }
    .hl-green  { background:rgba(105,240,174,0.40)!important; border-bottom:2px solid #00c853!important; }
    .fable-search-hl { background:rgba(255,165,0,0.45)!important; border-radius:3px; }
  `;
  doc.head.appendChild(style);
}

/* ── [버그2] 뷰어 가시성/실측 헬퍼 ── */

/* #screen-viewer를 즉시 가시 상태로 강제 (renderTo 측정 직전) */
function _ensureViewerVisible() {
  const vi = DOMProxy.get('screen-viewer');
  const up = DOMProxy.get('screen-uploader');
  if (DOMProxy.exists('screen-uploader')) up.style.display = 'none';
  if (DOMProxy.exists('screen-viewer')) {
    /* display:none이면 측정이 0이 되므로 즉시 flex 확정 */
    if (getComputedStyle(vi).display === 'none') vi.style.display = 'flex';
    vi.style.opacity = '1';
    vi.style.transform = 'none';
  }
}

/* 뷰포트 실측 치수 (0이면 안전 폴백) */
function _measureViewport(viewport) {
  let w = 0, h = 0;
  try {
    const rect = viewport.getBoundingClientRect?.();
    if (rect) { w = Math.floor(rect.width); h = Math.floor(rect.height); }
  } catch (_) {}
  /* 측정 실패/0 → 부모(reader-main-frame) 또는 윈도우 기준 폴백 */
  if (!w || !h) {
    const frame = DOMProxy.get('reader-main-frame');
    try {
      const r = frame.getBoundingClientRect?.();
      if (r && r.width && r.height) { w = Math.floor(r.width); h = Math.floor(r.height); }
    } catch (_) {}
  }
  if (!w) w = Math.max(320, window.innerWidth || 360);
  if (!h) h = Math.max(400, (window.innerHeight || 640) - 110); /* nav+bottom bar 보정 */
  return { width: w, height: h };
}

/* 표시 직후 실측 크기로 rendition을 재배치 (0px 잔재 제거) */
function _resizeRenditionToViewport(rendition, viewport) {
  if (!rendition) return;
  /* 다음 두 프레임 뒤 실측 (레이아웃 확정 후) */
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try {
      const { width, height } = _measureViewport(viewport);
      if (width > 1 && height > 1) rendition.resize(width, height);
    } catch (_) {}
  }));
}

export function initRenditionEngine(book) {
  const viewport = DOMProxy.get('viewer-viewport');
  if (!DOMProxy.exists('viewer-viewport')) return;

  /*
   * [버그2 수정] 화이트아웃(본문 0px 수축) 방지
   * ───────────────────────────────────────────────────────────
   * showViewerScreen()이 #screen-viewer를 display:none→flex로 바꾸는
   * 타이밍(300ms 트랜지션)과 renderTo() 호출 시점이 어긋나면, epub.js가
   * 컨테이너를 측정할 때 0×0 이라 iframe이 0px로 수축해 본문이 사라진다.
   *
   * 방어:
   *  1) renderTo 전에 뷰어 컨테이너 가시성을 강제 확정(display 보정).
   *  2) width/height를 '100%'가 아닌 '실측 px'로 넘겨 0 수축을 차단하고,
   *     0이면 안전한 폴백 치수를 사용.
   *  3) display 직후 ResizeObserver/rAF로 실측 크기를 재반영(resize).
   */
  _ensureViewerVisible();
  const dims = _measureViewport(viewport);

  const rendition = book.renderTo(viewport, {
    manager: 'continuous',
    flow: store.flow,
    width:  dims.width,
    height: dims.height,
    spread: 'auto',
    allowScriptedContent: true,
  });
  store.rendition = rendition;

  registerEpubThemes(rendition);
  rendition.hooks.content.register(injectContentStyles);
  _applyAllRenditionSettings(rendition);

  const savedCFI = StorageSystem.lsGet('fable_cfi_' + store.bookKey, '');
  rendition.display(savedCFI || undefined)
    .then(() => {
      LoadingOverlay.hide();
      /* 표시 직후 실측 크기로 한 번 더 resize → 0px 잔재 제거 */
      _resizeRenditionToViewport(rendition, viewport);
      if (savedCFI) Toast.show('이전에 읽던 위치에서 시작합니다.', 'success');
      deps.SearchEngine.build(book);
      deps.AnnotationManager.init(rendition);
      NavGuard.init(rendition);
    })
    .catch(err => { LoadingOverlay.hide(); ErrorBoundary.handle('renderer', err, 'rendition.display'); });

  rendition.on('relocated', (location) => {
    store.currentCFI = location.start.cfi;
    StorageSystem.lsSet('fable_cfi_' + store.bookKey, location.start.cfi);
    deps.ReadingStatsTracker.markPosition(location.start.cfi);
    updateProgressUI(location);
    const href = location.start.href;
    if (href && href !== store.currentHref) { store.currentHref = href; deps.updateTocActiveItem(href); }
    _updateArrowState(location);
    NavGuard.onRelocated();
  });

  rendition.on('keyup', deps.handleKeyDown);
  rendition.on('click', () => {
    if (store.isTocOpen)      store.isTocOpen     = false;
    if (store.isSettingsOpen) store.isSettingsOpen = false;
    store.navBarsVisible = !store.navBarsVisible;
  });
  rendition.on('rendered', (section, view) => {
    if (view?.document) injectContentStyles({ document: view.document });
    if (store.flow === 'scrolled') deps.bindScrollTopButton(view);
  });
}

function _applyAllRenditionSettings(rendition) {
  const t = store.theme === 'custom' ? 'custom' : store.theme;
  try { rendition.themes.select(t); } catch (_) {}
  try { rendition.themes.fontSize(`${store.fontSize}%`); } catch (_) {}
  try { rendition.themes.override('line-height', LH_MAP[store.lineHeight] || '1.85'); } catch (_) {}
  if (store.theme === 'custom') injectCustomToIframe();
}

/* 커스텀 테마를 iframe 본문에 주입 (settings.js와 공유) */
export function injectCustomToIframe() {
  if (!store.rendition || store.theme !== 'custom') return;
  try {
    store.rendition.themes.override('background-color', store.userBg);
    store.rendition.themes.override('color',            store.userInk);
    store.rendition.themes.override('letter-spacing',   store.userSpacing + 'em');
    store.rendition.themes.override('line-height',      String(store.userLeading));
  } catch (e) { ErrorBoundary.handle('renderer', e, 'customTheme'); }
}

/*
 * [버그 3B] 현재 열린 iframe 본문(들)에 인라인 테마를 강제 재주입.
 * 서체/폰트크기/테마 변경 시 호출하면 외부 CSS(해시 404) 없이 즉시 반영된다.
 */
export function reapplyInlineTheme() {
  if (!store.rendition) return;
  try {
    const contents = store.rendition.getContents?.() || [];
    const arr = Array.isArray(contents) ? contents : [contents];
    arr.forEach(c => { if (c?.document) injectContentStyles({ document: c.document }); });
  } catch (e) { ErrorBoundary.handle('renderer', e, 'reapplyInlineTheme'); }
}

function _updateArrowState(location) {
  DOMProxy.get('arrow-prev').disabled = location.atStart === true;
  DOMProxy.get('arrow-next').disabled = location.atEnd   === true;
}

/* ══════════════════════════════════════════════════════════
   §17. 자원 해제 파이프라인
   ══════════════════════════════════════════════════════════ */
export async function destroyCurrentRenditionContext() {
  /* [요구2] 잔여 진행률 버퍼를 디스크에 즉시 커밋 후 정리 */
  await StorageSystem.flushProgressNow();
  deps.ReadingStatsTracker.stopSession();
  NavGuard.destroy();
  deps.SearchEngine.destroy();
  deps.AnnotationManager.reset();
  deps.VirtualSearchList.destroy();
  CFICache.clear();          /* [2]-5/6 메모이제이션 캐시 해제 */
  ResourceRegistry.releaseAll();

  /*
   * [버그 3C] 좀비 인스턴스 / 이벤트 이중구독 방지
   * ───────────────────────────────────────────────────────────
   * rendition.destroy() 이전에 등록된 모든 epub.js 이벤트(relocated/
   * keyup/click/rendered)와 content 훅을 명시적으로 해제하여,
   * 구 rendition 콜백이 전역 store 프록시를 이중 구독하는 누수를 차단.
   */
  if (store.rendition) {
    const r = store.rendition;
    try { r.off('relocated'); } catch (_) {}
    try { r.off('keyup');     } catch (_) {}
    try { r.off('click');     } catch (_) {}
    try { r.off('rendered');  } catch (_) {}
    try { r.off('displayed'); } catch (_) {}
    /* content 훅 해제 (injectContentStyles 중복 등록 방지) */
    try { r.hooks?.content?.clear?.(); } catch (_) {}
  }

  const vp = DOMProxy.get('viewer-viewport');
  if (DOMProxy.exists('viewer-viewport')) {
    vp.querySelectorAll('iframe').forEach(f => { try { f.src = 'about:blank'; } catch (_) {} f.remove(); });
    /* 잔존 DOM 찌꺼기(epub.js manager가 남긴 컨테이너) 완전 소거 */
    vp.innerHTML = '';
  }

  if (store.rendition) { try { store.rendition.destroy(); } catch (_) {} store.rendition = null; }
  if (store.book)      { try { store.book.destroy();      } catch (_) {} store.book      = null; }

  ReactiveStore.patch({
    toc: [], currentHref: '', totalLocations: 0, currentCFI: '',
    isTocOpen: false, isSettingsOpen: false, bookKey: '',
    navBarsVisible: true, isScrollMode: false,
  });
  DOMProxy.invalidate();

  setTextSafe(DOMProxy.get('nav-book-title'),         '도서 로딩 중...');
  setTextSafe(DOMProxy.get('viewer-progress-text'),   '0%');
  setTextSafe(DOMProxy.get('reading-location-range'), '- / -');
  DOMProxy.get('progress-bar-fill').style.width = '0%';
  if (DOMProxy.exists('toc-list')) DOMProxy.get('toc-list').innerHTML = '';
}

export function exitViewer() {
  destroyCurrentRenditionContext().then(() => { showUploaderScreen(); deps.refreshLibraryData(); });
}

/* ══════════════════════════════════════════════════════════
   §18. CFI 보정 스케줄러 (가로↔세로)
   ══════════════════════════════════════════════════════════ */
export function switchFlowMode(mode) {
  if (store.flow === mode || !store.book) return;
  const savedCFI = store.currentCFI;
  const savedBook = store.book;
  store.flow = mode;
  destroyCurrentRenditionContext().then(() => {
    store.book = savedBook;
    initRenditionEngine(savedBook);
    if (savedCFI) ResourceRegistry.addTimer(setTimeout(() => { store.rendition?.display(savedCFI).catch(() => {}); }, 350));
  });
}

/* [요구3] 퍼센트 위치 이동 + 챕터 추정 */
export function chapterAtPercent(pct) {
  try {
    const toc = store.toc || [];
    if (!toc.length || !store.book?.spine) return '';
    const spineLen = store.book.spine.items.length || 1;
    const idx = Math.min(spineLen - 1, Math.floor((pct / 100) * spineLen));
    const href = store.book.spine.items[idx]?.href || '';
    let label = '';
    const walk = (items) => {
      for (const it of items) {
        const ih = (it.href || '').split('#')[0];
        if (ih && href.includes(ih)) { label = it.label?.trim() || label; }
        if (it.subitems?.length) walk(it.subitems);
      }
    };
    walk(toc);
    return label || `${idx + 1}번째 구간`;
  } catch (_) { return ''; }
}

export function seekToPercent(pct) {
  if (!store.rendition || !store.book) return;
  pct = Math.min(100, Math.max(0, pct));
  try {
    /* locations가 생성돼 있으면 CFI로 정밀 이동 */
    if (store.book.locations && store.totalLocations > 0) {
      const cfi = CFICache.getCfi(pct / 100, () => store.book.locations.cfiFromPercentage(pct / 100));
      if (cfi) { store.rendition.display(cfi).catch(() => {}); return; }
    }
    /* 폴백: spine 인덱스 기준 이동 */
    const spineLen = store.book.spine?.items?.length || 1;
    const idx = Math.min(spineLen - 1, Math.floor((pct / 100) * spineLen));
    const item = store.book.spine?.items?.[idx];
    if (item) store.rendition.display(item.href).catch(() => {});
  } catch (e) { ErrorBoundary.handle('renderer', e, 'seekToPercent'); }
}

/* ══════════════════════════════════════════════════════════
   §19. NavGuard (스와이프 관성 + 리사이즈 마스크)
   ══════════════════════════════════════════════════════════ */
export const NavGuard = (() => {
  let navigating = false, pending = null, resizeObs = null, resizeTimer = null;
  let gestureAxis = null, touchStartX = 0, touchStartY = 0, touchStartTime = 0, cfiSnap = '';

  function acquire() { if (navigating) return false; navigating = true; _setArrows(false); return true; }
  function release() {
    navigating = false; _setArrows(true);
    if (pending) { const d = pending; pending = null; requestAnimationFrame(() => d === 'prev' ? prev() : next()); }
  }
  function onRelocated() { release(); }
  function _setArrows(en) {
    DOMProxy.get('arrow-prev').style.pointerEvents = en ? '' : 'none';
    DOMProxy.get('arrow-next').style.pointerEvents = en ? '' : 'none';
  }

  async function prev() {
    if (!store.rendition) return;
    if (!acquire()) { pending = 'prev'; return; }
    try { await store.rendition.prev(); } catch (_) { release(); }
  }
  async function next() {
    if (!store.rendition) return;
    if (!acquire()) { pending = 'next'; return; }
    try { await store.rendition.next(); } catch (_) { release(); }
  }

  function _initResize(rendition) {
    const vp = DOMProxy.get('viewer-viewport');
    if (!DOMProxy.exists('viewer-viewport') || typeof ResizeObserver === 'undefined') return;
    resizeObs = new ResizeObserver(() => {
      /*
       * [버그 3A] 리사이즈 안전 가드
       * ─────────────────────────────────────────────────────
       * - 뷰어가 실제로 열려 있고 rendition이 살아 있을 때만 동작.
       * - ResizeObserver 엔트리의 contentRect는 트랜지션 중 0이거나
       *   stale일 수 있으므로, 신뢰하지 않고 '현재 활성 컨테이너'의
       *   실시간 가시 크기를 직접 역추적(getBoundingClientRect)한다.
       * - 0px이면 resize를 건너뛰어 본문 증발/깨짐을 방지한다.
       */
      if (!store.rendition || !store.isViewerOpen) return;
      if (store.currentCFI) cfiSnap = store.currentCFI;
      ResizeMask.show();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(async () => {
        if (!store.rendition || !store.isViewerOpen) { ResizeMask.hide(); return; }
        /* 실시간 컨테이너 크기 역추적 (엔트리 contentRect 미신뢰) */
        let width = 0, height = 0;
        try {
          const r = vp.getBoundingClientRect?.();
          if (r) { width = Math.floor(r.width); height = Math.floor(r.height); }
        } catch (_) {}
        if (width < 2 || height < 2) { ResizeMask.hide(); return; }
        try {
          navigating = false; pending = null;
          rendition.resize(width, height);
          await new Promise(r => requestAnimationFrame(r));
          if (cfiSnap) await rendition.display(cfiSnap).catch(() => {});
        } catch (_) {}
        ResizeMask.hide();
      }, 160);
    });
    resizeObs.observe(vp);
    ResourceRegistry.addResizeObserver(resizeObs);
  }

  function _initTouch() {
    const viewer = DOMProxy.get('screen-viewer');
    if (!DOMProxy.exists('screen-viewer')) return;
    /* [3]-6 거리 임계값 + 속도(관성) 임계값 동시 판정 */
    const SWIPE_MIN = 50, AXIS_LOCK = 8, EDGE_PX = window.innerWidth * 0.1;
    const VELOCITY_MIN = 0.35; /* px/ms — 빠르게 튕기면 짧은 거리도 넘김 */
    let lastX = 0, lastT = 0, velocity = 0;

    const onStart = (e) => {
      const panel = DOMProxy.get('settings-panel'), toc = DOMProxy.get('toc-sidebar');
      if (panel.contains?.(e.target) || toc.contains?.(e.target)) return;
      touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now(); gestureAxis = null;
      lastX = touchStartX; lastT = touchStartTime; velocity = 0;
    };
    const onMove = (e) => {
      if (gestureAxis === 'y') return;
      const cx = e.touches[0].clientX;
      const dx = Math.abs(cx - touchStartX), dy = Math.abs(e.touches[0].clientY - touchStartY);
      if (gestureAxis === null && (dx > AXIS_LOCK || dy > AXIS_LOCK)) gestureAxis = dx >= dy ? 'x' : 'y';
      if (gestureAxis === 'x') {
        e.preventDefault();
        const now = Date.now(), dt = now - lastT;
        if (dt > 0) velocity = (cx - lastX) / dt;
        lastX = cx; lastT = now;
      }
    };
    const onEnd = (e) => {
      if (gestureAxis !== 'x') return;
      const elapsed = Date.now() - touchStartTime;
      const deltaX = e.changedTouches[0].clientX - touchStartX;
      gestureAxis = null;
      if (touchStartX < EDGE_PX || touchStartX > window.innerWidth - EDGE_PX) return;
      const farEnough  = Math.abs(deltaX) >= SWIPE_MIN && elapsed <= 500;
      const fastFlick  = Math.abs(velocity) >= VELOCITY_MIN && Math.abs(deltaX) > 16;
      if (!farEnough && !fastFlick) return;
      const dir = (Math.abs(velocity) >= VELOCITY_MIN) ? (velocity < 0 ? 'next' : 'prev')
                                                        : (deltaX < 0 ? 'next' : 'prev');
      dir === 'next' ? next() : prev();
    };
    ResourceRegistry.addListener(viewer, 'touchstart', onStart, { passive: true });
    ResourceRegistry.addListener(viewer, 'touchmove',  onMove,  { passive: false });
    ResourceRegistry.addListener(viewer, 'touchend',   onEnd,   { passive: true });
  }

  function init(rendition) { navigating = false; pending = null; gestureAxis = null; _initResize(rendition); _initTouch(); }
  function destroy() { if (resizeObs) { resizeObs.disconnect(); resizeObs = null; } clearTimeout(resizeTimer); navigating = false; pending = null; }
  return { init, destroy, prev, next, onRelocated };
})();

/* ══════════════════════════════════════════════════════════
   §20. locations 백그라운드 생성
   ══════════════════════════════════════════════════════════ */
export function generateLocationsBackground(book) {
  /* [2] window.Worker 가용성 + 생성 예외 동시 가드 */
  if (typeof window !== 'undefined' && typeof window.Worker === 'function') {
    try {
      const code = `self.onmessage=function(e){var l=e.data.spineLength||10,list=[];for(var i=0;i<l;i++)list.push("epubcfi(/6/"+(i*2+2)+"[s"+i+"]!/4/2)");self.postMessage({list:list});};`;
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      const w   = new Worker(url);
      w.postMessage({ spineLength: book.spine?.items?.length || 10 });
      w.onmessage = (e) => { store.totalLocations = e.data.list.length; URL.revokeObjectURL(url); w.terminate(); };
      w.onerror   = () => { URL.revokeObjectURL(url); w.terminate(); };
    } catch (_) { /* 워커 생성 거부 시 아래 메인스레드 generate로 자연 폴백 */ }
  }
  book.locations.generate(1600).then(l => { store.totalLocations = Math.max(store.totalLocations, l.length); }).catch(() => {});
}
