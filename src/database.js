/**
 * src/database.js
 * ───────────────────────────────────────────────────────────────
 * StorageSystem — IndexedDB v6 제어 비동기 래퍼
 *
 * 보존된 스펙:
 *   - books / annotations / folders / readingLog / meta 스토어
 *   - fileHash 유니크 인덱스, tags multiEntry 인덱스, seq 내부 시퀀스 키
 *   - Cascade Delete (folder→books→annotations 단일 트랜잭션)
 *   - 300ms 디바운스 진행률 동기화 (updateBookProgress)
 *   - 배치 트랜잭션 (batchSaveBooks), 전체 DB export/import
 *   - localStorage LRU eviction
 * ─────────────────────────────────────────────────────────────── */

'use strict';

import {
  DB_NAME, DB_VER,
  store, ErrorBoundary, Toast,
  _abToBase64, _base64ToAb,
} from './store.js';

/* ══════════════════════════════════════════════════════════
   §6. StorageSystem (IndexedDB v6)
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

export { StorageSystem };
