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
 *
 * [v5.0 신규 — 고도화 #7] LRU 스토리지 압축 자동 크기 트리거
 *   saveBook() 완료 직후 checkQuotaAndReap()을 fire-and-forget으로 호출,
 *   navigator.storage.estimate() 사용량 비율이 QUOTA_WARN_RATIO(85%)를
 *   넘으면 reapLeastRecentlyUsedBinaries()가 가장 오래 열람하지 않은
 *   도서부터 본문 바이너리(bytes)만 null로 비우고 메타데이터는 보존한다
 *   (binaryEvicted 플래그로 스텁 레코드 표시, 완전 삭제와는 구분됨).
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
   *
   * [v5.0 신규 — 고도화 #7] 저장 완료 직후 IndexedDB 용량 임박 여부를
   * 비동기로 체크하여, 한계에 가까우면 LRUBinaryReaper를 트리거한다.
   * saveBook 자체의 트랜잭션 완료(resolve)를 막지 않도록 fire-and-forget
   * 으로 호출한다(체크/수거 자체가 다음 saveBook을 지연시키면 안 됨).
   */
  async saveBook(bookKey, buffer, title, creator, coverDataUrl = null, fileHash = null, extra = {}) {
    const seq = await this._nextSeq();
    const result = await new Promise((resolve, reject) => {
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
          /* [v5.0] LRU 본문 바이너리 무력화 가드 — 신규/갱신 저장 시에는
             항상 false로 리셋한다(사용자가 다시 불러온 도서이므로 본문이
             실재함을 보장). reapLeastRecentlyUsedBinaries()만이 true로
             전환할 수 있다. */
          binaryEvicted: false,
        });
      };
      getReq.onerror = () => {
        os.put({ bookKey, seq, bytes: buffer, title: title || '제목 없음', creator: creator || '',
                 publisher: extra.publisher || '', coverDataUrl: coverDataUrl || null, fileHash: fileHash || null,
                 folderId: null, tags: [], percent: 0, lastReadAt: null, ts: Date.now(),
                 binaryEvicted: false });
      };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });

    /* 저장 자체의 응답성을 해치지 않도록 비동기 체크는 await하지 않고
       다음 마이크로/매크로태스크로 흘려보낸다(fire-and-forget). */
    this.checkQuotaAndReap().catch(() => {});

    return result;
  },

  /**
   * [v5.0 신규 — 고도화 #7] LRU 스토리지 압축 자동 크기 트리거
   * ─────────────────────────────────────────────────────────────────
   * navigator.storage.estimate()로 origin의 사용량/할당량 비율을 측정해
   * QUOTA_WARN_RATIO(85%)를 넘으면 reapLeastRecentlyUsedBinaries()를
   * 호출한다. estimate API가 없는 환경(구형 브라우저)에서는 조용히
   * 스킵하고, books 스토어 자체의 대략적 총 바이트 합산으로 폴백한다.
   */
  QUOTA_WARN_RATIO: 0.85,

  async checkQuotaAndReap() {
    let usageRatio = null;
    try {
      if (navigator.storage?.estimate) {
        const { usage, quota } = await navigator.storage.estimate();
        if (typeof usage === 'number' && typeof quota === 'number' && quota > 0) {
          usageRatio = usage / quota;
        }
      }
    } catch (_) { /* estimate 미지원 — 폴백 경로로 진행 */ }

    if (usageRatio === null) {
      /* [폴백] storage.estimate API가 없으면, books 스토어의 bytes 필드
         총합을 대략적인 휴리스틱 임계치(200MB)와 비교한다. 정확한 quota를
         알 수 없으므로 보수적으로 동작한다. */
      const approxBytes = await this._approxBooksByteSize();
      const HEURISTIC_LIMIT = 200 * 1024 * 1024; /* 200MB */
      if (approxBytes >= HEURISTIC_LIMIT) {
        await this.reapLeastRecentlyUsedBinaries();
      }
      return;
    }

    if (usageRatio >= this.QUOTA_WARN_RATIO) {
      await this.reapLeastRecentlyUsedBinaries();
    }
  },

  /* navigator.storage.estimate()가 없는 환경을 위한 근사치 계산 —
     ArrayBuffer.byteLength 합산(메타데이터 객체 자체의 오버헤드는 무시). */
  async _approxBooksByteSize() {
    const books = await this.getAllBooks();
    return books.reduce((sum, b) => {
      if (b.binaryEvicted || !b.bytes) return sum;
      try { return sum + (b.bytes.byteLength || 0); } catch (_) { return sum; }
    }, 0);
  },

  /**
   * [v5.0 신규 — 고도화 #7] LRU 본문 바이너리 선별 무력화
   * ─────────────────────────────────────────────────────────────────
   * 용량 한계가 임박했을 때, 가장 오래 열람하지 않은(lastReadAt 오름차순)
   * 도서부터 본문 바이너리(bytes)만 null로 비우고 메타데이터(제목/표지/
   * 진행률/태그 등)는 그대로 보존한다. 완전 삭제(deleteBook)와 달리
   * 서재 목록에는 계속 노출되며, 사용자가 다시 열면 재임포트를 안내할
   * 수 있는 "스텁(stub)" 레코드로 전환된다. 이미 binaryEvicted인 레코드,
   * bytes가 없는 레코드는 후보에서 제외한다(이미 비워졌거나 원래 없음).
   * 한 번에 EVICT_BATCH개씩만 처리하여 단일 트랜잭션이 과도하게
   * 길어지는 것을 방지한다.
   */
  EVICT_BATCH: 3,

  async reapLeastRecentlyUsedBinaries() {
    const books = await this.getAllBooks();
    const candidates = books
      .filter(b => !b.binaryEvicted && b.bytes)
      .sort((a, b) => (a.lastReadAt || 0) - (b.lastReadAt || 0))
      .slice(0, this.EVICT_BATCH);

    if (!candidates.length) return 0;

    await new Promise((resolve) => {
      const tx = store.indexedDB.transaction(['books'], 'readwrite');
      const os = tx.objectStore('books');
      candidates.forEach((rec) => {
        rec.bytes = null;
        rec.binaryEvicted = true;
        rec.binaryEvictedAt = Date.now();
        os.put(rec);
      });
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    });

    try {
      Toast.show(
        `저장 공간 확보를 위해 ${candidates.length}권의 도서 본문이 임시로 정리되었습니다. 서재 목록에서 다시 불러올 수 있습니다.`,
        'info',
      );
    } catch (_) {}

    return candidates.length;
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
   *
   * [버그 수정 — A-8] 트랜잭션 수명 보장
   * ─────────────────────────────────────────────────────────────
   * 기존 구현은 Promise를 반환하지 않는 fire-and-forget 동기 함수였다.
   * 호출부(flushProgressNow)가 이 함수의 "완료"를 기다리지 않고 즉시
   * resolve 되었기 때문에, 뷰어 종료/도서 전환처럼 트랜잭션이 실제로
   * 커밋되기 전에 다음 단계(destroyCurrentRenditionContext 등)가
   * 진행되어 진행률 쓰기가 누락되거나, 이미 비활성화된(inactive) 구버전
   * 트랜잭션 핸들에 접근해 TransactionInactiveError가 발생할 수 있었다.
   * 이제 Promise를 반환하여 tx.oncomplete/onerror/onabort 까지 명시적으로
   * 대기하며, 트랜잭션 객체 생성 자체가 던지는 예외(DB 핸들 close 등)도
   * try/catch 로 흡수해 상위 체인이 끊기지 않도록 한다.
   */
  _flushProgress() {
    const pending = this._progressPending;
    this._progressPending = null;
    if (!pending || !store.indexedDB) return Promise.resolve(false);

    return new Promise((resolve) => {
      let tx;
      try {
        tx = store.indexedDB.transaction(['books'], 'readwrite');
      } catch (e) {
        /* DB 핸들이 close된 직후 등 트랜잭션 생성 자체가 실패하는 경우 */
        ErrorBoundary.handle('storage', e, 'flushProgress:txOpen');
        resolve(false);
        return;
      }
      const os = tx.objectStore('books');
      let   req;
      try {
        req = os.get(pending.bookKey);
      } catch (e) {
        ErrorBoundary.handle('storage', e, 'flushProgress:get');
        resolve(false);
        return;
      }
      req.onsuccess = () => {
        const rec = req.result;
        if (rec) {
          rec.percent    = pending.percent;
          rec.lastReadAt = pending.lastReadAt;
          try { os.put(rec); } catch (_) { /* tx가 이미 종료된 극단적 타이밍 — 무시 */ }
        }
      };
      req.onerror = () => {
        /* get 자체가 실패해도 트랜잭션은 oncomplete/onerror로 자연 종결된다 */
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror    = () => { ErrorBoundary.handle('storage', tx.error, 'flushProgress:tx'); resolve(false); };
      tx.onabort    = () => resolve(false);
    });
  },

  /**
   * 강제 즉시 커밋 (뷰어 종료 / beforeunload 시 잔여 버퍼 flush)
   * [버그 수정 — A-8] _flushProgress()의 완료(Promise)를 명시적으로 대기한다.
   * 호출부(destroyCurrentRenditionContext 등)가 await 하면, 실제 IndexedDB
   * 커밋이 끝난 뒤에야 다음 정리 단계(rendition.destroy 등)로 넘어간다.
   */
  async flushProgressNow() {
    clearTimeout(this._progressDebounceTimer);
    try {
      await this._flushProgress();
    } catch (e) {
      ErrorBoundary.handle('storage', e, 'flushProgressNow');
    }
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
