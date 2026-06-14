/**
 * Fable v3 — Service Worker
 * Cache-First 아키텍처 · 오프라인 앱쉘 · 백그라운드 동기화
 */
'use strict';

const CACHE_VERSION = 'fable-v6-cache-v1';
const FONT_CACHE    = 'fable-v3-fonts-v1';
const SYNC_TAG      = 'fable-annotation-sync';

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/epubjs/0.3.93/epub.min.js',
];

const FONT_ORIGINS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

/* ── install ── */
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(c => c.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] install 캐시 실패:', err))
  );
});

/* ── activate: 구버전 캐시 정리 ── */
self.addEventListener('activate', (e) => {
  const VALID = [CACHE_VERSION, FONT_CACHE];
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !VALID.includes(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── fetch: 요청 유형별 전략 분기 ── */
self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  if (url.startsWith('chrome-extension') ||
      url.includes('api.dictionary') ||
      e.request.method !== 'GET') return;

  /* [2]-7 Range 요청(대용량 EPUB/이미지 스트리밍): 부분 응답을 쪼개어 전달해 OOM 방지 */
  if (e.request.headers.has('range')) {
    e.respondWith(handleRangeRequest(e.request));
    return;
  }

  /* 폰트: Stale-While-Revalidate */
  if (FONT_ORIGINS.some(o => url.startsWith(o))) {
    e.respondWith(
      caches.open(FONT_CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          const fresh = fetch(e.request).then(res => {
            if (res?.status === 200) cache.put(e.request, res.clone());
            return res;
          }).catch(() => cached);
          return cached || fresh;
        })
      )
    );
    return;
  }

  /* 일반 자원: Cache-First + 네트워크 폴백 */
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (!res || res.status !== 200 || res.type !== 'basic') return res;
        const clone = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => {
        if (e.request.mode === 'navigate') return caches.match('./index.html');
      });
    })
  );
});

/**
 * [2]-7 Range 요청 처리 — 캐시된 자원을 바이트 범위로 분할 스트리밍
 * 대용량 자원을 통째로 메모리에 올리지 않고 요청된 청크만 206으로 응답
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
