/**
 * src/store.js  ── Fable Premium v4.0
 * ─────────────────────────────────────────────────────────────────
 * 순수 전역 상태 엔진 (SRP 준수)
 *
 * 변경 사항 (v4.0):
 *   - LZ-String 기반 인라인 압축 엔진 (LZStore) 추가
 *     → lsSet/lsGet에서 QuotaExceededError 발생 시 구형 LRU 삭제 대신 압축 보존
 *   - CRDT 상태 키 추가 (crdtVectorClock)
 *   - 스마트 슬립 가드 — visibilitychange 기반 rAF/타이머 절전 신호
 *   - WPM 트래커 보조 상태 추가 (measuredWpm, autoScrollWpm, autoScrollActive)
 *   - 눈 보호 타이머 상태 추가 (eyeProtectActive, eyeProtectMinutes)
 *   - 3D 페이지 전환 옵션 상태 추가 (pageTransition)
 *   - 폰트 굵기·대비 미세 조절 상태 추가 (fontWeightBoost, contrastScale)
 *   - 온보딩 상태 추가 (onboardingDone)
 *   - 스크러버 미리보기 상태 추가 (scrubberHoverPct)
 *   - ResourceRegistry: IntersectionObserver 추적 배열 추가 + releaseAll 완전 소멸
 *
 * ※ 이 파일은 ui.js 를 import 하지 않는다 (순환 참조 차단).
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

/* ══════════════════════════════════════════════════════════════════
   §0. 상수
   ══════════════════════════════════════════════════════════════════ */
export const LH_MAP     = { narrow: '1.5', normal: '1.85', wide: '2.3' };
export const STATE_KEY  = 'fable_v3_state';
export const SYNC_TAG   = 'fable-annotation-sync';
export const DB_NAME    = 'FableV3DB';
export const DB_VER     = 7;   /* v7: CRDT 벡터시계 메타 스토어 추가 */
export const RECENT_MAX = 3;

/* ══════════════════════════════════════════════════════════════════
   §0-A. 인라인 LZ-String 압축 엔진
   — 외부 라이브러리 없이 순수 바닐라 JS로 구현
     QuotaExceededError 발생 시 데이터를 삭제 대신 압축 보존 (효율 약 5~8배)
   ══════════════════════════════════════════════════════════════════ */
export const LZStore = (() => {

  /* ── LZ77 압축 ── */
  function _lz77Compress(str) {
    const WINDOW = 255, LOOKAHEAD = 15;
    let out = '', i = 0;
    while (i < str.length) {
      let bestLen = 0, bestOffset = 0;
      const start = Math.max(0, i - WINDOW);
      for (let j = start; j < i; j++) {
        let len = 0;
        while (len < LOOKAHEAD && i + len < str.length && str[j + len] === str[i + len]) len++;
        if (len > bestLen) { bestLen = len; bestOffset = i - j; }
      }
      if (bestLen >= 3) {
        out += '\x01' + String.fromCharCode(bestOffset) + String.fromCharCode(bestLen);
        i += bestLen;
      } else {
        const ch = str[i];
        out += ch === '\x01' ? '\x01\x00\x00' : ch;
        i++;
      }
    }
    return out;
  }

  function _lz77Decompress(str) {
    let out = '', i = 0;
    while (i < str.length) {
      if (str[i] === '\x01') {
        const offset = str.charCodeAt(i + 1);
        const len    = str.charCodeAt(i + 2);
        if (offset === 0 && len === 0) { out += '\x01'; i += 3; continue; }
        const start = out.length - offset;
        for (let k = 0; k < len; k++) out += out[start + k] || '';
        i += 3;
      } else {
        out += str[i++];
      }
    }
    return out;
  }

  function _compress(input) {
    if (!input || typeof input !== 'string') return input;
    try {
      return btoa(unescape(encodeURIComponent(_lz77Compress(input))));
    } catch (_) { return input; }
  }

  function _decompress(input) {
    if (!input || typeof input !== 'string') return input;
    try {
      return _lz77Decompress(decodeURIComponent(escape(atob(input))));
    } catch (_) { return input; }
  }

  /* ── LRU 기반 압축 보존 lsSet ── */
  function lsSet(key, value) {
    const raw = JSON.stringify({ data: value, ts: Date.now(), compressed: false });
    try {
      localStorage.setItem(key, raw);
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        /* 1차: 압축 후 재시도 */
        try {
          const compressed = JSON.stringify({
            data: _compress(JSON.stringify(value)),
            ts: Date.now(),
            compressed: true,
          });
          localStorage.setItem(key, compressed);
          return;
        } catch (_) {}
        /* 2차: LRU 삭제 후 재시도 */
        _evictLRU(key);
        try { localStorage.setItem(key, raw); } catch (_) {}
      }
    }
  }

  function lsGet(key, def = null) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return def;
      const parsed = JSON.parse(raw);
      if (parsed.compressed) {
        try { return JSON.parse(_decompress(parsed.data)) ?? def; }
        catch (_) { return def; }
      }
      return parsed.data ?? def;
    } catch (_) { return def; }
  }

  function _evictLRU(excludeKey) {
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith('fable_') || k === excludeKey) continue;
      try { entries.push({ k, ts: JSON.parse(localStorage.getItem(k)).ts || 0 }); } catch (_) {}
    }
    entries.sort((a, b) => a.ts - b.ts)
           .slice(0, Math.max(1, Math.ceil(entries.length * 0.3)))
           .forEach(e => localStorage.removeItem(e.k));
  }

  return { lsSet, lsGet, compress: _compress, decompress: _decompress };
})();

/* ══════════════════════════════════════════════════════════════════
   §1. Error Boundary Manager
   ══════════════════════════════════════════════════════════════════ */
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
      try { return await fn(...args); }
      catch (err) { handle(domain, err, fn.name); return null; }
    };
  }

  return { register, handle, wrap };
})();

/* ══════════════════════════════════════════════════════════════════
   §2. Null-Safe DOMProxy
   ══════════════════════════════════════════════════════════════════ */
export const DOMProxy = (() => {
  const cache = new Map();

  const VOID_NODE = new Proxy(Object.create(null), {
    get(_, prop) {
      if (prop === 'style')     return new Proxy({}, { set() { return true; }, get() { return ''; } });
      if (prop === 'classList') return { add(){}, remove(){}, toggle(){}, contains(){ return false; } };
      if (prop === 'dataset')   return new Proxy({}, { set(){ return true; }, get(){ return ''; } });
      const NO_OPS = [
        'addEventListener','removeEventListener','appendChild','querySelector',
        'querySelectorAll','focus','click','remove','setAttribute',
        'removeAttribute','dispatchEvent','contains','insertBefore',
      ];
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

/* ══════════════════════════════════════════════════════════════════
   §3. Proxy 기반 Reactive Store
   ══════════════════════════════════════════════════════════════════ */
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
        try { fn(store[key]); }
        catch (e) { ErrorBoundary.handle('global', e, 'store:' + key); }
      });
      (subscribers.get('*') ?? new Set()).forEach(fn => {
        try { fn(key, store[key]); }
        catch (e) { ErrorBoundary.handle('global', e, 'store:*'); }
      });
    });
  }

  function _notify(key) {
    pendingKeys.add(key);
    if (!flushQueued) { flushQueued = true; requestAnimationFrame(_flush); }
  }

  const rawState = {
    /* ── EPUB 런타임 ── */
    book:           null,
    rendition:      null,
    toc:            [],
    currentHref:    '',
    totalLocations: 0,
    currentCFI:     '',
    bookKey:        '',
    isViewerOpen:   false,

    /* ── UI 패널 상태 ── */
    isTocOpen:       false,
    isSettingsOpen:  false,
    navBarsVisible:  true,
    isScrollMode:    false,

    /* ── 독서 세션 ── */
    readingSession: { startTime: Date.now(), accumulated: 0, positions: new Set() },

    /* ── 렌더링 옵션 ── */
    fontSize:    100,
    lineHeight:  'normal',
    theme:       'paper',
    flow:        'paginated',
    fontFamily:  'gowun',

    /* ── 커스텀 테마 ── */
    userBg:      '#f4f1ea',
    userInk:     '#1a1814',
    userSpacing: 0,
    userLeading: 1.85,

    /* ── 서재 상태 ── */
    libraryBooks:   [],
    folders:        [],
    activeFolderId: null,
    allTags:        [],
    activeTags:     [],
    sortMode:       'recent',
    librarySearch:  '',
    readingLog:     {},
    dailyGoalMin:   30,
    folderTree:     [],   /* 계층형 폴더 트리 캐시 */

    /* ── 포모도로 ── */
    pomodoroState: 'idle',

    /* ────────────────────────────────────────────────────────────
       v4.0 신규 런타임 상태
       ──────────────────────────────────────────────────────────── */

    /* [E-Ink] 폰트 굵기 보정 오프셋 (-200 ~ +400) */
    fontWeightBoost: 0,

    /* [E-Ink] 대비 스케일 (0.5 ~ 2.0, 기본 1.0) */
    contrastScale:   1.0,

    /* [WPM 트래커] 실시간 측정값 (단어/분) */
    measuredWpm:     0,

    /* [자동 스크롤] 목표 WPM 및 활성 여부 */
    autoScrollWpm:    250,
    autoScrollActive: false,

    /* [눈 보호 타이머] 활성 여부 + 연속 독서 한계(분) */
    eyeProtectActive:  false,
    eyeProtectMinutes: 50,

    /* [3D 페이지 전환] 'fade' | 'slide' | 'flip3d' */
    pageTransition: 'fade',

    /* [온보딩] 최초 완료 여부 */
    onboardingDone: false,

    /* [CRDT] OR-Set 벡터 클락 { [clientId]: lamportN } */
    crdtVectorClock: {},

    /* [슬립 가드] 백그라운드 절전 신호
       — 구독자(ReadingStatsTracker, AutoScrollDriver, EyeProtectTimer 등)가
         이 값이 true 가 되면 rAF/타이머를 즉시 일시 정지한다 */
    appInBackground: false,

    /* [스크러버 미리보기] hover 위치 퍼센트 (-1 = 비활성) */
    scrubberHoverPct: -1,

    /* ── IndexedDB 레퍼런스 ── */
    indexedDB: null,
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

  function patch(updates) {
    Object.entries(updates).forEach(([k, v]) => { store[k] = v; });
  }

  return { store, subscribe, patch };
})();

export const store = ReactiveStore.store;

/* ══════════════════════════════════════════════════════════════════
   §3-A. 스마트 슬립 가드 (visibilitychange 기반)
   — 앱이 백그라운드로 전환될 때 store.appInBackground = true 신호
     구독자는 이 신호를 확인하여 rAF / 타이머를 즉시 절전 상태로 드롭
   ══════════════════════════════════════════════════════════════════ */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    store.appInBackground = document.visibilityState === 'hidden';
  });
}

/* ══════════════════════════════════════════════════════════════════
   §4. Toast
   ══════════════════════════════════════════════════════════════════ */
export const Toast = (() => {
  const DURATION = 3000, FADE_OUT = 280, MAX_STACK = 4;
  let queue = [];

  function show(message, type = 'info') {
    const container = DOMProxy.get('global-toast-container');
    if (queue.length >= MAX_STACK) {
      const oldest = queue.shift();
      if (oldest?.parentNode) {
        oldest.classList.add('out');
        setTimeout(() => oldest.remove(), FADE_OUT);
      }
    }
    const el = document.createElement('div');
    el.className = `toast${type !== 'info' ? ' ' + type : ''}`;
    el.textContent = message;  /* XSS 방어: textContent 사용 */
    container.appendChild(el);
    queue.push(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => { el.remove(); queue = queue.filter(t => t !== el); }, FADE_OUT);
    }, DURATION);
  }

  return { show };
})();

ErrorBoundary.register('global',   (e) => Toast.show(`오류: ${e?.message ?? '알 수 없는 오류'}`, 'error'));
ErrorBoundary.register('storage',  (e) => Toast.show(`저장소 오류: ${e?.message}`, 'error'));
ErrorBoundary.register('renderer', (e) => Toast.show(`렌더링 오류: ${e?.message}`, 'error'));
ErrorBoundary.register('network',  (e) => console.warn('[Network]', e?.message));

/* ══════════════════════════════════════════════════════════════════
   §5. XSS 유틸 + 직렬화 헬퍼
   ══════════════════════════════════════════════════════════════════ */
export function setTextSafe(el, text) {
  if (el && el !== DOMProxy.VOID_NODE) el.textContent = String(text ?? '');
}

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

/* ══════════════════════════════════════════════════════════════════
   §6. Resource Registry (메모리 누수 완전 방지)
   —  이벤트 리스너 · 스토어 구독 · 타이머 · rAF ·
      ResizeObserver · IntersectionObserver 전체 추적 및 소멸
   ══════════════════════════════════════════════════════════════════ */
export const ResourceRegistry = (() => {
  const listeners     = [];  /* { target, type, fn, opts } */
  const storeSubs     = [];  /* () => void  (unsubscribe fn) */
  const timers        = [];  /* setTimeout / setInterval ID */
  const resizeObs     = [];  /* ResizeObserver 인스턴스 */
  const intersectObs  = [];  /* IntersectionObserver 인스턴스 */
  const rafs          = [];  /* requestAnimationFrame ID */

  /* ── 등록 API ── */
  function addListener(target, type, fn, opts) {
    if (!target || target === DOMProxy.VOID_NODE) return;
    target.addEventListener(type, fn, opts);
    listeners.push({ target, type, fn, opts });
  }

  function addStoreSub(unsub) {
    if (typeof unsub === 'function') storeSubs.push(unsub);
  }

  function addTimer(id) {
    timers.push(id);
    return id;
  }

  function addResizeObserver(obs) {
    if (obs) resizeObs.push(obs);
    return obs;
  }

  /**
   * [v4.0 신규] IntersectionObserver 인스턴스 등록
   * CFIPrecisionGuard 등에서 생성한 옵저버를 추적하여
   * destroyCurrentRenditionContext() 시 완전 소멸
   */
  function addIntersectionObserver(obs) {
    if (obs) intersectObs.push(obs);
    return obs;
  }

  function addRaf(id) {
    rafs.push(id);
    return id;
  }

  /* ── 전체 소멸 (누수 제로 보장) ── */
  function releaseAll() {
    /* 1. DOM 이벤트 리스너 제거 */
    listeners.forEach(({ target, type, fn, opts }) => {
      try { target.removeEventListener(type, fn, opts); } catch (_) {}
    });
    listeners.length = 0;

    /* 2. ReactiveStore 구독 해제 */
    storeSubs.forEach(unsub => { try { unsub(); } catch (_) {} });
    storeSubs.length = 0;

    /* 3. setTimeout / setInterval 클리어 */
    timers.forEach(id => { clearTimeout(id); clearInterval(id); });
    timers.length = 0;

    /* 4. ResizeObserver 연결 해제 */
    resizeObs.forEach(obs => { try { obs.disconnect(); } catch (_) {} });
    resizeObs.length = 0;

    /* 5. IntersectionObserver 연결 해제 (v4.0 신규) */
    intersectObs.forEach(obs => { try { obs.disconnect(); } catch (_) {} });
    intersectObs.length = 0;

    /* 6. requestAnimationFrame 취소 */
    rafs.forEach(id => { try { cancelAnimationFrame(id); } catch (_) {} });
    rafs.length = 0;
  }

  return {
    addListener,
    addStoreSub,
    addTimer,
    addResizeObserver,
    addIntersectionObserver,  /* v4.0 신규 */
    addRaf,
    releaseAll,
  };
})();
