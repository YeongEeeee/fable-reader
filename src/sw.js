/**
 * src/sw.js
 * ───────────────────────────────────────────────────────────────
 * Fable Premium — Custom Service Worker (injectManifest)
 * * 역할:
 * - VitePWA가 빌드 시 `self.__WB_MANIFEST` 위치에 프리캐시 자산 주입
 * - 오프라인 상태에서도 리더(UI, JSZip, EpubJS 청크)가 정상 구동되도록 보장
 * - 하이라이트/주석 백그라운드 동기화(SYNC_TAG) 처리
 * ─────────────────────────────────────────────────────────────── */

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { StaleWhileRevalidate, CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

// 1. Vite가 빌드한 정적 자산 자동 프리캐싱 바인딩
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST || []);

// 2. 외부 폰트 및 고정 CDN 자원 런타임 캐싱 (CacheFirst)
registerRoute(
  ({ url }) => url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'fable-external-fonts',
    plugins: [
      new ExpirationPlugin({ maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 30 }), // 30일 보존
    ],
  })
);

// 3. 일반 웹 요청 정책 (StaleWhileRevalidate)
registerRoute(
  ({ request }) => request.mode === 'navigate' || request.destination === 'script' || request.destination === 'style',
  new StaleWhileRevalidate({
    cacheName: 'fable-runtime-assets',
  })
);

// 4. 서비스 워커 생명주기 제어
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// 5. 독서 데이터 / 주석 백그라운드 동기화 (LWW Sync Engine 연동)
const SYNC_TAG = 'fable-annotation-sync';

self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(executeBackgroundSync());
  }
});

// 백그라운드 동기화 실제 처리 (네트워크가 복구되었을 때 호출됨)
async function executeBackgroundSync() {
  try {
    // 런타임에 클라이언트를 찾아 동기화 트리거 메시지 송신 또는 직접 fetch
    const clients = await self.clients.matchAll();
    for (const client of clients) {
      client.postMessage({ type: 'SW_SYNC_TRIGGER' });
    }
  } catch (err) {
    console.error('[SW] 백그라운드 동기화 실패:', err);
  }
}

// 앱 메시지 수신 인터페이스
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});