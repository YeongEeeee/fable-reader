/**
 * src/main.js  ── Fable Premium v4.0
 * ───────────────────────────────────────────────────────────────────
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
 * 변경 사항 (v4.0):
 *   - ReactiveStore.subscribe('measuredWpm') → stat-wpm DOM 업데이트
 *   - ReactiveStore.subscribe('fontWeightBoost'/'contrastScale') → reapplyInlineTheme
 *   - ReactiveStore.subscribe('pageTransition') → store 싱크
 *   - ReactiveStore.subscribe('eyeProtectMinutes') → EyeProtectTimer 재설정
 *   - scrubberHoverPct: 스크러버 hover 시 챕터/페이지 툴팁 HUD 바인딩
 *   - btn-eye-protect / btn-auto-scroll / btn-page-transition 신규 버튼 바인딩
 *   - OnboardingGuide.start() 최초 진입 시 호출
 *   - imports: ReadingReport, OnboardingGuide, EyeProtectTimer, AutoScrollDriver, WPMTracker 추가
 *   - initV4SettingsUI() 호출
 * ───────────────────────────────────────────────────────────────────
 */

'use strict';

import {
  store, ReactiveStore, DOMProxy, ErrorBoundary, Toast,
  setTextSafe, LH_MAP,
} from './store.js';
import {
  LoadingOverlay, ResizeMask, ImportProgress,
  showViewerScreen, showUploaderScreen,
} from './ui.js';
import { StorageSystem } from './database.js';
import { AnnotationSyncEngine } from './sync.js';
import {
  registerReaderDeps,
  openEpubBook, exitViewer, switchFlowMode,
  injectCustomToIframe, reapplyInlineTheme, chapterAtPercent, seekToPercent,
  NavGuard, isEpubRuntimeReady, waitForEpubJS,
  EyeProtectTimer, AutoScrollDriver, WPMTracker,
} from './reader.js';
import {
  HashWorker, refreshLibraryData, renderLibraryGrid, importEpubFiles,
} from './ui/uploader.js';
import {
  renderTocSidebar, updateTocActiveItem,
  ReadingStatsTracker, SearchEngine, VirtualSearchList, runSearchExecution,
  AnnotationManager, initContextMenu, TTSSystem, bindScrollTopButton,
  MetadataEditor, AnnotationExporter, LibraryFullTextSearch, CloudBackup, Pomodoro,
  ReadingReport, OnboardingGuide,
} from './ui/viewer.js';
import {
  initFontUploader, initFontSelector, initCustomThemeBuilder,
  initV4SettingsUI,
  showKeyboardHint, initOfflineBanner, _saveStateToLS, _loadStateFromLS,
} from './ui/settings.js';

/* ══════════════════════════════════════════════════════════════════
   환경 변수 Null-Safe 접근
   import.meta / import.meta.env 가 undefined인 컨텍스트에서도
   절대 throw 하지 않고 모드 문자열을 안전하게 반환한다.
   ══════════════════════════════════════════════════════════════════ */
function _envMode() {
  try {
    if (typeof import.meta !== 'undefined' && import.meta && import.meta.env && import.meta.env.MODE) {
      return import.meta.env.MODE;
    }
  } catch (_) { /* import.meta 자체가 없는 환경 — 무시하고 폴백 */ }
  return 'production';
}

/* ══════════════════════════════════════════════════════════════════
   순환 의존성 차단 — reader.js에 UI 콜백 주입
   ══════════════════════════════════════════════════════════════════ */
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

/* ══════════════════════════════════════════════════════════════════
   §13. Reactive UI Binders
   store 변화 → DOM 선언적 반영
   ══════════════════════════════════════════════════════════════════ */
function mountReactiveBinders() {

  ReactiveStore.subscribe('theme', (theme) => {
    if (theme === 'paper' || theme === 'custom') document.body.removeAttribute('data-theme');
    else document.body.setAttribute('data-theme', theme);

    if (store.rendition) {
      requestAnimationFrame(() => {
        try { store.rendition.themes.select(theme === 'custom' ? 'custom' : theme); }
        catch (e) { ErrorBoundary.handle('renderer', e, 'theme:select'); }
        /* [버그 3B] 인라인 테마 재주입 — 해시 CSS 의존 없이 즉시 반영 */
        reapplyInlineTheme();
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
      reapplyInlineTheme();
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
        reapplyInlineTheme();
      });
    }
  });

  ReactiveStore.subscribe('flow', (flow) => {
    DOMProxy.qa('[data-flow]').forEach(b => {
      const ok = b.dataset.flow === flow;
      b.classList.toggle('active', ok); b.setAttribute('aria-checked', String(ok));
    });
    if (DOMProxy.exists('btn-scroll-top'))
      DOMProxy.get('btn-scroll-top').style.display = flow === 'scrolled' ? 'flex' : 'none';
  });

  ReactiveStore.subscribe('navBarsVisible', (visible) => {
    if (DOMProxy.exists('viewer-nav-bar'))
      DOMProxy.get('viewer-nav-bar').classList.toggle('nav-hidden', !visible);
    if (DOMProxy.exists('viewer-bottom-bar'))
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
    const btnV  = DOMProxy.get('btn-settings-toggle');
    const btnL  = DOMProxy.get('btn-library-settings');

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

  ReactiveStore.subscribe('userBg',      (v) => { document.documentElement.style.setProperty('--color-user-bg', v);              _injectCustomToIframe(); });
  ReactiveStore.subscribe('userInk',     (v) => { document.documentElement.style.setProperty('--color-user-ink', v);             _injectCustomToIframe(); });
  ReactiveStore.subscribe('userSpacing', (v) => { document.documentElement.style.setProperty('--user-letter-spacing', v + 'em'); _injectCustomToIframe(); });
  ReactiveStore.subscribe('userLeading', (v) => { document.documentElement.style.setProperty('--user-line-height', String(v));   _injectCustomToIframe(); });

  /* [v5] 서재 데이터 상태 → 그리드 자동 재렌더 (Reactive 일관성) */
  ReactiveStore.subscribe('libraryBooks',   () => renderLibraryGrid());
  ReactiveStore.subscribe('folders',        () => renderLibraryGrid());
  ReactiveStore.subscribe('activeFolderId', () => renderLibraryGrid());
  ReactiveStore.subscribe('activeTags',     () => renderLibraryGrid());
  ReactiveStore.subscribe('sortMode',       () => renderLibraryGrid());
  ReactiveStore.subscribe('librarySearch',  () => renderLibraryGrid());
  ReactiveStore.subscribe('readingLog',     () => { /* 대시보드는 grid 렌더 시 함께 갱신 */ });

  /* ── [v4.0] 신규 Reactive 바인더 ── */

  /**
   * measuredWpm — stat-wpm DOM 업데이트
   * WPMTracker가 IQR 필터 후 store에 기록 → UI 자동 반영
   */
  ReactiveStore.subscribe('measuredWpm', (wpm) => {
    if (DOMProxy.exists('stat-wpm'))
      setTextSafe(DOMProxy.get('stat-wpm'), `${wpm} WPM`);
    /* 자동 스크롤 속도도 즉시 갱신 */
    AutoScrollDriver.updateSpeed();
  });

  /**
   * fontWeightBoost / contrastScale — E-Ink 보정 즉시 반영
   * settings.js 슬라이더 → store 변화 → iframe 재주입
   */
  ReactiveStore.subscribe('fontWeightBoost', () => {
    if (store.rendition) requestAnimationFrame(() => reapplyInlineTheme());
  });
  ReactiveStore.subscribe('contrastScale', () => {
    if (store.rendition) requestAnimationFrame(() => reapplyInlineTheme());
  });

  /**
   * pageTransition — 선택값 스토어 동기화 (settings.js 바인딩과 상보)
   */
  ReactiveStore.subscribe('pageTransition', (v) => {
    /* data-transition 버튼 그룹 최신화 */
    DOMProxy.qa('[data-transition]').forEach(b => {
      b.classList.toggle('active', b.dataset.transition === v);
      b.setAttribute('aria-checked', String(b.dataset.transition === v));
    });
  });

  /**
   * eyeProtectMinutes — EyeProtectTimer가 이미 활성 중이면 재시작
   * (설정 변경 즉시 새 시간 적용)
   */
  ReactiveStore.subscribe('eyeProtectMinutes', () => {
    if (store.eyeProtectActive) {
      EyeProtectTimer.stop();
      EyeProtectTimer.start();
    }
  });

  /**
   * autoScrollActive — 버튼 활성 상태 시각 피드백
   */
  ReactiveStore.subscribe('autoScrollActive', (active) => {
    if (DOMProxy.exists('btn-auto-scroll')) {
      DOMProxy.get('btn-auto-scroll').classList.toggle('active', active);
      DOMProxy.get('btn-auto-scroll').setAttribute('aria-pressed', String(active));
    }
  });

  /**
   * eyeProtectActive — 버튼 활성 상태 시각 피드백
   */
  ReactiveStore.subscribe('eyeProtectActive', (active) => {
    if (DOMProxy.exists('btn-eye-protect')) {
      DOMProxy.get('btn-eye-protect').classList.toggle('active', active);
      DOMProxy.get('btn-eye-protect').setAttribute('aria-pressed', String(active));
    }
  });
}

/* 커스텀 테마를 iframe 본문에 주입 (reader.js의 injectCustomToIframe 위임) */
function _injectCustomToIframe() {
  injectCustomToIframe();
}

/* ══════════════════════════════════════════════════════════════════
   §32. 키보드 단축키
   ══════════════════════════════════════════════════════════════════ */
function handleKeyDown(e) {
  const viewer = DOMProxy.get('screen-viewer');
  if (!DOMProxy.exists('screen-viewer') || viewer.style.display === 'none') return;
  if (!store.rendition) return;
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case ' ':        e.preventDefault(); NavGuard.next(); break;
    case 'ArrowLeft':  case 'ArrowUp':  case 'Backspace': e.preventDefault(); NavGuard.prev(); break;
    case 'Escape':
      if (store.isSettingsOpen) { store.isSettingsOpen = false; break; }
      if (store.isTocOpen)      { store.isTocOpen      = false; break; }
      if (confirm('뷰어를 닫고 서재로 돌아가시겠습니까?')) exitViewer(); break;
    /* [v4.0] 검색 팝업 Esc 처리 */
    default: break;
  }
}

/* ══════════════════════════════════════════════════════════════════
   §35b. [요구3] 퍼센트 위치 이동 (reader.js 위임)
   ══════════════════════════════════════════════════════════════════ */
function _chapterAtPercent(pct) { return chapterAtPercent(pct); }
function _seekToPercent(pct)     { return seekToPercent(pct); }

/* ══════════════════════════════════════════════════════════════════
   §36. 버튼 이벤트 전체 바인딩
   ══════════════════════════════════════════════════════════════════ */
function initButtonEventHandlers() {
  const fileInput = DOMProxy.get('file-input');

  /* ── [U1] 서재 화면 상단 컨트롤 바 ── */
  if (DOMProxy.exists('btn-file-select')) {
    DOMProxy.get('btn-file-select').addEventListener('click', (e) => {
      e.stopPropagation(); fileInput.click();
    });
  }

  /* [L3] 다중 파일 change */
  fileInput.addEventListener('change', async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      await importEpubFiles(e.target.files);
    }
    fileInput.value = '';
  });

  /* [U2] 서재 화면 설정 버튼 */
  if (DOMProxy.exists('btn-library-settings')) {
    DOMProxy.get('btn-library-settings').addEventListener('click', () => {
      store.isSettingsOpen = !store.isSettingsOpen;
    });
  }

  /* ── 드래그앤드롭 (서재 화면 전체) ── */
  const dragOverlay = DOMProxy.get('drag-overlay');
  let dragCounter = 0;

  document.addEventListener('dragenter', (e) => {
    e.preventDefault(); dragCounter++;
    if (!store.isViewerOpen && dragOverlay) dragOverlay.style.display = 'flex';
  });
  document.addEventListener('dragleave', (e) => {
    e.preventDefault(); dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; if (dragOverlay) dragOverlay.style.display = 'none'; }
  });
  document.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('drop', async (e) => {
    e.preventDefault(); dragCounter = 0;
    if (dragOverlay) dragOverlay.style.display = 'none';
    if (store.isViewerOpen) return;
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.epub'));
    if (files.length > 0) await importEpubFiles(files);
  });

  /* ── 뷰어 화면 컨트롤 ── */
  if (DOMProxy.exists('btn-settings-toggle')) {
    DOMProxy.get('btn-settings-toggle').addEventListener('click', () => {
      store.isSettingsOpen = !store.isSettingsOpen;
    });
  }
  if (DOMProxy.exists('btn-toc-toggle')) {
    DOMProxy.get('btn-toc-toggle').addEventListener('click', () => {
      store.isTocOpen = !store.isTocOpen;
    });
  }
  if (DOMProxy.exists('toc-overlay')) {
    DOMProxy.get('toc-overlay').addEventListener('click', () => { store.isTocOpen = false; });
  }
  if (DOMProxy.exists('btn-exit-viewer')) {
    DOMProxy.get('btn-exit-viewer').addEventListener('click', () => {
      if (confirm('뷰어를 닫고 서재로 돌아가시겠습니까?')) exitViewer();
    });
  }
  if (DOMProxy.exists('arrow-prev')) {
    DOMProxy.get('arrow-prev').addEventListener('click', () => NavGuard.prev());
  }
  if (DOMProxy.exists('arrow-next')) {
    DOMProxy.get('arrow-next').addEventListener('click', () => NavGuard.next());
  }

  /* ── flow 전환 버튼 ── */
  DOMProxy.qa('[data-flow]').forEach(b => {
    b.addEventListener('click', () => { switchFlowMode(b.dataset.flow); _saveStateToLS(); });
  });

  /* ── 테마 스와치 ── */
  DOMProxy.qa('.theme-swatch').forEach(b => {
    b.addEventListener('click', () => { store.theme = b.dataset.theme; _saveStateToLS(); });
  });

  /* ── 폰트 크기 ── */
  if (DOMProxy.exists('btn-font-minus')) {
    DOMProxy.get('btn-font-minus').addEventListener('click', () => {
      store.fontSize = Math.max(60, store.fontSize - 5); _saveStateToLS();
    });
  }
  if (DOMProxy.exists('btn-font-plus')) {
    DOMProxy.get('btn-font-plus').addEventListener('click', () => {
      store.fontSize = Math.min(200, store.fontSize + 5); _saveStateToLS();
    });
  }

  /* ── 행간 버튼 ── */
  DOMProxy.qa('[data-lh]').forEach(b => {
    b.addEventListener('click', () => { store.lineHeight = b.dataset.lh; _saveStateToLS(); });
  });

  /* ── 검색 ── */
  if (DOMProxy.exists('btn-search-open')) {
    DOMProxy.get('btn-search-open').addEventListener('click', () => {
      const panel = DOMProxy.get('search-panel');
      if (panel) { panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'; }
      if (DOMProxy.exists('search-input')) DOMProxy.get('search-input').focus();
    });
  }
  if (DOMProxy.exists('btn-search-exec')) {
    DOMProxy.get('btn-search-exec').addEventListener('click', () => runSearchExecution());
  }
  if (DOMProxy.exists('search-input')) {
    DOMProxy.get('search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runSearchExecution();
      if (e.key === 'Escape') {
        const panel = DOMProxy.get('search-panel');
        if (panel) panel.style.display = 'none';
      }
    });
  }

  /* ── TTS ── */
  if (DOMProxy.exists('btn-tts-toggle')) {
    DOMProxy.get('btn-tts-toggle').addEventListener('click', () => TTSSystem.toggle());
  }

  /* ── 포모도로 ── */
  if (DOMProxy.exists('btn-pomodoro-toggle')) {
    DOMProxy.get('btn-pomodoro-toggle').addEventListener('click', () => Pomodoro.toggle());
  }

  /* ── [v4.0] 눈 보호 타이머 버튼 ── */
  if (DOMProxy.exists('btn-eye-protect')) {
    DOMProxy.get('btn-eye-protect').addEventListener('click', () => {
      EyeProtectTimer.toggle();
    });
  }

  /* ── [v4.0] 자동 스크롤 버튼 ── */
  if (DOMProxy.exists('btn-auto-scroll')) {
    DOMProxy.get('btn-auto-scroll').addEventListener('click', () => {
      /* 현재 표시된 view 객체 전달 */
      const view = store.rendition?.currentLocation?.()?.start ? null : null;
      AutoScrollDriver.toggle(view);
    });
  }

  /* ── 스크롤 Top 버튼 ── */
  if (DOMProxy.exists('btn-scroll-top')) {
    DOMProxy.get('btn-scroll-top').addEventListener('click', () => {
      try {
        const iframes = DOMProxy.get('viewer-viewport')?.querySelectorAll('iframe') || [];
        iframes.forEach(f => { if (f.contentWindow) f.contentWindow.scrollTo(0, 0); });
      } catch (_) {}
    });
  }

  /* ── [v4.0] 스크러버 호버 미리보기 HUD ──
     (이미 viewer.js의 initContextMenu에서 기본 로직 있으나
      진행률 슬라이더에 챕터 툴팁 추가)                           */
  _initScrubberHoverHUD();

  /* ── 설정 패널 외부 클릭 닫기 (서재/뷰어 양쪽 처리) ── */
  document.addEventListener('pointerdown', (e) => {
    const panel = DOMProxy.get('settings-panel');
    const btnV  = DOMProxy.get('btn-settings-toggle');
    const btnL  = DOMProxy.get('btn-library-settings');
    if (store.isSettingsOpen &&
        !panel.contains?.(e.target) &&
        !btnV.contains?.(e.target) &&
        !btnL.contains?.(e.target)) {
      store.isSettingsOpen = false;
    }
  }, { passive: true });

  document.addEventListener('keydown', handleKeyDown);

  /* ── 설정 UI 초기화 ── */
  initFontUploader();
  initFontSelector();
  initCustomThemeBuilder();
  initV4SettingsUI(); /* [v4.0] fontWeightBoost / contrastScale / eyeProtectMinutes / pageTransition */
}

/* ══════════════════════════════════════════════════════════════════
   [v4.0] §36-A. 스크러버 호버 미리보기 HUD
   진행률 슬라이더 hover/drag → 챕터 제목 + 예상 페이지 번호 툴팁
   ══════════════════════════════════════════════════════════════════ */
function _initScrubberHoverHUD() {
  const slider  = DOMProxy.get('progress-range-slider');
  const tooltip = DOMProxy.get('scrubber-tooltip');
  if (!DOMProxy.exists('progress-range-slider') || !DOMProxy.exists('scrubber-tooltip')) return;

  function _showTooltip(pct) {
    const chapter = _chapterAtPercent(pct);
    const pageEst = store.totalLocations > 0
      ? Math.round((pct / 100) * store.totalLocations)
      : Math.round((pct / 100) * (store.book?.spine?.items?.length || 1));

    /* 위치 계산 — 슬라이더 트랙 기준 */
    const rect   = slider.getBoundingClientRect();
    const leftPx = rect.left + (pct / 100) * rect.width;

    tooltip.style.display  = 'block';
    tooltip.style.left     = `${leftPx}px`;
    tooltip.style.transform = 'translateX(-50%)';
    tooltip.textContent    = chapter ? `${chapter} · ${pageEst}p` : `${pageEst}p`;

    /* scrubberHoverPct 스토어 업데이트 */
    store.scrubberHoverPct = pct;
  }

  function _hideTooltip() {
    if (!slider.dataset.dragging) {
      tooltip.style.display = 'none';
      store.scrubberHoverPct = -1;
    }
  }

  slider.addEventListener('mousemove', (e) => {
    const rect = slider.getBoundingClientRect();
    const pct  = Math.min(100, Math.max(0, Math.round(((e.clientX - rect.left) / rect.width) * 100)));
    _showTooltip(pct);
  });
  slider.addEventListener('mouseenter', (e) => {
    const rect = slider.getBoundingClientRect();
    const pct  = Math.min(100, Math.max(0, Math.round(((e.clientX - rect.left) / rect.width) * 100)));
    _showTooltip(pct);
  });
  slider.addEventListener('mouseleave', _hideTooltip);

  /* 터치/포인터 드래그 */
  slider.addEventListener('pointerdown', () => { slider.dataset.dragging = '1'; });
  slider.addEventListener('input', () => {
    const pct = parseInt(slider.value, 10);
    _showTooltip(pct);
  });
  slider.addEventListener('change', () => {
    const pct = parseInt(slider.value, 10);
    delete slider.dataset.dragging;
    tooltip.style.display = 'none';
    _seekToPercent(pct);
  });
  slider.addEventListener('pointerup',   () => { setTimeout(() => { tooltip.style.display = 'none'; }, 100); });
  slider.addEventListener('pointerleave', () => { if (!slider.dataset.dragging) tooltip.style.display = 'none'; });
}

/* ══════════════════════════════════════════════════════════════════
   §37. 전역 진입점
   ══════════════════════════════════════════════════════════════════ */
async function initializeSystemCore() {
  /*
   * [B1 리팩토링] 비동기 런타임 가드 레이어
   * ─────────────────────────────────────────────────────────────
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

  /* ── [스마트 슬립 가드] visibilitychange → store.appInBackground ── */
  document.addEventListener('visibilitychange', () => {
    store.appInBackground = document.hidden;
  });

  /* PWA 서비스 워커 등록 (vite-plugin-pwa injectManifest 산출물) */
  if ('serviceWorker' in navigator) {
    try {
      /*
       * [버그 수정] import.meta.env.MODE 직접 접근 금지.
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

  /* [v4.0] 최초 진입 시 온보딩 가이드 실행 */
  if (!store.onboardingDone) {
    /* 짧은 딜레이 후 온보딩 시작 (렌더링 완료 대기) */
    setTimeout(() => OnboardingGuide.start(), 600);
  }

  if (!('ontouchstart' in window)) showKeyboardHint();

  console.log('📖 Fable Premium v4.0 — Initialized');
}

/* [3]-9 미니멀 상단바 스크롤 동적 고정 (Sticky Header) */
function initStickyHeader() {
  const body   = DOMProxy.get('library-body');
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
  if (DOMProxy.exists('btn-fts-open'))
    DOMProxy.get('btn-fts-open').addEventListener('click', () => LibraryFullTextSearch.open());
  if (DOMProxy.exists('btn-cloud-backup'))
    DOMProxy.get('btn-cloud-backup').addEventListener('click', () => CloudBackup.backupToFile());

  store.dailyGoalMin = parseInt(localStorage.getItem('fable_daily_goal') || '30', 10);
}

function _forceSyncSettingsUI() {
  setTextSafe(DOMProxy.get('font-size-display'), `${store.fontSize}%`);
  DOMProxy.qa('[data-lh]').forEach(b => { const ok = b.dataset.lh === store.lineHeight; b.classList.toggle('active', ok); b.setAttribute('aria-checked', String(ok)); });
  DOMProxy.qa('[data-flow]').forEach(b => { const ok = b.dataset.flow === store.flow; b.classList.toggle('active', ok); b.setAttribute('aria-checked', String(ok)); });
  DOMProxy.qa('.theme-swatch').forEach(b => { const ok = b.dataset.theme === store.theme; b.classList.toggle('active', ok); b.setAttribute('aria-checked', String(ok)); });
  if (DOMProxy.exists('custom-theme-builder'))
    DOMProxy.get('custom-theme-builder').style.display = store.theme === 'custom' ? 'block' : 'none';
  if (store.theme !== 'paper' && store.theme !== 'custom')
    document.body.setAttribute('data-theme', store.theme);
  document.documentElement.style.setProperty('--color-user-bg',       store.userBg);
  document.documentElement.style.setProperty('--color-user-ink',      store.userInk);
  document.documentElement.style.setProperty('--user-letter-spacing', store.userSpacing + 'em');
  document.documentElement.style.setProperty('--user-line-height',    String(store.userLeading));
  if (DOMProxy.exists('input-user-bg'))      DOMProxy.get('input-user-bg').value      = store.userBg;
  if (DOMProxy.exists('input-user-bg-hex'))  DOMProxy.get('input-user-bg-hex').value  = store.userBg;
  if (DOMProxy.exists('input-user-ink'))     DOMProxy.get('input-user-ink').value     = store.userInk;
  if (DOMProxy.exists('input-user-ink-hex')) DOMProxy.get('input-user-ink-hex').value = store.userInk;
  if (DOMProxy.exists('input-user-spacing')) DOMProxy.get('input-user-spacing').value = String(store.userSpacing);
  setTextSafe(DOMProxy.get('spacing-val'), store.userSpacing + 'em');
  if (DOMProxy.exists('input-user-leading')) DOMProxy.get('input-user-leading').value = String(store.userLeading);
  setTextSafe(DOMProxy.get('leading-val'), String(store.userLeading));

  /* [v4.0] 신규 설정 UI 동기화 */
  if (DOMProxy.exists('input-font-weight-boost')) {
    DOMProxy.get('input-font-weight-boost').value = String(store.fontWeightBoost ?? 0);
    setTextSafe(DOMProxy.get('font-weight-boost-val'), String(store.fontWeightBoost ?? 0));
  }
  if (DOMProxy.exists('input-contrast-scale')) {
    DOMProxy.get('input-contrast-scale').value = String(store.contrastScale ?? 1.0);
    setTextSafe(DOMProxy.get('contrast-scale-val'), parseFloat(store.contrastScale ?? 1.0).toFixed(2));
  }
  if (DOMProxy.exists('input-eye-protect-minutes')) {
    DOMProxy.get('input-eye-protect-minutes').value = String(store.eyeProtectMinutes ?? 50);
    setTextSafe(DOMProxy.get('eye-protect-minutes-val'), String(store.eyeProtectMinutes ?? 50) + '분');
  }
  /* pageTransition 버튼 그룹 */
  DOMProxy.qa('[data-transition]').forEach(b => {
    const ok = b.dataset.transition === (store.pageTransition || 'fade');
    b.classList.toggle('active', ok); b.setAttribute('aria-checked', String(ok));
  });
}

/*
 * 부트스트랩 — 크래시 격리 레이어
 * initializeSystemCore 내부에서 예기치 못한 예외가 나도 페이지 전체가
 * 죽지 않도록 try-catch로 감싸고, 실패 시 사용자에게 안내한다.
 */
function _bootstrapFable() {
  try {
    const ret = initializeSystemCore();
    /* async 함수의 reject도 잡아 전역 사망 방지 */
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
