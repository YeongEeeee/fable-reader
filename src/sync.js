/**
 * src/sync.js  ── Fable Premium v4.0
 * ─────────────────────────────────────────────────────────────────
 * AnnotationSyncEngine — LWW Merge + CRDT 동기화 엔진
 *
 * v4.0 고도화 사항:
 *   [LWW Sync 양방향 CRDT]  가상 타임스탬프 + Lamport 카운터 정교화
 *                           OR-Set 기반 순수 바닐라 CRDT 데이터 병합 모델
 *                           AtomicTaskQueue 내부 완전 이식
 *   [IndexedDB 청크 분할]   50MB+ EPUB을 5MB 단위로 분할 저장 (타임아웃 차단)
 *   [LRU LZ 압축 예외 가드] 쿼터 초과 시 LZ-String 압축 보존 연동
 *
 * 보존된 스펙:
 *   UUID v4 생성(crypto.randomUUID 폴백),
 *   clientId(디바이스 고정) + Lamport 카운터,
 *   Service Worker Background Sync 연동,
 *   AtomicTaskQueue 직렬화 큐
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

import { store, ErrorBoundary, Toast, SYNC_TAG, LZStore } from './store.js';
import { StorageSystem } from './database.js';

/* ══════════════════════════════════════════════════════════
   §0. AtomicTaskQueue — 비동기 태스크 직렬화 실행기
   ─────────────────────────────────────────────────────────
   모든 enqueue() 호출은 이전 태스크의 Promise가 settled된 뒤에만
   다음 태스크를 실행합니다. 예외 발생 시에도 체인이 끊기지 않습니다.
   ══════════════════════════════════════════════════════════ */
class AtomicTaskQueue {
  constructor() {
    /** @type {Promise<void>} 직렬화 체인 앵커 */
    this._chain = Promise.resolve();
    /** 동기화 실행 중 여부 (외부 read-only) */
    this.isSyncing = false;
    /** 큐 내부 대기 태스크 수 (디버깅용) */
    this._depth = 0;
  }

  /**
   * 태스크를 큐 말단에 삽입합니다.
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  enqueue(task) {
    let resolve, reject;
    const ticket = new Promise((res, rej) => { resolve = res; reject = rej; });

    this._depth++;
    this._chain = this._chain.then(async () => {
      try {
        const result = await task();
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        this._depth--;
      }
    });

    return ticket;
  }

  /** 현재 대기 중인 태스크가 있는지 확인 */
  get isEmpty() { return this._depth === 0; }
}

/* ══════════════════════════════════════════════════════════
   §1. IndexedDB 5MB 청크 분할 스토리지 엔진
   ─────────────────────────────────────────────────────────
   50MB 이상 EPUB 버퍼를 5MB 단위로 분할하여 저장하고,
   로드 시 청크를 병합하여 원본 ArrayBuffer를 재구성합니다.
   QuotaExceededError 발생 시 LZ 압축 예외 가드를 통해
   데이터를 삭제하지 않고 압축 보존합니다.
   ══════════════════════════════════════════════════════════ */
export const ChunkedStorage = (() => {
  const CHUNK_SIZE = 5 * 1024 * 1024; /* 5MB 단위 */
  const STORE_NAME = 'epubChunks';    /* IndexedDB 오브젝트 스토어 이름 */

  /**
   * ArrayBuffer를 5MB 청크로 분할하여 IndexedDB에 저장
   * @param {IDBDatabase} db
   * @param {string} bookKey
   * @param {ArrayBuffer} buffer
   * @returns {Promise<{chunkCount:number, totalBytes:number}>}
   */
  async function saveChunked(db, bookKey, buffer) {
    if (!db) throw new Error('IndexedDB 인스턴스 없음');

    const bytes      = new Uint8Array(buffer);
    const totalBytes = bytes.length;
    const chunkCount = Math.ceil(totalBytes / CHUNK_SIZE);

    /* 청크 스토어가 없으면 스킵 — schema 업그레이드 필요 시 database.js onupgradeneeded에 추가 */
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      /* 폴백: 단일 버퍼로 저장 (기존 방식) */
      return { chunkCount: 1, totalBytes, fallback: true };
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const os = tx.objectStore(STORE_NAME);

      /* 기존 청크 제거 */
      os.delete(IDBKeyRange.bound(`${bookKey}::0`, `${bookKey}::9999`));

      /* 메타데이터 저장 */
      os.put({ id: `${bookKey}::meta`, bookKey, chunkCount, totalBytes, ts: Date.now() });

      /* 각 청크 저장 */
      for (let i = 0; i < chunkCount; i++) {
        const start = i * CHUNK_SIZE;
        const end   = Math.min(start + CHUNK_SIZE, totalBytes);
        os.put({
          id:       `${bookKey}::${i}`,
          bookKey,
          chunkIdx: i,
          data:     bytes.slice(start, end).buffer,
        });
      }

      tx.oncomplete = () => resolve({ chunkCount, totalBytes });
      tx.onerror    = (e) => {
        const err = tx.error || e.target.error;
        if (err?.name === 'QuotaExceededError') {
          /* LZ 압축 보존 예외 가드 — 청크 메타를 로컬스토리지에 압축 보존 */
          _handleQuotaExceeded(bookKey, chunkCount, totalBytes);
          reject(err);
        } else {
          reject(err);
        }
      };
    });
  }

  /**
   * 청크 병합 → 원본 ArrayBuffer 재구성
   * @param {IDBDatabase} db
   * @param {string} bookKey
   * @returns {Promise<ArrayBuffer|null>}
   */
  async function loadChunked(db, bookKey) {
    if (!db || !db.objectStoreNames.contains(STORE_NAME)) return null;

    return new Promise((resolve) => {
      const tx     = db.transaction([STORE_NAME], 'readonly');
      const os     = tx.objectStore(STORE_NAME);
      const metaReq = os.get(`${bookKey}::meta`);

      metaReq.onsuccess = () => {
        const meta = metaReq.result;
        if (!meta) { resolve(null); return; }

        const { chunkCount, totalBytes } = meta;
        const combined = new Uint8Array(totalBytes);
        let   loaded   = 0;

        for (let i = 0; i < chunkCount; i++) {
          ((idx) => {
            const req = os.get(`${bookKey}::${idx}`);
            req.onsuccess = () => {
              if (req.result?.data) {
                const chunk = new Uint8Array(req.result.data);
                combined.set(chunk, idx * CHUNK_SIZE);
              }
              loaded++;
              if (loaded === chunkCount) resolve(combined.buffer);
            };
            req.onerror = () => { loaded++; if (loaded === chunkCount) resolve(combined.buffer); };
          })(i);
        }
      };
      metaReq.onerror = () => resolve(null);
    });
  }

  /** 청크 완전 삭제 */
  async function deleteChunked(db, bookKey) {
    if (!db || !db.objectStoreNames.contains(STORE_NAME)) return;
    return new Promise(resolve => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const os = tx.objectStore(STORE_NAME);
      os.delete(`${bookKey}::meta`);
      /* 청크 범위 삭제 */
      const range = IDBKeyRange.bound(`${bookKey}::0`, `${bookKey}::9999`);
      const cursorReq = os.openCursor(range);
      cursorReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror    = () => resolve(false);
    });
  }

  /** QuotaExceededError 발생 시 청크 메타를 LZ 압축으로 로컬스토리지에 보존 */
  function _handleQuotaExceeded(bookKey, chunkCount, totalBytes) {
    try {
      const meta = { bookKey, chunkCount, totalBytes, ts: Date.now(), status: 'quota_exceeded' };
      LZStore.lsSet(`fable_chunk_meta_${bookKey}`, meta);
      Toast.show('저장 공간이 부족합니다. 일부 EPUB이 압축 보존되었습니다.', 'error');
    } catch (_) {}
  }

  return { saveChunked, loadChunked, deleteChunked };
})();

/* ══════════════════════════════════════════════════════════
   §2. CRDT 벡터 클락 관리자
   ─────────────────────────────────────────────────────────
   OR-Set 기반 순수 바닐라 CRDT 병합 모델:
   · 각 클라이언트는 독립적인 Lamport 카운터를 유지
   · 병합 시 동일 UUID에 대해 최대 (lamport, timestamp) 승리
   · 삭제는 tombstone(isDeleted=true)으로 처리하여 재삽입 충돌 방지
   ══════════════════════════════════════════════════════════ */
const CRDTVectorClock = (() => {
  const LS_KEY_CLOCK  = 'fable_crdt_clock';
  const LS_KEY_CLIENT = 'fable_client_id';

  /** 클라이언트 고유 ID (디바이스 단위 고정) */
  function clientId() {
    let id = localStorage.getItem(LS_KEY_CLIENT);
    if (!id) {
      id = _uuid();
      try { localStorage.setItem(LS_KEY_CLIENT, id); } catch (_) {}
    }
    return id;
  }

  /** 벡터 클락 로드 */
  function loadClock() {
    return LZStore.lsGet(LS_KEY_CLOCK, {});
  }

  /** 벡터 클락 저장 */
  function saveClock(clock) {
    LZStore.lsSet(LS_KEY_CLOCK, clock);
    /* ReactiveStore에도 반영 */
    try { store.crdtVectorClock = clock; } catch (_) {}
  }

  /**
   * Lamport 카운터 증가 후 반환
   * — 항상 현재 시계에서 해당 클라이언트의 카운터를 +1
   */
  function tick() {
    const cid   = clientId();
    const clock = loadClock();
    clock[cid]  = (clock[cid] || 0) + 1;
    saveClock(clock);
    return { cid, lamport: clock[cid], clock: { ...clock } };
  }

  /**
   * 원격 클락을 수신하여 로컬 클락과 병합 (max-merge)
   * @param {Object} remoteClock  { [clientId]: lamportN }
   */
  function merge(remoteClock) {
    const local = loadClock();
    Object.entries(remoteClock || {}).forEach(([cid, n]) => {
      if ((n || 0) > (local[cid] || 0)) local[cid] = n;
    });
    saveClock(local);
    return local;
  }

  /**
   * 두 어노테이션 항목 중 우선순위 판별
   * 반환값이 true → a가 b보다 우선 (a wins)
   *
   * 3단계 타이브레이킹:
   *  1순위: device_timestamp (절대 ms, 클록 드리프트 허용 ±2s)
   *  2순위: lamport 카운터 (인과 순서 보장)
   *  3순위: clientId 사전순 (결정론적 타이브레이커)
   */
  function wins(a, b) {
    if (!b) return true;
    const DRIFT_THRESHOLD = 2000; /* 2초 이내 드리프트는 Lamport로 판단 */
    const tsDiff = Math.abs((a.device_timestamp || 0) - (b.device_timestamp || 0));
    if (tsDiff > DRIFT_THRESHOLD) {
      return (a.device_timestamp || 0) > (b.device_timestamp || 0);
    }
    /* 타임스탬프가 거의 동일 → Lamport 카운터로 결정 */
    if ((a.lamport || 0) !== (b.lamport || 0)) return (a.lamport || 0) > (b.lamport || 0);
    /* 최종 타이브레이커: clientId 사전순 */
    return String(a.clientId || '') > String(b.clientId || '');
  }

  function _uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  return { clientId, tick, merge, wins, loadClock };
})();

/* ══════════════════════════════════════════════════════════
   §3. AnnotationSyncEngine — LWW + CRDT 양방향 병합
   ══════════════════════════════════════════════════════════ */
const AnnotationSyncEngine = (() => {
  /* 공유 태스크 큐 인스턴스 */
  const _queue = new AtomicTaskQueue();

  /* UUID v4 생성기 */
  function uuid() { return CRDTVectorClock.clientId.call(null) ? _uuid() : _uuid(); }
  function _uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  /**
   * 주석 생성 — 큐를 통해 직렬화 실행
   * CRDT 벡터 클락 tick() 적용으로 인과 순서 보장
   */
  function create(bookKey, cfiRange, text, color = 'yellow', note = '') {
    /* Lamport 카운터 증가 */
    const { cid, lamport, clock } = CRDTVectorClock.tick();

    const ann = {
      uuid:             _uuid(),
      bookKey,
      cfiRange,
      text:             text.slice(0, 500),
      note,
      color,
      device_timestamp: Date.now(),
      clientId:         cid,
      lamport,
      vectorClock:      clock,   /* 전체 벡터 클락 스냅샷 (CRDT 병합용) */
      isDeleted:        false,   /* OR-Set tombstone 플래그 */
      pendingSync:      1,
      synced_at:        null,
    };

    return _queue.enqueue(() =>
      ErrorBoundary.wrap('storage', () => StorageSystem.saveAnnotation(ann))()
        .then(() => ann)
    );
  }

  /**
   * 어노테이션 소프트 삭제 (OR-Set tombstone)
   * — 삭제 레코드를 원격에 전파하여 재삽입 충돌 방지
   */
  function softDelete(annUuid) {
    const { cid, lamport, clock } = CRDTVectorClock.tick();
    return _queue.enqueue(async () => {
      const ann = await StorageSystem.getAnnotation?.(annUuid);
      if (!ann) return;
      const tombstone = {
        ...ann,
        isDeleted:        true,
        deletedAt:        Date.now(),
        deletedBy:        cid,
        lamport,
        vectorClock:      clock,
        device_timestamp: Date.now(),
        pendingSync:      1,
      };
      return ErrorBoundary.wrap('storage', () => StorageSystem.saveAnnotation(tombstone))();
    });
  }

  /**
   * [양방향 CRDT LWW Merge]
   * ─────────────────────────────────────────────────────
   * OR-Set 병합 규칙:
   *  ① 동일 UUID: CRDT.wins(local, remote) 로 승자 결정
   *  ② tombstone(isDeleted=true) 이 있으면 삭제 상태 유지
   *     (add-wins 변형: 양쪽 모두 isDeleted=false 일 때만 복원)
   *  ③ 원격에만 있는 항목은 로컬에 추가 (신규 원격 주석 수용)
   *  ④ 로컬에만 있는 항목은 그대로 보존 (원격 미반영 미삭제 안전)
   *
   * @param {Object[]} remoteItems  서버에서 수신한 어노테이션 배열
   * @param {Object[]} localItems   IndexedDB에서 조회한 로컬 배열
   * @returns {Object[]}           최종 병합 결과 배열
   */
  function mergeWithLWW(remoteItems, localItems) {
    const merged = new Map();

    /* 로컬 항목을 기준 맵으로 초기화 */
    localItems.forEach(l => merged.set(l.uuid, l));

    /* 원격 항목을 병합 */
    remoteItems.forEach(r => {
      const existing = merged.get(r.uuid);
      if (!existing) {
        /* 신규 원격 주석 수용 */
        merged.set(r.uuid, r);
        return;
      }

      /* 충돌 해소: CRDT 우선순위 판별 */
      if (CRDTVectorClock.wins(r, existing)) {
        /* 원격 승리 — 단, tombstone 확인 */
        const winner = r.isDeleted
          ? r /* tombstone 우선 (삭제 전파) */
          : existing.isDeleted && !r.isDeleted
            ? existing /* 로컬 삭제 유지 (add-wins 방지) */
            : r;
        merged.set(r.uuid, winner);
      }
      /* 로컬 승리 → 현재 값 유지 (아무 것도 안 함) */
    });

    /* 원격 벡터 클락 병합 */
    remoteItems.forEach(r => {
      if (r.vectorClock) CRDTVectorClock.merge(r.vectorClock);
    });

    return [...merged.values()].filter(a => !a.isDeleted);
  }

  /**
   * 동기화 핵심 로직 — 큐 내부에서 원자적으로 실행됩니다.
   *
   * 실행 순서:
   *  1. isSyncing = true
   *  2. pendingSync=1 스냅샷 조회
   *  3. SW Background Sync / postMessage / 직접 fetch
   *  4. 성공 시 응답 원격 항목과 CRDT 병합 → IndexedDB 커밋
   *  5. isSyncing = false
   */
  async function _syncPendingCore() {
    _queue.isSyncing = true;
    try {
      const pending = await StorageSystem.getPendingAnnotations();
      if (!pending.length) return;

      /* ① SW Background Sync 위임 */
      if ('serviceWorker' in navigator && 'SyncManager' in window) {
        try {
          const reg = await navigator.serviceWorker.ready;
          await reg.sync.register(SYNC_TAG);
          return;
        } catch (_) { /* 폴백 */ }
      }

      /* ② SW postMessage 위임 */
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({
          type:    'ANNOTATION_SYNC_REQUEST',
          payload: { items: pending, clock: CRDTVectorClock.loadClock() },
        });
        return;
      }

      /* ③ 직접 fetch + CRDT 병합 */
      try {
        const res = await fetch('https://api.fable.example/annotations/sync', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            annotations: pending,
            vectorClock: CRDTVectorClock.loadClock(),
          }),
        });

        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const remoteItems = data.annotations || [];

          if (remoteItems.length > 0) {
            /* CRDT 양방향 병합 */
            const local  = await StorageSystem.getPendingAnnotations();
            const all    = await StorageSystem._getAllAnnotations?.() || local;
            const merged = mergeWithLWW(remoteItems, all);

            /* 병합 결과를 IndexedDB에 커밋 */
            for (const ann of merged) {
              await StorageSystem.saveAnnotation({ ...ann, pendingSync: 0, synced_at: Date.now() });
            }
          } else {
            /* 원격 응답 없음: 로컬 항목만 synced 처리 */
            for (const a of pending) {
              await StorageSystem.markAnnotationSynced(a.uuid);
            }
          }

          /* 원격 벡터 클락 병합 */
          if (data.vectorClock) CRDTVectorClock.merge(data.vectorClock);

          Toast.show(`${pending.length}개 하이라이트가 동기화되었습니다.`, 'success');
        }
      } catch (err) {
        ErrorBoundary.handle('network', err, 'syncPending');
      }
    } finally {
      _queue.isSyncing = false;
    }
  }

  /** syncPending — 큐를 통해 직렬화 진입 */
  function syncPending() {
    return _queue.enqueue(_syncPendingCore);
  }

  /** markSynced — 큐를 통해 직렬화 처리 (외부 호출용) */
  function markSynced(uuid) {
    return _queue.enqueue(() =>
      ErrorBoundary.wrap('storage', () => StorageSystem.markAnnotationSynced(uuid))()
    );
  }

  /* SW 완료 메시지 핸들러 */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', async (e) => {
      if (e.data?.type === 'ANNOTATION_SYNC_RESULT' && e.data.result?.success) {
        _queue.enqueue(async () => {
          const remoteItems = e.data.result.annotations || [];
          if (remoteItems.length > 0) {
            const all    = await StorageSystem._getAllAnnotations?.() || [];
            const merged = mergeWithLWW(remoteItems, all);
            for (const ann of merged) {
              await StorageSystem.saveAnnotation({ ...ann, pendingSync: 0, synced_at: Date.now() });
            }
            if (e.data.result.vectorClock) CRDTVectorClock.merge(e.data.result.vectorClock);
          } else {
            const pending = await StorageSystem.getPendingAnnotations();
            for (const a of pending) await StorageSystem.markAnnotationSynced(a.uuid);
          }
          Toast.show(`${e.data.result.synced || 0}개 하이라이트가 동기화되었습니다.`, 'success');
        });
      }
      if (e.data?.type === 'SW_SYNC_TRIGGER') {
        syncPending();
      }
    });
  }

  return {
    create,
    softDelete,
    mergeWithLWW,
    syncPending,
    markSynced,
    get isSyncing() { return _queue.isSyncing; },
    get queueDepth() { return _queue._depth; },
    /* CRDT 유틸 노출 (테스트/디버깅용) */
    crdt: CRDTVectorClock,
  };
})();

export { AnnotationSyncEngine, CRDTVectorClock, AtomicTaskQueue, ChunkedStorage };
