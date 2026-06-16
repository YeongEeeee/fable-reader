/**
 * src/reader.js  ── Fable Premium v4.0
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

/* 마지막 안전망: 정적 import가 어떤 이유로든 전역을 주입하지 못한
   극단적 환경에서, CDN UMD 스크립트를 주입해 window 전역을 복구한다. */
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
      if (typeof window.JSZip !== 'function' && JSZipLib)
        window.JSZip = JSZipLib.default || JSZipLib;
      if (typeof window.ePub !== 'function' && ePubLib)
        window.ePub = ePubLib.default || ePubLib;
      /* 2차: 그래도 없으면 CDN 폴백 */
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
      if (isEpubRuntimeReady())           { clearInterval(interval); resolve(true);  return; }
      if (Date.now() - start >= maxWaitMs){ clearInterval(interval); resolve(false); }
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
  if (!document.fonts?.load) return true;  /* API 미지원 환경 — 폴백 허용 */
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
  let _observer     = null;
  let _lastCenterCfi = '';

  /**
   * init(): IntersectionObserver를 뷰포트 기준으로 초기화
   * iframe 내부 단락을 직접 관찰할 수 없으므로,
   * 리사이즈 이벤트 시 snapCenterCfi()를 명시적으로 호출하는 구조를 사용
   */
  function init() {
    if (_observer) return;
    if (typeof IntersectionObserver === 'undefined') return;
    /* epub.js iframe sandbox 제약으로 iframe 내부 요소를
       부모 컨텍스트의 IntersectionObserver로 직접 observe 불가.
       → resize 이벤트 후 snapCenterCfi()를 수동 트리거하는 방식 채택.
       미래 확장 포인트: postMessage 기반 iframe ↔ host 브릿지 추가 가능. */
    _observer = {};  /* 초기화 완료 마커 */
  }

  /**
   * snapCenterCfi(): iframe 문서에서 뷰포트 수직 중앙에 가장 가까운
   * paragraph/heading 요소를 탐색하고, 현재 rendition CFI를 메모이제이션
   * — 리사이즈 마스크 해제 직전에 NavGuard._initResize()가 호출
   */
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
        /* p, h1~h4, li — 단락 단위 탐색 */
        const paras = doc.querySelectorAll('p,h1,h2,h3,h4,li');
        paras.forEach(el => {
          /* iframe 좌표를 host 뷰포트 좌표로 변환 */
          const iRect   = iframe.getBoundingClientRect();
          const elRect  = el.getBoundingClientRect();
          const elTop   = iRect.top + elRect.top;
          const elMid   = elTop + elRect.height / 2;
          const dist    = Math.abs(elMid - vMid);
          if (dist < bestDist) { bestDist = dist; bestEl = el; }
        });
      });

      /* 가장 가까운 요소를 찾았으면 현재 rendition CFI를 메모이제이션 */
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
    /* 현재 구현은 경량 마커 객체이므로 disconnect 불필요.
       미래 IntersectionObserver 인스턴스 추가 시 여기서 해제. */
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
  const SAMPLE_WINDOW  = 10;   /* 최근 10회 넘김 샘플 */
  const WORDS_PER_PAGE = 250;  /* 페이지당 평균 단어 수 추정치 */

  let _samples        = [];  /* [{ ts: number, elapsedMs: number }] */
  let _lastPageTs     = 0;
  let _sessionStartTs = 0;
  let _totalPages     = 0;
  let _wpmRafId       = null; /* rAF 배칭용 */
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
    /* 500ms 미만은 빠른 탐색(스킵)으로 판단 — 샘플 제외 */
    if (elapsed < 500) return;
    _lastPageTs = now;
    _totalPages++;
    _samples.push({ ts: now, elapsedMs: elapsed });
    if (_samples.length > SAMPLE_WINDOW) _samples.shift();
    _scheduleWpmUpdate();
  }

  /* rAF 배칭: 연속 넘김 시 마지막 프레임에서만 store 업데이트 */
  function _scheduleWpmUpdate() {
    if (_wpmRafId) return;
    _wpmRafId = requestAnimationFrame(() => {
      _wpmRafId = null;
      _computeAndCommitWpm();
    });
  }

  function _computeAndCommitWpm() {
    if (_samples.length < 2) return;

    /* IQR 이상치 제거 (Tukey Fence: Q1 - 1.5×IQR ~ Q3 + 1.5×IQR) */
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
    const avgMs = filtered.reduce((s, t) => s + t, 0) / filtered.length;

    /* WPM = (단어/페이지) ÷ (평균 페이지 독서 시간[분]) */
    const wpm = Math.round(WORDS_PER_PAGE / (avgMs / 60_000));
    const clamped = Math.min(1500, Math.max(50, wpm));

    /* store 업데이트는 이미 rAF 내부이므로 즉시 반영 */
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
  let _targetIw = null;  /* 현재 스크롤 대상 iframe.contentWindow */
  let _speed    = 0;     /* px/프레임 */
  let _active   = false;

  /**
   * WPM → px/프레임 변환
   * 분당 픽셀 = WPM × 평균 단어 너비(px) / 줄당 단어 수
   * 프레임당 픽셀 = 분당 픽셀 / (FPS × 60초)
   */
  function _calcPxPerFrame(wpm) {
    const AVG_WORD_PX    = 40;
    const WORDS_PER_LINE = 12;
    const FPS            = 60;
    const pxPerMin       = (wpm * AVG_WORD_PX) / WORDS_PER_LINE;
    return pxPerMin / (FPS * 60);
  }

  function _loop() {
    /* 슬립 가드: 백그라운드 전환 시 루프 종료 */
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

  /* WPM 변경 시 속도 즉시 갱신 */
  function updateSpeed() {
    _speed = _calcPxPerFrame(WPMTracker.getWpm());
  }

  function toggle(view) {
    if (_active) {
      stop();
      Toast.show('자동 스크롤 중지');
    } else {
      /* scrolled 플로우 모드에서만 활성화 */
      const iframe = view?.element?.querySelector?.('iframe');
      if (iframe?.contentWindow && store.flow === 'scrolled') {
        start(iframe.contentWindow);
        Toast.show(`자동 스크롤 시작 (${WPMTracker.getWpm()} WPM)`, 'success');
      } else {
        Toast.show('자동 스크롤은 스크롤(플로우) 모드에서만 사용 가능합니다.', 'info');
      }
    }
  }

  /* 슬립 가드 구독 — appInBackground 전환 즉시 루프 정지/재개 */
  ReactiveStore.subscribe('appInBackground', (hidden) => {
    if (hidden && _active) {
      /* 백그라운드 전환: rAF 취소 (루프 자체는 _active=true 유지) */
      if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    } else if (!hidden && _active) {
      /* 포그라운드 복귀: rAF 재개 */
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

  /* CSS 키프레임 1회 주입 */
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

    /* XSS 방어: DOM 조립 방식 사용 */
    const icon    = document.createElement('div');
    icon.textContent = '👁️';
    icon.style.cssText = 'font-size:28px;margin-bottom:8px';

    const title   = document.createElement('div');
    title.textContent = '시력 보호 휴식 알림';
    title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:4px';

    const desc    = document.createElement('div');
    desc.textContent = `${store.eyeProtectMinutes || 50}분 동안 읽으셨습니다. 잠시 눈을 쉬게 해주세요.`;
    desc.style.cssText = 'font-size:13px;color:#666;margin-bottom:14px';

    const btn     = document.createElement('button');
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
    _elapsedSec = 0;   /* 타이머 리셋 */
    Toast.show('5분간 휴식 후 다시 읽어주세요. 🌿', 'info');
  }

  function _tick() {
    if (_paused || store.appInBackground) return;  /* 슬립 가드 */
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

  /* 슬립 가드: 백그라운드 전환 시 타이머 일시 정지 */
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
            background:      store.userBg  + ' !important',
            color:           store.userInk + ' !important',
            'letter-spacing': store.userSpacing + 'em',
            'line-height':   String(store.userLeading) },
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

  /* [E-Ink] 폰트 굵기 보정 */
  const weightBoost = store.fontWeightBoost || 0;
  const baseWeight  = isDark ? 300 : 400;
  const finalWeight = Math.max(100, Math.min(900, baseWeight + weightBoost));

  /* [E-Ink] 대비 스케일 보정 */
  const contrast = store.contrastScale ?? 1.0;
  const filterVal = isDark
    ? `contrast(${(0.92 * contrast).toFixed(2)})`
    : contrast !== 1.0
      ? `contrast(${contrast.toFixed(2)})`
      : '';

  /* [이미지] 다크 모드 35% 감쇄 (brightness(0.65) = 100% - 35%) */
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
  try { rendition.themes.select(t); }              catch (_) {}
  try { rendition.themes.fontSize(`${store.fontSize}%`); } catch (_) {}
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
  /* 잔여 진행률 버퍼 즉시 커밋 */
  await StorageSystem.flushProgressNow();

  /* 세션 종속 모듈 정리 */
  deps.ReadingStatsTracker.stopSession();
  WPMTracker.stopSession();
  AutoScrollDriver.stop();
  EyeProtectTimer.stop();      /* 눈 보호 타이머도 함께 종료 */

  NavGuard.destroy();
  deps.SearchEngine.destroy();
  deps.AnnotationManager.reset();
  deps.VirtualSearchList.destroy();
  CFICache.clear();
  CFIPrecisionGuard.destroy();

  /* ResourceRegistry 전체 소멸
     (리스너 + 스토어 구독 + 타이머 + ResizeObserver +
      IntersectionObserver + rAF — v4.0 신규 항목 포함) */
  ResourceRegistry.releaseAll();

  /* ──────────────────────────────────────────────────────────
     Phase 1: rendition 이벤트 리스너 전량 명시 탈착
     epub.js Rendition은 EventEmitter 패턴이므로, destroy() 이전에
     등록된 모든 named 이벤트를 r.off()로 명시 탈착한다.
     → 구 rendition 콜백이 store Proxy를 이중 구독하는 누수 차단.
     ────────────────────────────────────────────────────────── */
  if (store.rendition) {
    const r = store.rendition;

    const RENDITION_EVENTS = [
      'relocated', 'keyup', 'click', 'rendered', 'displayed',
      'started', 'attached', 'removed', 'resized', 'orientationchange',
    ];
    for (const ev of RENDITION_EVENTS) {
      try { r.off(ev); } catch (_) {}
    }

    /* ──────────────────────────────────────────────────────────
       Phase 2: hooks 익명화
       destroy() 후에도 epub.js 내부가 hooks.content / hooks.serialize
       등을 flush 하려 할 때 사용자 콜백이 실행되는 것을 차단.
       epub.js EventEmitter의 clear() 또는 직접 배열 교체로 무력화.
       ────────────────────────────────────────────────────────── */
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

    /* ──────────────────────────────────────────────────────────
       Phase 3: rendition.destroy() → iframe 컨텍스트 파기
       ────────────────────────────────────────────────────────── */
    try { r.destroy(); } catch (_) {}
    store.rendition = null;
  }

  /* ──────────────────────────────────────────────────────────
     Phase 4: book.destroy() → 순서 보정
     rendition 파기 이후 book을 파기해야 epub.js 내부
     View Manager가 이미 해제된 rendition에 접근하는 것을 방지.
     ────────────────────────────────────────────────────────── */
  if (store.book) {
    try { store.book.destroy(); } catch (_) {}
    store.book = null;
  }

  /* ──────────────────────────────────────────────────────────
     Phase 5: store 상태 + DOM 소거
     ────────────────────────────────────────────────────────── */
  store.currentCFI     = '';
  store.currentHref    = '';
  store.totalLocations = 0;
  store.toc            = [];
  store.bookKey        = '';
  store.isViewerOpen   = false;
}

export function exitViewer() {
  destroyCurrentRenditionContext().then(() => showUploaderScreen());
}

/* ══════════════════════════════════════════════════════════════════
   flow 전환 (CFI 보정 스케줄러)
   ══════════════════════════════════════════════════════════════════ */
export function switchFlowMode(mode) {
  if (store.flow === mode || !store.book) return;
  const savedCFI  = store.currentCFI;
  const savedBook = store.book;
  store.flow = mode;
  destroyCurrentRenditionContext().then(() => {
    store.book = savedBook;
    initRenditionEngine(savedBook);
    if (savedCFI) {
      ResourceRegistry.addTimer(
        setTimeout(() => { store.rendition?.display(savedCFI).catch(() => {}); }, 350),
      );
    }
  });
}

export function chapterAtPercent(pct) {
  try {
    const toc = store.toc || [];
    if (!toc.length || !store.book?.spine) return '';
    const spineLen = store.book.spine.items.length || 1;
    const idx      = Math.min(spineLen - 1, Math.floor((pct / 100) * spineLen));
    const href     = store.book.spine.items[idx]?.href || '';
    let label      = '';
    const walk = (items) => {
      for (const it of items) {
        const ih = (it.href || '').split('#')[0];
        if (ih && href.includes(ih)) label = it.label?.trim() || label;
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
    if (store.book.locations && store.totalLocations > 0) {
      const cfi = CFICache.getCfi(
        pct / 100,
        () => store.book.locations.cfiFromPercentage(pct / 100),
      );
      if (cfi) { store.rendition.display(cfi).catch(() => {}); return; }
    }
    const spineLen = store.book.spine?.items?.length || 1;
    const idx      = Math.min(spineLen - 1, Math.floor((pct / 100) * spineLen));
    const item     = store.book.spine?.items?.[idx];
    if (item) store.rendition.display(item.href).catch(() => {});
  } catch (e) { ErrorBoundary.handle('renderer', e, 'seekToPercent'); }
}

/* ══════════════════════════════════════════════════════════════════
   NavGuard — 스와이프 관성 + 바운스 + 리사이즈 마스크
   [바운스] 첫/마지막 페이지 고무줄 텐션 인터랙션 (CSS Transform + rAF)
   [3D 전환] fade | slide | flip3d
   ══════════════════════════════════════════════════════════════════ */
export const NavGuard = (() => {
  let navigating = false, pending = null, resizeObs = null, resizeTimer = null;
  let gestureAxis = null, touchStartX = 0, touchStartY = 0, touchStartTime = 0, cfiSnap = '';
  let _atStart = false, _atEnd = false;

  function acquire() {
    if (navigating) return false;
    navigating = true; _setArrows(false);
    return true;
  }
  function release() {
    navigating = false; _setArrows(true);
    if (pending) {
      const d = pending; pending = null;
      requestAnimationFrame(() => d === 'prev' ? prev() : next());
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

  /* [3D 전환] slide / flip3d 애니메이션 */
  function _triggerPageTransition(dir) {
    const mode = store.pageTransition || 'fade';
    if (mode === 'fade') return;  /* 기본값 — epub.js 자체 처리 */

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

  /* [바운스] 첫/마지막 페이지 고무줄 텐션 */
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

        /* [CFI] 리사이즈 시 화면 중앙 CFI 스냅샷 보정 */
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
    const VELOCITY_MIN = 0.35;   /* px/ms — 빠르게 튕기면 짧은 거리도 넘김 */
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
      /* 엣지 영역(좌우 10%) 스와이프 무시 — 오발 방지 */
      if (touchStartX < EDGE_PX || touchStartX > window.innerWidth - EDGE_PX) return;
      const farEnough = Math.abs(deltaX) >= SWIPE_MIN && elapsed <= 500;
      const fastFlick = Math.abs(velocity) >= VELOCITY_MIN && Math.abs(deltaX) > 16;
      if (!farEnough && !fastFlick) return;
      const dir = (Math.abs(velocity) >= VELOCITY_MIN)
        ? (velocity < 0 ? 'next' : 'prev')
        : (deltaX  < 0 ? 'next' : 'prev');

      /* [바운스 가드] 경계 페이지에서 고무줄 텐션 */
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
  /* 폴백: 메인스레드 generate (느리지만 항상 동작) */
  book.locations.generate(1600)
    .then(l => { store.totalLocations = Math.max(store.totalLocations, l.length); })
    .catch(() => {});
}
