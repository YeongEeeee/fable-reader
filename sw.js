/**
 * src/sw.js — Fable Premium 서비스 워커 (Vite injectManifest 대응)
 * ───────────────────────────────────────────────────────────────
 * vite-plugin-pwa(injectManifest)가 self.__WB_MANIFEST에 빌드 산출물
 * 프리캐시 목록을 주입한다. 그 목록을 로컬 앱셸 캐시에 개별 등록하고,
 * 기존에 안정화한 네트워크 전략(개별 캐싱 / CDN network-first /
 * 폰트 SWR / Range 스트리밍)을 그대로 유지한다.
 *
 * 핵심 안정화 스펙 보존:
 *   - addAll 금지 → 개별 cache.put (1건 실패가 전체 설치를 막지 않음)
 *   - CDN(epub.js/JSZip) network-first + 별도 캐시 (404 고착 방지)
 *   - 로컬 자원 cache-first, 네비게이션 오프라인 폴백
 *   - 대용량 EPUB Range 206 스트리밍
 *   - LWW 백그라운드 동기화 메시지/Background Sync
 * ─────────────────────────────────────────────────────────────── */

'use strict';

/* injectManifest 주입 지점 — 빌드 시 프리캐시 매니페스트가 삽입됨 */
const PRECACHE_MANIFEST = self.__WB_MANIFEST || [];

const CACHE_VERSION = 'fable-v6-cache-v2';
const FONT_CACHE    = 'fable-v3-fonts-v1';
const CDN_CACHE     = 'fable-v6-cdn-v1';
const SYNC_TAG      = 'fable-annotation-sync';

/* best-effort 외부 CDN 자원 (설치 실패해도 앱 기동에 영향 없음) */
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js',
];

const FONT_ORIGINS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

const CDN_ORIGINS = [
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
];

/* ── install: 개별 캐싱 (addAll 금지) ── */
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);

    /* Vite 프리캐시 매니페스트(로컬 빌드 산출물) 개별 등록 */
    const urls = PRECACHE_MANIFEST.map(entry => (typeof entry === 'string' ? entry : entry.url));
    await Promise.all(urls.map(async (url) => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (err) { console.warn('[SW] 로컬 앱셸 캐시 실패(무시):', url, err.message); }
    }));

    /* CDN 자원: best-effort. 실패해도 설치를 막지 않음 */
    const cdnCache = await caches.open(CDN_CACHE);
    await Promise.all(CDN_ASSETS.map(async (url) => {
      try {
        const res = await fetch(url, { mode: 'cors' }).catch(() => fetch(url, { mode: 'no-cors' }));
        if (res && (res.ok || res.type === 'opaque')) await cdnCache.put(url, res.clone());
      } catch (err) { console.warn('[SW] CDN 자원 선캐시 실패(무시):', url, err.message); }
    }));

    await self.skipWaiting();
  })());
});

/* ── activate: 구버전 캐시 정리 ── */
self.addEventListener('activate', (e) => {
  const VALID = [CACHE_VERSION, FONT_CACHE, CDN_CACHE];
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !VALID.includes(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* ── fetch: 출처/유형별 전략 분기 ── */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = req.url;

  if (req.method !== 'GET' || url.startsWith('chrome-extension') || url.includes('api.dictionary')) return;

  /* Range 요청(대용량 EPUB/이미지): 부분 스트리밍 */
  if (req.headers.has('range')) {
    e.respondWith(handleRangeRequest(req));
    return;
  }

  /* 폰트: Stale-While-Revalidate */
  if (FONT_ORIGINS.some(o => url.startsWith(o))) {
    e.respondWith(staleWhileRevalidate(req, FONT_CACHE));
    return;
  }

  /* CDN(epub.js/JSZip 등): network-first (404 고착 방지) */
  if (CDN_ORIGINS.some(o => url.startsWith(o))) {
    e.respondWith(networkFirstCDN(req));
    return;
  }

  /* 동일 출처(로컬) 자원: cache-first + 네트워크 폴백 */
  e.respondWith(cacheFirstLocal(req));
});

/* ── 전략 구현 ── */

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const fresh = fetch(req).then(res => {
    if (res && res.status === 200) cache.put(req, res.clone());
    return res;
  }).catch(() => cached);
  return cached || fresh;
}

async function networkFirstCDN(req) {
  const cache = await caches.open(CDN_CACHE);
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone()).catch(() => {});
      return res;
    }
    const cached = await cache.match(req);
    return cached || res;
  } catch (_) {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response('', { status: 503, statusText: 'CDN unavailable' });
  }
}

async function cacheFirstLocal(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.status === 200 && res.type === 'basic') {
      const clone = res.clone();
      caches.open(CACHE_VERSION).then(c => c.put(req, clone)).catch(() => {});
    }
    return res;
  } catch (_) {
    if (req.mode === 'navigate') {
      const shell = await caches.match('./index.html') || await caches.match('index.html');
      if (shell) return shell;
    }
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

/**
 * Range 요청 처리 — 캐시/네트워크 자원을 바이트 범위로 분할 스트리밍
 */
async function handleRangeRequest(request) {
  const rangeHeader = request.headers.get('range');
  let cached = await caches.match(request.url);
  if (!cached) {
    try { cached = await fetch(request.url); } catch (_) { return new Response(null, { status: 502 }); }
  }
  if (!cached || !cached.ok) return cached || new Response(null, { status: 416 });

  const buf = await cached.arrayBuffer();
  const total = buf.byteLength;
  const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
  if (!m) return new Response(buf, { status: 200 });

  const start = parseInt(m[1], 10);
  const end   = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
  if (start >= total) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });

  const chunk = buf.slice(start, end + 1);
  return new Response(chunk, {
    status: 206,
    headers: {
      'Content-Range':  `bytes ${start}-${end}/${total}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': String(chunk.byteLength),
    },
  });
}

/* ── message ── */
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data?.type === 'ANNOTATION_SYNC_REQUEST') {
    handleAnnotationSync(e.data.payload).then(result => {
      e.source?.postMessage({ type: 'ANNOTATION_SYNC_RESULT', result });
    });
  }
});

/* ── sync: Background Sync ── */
self.addEventListener('sync', (e) => {
  if (e.tag === SYNC_TAG) {
    e.waitUntil(processPendingSyncFromSW());
  }
});

/* ── push ── */
self.addEventListener('push', (e) => {
  const data  = e.data?.json() ?? {};
  const title = data.title || 'Fable';
  const body  = data.body  || '독서 알림이 도착했습니다.';
  e.waitUntil(
    self.registration.showNotification(title, { body }).catch(() => {})
  );
});

async function processPendingSyncFromSW() {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach(c => c.postMessage({ type: 'SW_SYNC_TRIGGER' }));
}

async function handleAnnotationSync(payload) {
  if (!payload?.items?.length) return { success: true, synced: 0 };
  const REMOTE_ENDPOINT = 'https://api.fable.example/annotations/sync';
  try {
    const res = await fetch(REMOTE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ annotations: payload.items }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return { success: true, synced: json.synced ?? payload.items.length };
  } catch (err) {
    console.warn('[SW] 동기화 실패:', err.message);
    return { success: false, error: err.message };
  }
}
