/**
 * src/main.js  ── Fable Premium v4.1
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
 *     (viewer.js export 제거에 따른 import 목록 동기화)
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
} from './viewer.js';
import {
  initFontUploader, initFontSelector, initCustomThemeBuilder,
  initV4SettingsUI,
  showKeyboardHint, initOfflineBanner, _saveStateToLS, _loadStateFromLS,
} from './settings.js';

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
   ※ registerReaderDeps() 호출보다 앞에 함수 선언식(function declaration)
     으로 정의해야 한다. JS 엔진은 함수 선언식을 호이스팅하므로
     registerReaderDeps({ handleKeyDown }) 참조 시점에 이미 확정된다.
   ══════════════════════════════════════════════════════════════════ */
function handleKeyDown(e) {
  const viewer = DOMProxy.get('screen-viewer');
  if (!DOMProxy.exists('screen-viewer') || viewer.style.display === 'none') return;
  if (!store.rendition) return;
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case ' ':
      e.preventDefault(); NavGuard.next(); break;
    case 'ArrowLeft': case 'ArrowUp': case 'Backspace':
      e.preventDefault(); NavGuard.prev(); break;
    case 'Escape':
      if (store.isSettingsOpen) { store.isSettingsOpen = false; break; }
      if (store.isTocOpen)      { store.isTocOpen      = false; break; }
      if (DOMProxy.get('search-modal')?.style.display === 'flex') {
        DOMProxy.get('search-modal').style.display = 'none'; break;
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
   ─────────────────────────────────────────────────────────────────
   handleKeyDown은 위에서 함수 선언식으로 정의되어 호이스팅 완료.
   AnnotationManager는 viewer.js에서 export된 객체를 직접 주입.
   (initAnnotationManager 래퍼는 viewer.js v4.1에서 제거됨)
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

  /* [v4.0] 신규 Reactive 바인더 */

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
   [버그 수정 v4.1] 누락 바인딩 전면 추가 + ID 오탈자 수정
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

  /* 목차 열기/닫기 버튼 */
  if (DOMProxy.exists('btn-toc-toggle')) {
    DOMProxy.get('btn-toc-toggle').addEventListener('click', () => {
      store.isTocOpen = !store.isTocOpen;
    });
  }

  /* [버그 수정] 목차 사이드바 X 닫기 버튼 — 누락된 바인딩 추가 */
  if (DOMProxy.exists('btn-toc-close')) {
    DOMProxy.get('btn-toc-close').addEventListener('click', () => {
      store.isTocOpen = false;
    });
  }

  /* 목차 오버레이 클릭 닫기 */
  if (DOMProxy.exists('toc-overlay')) {
    DOMProxy.get('toc-overlay').addEventListener('click', () => { store.isTocOpen = false; });
  }

  /* [버그 수정] 뷰어 닫기 — HTML ID는 btn-close-viewer, btn-exit-viewer 양쪽 대응 */
  if (DOMProxy.exists('btn-close-viewer')) {
    DOMProxy.get('btn-close-viewer').addEventListener('click', () => {
      if (confirm('뷰어를 닫고 서재로 돌아가시겠습니까?')) exitViewer();
    });
  }
  if (DOMProxy.exists('btn-exit-viewer')) {
    DOMProxy.get('btn-exit-viewer').addEventListener('click', () => {
      if (confirm('뷰어를 닫고 서재로 돌아가시겠습니까?')) exitViewer();
    });
  }

  /* 이전/다음 페이지 화살표 */
  if (DOMProxy.exists('arrow-prev'))
    DOMProxy.get('arrow-prev').addEventListener('click', () => NavGuard.prev());
  if (DOMProxy.exists('arrow-next'))
    DOMProxy.get('arrow-next').addEventListener('click', () => NavGuard.next());

  /* ── [버그 수정] 검색 모달 (🔍) — 누락 바인딩 추가 ── */
  if (DOMProxy.exists('btn-search-toggle')) {
    DOMProxy.get('btn-search-toggle').addEventListener('click', () => {
      const modal = DOMProxy.get('search-modal');
      if (!modal) return;
      const nowOpen = modal.style.display === 'flex';
      modal.style.display = nowOpen ? 'none' : 'flex';
      if (!nowOpen)
        setTimeout(() => { if (DOMProxy.exists('input-search-query')) DOMProxy.get('input-search-query').focus(); }, 60);
    });
  }
  if (DOMProxy.exists('btn-search-modal-close')) {
    DOMProxy.get('btn-search-modal-close').addEventListener('click', () => {
      DOMProxy.get('search-modal').style.display = 'none';
    });
  }

  /* 검색 실행 버튼 — btn-execute-search(HTML 실제 ID) + btn-search-exec(구버전) 양쪽 대응 */
  if (DOMProxy.exists('btn-execute-search'))
    DOMProxy.get('btn-execute-search').addEventListener('click', () => runSearchExecution());
  if (DOMProxy.exists('btn-search-exec'))
    DOMProxy.get('btn-search-exec').addEventListener('click', () => runSearchExecution());

  /* 검색 입력창 엔터/Esc */
  if (DOMProxy.exists('input-search-query')) {
    DOMProxy.get('input-search-query').addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  runSearchExecution();
      if (e.key === 'Escape') DOMProxy.get('search-modal').style.display = 'none';
    });
  }

  /* 레거시 인라인 검색 패널 (있으면 바인딩) */
  if (DOMProxy.exists('btn-search-open')) {
    DOMProxy.get('btn-search-open').addEventListener('click', () => {
      const panel = DOMProxy.get('search-panel');
      if (panel) panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    });
  }

  /* ── [버그 수정] 메모/하이라이트·TTS (✏️) — 누락 바인딩 추가 ──
     선택 텍스트가 있으면 낭독, 없으면 현재 페이지 본문 TTS 폴백     */
  if (DOMProxy.exists('btn-annotation-toggle')) {
    DOMProxy.get('btn-annotation-toggle').addEventListener('click', () => {
      let text = '';
      try {
        const vp = DOMProxy.get('viewer-viewport');
        if (vp) {
          vp.querySelectorAll('iframe').forEach(f => {
            const s = f.contentWindow?.getSelection()?.toString()?.trim();
            if (s) text = s;
          });
        }
        if (!text && store.rendition) {
          const contents = store.rendition.getContents?.() || [];
          const arr = Array.isArray(contents) ? contents : [contents];
          arr.forEach(c => {
            if (!text && c?.document?.body)
              text = c.document.body.textContent?.trim()?.slice(0, 3000) || '';
          });
        }
      } catch (_) {}
      if (text) TTSSystem.play(text);
      else Toast.show('낭독할 텍스트를 먼저 선택하거나 책을 열어주세요.', 'info');
    });
  }

  /* ── [버그 수정] 통계 모달 (📊) — 누락 바인딩 추가 ── */
  if (DOMProxy.exists('btn-stats-toggle')) {
    DOMProxy.get('btn-stats-toggle').addEventListener('click', async () => {
      const modal = DOMProxy.get('stats-modal');
      if (!modal) return;
      const nowOpen = modal.style.display === 'flex';
      if (nowOpen) {
        modal.style.display = 'none';
      } else {
        modal.style.display = 'flex';
        /* 독서 리포트 위젯 최신화 */
        try {
          const log = await StorageSystem.getReadingLog();
          ReadingReport.render(log, 'reading-report-widget');
        } catch (_) {}
      }
    });
  }
  if (DOMProxy.exists('btn-stats-modal-close')) {
    DOMProxy.get('btn-stats-modal-close').addEventListener('click', () => {
      DOMProxy.get('stats-modal').style.display = 'none';
    });
  }

  /* 독서 목표 저장 */
  if (DOMProxy.exists('btn-save-goal')) {
    DOMProxy.get('btn-save-goal').addEventListener('click', () => {
      const val = parseInt(DOMProxy.get('input-reading-goal')?.value || '30', 10);
      if (val > 0) {
        localStorage.setItem('fable_daily_goal', String(val));
        store.dailyGoalMin = val;
        Toast.show(`일일 독서 목표가 ${val}분으로 설정되었습니다.`, 'success');
      }
    });
  }

  /* ── TTS 컨트롤 ── */
  if (DOMProxy.exists('btn-tts-play-pause'))
    DOMProxy.get('btn-tts-play-pause').addEventListener('click', () => TTSSystem.pauseResume());
  if (DOMProxy.exists('btn-tts-stop'))
    DOMProxy.get('btn-tts-stop').addEventListener('click', () => TTSSystem.stop());
  /* 레거시 단일 토글 버튼 폴백 */
  if (DOMProxy.exists('btn-tts-toggle'))
    DOMProxy.get('btn-tts-toggle').addEventListener('click', () => TTSSystem.pauseResume());

  /* ── [버그 수정] 포모도로 (🍅) — btn-pomodoro-open 누락 추가 ── */
  if (DOMProxy.exists('btn-pomodoro-open'))
    DOMProxy.get('btn-pomodoro-open').addEventListener('click', () => Pomodoro.openPopup());

  /* ── flow 전환 버튼 ── */
  DOMProxy.qa('[data-flow]').forEach(b => {
    b.addEventListener('click', () => { switchFlowMode(b.dataset.flow); _saveStateToLS(); });
  });

  /* ── 테마 스와치 ── */
  DOMProxy.qa('.theme-swatch').forEach(b => {
    b.addEventListener('click', () => { store.theme = b.dataset.theme; _saveStateToLS(); });
  });

  /* ── [버그 수정] 폰트 크기 — HTML ID는 btn-font-decrease/increase,
     구버전 btn-font-minus/plus 도 함께 대응                           ── */
  if (DOMProxy.exists('btn-font-decrease'))
    DOMProxy.get('btn-font-decrease').addEventListener('click', () => {
      store.fontSize = Math.max(60, store.fontSize - 5); _saveStateToLS();
    });
  if (DOMProxy.exists('btn-font-minus'))
    DOMProxy.get('btn-font-minus').addEventListener('click', () => {
      store.fontSize = Math.max(60, store.fontSize - 5); _saveStateToLS();
    });
  if (DOMProxy.exists('btn-font-increase'))
    DOMProxy.get('btn-font-increase').addEventListener('click', () => {
      store.fontSize = Math.min(200, store.fontSize + 5); _saveStateToLS();
    });
  if (DOMProxy.exists('btn-font-plus'))
    DOMProxy.get('btn-font-plus').addEventListener('click', () => {
      store.fontSize = Math.min(200, store.fontSize + 5); _saveStateToLS();
    });

  /* ── 행간 버튼 ── */
  DOMProxy.qa('[data-lh]').forEach(b => {
    b.addEventListener('click', () => { store.lineHeight = b.dataset.lh; _saveStateToLS(); });
  });

  /* ── [v4.0] 눈 보호 타이머 ── */
  if (DOMProxy.exists('btn-eye-protect'))
    DOMProxy.get('btn-eye-protect').addEventListener('click', () => EyeProtectTimer.toggle());

  /* ── [v4.0] 자동 스크롤 — 실제 view 객체를 안전하게 추출해 전달 ── */
  if (DOMProxy.exists('btn-auto-scroll')) {
    DOMProxy.get('btn-auto-scroll').addEventListener('click', () => {
      /* rendition.manager.views() 는 현재 렌더된 view 배열을 반환 */
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

  /* ── [버그 수정] 스크러버 HUD — HTML ID 'slider-tooltip' 으로 수정
     (기존 코드는 존재하지 않는 'scrubber-tooltip' 을 참조해
      DOMProxy.exists 가드에서 즉시 반환 → 슬라이더 전체 비활성화)  ── */
  _initScrubberHoverHUD();

  /* ── 설정 패널 외부 클릭 닫기 ── */
  document.addEventListener('pointerdown', (e) => {
    /* 설정 패널 */
    const panel = DOMProxy.get('settings-panel');
    const btnV  = DOMProxy.get('btn-settings-toggle');
    const btnL  = DOMProxy.get('btn-library-settings');
    if (store.isSettingsOpen &&
        !panel.contains?.(e.target) &&
        !btnV.contains?.(e.target) &&
        !btnL.contains?.(e.target)) {
      store.isSettingsOpen = false;
    }
    /* 검색 모달 외부 클릭 닫기 */
    const searchModal = DOMProxy.get('search-modal');
    if (searchModal && searchModal.style.display === 'flex') {
      const btnSearch = DOMProxy.get('btn-search-toggle');
      if (!searchModal.contains?.(e.target) && !btnSearch?.contains?.(e.target))
        searchModal.style.display = 'none';
    }
    /* 통계 모달 외부 클릭 닫기 */
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
   [버그 수정] tooltip ID: 'scrubber-tooltip' → 'slider-tooltip'
   ══════════════════════════════════════════════════════════════════ */
function _initScrubberHoverHUD() {
  const slider  = DOMProxy.get('progress-range-slider');
  /*
   * [버그 수정] HTML 실제 ID 는 'slider-tooltip'.
   * 기존 'scrubber-tooltip' 은 존재하지 않아 DOMProxy.exists() 가드에서
   * 즉시 return → 슬라이더 hover/drag 이벤트 전체가 바인딩되지 않았음.
   */
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
      /* 자식 요소가 있으면 개별 업데이트 */
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
   §36-B. Settings UI 동기화 강제 초기화
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

/* ══════════════════════════════════════════════════════════════════
   §38. 전역 진입점 — 비동기 초기화 시퀀스
   ══════════════════════════════════════════════════════════════════ */
async function initializeSystemCore() {
  /*
   * [B1] 비동기 런타임 가드 레이어
   * epub.js 로드 여부와 UI 기동을 완전 분리.
   * 실제 책을 열 때 waitForEpubJS()로 가용성 확인.
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
      try {
        localStorage.setItem(
          'fable_cfi_' + store.bookKey,
          JSON.stringify({ data: store.currentCFI, ts: Date.now() })
        );
      } catch (_) {}
    }
    try { StorageSystem.flushProgressNow(); } catch (_) {}
  });

  /* [스마트 슬립 가드] visibilitychange → store.appInBackground */
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

  /* 신규 모듈 초기화 */
  MetadataEditor.init();
  AnnotationExporter.init();
  LibraryFullTextSearch.init();
  CloudBackup.init();
  Pomodoro.init();
  initLibraryControls();
  initStickyHeader();
  refreshLibraryData();

  /* [v4.0] 최초 진입 시 온보딩 가이드 실행
     [버그 수정] OnboardingGuide.start() → OnboardingGuide.init() */
  if (!store.onboardingDone) {
    setTimeout(() => OnboardingGuide.init(), 600);
  }

  if (!('ontouchstart' in window)) showKeyboardHint();

  console.log('📖 Fable Premium v4.1 — Initialized');
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
