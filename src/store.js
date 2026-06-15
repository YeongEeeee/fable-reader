/**
 * src/store.js
 * ───────────────────────────────────────────────────────────────
 * Fable Premium 모듈러 코어 — 전역 상태 + 유틸리티 기반 레이어
 *
 * 보존된 아키텍처:
 *   - ErrorBoundary  : 도메인별 예외 격리 매니저
 *   - DOMProxy       : Null-Safe DOM 접근 프록시 (VOID_NODE)
 *   - ReactiveStore  : Proxy 기반 리액티브 스토어 (rAF 배치 알림)
 *   - Toast          : 스택형 토스트 알림
 *   - 상수/유틸       : LH_MAP, DB 상수, setTextSafe, base64 변환
 *
 * 모든 하위 모듈은 이 파일에서 store / DOMProxy / ErrorBoundary 등을
 * import 하여 단일 상태원(single source of truth)을 공유한다.
 * ─────────────────────────────────────────────────────────────── */

'use strict';

/* ══════════════════════════════════════════════════════════
   §0. 상수
   ══════════════════════════════════════════════════════════ */
export const LH_MAP    = { narrow: '1.5', normal: '1.85', wide: '2.3' };
export const STATE_KEY = 'fable_v3_state';
export const SYNC_TAG  = 'fable-annotation-sync';
export const DB_NAME   = 'FableV3DB';
export const DB_VER    = 6; /* v6: 태그 인덱스 + readingLog 스토어 + fileHash 유니크 인덱스 */
export const RECENT_MAX = 3; /* 최근 읽은 책 표시 개수 */

/* ══════════════════════════════════════════════════════════
   §1. Error Boundary Manager
   ══════════════════════════════════════════════════════════ */
export const ErrorBoundary = (() => {
  const handlers = {};

  function register(domain, handler) { handlers[domain] = handler; }

  function handle(domain, err, context) {
    const msg = `[Fable:${domain}]${context ? ' ' + context + ':' : ''} ${err?.message ?? err}`;
    console.error(msg, err);
    try { (handlers[domain] ?? handlers['global'])?.(err, context); } catch (_) {}
  }

  function wrap(domain, fn) {
    return async (...args) => {
      try { return await fn(...args); } catch (err) { handle(domain, err, fn.name); return null; }
    };
  }

  return { register, handle, wrap };
})();

/* ══════════════════════════════════════════════════════════
   §2. Null-Safe DOMProxy
   ══════════════════════════════════════════════════════════ */
export const DOMProxy = (() => {
  const cache = new Map();

  const VOID_NODE = new Proxy(Object.create(null), {
    get(_, prop) {
      if (prop === 'style')     return new Proxy({}, { set() { return true; }, get() { return ''; } });
      if (prop === 'classList') return { add(){}, remove(){}, toggle(){}, contains(){ return false; } };
      if (prop === 'dataset')   return new Proxy({}, { set(){ return true; }, get(){ return ''; } });
      const NO_OPS = ['addEventListener','removeEventListener','appendChild','querySelector',
                      'querySelectorAll','focus','click','remove','setAttribute',
                      'removeAttribute','dispatchEvent','contains'];
      if (NO_OPS.includes(prop)) return () => VOID_NODE;
      if (['textContent','innerHTML','value','src'].includes(prop)) return '';
      if (prop === 'offsetHeight') return 0;
      if (prop === 'disabled') return false;
      return VOID_NODE;
    },
    set() { return true; },
  });

  return {
    VOID_NODE,
    get(id) {
      if (!cache.has(id)) cache.set(id, document.getElementById(id) ?? VOID_NODE);
      return cache.get(id);
    },
    exists(id) { return !!document.getElementById(id); },
    q(sel)     { return document.querySelector(sel) ?? VOID_NODE; },
    qa(sel)    { return Array.from(document.querySelectorAll(sel)); },
    invalidate(id) { id ? cache.delete(id) : cache.clear(); },
  };
})();

/* ══════════════════════════════════════════════════════════
   §3. Proxy 기반 Reactive Store
   ══════════════════════════════════════════════════════════ */
export const ReactiveStore = (() => {
  const subscribers = new Map();
  let   pendingKeys = new Set();
  let   flushQueued = false;

  function _flush() {
    flushQueued = false;
    const keys = [...pendingKeys];
    pendingKeys.clear();
    keys.forEach(key => {
      (subscribers.get(key) ?? new Set()).forEach(fn => {
        try { fn(store[key]); } catch (e) { ErrorBoundary.handle('global', e, 'store:' + key); }
      });
      (subscribers.get('*') ?? new Set()).forEach(fn => {
        try { fn(key, store[key]); } catch (e) { ErrorBoundary.handle('global', e, 'store:*'); }
      });
    });
  }

  function _notify(key) {
    pendingKeys.add(key);
    if (!flushQueued) { flushQueued = true; requestAnimationFrame(_flush); }
  }

  const rawState = {
    book: null, rendition: null, toc: [], currentHref: '',
    totalLocations: 0, currentCFI: '', isTocOpen: false, isSettingsOpen: false,
    bookKey: '', indexedDB: null, navBarsVisible: true, isScrollMode: false,
    readingSession: { startTime: Date.now(), accumulated: 0, positions: new Set() },
    fontSize: 100, lineHeight: 'normal', theme: 'paper', flow: 'paginated',
    userBg: '#f4f1ea', userInk: '#1a1814', userSpacing: 0, userLeading: 1.85,
    /* [U1] 서재 화면에서도 설정 패널 열림 여부 추적 */
    isViewerOpen: false,
    /* [v5] 서재 데이터 상태 트리 — 변경 시 그리드 자동 재렌더 */
    libraryBooks:   [],   /* 전체 도서 캐시 */
    folders:        [],   /* 폴더 목록 */
    activeFolderId: null, /* 현재 필터된 폴더 (null = 전체) */
    /* [v6] 태그·필터·정렬·통계 */
    allTags:        [],   /* 전역 태그 목록 (도서들로부터 집계) */
    activeTags:     [],   /* 다중 선택된 태그 필터 */
    sortMode:       'recent', /* recent | title | progress | added */
    librarySearch:  '',   /* 풀텍스트 서재 검색어 */
    readingLog:     {},   /* { 'YYYY-MM-DD': seconds } 일별 누적 독서시간 */
    dailyGoalMin:   30,   /* 일일 목표(분) */
    pomodoroState:  'idle', /* idle | focus | break */
    fontFamily:     'gowun', /* 본문 서체 id */
  };

  const store = new Proxy(rawState, {
    set(target, key, value) {
      if (target[key] === value) return true;
      target[key] = value;
      _notify(key);
      return true;
    },
    get(target, key) { return target[key]; },
  });

  function subscribe(key, fn) {
    if (!subscribers.has(key)) subscribers.set(key, new Set());
    subscribers.get(key).add(fn);
    return () => subscribers.get(key)?.delete(fn);
  }

  function patch(updates) { Object.entries(updates).forEach(([k, v]) => { store[k] = v; }); }

  return { store, subscribe, patch };
})();

/* 전역 단일 상태 인스턴스 — 모든 모듈이 공유 */
export const store = ReactiveStore.store;

/* ══════════════════════════════════════════════════════════
   §4. Toast
   ══════════════════════════════════════════════════════════ */
export const Toast = (() => {
  const DURATION = 3000, FADE_OUT = 280, MAX_STACK = 4;
  let queue = [];

  function show(message, type = 'info') {
    const container = DOMProxy.get('global-toast-container');
    if (queue.length >= MAX_STACK) {
      const oldest = queue.shift();
      if (oldest?.parentNode) { oldest.classList.add('out'); setTimeout(() => oldest.remove(), FADE_OUT); }
    }
    const el = document.createElement('div');
    el.className = `toast${type !== 'info' ? ' ' + type : ''}`;
    el.textContent = message;
    container.appendChild(el);
    queue.push(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => { el.remove(); queue = queue.filter(t => t !== el); }, FADE_OUT);
    }, DURATION);
  }
  return { show };
})();

/* ErrorBoundary 도메인 핸들러 등록 (Toast 의존) */
ErrorBoundary.register('global',   (e) => Toast.show(`오류: ${e?.message ?? '알 수 없는 오류'}`, 'error'));
ErrorBoundary.register('storage',  (e) => Toast.show(`저장소 오류: ${e?.message}`, 'error'));
ErrorBoundary.register('renderer', (e) => Toast.show(`렌더링 오류: ${e?.message}`, 'error'));
ErrorBoundary.register('network',  (e) => console.warn('[Network]', e?.message));

/* ══════════════════════════════════════════════════════════
   §5. XSS 유틸 + 직렬화 헬퍼
   ══════════════════════════════════════════════════════════ */
export function setTextSafe(el, text) {
  if (el && el !== DOMProxy.VOID_NODE) el.textContent = String(text ?? '');
}

/* ArrayBuffer ↔ base64 (백업/복원 직렬화용) */
export function _abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
export function _base64ToAb(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/* ══════════════════════════════════════════════════════════
   §8. Resource Registry (Memory Leak 방지)
   — 뷰어 자원/리스너/타이머 추적 후 일괄 해제
   ══════════════════════════════════════════════════════════ */
export const ResourceRegistry = (() => {
  const listeners = [], storeSubs = [], timers = [], resizeObs = [];

  function addListener(target, type, fn, opts) {
    if (!target || target === DOMProxy.VOID_NODE) return;
    target.addEventListener(type, fn, opts);
    listeners.push({ target, type, fn, opts });
  }
  function addStoreSub(unsub) { storeSubs.push(unsub); }
  function addTimer(id)       { timers.push(id); return id; }
  function addResizeObserver(obs) { resizeObs.push(obs); }

  function releaseAll() {
    listeners.forEach(({ target, type, fn, opts }) => { try { target.removeEventListener(type, fn, opts); } catch (_) {} });
    listeners.length = 0;
    storeSubs.forEach(unsub => { try { unsub(); } catch (_) {} });
    storeSubs.length = 0;
    timers.forEach(id => { clearTimeout(id); clearInterval(id); });
    timers.length = 0;
    resizeObs.forEach(obs => { try { obs.disconnect(); } catch (_) {} });
    resizeObs.length = 0;
  }
  return { addListener, addStoreSub, addTimer, addResizeObserver, releaseAll };
})();

/* ══════════════════════════════════════════════════════════
   화면 전환 / 로딩 오버레이 / 리사이즈 마스크 / 임포트 진행바
   — 여러 UI 모듈이 공유하는 경량 위젯 (store 레이어에 배치)
   ══════════════════════════════════════════════════════════ */
export function showViewerScreen() {
  const up = DOMProxy.get('screen-uploader'), vi = DOMProxy.get('screen-viewer');
  up.style.transition = 'opacity 300ms ease, transform 300ms ease';
  up.style.opacity    = '0'; up.style.transform = 'scale(0.97)';
  setTimeout(() => {
    up.style.display = 'none'; up.style.opacity = ''; up.style.transform = '';
    vi.style.display = 'flex'; vi.style.opacity = '0'; vi.style.transform = 'scale(1.02)';
    vi.style.transition = 'opacity 300ms ease, transform 300ms ease';
    requestAnimationFrame(() => requestAnimationFrame(() => { vi.style.opacity = '1'; vi.style.transform = 'scale(1)'; }));
  }, 300);
  store.isViewerOpen = true;
}

export function showUploaderScreen() {
  const up = DOMProxy.get('screen-uploader'), vi = DOMProxy.get('screen-viewer');
  vi.style.transition = 'opacity 260ms ease'; vi.style.opacity = '0';
  setTimeout(() => {
    vi.style.display = 'none'; vi.style.opacity = ''; vi.style.transition = '';
    up.style.display = 'flex'; up.style.opacity = '0';
    up.style.transition = 'opacity 260ms ease';
    requestAnimationFrame(() => requestAnimationFrame(() => { up.style.opacity = '1'; }));
    setTimeout(() => { up.style.transition = ''; }, 300);
  }, 260);
  store.isViewerOpen = false;
}

export const LoadingOverlay = (() => {
  let el = null;
  function show(msg = '도서를 불러오는 중...') {
    if (el) return;
    el = document.createElement('div'); el.className = 'loading-overlay';
    const p = document.createElement('p'); p.textContent = msg;
    el.innerHTML = '<div class="spinner"></div>'; el.appendChild(p);
    const vi = DOMProxy.get('screen-viewer');
    if (DOMProxy.exists('screen-viewer')) vi.appendChild(el);
  }
  function hide() {
    if (!el) return;
    el.classList.add('fade-out'); setTimeout(() => { el?.remove(); el = null; }, 260);
  }
  return { show, hide };
})();

export const ResizeMask = {
  show() { DOMProxy.get('resize-mask').style.display = 'flex'; },
  hide() { DOMProxy.get('resize-mask').style.display = 'none'; },
};

export const ImportProgress = (() => {
  function show(text = '도서 추가 중...') {
    const bar = DOMProxy.get('import-progress-bar');
    bar.style.display = 'flex';
    setTextSafe(DOMProxy.get('import-progress-text'), text);
    DOMProxy.get('import-progress-fill').style.width = '0%';
  }
  function update(pct, text) {
    DOMProxy.get('import-progress-fill').style.width = `${pct}%`;
    if (text) setTextSafe(DOMProxy.get('import-progress-text'), text);
  }
  function hide() {
    const bar = DOMProxy.get('import-progress-bar');
    bar.style.display = 'none';
  }
  return { show, update, hide };
})();
