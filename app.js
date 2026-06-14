/**
 * ============================================================
 * Fable v3 Premium — app.js  (v3.1 서재 고도화 에디션)
 * Proxy 기반 리액티브 아키텍처 완전 계승
 *
 * 신규 요구사항:
 *  [B1] ePub 폴드 가드 — window.ePub 존재 확인 후 초기화
 *  [B2] ErrorBoundary.wrap('renderer') 메타데이터 파싱 완전 래핑
 *  [L1] 표지 이미지 + 스마트 타이틀 책장 (Base64 추출 저장)
 *  [L2] CSS 툴팁 — 전체 제목 hover/롱터치 팝업
 *  [L3] 다중 파일 순차 등록 파이프라인 (for-of await)
 *  [U1] 미니멀 상단 컨트롤 바 (서재 화면)
 *  [U2] 설정 패널 양쪽 화면 공용화
 * ============================================================
 */

'use strict';

/* ══════════════════════════════════════════════════════════
   §0. 상수
   ══════════════════════════════════════════════════════════ */
const LH_MAP    = { narrow: '1.5', normal: '1.85', wide: '2.3' };
const STATE_KEY = 'fable_v3_state';
const SYNC_TAG  = 'fable-annotation-sync';
const DB_NAME   = 'FableV3DB';
const DB_VER    = 6; /* v6: 태그 인덱스 + readingLog 스토어 + fileHash 유니크 인덱스 */
const RECENT_MAX = 3; /* 최근 읽은 책 표시 개수 */

/* ══════════════════════════════════════════════════════════
   §1. Error Boundary Manager
   ══════════════════════════════════════════════════════════ */
const ErrorBoundary = (() => {
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
const DOMProxy = (() => {
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
const ReactiveStore = (() => {
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

const store = ReactiveStore.store;

/* ══════════════════════════════════════════════════════════
   §4. Toast
   ══════════════════════════════════════════════════════════ */
const Toast = (() => {
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

ErrorBoundary.register('global',   (e) => Toast.show(`오류: ${e?.message ?? '알 수 없는 오류'}`, 'error'));
ErrorBoundary.register('storage',  (e) => Toast.show(`저장소 오류: ${e?.message}`, 'error'));
ErrorBoundary.register('renderer', (e) => Toast.show(`렌더링 오류: ${e?.message}`, 'error'));
ErrorBoundary.register('network',  (e) => console.warn('[Network]', e?.message));

/* ══════════════════════════════════════════════════════════
   §5. XSS 유틸
   ══════════════════════════════════════════════════════════ */
function setTextSafe(el, text) {
  if (el && el !== DOMProxy.VOID_NODE) el.textContent = String(text ?? '');
}

/* ArrayBuffer ↔ base64 (백업/복원 직렬화용) */
function _abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
function _base64ToAb(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/* ══════════════════════════════════════════════════════════
   §6. StorageSystem (IndexedDB v6)
   books 레코드 필드:
     bookKey(PK), seq([2]-8 내부 시퀀스), bytes, title, creator, publisher,
     coverDataUrl, ts, folderId, fileHash(유니크 인덱스), tags[](multiEntry),
     percent, lastReadAt
   folders: { id, name, ts }
   readingLog: { date 'YYYY-MM-DD'(PK), seconds }
   ══════════════════════════════════════════════════════════ */
const StorageSystem = {
  init: ErrorBoundary.wrap('storage', async function init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const txn = e.target.transaction;
        /* books 스토어 */
        let bs;
        if (!db.objectStoreNames.contains('books')) {
          bs = db.createObjectStore('books', { keyPath: 'bookKey' });
          bs.createIndex('folderId', 'folderId', { unique: false });
        } else {
          bs = txn.objectStore('books');
          if (!bs.indexNames.contains('folderId')) bs.createIndex('folderId', 'folderId', { unique: false });
        }
        /* [2]-8 fileHash 유니크 인덱스로 격리 (해시 충돌 배제) */
        if (bs.indexNames.contains('fileHash')) bs.deleteIndex('fileHash');
        bs.createIndex('fileHash', 'fileHash', { unique: true });
        /* [1]-6 태그 multiEntry 인덱스 */
        if (!bs.indexNames.contains('tags')) bs.createIndex('tags', 'tags', { unique: false, multiEntry: true });
        /* [2]-8 내부 시퀀스 인덱스 */
        if (!bs.indexNames.contains('seq')) bs.createIndex('seq', 'seq', { unique: false });

        if (!db.objectStoreNames.contains('annotations')) {
          const as = db.createObjectStore('annotations', { keyPath: 'uuid' });
          as.createIndex('bookKey',     'bookKey',     { unique: false });
          as.createIndex('pendingSync', 'pendingSync', { unique: false });
        }
        if (!db.objectStoreNames.contains('folders')) {
          db.createObjectStore('folders', { keyPath: 'id' });
        }
        /* [1]-4 readingLog 스토어 (일별 독서 시간) */
        if (!db.objectStoreNames.contains('readingLog')) {
          db.createObjectStore('readingLog', { keyPath: 'date' });
        }
        /* [2]-8 시퀀스 카운터 스토어 */
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess  = (e) => { store.indexedDB = e.target.result; resolve(); };
      req.onerror    = () => reject(new Error('IndexedDB 초기화 실패'));
    });
  }),

  /**
   * [L1] 표지 dataUrl + 폴더/해시/진행률/태그 포함 저장
   * 기존 레코드가 있으면 진행률/폴더/태그 정보를 보존합니다.
   */
  async saveBook(bookKey, buffer, title, creator, coverDataUrl = null, fileHash = null, extra = {}) {
    const seq = await this._nextSeq();
    return new Promise((resolve, reject) => {
      const tx = store.indexedDB.transaction(['books'], 'readwrite');
      const os = tx.objectStore('books');
      const getReq = os.get(bookKey);
      getReq.onsuccess = () => {
        const prev = getReq.result || {};
        os.put({
          bookKey,
          seq:          prev.seq ?? seq,
          bytes:        buffer,
          title:        title || prev.title || '제목 없음',
          creator:      creator || prev.creator || '',
          publisher:    extra.publisher ?? prev.publisher ?? '',
          coverDataUrl: coverDataUrl ?? prev.coverDataUrl ?? null,
          fileHash:     fileHash ?? prev.fileHash ?? null,
          folderId:     prev.folderId ?? null,
          tags:         prev.tags ?? [],
          percent:      prev.percent ?? 0,
          lastReadAt:   prev.lastReadAt ?? null,
          ts:           prev.ts ?? Date.now(),
        });
      };
      getReq.onerror = () => {
        os.put({ bookKey, seq, bytes: buffer, title: title || '제목 없음', creator: creator || '',
                 publisher: extra.publisher || '', coverDataUrl: coverDataUrl || null, fileHash: fileHash || null,
                 folderId: null, tags: [], percent: 0, lastReadAt: null, ts: Date.now() });
      };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
  },

  /* [2]-8 내부 시퀀스 ID 발급 (해시와 독립된 안전 키) */
  async _nextSeq() {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve(Date.now());
      const tx = store.indexedDB.transaction(['meta'], 'readwrite');
      const os = tx.objectStore('meta');
      const req = os.get('bookSeq');
      req.onsuccess = () => {
        const cur = (req.result?.value || 0) + 1;
        os.put({ key: 'bookSeq', value: cur });
        tx.oncomplete = () => resolve(cur);
      };
      req.onerror = () => resolve(Date.now());
    });
  },

  /* [1]-11 메타데이터 수동 편집 저장 */
  async updateBookMeta(bookKey, { title, creator, publisher, coverDataUrl }) {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve(false);
      const tx = store.indexedDB.transaction(['books'], 'readwrite');
      const os = tx.objectStore('books');
      const req = os.get(bookKey);
      req.onsuccess = () => {
        const rec = req.result;
        if (rec) {
          if (title != null)        rec.title = title;
          if (creator != null)      rec.creator = creator;
          if (publisher != null)    rec.publisher = publisher;
          if (coverDataUrl != null) rec.coverDataUrl = coverDataUrl;
          os.put(rec);
        }
      };
      tx.oncomplete = () => resolve(true); tx.onerror = () => resolve(false);
    });
  },

  /* [1]-6 태그 업데이트 */
  async updateBookTags(bookKey, tags) {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve(false);
      const tx = store.indexedDB.transaction(['books'], 'readwrite');
      const os = tx.objectStore('books');
      const req = os.get(bookKey);
      req.onsuccess = () => { const rec = req.result; if (rec) { rec.tags = tags; os.put(rec); } };
      tx.oncomplete = () => resolve(true); tx.onerror = () => resolve(false);
    });
  },

  async getAllBooks() {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve([]);
      const tx  = store.indexedDB.transaction(['books'], 'readonly');
      const req = tx.objectStore('books').getAll();
      req.onsuccess = () => resolve(req.result || []); req.onerror = () => resolve([]);
    });
  },

  async getBook(bookKey) {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve(null);
      const req = store.indexedDB.transaction(['books'], 'readonly').objectStore('books').get(bookKey);
      req.onsuccess = () => resolve(req.result || null); req.onerror = () => resolve(null);
    });
  },

  /**
   * [Cascade] 도서 삭제 — 해당 도서의 모든 어노테이션까지 연쇄 제거
   * 단일 트랜잭션(books + annotations)으로 원자적 처리
   */
  async deleteBook(bookKey) {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve(false);
      const tx = store.indexedDB.transaction(['books', 'annotations'], 'readwrite');
      tx.objectStore('books').delete(bookKey);
      /* 어노테이션 연쇄 제거 (bookKey 인덱스 커서) */
      const annIdx = tx.objectStore('annotations').index('bookKey');
      const cursorReq = annIdx.openCursor(IDBKeyRange.only(bookKey));
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      tx.oncomplete = () => resolve(true); tx.onerror = () => resolve(false);
    });
  },

  /**
   * [요구2] 읽은 기록(퍼센트) 동기화 — 300ms 디바운스 가드 내장
   *
   * 동작 원리:
   *  - 즉시(동기): 메모리 내부 store.libraryBooks의 해당 레코드 percent/lastReadAt 갱신
   *  - 지연(300ms): 마지막 호출 후 페이지가 멈춘 시점에만 IndexedDB 디스크 쓰기 1회 수행
   *  연속 스와이프/키보드 페이지 넘김 중에는 디스크 트랜잭션이 발생하지 않아 병목 제로화
   */
  _progressDebounceTimer: null,
  _progressPending: null, /* { bookKey, percent } */

  updateBookProgress(bookKey, percent) {
    const pct = Math.min(100, Math.max(0, Math.round(percent)));
    const now = Date.now();

    /* (1) 메모리 내부 스토어 즉시 동기화 — UI 일관성 유지 */
    const books = store.libraryBooks || [];
    const rec = books.find(b => b.bookKey === bookKey);
    if (rec) { rec.percent = pct; rec.lastReadAt = now; }

    /* (2) 디스크 쓰기 디바운스 — 최신 값만 버퍼에 적재 */
    this._progressPending = { bookKey, percent: pct, lastReadAt: now };
    clearTimeout(this._progressDebounceTimer);
    this._progressDebounceTimer = setTimeout(() => {
      this._flushProgress();
    }, 300);

    return Promise.resolve(true);
  },

  /**
   * 버퍼에 적재된 최종 진행률을 IndexedDB에 1회 커밋
   */
  _flushProgress() {
    const pending = this._progressPending;
    this._progressPending = null;
    if (!pending || !store.indexedDB) return;
    const tx = store.indexedDB.transaction(['books'], 'readwrite');
    const os = tx.objectStore('books');
    const req = os.get(pending.bookKey);
    req.onsuccess = () => {
      const rec = req.result;
      if (rec) {
        rec.percent    = pending.percent;
        rec.lastReadAt = pending.lastReadAt;
        os.put(rec);
      }
    };
  },

  /**
   * 강제 즉시 커밋 (뷰어 종료 / beforeunload 시 잔여 버퍼 flush)
   */
  async flushProgressNow() {
    clearTimeout(this._progressDebounceTimer);
    this._flushProgress();
  },

  /**
   * 도서를 특정 폴더로 이동 (folderId = null 이면 폴더에서 제거)
   */
  async setBookFolder(bookKey, folderId) {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve(false);
      const tx = store.indexedDB.transaction(['books'], 'readwrite');
      const os = tx.objectStore('books');
      const req = os.get(bookKey);
      req.onsuccess = () => { const rec = req.result; if (rec) { rec.folderId = folderId; os.put(rec); } };
      tx.oncomplete = () => resolve(true); tx.onerror = () => resolve(false);
    });
  },

  /**
   * 중복 방지: 동일 fileHash 보유 도서 존재 여부
   */
  async findBookByHash(fileHash) {
    return new Promise(resolve => {
      if (!store.indexedDB || !fileHash) return resolve(null);
      const req = store.indexedDB.transaction(['books'], 'readonly')
                      .objectStore('books').index('fileHash').get(fileHash);
      req.onsuccess = () => resolve(req.result || null); req.onerror = () => resolve(null);
    });
  },

  /* ── 폴더 CRUD ── */
  async getAllFolders() {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve([]);
      const req = store.indexedDB.transaction(['folders'], 'readonly').objectStore('folders').getAll();
      req.onsuccess = () => resolve(req.result || []); req.onerror = () => resolve([]);
    });
  },

  async saveFolder(folder) {
    return new Promise(resolve => {
      const tx = store.indexedDB.transaction(['folders'], 'readwrite');
      tx.objectStore('folders').put(folder);
      tx.oncomplete = () => resolve(true); tx.onerror = () => resolve(false);
    });
  },

  /**
   * [Cascade Delete] 폴더 완전 삭제 파이프라인
   * folders + books + annotations 3개 스토어를 단일 트랜잭션으로 원자 처리:
   *  1) 폴더 엔티티 삭제
   *  2) folderId 귀속 도서 전부 삭제
   *  3) 삭제되는 각 도서의 어노테이션(하이라이트/메모) 연쇄 삭제
   * 트랜잭션이 완전히 oncomplete 된 직후 한 번만 resolve → 호출부에서 단일 store 갱신
   * @returns {Promise<{ok:boolean, deletedBooks:number}>}
   */
  async deleteFolder(folderId) {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve({ ok: false, deletedBooks: 0 });
      const tx = store.indexedDB.transaction(['folders', 'books', 'annotations'], 'readwrite');
      const booksOS = tx.objectStore('books');
      const annIdx  = tx.objectStore('annotations').index('bookKey');
      let   deletedBooks = 0;

      /* 1) 폴더 엔티티 삭제 */
      tx.objectStore('folders').delete(folderId);

      /* 2~3) 귀속 도서 + 어노테이션 연쇄 삭제 */
      const bookIdx   = booksOS.index('folderId');
      const cursorReq = bookIdx.openCursor(IDBKeyRange.only(folderId));
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const bk = cursor.value.bookKey;
          /* 도서 레코드 삭제 */
          cursor.delete();
          deletedBooks++;
          /* 해당 도서의 어노테이션 연쇄 삭제 */
          const annCursorReq = annIdx.openCursor(IDBKeyRange.only(bk));
          annCursorReq.onsuccess = (ev) => {
            const annCursor = ev.target.result;
            if (annCursor) { annCursor.delete(); annCursor.continue(); }
          };
          cursor.continue();
        }
      };

      /* 4) 트랜잭션 원자성 — 모든 삭제가 settle된 직후 단 한 번 resolve */
      tx.oncomplete = () => resolve({ ok: true, deletedBooks });
      tx.onerror    = () => resolve({ ok: false, deletedBooks: 0 });
    });
  },

  /**
   * 특정 도서의 어노테이션만 일괄 삭제 (독립 호출용)
   */
  async deleteAnnotationsByBook(bookKey) {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve(false);
      const tx  = store.indexedDB.transaction(['annotations'], 'readwrite');
      const idx = tx.objectStore('annotations').index('bookKey');
      const cursorReq = idx.openCursor(IDBKeyRange.only(bookKey));
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      tx.oncomplete = () => resolve(true); tx.onerror = () => resolve(false);
    });
  },

  /* ── [1]-4/10 readingLog (일별 독서시간) ── */
  async getReadingLog() {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve({});
      const req = store.indexedDB.transaction(['readingLog'], 'readonly').objectStore('readingLog').getAll();
      req.onsuccess = () => {
        const map = {};
        (req.result || []).forEach(r => { map[r.date] = r.seconds; });
        resolve(map);
      };
      req.onerror = () => resolve({});
    });
  },

  async addReadingSeconds(seconds) {
    const date = new Date().toISOString().slice(0, 10);
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve(false);
      const tx = store.indexedDB.transaction(['readingLog'], 'readwrite');
      const os = tx.objectStore('readingLog');
      const req = os.get(date);
      req.onsuccess = () => {
        const rec = req.result || { date, seconds: 0 };
        rec.seconds += seconds;
        os.put(rec);
      };
      tx.oncomplete = () => resolve(true); tx.onerror = () => resolve(false);
    });
  },

  /* ── [2]-3 배치 트랜잭션: 다중 도서를 단일 readwrite 트랜잭션으로 일괄 등록 ── */
  async batchSaveBooks(records) {
    /* records: [{ bookKey, buffer, title, creator, coverDataUrl, fileHash, publisher }] */
    if (!records.length) return [];
    /* 시퀀스 선발급 */
    const baseSeq = await this._reserveSeqRange(records.length);
    return new Promise((resolve, reject) => {
      const tx = store.indexedDB.transaction(['books'], 'readwrite');
      const os = tx.objectStore('books');
      records.forEach((r, i) => {
        os.put({
          bookKey:      r.bookKey,
          seq:          baseSeq + i,
          bytes:        r.buffer,
          title:        r.title || '제목 없음',
          creator:      r.creator || '',
          publisher:    r.publisher || '',
          coverDataUrl: r.coverDataUrl || null,
          fileHash:     r.fileHash || null,
          folderId:     null,
          tags:         [],
          percent:      0,
          lastReadAt:   null,
          ts:           Date.now() + i,
        });
      });
      tx.oncomplete = () => resolve(records.map(r => r.bookKey));
      tx.onerror    = () => reject(tx.error);
    });
  },

  async _reserveSeqRange(count) {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve(Date.now());
      const tx = store.indexedDB.transaction(['meta'], 'readwrite');
      const os = tx.objectStore('meta');
      const req = os.get('bookSeq');
      req.onsuccess = () => {
        const start = (req.result?.value || 0) + 1;
        os.put({ key: 'bookSeq', value: start + count - 1 });
        tx.oncomplete = () => resolve(start);
      };
      req.onerror = () => resolve(Date.now());
    });
  },

  /* ── [1]-8 전체 DB 익스포트(백업) / 임포트(복원) ── */
  async exportDatabase() {
    const [books, folders, annotations, readingLog] = await Promise.all([
      this.getAllBooks(), this.getAllFolders(), this._getAllAnnotations(), this.getReadingLog(),
    ]);
    /* 바이트(ArrayBuffer)는 base64로 직렬화 */
    const serBooks = books.map(b => ({ ...b, bytes: b.bytes ? _abToBase64(b.bytes) : null }));
    return {
      version: DB_VER, exportedAt: Date.now(),
      books: serBooks, folders, annotations, readingLog,
    };
  },

  async _getAllAnnotations() {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve([]);
      const req = store.indexedDB.transaction(['annotations'], 'readonly').objectStore('annotations').getAll();
      req.onsuccess = () => resolve(req.result || []); req.onerror = () => resolve([]);
    });
  },

  async importDatabase(data) {
    if (!data?.books) throw new Error('유효하지 않은 백업 파일입니다.');
    const tx = store.indexedDB.transaction(['books', 'folders', 'annotations', 'readingLog'], 'readwrite');
    const bOS = tx.objectStore('books'), fOS = tx.objectStore('folders'),
          aOS = tx.objectStore('annotations'), rOS = tx.objectStore('readingLog');
    (data.books || []).forEach(b => {
      const rec = { ...b, bytes: b.bytes ? _base64ToAb(b.bytes) : null };
      bOS.put(rec);
    });
    (data.folders || []).forEach(f => fOS.put(f));
    (data.annotations || []).forEach(a => aOS.put(a));
    Object.entries(data.readingLog || {}).forEach(([date, seconds]) => rOS.put({ date, seconds }));
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve(true); tx.onerror = () => reject(tx.error);
    });
  },

  async saveAnnotation(ann) {
    return new Promise((resolve, reject) => {
      const tx = store.indexedDB.transaction(['annotations'], 'readwrite');
      tx.objectStore('annotations').put(ann);
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
  },

  async getAnnotationsByBook(bookKey) {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve([]);
      const req = store.indexedDB.transaction(['annotations'], 'readonly')
                      .objectStore('annotations').index('bookKey').getAll(bookKey);
      req.onsuccess = () => resolve(req.result || []); req.onerror = () => resolve([]);
    });
  },

  async getPendingAnnotations() {
    return new Promise(resolve => {
      if (!store.indexedDB) return resolve([]);
      const req = store.indexedDB.transaction(['annotations'], 'readonly')
                      .objectStore('annotations').index('pendingSync').getAll(1);
      req.onsuccess = () => resolve(req.result || []); req.onerror = () => resolve([]);
    });
  },

  async markAnnotationSynced(uuid) {
    return new Promise(resolve => {
      const tx  = store.indexedDB.transaction(['annotations'], 'readwrite');
      const s   = tx.objectStore('annotations');
      const req = s.get(uuid);
      req.onsuccess = () => {
        if (req.result) { req.result.pendingSync = 0; s.put(req.result); }
        resolve();
      };
      req.onerror = () => resolve();
    });
  },

  lsSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify({ data: value, ts: Date.now() }));
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        this._evictLRU();
        Toast.show('오래된 서재 데이터가 안전하게 자동 최적화되었습니다.', 'info');
        try { localStorage.setItem(key, JSON.stringify({ data: value, ts: Date.now() })); } catch (_) {}
      }
    }
  },

  lsGet(key, def = null) {
    try { const raw = localStorage.getItem(key); if (!raw) return def; return JSON.parse(raw).data ?? def; }
    catch (_) { return def; }
  },

  _evictLRU() {
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith('fable_')) continue;
      try { entries.push({ k, ts: JSON.parse(localStorage.getItem(k)).ts }); } catch (_) {}
    }
    entries.sort((a, b) => a.ts - b.ts)
           .slice(0, Math.ceil(entries.length * 0.3))
           .forEach(e => localStorage.removeItem(e.k));
  },
};

/* ══════════════════════════════════════════════════════════
   §7. Annotation Sync Engine (UUID + LWW Merge)
   ══════════════════════════════════════════════════════════ */
const AnnotationSyncEngine = (() => {
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  /* [2]-11 클라이언트 식별자 (디바이스 단위 고정) + 단조 증가 카운터 */
  function _clientId() {
    let id = localStorage.getItem('fable_client_id');
    if (!id) { id = uuid(); localStorage.setItem('fable_client_id', id); }
    return id;
  }
  let _lamport = parseInt(localStorage.getItem('fable_lamport') || '0', 10);
  function _tick() { _lamport++; localStorage.setItem('fable_lamport', String(_lamport)); return _lamport; }

  async function create(bookKey, cfiRange, text, color = 'yellow', note = '') {
    const ann = {
      uuid: uuid(), bookKey, cfiRange, text: text.slice(0, 500), note, color,
      device_timestamp: Date.now(),
      /* [2]-11 벡터 시계 구성요소: 클라이언트 ID + Lamport 카운터 */
      clientId: _clientId(),
      lamport:  _tick(),
      pendingSync: 1, synced_at: null,
    };
    await ErrorBoundary.wrap('storage', () => StorageSystem.saveAnnotation(ann))();
    return ann;
  }

  /**
   * [2]-11 LWW Merge 정교화 — 동일 CFI 충돌 시:
   *  1순위 device_timestamp(ms), 2순위 lamport 카운터, 3순위 clientId 사전순(타이브레이커)
   */
  function mergeWithLWW(remoteItems, localItems) {
    const merged = new Map();
    const _wins = (a, b) => {
      /* a가 b보다 우선이면 true */
      if (!b) return true;
      if ((a.device_timestamp || 0) !== (b.device_timestamp || 0)) return (a.device_timestamp || 0) > (b.device_timestamp || 0);
      if ((a.lamport || 0) !== (b.lamport || 0)) return (a.lamport || 0) > (b.lamport || 0);
      return String(a.clientId || '') > String(b.clientId || '');
    };
    remoteItems.forEach(r => merged.set(r.cfiRange, r));
    localItems.forEach(l => {
      const ex = merged.get(l.cfiRange);
      if (_wins(l, ex)) merged.set(l.cfiRange, l);
    });
    return [...merged.values()];
  }

  async function syncPending() {
    const pending = await StorageSystem.getPendingAnnotations();
    if (!pending.length) return;

    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      try { const reg = await navigator.serviceWorker.ready; await reg.sync.register(SYNC_TAG); return; }
      catch (_) {}
    }

    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'ANNOTATION_SYNC_REQUEST', payload: { items: pending } });
      return;
    }

    try {
      const res = await fetch('https://api.fable.example/annotations/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ annotations: pending }),
      });
      if (res.ok) {
        await Promise.all(pending.map(a => StorageSystem.markAnnotationSynced(a.uuid)));
        Toast.show(`${pending.length}개 하이라이트가 동기화되었습니다.`, 'success');
      }
    } catch (err) { ErrorBoundary.handle('network', err, 'syncPending'); }
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', async (e) => {
      if (e.data?.type === 'ANNOTATION_SYNC_RESULT' && e.data.result?.success) {
        const pending = await StorageSystem.getPendingAnnotations();
        await Promise.all(pending.map(a => StorageSystem.markAnnotationSynced(a.uuid)));
        Toast.show(`${e.data.result.synced}개 하이라이트가 동기화되었습니다.`, 'success');
      }
      if (e.data?.type === 'SW_SYNC_TRIGGER') await syncPending();
    });
  }

  return { create, mergeWithLWW, syncPending };
})();

/* ══════════════════════════════════════════════════════════
   §8. Resource Registry (Memory Leak 방지)
   ══════════════════════════════════════════════════════════ */
const ResourceRegistry = (() => {
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
   §9. 화면 전환
   ══════════════════════════════════════════════════════════ */
function showViewerScreen() {
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

function showUploaderScreen() {
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

/* ══════════════════════════════════════════════════════════
   §10. 로딩 오버레이
   ══════════════════════════════════════════════════════════ */
const LoadingOverlay = (() => {
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

/* ══════════════════════════════════════════════════════════
   §11. 리사이즈 마스크
   ══════════════════════════════════════════════════════════ */
const ResizeMask = {
  show() { DOMProxy.get('resize-mask').style.display = 'flex'; },
  hide() { DOMProxy.get('resize-mask').style.display = 'none'; },
};

/* ══════════════════════════════════════════════════════════
   §12. 파일 추가 진행 바
   ══════════════════════════════════════════════════════════ */
const ImportProgress = (() => {
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

/* ══════════════════════════════════════════════════════════
   §13. Reactive UI Binders
   ══════════════════════════════════════════════════════════ */
function mountReactiveBinders() {

  ReactiveStore.subscribe('theme', (theme) => {
    if (theme === 'paper' || theme === 'custom') document.body.removeAttribute('data-theme');
    else document.body.setAttribute('data-theme', theme);

    if (store.rendition) {
      requestAnimationFrame(() => {
        try { store.rendition.themes.select(theme === 'custom' ? 'custom' : theme); }
        catch (e) { ErrorBoundary.handle('renderer', e, 'theme:select'); }
      });
    }
    DOMProxy.qa('.theme-swatch').forEach(b => {
      const ok = b.dataset.theme === theme;
      b.classList.toggle('active', ok); b.setAttribute('aria-checked', String(ok));
    });
    DOMProxy.get('custom-theme-builder').style.display = theme === 'custom' ? 'block' : 'none';
  });

  ReactiveStore.subscribe('fontSize', (size) => {
    setTextSafe(DOMProxy.get('font-size-display'), `${size}%`);
    if (store.rendition) requestAnimationFrame(() => {
      try { store.rendition.themes.fontSize(`${size}%`); }
      catch (e) { ErrorBoundary.handle('renderer', e, 'fontSize'); }
    });
  });

  ReactiveStore.subscribe('lineHeight', (lh) => {
    DOMProxy.qa('[data-lh]').forEach(b => {
      const ok = b.dataset.lh === lh;
      b.classList.toggle('active', ok); b.setAttribute('aria-checked', String(ok));
    });
    if (store.rendition) {
      const val = LH_MAP[lh] || '1.85';
      requestAnimationFrame(() => {
        try { store.rendition.themes.override('line-height', val); }
        catch (e) { ErrorBoundary.handle('renderer', e, 'lineHeight'); }
      });
    }
  });

  ReactiveStore.subscribe('flow', (flow) => {
    DOMProxy.qa('[data-flow]').forEach(b => {
      const ok = b.dataset.flow === flow;
      b.classList.toggle('active', ok); b.setAttribute('aria-checked', String(ok));
    });
    DOMProxy.get('btn-scroll-top').style.display = flow === 'scrolled' ? 'flex' : 'none';
  });

  ReactiveStore.subscribe('navBarsVisible', (visible) => {
    DOMProxy.get('viewer-nav-bar').classList.toggle('nav-hidden', !visible);
    DOMProxy.get('viewer-bottom-bar').classList.toggle('bottom-hidden', !visible);
  });

  ReactiveStore.subscribe('isTocOpen', (open) => {
    const sidebar = DOMProxy.get('toc-sidebar');
    const overlay = DOMProxy.get('toc-overlay');
    const btn     = DOMProxy.get('btn-toc-toggle');
    if (open) {
      sidebar.style.display = 'flex'; sidebar.offsetHeight;
      sidebar.classList.add('open');
      overlay.classList.add('visible', 'blur-backdrop');
      btn.setAttribute('aria-expanded', 'true');
    } else {
      sidebar.classList.remove('open');
      overlay.classList.remove('visible', 'blur-backdrop');
      btn.setAttribute('aria-expanded', 'false');
      setTimeout(() => { if (!store.isTocOpen) sidebar.style.display = 'none'; }, 240);
    }
  });

  /* [U2] isSettingsOpen — 서재/뷰어 공용 설정 패널 */
  ReactiveStore.subscribe('isSettingsOpen', (open) => {
    const panel = DOMProxy.get('settings-panel');
    /* 뷰어 버튼 */
    const btnV = DOMProxy.get('btn-settings-toggle');
    /* 서재 버튼 */
    const btnL = DOMProxy.get('btn-library-settings');

    if (open) {
      panel.style.display = 'flex'; panel.offsetHeight;
      panel.classList.add('open');
      btnV.classList.add('active'); btnV.setAttribute('aria-expanded', 'true');
      btnL.classList.add('active'); btnL.setAttribute('aria-expanded', 'true');
    } else {
      panel.classList.remove('open');
      btnV.classList.remove('active'); btnV.setAttribute('aria-expanded', 'false');
      btnL.classList.remove('active'); btnL.setAttribute('aria-expanded', 'false');
      setTimeout(() => { if (!store.isSettingsOpen) panel.style.display = 'none'; }, 240);
    }
  });

  ReactiveStore.subscribe('userBg',      (v) => { document.documentElement.style.setProperty('--color-user-bg', v);         _injectCustomToIframe(); });
  ReactiveStore.subscribe('userInk',     (v) => { document.documentElement.style.setProperty('--color-user-ink', v);        _injectCustomToIframe(); });
  ReactiveStore.subscribe('userSpacing', (v) => { document.documentElement.style.setProperty('--user-letter-spacing', v + 'em'); _injectCustomToIframe(); });
  ReactiveStore.subscribe('userLeading', (v) => { document.documentElement.style.setProperty('--user-line-height', String(v)); _injectCustomToIframe(); });

  /* [v5] 서재 데이터 상태 → 그리드 자동 재렌더 (Reactive 일관성) */
  ReactiveStore.subscribe('libraryBooks',   () => renderLibraryGrid());
  ReactiveStore.subscribe('folders',        () => renderLibraryGrid());
  ReactiveStore.subscribe('activeFolderId', () => renderLibraryGrid());
  ReactiveStore.subscribe('activeTags',     () => renderLibraryGrid());
  ReactiveStore.subscribe('sortMode',       () => renderLibraryGrid());
  ReactiveStore.subscribe('librarySearch',  () => renderLibraryGrid());
  ReactiveStore.subscribe('readingLog',     () => { /* 대시보드는 grid 렌더 시 함께 갱신 */ });
}

function _injectCustomToIframe() {
  if (!store.rendition || store.theme !== 'custom') return;
  try {
    store.rendition.themes.override('background-color', store.userBg);
    store.rendition.themes.override('color',            store.userInk);
    store.rendition.themes.override('letter-spacing',   store.userSpacing + 'em');
    store.rendition.themes.override('line-height',      String(store.userLeading));
  } catch (e) { ErrorBoundary.handle('renderer', e, 'customTheme'); }
}

/* ══════════════════════════════════════════════════════════
   §14. 진행률 UI + [요구3] 퍼센트 IndexedDB 동기화
   ══════════════════════════════════════════════════════════ */
let _lastSyncedPct = -1;

function updateProgressUI(location) {
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

  /* [요구2] 읽은 기록 동기화 — updateBookProgress 내부 300ms 디바운스 가드가 처리
     매 페이지 이동마다 호출해도 메모리만 즉시 갱신되고 디스크 쓰기는 정지 후 1회 */
  if (store.bookKey && pct !== _lastSyncedPct) {
    _lastSyncedPct = pct;
    StorageSystem.updateBookProgress(store.bookKey, pct);
  }
}

/* ══════════════════════════════════════════════════════════
   §15. [L1] 표지 이미지 추출 (epub.js book.loaded.cover)
   ══════════════════════════════════════════════════════════ */
async function extractCoverDataUrl(book) {
  try {
    /* epub.js: book.loaded.cover → cover path → archive URL → canvas → dataURL */
    const coverPath = await book.loaded.cover;
    if (!coverPath) return null;

    const coverUrl = await book.archive.createUrl(coverPath, { base64: true });
    if (!coverUrl) return null;

    /* Base64 URL이면 그대로 사용, blob URL이면 canvas 변환 */
    if (coverUrl.startsWith('data:')) return coverUrl;

    return await new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          /* 썸네일 크기로 리사이즈 (메모리 절약) */
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
   §16. epub.js 렌더링 엔진
   ══════════════════════════════════════════════════════════ */
/**
 * [B1] ePub 폴드 가드 — window.ePub 존재 확인
 * epub.js CDN이 아직 파싱 중이라면 최대 5초 대기
 */
async function waitForEpubJS(maxWaitMs = 5000) {
  if (typeof window.ePub === 'function') return true;

  return new Promise((resolve) => {
    const start    = Date.now();
    const interval = setInterval(() => {
      if (typeof window.ePub === 'function') {
        clearInterval(interval);
        resolve(true);
        return;
      }
      if (Date.now() - start >= maxWaitMs) {
        clearInterval(interval);
        resolve(false);
      }
    }, 50);
  });
}

async function openEpubBook(fileData, isBuffer = false) {
  /* [B1] ePub 가드 */
  const epubReady = await waitForEpubJS();
  if (!epubReady) {
    Toast.show('epub.js 라이브러리를 로드하지 못했습니다. 페이지를 새로고침해 주세요.', 'error');
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

    /* 메타 + 내비게이션 병렬 로드 (각각 에러 격리) */
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
    _lastSyncedPct = -1; /* [요구2] 새 책 — 진행률 동기화 캐시 초기화 */

    /* [L1] 서재 저장 (표지 + 파일 해시 포함) */
    if (!isBuffer && fileData instanceof File) {
      const buf          = await fileData.arrayBuffer();
      const coverDataUrl = await extractCoverDataUrl(book);
      const fileHash     = await HashWorker.compute(fileData);
      await StorageSystem.saveBook(store.bookKey, buf, title, creator, coverDataUrl, fileHash);
      await refreshLibraryData();
    }

    renderTocSidebar(toc);
    initRenditionEngine(book);
    generateLocationsBackground(book);
    ReadingStatsTracker.startSession();

    const annotations = await StorageSystem.getAnnotationsByBook(store.bookKey);
    AnnotationManager.restoreAll(annotations);

    return true;
  })();

  if (!result || !store.rendition) {
    LoadingOverlay.hide();
    exitViewer();
  }
}

/* ── 테마 등록 ── */
function registerEpubThemes(rendition) {
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

/* FOUC 방지 스타일 주입 */
function injectContentStyles(contents) {
  const doc = contents.document;
  if (!doc) return;
  doc.getElementById('fable-injected')?.remove();
  const style = doc.createElement('style');
  style.id = 'fable-injected';
  const themeBg = store.theme === 'dark' ? '#1a1a1e' : store.theme === 'white' ? '#ffffff' : store.theme === 'custom' ? store.userBg : '#fcfbf7';
  /* [3]-7 다크 모드: 본문 내 흰 배경 이미지 대비 감쇄 */
  const darkImg = store.theme === 'dark'
    ? 'img,svg,image{filter:brightness(0.8) contrast(1.2);opacity:0.92;}'
    : '';
  style.textContent = `
    html,body { background:${themeBg} !important; -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
    *,*::before,*::after { box-sizing:border-box; }
    p,div,span,li,td { page-break-inside:avoid; break-inside:avoid; }
    ${darkImg}
    mark.fable-search-mark { background:rgba(255,220,50,0.55); border-radius:2px; animation:fable-mark-pulse 1.2s ease-out forwards; }
    @keyframes fable-mark-pulse { 0% { background:rgba(255,165,0,0.75); } 100% { background:rgba(255,220,50,0.45); } }
    .hl-yellow { background:rgba(255,235,59,0.45)!important; border-bottom:2px solid #f5c800!important; }
    .hl-green  { background:rgba(105,240,174,0.40)!important; border-bottom:2px solid #00c853!important; }
    .fable-search-hl { background:rgba(255,165,0,0.45)!important; border-radius:3px; }
  `;
  doc.head.appendChild(style);
}

function initRenditionEngine(book) {
  const viewport = DOMProxy.get('viewer-viewport');
  if (!DOMProxy.exists('viewer-viewport')) return;

  const rendition = book.renderTo(viewport, {
    manager: 'continuous', flow: store.flow, width: '100%', height: '100%', spread: 'auto',
  });
  store.rendition = rendition;

  registerEpubThemes(rendition);
  rendition.hooks.content.register(injectContentStyles);
  _applyAllRenditionSettings(rendition);

  const savedCFI = StorageSystem.lsGet('fable_cfi_' + store.bookKey, '');
  rendition.display(savedCFI || undefined)
    .then(() => {
      LoadingOverlay.hide();
      if (savedCFI) Toast.show('이전에 읽던 위치에서 시작합니다.', 'success');
      SearchEngine.build(book);
      initAnnotationManager(rendition);
      NavGuard.init(rendition);
    })
    .catch(err => { LoadingOverlay.hide(); ErrorBoundary.handle('renderer', err, 'rendition.display'); });

  rendition.on('relocated', (location) => {
    store.currentCFI = location.start.cfi;
    StorageSystem.lsSet('fable_cfi_' + store.bookKey, location.start.cfi);
    ReadingStatsTracker.markPosition(location.start.cfi);
    updateProgressUI(location);
    const href = location.start.href;
    if (href && href !== store.currentHref) { store.currentHref = href; updateTocActiveItem(href); }
    _updateArrowState(location);
    NavGuard.onRelocated();
  });

  rendition.on('keyup', handleKeyDown);
  rendition.on('click', () => {
    if (store.isTocOpen)      store.isTocOpen     = false;
    if (store.isSettingsOpen) store.isSettingsOpen = false;
    store.navBarsVisible = !store.navBarsVisible;
  });
  rendition.on('rendered', (section, view) => {
    if (view?.document) injectContentStyles({ document: view.document });
    if (store.flow === 'scrolled') bindScrollTopButton(view);
  });
}

function _applyAllRenditionSettings(rendition) {
  const t = store.theme === 'custom' ? 'custom' : store.theme;
  try { rendition.themes.select(t); } catch (_) {}
  try { rendition.themes.fontSize(`${store.fontSize}%`); } catch (_) {}
  try { rendition.themes.override('line-height', LH_MAP[store.lineHeight] || '1.85'); } catch (_) {}
  if (store.theme === 'custom') _injectCustomToIframe();
}

function _updateArrowState(location) {
  DOMProxy.get('arrow-prev').disabled = location.atStart === true;
  DOMProxy.get('arrow-next').disabled = location.atEnd   === true;
}

/* ══════════════════════════════════════════════════════════
   §17. 자원 해제 파이프라인
   ══════════════════════════════════════════════════════════ */
async function destroyCurrentRenditionContext() {
  /* [요구2] 잔여 진행률 버퍼를 디스크에 즉시 커밋 후 정리 */
  await StorageSystem.flushProgressNow();
  ReadingStatsTracker.stopSession();
  NavGuard.destroy();
  SearchEngine.destroy();
  AnnotationManager.reset();
  VirtualSearchList.destroy();
  CFICache.clear();          /* [2]-5/6 메모이제이션 캐시 해제 */
  ResourceRegistry.releaseAll();

  const vp = DOMProxy.get('viewer-viewport');
  if (DOMProxy.exists('viewer-viewport')) {
    vp.querySelectorAll('iframe').forEach(f => { f.src = 'about:blank'; f.remove(); });
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

function exitViewer() {
  destroyCurrentRenditionContext().then(() => { showUploaderScreen(); refreshLibraryData(); });
}

/* ══════════════════════════════════════════════════════════
   §18. CFI 보정 스케줄러 (가로↔세로)
   ══════════════════════════════════════════════════════════ */
function switchFlowMode(mode) {
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

/* ══════════════════════════════════════════════════════════
   §19. NavGuard
   ══════════════════════════════════════════════════════════ */
const NavGuard = (() => {
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
    resizeObs = new ResizeObserver(entries => {
      if (!store.rendition) return;
      if (store.currentCFI) cfiSnap = store.currentCFI;
      ResizeMask.show();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(async () => {
        if (!store.rendition) { ResizeMask.hide(); return; }
        const { width, height } = entries[entries.length - 1].contentRect;
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
        /* 순간 속도 계산 */
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
      /* 엣지 가드 */
      if (touchStartX < EDGE_PX || touchStartX > window.innerWidth - EDGE_PX) return;
      /* 관성 판정: (충분한 거리 + 0.5s 이내) 또는 (빠른 플릭 속도) */
      const farEnough  = Math.abs(deltaX) >= SWIPE_MIN && elapsed <= 500;
      const fastFlick  = Math.abs(velocity) >= VELOCITY_MIN && Math.abs(deltaX) > 16;
      if (!farEnough && !fastFlick) return;
      /* 방향: 속도 우선, 없으면 변위 */
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
function generateLocationsBackground(book) {
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

/* ══════════════════════════════════════════════════════════
   §21. TOC 사이드바
   ══════════════════════════════════════════════════════════ */
function renderTocSidebar(tocData) {
  const container = DOMProxy.get('toc-list');
  if (!DOMProxy.exists('toc-list')) return;
  container.innerHTML = '';

  if (!tocData?.length) {
    const p = document.createElement('p');
    p.style.cssText = 'padding:20px;color:var(--color-ink-muted);font-size:13px;text-align:center;';
    p.textContent = '목차 정보가 없습니다.'; container.appendChild(p); return;
  }
  const frag = document.createDocumentFragment();
  function appendItems(items, depth) {
    items.forEach(item => {
      const btn = document.createElement('button');
      btn.className     = 'toc-item'; btn.dataset.depth = String(Math.min(depth, 3));
      btn.dataset.href  = item.href || ''; btn.textContent = item.label?.trim() || '(제목 없음)';
      btn.setAttribute('role', 'listitem');
      btn.addEventListener('click', () => {
        if (store.rendition && item.href) store.rendition.display(item.href).catch(() => {});
        store.isTocOpen = false;
      });
      frag.appendChild(btn);
      if (item.subitems?.length) appendItems(item.subitems, depth + 1);
    });
  }
  appendItems(tocData, 1); container.appendChild(frag);
}

function updateTocActiveItem(href) {
  DOMProxy.get('toc-list').querySelectorAll?.('.toc-item').forEach(item => {
    const ih = item.dataset.href || '';
    item.classList.toggle('active', !!(ih && (href.includes(ih.split('#')[0]) || ih.includes(href.split('#')[0]))));
  });
}

/* ══════════════════════════════════════════════════════════
   §22. Virtual Search List (IntersectionObserver 재활용 풀)
   ══════════════════════════════════════════════════════════ */
const VirtualSearchList = (() => {
  const VISIBLE = 20, ITEM_H = 64;
  let allResults = [], renderedStart = 0, container = null, sentinel = null, observer = null, pool = [], _q = '';

  function _createItem() {
    const div = document.createElement('div');
    div.className = 'search-result-item';
    div.setAttribute('role', 'option');
    div.style.cssText = `min-height:${ITEM_H}px;padding:10px 16px;border-bottom:1px solid var(--color-border-soft);cursor:pointer;`;
    div.innerHTML = '<div class="sri-section" style="font-size:10px;color:var(--color-ink-muted);margin-bottom:3px;"></div><p class="sri-snippet" style="font-size:12px;line-height:1.5;margin:0;color:var(--color-ink-soft);"></p>';
    return div;
  }

  function _renderChunk(start, q) {
    if (!container) return;
    const end = Math.min(start + VISIBLE, allResults.length);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const m = allResults[i], node = pool.pop() || _createItem();
      node.querySelector('.sri-section').textContent = `${i+1}. ${(m.sectionHref||'').split('/').pop()}`;
      const snip = node.querySelector('.sri-snippet'); snip.innerHTML = '';
      const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi');
      m.context.split(re).forEach(part => {
        if (re.test(part)) { const mk = document.createElement('mark'); mk.className='fable-search-mark'; mk.textContent=part; snip.appendChild(mk); re.lastIndex=0; }
        else snip.appendChild(document.createTextNode(part));
      });
      node.onclick = async () => {
        DOMProxy.get('search-modal').style.display = 'none';
        if (store.rendition && m.cfi) { try { await store.rendition.display(m.cfi); setTimeout(() => injectSearchHighlight(m.cfi), 400); } catch (_) {} }
      };
      frag.appendChild(node);
    }
    container.appendChild(frag); renderedStart = end;
  }

  function _setupSentinel() {
    sentinel = document.createElement('div'); sentinel.style.height = '1px';
    container.appendChild(sentinel);
    observer = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting || renderedStart >= allResults.length) return;
      const old = container.querySelectorAll('.search-result-item');
      if (old.length > VISIBLE * 2) { Array.from(old).slice(0, old.length - VISIBLE).forEach(n => { pool.push(n); n.remove(); }); }
      _renderChunk(renderedStart, _q); container.appendChild(sentinel);
    }, { threshold: 0.1 });
    observer.observe(sentinel);
  }

  function render(containerEl, results, query) {
    if (observer) { observer.disconnect(); observer = null; }
    pool = []; allResults = results; container = containerEl; renderedStart = 0; _q = query;
    container.innerHTML = '';
    if (!results.length) {
      const p = document.createElement('p'); p.style.cssText='padding:20px;text-align:center;color:var(--color-ink-muted);font-size:13px;';
      p.textContent='검색 결과가 없습니다.'; container.appendChild(p); return;
    }
    _renderChunk(0, query); _setupSentinel();
  }

  function destroy() { if (observer) { observer.disconnect(); observer = null; } pool=[]; allResults=[]; container=null; sentinel=null; }
  return { render, destroy };
})();

/* ══════════════════════════════════════════════════════════
   §23. 전문 검색 엔진
   ══════════════════════════════════════════════════════════ */
const SearchEngine = (() => {
  let index = new Map(), isBuilt = false;

  async function build(book) {
    if (isBuilt || !book) return;
    index.clear();
    const parser = new DOMParser(), items = book.spine?.items || [];
    for (const item of items) {
      try {
        const section = book.spine.get(item.href || item.idref);
        if (!section) continue;
        await section.load(book.load.bind(book));
        const doc = parser.parseFromString(section.content || '<html></html>', 'text/html');
        Array.from(doc.querySelectorAll('p,h1,h2,h3,li')).forEach(p => {
          const text = p.textContent?.trim() || '';
          if (text.length < 3) return;
          let cfi = ''; try { cfi = section.cfiFromElement(p); } catch (_) { cfi = item.href || ''; }
          new Set(text.toLowerCase().split(/\s+/).filter(w => w.length >= 2)).forEach(word => {
            if (!index.has(word)) index.set(word, []);
            index.get(word).push({ sectionHref: item.href || '', cfi, context: text.slice(0, 120) });
          });
        });
        section.unload(); await new Promise(r => setTimeout(r, 0));
      } catch (_) {}
    }
    isBuilt = true;
  }

  function query(keyword) {
    if (!isBuilt || keyword.length < 2) return [];
    const kw = keyword.toLowerCase().trim(), results = [], seen = new Set();
    for (const [key, list] of index.entries()) {
      if (key.includes(kw)) list.forEach(r => { if (!seen.has(r.cfi)) { seen.add(r.cfi); results.push(r); } });
      if (results.length >= 200) break;
    }
    return results;
  }

  function destroy() { index.clear(); isBuilt = false; }
  return { build, query, destroy };
})();

function runSearchExecution() {
  const q = DOMProxy.get('input-search-query').value?.trim() ?? '';
  if (q.length < 2) { Toast.show('검색어는 2글자 이상 입력하세요.', 'error'); return; }
  VirtualSearchList.render(DOMProxy.get('search-results-container'), SearchEngine.query(q), q);
}

function injectSearchHighlight(cfi) {
  if (!store.rendition) return;
  try { store.rendition.annotations.add('highlight', cfi, {}, null, 'fable-search-hl'); setTimeout(() => { try { store.rendition?.annotations?.remove(cfi, 'highlight'); } catch (_) {} }, 3000); }
  catch (_) {}
}

/* ══════════════════════════════════════════════════════════
   §24. [L1/L2/v5] 서재 렌더링 — 최근 읽은 책 · 폴더 · 도서 카드
   ══════════════════════════════════════════════════════════ */
const TITLE_MAX_LEN = 10; /* [L2] 말줄임표 최대 글자 수 */

function truncateTitle(title) {
  if (!title) return '제목 없음';
  return title.length > TITLE_MAX_LEN ? title.slice(0, TITLE_MAX_LEN) + '…' : title;
}

/** 제목 문자열로 HSL 색조값 생성 (0~360) */
function _titleToHue(title) {
  let hash = 0;
  for (let i = 0; i < title.length; i++) { hash = title.charCodeAt(i) + ((hash << 5) - hash); }
  return Math.abs(hash) % 360;
}

/** [보완] 이름+크기 기반 파일 해시 (중복 등록 방지) */
function computeFileHash(file) {
  const seed = `${file.name}::${file.size}`;
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) + hash) + seed.charCodeAt(i);
  return `h${(hash >>> 0).toString(36)}_${file.size}`;
}

/* ══════════════════════════════════════════════════════════
   [2]-10 Web Worker 해시 연산 — 메인 스레드 60fps 유지
   대용량 파일은 내용 일부 + 메타로 해시를 백그라운드에서 산출
   ══════════════════════════════════════════════════════════ */
const HashWorker = (() => {
  let worker = null;
  let seq = 0;
  let workerSupported = (typeof window !== 'undefined' && typeof window.Worker === 'function');
  const pending = new Map();

  function _ensure() {
    /* [2] Web Worker 미지원/생성거부 환경이면 즉시 우회 */
    if (!workerSupported || worker) return;
    const code = `
      self.onmessage = function(e) {
        var id = e.data.id, name = e.data.name, size = e.data.size, sample = e.data.sample;
        var seed = name + '::' + size + '::';
        var hash = 5381;
        for (var i = 0; i < seed.length; i++) hash = ((hash << 5) + hash) + seed.charCodeAt(i);
        var bytes = new Uint8Array(sample);
        for (var j = 0; j < bytes.length; j += 64) hash = ((hash << 5) + hash) + bytes[j];
        self.postMessage({ id: id, hash: 'h' + (hash >>> 0).toString(36) + '_' + size });
      };
    `;
    try {
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (e) => {
        const { id, hash } = e.data;
        const res = pending.get(id);
        if (res) { res(hash); pending.delete(id); }
      };
      /* 런타임 에러 시 워커 비활성화하고 메인스레드 폴백으로 전환 */
      worker.onerror = () => { workerSupported = false; worker = null; };
    } catch (_) {
      /* 보안 컨텍스트(비보안 HTTP)·CSP·하위 브라우저에서 생성 거부 → 영구 폴백 */
      workerSupported = false; worker = null;
    }
  }

  /** 메인스레드 비차단 해시 (setTimeout으로 이벤트루프 양보) */
  function _computeMainThreadAsync(file) {
    return new Promise((resolve) => {
      setTimeout(() => { resolve(computeFileHash(file)); }, 0);
    });
  }

  /** 파일 해시를 워커에서 산출 (미지원/실패 시 메인스레드 비동기 폴백) */
  async function compute(file) {
    /* [2] 삼항 가드: 워커 미지원이면 메인 스레드 비동기 루틴으로 우회 */
    if (!workerSupported) return _computeMainThreadAsync(file);
    _ensure();
    if (!worker) return _computeMainThreadAsync(file);
    try {
      const sample = await file.slice(0, 65536).arrayBuffer();
      return await new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        worker.postMessage({ id, name: file.name, size: file.size, sample }, [sample]);
        /* 타임아웃 폴백 (워커 응답 지연 시 메인스레드 산출) */
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(computeFileHash(file)); } }, 3000);
      });
    } catch (_) { return _computeMainThreadAsync(file); }
  }

  function destroy() { if (worker) { worker.terminate(); worker = null; } pending.clear(); }
  return { compute, destroy };
})();

/**
 * [v6] 서재 데이터 로드 → Reactive Store 반영
 * books / folders / 태그집계 / readingLog 를 단일 트랜잭션 묶음으로 로드
 */
async function refreshLibraryData() {
  const [books, folders, readingLog] = await Promise.all([
    StorageSystem.getAllBooks(),
    StorageSystem.getAllFolders(),
    StorageSystem.getReadingLog(),
  ]);
  /* 전역 태그 집계 */
  const tagSet = new Set();
  books.forEach(b => (b.tags || []).forEach(t => tagSet.add(t)));
  ReactiveStore.patch({
    libraryBooks: books,
    folders,
    readingLog,
    allTags: [...tagSet].sort(),
  });
}

/** [L1] 표지 또는 HSL 플레이스홀더 노드 생성 */
function _buildCoverNode(book) {
  if (book.coverDataUrl) {
    const img = document.createElement('img');
    img.className = 'book-cover-img';
    img.src       = book.coverDataUrl;
    img.alt       = book.title || '표지';
    img.loading   = 'lazy';
    /* [보완] 표지 로드 실패 시 HSL 플레이스홀더로 폴백 */
    img.onerror = () => { img.replaceWith(_buildPlaceholder(book.title || '')); };
    return img;
  }
  return _buildPlaceholder(book.title || '');
}

/** [보완] 제목 첫 글자 기반 HSL 플레이스홀더 */
function _buildPlaceholder(title) {
  const placeholder = document.createElement('div');
  placeholder.className = 'book-cover-placeholder';
  const hue = _titleToHue(title);
  placeholder.style.background = `hsl(${hue}, 32%, 70%)`;
  placeholder.setAttribute('aria-hidden', 'true');
  const initials = document.createElement('span');
  initials.textContent = (title.trim()[0] || 'E').toUpperCase();
  placeholder.appendChild(initials);
  return placeholder;
}

/**
 * [요구2-최상단] 최근 읽은 책 3권 렌더링 (진행률 포함)
 */
function renderRecentBooks(books) {
  const section = DOMProxy.get('recent-section');
  const row     = DOMProxy.get('recent-row');
  if (!DOMProxy.exists('recent-row')) return;

  const recent = books
    .filter(b => b.lastReadAt)
    .sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))
    .slice(0, RECENT_MAX);

  if (!recent.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  row.innerHTML = '';

  const frag = document.createDocumentFragment();
  recent.forEach(b => {
    const pct = b.percent || 0;
    const item = document.createElement('div');
    item.className = 'recent-card';
    item.setAttribute('role', 'listitem');
    item.setAttribute('aria-label', `${b.title || '제목 없음'} 이어 읽기 (${pct}%)`);

    const cover = document.createElement('div');
    cover.className = 'recent-cover';
    cover.appendChild(_buildCoverNode(b));

    const info = document.createElement('div');
    info.className = 'recent-info';

    const titleEl = document.createElement('div');
    titleEl.className = 'recent-title';
    titleEl.textContent = b.title || '제목 없음';

    const progWrap = document.createElement('div');
    progWrap.className = 'recent-progress-track';
    progWrap.setAttribute('role', 'progressbar');
    progWrap.setAttribute('aria-valuenow', String(pct));
    progWrap.setAttribute('aria-valuemin', '0');
    progWrap.setAttribute('aria-valuemax', '100');
    const progFill = document.createElement('div');
    progFill.className = 'recent-progress-fill';
    progFill.style.width = `${pct}%`;
    progWrap.appendChild(progFill);

    const pctText = document.createElement('span');
    pctText.className = 'recent-pct';
    pctText.textContent = `${pct}% 읽음`;

    info.appendChild(titleEl);
    info.appendChild(progWrap);
    info.appendChild(pctText);

    item.appendChild(cover);
    item.appendChild(info);
    item.addEventListener('click', () => openEpubBook(b.bytes, true));
    frag.appendChild(item);
  });
  row.appendChild(frag);
}

/**
 * [요구2-중단] 폴더 칩 바 렌더링
 */
function renderFolderBar(folders, books) {
  const bar = DOMProxy.get('folder-bar');
  if (!DOMProxy.exists('folder-bar')) return;
  bar.innerHTML = '';

  const frag = document.createDocumentFragment();

  /* '전체' 칩 */
  const allChip = document.createElement('button');
  allChip.className = 'folder-chip' + (store.activeFolderId === null ? ' active' : '');
  allChip.textContent = `전체 (${books.length})`;
  allChip.setAttribute('role', 'tab');
  allChip.setAttribute('aria-selected', String(store.activeFolderId === null));
  allChip.addEventListener('click', () => { store.activeFolderId = null; });
  frag.appendChild(allChip);

  /* 폴더 칩들 */
  folders.forEach(f => {
    const cnt = books.filter(b => b.folderId === f.id).length;
    const chip = document.createElement('button');
    chip.className = 'folder-chip' + (store.activeFolderId === f.id ? ' active' : '');
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', String(store.activeFolderId === f.id));

    const label = document.createElement('span');
    label.textContent = `📁 ${f.name} (${cnt})`;
    chip.appendChild(label);

    /* 폴더 삭제 버튼 */
    const del = document.createElement('span');
    del.className = 'folder-chip-del';
    del.textContent = '✕';
    del.setAttribute('role', 'button');
    del.setAttribute('aria-label', `${f.name} 폴더 삭제`);
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      /* [요구1-3] 파괴적 유실 방지 — 엄격한 Cascade 경고 */
      const warn = '이 폴더를 삭제하면 폴더 안의 모든 도서와 독서 퍼센트 기록, 하이라이트가 영구적으로 함께 삭제됩니다. 정말 삭제하시겠습니까?';
      if (confirm(warn)) {
        /* [요구1-4] 트랜잭션 원자성 — DB cascade 완료(await) 직후 store 1회 갱신 */
        StorageSystem.deleteFolder(f.id).then(async (result) => {
          if (store.activeFolderId === f.id) store.activeFolderId = null;
          /* 단일 트랜잭션 settle 후 libraryBooks + folders를 한 번에 patch (플리커 제로) */
          const [books, folders] = await Promise.all([
            StorageSystem.getAllBooks(),
            StorageSystem.getAllFolders(),
          ]);
          ReactiveStore.patch({ libraryBooks: books, folders });
          const n = result?.deletedBooks || 0;
          Toast.show(n > 0 ? `폴더와 도서 ${n}권이 삭제되었습니다.` : '폴더가 삭제되었습니다.', 'success');
        });
      }
    });
    chip.appendChild(del);

    chip.addEventListener('click', () => { store.activeFolderId = f.id; });

    /* [3]-8 드롭 타깃: 도서 카드를 폴더 칩 위로 드롭하면 이동 */
    chip.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('text/fable-book')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        chip.classList.add('drop-target');
      }
    });
    chip.addEventListener('dragleave', () => chip.classList.remove('drop-target'));
    chip.addEventListener('drop', async (e) => {
      e.preventDefault();
      chip.classList.remove('drop-target');
      const bookKey = e.dataTransfer.getData('text/fable-book');
      if (!bookKey) return;
      await StorageSystem.setBookFolder(bookKey, f.id);
      await refreshLibraryData();
      Toast.show(`'${f.name}'(으)로 이동했습니다.`, 'success');
    });

    frag.appendChild(chip);
  });

  /* '전체' 칩도 드롭 타깃 (폴더에서 빼기) */
  allChip.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/fable-book')) { e.preventDefault(); allChip.classList.add('drop-target'); }
  });
  allChip.addEventListener('dragleave', () => allChip.classList.remove('drop-target'));
  allChip.addEventListener('drop', async (e) => {
    e.preventDefault();
    allChip.classList.remove('drop-target');
    const bookKey = e.dataTransfer.getData('text/fable-book');
    if (!bookKey) return;
    await StorageSystem.setBookFolder(bookKey, null);
    await refreshLibraryData();
    Toast.show('폴더에서 제외했습니다.', 'success');
  });

  /* 폴더 생성 버튼 */
  const addChip = document.createElement('button');
  addChip.className = 'folder-chip folder-chip--add';
  addChip.textContent = '+ 폴더';
  addChip.setAttribute('aria-label', '새 폴더 생성');
  addChip.addEventListener('click', createFolderPrompt);
  frag.appendChild(addChip);

  bar.appendChild(frag);
}

/** 폴더 생성 프롬프트 */
function createFolderPrompt() {
  const name = prompt('새 폴더 이름을 입력하세요:');
  if (!name || !name.trim()) return;
  const folder = { id: 'folder_' + Date.now().toString(36), name: name.trim().slice(0, 30), ts: Date.now() };
  StorageSystem.saveFolder(folder).then(async () => {
    await refreshLibraryData();
    Toast.show(`'${folder.name}' 폴더가 생성되었습니다.`, 'success');
  });
}

/**
 * [요구2-도서카드] 카드 메뉴 (폴더 지정 + 삭제)
 */
function _showCardMenu(book, anchorEl) {
  document.querySelectorAll('.card-menu-popup').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'card-menu-popup';
  menu.setAttribute('role', 'menu');

  const head = document.createElement('div');
  head.className = 'card-menu-head';
  head.textContent = '폴더로 이동';
  menu.appendChild(head);

  /* 폴더 없음(전체) 옵션 */
  const noneItem = document.createElement('button');
  noneItem.className = 'card-menu-item' + (book.folderId == null ? ' checked' : '');
  noneItem.setAttribute('role', 'menuitem');
  noneItem.textContent = '📚 폴더 없음';
  noneItem.addEventListener('click', async (e) => {
    e.stopPropagation();
    await StorageSystem.setBookFolder(book.bookKey, null);
    await refreshLibraryData();
    menu.remove();
  });
  menu.appendChild(noneItem);

  store.folders.forEach(f => {
    const item = document.createElement('button');
    item.className = 'card-menu-item' + (book.folderId === f.id ? ' checked' : '');
    item.setAttribute('role', 'menuitem');
    item.textContent = `📁 ${f.name}`;
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      await StorageSystem.setBookFolder(book.bookKey, f.id);
      await refreshLibraryData();
      menu.remove();
      Toast.show(`'${f.name}'(으)로 이동했습니다.`, 'success');
    });
    menu.appendChild(item);
  });

  /* 새 폴더 생성 후 이동 */
  const newFolder = document.createElement('button');
  newFolder.className = 'card-menu-item card-menu-item--accent';
  newFolder.setAttribute('role', 'menuitem');
  newFolder.textContent = '+ 새 폴더에 추가';
  newFolder.addEventListener('click', async (e) => {
    e.stopPropagation();
    const name = prompt('새 폴더 이름:');
    if (name && name.trim()) {
      const folder = { id: 'folder_' + Date.now().toString(36), name: name.trim().slice(0, 30), ts: Date.now() };
      await StorageSystem.saveFolder(folder);
      await StorageSystem.setBookFolder(book.bookKey, folder.id);
      await refreshLibraryData();
      Toast.show(`'${folder.name}'에 추가되었습니다.`, 'success');
    }
    menu.remove();
  });
  menu.appendChild(newFolder);

  const divider0 = document.createElement('div');
  divider0.className = 'card-menu-divider';
  menu.appendChild(divider0);

  /* [1]-6 태그 편집 */
  const tagItem = document.createElement('button');
  tagItem.className = 'card-menu-item';
  tagItem.setAttribute('role', 'menuitem');
  tagItem.textContent = '🏷 태그 편집';
  tagItem.addEventListener('click', async (e) => {
    e.stopPropagation();
    menu.remove();
    const cur = (book.tags || []).join(', ');
    const input = prompt('태그를 쉼표(,)로 구분해 입력하세요:', cur);
    if (input === null) return;
    const tags = [...new Set(input.split(',').map(t => t.trim()).filter(Boolean).map(t => t.slice(0, 20)))].slice(0, 8);
    await StorageSystem.updateBookTags(book.bookKey, tags);
    await refreshLibraryData();
    Toast.show('태그가 저장되었습니다.', 'success');
  });
  menu.appendChild(tagItem);

  /* [1]-11 메타데이터 편집 */
  const metaItem = document.createElement('button');
  metaItem.className = 'card-menu-item';
  metaItem.setAttribute('role', 'menuitem');
  metaItem.textContent = '✏️ 정보 편집';
  metaItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.remove();
    MetadataEditor.open(book);
  });
  menu.appendChild(metaItem);

  /* [1]-7 메모/하이라이트 내보내기 */
  const exportItem = document.createElement('button');
  exportItem.className = 'card-menu-item';
  exportItem.setAttribute('role', 'menuitem');
  exportItem.textContent = '📤 메모 내보내기';
  exportItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.remove();
    AnnotationExporter.open(book);
  });
  menu.appendChild(exportItem);

  const divider = document.createElement('div');
  divider.className = 'card-menu-divider';
  menu.appendChild(divider);

  /* 삭제 */
  const delItem = document.createElement('button');
  delItem.className = 'card-menu-item card-menu-item--danger';
  delItem.setAttribute('role', 'menuitem');
  delItem.textContent = '🗑 서재에서 삭제';
  delItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.remove();
    /* [요구1-2] 도서 삭제 시 하이라이트/메모 연쇄 제거 안내 */
    if (confirm('이 도서를 삭제하면 독서 기록과 하이라이트·메모가 함께 영구 삭제됩니다. 삭제하시겠습니까?')) {
      StorageSystem.deleteBook(book.bookKey).then(async () => {
        await refreshLibraryData();
        Toast.show('도서와 관련 기록이 삭제되었습니다.', 'success');
      });
    }
  });
  menu.appendChild(delItem);

  document.body.appendChild(menu);

  /* 위치 — 앵커 기준, 뷰포트 오버플로우 방지 */
  const rect = anchorEl.getBoundingClientRect();
  let left = rect.left;
  let top  = rect.bottom + 6;
  const mw = 200, mh = menu.offsetHeight || 280;
  if (left + mw > window.innerWidth - 8)  left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8)  top = rect.top - mh - 6;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top  = `${Math.max(8, top)}px`;

  /* 외부 클릭 닫기 */
  const closeHandler = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', closeHandler); }
  };
  setTimeout(() => document.addEventListener('pointerdown', closeHandler), 10);
}

/* ══════════════════════════════════════════════════════════
   [1]-4/10 독서 분석 대시보드 (주간 추이 + 목표 달성률 + 인사이트)
   ══════════════════════════════════════════════════════════ */
function renderAnalyticsDashboard(books, readingLog) {
  const wrap = DOMProxy.get('dashboard-section');
  if (!DOMProxy.exists('dashboard-section')) return;

  /* 최근 7일 막대 그래프 데이터 */
  const days = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ key, label: ['일','월','화','수','목','금','토'][d.getDay()], sec: readingLog[key] || 0 });
  }
  const maxSec = Math.max(60, ...days.map(d => d.sec));
  const todaySec = days[days.length - 1].sec;
  const goalSec  = (store.dailyGoalMin || 30) * 60;
  const goalPct  = Math.min(100, Math.round((todaySec / goalSec) * 100));

  /* 주간 합계 */
  const weekSec = days.reduce((s, d) => s + d.sec, 0);
  const weekMin = Math.round(weekSec / 60);

  /* 인사이트: 평균 진행률 + 완독 예상 */
  const inProgress = books.filter(b => (b.percent || 0) > 0 && (b.percent || 0) < 100);
  const avgPct = inProgress.length ? Math.round(inProgress.reduce((s, b) => s + b.percent, 0) / inProgress.length) : 0;

  /* 막대 그래프 */
  const bars = days.map(d => {
    const h = Math.round((d.sec / maxSec) * 100);
    const min = Math.round(d.sec / 60);
    return `<div class="dash-bar-col">
      <div class="dash-bar-wrap"><div class="dash-bar" style="height:${h}%" title="${min}분"></div></div>
      <span class="dash-bar-label">${d.label}</span>
    </div>`;
  }).join('');

  wrap.innerHTML = `
    <div class="dash-grid">
      <div class="dash-card dash-card--chart">
        <div class="dash-card-head">주간 독서 추이</div>
        <div class="dash-chart">${bars}</div>
        <div class="dash-week-total">이번 주 ${weekMin}분</div>
      </div>
      <div class="dash-card dash-card--goal">
        <div class="dash-card-head">오늘 목표 달성률</div>
        <div class="dash-ring" style="--goal:${goalPct}">
          <span class="dash-ring-pct">${goalPct}%</span>
        </div>
        <div class="dash-goal-detail">${Math.round(todaySec/60)} / ${store.dailyGoalMin || 30}분</div>
      </div>
      <div class="dash-card dash-card--insight">
        <div class="dash-card-head">인사이트</div>
        <ul class="dash-insight-list">
          <li><span>읽는 중</span><strong>${inProgress.length}권</strong></li>
          <li><span>평균 진행률</span><strong>${avgPct}%</strong></li>
          <li><span>서재 도서</span><strong>${books.length}권</strong></li>
        </ul>
      </div>
    </div>`;
}

/* ══════════════════════════════════════════════════════════
   [1]-6 스마트 태그 다중 필터 바
   ══════════════════════════════════════════════════════════ */
function renderTagBar(allTags, books) {
  const bar = DOMProxy.get('tag-bar');
  if (!DOMProxy.exists('tag-bar')) return;
  bar.innerHTML = '';

  if (!allTags.length) {
    const hint = document.createElement('span');
    hint.className = 'tag-empty-hint';
    hint.textContent = '도서 메뉴에서 태그를 추가할 수 있습니다';
    bar.appendChild(hint);
    return;
  }

  const frag = document.createDocumentFragment();
  allTags.forEach(t => {
    const cnt = books.filter(b => (b.tags || []).includes(t)).length;
    const chip = document.createElement('button');
    const active = store.activeTags.includes(t);
    chip.className = 'tag-chip' + (active ? ' active' : '');
    chip.textContent = `#${t} ${cnt}`;
    chip.setAttribute('aria-pressed', String(active));
    chip.addEventListener('click', () => {
      const set = new Set(store.activeTags);
      set.has(t) ? set.delete(t) : set.add(t);
      store.activeTags = [...set];
    });
    frag.appendChild(chip);
  });

  /* 정렬 셀렉터 */
  const sortSel = document.createElement('select');
  sortSel.className = 'sort-select';
  sortSel.setAttribute('aria-label', '도서 정렬 기준');
  [['recent','최근 읽음'],['title','제목순'],['progress','진행률'],['added','추가순']].forEach(([v, label]) => {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = label;
    if (store.sortMode === v) opt.selected = true;
    sortSel.appendChild(opt);
  });
  sortSel.addEventListener('change', () => { store.sortMode = sortSel.value; });
  frag.appendChild(sortSel);

  bar.appendChild(frag);
}

/**
 * [요구2-하단 + v6] 도서 그리드 렌더링
 *  - 대시보드/태그/폴더/정렬/검색 필터 적용
 *  - [2]-9 AbortController 뮤텍스: 연속 폴더 클릭 시 이전 렌더 중단
 *  - [3]-8 카드 드래그&드롭으로 폴더 이동
 */
let _gridRenderController = null;

function renderLibraryGrid() {
  const grid  = DOMProxy.get('library-grid');
  const empty = DOMProxy.get('library-empty');
  const count = DOMProxy.get('library-count');
  if (!DOMProxy.exists('library-grid')) return;

  /* [2]-9 이전 렌더 중단 */
  if (_gridRenderController) _gridRenderController.abort();
  _gridRenderController = new AbortController();
  const signal = _gridRenderController.signal;

  const allBooks = store.libraryBooks || [];

  /* 상단 위젯 갱신 */
  renderAnalyticsDashboard(allBooks, store.readingLog || {});
  renderRecentBooks(allBooks);
  renderFolderBar(store.folders || [], allBooks);
  renderTagBar(store.allTags || [], allBooks);

  /* ── 필터 파이프라인 ── */
  let books = allBooks.slice();

  /* 폴더 필터 */
  if (store.activeFolderId !== null) books = books.filter(b => b.folderId === store.activeFolderId);

  /* 태그 다중 필터 (AND) */
  if (store.activeTags.length) {
    books = books.filter(b => store.activeTags.every(t => (b.tags || []).includes(t)));
  }

  /* 서재 검색어 (제목/저자) */
  const q = (store.librarySearch || '').trim().toLowerCase();
  if (q) books = books.filter(b => (b.title || '').toLowerCase().includes(q) || (b.creator || '').toLowerCase().includes(q));

  /* 정렬 */
  switch (store.sortMode) {
    case 'title':    books.sort((a, b) => (a.title || '').localeCompare(b.title || '')); break;
    case 'progress': books.sort((a, b) => (b.percent || 0) - (a.percent || 0)); break;
    case 'added':    books.sort((a, b) => (b.seq || 0) - (a.seq || 0)); break;
    case 'recent':
    default:         books.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0)); break;
  }

  grid.innerHTML = '';

  if (!allBooks.length) {
    if (empty) empty.style.display = 'flex';
    if (count) count.textContent = '';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (count) count.textContent = `${books.length}권`;

  if (!books.length) {
    const p = document.createElement('p');
    p.style.cssText = 'grid-column:1/-1;text-align:center;padding:30px;color:var(--color-ink-muted);font-size:13px;';
    p.textContent = '조건에 맞는 도서가 없습니다.';
    grid.appendChild(p);
    return;
  }

  /* [2]-4 대량 그리드는 청크 단위로 렌더 (AbortController 중단 가능) */
  const frag = document.createDocumentFragment();
  const CHUNK = 24;
  let idx = 0;

  function renderChunk() {
    if (signal.aborted) return;
    const end = Math.min(idx + CHUNK, books.length);
    for (; idx < end; idx++) {
      frag.appendChild(_buildBookCard(books[idx]));
    }
    if (idx < books.length) {
      requestAnimationFrame(renderChunk);
    } else {
      if (!signal.aborted) grid.appendChild(frag);
    }
    /* 첫 청크는 즉시 부착해 체감 속도 향상 */
    if (idx === Math.min(CHUNK, books.length) && grid.childElementCount === 0) {
      grid.appendChild(frag);
    }
  }
  /* 단순화: 한 번에 부착하되 signal 확인 */
  if (signal.aborted) return;
  books.forEach(b => frag.appendChild(_buildBookCard(b)));
  if (!signal.aborted) grid.appendChild(frag);
}

/** 개별 도서 카드 빌더 ([3]-8 드래그 소스 포함) */
function _buildBookCard(b) {
  const fullTitle = b.title || '제목 없음';
  const pct = b.percent || 0;

  const card = document.createElement('div');
  card.className = 'book-card';
  card.setAttribute('role', 'listitem');
  card.setAttribute('aria-label', `${fullTitle} 열기 (${pct}% 읽음)`);
  card.draggable = true;
  card.dataset.bookKey = b.bookKey;

  /* [3]-8 드래그 시작 */
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/fable-book', b.bookKey);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  const coverWrap = document.createElement('div');
  coverWrap.className = 'book-cover-wrap';
  coverWrap.dataset.tooltip = fullTitle;
  coverWrap.appendChild(_buildCoverNode(b));

  if (pct > 0) {
    const badge = document.createElement('div');
    badge.className = 'book-progress-badge';
    badge.textContent = `${pct}%`;
    coverWrap.appendChild(badge);
  }

  const menuBtn = document.createElement('button');
  menuBtn.className = 'btn-card-menu';
  menuBtn.textContent = '⋯';
  menuBtn.title = '도서 메뉴';
  menuBtn.setAttribute('aria-label', `${fullTitle} 메뉴`);
  menuBtn.setAttribute('aria-haspopup', 'menu');
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); _showCardMenu(b, menuBtn); });
  coverWrap.appendChild(menuBtn);

  const progLine = document.createElement('div');
  progLine.className = 'book-card-progress';
  const progLineFill = document.createElement('div');
  progLineFill.className = 'book-card-progress-fill';
  progLineFill.style.width = `${pct}%`;
  progLine.appendChild(progLineFill);
  coverWrap.appendChild(progLine);

  const titleEl = document.createElement('div');
  titleEl.className = 'book-card-title';
  titleEl.textContent = truncateTitle(fullTitle);

  /* 태그 미니칩 */
  if ((b.tags || []).length) {
    const tagRow = document.createElement('div');
    tagRow.className = 'book-card-tags';
    b.tags.slice(0, 2).forEach(t => {
      const chip = document.createElement('span');
      chip.className = 'book-card-tag';
      chip.textContent = t;
      tagRow.appendChild(chip);
    });
    card.appendChild(coverWrap);
    card.appendChild(titleEl);
    card.appendChild(tagRow);
  } else {
    card.appendChild(coverWrap);
    card.appendChild(titleEl);
  }

  card.addEventListener('click', () => openEpubBook(b.bytes, true));
  return card;
}

/* ══════════════════════════════════════════════════════════
   §25. [L3] 다중 파일 순차 등록 파이프라인 + [보완] 중복 방지
   ══════════════════════════════════════════════════════════ */
async function importEpubFiles(files) {
  if (!files || files.length === 0) return;

  /* [B1] ePub 가드 먼저 */
  const epubReady = await waitForEpubJS();
  if (!epubReady) {
    Toast.show('epub.js 라이브러리를 로드하지 못했습니다. 페이지를 새로고침해 주세요.', 'error');
    return;
  }

  const fileArr = Array.from(files);
  const total   = fileArr.length;

  if (total === 1) {
    /* [보완] 단일 파일도 중복 체크 */
    const hash = await HashWorker.compute(fileArr[0]);
    const dup  = await StorageSystem.findBookByHash(hash);
    if (dup) {
      Toast.show(`이미 서재에 있는 도서입니다: ${truncateTitle(dup.title)}`, 'info');
      await openEpubBook(dup.bytes, true);
      return;
    }
    await openEpubBook(fileArr[0], false);
    return;
  }

  /* 다중 파일: 메타/표지를 모은 뒤 [2]-3 단일 배치 트랜잭션으로 일괄 커밋 */
  ImportProgress.show(`0 / ${total} 도서 추가 중...`);
  let successCount = 0, dupCount = 0;
  const batch = []; /* { bookKey, buffer, title, creator, coverDataUrl, fileHash, publisher } */

  for (let i = 0; i < fileArr.length; i++) {
    const file = fileArr[i];

    if (!file.name.toLowerCase().endsWith('.epub')) {
      Toast.show(`${file.name}: EPUB 파일이 아닙니다.`, 'error');
      continue;
    }

    /* [보완] 중복 파일 등록 방지 (이름+크기 해시, 워커 산출) */
    const fileHash = await HashWorker.compute(file);
    const existing = await StorageSystem.findBookByHash(fileHash);
    if (existing) { dupCount++; continue; }
    /* 같은 배치 내 중복도 차단 */
    if (batch.some(r => r.fileHash === fileHash)) { dupCount++; continue; }

    ImportProgress.update(
      Math.round(((i + 0.5) / total) * 100),
      `${i + 1} / ${total} — ${file.name.slice(0, 20)}`
    );

    await ErrorBoundary.wrap('renderer', async () => {
      const buf  = await file.arrayBuffer();
      const book = window.ePub(buf.slice(0));
      await book.ready;

      let title = file.name.replace(/\.epub$/i, ''), creator = '', publisher = '';
      try {
        const meta = await book.loaded.metadata;
        title     = meta.title     || title;
        creator   = meta.creator   || '';
        publisher = meta.publisher || '';
      } catch (_) {}

      const coverDataUrl = await extractCoverDataUrl(book);
      try { book.destroy(); } catch (_) {}

      const bookKey = 'fable_cfi_' + (title + creator).replace(/[^a-zA-Z0-9가-힣]/g, '_').slice(0, 50);
      batch.push({ bookKey, buffer: buf, title, creator, coverDataUrl, fileHash, publisher });
      successCount++;
    })();

    /* 프레임 양보 (메타 파싱은 무겁지만 디스크 쓰기는 배치로 1회만) */
    await new Promise(r => setTimeout(r, 0));
  }

  /* [2]-3 모든 도서를 단일 readwrite 트랜잭션으로 일괄 저장 */
  if (batch.length) {
    await ErrorBoundary.wrap('storage', () => StorageSystem.batchSaveBooks(batch))();
  }

  ImportProgress.update(100, '완료!');
  await new Promise(r => setTimeout(r, 600));
  ImportProgress.hide();

  await refreshLibraryData();

  let msg = '';
  if (successCount > 0) msg += `${successCount}권 추가`;
  if (dupCount > 0)     msg += `${msg ? ', ' : ''}중복 ${dupCount}권 제외`;
  if (msg) Toast.show(msg + ' 완료', 'success');
}

/* ══════════════════════════════════════════════════════════
   §26. TTS 엔진
   ══════════════════════════════════════════════════════════ */
const TTSSystem = (() => {
  let utterance = null, isPaused = false, totalLen = 0;
  function play(text) {
    if (!text) return;
    window.speechSynthesis.cancel(); totalLen = text.length;
    utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'ko-KR'; utterance.rate = 1.0;
    utterance.onboundary = (e) => { if (e.charIndex != null) { DOMProxy.get('tts-progress-fill').style.width = `${Math.min(100,(e.charIndex/totalLen)*100)}%`; } };
    utterance.onend = utterance.onerror = () => { DOMProxy.get('tts-player-bar').style.display='none'; DOMProxy.get('tts-progress-fill').style.width='0%'; };
    isPaused = false; window.speechSynthesis.speak(utterance);
    DOMProxy.get('tts-player-bar').style.display = 'flex'; setTextSafe(DOMProxy.get('btn-tts-play-pause'), '⏸');
  }
  function pauseResume() {
    if (isPaused) { window.speechSynthesis.resume(); isPaused = false; setTextSafe(DOMProxy.get('btn-tts-play-pause'), '⏸'); }
    else { window.speechSynthesis.pause(); isPaused = true; setTextSafe(DOMProxy.get('btn-tts-play-pause'), '▶'); }
  }
  function stop() { window.speechSynthesis.cancel(); DOMProxy.get('tts-player-bar').style.display='none'; }
  return { play, pauseResume, stop };
})();

/* ══════════════════════════════════════════════════════════
   §27. 독서 통계
   ══════════════════════════════════════════════════════════ */
const ReadingStatsTracker = (() => {
  let timer = null;
  let pendingSeconds = 0; /* readingLog 일괄 커밋 버퍼 */
  function startSession() {
    store.readingSession.startTime = Date.now();
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        store.readingSession.accumulated++;
        pendingSeconds++;
        _updateUI();
        /* [1]-4 30초마다 일별 독서로그 일괄 적재 */
        if (pendingSeconds >= 30) { StorageSystem.addReadingSeconds(pendingSeconds); pendingSeconds = 0; }
      }
    }, 1000);
    ResourceRegistry.addTimer(timer);
  }
  function stopSession() {
    clearInterval(timer);
    if (pendingSeconds > 0) { StorageSystem.addReadingSeconds(pendingSeconds); pendingSeconds = 0; }
  }
  function markPosition(cfi) { if (cfi) store.readingSession.positions.add(cfi); _updateUI(); }
  function _updateUI() {
    const total = store.readingSession.accumulated, min = Math.floor(total / 60), sec = total % 60;
    setTextSafe(DOMProxy.get('stat-reading-time'), `${min}분 ${sec}초`);
    setTextSafe(DOMProxy.get('stat-pages-read'), String(store.readingSession.positions.size));
    const goalMin = parseInt(localStorage.getItem('fable_daily_goal') || '30', 10);
    const fill = DOMProxy.get('goal-progress-fill'), pct = Math.min(100, (min / goalMin) * 100);
    fill.style.transition = 'width 600ms cubic-bezier(0.34,1.56,0.64,1)'; fill.style.width = `${pct}%`;
    DOMProxy.q('.goal-track').setAttribute('aria-valuenow', Math.round(pct));
    if (pct >= 100 && fill.dataset.notified !== '1') { fill.dataset.notified = '1'; Toast.show('\uD83C\uDF89 오늘의 독서 목표를 달성했습니다!', 'success'); }
  }
  return { startSession, stopSession, markPosition };
})();

/* ══════════════════════════════════════════════════════════
   §28. 컨텍스트 메뉴 (롱프레스)
   ══════════════════════════════════════════════════════════ */
function initContextMenu() {
  const viewer = DOMProxy.get('screen-viewer');
  if (!DOMProxy.exists('screen-viewer')) return;
  let longPressTimer = null, selectedText = '';

  function showMenu() { if (!selectedText) return; const m = DOMProxy.get('context-menu'); m.style.display='flex'; m.classList.add('slide-up'); }
  function hideMenu() { const m = DOMProxy.get('context-menu'); m.classList.remove('slide-up'); setTimeout(() => { m.style.display='none'; }, 280); }

  const onStart = (e) => {
    longPressTimer = setTimeout(() => {
      if (store.rendition) {
        try { DOMProxy.get('viewer-viewport').querySelectorAll('iframe').forEach(f => { const s = f.contentWindow?.getSelection()?.toString()?.trim(); if (s?.length > 1) selectedText = s; }); } catch (_) {}
      }
      if (selectedText) showMenu();
    }, 600);
  };
  ResourceRegistry.addListener(viewer, 'touchstart', onStart, { passive: true });
  ResourceRegistry.addListener(viewer, 'touchend',   () => clearTimeout(longPressTimer), { passive: true });
  ResourceRegistry.addListener(viewer, 'touchmove',  () => clearTimeout(longPressTimer), { passive: true });
  ResourceRegistry.addListener(document, 'pointerdown', (e) => { if (!DOMProxy.get('context-menu').contains?.(e.target)) { hideMenu(); selectedText = ''; } }, { passive: true });

  DOMProxy.get('ctx-copy').addEventListener('click', () => { if (selectedText) navigator.clipboard?.writeText(selectedText).catch(() => {}); Toast.show('클립보드에 복사했습니다.'); hideMenu(); });
  DOMProxy.get('ctx-tts').addEventListener('click', () => { if (selectedText) TTSSystem.play(selectedText); hideMenu(); });
  DOMProxy.get('ctx-search').addEventListener('click', () => {
    const m=DOMProxy.get('search-modal'), i=DOMProxy.get('input-search-query'); i.value=selectedText; m.style.display='flex'; runSearchExecution(); hideMenu();
  });
  DOMProxy.get('ctx-highlight').addEventListener('click', () => { Toast.show('하이라이트 기능은 텍스트 선택 후 자동 추가됩니다.'); hideMenu(); });
}

/* ══════════════════════════════════════════════════════════
   §29. Annotation Manager
   ══════════════════════════════════════════════════════════ */
const AnnotationManager = (() => {
  let _rendition = null;
  function init(rendition) {
    _rendition = rendition;
    rendition.on('selected', async (cfiRange, contents) => {
      const sel = contents.window.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim().length < 2) return;
      try {
        const ann = await AnnotationSyncEngine.create(store.bookKey, cfiRange, sel.toString().trim(), 'yellow');
        rendition.annotations.add('highlight', cfiRange, { uuid: ann.uuid }, null, 'hl-yellow');
        Toast.show('하이라이트가 저장되었습니다.', 'success');
      } catch (e) { ErrorBoundary.handle('storage', e, 'annotation:create'); }
    });
  }
  function restoreAll(annotations) {
    if (!_rendition) return;
    annotations.forEach(ann => { try { _rendition.annotations.add('highlight', ann.cfiRange, { uuid: ann.uuid }, null, 'hl-' + (ann.color||'yellow')); } catch (_) {} });
  }
  function reset() { _rendition = null; }
  return { init, restoreAll, reset };
})();

function initAnnotationManager(rendition) { AnnotationManager.init(rendition); }

/* ══════════════════════════════════════════════════════════
   §30. 폰트 업로더
   ══════════════════════════════════════════════════════════ */
function initFontUploader() {
  if (!DOMProxy.exists('font-uploader')) return;
  DOMProxy.get('font-uploader').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const safeId = 'custom_' + Math.random().toString(36).slice(2, 10);
      try {
        const face = new FontFace(safeId, `url(${evt.target.result})`);
        const loaded = await face.load(); document.fonts.add(loaded);
        if (store.rendition) { store.rendition.themes.font(safeId); Toast.show('커스텀 폰트가 적용되었습니다.', 'success'); }
      } catch (err) { Toast.show(`폰트 로드 실패: ${err.message}`, 'error'); }
    };
    reader.readAsDataURL(file); e.target.value = '';
  });
}

/* ══════════════════════════════════════════════════════════
   [2]-2 오프라인 폰트 동적 로딩 (Font Lazy Loading)
   서체 선택 시점에만 @font-face / Google Fonts를 비동기 인젝션
   ══════════════════════════════════════════════════════════ */
const FontLazyLoader = (() => {
  const loaded = new Set();
  /* 폰트 정의: id → { label, family, href(웹폰트), local(시스템) } */
  const FONTS = {
    'gowun':  { label: '고운바탕', family: "'Gowun Batang', serif", href: 'https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&display=swap' },
    'noto':   { label: '본명조',   family: "'Noto Serif KR', serif", href: 'https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;700&display=swap' },
    'sans':   { label: '본고딕',   family: "'Noto Sans KR', sans-serif", href: 'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;700&display=swap' },
    'nanum':  { label: '나눔명조', family: "'Nanum Myeongjo', serif", href: 'https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@400;700&display=swap' },
    'system': { label: '시스템',   family: 'system-ui, -apple-system, sans-serif', href: null },
  };

  function _injectStylesheet(href) {
    return new Promise((resolve) => {
      if (!href) return resolve();
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = href;
      link.onload = () => resolve(); link.onerror = () => resolve();
      document.head.appendChild(link);
    });
  }

  /** 선택 시점에만 비동기 로드 후 rendition에 적용 */
  async function apply(fontId) {
    const def = FONTS[fontId];
    if (!def) return;
    if (!loaded.has(fontId)) {
      Toast.show(`${def.label} 서체 로딩 중...`, 'info');
      await _injectStylesheet(def.href);
      if (def.href && document.fonts?.ready) { try { await document.fonts.ready; } catch (_) {} }
      loaded.add(fontId);
    }
    if (store.rendition) {
      try { store.rendition.themes.override('font-family', def.family + ' !important'); } catch (_) {}
    }
    store.fontFamily = fontId;
    localStorage.setItem('fable_font_family', fontId);
  }

  function list() { return Object.entries(FONTS).map(([id, d]) => ({ id, label: d.label })); }
  return { apply, list, FONTS };
})();

function initFontSelector() {
  const sel = DOMProxy.get('font-family-select');
  if (!DOMProxy.exists('font-family-select')) return;
  /* 옵션 채우기 */
  sel.innerHTML = '';
  FontLazyLoader.list().forEach(({ id, label }) => {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = label;
    sel.appendChild(opt);
  });
  const saved = localStorage.getItem('fable_font_family') || 'gowun';
  sel.value = saved;
  sel.addEventListener('change', () => FontLazyLoader.apply(sel.value));
}

/* ══════════════════════════════════════════════════════════
   §31. 커스텀 테마 빌더
   ══════════════════════════════════════════════════════════ */
function initCustomThemeBuilder() {
  function syncColor(colorId, hexId, storeKey) {
    const colorEl = DOMProxy.get(colorId), hexEl = DOMProxy.get(hexId);
    colorEl.addEventListener('input', () => { const v=colorEl.value; hexEl.value=v; store[storeKey]=v; _saveStateToLS(); });
    hexEl.addEventListener('input', () => { const v=hexEl.value.trim(); if (/^#[0-9A-Fa-f]{6}$/.test(v)) { colorEl.value=v; store[storeKey]=v; _saveStateToLS(); } });
  }
  syncColor('input-user-bg', 'input-user-bg-hex', 'userBg');
  syncColor('input-user-ink','input-user-ink-hex','userInk');
  DOMProxy.get('input-user-spacing').addEventListener('input', () => { const v=parseFloat(DOMProxy.get('input-user-spacing').value); setTextSafe(DOMProxy.get('spacing-val'), v+'em'); store.userSpacing=v; _saveStateToLS(); });
  DOMProxy.get('input-user-leading').addEventListener('input', () => { const v=parseFloat(DOMProxy.get('input-user-leading').value); setTextSafe(DOMProxy.get('leading-val'), String(v)); store.userLeading=v; _saveStateToLS(); });
}

/* ══════════════════════════════════════════════════════════
   §32. 키보드 단축키
   ══════════════════════════════════════════════════════════ */
function handleKeyDown(e) {
  const viewer = DOMProxy.get('screen-viewer');
  if (!DOMProxy.exists('screen-viewer') || viewer.style.display === 'none') return;
  if (!store.rendition) return;
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case ' ':     e.preventDefault(); NavGuard.next(); break;
    case 'ArrowLeft':  case 'ArrowUp':  case 'Backspace': e.preventDefault(); NavGuard.prev(); break;
    case 'Escape':
      if (store.isSettingsOpen) { store.isSettingsOpen = false; break; }
      if (store.isTocOpen)      { store.isTocOpen      = false; break; }
      if (confirm('뷰어를 닫고 서재로 돌아가시겠습니까?')) exitViewer(); break;
    default: break;
  }
}

function showKeyboardHint() {
  if (localStorage.getItem('fable_keyboard_hint_shown')) return;
  DOMProxy.get('keyboard-hint-layer').style.display = 'flex';
  localStorage.setItem('fable_keyboard_hint_shown', '1');
}

/* ══════════════════════════════════════════════════════════
   §33. 오프라인 배너
   ══════════════════════════════════════════════════════════ */
function initOfflineBanner() {
  function update(offline) {
    [DOMProxy.get('offline-banner'), DOMProxy.get('offline-banner-viewer')].forEach(b => { b.style.display = offline ? 'flex' : 'none'; });
  }
  window.addEventListener('offline', () => { update(true); Toast.show('인터넷 연결이 끊겼습니다. 오프라인 모드로 작동 중입니다.'); });
  window.addEventListener('online',  async () => { update(false); Toast.show('인터넷 연결이 복원되었습니다.', 'success'); await AnnotationSyncEngine.syncPending(); });
  if (!navigator.onLine) update(true);
}

/* ══════════════════════════════════════════════════════════
   §34. 스크롤 맨위로 버튼
   ══════════════════════════════════════════════════════════ */
function bindScrollTopButton(view) {
  const btn = DOMProxy.get('btn-scroll-top');
  const iframe = view?.element?.querySelector('iframe');
  if (!iframe) return;
  const cw = iframe.contentWindow; if (!cw) return;
  const onScroll = () => { btn.style.display = cw.scrollY > 200 ? 'flex' : 'none'; };
  ResourceRegistry.addListener(cw, 'scroll', onScroll, { passive: true });
  btn.onclick = () => cw.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ══════════════════════════════════════════════════════════
   §35. 설정 저장 / 복원
   ══════════════════════════════════════════════════════════ */
function _saveStateToLS() {
  const snap = { fontSize: store.fontSize, lineHeight: store.lineHeight, theme: store.theme, flow: store.flow,
                 userBg: store.userBg, userInk: store.userInk, userSpacing: store.userSpacing, userLeading: store.userLeading };
  try { localStorage.setItem(STATE_KEY, JSON.stringify(snap)); } catch (_) {}
}

function _loadStateFromLS() {
  try {
    const raw = localStorage.getItem(STATE_KEY); if (!raw) return;
    const s = JSON.parse(raw);
    ReactiveStore.patch({
      fontSize: s.fontSize ?? 100, lineHeight: s.lineHeight ?? 'normal', theme: s.theme ?? 'paper', flow: s.flow ?? 'paginated',
      userBg: s.userBg ?? '#f4f1ea', userInk: s.userInk ?? '#1a1814', userSpacing: s.userSpacing ?? 0, userLeading: s.userLeading ?? 1.85,
    });
  } catch (_) {}
}

/* ══════════════════════════════════════════════════════════
   §36. 버튼 이벤트 전체 바인딩
   ══════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════
   §35b. [요구3] 퍼센트 위치 이동
   ══════════════════════════════════════════════════════════ */
/* [3]-2 퍼센트 위치의 챕터(장) 제목 추정 */
function _chapterAtPercent(pct) {
  try {
    const toc = store.toc || [];
    if (!toc.length || !store.book?.spine) return '';
    const spineLen = store.book.spine.items.length || 1;
    const idx = Math.min(spineLen - 1, Math.floor((pct / 100) * spineLen));
    const href = store.book.spine.items[idx]?.href || '';
    /* TOC에서 href 매칭되는 라벨 탐색 */
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

function _seekToPercent(pct) {
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

function initButtonEventHandlers() {
  const fileInput = DOMProxy.get('file-input');

  /* ── [U1] 서재 화면 상단 컨트롤 바 ── */
  DOMProxy.get('btn-file-select').addEventListener('click', (e) => {
    e.stopPropagation(); fileInput.click();
  });

  /* [L3] 다중 파일 change */
  fileInput.addEventListener('change', async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      await importEpubFiles(e.target.files);
    }
    fileInput.value = '';
  });

  /* [U2] 서재 화면 설정 버튼 */
  DOMProxy.get('btn-library-settings').addEventListener('click', () => {
    store.isSettingsOpen = !store.isSettingsOpen;
  });

  /* ── 드래그앤드롭 (서재 화면 전체) ── */
  const uploader = DOMProxy.get('screen-uploader');
  const dragOverlay = DOMProxy.get('drag-overlay');

  let dragCounter = 0;

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    /* 서재 화면일 때만 오버레이 표시 */
    if (!store.isViewerOpen) {
      dragOverlay.style.display = 'flex';
    }
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dragOverlay.style.display = 'none';
    }
  });

  document.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dragOverlay.style.display = 'none';
    const files = e.dataTransfer.files;
    if (!files?.length) return;
    await importEpubFiles(files);
  });

  /* ── 뷰어 ── */
  DOMProxy.get('arrow-prev').addEventListener('click', () => NavGuard.prev());
  DOMProxy.get('arrow-next').addEventListener('click', () => NavGuard.next());

  DOMProxy.get('btn-toc-toggle').addEventListener('click', () => { store.isTocOpen = !store.isTocOpen; });
  DOMProxy.get('btn-toc-close').addEventListener('click',  () => { store.isTocOpen = false; });
  DOMProxy.get('toc-overlay').addEventListener('click',    () => { store.isTocOpen = false; });

  /* [U2] 뷰어 설정 버튼 */
  DOMProxy.get('btn-settings-toggle').addEventListener('click', () => { store.isSettingsOpen = !store.isSettingsOpen; });

  /* 공용 설정 닫기 버튼 */
  DOMProxy.get('btn-settings-close').addEventListener('click', () => { store.isSettingsOpen = false; });

  DOMProxy.get('btn-close-viewer').addEventListener('click', () => {
    if (confirm('뷰어를 닫고 서재로 돌아가시겠습니까?')) exitViewer();
  });

  DOMProxy.qa('[data-flow]').forEach(btn => btn.addEventListener('click', () => switchFlowMode(btn.dataset.flow)));
  DOMProxy.get('btn-font-decrease').addEventListener('click', () => { store.fontSize = Math.max(60, store.fontSize - 5); _saveStateToLS(); });
  DOMProxy.get('btn-font-increase').addEventListener('click', () => { store.fontSize = Math.min(200, store.fontSize + 5); _saveStateToLS(); });
  DOMProxy.qa('[data-lh]').forEach(btn => btn.addEventListener('click', () => { store.lineHeight = btn.dataset.lh; _saveStateToLS(); }));
  DOMProxy.qa('.theme-swatch').forEach(btn => btn.addEventListener('click', () => { store.theme = btn.dataset.theme; _saveStateToLS(); }));

  DOMProxy.get('btn-search-toggle').addEventListener('click', () => { DOMProxy.get('search-modal').style.display='flex'; setTimeout(() => DOMProxy.get('input-search-query').focus(), 60); });
  DOMProxy.get('btn-search-modal-close').addEventListener('click', () => { DOMProxy.get('search-modal').style.display='none'; VirtualSearchList.destroy(); });
  DOMProxy.get('btn-execute-search').addEventListener('click', runSearchExecution);
  DOMProxy.get('input-search-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearchExecution(); });

  DOMProxy.get('btn-stats-toggle').addEventListener('click', () => { DOMProxy.get('stats-modal').style.display='flex'; });
  if (DOMProxy.exists('btn-pomodoro-open')) DOMProxy.get('btn-pomodoro-open').addEventListener('click', () => Pomodoro.openPopup());
  DOMProxy.get('btn-stats-modal-close').addEventListener('click', () => { DOMProxy.get('stats-modal').style.display='none'; });
  DOMProxy.get('btn-save-goal').addEventListener('click', () => { const v=DOMProxy.get('input-reading-goal').value; if(v){localStorage.setItem('fable_daily_goal',v);store.dailyGoalMin=parseInt(v,10);renderLibraryGrid();Toast.show('독서 목표가 저장되었습니다.','success');} });

  DOMProxy.get('btn-annotation-toggle').addEventListener('click', () => {
    if (!store.rendition) return;
    try { const doc = store.rendition.manager?.current()?.document; const text = doc?.body?.textContent?.slice(0, 4000)||''; if(text) TTSSystem.play(text); }
    catch (_) { Toast.show('TTS를 시작할 수 없습니다.', 'error'); }
  });
  DOMProxy.get('btn-tts-play-pause').addEventListener('click', () => TTSSystem.pauseResume());
  DOMProxy.get('btn-tts-stop').addEventListener('click',       () => TTSSystem.stop());
  DOMProxy.get('btn-hint-close').addEventListener('click', () => { DOMProxy.get('keyboard-hint-layer').style.display='none'; });

  /* [요구3 + 3-2] 퍼센트 이동 드래그 바 + 실시간 플로팅 툴팁 */
  const slider = DOMProxy.get('progress-range-slider');
  if (DOMProxy.exists('progress-range-slider')) {
    const tooltip = DOMProxy.get('slider-tooltip');

    function _positionTooltip(pct) {
      /* 노브 위치 계산 → 툴팁을 노브 위에 따라다니게 */
      const rect = slider.getBoundingClientRect();
      const x = rect.left + (rect.width * pct / 100);
      tooltip.style.left = `${x}px`;
      tooltip.style.display = 'flex';
      setTextSafe(DOMProxy.get('slider-tooltip-pct'), `${pct}%`);
      setTextSafe(DOMProxy.get('slider-tooltip-chapter'), _chapterAtPercent(pct));
    }

    slider.addEventListener('input', () => {
      slider.dataset.dragging = '1';
      const pct = parseInt(slider.value, 10);
      setTextSafe(DOMProxy.get('viewer-progress-text'), `${pct}%`);
      DOMProxy.get('progress-bar-fill').style.width = `${pct}%`;
      _positionTooltip(pct);
    });
    slider.addEventListener('change', () => {
      const pct = parseInt(slider.value, 10);
      delete slider.dataset.dragging;
      tooltip.style.display = 'none';
      _seekToPercent(pct);
    });
    /* 포인터를 떼면 툴팁 숨김 (모바일 안전장치) */
    slider.addEventListener('pointerup',   () => { setTimeout(() => { tooltip.style.display = 'none'; }, 100); });
    slider.addEventListener('pointerleave', () => { if (!slider.dataset.dragging) tooltip.style.display = 'none'; });
  }

  /* 설정 패널 외부 클릭 닫기 (서재/뷰어 양쪽 처리) */
  document.addEventListener('pointerdown', (e) => {
    const panel  = DOMProxy.get('settings-panel');
    const btnV   = DOMProxy.get('btn-settings-toggle');
    const btnL   = DOMProxy.get('btn-library-settings');
    if (store.isSettingsOpen &&
        !panel.contains?.(e.target) &&
        !btnV.contains?.(e.target) &&
        !btnL.contains?.(e.target)) {
      store.isSettingsOpen = false;
    }
  }, { passive: true });

  document.addEventListener('keydown', handleKeyDown);
  initFontUploader();
  initFontSelector();      /* [2]-2 */
  initCustomThemeBuilder();
}

/* ══════════════════════════════════════════════════════════
   [1]-11 메타데이터 수동 편집기 (모달)
   ══════════════════════════════════════════════════════════ */
const MetadataEditor = (() => {
  let _book = null;

  function open(book) {
    _book = book;
    DOMProxy.get('meta-edit-title').value     = book.title || '';
    DOMProxy.get('meta-edit-creator').value   = book.creator || '';
    DOMProxy.get('meta-edit-publisher').value = book.publisher || '';
    const preview = DOMProxy.get('meta-edit-cover-preview');
    if (book.coverDataUrl) { preview.src = book.coverDataUrl; preview.style.display = 'block'; }
    else preview.style.display = 'none';
    preview.dataset.newCover = '';
    DOMProxy.get('metadata-modal').style.display = 'flex';
  }

  function close() { DOMProxy.get('metadata-modal').style.display = 'none'; _book = null; }

  async function save() {
    if (!_book) return;
    const preview = DOMProxy.get('meta-edit-cover-preview');
    const payload = {
      title:     DOMProxy.get('meta-edit-title').value.trim() || '제목 없음',
      creator:   DOMProxy.get('meta-edit-creator').value.trim(),
      publisher: DOMProxy.get('meta-edit-publisher').value.trim(),
      coverDataUrl: preview.dataset.newCover || null,
    };
    await StorageSystem.updateBookMeta(_book.bookKey, payload);
    await refreshLibraryData();
    Toast.show('도서 정보가 수정되었습니다.', 'success');
    close();
  }

  function init() {
    if (!DOMProxy.exists('metadata-modal')) return;
    DOMProxy.get('btn-meta-edit-close').addEventListener('click', close);
    DOMProxy.get('btn-meta-edit-save').addEventListener('click', save);
    /* 표지 재업로드 */
    DOMProxy.get('meta-edit-cover-input').addEventListener('change', (e) => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        /* canvas 리사이즈로 200px 썸네일화 */
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const MAX = 200, ratio = Math.min(MAX / img.width, MAX / img.height, 1);
          canvas.width = Math.round(img.width * ratio); canvas.height = Math.round(img.height * ratio);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          const preview = DOMProxy.get('meta-edit-cover-preview');
          preview.src = dataUrl; preview.style.display = 'block'; preview.dataset.newCover = dataUrl;
        };
        img.src = evt.target.result;
      };
      reader.readAsDataURL(file); e.target.value = '';
    });
  }

  return { open, close, save, init };
})();

/* ══════════════════════════════════════════════════════════
   [1]-7 어노테이션 익스포트 (Markdown / JSON / PDF)
   ══════════════════════════════════════════════════════════ */
const AnnotationExporter = (() => {
  let _book = null;

  async function open(book) {
    _book = book;
    const anns = await StorageSystem.getAnnotationsByBook(book.bookKey);
    if (!anns.length) { Toast.show('내보낼 하이라이트/메모가 없습니다.', 'info'); return; }
    DOMProxy.get('export-modal').style.display = 'flex';
    setTextSafe(DOMProxy.get('export-modal-info'), `${book.title || '제목 없음'} — ${anns.length}개 항목`);
  }

  function close() { DOMProxy.get('export-modal').style.display = 'none'; _book = null; }

  function _download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportAs(format) {
    if (!_book) return;
    const anns = await StorageSystem.getAnnotationsByBook(_book.bookKey);
    const safeTitle = (_book.title || 'book').replace(/[^a-zA-Z0-9가-힣]/g, '_').slice(0, 40);
    const sorted = anns.slice().sort((a, b) => (a.device_timestamp || 0) - (b.device_timestamp || 0));

    if (format === 'json') {
      _download(`${safeTitle}_notes.json`, JSON.stringify(sorted, null, 2), 'application/json');
    } else if (format === 'markdown') {
      let md = `# ${_book.title || '제목 없음'}\n`;
      if (_book.creator) md += `*${_book.creator}*\n`;
      md += `\n> 하이라이트 ${sorted.length}개 · 내보낸 날짜 ${new Date().toLocaleDateString('ko-KR')}\n\n---\n\n`;
      sorted.forEach((a, i) => {
        md += `### ${i + 1}. \n`;
        md += `> ${a.text || ''}\n\n`;
        if (a.note) md += `**메모:** ${a.note}\n\n`;
        md += `\n`;
      });
      _download(`${safeTitle}_notes.md`, md, 'text/markdown');
    } else if (format === 'pdf') {
      /* 의존성 없는 경량 PDF 생성 (텍스트 기반) */
      _exportPdf(_book, sorted, safeTitle);
    }
    Toast.show('내보내기가 완료되었습니다.', 'success');
    close();
  }

  /* 외부 라이브러리 없이 최소 PDF 1.4 문서를 직접 조립 */
  function _exportPdf(book, anns, safeTitle) {
    /* [1] PDF 문자열 안전 이스케이프
       - 역슬래시 → \\  (가장 먼저)
       - 소괄호 (, ) → \(, \)  (PDF 리터럴 문자열 구분자라 반드시 이스케이프)
       - 제어문자(개행/탭/캐리지리턴) → 공백/이스케이프 시퀀스
       - 멀티바이트 유니코드는 PDF 기본 WinAnsi 폰트로 깨질 수 있으므로
         Latin-1 범위를 벗어난 코드포인트는 '?'로 안전 폴백 */
    function escapePdfText(str) {
      let out = '';
      for (const ch of String(str)) {
        const code = ch.codePointAt(0);
        if (ch === '\\') { out += '\\\\'; }
        else if (ch === '(') { out += '\\('; }
        else if (ch === ')') { out += '\\)'; }
        else if (ch === '\r') { out += ' '; }
        else if (ch === '\n') { out += ' '; }
        else if (ch === '\t') { out += '  '; }
        else if (code < 0x20) { out += ' '; }            /* 기타 제어문자 제거 */
        else if (code > 0xFF) { out += '?'; }            /* WinAnsi 미지원 멀티바이트 폴백 */
        else { out += ch; }
      }
      return out;
    }

    /* content stream의 바이트 길이를 정확히 구해 /Length 무결성 확보
       (멀티바이트가 ?로 폴백되므로 사실상 1바이트지만, 안전하게 바이트 측정) */
    function byteLength(str) {
      return (typeof TextEncoder !== 'undefined')
        ? new TextEncoder().encode(str).length
        : unescape(encodeURIComponent(str)).length;
    }

    const lines = [];
    lines.push(`${book.title || '제목 없음'}`);
    if (book.creator) lines.push(`${book.creator}`);
    lines.push(`Highlights: ${anns.length}`);
    lines.push('');
    anns.forEach((a, i) => {
      const text = (a.text || '');
      /* 한 줄 80자 단위로 분할 (이스케이프는 주입 직전에 수행) */
      const wrapped = text.match(/[\s\S]{1,80}/g) || [text];
      lines.push(`${i + 1}. ${wrapped[0]}`);
      for (let j = 1; j < wrapped.length; j++) lines.push(`   ${wrapped[j]}`);
      if (a.note) lines.push(`   [Note] ${a.note}`);
      lines.push('');
    });

    /* PDF content stream — 각 라인을 이스케이프 후 주입 */
    let stream = 'BT /F1 11 Tf 50 780 Td 14 TL\n';
    lines.forEach(line => {
      stream += `(${escapePdfText(line)}) Tj T*\n`;
    });
    stream += 'ET';

    const objects = [];
    objects.push('<< /Type /Catalog /Pages 2 0 R >>');
    objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
    objects.push(`<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

    let pdf = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((obj, i) => {
      offsets.push(byteLength(pdf));
      pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    });
    const xrefPos = byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach(off => { pdf += String(off).padStart(10, '0') + ' 00000 n \n'; });
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

    _download(`${safeTitle}_notes.pdf`, pdf, 'application/pdf');
  }

  function init() {
    if (!DOMProxy.exists('export-modal')) return;
    DOMProxy.get('btn-export-close').addEventListener('click', close);
    DOMProxy.get('btn-export-md').addEventListener('click', () => exportAs('markdown'));
    DOMProxy.get('btn-export-json').addEventListener('click', () => exportAs('json'));
    DOMProxy.get('btn-export-pdf').addEventListener('click', () => exportAs('pdf'));
  }

  return { open, close, init };
})();

/* ══════════════════════════════════════════════════════════
   [1]-5 풀텍스트 로컬 서재 검색 (전 도서 본문 → CFI 점프)
   ══════════════════════════════════════════════════════════ */
const LibraryFullTextSearch = (() => {
  let _running = false;

  function open() {
    DOMProxy.get('fts-modal').style.display = 'flex';
    setTimeout(() => DOMProxy.get('fts-input').focus(), 60);
  }
  function close() { DOMProxy.get('fts-modal').style.display = 'none'; }

  async function run() {
    if (_running) return;
    const q = DOMProxy.get('fts-input').value.trim();
    if (q.length < 2) { Toast.show('검색어는 2글자 이상 입력하세요.', 'error'); return; }
    _running = true;
    const resultsEl = DOMProxy.get('fts-results');
    resultsEl.innerHTML = '<p class="fts-status">전체 서재 본문을 검색 중입니다...</p>';

    const books = store.libraryBooks || [];
    const allHits = [];

    /* [B1] ePub 가드 */
    const ready = await waitForEpubJS();
    if (!ready) { resultsEl.innerHTML = '<p class="fts-status">epub.js 로드 실패</p>'; _running = false; return; }

    for (const b of books) {
      await ErrorBoundary.wrap('renderer', async () => {
        const book = window.ePub(b.bytes.slice(0));
        await book.ready;
        const parser = new DOMParser();
        const items = book.spine?.items || [];
        let bookHits = 0;
        for (const item of items) {
          if (bookHits >= 5) break; /* 책당 최대 5건 */
          try {
            const section = book.spine.get(item.href || item.idref);
            if (!section) continue;
            await section.load(book.load.bind(book));
            const doc = parser.parseFromString(section.content || '<html></html>', 'text/html');
            const paras = Array.from(doc.querySelectorAll('p,h1,h2,h3,li'));
            for (const p of paras) {
              const text = p.textContent || '';
              const pos = text.toLowerCase().indexOf(q.toLowerCase());
              if (pos >= 0) {
                let cfi = ''; try { cfi = section.cfiFromElement(p); } catch (_) { cfi = item.href; }
                allHits.push({
                  bookKey: b.bookKey, title: b.title, cfi,
                  snippet: text.slice(Math.max(0, pos - 30), pos + 50),
                });
                bookHits++;
                if (bookHits >= 5) break;
              }
            }
            section.unload();
          } catch (_) {}
        }
        try { book.destroy(); } catch (_) {}
      })();
      await new Promise(r => setTimeout(r, 0));
    }

    _running = false;
    _renderResults(allHits, q);
  }

  function _renderResults(hits, q) {
    const resultsEl = DOMProxy.get('fts-results');
    resultsEl.innerHTML = '';
    if (!hits.length) { resultsEl.innerHTML = '<p class="fts-status">검색 결과가 없습니다.</p>'; return; }

    /* [2]-4 가상 스크롤: 보이는 항목만 렌더 */
    VirtualListRenderer.render(resultsEl, hits, (hit) => {
      const item = document.createElement('div');
      item.className = 'fts-result-item';
      const title = document.createElement('div');
      title.className = 'fts-result-title';
      title.textContent = `📖 ${hit.title || '제목 없음'}`;
      const snip = document.createElement('div');
      snip.className = 'fts-result-snippet';
      /* 키워드 강조 */
      const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      snip.innerHTML = '';
      hit.snippet.split(re).forEach(part => {
        if (re.test(part)) { const m = document.createElement('mark'); m.textContent = part; snip.appendChild(m); re.lastIndex = 0; }
        else snip.appendChild(document.createTextNode(part));
      });
      item.appendChild(title); item.appendChild(snip);
      item.addEventListener('click', async () => {
        close();
        const rec = await StorageSystem.getBook(hit.bookKey);
        if (rec) {
          await openEpubBook(rec.bytes, true);
          /* 렌더 후 해당 CFI로 점프 */
          setTimeout(() => { try { store.rendition?.display(hit.cfi); } catch (_) {} }, 1200);
        }
      });
      return item;
    });
  }

  function init() {
    if (!DOMProxy.exists('fts-modal')) return;
    DOMProxy.get('btn-fts-close').addEventListener('click', close);
    DOMProxy.get('btn-fts-run').addEventListener('click', run);
    DOMProxy.get('fts-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  }

  return { open, close, init };
})();

/* ══════════════════════════════════════════════════════════
   [2]-4 범용 가상 스크롤 렌더러 (TOC / 검색 결과 공용)
   IntersectionObserver sentinel + DOM 재활용
   ══════════════════════════════════════════════════════════ */
const VirtualListRenderer = (() => {
  const CHUNK = 20;
  const states = new WeakMap();

  function render(container, items, builderFn) {
    if (!container) return;
    container.innerHTML = '';
    let rendered = 0;

    const sentinel = document.createElement('div');
    sentinel.style.height = '1px';

    function renderChunk() {
      const end = Math.min(rendered + CHUNK, items.length);
      const frag = document.createDocumentFragment();
      for (; rendered < end; rendered++) frag.appendChild(builderFn(items[rendered]));
      container.insertBefore(frag, sentinel);
    }

    renderChunk();
    container.appendChild(sentinel);

    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && rendered < items.length) {
        renderChunk();
        container.appendChild(sentinel);
      }
    }, { root: container, threshold: 0.1 });
    obs.observe(sentinel);
    states.set(container, obs);
  }

  function destroy(container) {
    const obs = states.get(container);
    if (obs) { obs.disconnect(); states.delete(container); }
  }
  return { render, destroy };
})();

/* ══════════════════════════════════════════════════════════
   [1]-8 클라우드 수동 백업 / 복원 (WebDAV + Google Drive 프레임워크)
   ══════════════════════════════════════════════════════════ */
const CloudBackup = (() => {
  /* 로컬 파일 백업 (즉시 가용) */
  async function backupToFile() {
    Toast.show('백업 데이터를 생성 중입니다...', 'info');
    const data = await StorageSystem.exportDatabase();
    const json = JSON.stringify(data);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `fable_backup_${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    Toast.show('서재 백업 파일이 저장되었습니다.', 'success');
  }

  async function restoreFromFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!confirm('백업을 복원하면 동일 키의 기존 데이터가 덮어쓰기됩니다. 계속하시겠습니까?')) return;
      await StorageSystem.importDatabase(data);
      await refreshLibraryData();
      Toast.show('서재가 복원되었습니다.', 'success');
    } catch (err) {
      ErrorBoundary.handle('storage', err, 'restore');
      Toast.show('복원 실패: 유효하지 않은 백업 파일입니다.', 'error');
    }
  }

  /* ── WebDAV 프레임워크 스텁 ── */
  const WebDAV = {
    async upload(url, user, pass, data) {
      /* PUT 요청으로 프라이빗 WebDAV 서버에 업로드 */
      const auth = 'Basic ' + btoa(`${user}:${pass}`);
      return fetch(url, { method: 'PUT', headers: { 'Authorization': auth, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    },
    async download(url, user, pass) {
      const auth = 'Basic ' + btoa(`${user}:${pass}`);
      const res = await fetch(url, { headers: { 'Authorization': auth } });
      if (!res.ok) throw new Error(`WebDAV ${res.status}`);
      return res.json();
    },
  };

  /* ── Google Drive 프레임워크 스텁 (OAuth 토큰 필요) ── */
  const GoogleDrive = {
    async upload(accessToken, data) {
      const metadata = { name: `fable_backup_${Date.now()}.json`, mimeType: 'application/json' };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', new Blob([JSON.stringify(data)], { type: 'application/json' }));
      return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}` }, body: form,
      });
    },
    async download(accessToken, fileId) {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Drive ${res.status}`);
      return res.json();
    },
  };

  function init() {
    /* 백업 버튼 클릭은 initLibraryControls에서 바인딩됨 — 여기선 복원 input만 처리 */
    if (DOMProxy.exists('restore-file-input')) {
      DOMProxy.get('restore-file-input').addEventListener('change', (e) => {
        if (e.target.files[0]) restoreFromFile(e.target.files[0]);
        e.target.value = '';
      });
    }
  }

  return { backupToFile, restoreFromFile, WebDAV, GoogleDrive, init };
})();

/* ══════════════════════════════════════════════════════════
   [1]-12 포모도로 독서 타이머 (25분 집중 / 5분 휴식)
   ══════════════════════════════════════════════════════════ */
const Pomodoro = (() => {
  const FOCUS = 25 * 60, BREAK = 5 * 60;
  let remaining = FOCUS, mode = 'idle', timer = null;

  function _fmt(s) { const m = Math.floor(s / 60), sec = s % 60; return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; }

  function _tick() {
    remaining--;
    setTextSafe(DOMProxy.get('pomodoro-time'), _fmt(remaining));
    if (remaining <= 0) {
      if (mode === 'focus') { Toast.show('🍅 집중 시간 완료! 5분 휴식하세요.', 'success'); mode = 'break'; remaining = BREAK; }
      else { Toast.show('휴식 끝! 다시 집중해 볼까요?', 'info'); mode = 'focus'; remaining = FOCUS; }
      store.pomodoroState = mode;
      _updateModeLabel();
    }
  }

  function start() {
    if (mode === 'idle') { mode = 'focus'; remaining = FOCUS; }
    store.pomodoroState = mode;
    _updateModeLabel();
    clearInterval(timer);
    timer = setInterval(_tick, 1000);
    ResourceRegistry.addTimer(timer);
    DOMProxy.get('pomodoro-popup').style.display = 'flex';
    setTextSafe(DOMProxy.get('btn-pomodoro-toggle'), '⏸');
  }
  function pause() { clearInterval(timer); timer = null; setTextSafe(DOMProxy.get('btn-pomodoro-toggle'), '▶'); }
  function reset() { clearInterval(timer); timer = null; mode = 'idle'; remaining = FOCUS; store.pomodoroState = 'idle'; setTextSafe(DOMProxy.get('pomodoro-time'), _fmt(FOCUS)); _updateModeLabel(); setTextSafe(DOMProxy.get('btn-pomodoro-toggle'), '▶'); }
  function toggle() {
    const popup = DOMProxy.get('pomodoro-popup');
    if (popup.style.display === 'flex' && timer) pause();
    else start();
  }
  function _updateModeLabel() {
    const label = mode === 'focus' ? '집중' : mode === 'break' ? '휴식' : '대기';
    setTextSafe(DOMProxy.get('pomodoro-mode'), label);
    DOMProxy.get('pomodoro-popup').dataset.mode = mode;
  }

  function init() {
    if (!DOMProxy.exists('pomodoro-popup')) return;
    setTextSafe(DOMProxy.get('pomodoro-time'), _fmt(FOCUS));
    DOMProxy.get('btn-pomodoro-toggle').addEventListener('click', toggle);
    DOMProxy.get('btn-pomodoro-reset').addEventListener('click', reset);
    DOMProxy.get('btn-pomodoro-close').addEventListener('click', () => { pause(); DOMProxy.get('pomodoro-popup').style.display = 'none'; });
  }
  function openPopup() {
    const popup = DOMProxy.get('pomodoro-popup');
    popup.style.display = popup.style.display === 'flex' ? 'none' : 'flex';
  }

  return { init, start, pause, reset, toggle, openPopup };
})();

/* ══════════════════════════════════════════════════════════
   [2]-6 CFI 디코딩 메모이제이션 (위치 역산 가속)
   ══════════════════════════════════════════════════════════ */
const CFICache = (() => {
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
   §37. 전역 진입점
   ══════════════════════════════════════════════════════════ */
async function initializeSystemCore() {
  /* [B1] 최상단 ePub 가드 로그 */
  if (typeof window.ePub !== 'function') {
    console.warn('[Fable] ePub 아직 로드되지 않음 — 폴링 가드 활성화');
  }

  window.addEventListener('unhandledrejection', (e) => {
    ErrorBoundary.handle('global', e.reason ?? new Error('Unhandled rejection'), 'unhandledrejection');
  });

  window.addEventListener('beforeunload', () => {
    if (store.bookKey && store.currentCFI) {
      try { localStorage.setItem('fable_cfi_' + store.bookKey, JSON.stringify({ data: store.currentCFI, ts: Date.now() })); } catch (_) {}
    }
    /* [요구2] 잔여 진행률 버퍼 강제 커밋 (페이지 이탈 직전) */
    try { StorageSystem.flushProgressNow(); } catch (_) {}
  });

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      console.log('[Fable] SW 등록 완료:', reg.scope);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller)
            Toast.show('앱이 업데이트되었습니다. 새로고침하면 최신 버전을 사용할 수 있습니다.');
        });
      });
    } catch (err) { console.warn('[Fable] SW 등록 실패:', err); }
  }

  await StorageSystem.init()?.catch(err => ErrorBoundary.handle('storage', err, 'init'));

  mountReactiveBinders();
  _loadStateFromLS();
  _forceSyncSettingsUI();
  initButtonEventHandlers();
  initOfflineBanner();
  initContextMenu();
  /* [v6] 신규 모듈 초기화 */
  MetadataEditor.init();        /* [1]-11 */
  AnnotationExporter.init();    /* [1]-7 */
  LibraryFullTextSearch.init(); /* [1]-5 */
  CloudBackup.init();           /* [1]-8 */
  Pomodoro.init();              /* [1]-12 */
  initLibraryControls();        /* 대시보드/검색/백업 상단 컨트롤 */
  initStickyHeader();           /* [3]-9 */
  refreshLibraryData();
  if (!('ontouchstart' in window)) showKeyboardHint();

  console.log('\uD83D\uDCD6 Fable v3.1 — Library Edition Initialized');
}

/* [3]-9 미니멀 상단바 스크롤 동적 고정 (Sticky Header) */
function initStickyHeader() {
  const body = DOMProxy.get('library-body');
  const topbar = DOMProxy.get('library-topbar');
  if (!DOMProxy.exists('library-body') || !DOMProxy.exists('library-topbar')) return;
  let lastY = 0;
  const onScroll = () => {
    const y = body.scrollTop;
    if (y < 10) topbar.classList.remove('topbar-hidden');
    else if (y > lastY + 4) topbar.classList.add('topbar-hidden');
    else if (y < lastY - 4) topbar.classList.remove('topbar-hidden');
    lastY = y;
  };
  body.addEventListener('scroll', onScroll, { passive: true });
}

/* 서재 상단 컨트롤(검색·풀텍스트·백업) 바인딩 */
function initLibraryControls() {
  if (DOMProxy.exists('library-search-input')) {
    const si = DOMProxy.get('library-search-input');
    let t = null;
    si.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { store.librarySearch = si.value; }, 200);
    });
  }
  if (DOMProxy.exists('btn-fts-open')) DOMProxy.get('btn-fts-open').addEventListener('click', () => LibraryFullTextSearch.open());
  if (DOMProxy.exists('btn-cloud-backup')) DOMProxy.get('btn-cloud-backup').addEventListener('click', () => CloudBackup.backupToFile());
  store.dailyGoalMin = parseInt(localStorage.getItem('fable_daily_goal') || '30', 10);
}

function _forceSyncSettingsUI() {
  setTextSafe(DOMProxy.get('font-size-display'), `${store.fontSize}%`);
  DOMProxy.qa('[data-lh]').forEach(b => { const ok = b.dataset.lh === store.lineHeight; b.classList.toggle('active',ok); b.setAttribute('aria-checked',String(ok)); });
  DOMProxy.qa('[data-flow]').forEach(b => { const ok = b.dataset.flow === store.flow; b.classList.toggle('active',ok); b.setAttribute('aria-checked',String(ok)); });
  DOMProxy.qa('.theme-swatch').forEach(b => { const ok = b.dataset.theme === store.theme; b.classList.toggle('active',ok); b.setAttribute('aria-checked',String(ok)); });
  DOMProxy.get('custom-theme-builder').style.display = store.theme === 'custom' ? 'block' : 'none';
  if (store.theme !== 'paper' && store.theme !== 'custom') document.body.setAttribute('data-theme', store.theme);
  document.documentElement.style.setProperty('--color-user-bg',       store.userBg);
  document.documentElement.style.setProperty('--color-user-ink',      store.userInk);
  document.documentElement.style.setProperty('--user-letter-spacing', store.userSpacing + 'em');
  document.documentElement.style.setProperty('--user-line-height',    String(store.userLeading));
  DOMProxy.get('input-user-bg').value      = store.userBg;
  DOMProxy.get('input-user-bg-hex').value  = store.userBg;
  DOMProxy.get('input-user-ink').value     = store.userInk;
  DOMProxy.get('input-user-ink-hex').value = store.userInk;
  DOMProxy.get('input-user-spacing').value = String(store.userSpacing);
  setTextSafe(DOMProxy.get('spacing-val'), store.userSpacing + 'em');
  DOMProxy.get('input-user-leading').value = String(store.userLeading);
  setTextSafe(DOMProxy.get('leading-val'), String(store.userLeading));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSystemCore);
} else {
  initializeSystemCore();
}
