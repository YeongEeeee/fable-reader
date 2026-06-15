/**
 * src/sync.js
 * ───────────────────────────────────────────────────────────────
 * AnnotationSyncEngine — LWW Merge 기반 백그라운드 동기화 엔진
 *
 * 보존된 스펙:
 *   - UUID v4 생성 (crypto.randomUUID 폴백)
 *   - [2]-11 벡터 시계: clientId(디바이스 고정) + Lamport 카운터
 *   - LWW Merge: device_timestamp → lamport → clientId 타이브레이커
 *   - Service Worker Background Sync 연동 (SyncManager / postMessage 폴백)
 * ─────────────────────────────────────────────────────────────── */

'use strict';

import { store, ErrorBoundary, Toast, SYNC_TAG } from './store.js';
import { StorageSystem } from './database.js';

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


export { AnnotationSyncEngine };
