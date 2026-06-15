/**
 * src/main.js
 * ───────────────────────────────────────────────────────────────
 * 시스템 부트스트랩 + 오케스트레이션 (모듈 진입점)
 *
 * 역할:
 *   - 모든 모듈을 import 하고, reader.js에 UI 콜백을 주입(registerReaderDeps)
 *     하여 순환 의존성을 끊는다.
 *   - mountReactiveBinders : store 변화 → DOM 선언적 반영
 *   - initButtonEventHandlers : 전역 버튼/드래그/슬라이더 이벤트 바인딩
 *   - initializeSystemCore : SW 등록 · DB init · 전체 init 시퀀스
 *   - _bootstrapFable : 크래시 격리 진입점
 *
 * ※ Vite/PWA: 서비스 워커 등록은 vite-plugin-pwa(injectManifest)가
 *    빌드한 sw.js를 직접 register 한다.
 * ─────────────────────────────────────────────────────────────── */

'use strict';

import {
  store, ReactiveStore, DOMProxy, ErrorBoundary, Toast,
  setTextSafe, LH_MAP,
} from './store.js';
import { StorageSystem } from './database.js';
import { AnnotationSyncEngine } from './sync.js';
import {
  registerReaderDeps,
  openEpubBook, exitViewer, switchFlowMode,
  injectCustomToIframe, chapterAtPercent, seekToPercent,
  NavGuard, isEpubRuntimeReady, waitForEpubJS,
} from './reader.js';
import {
  HashWorker, refreshLibraryData, renderLibraryGrid, importEpubFiles,
} from './ui/uploader.js';
import {
  renderTocSidebar, updateTocActiveItem,
  ReadingStatsTracker, SearchEngine, VirtualSearchList, runSearchExecution,
  AnnotationManager, initContextMenu, TTSSystem, bindScrollTopButton,
  MetadataEditor, AnnotationExporter, LibraryFullTextSearch, CloudBackup, Pomodoro,
} from './ui/viewer.js';
import {
  initFontUploader, initFontSelector, initCustomThemeBuilder,
  showKeyboardHint, initOfflineBanner, _saveStateToLS, _loadStateFromLS,
} from './ui/settings.js';

/* ══════════════════════════════════════════════════════════
   환경 변수 Null-Safe 접근
   import.meta / import.meta.env 가 undefined인 컨텍스트에서도
   절대 throw 하지 않고 모드 문자열을 안전하게 반환한다.
   (기본값 'production' — 빌드 산출물 기준 안전측)
   ══════════════════════════════════════════════════════════ */
function _envMode() {
  try {
    if (typeof import.meta !== 'undefined' && import.meta && import.meta.env && import.meta.env.MODE) {
      return import.meta.env.MODE;
    }
  } catch (_) { /* import.meta 자체가 없는 환경 — 무시하고 폴백 */ }
  return 'production';
}

/* ══════════════════════════════════════════════════════════
   순환 의존성 차단 — reader.js에 UI 콜백 주입
   ══════════════════════════════════════════════════════════ */
registerReaderDeps({
  renderTocSidebar,
  updateTocActiveItem,
  ReadingStatsTracker,
  SearchEngine,
  VirtualSearchList,
  AnnotationManager,
  HashWorker,
  refreshLibraryData,
  handleKeyDown,
  bindScrollTopButton,
});

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

/* 커스텀 테마를 iframe 본문에 주입 (reader.js의 injectCustomToIframe 위임) */
function _injectCustomToIframe() {
  injectCustomToIframe();
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

/* ══════════════════════════════════════════════════════════
   §35b. [요구3] 퍼센트 위치 이동 (reader.js 위임)
   ══════════════════════════════════════════════════════════ */
function _chapterAtPercent(pct) { return chapterAtPercent(pct); }
function _seekToPercent(pct)     { return seekToPercent(pct); }

/* ══════════════════════════════════════════════════════════
   §36. 버튼 이벤트 전체 바인딩
   ══════════════════════════════════════════════════════════ */
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
   §37. 전역 진입점
   ══════════════════════════════════════════════════════════ */
async function initializeSystemCore() {
  /*
   * [B1 리팩토링] 비동기 런타임 가드 레이어
   * ───────────────────────────────────────────────────────────
   * 시스템 초기화는 epub.js 로드 여부와 '완전히 분리'하여 항상 기동.
   * 라이브러리는 백그라운드에서 최대 3초 재시도로 준비하고,
   * 실제 책을 열 때(openEpubBook/importEpubFiles) 시점에만
   * waitForEpubJS()로 가용성을 확인한다.
   *   → 라이브러리가 늦거나 실패해도 UI/이벤트는 절대 죽지 않음.
   */
  if (!isEpubRuntimeReady()) {
    console.info('[Fable] EPUB 엔진 백그라운드 로드 대기 중… (UI는 정상 기동)');
    waitForEpubJS(3000).then((ok) => {
      if (ok) {
        console.info('[Fable] EPUB 엔진 준비 완료.');
      } else {
        console.warn('[Fable] EPUB 엔진(또는 JSZip) 로드 실패 — 책 열기 시 안내됩니다.');
        Toast.show('EPUB 엔진 로딩이 지연되고 있습니다. 네트워크를 확인해 주세요.', 'info');
      }
    });
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

  /* PWA 서비스 워커 등록 (vite-plugin-pwa injectManifest 산출물) */
  if ('serviceWorker' in navigator) {
    try {
      /*
       * [버그 수정] import.meta.env.MODE 직접 접근 금지.
       * ───────────────────────────────────────────────────────
       * import.meta 또는 import.meta.env 가 undefined인 컨텍스트에서
       * .MODE 를 읽으면 "Cannot read properties of undefined (reading 'MODE')"
       * 로 크래시가 나면서 SW 등록은 물론 그 아래 초기화까지 사멸한다.
       * → _envMode() Null-Safe 가드로 안전하게 읽고, 프로덕션 빌드에서는
       *   항상 단일 './sw.js'(injectManifest 산출물)를 등록한다.
       */
      const isProd = _envMode() === 'production';
      const swUrl  = isProd ? './sw.js' : './dev-sw.js?dev-sw';
      const swType = isProd ? 'classic' : 'module';
      const reg = await navigator.serviceWorker.register(swUrl, { type: swType });
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

  console.log('\uD83D\uDCD6 Fable Premium v3.1 — Vite Modular Edition Initialized');
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

/*
 * 부트스트랩 — 크래시 격리 레이어
 * initializeSystemCore 내부에서 예기치 못한 예외가 나도 페이지 전체가
 * 죽지 않도록 try-catch로 감싸고, 실패 시 사용자에게 안내한다.
 */
function _bootstrapFable() {
  try {
    const ret = initializeSystemCore();
    /* async 함수의 reject도 잡아 전역 사멸 방지 */
    if (ret && typeof ret.catch === 'function') {
      ret.catch((err) => {
        console.error('[Fable] 초기화 비동기 오류:', err);
        try { Toast.show('초기화 중 일부 오류가 발생했습니다.', 'error'); } catch (_) {}
      });
    }
  } catch (err) {
    console.error('[Fable] 치명적 초기화 오류:', err);
    try { Toast.show('앱 초기화에 실패했습니다. 새로고침해 주세요.', 'error'); } catch (_) {}
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _bootstrapFable);
} else {
  _bootstrapFable();
}
