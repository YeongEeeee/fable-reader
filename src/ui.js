/**
 * ui.js
 * ───────────────────────────────────────────────────────────────
 * Fable Premium — UI 헬퍼 레이어 (store.js로부터 분리)
 *
 * 담당 책임:
 *   - 화면 전환 애니메이션 (Viewer ↔ Uploader)
 *   - LoadingOverlay  : 뷰어 전면 스피너
 *   - ResizeMask      : 리사이즈 중 마스킹
 *   - ImportProgress  : 서재 임포트 진행바
 *
 * ※ store.js 의 순수 상태 계층에서 DOM 조작 코드를 완전히 격리한다.
 *    이 모듈은 store / DOMProxy 를 단방향으로만 참조하며
 *    store.js 는 이 파일을 참조하지 않는다 (순환 참조 차단).
 * ─────────────────────────────────────────────────────────────── */

'use strict';

import { store, DOMProxy, setTextSafe } from './store.js';

/* ══════════════════════════════════════════════════════════
   §1. 화면 전환
   ══════════════════════════════════════════════════════════ */

/**
 * 업로더 → 뷰어 전환.
 * [버그2 보강] renderTo() 실행 전에 뷰어 컨테이너가 측정 가능한 크기를
 * 갖도록 display:flex 를 즉시 적용하고, 페이드-인만 rAF 로 처리한다.
 */
export function showViewerScreen() {
  const up = DOMProxy.get('screen-uploader');
  const vi = DOMProxy.get('screen-viewer');

  up.style.display    = 'none';
  up.style.opacity    = '';
  up.style.transform  = '';

  vi.style.display    = 'flex';
  vi.style.opacity    = '0';
  vi.style.transform  = 'scale(1.01)';
  vi.style.transition = 'opacity 280ms ease, transform 280ms ease';

  requestAnimationFrame(() => requestAnimationFrame(() => {
    vi.style.opacity   = '1';
    vi.style.transform = 'scale(1)';
  }));

  store.isViewerOpen = true;
}

/**
 * 뷰어 → 업로더 전환 (페이드-아웃 후 swap).
 */
export function showUploaderScreen() {
  const up = DOMProxy.get('screen-uploader');
  const vi = DOMProxy.get('screen-viewer');

  vi.style.transition = 'opacity 260ms ease';
  vi.style.opacity    = '0';

  setTimeout(() => {
    vi.style.display    = 'none';
    vi.style.opacity    = '';
    vi.style.transition = '';

    up.style.display    = 'flex';
    up.style.opacity    = '0';
    up.style.transition = 'opacity 260ms ease';

    requestAnimationFrame(() => requestAnimationFrame(() => {
      up.style.opacity = '1';
    }));

    setTimeout(() => { up.style.transition = ''; }, 300);
  }, 260);

  store.isViewerOpen = false;
}

/* ══════════════════════════════════════════════════════════
   §2. LoadingOverlay
   — 뷰어 전면을 덮는 스피너 (도서 로딩 중 표시)
   ══════════════════════════════════════════════════════════ */
export const LoadingOverlay = (() => {
  let el = null;

  function show(msg = '도서를 불러오는 중...') {
    if (el) return;
    el = document.createElement('div');
    el.className = 'loading-overlay';
    el.innerHTML = '<div class="spinner"></div>';
    const p = document.createElement('p');
    p.textContent = msg;
    el.appendChild(p);
    const vi = DOMProxy.get('screen-viewer');
    if (DOMProxy.exists('screen-viewer')) vi.appendChild(el);
  }

  function hide() {
    if (!el) return;
    el.classList.add('fade-out');
    setTimeout(() => { el?.remove(); el = null; }, 260);
  }

  return { show, hide };
})();

/* ══════════════════════════════════════════════════════════
   §3. ResizeMask
   — 윈도우 리사이즈 중 epub iframe 위를 덮어 깜빡임 방지
   ══════════════════════════════════════════════════════════ */
export const ResizeMask = {
  show() { DOMProxy.get('resize-mask').style.display = 'flex'; },
  hide() { DOMProxy.get('resize-mask').style.display = 'none'; },
};

/* ══════════════════════════════════════════════════════════
   §4. ImportProgress
   — 서재 EPUB 임포트 진행바 위젯
   ══════════════════════════════════════════════════════════ */
export const ImportProgress = (() => {
  function show(text = '도서 추가 중...') {
    const bar = DOMProxy.get('import-progress-bar');
    bar.style.display = 'flex';
    setTextSafe(DOMProxy.get('import-progress-text'), text);
    DOMProxy.get('import-progress-fill').style.width = '0%';
  }

  function update(pct, text) {
    DOMProxy.get('import-progress-fill').style.width = `${pct}%`;
    if (text) setTextSafe(DOMProxy.get('import-progress-text'), text);
  }

  function hide() {
    DOMProxy.get('import-progress-bar').style.display = 'none';
  }

  return { show, update, hide };
})();
