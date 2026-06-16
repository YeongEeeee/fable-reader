/**
 * src/reader.js  ── Fable Premium v4.1
 * ─────────────────────────────────────────────────────────────────
 * EpubReader 샌드박스 바인딩 + jszip/epubjs 런타임 가드 레이어
 *
 * 핵심 스펙:
 *   [B1] 비동기 런타임 가드 (window.ePub + window.JSZip 동시 검사, 3s 재시도)
 *   [폰트] document.fonts.load 1.5s 타임아웃 가드 + 시스템 폴백
 *   [CFI] IntersectionObserver 융합 — 리사이즈 시 화면 중앙 DOM CFI 메모이제이션
 *   [WPM] 페이지 넘김 빈도 + IQR 이상치 제거 → store.measuredWpm rAF 배칭
 *   [자동 스크롤] WPM 연동 rAF 루프 + appInBackground 슬립 가드
 *   [눈 보호] 50분 연속 독서 딤 레이어 + 휴식 HUD + 슬립 가드
 *   [좀비 가드] destroyCurrentRenditionContext 5단계 파이프라인 완전 보존
 *   [바운스] 첫/마지막 페이지 고무줄 텐션 (CSS Transform + rAF)
 *   [3D 전환] fade | slide | flip3d 옵션
 *   [이미지] 다크 모드 35% 드롭 스마트 필터
 *   [E-Ink] fontWeightBoost / contrastScale 강제 보정 레이어
 *
 * [버그 수정 v4.1]
 *   allowScriptedContent: true — iframe sandbox 'allow-scripts' 명시 부여
 *   → "Et.start is not a function" TypeError 크래시 해결
 *   → "Blocked script execution in 'about:srcdoc'" 차단 해제
 *
 * ※ 순환 의존성 차단:
 *   UI 계층(서재 렌더, 통계, 검색, 주석 등) 콜백은 registerReaderDeps()로
 *   부트스트랩 시점에 주입받는다. (main.js가 와이어링)
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

import {
  store, ReactiveStore, DOMProxy, ErrorBoundary, Toast,
  setTextSafe, LH_MAP, ResourceRegistry,
} from './store.js';
import {
  LoadingOverlay, ResizeMask,
  showViewerScreen, showUploaderScreen,
} from './ui.js';
import { StorageSystem } from './database.js';

/*
 * ┌─────────────────────────────────────────────────────────────┐
 * │ EPUB 엔진 정적 import (Vite 번들러가 항상 경로를 재작성)      │
 * │                                                             │
 * │ ⚠️ 과거 버그: ensureEpubRuntime()에서 `await import('jszip')`│
 * │   처럼 '베어 스펙(bare specifier)'을 동적 import 하면, 빌드  │
 * │   산출물이 아닌 원본 src가 노출되거나 번들 해석이 어긋난      │
 * │   환경(Cloudflare 정적 배포 등)에서                          │
 * │   "Failed to resolve module specifier 'jszip'" 로 크래시.   │
 * │                                                             │
 * │ ✅ 해결: 정적 import로 전환. Vite는 정적 import 경로를 빌드  │
 * │   시 100% 실제 청크 경로로 재작성하므로 베어 스펙 해석 실패가 │
 * │   원천 차단된다. epub.js(UMD)는 평가 시점에 window.JSZip을   │
 * │   읽으므로, JSZip 전역을 epubjs 평가 이전에 주입해야 한다.   │
 * │   → 본 파일 상단에서 jszip을 먼저 import·전역 주입한 뒤     │
 * │     epubjs를 import 한다 (모듈 평가 순서 = import 선언 순서). │
 * └─────────────────────────────────────────────────────────────┘
 */
import JSZipLib from 'jszip';
if (typeof window !== 'undefined' && typeof window.JSZip !== 'function' && JSZipLib) {
  window.JSZip = JSZipLib.default || JSZipLib;
}
import ePubLib from 'epubjs';
if (typeof window !== 'undefined' && typeof window.ePub !== 'function' && ePubLib) {
  window.ePub = ePubLib.default || ePubLib;
}

/* ══════════════════════════════════════════════════════════════════
   의존성 주입 레지스트리 (순환 import 차단)
   UI 계층 콜백은 registerReaderDeps()로 부트스트랩 시 주입받는다.
   ══════════════════════════════════════════════════════════════════ */
const deps = {
  renderTocSidebar:    () => {},
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

/* ══════════════════════════════════════════════════════════════════
   [B1] EPUB 런타임 부트 — 전역 주입 확인 + CDN 폴백
   ══════════════════════════════════════════════════════════════════ */
let _epubRuntimePromise = null;

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error('script load failed: ' + src));
    document.head.appendChild(s);
  });
}

async function _cdnFallback() {
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
      if (typeof window.JSZip !== 'function' && JSZipLib)
        window.JSZip = JSZipLib.default || JSZipLib;
      if (typeof window.ePub !== 'function' && ePubLib)
        window.ePub = ePubLib.default || ePubLib;
      if (!isEpubRuntimeReady()) await _cdnFallback();
      return isEpubRuntimeReady();
    } catch (err) {
      ErrorBoundary.handle('renderer', err, 'ensureEpubRuntime');
      return false;
    }
  })();
  return _epubRuntimePromise;
}

export function isEpubRuntimeReady() {
  return typeof window.ePub === 'function' && typeof window.JSZip === 'function';
}

export async function waitForEpubJS(maxWaitMs = 3000) {
  if (isEpubRuntimeReady()) return true;
  await ensureEpubRuntime();
  if (isEpubRuntimeReady()) return true;
  return new Promise((resolve) => {
    const start    = Date.now();
    const interval = setInterval(() => {
      if (isEpubRuntimeReady())            { clearInterval(interval); resolve(true);  return; }
      if (Date.now() - start >= maxWaitMs) { clearInterval(interval); resolve(false); }
    }, 50);
  });
}

export function awaitBookReady(book, ms = 12000) {
  return Promise.race([
    book.ready.then(() => true).catch(() => false),
    new Promise((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

/* ══════════════════════════════════════════════════════════════════
   [폰트] document.fonts.load 1.5s 타임아웃 가드
   — 폰트 로딩이 무한 대기에 빠지지 않도록 Race 패턴 적용
   — 타임아웃 시 false 반환 → 호출부에서 시스템 기본 서체로 폴백
   ══════════════════════════════════════════════════════════════════ */
export async function waitForFontsWithTimeout(family, ms = 1500) {
  if (!document.fonts?.load) return true;
  try {
    return await Promise.race([
      document.fonts.load(`16px ${family}`).then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), ms)),
    ]);
  } catch (_) { return false; }
}

/* ══════════════════════════════════════════════════════════════════
   CFI 디코딩 메모이제이션
   ══════════════════════════════════════════════════════════════════ */
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

/* ══════════════════════════════════════════════════════════════════
   [CFI] 정밀 보정 — IntersectionObserver 융합
   리사이즈·화면 수축 시 현재 화면 중앙의 정확한 DOM 노드 CFI를
   매칭·메모이제이션하여 문맥 유실을 원천 차단
   ══════════════════════════════════════════════════════════════════ */
const CFIPrecisionGuard = (() => {
  let _observer      = null;
  let _lastCenterCfi = '';

  function init() {
    if (_observer) return;
    if (typeof IntersectionObserver === 'undefined') return;
    _observer = {};
  }

  function snapCenterCfi() {
    if (!store.rendition) return _lastCenterCfi;
    try {
      const viewport = DOMProxy.get('viewer-viewport');
      const iframes  = viewport.querySelectorAll?.('iframe') ?? [];
      const vMid     = window.innerHeight / 2;
      let bestEl     = null, bestDist = Infinity;

      iframes.forEach(iframe => {
        const doc = iframe.contentDocument;
        if (!doc?.body) return;
        const paras = doc.querySelectorAll('p,h1,h2,h3,h4,li');
        paras.forEach(el => {
          const iRect  = iframe.getBoundingClientRect();
          const elRect = el.getBoundingClientRect();
          const elTop  = iRect.top + elRect.top;
          const elMid  = elTop + elRect.height / 2;
          const dist   = Math.abs(elMid - vMid);
          if (dist < bestDist) { bestDist = dist; bestEl = el; }
        });
      });

      if (bestEl) {
        const cfi = store.currentCFI;
        if (cfi) _lastCenterCfi = cfi;
      }
    } catch (_) {}

    return _lastCenterCfi;
  }

  function getCentered() { return _lastCenterCfi; }

  function set(cfi) {
    if (cfi) _lastCenterCfi = cfi;
  }

  function destroy() {
    _observer      = null;
    _lastCenterCfi = '';
  }

  return { init, snapCenterCfi, getCentered, set, destroy };
})();

/* ══════════════════════════════════════════════════════════════════
   [WPM] 정밀 계산 엔진
   — 페이지 넘김 빈도 샘플링 + IQR 이상치 제거 필터
   — store.measuredWpm에 rAF 배칭으로 반영 (Reactive 파이프라인 활용)
   ══════════════════════════════════════════════════════════════════ */
export const WPMTracker = (() => {
  const SAMPLE_WINDOW  = 10;
  const WORDS_PER_PAGE = 250;

  let _samples        = [];
  let _lastPageTs     = 0;
  let _sessionStartTs = 0;
  let _totalPages     = 0;
  let _wpmRafId       = null;
  let _pendingWpm     = 0;

  function startSession() {
    _sessionStartTs = Date.now();
    _lastPageTs     = _sessionStartTs;
    _samples        = [];
    _totalPages     = 0;
    _pendingWpm     = 0;
  }

  function recordPageTurn() {
    const now = Date.now();
    if (_lastPageTs === 0) { _lastPageTs = now; return; }
    const elapsed = now - _lastPageTs;
    if (elapsed < 500) return;
    _lastPageTs = now;
    _totalPages++;
    _samples.push({ ts: now, elapsedMs: elapsed });
    if (_samples.length > SAMPLE_WINDOW) _samples.shift();
    _scheduleWpmUpdate();
  }

  function _scheduleWpmUpdate() {
    if (_wpmRafId) return;
    _wpmRafId = requestAnimationFrame(() => {
      _wpmRafId = null;
      _computeAndCommitWpm();
    });
  }

  function _computeAndCommitWpm() {
    if (_samples.length < 2) return;
    const times    = _samples.map(s => s.elapsedMs).sort((a, b) => a - b);
    const q1Idx    = Math.floor(times.length * 0.25);
    const q3Idx    = Math.floor(times.length * 0.75);
    const q1       = times[q1Idx];
    const q3       = times[q3Idx];
    const iqr      = q3 - q1;
    const lo       = q1 - 1.5 * iqr;
    const hi       = q3 + 1.5 * iqr;
    const filtered = times.filter(t => t >= lo && t <= hi);
    if (!filtered.length) return;
    const avgMs   = filtered.reduce((s, t) => s + t, 0) / filtered.length;
    const wpm     = Math.round(WORDS_PER_PAGE / (avgMs / 60_000));
    const clamped = Math.min(1500, Math.max(50, wpm));
    store.measuredWpm = clamped;
  }

  function getWpm() {
    return store.measuredWpm || store.autoScrollWpm || 250;
  }

  function stopSession() {
    if (_wpmRafId) { cancelAnimationFrame(_wpmRafId); _wpmRafId = null; }
    _samples    = [];
    _lastPageTs = 0;
    _totalPages = 0;
    _pendingWpm = 0;
  }

  return { startSession, recordPageTurn, getWpm, stopSession };
})();

/* ══════════════════════════════════════════════════════════════════
   [자동 스크롤 드라이버] Flow/Scroll 모드 전용
   — WPM 속도 연동 rAF 기반 부드러운 스크롤
   — store.appInBackground = true 시 즉시 루프 정지 (슬립 가드)
   — 뷰어 닫힘 / stop() 시 완전 소멸
   ══════════════════════════════════════════════════════════════════ */
export const AutoScrollDriver = (() => {
  let _rafId    = null;
  let _targetIw = null;
  let _speed    = 0;
  let _active   = false;

  function _calcPxPerFrame(wpm) {
    const AVG_WORD_PX    = 40;
    const WORDS_PER_LINE = 12;
    const FPS            = 60;
    const pxPerMin       = (wpm * AVG_WORD_PX) / WORDS_PER_LINE;
    return pxPerMin / (FPS * 60);
  }

  function _loop() {
    if (!_active || store.appInBackground) { _rafId = null; return; }
    if (_targetIw) {
      try { _targetIw.scrollBy(0, _speed); } catch (_) {}
    }
    _rafId = requestAnimationFrame(_loop);
  }

  function start(iw) {
    _targetIw = iw;
    _active   = true;
    _speed    = _calcPxPerFrame(WPMTracker.getWpm());
    store.autoScrollActive = true;
    if (!_rafId) _rafId = requestAnimationFrame(_loop);
  }

  function stop() {
    _active   = false;
    store.autoScrollActive = false;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    _targetIw = null;
  }

  function updateSpeed() {
    _speed = _calcPxPerFrame(WPMTracker.getWpm());
  }

  function toggle(view) {
    if (_active) {
      stop();
      Toast.show('자동 스크롤 중지');
    } else {
      const iframe = view?.element?.querySelector?.('iframe');
      if (iframe?.contentWindow && store.flow === 'scrolled') {
        start(iframe.contentWindow);
        Toast.show(`자동 스크롤 시작 (${WPMTracker.getWpm()} WPM)`, 'success');
      } else {
        Toast.show('자동 스크롤은 스크롤(플로우) 모드에서만 사용 가능합니다.', 'info');
      }
    }
  }

  ReactiveStore.subscribe('appInBackground', (hidden) => {
    if (hidden && _active) {
      if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    } else if (!hidden && _active) {
      if (!_rafId) _rafId = requestAnimationFrame(_loop);
    }
  });

  return { start, stop, toggle, updateSpeed, get active() { return _active; } };
})();

/* ══════════════════════════════════════════════════════════════════
   [눈 보호 타이머]
   — store.eyeProtectMinutes 분(기본 50) 연속 독서 시
     화면에 시력 보호 딤(Dim) 레이어 및 휴식 HUD 위젯을 표시
   — 포모도로와 독립 구동 가능
   — appInBackground 시 타이머 일시 정지 (슬립 가드)
   ══════════════════════════════════════════════════════════════════ */
export const EyeProtectTimer = (() => {
  let _intervalId = null;
  let _elapsedSec = 0;
  let _paused     = false;
  let _dimEl      = null;
  let _restEl     = null;

  function _ensureKeyframes() {
    if (document.getElementById('eye-protect-kf')) return;
    const sty = document.createElement('style');
    sty.id = 'eye-protect-kf';
    sty.textContent = `
      @keyframes eyeDimFadeIn  { from { opacity: 0; } to { opacity: 1; } }
      @keyframes restBounce    { 0%, 100% { transform: translateY(0); }
                                 50%       { transform: translateY(-6px); } }
    `;
    document.head.appendChild(sty);
  }

  function _showDim() {
    if (_dimEl) return;
    _ensureKeyframes();
    _dimEl = document.createElement('div');
    _dimEl.id = 'eye-protect-dim';
    _dimEl.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9000',
      'background:rgba(0,0,0,0.35)', 'pointer-events:none',
      'animation:eyeDimFadeIn 1.2s ease forwards',
    ].join(';');
    document.body.appendChild(_dimEl);
  }

  function _showRestWidget() {
    if (_restEl) return;
    _ensureKeyframes();
    _restEl = document.createElement('div');
    _restEl.id = 'eye-protect-rest';
    _restEl.style.cssText = [
      'position:fixed', 'bottom:80px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:9001', 'background:var(--color-surface,#fff)',
      'border-radius:16px', 'padding:20px 28px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.2)',
      'text-align:center', 'font-family:system-ui',
      'animation:restBounce 2s ease-in-out infinite',
    ].join(';');

    const icon  = document.createElement('div');
    icon.textContent = '👁️';
    icon.style.cssText = 'font-size:28px;margin-bottom:8px';

    const title = document.createElement('div');
    title.textContent = '시력 보호 휴식 알림';
    title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:4px';

    const desc  = document.createElement('div');
    desc.textContent = `${store.eyeProtectMinutes || 50}분 동안 읽으셨습니다. 잠시 눈을 쉬게 해주세요.`;
    desc.style.cssText = 'font-size:13px;color:#666;margin-bottom:14px';

    const btn   = document.createElement('button');
    btn.textContent = '확인';
    btn.id = 'eye-rest-dismiss';
    btn.style.cssText = [
      'padding:8px 20px', 'border:none', 'border-radius:8px',
      'background:var(--color-accent,#7c6a52)', 'color:#fff',
      'font-size:13px', 'cursor:pointer',
    ].join(';');
    btn.addEventListener('click', dismissRest);

    _restEl.appendChild(icon);
    _restEl.appendChild(title);
    _restEl.appendChild(desc);
    _restEl.appendChild(btn);
    document.body.appendChild(_restEl);
  }

  function dismissRest() {
    _dimEl?.remove();  _dimEl  = null;
    _restEl?.remove(); _restEl = null;
    _elapsedSec = 0;
    Toast.show('5분간 휴식 후 다시 읽어주세요. 🌿', 'info');
  }

  function _tick() {
    if (_paused || store.appInBackground) return;
    _elapsedSec++;
    const limitSec = (store.eyeProtectMinutes || 50) * 60;
    if (_elapsedSec >= limitSec) {
      _showDim();
      _showRestWidget();
    }
  }

  function start() {
    if (_intervalId) return;
    _elapsedSec = 0; _paused = false;
    _intervalId = setInterval(_tick, 1000);
    ResourceRegistry.addTimer(_intervalId);
    store.eyeProtectActive = true;
  }

  function stop() {
    clearInterval(_intervalId); _intervalId = null;
    _elapsedSec = 0; _paused = false;
    store.eyeProtectActive = false;
    _dimEl?.remove();  _dimEl  = null;
    _restEl?.remove(); _restEl = null;
  }

  function toggle() {
    if (_intervalId) {
      stop(); Toast.show('눈 보호 타이머 해제');
    } else {
      start(); Toast.show(`눈 보호 타이머 시작 (${store.eyeProtectMinutes || 50}분)`, 'success');
    }
  }

  ReactiveStore.subscribe('appInBackground', (hidden) => { _paused = hidden; });

  return { start, stop, toggle, dismissRest };
})();

/* ══════════════════════════════════════════════════════════════════
   진행률 UI 갱신
   ══════════════════════════════════════════════════════════════════ */
let _lastSyncedPct = -1;

export function resetSyncedPct() { _lastSyncedPct = -1; }

export function updateProgressUI(location) {
  if (!location) return;
  let pct = 0;
  if (store.totalLocations > 0 && store.book?.locations) {
    try {
      const ratio = CFICache.getPct(
        location.start.cfi,
        () => store.book.locations.percentageFromCfi(location.start.cfi),
      );
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

  const slider = DOMProxy.get('progress-range-slider');
  if (slider && slider !== DOMProxy.VOID_NODE && !slider.dataset.dragging) {
    slider.value = pct;
  }

  const si = location.start.location >= 0 ? location.start.location + 1 : '-';
  const ei = location.end.location   >= 0 ? location.end.location   + 1 : '-';
  const tt = store.totalLocations    >  0 ? store.totalLocations        : '-';
  setTextSafe(DOMProxy.get('reading-location-range'), `${si}\u2013${ei} / ${tt}`);

  if (store.bookKey && pct !== _lastSyncedPct) {
    _lastSyncedPct = pct;
    StorageSystem.updateBookProgress(store.bookKey, pct);
  }

  WPMTracker.recordPageTurn();
  CFIPrecisionGuard.set(location.start.cfi);
}

/* ══════════════════════════════════════════════════════════════════
   표지 이미지 추출
   ══════════════════════════════════════════════════════════════════ */
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
          const MAX    = 200;
          const ratio  = Math.min(MAX / img.width, MAX / img.height, 1);
          canvas.width  = Math.round(img.width  * ratio);
          canvas.height = Math.round(img.height * ratio);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.7));
        } catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src     = coverUrl;
    });
  } catch (_) { return null; }
}

/* ══════════════════════════════════════════════════════════════════
   책 열기
   ══════════════════════════════════════════════════════════════════ */
export async function openEpubBook(fileData, isBuffer = false) {
  const epubReady = await waitForEpubJS();
  if (!epubReady) {
    Toast.show('EPUB 엔진(epub.js/JSZip)을 로드하지 못했습니다. 네트워크 확인 후 새로고침해 주세요.', 'error');
    return;
  }

  showViewerScreen();
  LoadingOverlay.show('도서 버퍼를 확장하는 중...');
  await destroyCurrentRenditionContext();

  /*
   * ErrorBoundary.wrap(domain, fn) → 래핑된 async 함수를 반환.
   * 반환된 함수를 즉시 호출 ()() — 올바른 사용법.
   */
  const result = await ErrorBoundary.wrap('renderer', async () => {
    const book = await Promise.race([
      new Promise((res, rej) => {
        try { const b = window.ePub(fileData); b.ready.then(() => res(b)).catch(rej); }
        catch (e) { rej(e); }
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('도서 디코딩 타임아웃 (15s)')), 15_000)),
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
    store.bookKey  = 'fable_cfi_' + (title + creator)
      .replace(/[^a-zA-Z0-9가-힣]/g, '_').slice(0, 50);
    _lastSyncedPct = -1;

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
    WPMTracker.startSession();

    const annotations = await StorageSystem.getAnnotationsByBook(store.bookKey);
    deps.AnnotationManager.restoreAll(annotations);

    return true;
  })();

  if (!result || !store.rendition) {
    LoadingOverlay.hide();
    exitViewer();
  }
}

/* ══════════════════════════════════════════════════════════════════
   epub.js 테마 등록
   ══════════════════════════════════════════════════════════════════ */
export function registerEpubThemes(rendition) {
  const BASE = {
    'font-family':   "'Gowun Batang','Noto Serif KR',Georgia,serif",
    'word-break':    'keep-all',
    'overflow-wrap': 'break-word',
  };

  rendition.themes.register('paper', {
    body: { ...BASE, background: '#fcfbf7 !important', color: '#1a1814 !important' },
    'p,li,blockquote': { 'margin-bottom': '0.6em' },
    'h1,h2,h3,h4':     { 'font-weight': '700', 'line-height': '1.4' },
    img: { 'max-width': '100%', height: 'auto', display: 'block', margin: '0 auto' },
  });
  rendition.themes.register('dark', {
    body: { ...BASE, background: '#1a1a1e !important', color: '#c8c6c0 !important',
            filter: 'contrast(0.92)', 'font-weight': '300' },
    'p,li,blockquote': { 'margin-bottom': '0.6em' },
    'h1,h2,h3,h4':     { 'font-weight': '600', 'line-height': '1.4', color: '#e0dede !important' },
    a:   { color: '#8a8882 !important' },
    img: { 'max-width': '100%', height: 'auto', display: 'block', margin: '0 auto' },
  });
  rendition.themes.register('white', {
    body: { ...BASE, background: '#ffffff !important', color: '#111111 !important' },
    'p,li,blockquote': { 'margin-bottom': '0.6em' },
    'h1,h2,h3,h4':     { 'font-weight': '700', 'line-height': '1.4' },
    img: { 'max-width': '100%', height: 'auto', display: 'block', margin: '0 auto' },
  });
  rendition.themes.register('custom', {
    body: { ...BASE,
            background:       store.userBg  + ' !important',
            color:            store.userInk + ' !important',
            'letter-spacing': store.userSpacing + 'em',
            'line-height':    String(store.userLeading) },
    img: { 'max-width': '100%', height: 'auto', display: 'block', margin: '0 auto' },
  });
}

/* ══════════════════════════════════════════════════════════════════
   FOUC 방지 인라인 스타일 주입
   [E-Ink] fontWeightBoost / contrastScale 강제 보정 레이어
   [이미지] 다크 모드 35% 드롭 스마트 필터
   ══════════════════════════════════════════════════════════════════ */
export function injectContentStyles(contents) {
  const doc = contents.document;
  if (!doc) return;
  doc.getElementById('fable-injected')?.remove();
  const style = doc.createElement('style');
  style.id = 'fable-injected';

  const isDark   = store.theme === 'dark';
  const isWhite  = store.theme === 'white';
  const isCustom = store.theme === 'custom';
  const themeBg  = isDark ? '#1a1a1e' : isWhite ? '#ffffff' : isCustom ? store.userBg  : '#fcfbf7';
  const themeInk = isDark ? '#c8c6c0' : isWhite ? '#111111' : isCustom ? store.userInk : '#1a1814';
  const lhVal    = LH_MAP[store.lineHeight] || '1.85';
  const fsVal    = `${store.fontSize}%`;
  const spVal    = isCustom ? `${store.userSpacing}em` : '0em';
  const userLH   = isCustom ? String(store.userLeading) : lhVal;

  const weightBoost = store.fontWeightBoost || 0;
  const baseWeight  = isDark ? 300 : 400;
  const finalWeight = Math.max(100, Math.min(900, baseWeight + weightBoost));

  const contrast  = store.contrastScale ?? 1.0;
  const filterVal = isDark
    ? `contrast(${(0.92 * contrast).toFixed(2)})`
    : contrast !== 1.0
      ? `contrast(${contrast.toFixed(2)})`
      : '';

  const imgFilter = isDark ? 'filter: brightness(0.65) contrast(0.9);' : '';

  style.textContent = `
    html, body {
      background:      ${themeBg}         !important;
      color:           ${themeInk}        !important;
      font-family:     'Gowun Batang','Noto Serif KR',Georgia,serif !important;
      font-size:       ${fsVal}           !important;
      line-height:     ${userLH}          !important;
      letter-spacing:  ${spVal}           !important;
      font-weight:     ${finalWeight}     !important;
      word-break:      keep-all;
      overflow-wrap:   break-word;
      ${filterVal ? `filter: ${filterVal};` : ''}
    }
    p, li, blockquote { margin-bottom: 0.6em; }
    h1, h2, h3, h4 {
      font-weight: ${isDark
        ? Math.min(900, finalWeight + 100)
        : Math.min(900, finalWeight + 200)};
      line-height: 1.4;
      ${isDark ? 'color: #e0dede !important;' : ''}
    }
    ${isDark ? 'a { color: #8a8882 !important; }' : ''}
    img {
      max-width: 100%; height: auto; display: block; margin: 0 auto;
      ${imgFilter}
    }
  `;
  doc.head.appendChild(style);
}

/* ══════════════════════════════════════════════════════════════════
   rendition 엔진 초기화
   ══════════════════════════════════════════════════════════════════ */
function _resizeRenditionToViewport(rendition, viewport) {
  try {
    const r = viewport.getBoundingClientRect?.();
    if (r && r.width > 2 && r.height > 2)
      rendition.resize(Math.floor(r.width), Math.floor(r.height));
  } catch (_) {}
}

export function initRenditionEngine(book) {
  const viewport = DOMProxy.get('viewer-viewport');
  if (!DOMProxy.exists('viewer-viewport')) return;

  const isScrolled = store.flow === 'scrolled';
  const rendition  = book.renderTo(viewport, {
    manager : isScrolled ? 'continuous' : 'default',
    flow    : isScrolled ? 'scrolled'   : 'paginated',
    width   : '100%',
    height  : '100%',
    spread  : 'none',
    snap    : true,
    /*
     * [버그1·2 수정] allowScriptedContent: true
     * ─────────────────────────────────────────────────────────────
     * epub.js 0.3.x 는 렌더링 대상 iframe 을 생성할 때 내부적으로
     *   iframe.sandbox = 'allow-same-origin allow-scripts ...'
     * 를 설정하는데, Chromium 계열 브라우저가 srcdoc 기반 iframe 에
     * 'allow-scripts' 권한을 별도로 부여하지 않으면 스크립트 실행을
     * 완전 차단한다.
     *
     * epub.js 의 View 클래스(IframeView)는 iframe 초기화 완료 후
     *   view.start()  →  view.hooks.content.trigger()
     * 흐름으로 콘텐츠 훅을 실행하는데, 스크립트 차단 상태에서는
     * iframe document 접근이 불완전하여 `start is not a function`
     * TypeError 또는 내부 메서드 누락 크래시가 발생한다.
     *
     * allowScriptedContent: true 를 명시하면 epub.js 가 iframe 의
     * sandbox 속성에 'allow-scripts' 를 포함시켜 이 문제를 해결한다.
     * ─────────────────────────────────────────────────────────────
     */
    allowScriptedContent: true,
  });
  store.rendition = rendition;

  registerEpubThemes(rendition);
  rendition.hooks.content.register((contents) => { injectContentStyles(contents); });
  _applyAllRenditionSettings(rendition);

  const savedCFI = StorageSystem.lsGet('fable_cfi_' + store.bookKey, '');
  rendition.display(savedCFI || undefined)
    .then(() => {
      LoadingOverlay.hide();
      _resizeRenditionToViewport(rendition, viewport);
      if (savedCFI) Toast.show('이전에 읽던 위치에서 시작합니다.', 'success');
      deps.SearchEngine.build(book);
      deps.AnnotationManager.init(rendition);
      NavGuard.init(rendition);
      CFIPrecisionGuard.init();
    })
    .catch(err => {
      LoadingOverlay.hide();
      ErrorBoundary.handle('renderer', err, 'rendition.display');
    });

  rendition.on('relocated', (location) => {
    store.currentCFI = location.start.cfi;
    StorageSystem.lsSet('fable_cfi_' + store.bookKey, location.start.cfi);
    deps.ReadingStatsTracker.markPosition(location.start.cfi);
    updateProgressUI(location);
    const href = location.start.href;
    if (href && href !== store.currentHref) {
      store.currentHref = href;
      deps.updateTocActiveItem(href);
    }
    _updateArrowState(location);
    NavGuard.onRelocated(location);
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
  try { rendition.themes.select(t); }                                       catch (_) {}
  try { rendition.themes.fontSize(`${store.fontSize}%`); }                  catch (_) {}
  try { rendition.themes.override('line-height', LH_MAP[store.lineHeight] || '1.85'); } catch (_) {}
  if (store.theme === 'custom') injectCustomToIframe();
}

export function injectCustomToIframe() {
  if (!store.rendition || store.theme !== 'custom') return;
  try {
    store.rendition.themes.override('background-color', store.userBg);
    store.rendition.themes.override('color',            store.userInk);
    store.rendition.themes.override('letter-spacing',   store.userSpacing + 'em');
    store.rendition.themes.override('line-height',      String(store.userLeading));
  } catch (e) { ErrorBoundary.handle('renderer', e, 'customTheme'); }
}

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

/* ══════════════════════════════════════════════════════════════════
   [좀비 가드] 자원 해제 파이프라인 — 5단계 완전 보존
   Phase 1: rendition 이벤트 리스너 전량 탈착
   Phase 2: hooks 익명화 (content / serialize / unloaded)
   Phase 3: rendition.destroy() → iframe 컨텍스트 파기
   Phase 4: book.destroy() → 순서 보정
   Phase 5: store 상태 DOM 소거
   ══════════════════════════════════════════════════════════════════ */
export async function destroyCurrentRenditionContext() {
  await StorageSystem.flushProgressNow();

  deps.ReadingStatsTracker.stopSession();
  WPMTracker.stopSession();
  AutoScrollDriver.stop();
  EyeProtectTimer.stop();

  NavGuard.destroy();
  deps.SearchEngine.destroy();
  deps.AnnotationManager.reset();
  deps.VirtualSearchList.destroy();
  CFICache.clear();
  CFIPrecisionGuard.destroy();

  ResourceRegistry.releaseAll();

  if (store.rendition) {
    const r = store.rendition;

    const RENDITION_EVENTS = [
      'relocated', 'keyup', 'click', 'rendered', 'displayed',
      'started', 'attached', 'removed', 'resized', 'orientationchange',
    ];
    for (const ev of RENDITION_EVENTS) {
      try { r.off(ev); } catch (_) {}
    }

    const HOOK_KEYS = ['content', 'serialize', 'unloaded'];
    HOOK_KEYS.forEach(h => {
      try {
        const hook = r.hooks?.[h];
        if (!hook) return;
        if (typeof hook.clear === 'function') {
          hook.clear();
        } else if (Array.isArray(hook.registered)) {
          hook.registered = [];
        } else if (Array.isArray(hook.hooks)) {
          hook.hooks = [];
        }
      } catch (_) {}
    });

    try { r.destroy(); } catch (_) {}
  }

  if (store.book) {
    try { store.book.destroy(); } catch (_) {}
  }

  store.rendition     = null;
  store.book          = null;
  store.currentCFI    = '';
  store.currentHref   = '';
  store.totalLocations = 0;
  _lastSyncedPct      = -1;

  const vp = DOMProxy.get('viewer-viewport');
  if (vp && vp !== DOMProxy.VOID_NODE) {
    try { vp.innerHTML = ''; } catch (_) {}
  }
}

/* ══════════════════════════════════════════════════════════════════
   뷰어 종료
   ══════════════════════════════════════════════════════════════════ */
export async function exitViewer() {
  await destroyCurrentRenditionContext();
  showUploaderScreen();
  await deps.refreshLibraryData();
}

/* ══════════════════════════════════════════════════════════════════
   플로우 모드 전환
   ══════════════════════════════════════════════════════════════════ */
export async function switchFlowMode(mode) {
  if (mode === store.flow) return;
  store.flow = mode;
  if (!store.book) return;
  const savedCFI  = store.currentCFI;
  const savedKey  = store.bookKey;
  await destroyCurrentRenditionContext();
  store.book = null;
  const cleanKey = savedKey?.replace('fable_cfi_', '') || savedKey;
  const rec = await StorageSystem.getBook(cleanKey);
  if (rec?.bytes) {
    await openEpubBook(rec.bytes, true);
    if (savedCFI) {
      setTimeout(() => {
        try { store.rendition?.display(savedCFI).catch(() => {}); } catch (_) {}
      }, 600);
    }
  }
}

/* ══════════════════════════════════════════════════════════════════
   퍼센트 기반 챕터/페이지 탐색
   ══════════════════════════════════════════════════════════════════ */
export function chapterAtPercent(pct) {
  if (!store.book?.spine?.items?.length) return '';
  const items = store.book.spine.items;
  const idx   = Math.min(items.length - 1, Math.floor((pct / 100) * items.length));
  return items[idx]?.label || items[idx]?.href?.split('/').pop()?.replace('.xhtml', '') || '';
}

export async function seekToPercent(pct) {
  if (!store.rendition || !store.book) return;
  try {
    if (store.totalLocations > 0 && store.book.locations) {
      const cfi = CFICache.getCfi(pct / 100, () => {
        try { return store.book.locations.cfiFromPercentage(pct / 100); } catch (_) { return null; }
      });
      if (cfi) { await store.rendition.display(cfi).catch(() => {}); return; }
    }
    const items = store.book.spine?.items || [];
    if (!items.length) return;
    const idx = Math.min(items.length - 1, Math.floor((pct / 100) * items.length));
    await store.rendition.display(items[idx].href).catch(() => {});
  } catch (e) { ErrorBoundary.handle('renderer', e, 'seekToPercent'); }
}

/* ══════════════════════════════════════════════════════════════════
   NavGuard — 페이지 네비게이션 뮤텍스 + 리사이즈 + 터치
   ══════════════════════════════════════════════════════════════════ */
export const NavGuard = (() => {
  let navigating     = false;
  let pending        = null;
  let resizeObs      = null;
  let resizeTimer    = null;
  let cfiSnap        = '';
  let touchStartX    = 0;
  let touchStartY    = 0;
  let touchStartTime = 0;
  let gestureAxis    = null;
  let _atStart       = false;
  let _atEnd         = false;

  function acquire() {
    if (navigating) return false;
    navigating = true; return true;
  }
  function release() {
    navigating = false;
    if (pending) {
      const p = pending; pending = null;
      p === 'next' ? next() : prev();
    }
  }
  function onRelocated(location) {
    release();
    if (location) { _atStart = !!location.atStart; _atEnd = !!location.atEnd; }
  }
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

  function _triggerPageTransition(dir) {
    const mode = store.pageTransition || 'fade';
    if (mode === 'fade') return;

    const vp = DOMProxy.get('viewer-viewport');
    if (!vp || vp === DOMProxy.VOID_NODE) return;

    if (mode === 'slide') {
      vp.style.transition = 'none';
      vp.style.transform  = `translateX(${dir === 'next' ? '4%' : '-4%'})`;
      vp.style.opacity    = '0.7';
      requestAnimationFrame(() => {
        vp.style.transition = 'transform 260ms cubic-bezier(0.25,0.8,0.25,1), opacity 220ms';
        vp.style.transform  = 'translateX(0)';
        vp.style.opacity    = '1';
        setTimeout(() => {
          vp.style.transition = '';
          vp.style.transform  = '';
          vp.style.opacity    = '';
        }, 280);
      });
    } else if (mode === 'flip3d') {
      vp.style.transition      = 'none';
      vp.style.transformOrigin = dir === 'next' ? 'left center' : 'right center';
      vp.style.transform       = `perspective(1200px) rotateY(${dir === 'next' ? '8deg' : '-8deg'})`;
      vp.style.opacity         = '0.85';
      requestAnimationFrame(() => {
        vp.style.transition = 'transform 320ms cubic-bezier(0.23,1,0.32,1), opacity 250ms';
        vp.style.transform  = 'perspective(1200px) rotateY(0deg)';
        vp.style.opacity    = '1';
        setTimeout(() => {
          vp.style.transition      = '';
          vp.style.transform       = '';
          vp.style.opacity         = '';
          vp.style.transformOrigin = '';
        }, 340);
      });
    }
  }

  function _playBounce(dir) {
    const vp = DOMProxy.get('viewer-viewport');
    if (!vp || vp === DOMProxy.VOID_NODE) return;
    const tx = dir === 'prev' ? '12px' : '-12px';
    vp.style.transition = 'none';
    vp.style.transform  = `translateX(${tx})`;
    requestAnimationFrame(() => {
      vp.style.transition = 'transform 380ms cubic-bezier(0.34,1.56,0.64,1)';
      vp.style.transform  = 'translateX(0)';
      setTimeout(() => { vp.style.transition = ''; vp.style.transform = ''; }, 400);
    });
  }

  function _initResize(rendition) {
    const vp = DOMProxy.get('viewer-viewport');
    if (!DOMProxy.exists('viewer-viewport') || typeof ResizeObserver === 'undefined') return;

    resizeObs = new ResizeObserver(() => {
      if (!store.rendition || !store.isViewerOpen) return;
      if (store.currentCFI) cfiSnap = store.currentCFI;
      ResizeMask.show();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(async () => {
        if (!store.rendition || !store.isViewerOpen) { ResizeMask.hide(); return; }

        const centerCfi = CFIPrecisionGuard.snapCenterCfi();
        const targetCfi = centerCfi || cfiSnap;

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
          if (targetCfi) await rendition.display(targetCfi).catch(() => {});
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
    const SWIPE_MIN    = 50;
    const AXIS_LOCK    = 8;
    const EDGE_PX      = window.innerWidth * 0.1;
    const VELOCITY_MIN = 0.35;
    let lastX = 0, lastT = 0, velocity = 0;

    const onStart = (e) => {
      const panel = DOMProxy.get('settings-panel'), toc = DOMProxy.get('toc-sidebar');
      if (panel.contains?.(e.target) || toc.contains?.(e.target)) return;
      touchStartX    = e.touches[0].clientX;
      touchStartY    = e.touches[0].clientY;
      touchStartTime = Date.now();
      gestureAxis    = null;
      lastX = touchStartX; lastT = touchStartTime; velocity = 0;
    };
    const onMove = (e) => {
      if (gestureAxis === 'y') return;
      const cx = e.touches[0].clientX;
      const dx = Math.abs(cx - touchStartX);
      const dy = Math.abs(e.touches[0].clientY - touchStartY);
      if (gestureAxis === null && (dx > AXIS_LOCK || dy > AXIS_LOCK))
        gestureAxis = dx >= dy ? 'x' : 'y';
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
      const deltaX  = e.changedTouches[0].clientX - touchStartX;
      gestureAxis   = null;
      if (touchStartX < EDGE_PX || touchStartX > window.innerWidth - EDGE_PX) return;
      const farEnough = Math.abs(deltaX) >= SWIPE_MIN && elapsed <= 500;
      const fastFlick = Math.abs(velocity) >= VELOCITY_MIN && Math.abs(deltaX) > 16;
      if (!farEnough && !fastFlick) return;
      const dir = (Math.abs(velocity) >= VELOCITY_MIN)
        ? (velocity < 0 ? 'next' : 'prev')
        : (deltaX  < 0 ? 'next' : 'prev');

      if (dir === 'prev' && _atStart) { _playBounce('prev'); return; }
      if (dir === 'next' && _atEnd)   { _playBounce('next'); return; }

      _triggerPageTransition(dir);
      dir === 'next' ? next() : prev();
    };

    ResourceRegistry.addListener(viewer, 'touchstart', onStart, { passive: true  });
    ResourceRegistry.addListener(viewer, 'touchmove',  onMove,  { passive: false });
    ResourceRegistry.addListener(viewer, 'touchend',   onEnd,   { passive: true  });
  }

  function init(rendition) {
    navigating = false; pending = null; gestureAxis = null;
    _atStart = false; _atEnd = false;
    _initResize(rendition);
    _initTouch();
  }
  function destroy() {
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    clearTimeout(resizeTimer);
    navigating = false; pending = null;
  }

  return { init, destroy, prev, next, onRelocated };
})();

/* ══════════════════════════════════════════════════════════════════
   locations 백그라운드 생성
   ══════════════════════════════════════════════════════════════════ */
export function generateLocationsBackground(book) {
  if (typeof window !== 'undefined' && typeof window.Worker === 'function') {
    try {
      const code = [
        'self.onmessage=function(e){',
        'var l=e.data.spineLength||10,list=[];',
        'for(var i=0;i<l;i++)',
        'list.push("epubcfi(/6/"+(i*2+2)+"[s"+i+"]!/4/2)");',
        'self.postMessage({list:list});};',
      ].join('');
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      const w   = new Worker(url);
      w.postMessage({ spineLength: book.spine?.items?.length || 10 });
      w.onmessage = (e) => { store.totalLocations = e.data.list.length; URL.revokeObjectURL(url); w.terminate(); };
      w.onerror   = ()  => { URL.revokeObjectURL(url); w.terminate(); };
    } catch (_) {}
  }
  book.locations.generate(1600)
    .then(l => { store.totalLocations = Math.max(store.totalLocations, l.length); })
    .catch(() => {});
}
