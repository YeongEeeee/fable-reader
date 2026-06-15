import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Fable Premium — Vite 설정
 * ───────────────────────────────────────────────────────────────
 * - 순수 바닐라 ES Modules. 프레임워크 런타임 오버헤드 없음.
 * - epub.js(0.3.93)는 전역 window.JSZip을 요구하는 UMD 빌드이므로,
 *   번들러가 트리셰이킹/인터롭으로 깨뜨리지 않도록 main.js에서
 *   'jszip' → window.JSZip 전역 주입 후 'epubjs'를 동적 import 한다.
 *   (reader.js의 ensureEpubRuntime() 참조)
 * - PWA 플러그인은 injectManifest 전략으로 기존에 안정화한
 *   커스텀 서비스 워커(src/sw.js)를 그대로 사용한다.
 *   (generateSW가 아니라 우리가 작성한 캐싱/네트워크 폴백 로직 보존)
 */
export default defineConfig({
  base: './',

  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        /* epub.js / jszip을 별도 청크로 분리해 초기 페이로드 최적화 */
        manualChunks: {
          epub: ['epubjs'],
          jszip: ['jszip'],
        },
      },
    },
  },

  /* epub.js UMD 인터롭 — CommonJS 의존성 사전 번들 */
  optimizeDeps: {
    include: ['epubjs', 'jszip'],
  },

  plugins: [
    VitePWA({
      /* 커스텀 SW를 그대로 주입 (자체 안정화 캐싱 로직 보존) */
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'autoUpdate',
      injectRegister: null, /* 등록은 main.js에서 직접 수행 */

      injectManifest: {
        /* 프리캐시 대상 — 로컬 빌드 산출물만 (CDN은 SW 런타임에서 best-effort) */
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },

      manifest: {
        name: 'Fable Premium',
        short_name: 'Fable',
        description: '순수 바닐라 JS 기반 Folio 스타일 EPUB 리더',
        theme_color: '#fcfbf7',
        background_color: '#fcfbf7',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },

      devOptions: {
        enabled: false, /* 개발 중 SW 비활성화 (HMR 충돌 방지) */
      },
    }),
  ],

  server: {
    port: 5173,
    open: true,
  },

  preview: {
    port: 4173,
  },
});
