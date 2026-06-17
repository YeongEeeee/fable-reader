/**
 * src/main.js  ── Fable Premium v5.0
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
 * [버그 수정 v4.1]
 *   - btn-toc-close (목차 X 닫기) 바인딩 추가
 *   - btn-close-viewer (뷰어 ✕ 닫기) — btn-exit-viewer 오탈자 수정
 *   - btn-search-toggle (🔍) 바인딩 추가 → search-modal 토글
 *   - btn-annotation-toggle (✏️) 바인딩 추가 → TTS 낭독 연결
 *   - btn-stats-toggle (📊) 바인딩 추가 → stats-modal 토글 + ReadingReport
 *   - btn-pomodoro-open (🍅) 바인딩 추가 → Pomodoro.openPopup()
 *   - btn-font-decrease/increase — btn-font-minus/plus 오탈자 수정
 *   - btn-settings-close 바인딩 추가
 *   - scrubber-tooltip → slider-tooltip ID 수정 (HTML 실제 ID 일치)
 *   - OnboardingGuide.start() → OnboardingGuide.init() 수정
 *   - TTSSystem.toggle() → TTSSystem.pauseResume() 수정
 *   - AutoScrollDriver.toggle(null) → 실제 view 객체 전달
 *   - 검색/통계 모달 외부 클릭 닫기 추가
 *   - registerReaderDeps 호출 시 initAnnotationManager 래퍼 제거
 *
 * [고도화 v4.2]
 *   - handleKeyDown: store.isSearching / fts-modal 활성 시 Space·방향키 가드
 *   - TTS 정지 버튼(btn-tts-stop) 바인딩 — TTSSystem.stop() 연결
 *   - slider-scrubber TTS 재생 중 조작 차단 토스트 이벤트 주입
 *
 * [고도화 v5.0]
 *   - store.fxAnimation / fxBlur / fxZenMode 리액티브 바인더 추가
 *   - initZenMode(): 2초 비활동 → zen-mode-active 클래스 오케스트레이션
 *     (뷰어 화면에서만 활성, store.fxZenMode=false 시 완전 비활성)
 *   - _forceSyncSettingsUI(): FX 체크박스 동기화 확장
 *   - applyFxState import 및 부팅 시 즉시 적용
 *
 * [v5.0 설정 UI/UX 대개혁]
 *   - registerReaderDeps에 onViewerTap 콜백 추가 — reader.js의 rendition
 *     click 핸들러(navBarsVisible 토글)와 QuickSettingsPopover를 동기화.
 *     상하단 바가 나타날 때 팝오버도 함께 열리고, 숨겨질 때 함께 닫힌다.
 *   - handleKeyDown Escape 체인 최우선 분기에 quickPopoverOpen 닫기 추가.
 *   - mountReactiveBinders: isViewerOpen=false 구독 시 팝오버 강제 닫기
 *     (서재 화면 복귀 후 팝오버 잔존 방지).
 * ───────────────────────────────────────────────────────────────────
 */

'use strict';

/* 1. 코어 상태 엔진 및 유틸리티 모듈 (동일 디렉터리) */
import {
  store, ReactiveStore, DOMProxy, ErrorBoundary, Toast,
  setTextSafe, LH_MAP,
} from './store.js';
import { StorageSystem } from './database.js';
import { AnnotationSyncEngine } from './sync.js';
import {
  registerReaderDeps,
  openEpubBook, exitViewer, switchFlowMode,
  injectCustomToIframe, reapplyInlineTheme, chapterAtPercent, seekToPercent,
  NavGuard, isEpubRuntimeReady, waitForEpubJS,
  EyeProtectTimer, AutoScrollDriver, WPMTracker,
} from './reader.js';

/* 2. 전역 공용 UI 레이어 모듈 (동일 디렉터리) */
import {
  LoadingOverlay, ResizeMask, ImportProgress,
  showViewerScreen, showUploaderScreen,
} from './ui.js';

/* 3. [경로 교정] src/ui/ 서브 디렉터리 내부 UI 특화 상호작용 모듈 */
import {
  HashWorker, refreshLibraryData, renderLibraryGrid, importEpubFiles,
} from './ui/uploader.js';

import {
  renderTocSidebar, updateTocActiveItem,
  ReadingStatsTracker, SearchEngine, VirtualSearchList, runSearchExecution,
  AnnotationManager, initContextMenu, TTSSystem, bindScrollTopButton,
  MetadataEditor, AnnotationExporter, LibraryFullTextSearch, CloudBackup, Pomodoro,
  ReadingReport, OnboardingGuide,
  QuickSettingsPopover, // <-- v5.0 맥락형 빠른 설정 팝오버
} from './ui/viewer.js';

import {
  initFontUploader, initFontSelector, initCustomThemeBuilder,
  initV4SettingsUI, initFxSettingsUI, // <-- v5.0 비주얼 효과 초기화 엔진 통합
  showKeyboardHint, initOfflineBanner, _saveStateToLS, _loadStateFromLS,
  applyFxState,
} from './ui/settings.js';

/* ══════════════════════════════════════════════════════════════════
   환경 변수 Null-Safe 접근
   ══════════════════════════════════════════════════════════════════ */
function _envMode() {
  try {
    if (typeof import.meta !== 'undefined' && import.meta && import.meta.env && import.meta.env.MODE)
      return import.meta.env.MODE;
  } catch (_) {}
  return 'production';
}

/* ══════════════════════════════════════════════════════════════════
   §32. 키보드 단축키
   ─────────────────────────────────────────────────────────────────
   [v4.2 가드] 전문 검색 활성 상태 또는 검색 모달 내 인풋 포커스 중에는
   Space·방향키 이벤트를 preventDefault 없이 즉시 return 한다.
   ══════════════════════════════════════════════════════════════════ */
function handleKeyDown(e) {
  const viewer = DOMProxy.get('screen-viewer');
  if (!DOMProxy.exists('screen-viewer') || viewer.style.display === 'none') return;
  if (!store.rendition) return;

  const _isSearchActive = () => {
    if (store.isSearching) return true;
    const searchModal = DOMProxy.get('search-modal');
    if (searchModal && searchModal.style.display === 'flex') return true;
    const ftsModal = DOMProxy.get('fts-modal');
    if (ftsModal && ftsModal.style.display === 'flex') return true;
    return false;
  };

  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case ' ':
      if (_isSearchActive()) return;
      e.preventDefault(); NavGuard.next(); break;
    case 'ArrowLeft': case 'ArrowUp': case 'Backspace':
      if (_isSearchActive()) return;
      e.preventDefault(); NavGuard.prev(); break;
    case 'Escape':
      if (store.quickPopoverOpen) { QuickSettingsPopover.close(); break; }
      if (store.isSettingsOpen) { store.isSettingsOpen = false; break; }
      if (store.isTocOpen)      { store.isTocOpen      = false; break; }
      if (DOMProxy.get('search-modal')?.style.display === 'flex') {
        DOMProxy.get('search-modal').style.display = 'none';
        store.isSearching = false;
        break;
      }
      if (DOMProxy.get('fts-modal')?.style.display === 'flex') {
        DOMProxy.get('fts-modal').style.display = 'none';
        store.isSearching = false;
        break;
      }
      if (DOMProxy.get('stats-modal')?.style.display === 'flex') {
        DOMProxy.get('stats-modal').style.display = 'none'; break;
      }
      if (confirm('뷰어를 닫고 서재로 돌아가시겠습니까?')) exitViewer();
      break;
    default: break;
  }
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
  /* [v5.0] 뷰어 본문 탭 시 navBarsVisible과 QuickSettingsPopover 동기화.
     바가 나타나면(visible=true) 팝오버를 열고, 숨겨지면 닫는다. */
  onViewerTap: (navBarsVisible) => {
    if (navBarsVisible) QuickSettingsPopover.open();
    else QuickSettingsPopover.close();
  },
});

/* ══════════════════════════════════════════════════════════════════
   [v5.0] §ZEN. 젠 모드 오케스트레이션
   ─────────────────────────────────────────────────────────────────
   뷰어 화면이 활성 상태이고 store.fxZenMode === true 일 때,
   2초(CSS --fx-zen-idle-delay와 동기) 동안 포인터/터치 입력이
   없으면 body에 zen-mode-active 클래스를 추가하여 상하단 바를
   CSS transition으로 페이드아웃 한다.
   포인터 이동/터치 발생 시 클래스를 즉시 제거한다.
   ══════════════════════════════════════════════════════════════════ */
function initZenMode() {
  /* 내부 상태 */
  let _zenTimer       = null;
  let _zenActive      = false;
  const ZEN_DELAY_MS  = 2000;   /* CSS --fx-zen-idle-delay와 동기화 */

  /* 젠 모드 진입 */
  function _enterZen() {
    if (_zenActive) return;
    _zenActive = true;
    document.body.classList.add('zen-mode-active');
    const viewer = DOMProxy.get('screen-viewer');
    if (viewer && viewer !== DOMProxy.VOID_NODE) viewer.classList.add('zen-mode-active');
  }

  /* 젠 모드 해제 — 즉각적 */
  function _exitZen() {
    _zenActive = false;
    document.body.classList.remove('zen-mode-active');
    const viewer = DOMProxy.get('screen-viewer');
    if (viewer && viewer !== DOMProxy.VOID_NODE) viewer.classList.remove('zen-mode-active');
  }

  /* 타이머 리셋 + 젠 해제 */
  function _resetZenTimer() {
    /* fxZenMode가 꺼져 있으면 아무것도 안 함 */
    if (store.fxZenMode === false) { _exitZen(); return; }
    /* 뷰어 화면이 아니면 작동 안 함 */
    if (!store.isViewerOpen) { _exitZen(); return; }

    _exitZen();
    clearTimeout(_zenTimer);
    _zenTimer = setTimeout(_enterZen, ZEN_DELAY_MS);
  }

  /* 활동 감지 이벤트 — 뷰어 iframe 내부 포함 */
  const _ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'touchstart', 'wheel'];

  _ACTIVITY_EVENTS.forEach(type => {
    document.addEventListener(type, _resetZenTimer, { passive: true, capture: true });
  });

  /* iframe 내부 활동도 감지 — epub.js iframe에 이벤트 전달 위임 */
  function _hookIframeActivity() {
    const iframes = document.querySelectorAll('#viewer-viewport iframe, .epub-container iframe');
    iframes.forEach(iframe => {
      try {
        const iframeDoc = iframe.contentDocument;
        if (!iframeDoc) return;
        _ACTIVITY_EVENTS.forEach(type => {
          iframeDoc.addEventListener(type, _resetZenTimer, { passive: true, capture: true });
        });
      } catch (_) {}
    });
  }

  /* rendition 준비 완료 후 iframe 훅 — store.rendition 변화 감지 */
  ReactiveStore.subscribe('rendition', (rendition) => {
    if (rendition) {
      /* rendition.on('rendered') 이후 iframe이 완전히 삽입되므로 딜레이 */
      setTimeout(_hookIframeActivity, 600);
      rendition.on('rendered', () => {
        setTimeout(_hookIframeActivity, 300);
      });
    }
  });

  /* 뷰어 진입/이탈 시 타이머 제어 */
  ReactiveStore.subscribe('isViewerOpen', (open) => {
    if (open) {
      /* 뷰어 진입 — 젠 타이머 시작 */
      _resetZenTimer();
    } else {
      /* 서재로 복귀 — 젠 해제 + 타이머 정리 */
      clearTimeout(_zenTimer);
      _exitZen();
    }
  });

  /* fxZenMode 토글 시 즉시 반영 */
  ReactiveStore.subscribe('fxZenMode', (enabled) => {
    if (!enabled) {
      clearTimeout(_zenTimer);
      _exitZen();
    } else if (store.isViewerOpen) {
      _resetZenTimer();
    }
  });
}

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

  /* [v5.0] 뷰어 종료 시 맥락형 빠른 설정 팝오버 강제 닫기
     — 서재 화면으로 복귀했는데 팝오버가 잔존하는 현상 방지 */
  ReactiveStore.subscribe('isViewerOpen', (open) => {
    if (!open && store.quickPopoverOpen) QuickSettingsPopover.close();
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

  ReactiveStore.subscribe('libraryBooks',   () => renderLibraryGrid());
  ReactiveStore.subscribe('folders',        () => renderLibraryGrid());
  ReactiveStore.subscribe('activeFolderId', () => renderLibraryGrid());
  ReactiveStore.subscribe('activeTags',     () => renderLibraryGrid());
  ReactiveStore.subscribe('sortMode',       () => renderLibraryGrid());
  ReactiveStore.subscribe('librarySearch',  () => renderLibraryGrid());

  ReactiveStore.subscribe('measuredWpm', (wpm) => {
    if (DOMProxy.exists('stat-wpm'))
      setTextSafe(DOMProxy.get('stat-wpm'), `${wpm} WPM`);
    AutoScrollDriver.updateSpeed();
  });

  ReactiveStore.subscribe('fontWeightBoost', () => {
    if (store.rendition) requestAnimationFrame(() => reapplyInlineTheme());
  });

  ReactiveStore.subscribe('contrastScale', () => {
    if (store.rendition) requestAnimationFrame(() => reapplyInlineTheme());
  });

  ReactiveStore.subscribe('pageTransition', (v) => {
    DOMProxy.qa('[data-transition]').forEach(b => {
      b.classList.toggle('active', b.dataset.transition === v);
      b.setAttribute('aria-checked', String(b.dataset.transition === v));
    });
  });

  ReactiveStore.subscribe('eyeProtectMinutes', () => {
    if (store.eyeProtectActive) {
      EyeProtectTimer.stop();
      EyeProtectTimer.start();
    }
  });

  ReactiveStore.subscribe('autoScrollActive', (active) => {
    if (DOMProxy.exists('btn-auto-scroll')) {
      DOMProxy.get('btn-auto-scroll').classList.toggle('active', active);
      DOMProxy.get('btn-auto-scroll').setAttribute('aria-pressed', String(active));
    }
  });

  ReactiveStore.subscribe('eyeProtectActive', (active) => {
    if (DOMProxy.exists('btn-eye-protect')) {
      DOMProxy.get('btn-eye-protect').classList.toggle('active', active);
      DOMProxy.get('btn-eye-protect').setAttribute('aria-pressed', String(active));
    }
  });

  ReactiveStore.subscribe('isTtsPlaying', (playing) => {
    if (DOMProxy.exists('btn-tts-play-pause')) {
      setTextSafe(DOMProxy.get('btn-tts-play-pause'), playing ? '⏸' : '▶');
      DOMProxy.get('btn-tts-play-pause').setAttribute('aria-pressed', String(playing));
    }
  });

  ReactiveStore.subscribe('ttsVoice', (voiceURI) => {
    const sel = DOMProxy.get('tts-voice-select');
    if (sel && sel !== DOMProxy.VOID_NODE) sel.value = voiceURI || '';
  });

  /* ── [v5.0] FX 상태 리액티브 바인더 ──
     store.fxAnimation / fxBlur / fxZenMode 변화 시
     html 어트리뷰트를 즉시 갱신하여 CSS 가드를 활성화/해제한다. */
  ReactiveStore.subscribe('fxAnimation', () => applyFxState());
  ReactiveStore.subscribe('fxBlur',      () => applyFxState());
  ReactiveStore.subscribe('fxZenMode',   () => applyFxState());
}

/* ══════════════════════════════════════════════════════════════════
   내부 래퍼 — injectCustomToIframe (reader.js 위임)
   ══════════════════════════════════════════════════════════════════ */
function _injectCustomToIframe() {
  injectCustomToIframe();
}

/* ══════════════════════════════════════════════════════════════════
   §35b. 퍼센트 위치 이동 (reader.js 위임)
   ══════════════════════════════════════════════════════════════════ */
function _chapterAtPercent(pct) { return chapterAtPercent(pct); }
function _seekToPercent(pct)    { return seekToPercent(pct); }

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

  fileInput.addEventListener('change', async (e) => {
    if (e.target.files && e.target.files.length > 0)
      await importEpubFiles(e.target.files);
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
  let dragCounter   = 0;

  document.addEventListener('dragenter', (e) => {
    e.preventDefault(); dragCounter++;
    if (!store.isViewerOpen && dragOverlay) dragOverlay.style.display = 'flex';
  });
  document.addEventListener('dragleave', (e) => {
    e.preventDefault(); dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; if (dragOverlay) dragOverlay.style.display = 'none'; }
  });
  document.addEventListener('dragover',  (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('drop', async (e) => {
    e.preventDefault(); dragCounter = 0;
    if (dragOverlay) dragOverlay.style.display = 'none';
    if (store.isViewerOpen) return;
    const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.epub'));
    if (files.length > 0) await importEpubFiles(files);
  });

  /* ── 뷰어 상단 툴바 — 설정 버튼 ── */
  if (DOMProxy.exists('btn-settings-toggle')) {
    DOMProxy.get('btn-settings-toggle').addEventListener('click', () => {
      store.isSettingsOpen = !store.isSettingsOpen;
    });
  }

  /* 설정 패널 X 닫기 버튼 */
  if (DOMProxy.exists('btn-settings-close')) {
    DOMProxy.get('btn-settings-close').addEventListener('click', () => {
      store.isSettingsOpen = false;
    });
  }

  /* ── 뷰어 닫기 버튼 ── */
  if (DOMProxy.exists('btn-close-viewer')) {
    DOMProxy.get('btn-close-viewer').addEventListener('click', () => {
      if (confirm('뷰어를 닫고 서재로 돌아가시겠습니까?')) exitViewer();
    });
  }

  /* ── 목차 토글 ── */
  if (DOMProxy.exists('btn-toc-toggle')) {
    DOMProxy.get('btn-toc-toggle').addEventListener('click', () => {
      store.isTocOpen = !store.isTocOpen;
    });
  }
  if (DOMProxy.exists('btn-toc-close')) {
    DOMProxy.get('btn-toc-close').addEventListener('click', () => {
      store.isTocOpen = false;
    });
  }
  if (DOMProxy.exists('toc-overlay')) {
    DOMProxy.get('toc-overlay').addEventListener('click', () => {
      store.isTocOpen = false;
    });
  }

  /* ── 페이지 이동 ── */
  if (DOMProxy.exists('btn-prev-page'))
    DOMProxy.get('btn-prev-page').addEventListener('click', () => NavGuard.prev());
  if (DOMProxy.exists('btn-next-page'))
    DOMProxy.get('btn-next-page').addEventListener('click', () => NavGuard.next());

  /* ── 폰트 크기 ── */
  if (DOMProxy.exists('btn-font-decrease')) {
    DOMProxy.get('btn-font-decrease').addEventListener('click', () => {
      store.fontSize = Math.max(60, store.fontSize - 5); _saveStateToLS();
    });
  }
  if (DOMProxy.exists('btn-font-increase')) {
    DOMProxy.get('btn-font-increase').addEventListener('click', () => {
      store.fontSize = Math.min(200, store.fontSize + 5); _saveStateToLS();
    });
  }

  /* ── 테마 스와치 ── */
  DOMProxy.qa('.theme-swatch').forEach(b => {
    b.addEventListener('click', () => { store.theme = b.dataset.theme; _saveStateToLS(); });
  });

  /* ── 흐름 전환 (paginated / scrolled) ── */
  DOMProxy.qa('[data-flow]').forEach(b => {
    b.addEventListener('click', () => { store.flow = b.dataset.flow; switchFlowMode(b.dataset.flow); _saveStateToLS(); });
  });

  /* ── 검색 모달 토글 ── */
  if (DOMProxy.exists('btn-search-toggle')) {
    DOMProxy.get('btn-search-toggle').addEventListener('click', () => {
      const modal = DOMProxy.get('search-modal');
      if (!modal || modal === DOMProxy.VOID_NODE) return;
      const isVisible = modal.style.display === 'flex';
      modal.style.display = isVisible ? 'none' : 'flex';
      store.isSearching = !isVisible;
      if (!isVisible) {
        const input = modal.querySelector('input[type="text"], input[type="search"]');
        if (input) setTimeout(() => input.focus(), 80);
      }
    });
  }

  /* ── 주석/어노테이션 토글 ── */
  if (DOMProxy.exists('btn-annotation-toggle')) {
    DOMProxy.get('btn-annotation-toggle').addEventListener('click', () => {
      TTSSystem.pauseResume();
    });
  }

  /* ── 통계 모달 토글 ── */
  if (DOMProxy.exists('btn-stats-toggle')) {
    DOMProxy.get('btn-stats-toggle').addEventListener('click', () => {
      const modal = DOMProxy.get('stats-modal');
      if (!modal || modal === DOMProxy.VOID_NODE) return;
      const isVisible = modal.style.display === 'flex';
      modal.style.display = isVisible ? 'none' : 'flex';
      if (!isVisible) ReadingReport.render();
    });
  }

  /* ── 포모도로 버튼 ── */
  if (DOMProxy.exists('btn-pomodoro-open')) {
    DOMProxy.get('btn-pomodoro-open').addEventListener('click', () => {
      Pomodoro.openPopup();
    });
  }

  /* ── TTS 재생/일시정지 ── */
  if (DOMProxy.exists('btn-tts-play-pause')) {
    DOMProxy.get('btn-tts-play-pause').addEventListener('click', () => {
      TTSSystem.pauseResume();
    });
  }

  /* ── [v4.2] TTS 정지 버튼 ── */
  if (DOMProxy.exists('btn-tts-stop')) {
    DOMProxy.get('btn-tts-stop').addEventListener('click', () => {
      TTSSystem.stop();
    });
  }

  /* ── 행간 버튼 그룹 ── */
  DOMProxy.qa('[data-lh]').forEach(b => {
    b.addEventListener('click', () => { store.lineHeight = b.dataset.lh; _saveStateToLS(); });
  });

  /* ── [v4.0] 눈 보호 타이머 ── */
  if (DOMProxy.exists('btn-eye-protect'))
    DOMProxy.get('btn-eye-protect').addEventListener('click', () => EyeProtectTimer.toggle());

  /* ── [v4.0] 자동 스크롤 ── */
  if (DOMProxy.exists('btn-auto-scroll')) {
    DOMProxy.get('btn-auto-scroll').addEventListener('click', () => {
      let view = null;
      try { view = store.rendition?.manager?.views?.()?.[0] ?? null; } catch (_) {}
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

  /* ── 키보드 단축키 힌트 닫기 ── */
  if (DOMProxy.exists('btn-hint-close')) {
    DOMProxy.get('btn-hint-close').addEventListener('click', () => {
      const layer = DOMProxy.get('keyboard-hint-layer');
      if (layer) layer.style.display = 'none';
    });
  }

  /* ── 스크러버 HUD ── */
  _initScrubberHoverHUD();

  /* ── [v4.2] 슬라이더 TTS 재생 중 조작 차단 블로커 ── */
  _initScrubberTtsBlocker();

  /* ── 설정 패널 외부 클릭 닫기 ── */
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
    const searchModal = DOMProxy.get('search-modal');
    if (searchModal && searchModal.style.display === 'flex') {
      const btnSearch = DOMProxy.get('btn-search-toggle');
      if (!searchModal.contains?.(e.target) && !btnSearch?.contains?.(e.target)) {
        searchModal.style.display = 'none';
        store.isSearching = false;
      }
    }
    const statsModal = DOMProxy.get('stats-modal');
    if (statsModal && statsModal.style.display === 'flex') {
      const btnStats = DOMProxy.get('btn-stats-toggle');
      if (!statsModal.contains?.(e.target) && !btnStats?.contains?.(e.target))
        statsModal.style.display = 'none';
    }
  }, { passive: true });

  document.addEventListener('keydown', handleKeyDown);

  /* ── 설정 UI 초기화 ── */
  initFontUploader();
  initFontSelector();
  initCustomThemeBuilder();
  initV4SettingsUI();
}

/* ══════════════════════════════════════════════════════════════════
   [v4.0] §36-A. 스크러버 호버 미리보기 HUD
   ══════════════════════════════════════════════════════════════════ */
function _initScrubberHoverHUD() {
  const slider  = DOMProxy.get('progress-range-slider');
  const tooltip = DOMProxy.get('slider-tooltip');
  if (!DOMProxy.exists('progress-range-slider')) return;

  function _showTooltip(pct) {
    const chapter = _chapterAtPercent(pct);
    const pageEst = store.totalLocations > 0
      ? Math.round((pct / 100) * store.totalLocations)
      : Math.round((pct / 100) * (store.book?.spine?.items?.length || 1));

    const rect   = slider.getBoundingClientRect();
    const leftPx = rect.left + (pct / 100) * rect.width;

    if (tooltip && tooltip !== DOMProxy.VOID_NODE) {
      tooltip.style.display   = 'block';
      tooltip.style.left      = `${leftPx}px`;
      tooltip.style.transform = 'translateX(-50%)';
      const chEl  = tooltip.querySelector('#slider-tooltip-chapter, .slider-tooltip-chapter');
      const pctEl = tooltip.querySelector('#slider-tooltip-pct,     .slider-tooltip-pct');
      if (chEl && pctEl) {
        setTextSafe(chEl,  chapter || '');
        setTextSafe(pctEl, `${pageEst}p`);
      } else {
        tooltip.textContent = chapter ? `${chapter} · ${pageEst}p` : `${pageEst}p`;
      }
    }
    store.scrubberHoverPct = pct;
  }

  function _hideTooltip() {
    if (!slider.dataset.dragging && tooltip && tooltip !== DOMProxy.VOID_NODE) {
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

  slider.addEventListener('pointerdown', () => { slider.dataset.dragging = '1'; });
  slider.addEventListener('input', () => {
    const pct = parseInt(slider.value, 10);
    _showTooltip(pct);
  });
  slider.addEventListener('change', () => {
    const pct = parseInt(slider.value, 10);
    delete slider.dataset.dragging;
    if (tooltip && tooltip !== DOMProxy.VOID_NODE) tooltip.style.display = 'none';
    _seekToPercent(pct);
  });
  slider.addEventListener('pointerup', () => {
    setTimeout(() => {
      if (tooltip && tooltip !== DOMProxy.VOID_NODE) tooltip.style.display = 'none';
    }, 100);
  });
  slider.addEventListener('pointerleave', () => {
    if (!slider.dataset.dragging && tooltip && tooltip !== DOMProxy.VOID_NODE)
      tooltip.style.display = 'none';
  });
}

/* ══════════════════════════════════════════════════════════════════
   [v4.2] §36-B. 슬라이더 TTS 재생 중 조작 차단 블로커
   ══════════════════════════════════════════════════════════════════ */
function _initScrubberTtsBlocker() {
  const scrubber = DOMProxy.exists('slider-scrubber')
    ? DOMProxy.get('slider-scrubber')
    : DOMProxy.get('progress-range-slider');

  if (!scrubber || scrubber === DOMProxy.VOID_NODE) return;

  let _toastCooldown = false;

  scrubber.addEventListener('mouseover', () => {
    if (!store.isTtsPlaying) return;
    if (_toastCooldown) return;
    _toastCooldown = true;
    Toast.show('TTS 재생 중에는 하단 스크롤바 조작이 제한됩니다.', 'warning');
    setTimeout(() => { _toastCooldown = false; }, 2000);
  });

  scrubber.addEventListener('pointerdown', (e) => {
    if (!store.isTtsPlaying) return;
    e.preventDefault();
    e.stopPropagation();
    if (!_toastCooldown) {
      _toastCooldown = true;
      Toast.show('TTS 재생 중에는 하단 스크롤바 조작이 제한됩니다.', 'warning');
      setTimeout(() => { _toastCooldown = false; }, 2000);
    }
  });

  scrubber.addEventListener('touchstart', (e) => {
    if (!store.isTtsPlaying) return;
    e.preventDefault();
    if (!_toastCooldown) {
      _toastCooldown = true;
      Toast.show('TTS 재생 중에는 하단 스크롤바 조작이 제한됩니다.', 'warning');
      setTimeout(() => { _toastCooldown = false; }, 2000);
    }
  }, { passive: false });
}

/* ══════════════════════════════════════════════════════════════════
   §36-C. Settings UI 동기화 강제 초기화 — [v5.0] FX 체크박스 추가
   ══════════════════════════════════════════════════════════════════ */
function _forceSyncSettingsUI() {
  setTextSafe(DOMProxy.get('font-size-display'), `${store.fontSize}%`);
  DOMProxy.qa('[data-lh]').forEach(b => {
    const ok = b.dataset.lh === store.lineHeight;
    b.classList.toggle('active', ok); b.setAttribute('aria-checked', String(ok));
  });
  DOMProxy.qa('[data-flow]').forEach(b => {
    const ok = b.dataset.flow === store.flow;
    b.classList.toggle('active', ok); b.setAttribute('aria-checked', String(ok));
  });
  DOMProxy.qa('.theme-swatch').forEach(b => {
    const ok = b.dataset.theme === store.theme;
    b.classList.toggle('active', ok); b.setAttribute('aria-checked', String(ok));
  });
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
  DOMProxy.qa('[data-transition]').forEach(b => {
    const ok = b.dataset.transition === (store.pageTransition || 'fade');
    b.classList.toggle('active', ok); b.setAttribute('aria-checked', String(ok));
  });

  /* [v5.0] FX 토글 체크박스 동기화 */
  const fxMap = {
    'fx-toggle-animation': 'fxAnimation',
    'fx-toggle-blur':      'fxBlur',
    'fx-toggle-zen':       'fxZenMode',
  };
  Object.entries(fxMap).forEach(([elId, storeKey]) => {
    if (DOMProxy.exists(elId)) {
      DOMProxy.get(elId).checked = store[storeKey] !== false;
    }
  });

  /* [v5.0] FX 어트리뷰트 즉시 적용 */
  applyFxState();
}

/* ══════════════════════════════════════════════════════════════════
   §37. 서재 상단 컨트롤 바인딩
   ══════════════════════════════════════════════════════════════════ */
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

/* 미니멀 상단바 스크롤 동적 고정 (Sticky Header) */
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

/* ══════════════════════════════════════════════════════════════════
   §38. 전역 진입점 — 비동기 초기화 시퀀스
   ══════════════════════════════════════════════════════════════════ */
async function initializeSystemCore() {
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
      try {
        localStorage.setItem(
          'fable_cfi_' + store.bookKey,
          JSON.stringify({ data: store.currentCFI, ts: Date.now() })
        );
      } catch (_) {}
    }
    try { StorageSystem.flushProgressNow(); } catch (_) {}
  });

  document.addEventListener('visibilitychange', () => {
    store.appInBackground = document.hidden;
  });

  /* PWA 서비스 워커 등록 */
  if ('serviceWorker' in navigator) {
    try {
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

  /* [v5.0] 젠 모드 오케스트레이터 초기화 — initButtonEventHandlers 이후 */
  initZenMode();

  MetadataEditor.init();
  AnnotationExporter.init();
  LibraryFullTextSearch.init();
  CloudBackup.init();
  Pomodoro.init();
  TTSSystem.initVoiceSelector();
  initLibraryControls();
  initStickyHeader();
  refreshLibraryData();

  if (!store.onboardingDone) {
    setTimeout(() => OnboardingGuide.init(), 600);
  }

  if (!('ontouchstart' in window)) showKeyboardHint();

  console.log('📖 Fable Premium v5.0 — Initialized');
}

/* ══════════════════════════════════════════════════════════════════
   부트스트랩 — 크래시 격리 레이어
   ══════════════════════════════════════════════════════════════════ */
function _bootstrapFable() {
  try {
    const ret = initializeSystemCore();
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
