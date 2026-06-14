/**
 * Fable v3 — Service Worker (안정화 리팩토링)
 * ───────────────────────────────────────────────────────────────
 * 핵심 수정:
 *  1) install 단계에서 cache.addAll() 사용 금지.
 *     addAll은 목록 중 '단 하나라도' 실패하면 전체가 reject되어
 *     SW 설치 자체가 실패 → 정적 자원까지 캐시 안 됨 → 연쇄 404.
 *     따라서 자원별 개별 cache.add()로 처리하고 각각 catch하여
 *     CDN 1건 실패가 앱셸 전체를 무너뜨리지 않도록 격리한다.
 *  2) 외부 CDN(epub.js/JSZip)은 'best-effort'로 분리.
 *     설치 시 실패해도 무시하고, fetch 시 network-first로 처리하여
 *     잘못 캐시된 404 응답이 영구 고착되는 것을 방지한다.
 *  3) 로컬 동일 출처 자원만 cache-first, 그 외/CDN은 network-first.
 * ─────────────────────────────────────────────────────────────── */
'use strict';

const CACHE_VERSION = 'fable-v6-cache-v2';   /* 캐시 무효화를 위해 버전 상향 */
const FONT_CACHE    = 'fable-v3-fonts-v1';
const CDN_CACHE     = 'fable-v6-cdn-v1';     /* CDN 자원 전용 캐시 (앱셸과 분리) */
const SYNC_TAG      = 'fable-annotation-sync';

/* 반드시 캐시되어야 하는 '동일 출처' 핵심 앱셸 (실패 시에도 개별 격리) */
const LOCAL_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
];

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

    /* 로컬 앱셸: 개별 add + 개별 catch (1건 실패가 전체를 막지 않음) */
    await Promise.all(LOCAL_SHELL.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        console.warn('[SW] 로컬 앱셸 캐시 실패(무시):', url, err.message);
      }
    }));

    /* CDN 자원: best-effort. 실패해도 설치를 막지 않음 */
    const cdnCache = await caches.open(CDN_CACHE);
    await Promise.all(CDN_ASSETS.map(async (url) => {
      try {
        /* no-cors라도 응답을 받으면 캐시 시도 (opaque 허용) */
        const res = await fetch(url, { mode: 'cors' }).catch(() => fetch(url, { mode: 'no-cors' }));
        if (res && (res.ok || res.type === 'opaque')) await cdnCache.put(url, res.clone());
      } catch (err) {
        console.warn('[SW] CDN 자원 선캐시 실패(무시):', url, err.message);
      }
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

  /* 비-GET, 확장 프로그램, 비대상 요청은 SW가 손대지 않음 */
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

  /* CDN(epub.js/JSZip 등): network-first.
     잘못 캐시된 404가 고착되지 않도록 항상 네트워크를 먼저 시도하고,
     실패 시에만 캐시 폴백. 200/opaque 응답만 캐시에 갱신. */
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
    /* 200 또는 opaque(no-cors)만 캐시 갱신. 404/5xx는 캐시에 넣지 않음 */
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone()).catch(() => {});
      return res;
    }
    /* 비정상 응답이면 캐시 폴백 시도 */
    const cached = await cache.match(req);
    return cached || res;
  } catch (_) {
    /* 네트워크 실패 → 캐시 폴백 */
    const cached = await cache.match(req);
    if (cached) return cached;
    /* 폴백도 없으면 명확한 503 (앱은 자체 CDN 폴백 체인으로 재시도) */
    return new Response('', { status: 503, statusText: 'CDN unavailable' });
  }
}

async function cacheFirstLocal(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    /* 동일 출처 정상 응답만 캐시 */
    if (res && res.status === 200 && res.type === 'basic') {
      const clone = res.clone();
      caches.open(CACHE_VERSION).then(c => c.put(req, clone)).catch(() => {});
    }
    return res;
  } catch (_) {
    /* 내비게이션 요청 실패 시 앱셸로 폴백 (오프라인 SPA 보장) */
    if (req.mode === 'navigate') {
      const shell = await caches.match('./index.html');
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
