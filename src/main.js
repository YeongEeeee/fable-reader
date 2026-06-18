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
  QuickSettingsHint,    // <-- [버그 수정 C-7] 첫 뷰어 진입 시 팝오버 안내
  PageTransitionEngine, // <-- [v5.0] 고도화 #6/#8 — will-change 동적 동기화
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

   [🚨 핵심 버그 수정] 이중 키보드 이벤트 버블링 차단
   ─────────────────────────────────────────────────────────────────
   iframe 내부(rendition.on('keydown', ...))와 메인 윈도우
   (document.addEventListener('keydown', handleKeyDown)) 양쪽에서
   동일한 ArrowLeft/ArrowRight 입력이 중복 처리되거나, 브라우저 고유
   스크롤 동작과 충돌해 "화면만 들썩이는" 현상의 보조 원인이 되었다.
   e.preventDefault() 만으로는 이미 상위로 전파된 네이티브 스크롤
   유발 동작(예: 포커스 이동에 따른 scrollIntoView)을 막지 못하는
   경우가 있어, stopPropagation() + stopImmediatePropagation() 까지
   체인으로 호출하여 동일 타깃에 등록된 다른 리스너로의 전파와 상위
   전파를 모두 차단한다.

   [v4.2 가드] 전문 검색 활성 상태 또는 검색 모달 내 인풋 포커스 중에는
   Space·방향키 이벤트를 preventDefault 없이 즉시 return 한다.

   [버그 수정 — A-4] Active Element 예외 처리 강화
   ─────────────────────────────────────────────────────────────────
   포커스가 input/textarea 뿐 아니라 contenteditable 요소, 또는
   커스텀 셀렉터 팝업(quick-settings-popover, context-menu 등) 내부에
   있을 때도 방향키/Space가 페이지 탐색으로 오작동하지 않도록
   document.activeElement 기반 검사를 전면 강화한다.
   ══════════════════════════════════════════════════════════════════ */
function _isEditableActiveElement() {
  const ae = document.activeElement;
  if (!ae) return false;
  const tag = ae.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  /* [A-4] contenteditable 요소 (메모 입력 등) 포커스 가드 */
  if (ae.isContentEditable) return true;
  try {
    if (typeof ae.closest === 'function' &&
        ae.closest('[contenteditable="true"], [contenteditable=""]')) return true;
  } catch (_) {}
  return false;
}

function _isInsideCustomPopup() {
  const ae = document.activeElement;
  if (!ae || typeof ae.closest !== 'function') return false;
  /* [A-4] 커스텀 셀렉터 팝업(빠른 설정 팝오버, 컨텍스트 메뉴, FTS 모달 등)
     내부에 포커스가 있을 때는 단축키를 페이지 탐색으로 해석하지 않는다. */
  try {
    return !!ae.closest('#quick-settings-popover, #context-menu, #fts-modal, #search-modal, #pomodoro-popup, #onboarding-overlay');
  } catch (_) { return false; }
}

/*
 * ══════════════════════════════════════════════════════════════════
 * [v5.0 신규 — 고도화 #10] Escape 키 전역 모달 체인 우선순위 큐
 * ──────────────────────────────────────────────────────────────────
 * 기존 한계: handleKeyDown의 'Escape' 분기가 if문을 위에서부터 순서대로
 * 검사하는 하드코딩된 체인이었다. 이 방식은 두 가지 문제를 안고 있다:
 *   1) 새로운 모달/팝업이 추가될 때마다 "어느 if문 사이에 끼워 넣어야
 *      논리적으로 옳은 닫힘 순서가 되는지"를 매번 사람이 판단해 코드를
 *      직접 편집해야 했다 — 우선순위가 코드 작성 순서에 암묵적으로
 *      흩어져 있어 유지보수 시 실수 위험이 크다.
 *   2) pomodoro-popup, context-menu처럼 _isInsideCustomPopup()의
 *      예외 목록에는 포함되어 있지만 Escape 분기 자체에는 닫는 로직이
 *      없는 모달이 존재해, 해당 팝업에 포커스가 있을 때 Escape를 눌러도
 *      아무 반응이 없는 누락 사례가 있었다.
 *
 * 해결: 모든 닫을 수 있는 오버레이를 ESCAPE_LAYER_REGISTRY 배열에
 * { id, priority, isOpen(), close() } 형태로 선언적으로 등록한다.
 * Escape 키 입력 시:
 *   1) isOpen()이 true인 엔트리만 후보로 추린다.
 *   2) priority 내림차순(숫자가 클수록 시각적으로 더 위 — 실제 CSS
 *      z-index 값과 동일한 의미 체계)으로 정렬한다.
 *   3) 가장 위에 있는 엔트리 단 하나만 close()를 호출한다.
 * 이로써 "어떤 레이어가 가장 위에 떠 있는가"라는 순수한 우선순위
 * 데이터만으로 닫힘 순서가 자동 결정되며, 새 모달 추가 시에는 배열에
 * 항목 하나를 추가하는 것만으로 충분하다 — if-체인 순서를 다시 검토할
 * 필요가 없다. 후보가 전혀 없으면(모든 오버레이가 닫힌 상태) 뷰어
 * 종료 확인 다이얼로그로 폴백한다(기존 동작 보존).
 * ══════════════════════════════════════════════════════════════════ */
const ESCAPE_LAYER_REGISTRY = [
  {
    id: 'quick-settings-popover',
    priority: 9950, /* 뷰어 탭 팝오버 — 가장 자주 열리는 경량 오버레이, 최상단 */
    isOpen:  () => !!store.quickPopoverOpen,
    close:   () => QuickSettingsPopover.close(),
  },
  {
    id: 'context-menu',
    priority: 9900,
    isOpen:  () => DOMProxy.exists('context-menu')
                   && DOMProxy.get('context-menu').style.display !== 'none',
    /* viewer.js의 hideMenu()와 동일한 트랜지션 패턴(슬라이드 다운 후
       280ms 뒤 display:none)을 따라 즉시 끊기는 느낌 없이 닫는다. */
    close:   () => {
      const m = DOMProxy.get('context-menu');
      m.classList.remove('slide-up');
      setTimeout(() => { m.style.display = 'none'; }, 280);
    },
  },
  {
    id: 'pomodoro-popup',
    priority: 9800,
    isOpen:  () => DOMProxy.get('pomodoro-popup')?.style.display === 'flex',
    close:   () => { Pomodoro.pause(); DOMProxy.get('pomodoro-popup').style.display = 'none'; },
  },
  {
    id: 'fts-modal',
    priority: 600,
    isOpen:  () => DOMProxy.get('fts-modal')?.style.display === 'flex',
    close:   () => { DOMProxy.get('fts-modal').style.display = 'none'; store.isSearching = false; },
  },
  {
    id: 'search-modal',
    priority: 500,
    isOpen:  () => DOMProxy.get('search-modal')?.style.display === 'flex',
    close:   () => { DOMProxy.get('search-modal').style.display = 'none'; store.isSearching = false; },
  },
  {
    id: 'stats-modal',
    priority: 400,
    isOpen:  () => DOMProxy.get('stats-modal')?.style.display === 'flex',
    close:   () => { DOMProxy.get('stats-modal').style.display = 'none'; },
  },
  {
    id: 'settings-panel',
    priority: 300,
    isOpen:  () => !!store.isSettingsOpen,
    close:   () => { store.isSettingsOpen = false; },
  },
  {
    id: 'toc-sidebar',
    priority: 200,
    isOpen:  () => !!store.isTocOpen,
    close:   () => { store.isTocOpen = false; },
  },
];

/**
 * 현재 열려 있는 오버레이 중 우선순위(priority)가 가장 높은 단 하나만
 * 닫는다. 닫을 대상이 없으면 false를 반환해 호출부가 폴백 동작(뷰어
 * 종료 확인)을 수행할 수 있게 한다.
 */
function _closeTopmostOverlay() {
  const openLayers = ESCAPE_LAYER_REGISTRY.filter(layer => {
    try { return layer.isOpen(); } catch (_) { return false; }
  });
  if (!openLayers.length) return false;

  openLayers.sort((a, b) => b.priority - a.priority);
  const top = openLayers[0];
  try { top.close(); } catch (e) { ErrorBoundary.handle('global', e, 'escapeLayer:' + top.id); }
  return true;
}

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

  /* [A-4] 입력 가능 요소 또는 커스텀 팝업에 포커스가 있으면 단축키를
     완전히 무시하고 네이티브 동작(타이핑 등)을 그대로 허용한다. */
  if (_isEditableActiveElement() || _isInsideCustomPopup()) {
    if (e.key === 'Escape') {
      /* Escape는 입력 중에도 모달/팝업을 닫을 수 있어야 하므로 예외적으로 통과 */
    } else {
      return;
    }
  }

  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case ' ':
      if (_isSearchActive()) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      NavGuard.next(); break;
    case 'ArrowLeft': case 'ArrowUp': case 'Backspace':
      if (_isSearchActive()) return;
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      NavGuard.prev(); break;
    case 'Escape':
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      /* [v5.0] 우선순위 큐 기반 — 가장 위에 떠 있는 오버레이 하나만
         닫는다. 닫을 오버레이가 전혀 없으면 뷰어 종료 확인으로 폴백. */
      if (_closeTopmostOverlay()) break;
      if (confirm('뷰어를 닫고 서재로 돌아가시겠습니까?')) exitViewer();
      break;
    default: break;
  }
}

/*
 * [🚨 핵심 버그 수정 + A-1] iframe 포커스 소실 검증
 * ─────────────────────────────────────────────────────────────────
 * 뷰어 내부 iframe을 클릭하면 포커스가 iframe 내부 document로 이동해,
 * 메인 윈도우(document)에 바인딩된 handleKeyDown이 keydown 이벤트를
 * 전혀 수신하지 못하는 현상이 발생한다. epub.js는 rendition.on('keydown')
 * 으로 iframe 내부 이벤트를 별도로 전달해주지만(reader.js에서 처리),
 * 일부 환경(예: iframe sandbox 제약, 포커스 전환 타이밍)에서는 이 경로도
 * 누락될 수 있다. 이를 보강하기 위해 iframe에 포커스가 진입할 때마다
 * 메인 윈도우로 포커스를 즉시 되돌리지는 않되(텍스트 선택/TTS 등 iframe
 * 내부 상호작용을 방해하면 안 되므로), capture 단계에서 메인 document의
 * keydown 리스너가 항상 우선 실행되도록 보장한다.
 * (document.addEventListener의 capture:true 옵션으로 버블링 단계보다
 *  먼저 가로채어, 이중 처리 시에도 항상 메인 핸들러가 단일 진실
 *  공급원이 되도록 한다.)
 */



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
  /* [버그 수정 — A-6] 좀비 TTS 오디오 정리 — 뷰어 종료/도서 전환 시
     reader.js의 destroyCurrentRenditionContext()가 이 콜백을 통해
     TTSSystem.stop()을 호출하여 speechSynthesis.cancel()을 보장한다. */
  stopTTS: TTSSystem.stop,
});

/* ══════════════════════════════════════════════════════════════════
   [v5.0] §ZEN. 젠 모드 오케스트레이션
   ─────────────────────────────────────────────────────────────────
   뷰어 화면이 활성 상태이고 store.fxZenMode === true 일 때,
   설정 가능한 비활동 시간(store.zenIdleDelaySec, 기본 2초) 동안
   포인터/터치 입력이 없으면 body에 zen-mode-active 클래스를 추가하여
   상하단 바를 CSS transition으로 페이드아웃 한다.
   포인터 이동/터치 발생 시 클래스를 즉시 제거한다.

   [버그 수정 — C-6] 젠 모드 진입 타이밍 커스텀 제어
   ─────────────────────────────────────────────────────────────────
   기존에는 ZEN_DELAY_MS가 2000으로 하드코딩되어 사용자가 진입
   타이밍을 조절할 방법이 없었다. store.zenIdleDelaySec(설정 패널의
   슬라이더로 1~10초 범위 조절 가능)을 매 타이머 리셋 시점에 다시
   읽어, 설정 변경이 다음 비활동 감지부터 즉시 반영되도록 한다.
   ══════════════════════════════════════════════════════════════════ */
function initZenMode() {
  /* 내부 상태 */
  let _zenTimer       = null;
  let _zenActive      = false;
  const ZEN_DELAY_FALLBACK_MS = 2000; /* CSS --fx-zen-idle-delay 기본값과 동기화 */

  /* [C-6] store.zenIdleDelaySec(초 단위, 사용자 설정)을 ms로 환산.
     유효하지 않은 값(범위 밖, NaN)이면 기존 기본값(2초)으로 폴백한다. */
  function _getZenDelayMs() {
    const sec = Number(store.zenIdleDelaySec);
    if (!Number.isFinite(sec) || sec < 1 || sec > 10) return ZEN_DELAY_FALLBACK_MS;
    return Math.round(sec * 1000);
  }

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
    _zenTimer = setTimeout(_enterZen, _getZenDelayMs());
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
        /* [버그 수정 — C-8] 다크모드 전환 시 스마트 하이라이터 컬러 보정 —
           이미 그려진 형광펜을 테마에 맞는 fill/opacity로 재도색한다. */
        try { AnnotationManager.repaintForTheme(); } catch (_) {}
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
     — 서재 화면으로 복귀했는데 팝오버가 잔존하는 현상 방지
     [버그 수정 — C-7] 뷰어 진입 시에는 QuickSettingsHint를 1회성으로
     트리거한다. localStorage 가드가 내부에 있어 이미 본 사용자에게는
     아무 동작도 하지 않는다. */
  ReactiveStore.subscribe('isViewerOpen', (open) => {
    if (!open && store.quickPopoverOpen) QuickSettingsPopover.close();
    if (open) QuickSettingsHint.maybeShow();
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

  /* [v5.0 버그 수정] 독서 리포트 HUD 표시 토글 — 이전에는 store 값만
     바뀌고 실제 #dashboard-section의 표시 여부를 제어하는 구독자가
     없어 토글이 화면에 아무 영향도 주지 못했다. 여기서 실제 DOM
     반영을 담당한다.
     [버그 수정 — C-2] display:none 즉시 전환 대신 .hud-collapsed
     클래스를 토글하여 fx.css의 max-height/opacity 트랜지션이 적용된
     슬라이딩 다운/업 아코디언 애니메이션으로 동작하도록 한다. */
  ReactiveStore.subscribe('showDashboardReport', (visible) => {
    if (DOMProxy.exists('dashboard-section'))
      DOMProxy.get('dashboard-section').classList.toggle('hud-collapsed', visible === false);
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

  /* ── 페이지 이동 (실제 DOM ID: arrow-prev / arrow-next) ── */
  if (DOMProxy.exists('arrow-prev'))
    DOMProxy.get('arrow-prev').addEventListener('click', () => NavGuard.prev());
  if (DOMProxy.exists('arrow-next'))
    DOMProxy.get('arrow-next').addEventListener('click', () => NavGuard.next());

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

  /* [🚨 핵심 버그 수정 + A-1] capture:true — iframe 포커스 이동 등으로
     버블링 단계가 어긋나는 경우에도 메인 핸들러가 항상 우선 가로채도록
     캡처 단계에서 등록한다. */
  document.addEventListener('keydown', handleKeyDown, { capture: true });

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

/*
 * ══════════════════════════════════════════════════════════════════
 * §36-C. [v5.0 신규 — 고도화 #8] 설정 동기화 3-Way 바인딩
 * 파이프라인 단일화
 * ──────────────────────────────────────────────────────────────────
 * 기존 한계: _loadStateFromLS()(LS→Store)와 _forceSyncSettingsUI()
 * (Store→UI)가 부팅 시퀀스에서 별개의 두 호출로 분리되어 있었다.
 * 두 호출 사이의 짧은 간극에서 다른 비동기 경로(예: ReactiveStore
 * 구독 콜백, StorageSystem.init() 완료 콜백 등)가 store 값을 먼저
 * 건드리면, "LS에서 막 복원된 값"과 "화면에 그려질 값"이 어긋나는
 * 순간이 생길 수 있었다. 또한 각 개별 설정 위젯(슬라이더/스위치)이
 * change 핸들러 안에서 직접 _saveStateToLS()를 호출하는 분산 패턴은,
 * 여러 입력이 거의 동시에 바뀔 때 LS 쓰기가 중복 직렬화되는 비효율도
 * 동반했다.
 *
 * 해결: LS→Store(_loadStateFromLS)와 Store→UI(_forceSyncSettingsUI)를
 * _atomicSyncSettingsPipeline() 단일 함수로 묶어 항상 같은 순서로
 * 동기 실행되도록 원자성(Atomicity)을 보장한다. 이 함수가 시작되면
 * 중간에 다른 코드가 끼어들 수 없는 순수 동기 호출 체인이므로(await
 * 지점이 없음), "부분적으로만 반영된" 상태가 외부에 노출될 가능성이
 * 구조적으로 제거된다. 부팅 시퀀스뿐 아니라, 향후 "설정 초기화" 같은
 * 기능이 추가되어 LS를 다시 읽고 UI를 강제 재동기화해야 할 때도 항상
 * 이 단일 진입점을 통하도록 한다.
 * ══════════════════════════════════════════════════════════════════ */
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

  /* [v5.0 — 고도화 #6 연계] 페이지 전환 모드에 맞춰 viewer-viewport의
     will-change 가속 힌트를 부팅 시점에도 즉시 동기화한다. */
  PageTransitionEngine.syncHardwareAcceleration(store.pageTransition || 'fade');

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

  /* [v5.0 버그 수정] 독서 리포트 HUD 표시 상태 부팅 시 즉시 동기화
     — ReactiveStore.subscribe는 향후 변경에만 반응하므로, 부팅 시점의
     초기 값은 명시적으로 한 번 적용해야 한다.
     [버그 수정 — C-2] 부팅 시 접힌 상태라면 애니메이션 없이 즉시
     max-height:0으로 시작하도록 transition을 임시로 끈 뒤 한 프레임
     후 복원한다 — 페이지 로드 직후 불필요한 슬라이드 모션이 보이는
     것을 방지한다. */
  if (DOMProxy.exists('dashboard-section')) {
    const dashEl = DOMProxy.get('dashboard-section');
    const collapsed = store.showDashboardReport === false;
    if (collapsed) {
      dashEl.style.transition = 'none';
      dashEl.classList.add('hud-collapsed');
      requestAnimationFrame(() => { dashEl.style.transition = ''; });
    } else {
      dashEl.classList.remove('hud-collapsed');
    }
  }
}

/**
 * [v5.0 신규 — 고도화 #8] LS → Store → UI 원자적 동기화 진입점.
 * 항상 이 함수를 통해서만 "설정 전체 재동기화"를 수행하도록 강제하여,
 * _loadStateFromLS()와 _forceSyncSettingsUI()가 분리 호출되며 발생할
 * 수 있는 중간 불일치 윈도우를 구조적으로 차단한다. 두 단계 모두
 * 동기 함수이므로 이 함수 실행 도중에는 다른 매크로/마이크로태스크가
 * 끼어들 수 없다(자바스크립트 단일 스레드 실행 모델 + await 부재).
 */
function _atomicSyncSettingsPipeline() {
  _loadStateFromLS();      /* 1) LS → Store */
  _forceSyncSettingsUI();  /* 2) Store → UI (애니메이션/가속 힌트까지 포함) */
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
    /*
     * [버그 수정 — D-9] 스크롤 시에만 헤더 하단 경계선 노출
     * ─────────────────────────────────────────────────────────────
     * fx.css의 #library-topbar.is-scrolled 규칙이 본문과의 시각적
     * 경계(글래스모피즘 보더 + 미세 그림자)를 그려준다. 4px의 작은
     * 임계값을 둔 것은 스크롤 0 근처에서 미세한 휠 떨림으로 클래스가
     * 깜빡이는 것을 방지하기 위함이다.
     */
    topbar.classList.toggle('is-scrolled', y > 4);
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
  /* [v5.0] LS→Store→UI 원자적 동기화 — 분리 호출로 인한 중간 불일치
     윈도우를 차단한다(고도화 #8). */
  _atomicSyncSettingsPipeline();
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
