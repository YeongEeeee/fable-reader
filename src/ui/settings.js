/**
 * src/ui/settings.js  ── Fable Premium v4.0
 * ───────────────────────────────────────────────────────────────────
 * 공용 설정 UI (서재/뷰어 양쪽에서 사용)
 *
 * 변경 사항 (v4.0):
 *   - [1] fontWeightBoost 슬라이더 바인딩 (E-Ink 폰트 굵기 보정)
 *   - [1] contrastScale 슬라이더 바인딩 (대비 미세 조절)
 *   - [1] eyeProtectMinutes 입력 바인딩 (눈 보호 타이머 시간 설정)
 *   - [3] pageTransition 라디오 바인딩 (fade|slide|flip3d)
 *   - [2] FontLazyLoader.apply() → waitForFontsWithTimeout 1.5s 가드 통합
 *   - STATE_KEY 저장 항목 확장
 * ───────────────────────────────────────────────────────────────────
 */

'use strict';

import {
  store, ReactiveStore, DOMProxy, Toast, setTextSafe, STATE_KEY,
} from '../store.js';
import { AnnotationSyncEngine } from '../sync.js';
import { injectCustomToIframe, reapplyInlineTheme, waitForFontsWithTimeout } from '../reader.js';

/* ══════════════════════════════════════════════════════════════════
   §30. 폰트 업로더
   ══════════════════════════════════════════════════════════════════ */
function initFontUploader() {
  if (!DOMProxy.exists('font-uploader')) return;
  DOMProxy.get('font-uploader').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      const safeId = 'custom_' + Math.random().toString(36).slice(2, 10);
      try {
        const face = new FontFace(safeId, `url(${evt.target.result})`);
        const loaded = await face.load(); document.fonts.add(loaded);
        if (store.rendition) { store.rendition.themes.font(safeId); Toast.show('커스텀 폰트가 적용되었습니다.', 'success'); }
      } catch (err) { Toast.show(`폰트 로드 실패: ${err.message}`, 'error'); }
    };
    reader.readAsDataURL(file); e.target.value = '';
  });
}

/* ══════════════════════════════════════════════════════════════════
   [2]-2 오프라인 폰트 동적 로딩 (Font Lazy Loading)
   서체 선택 시점에만 @font-face / Google Fonts를 비동기 인젝션
   [v4.0] waitForFontsWithTimeout 1.5s 가드 통합
   ══════════════════════════════════════════════════════════════════ */
const FontLazyLoader = (() => {
  const loaded = new Set();
  /* 폰트 정의: id → { label, family, href(웹폰트), local(시스템) } */
  const FONTS = {
    'gowun':  { label: '고운바탕', family: "'Gowun Batang', serif",        href: 'https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&display=swap' },
    'noto':   { label: '본명조',   family: "'Noto Serif KR', serif",        href: 'https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;700&display=swap' },
    'sans':   { label: '본고딕',   family: "'Noto Sans KR', sans-serif",    href: 'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;700&display=swap' },
    'nanum':  { label: '나눔명조', family: "'Nanum Myeongjo', serif",       href: 'https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@400;700&display=swap' },
    'system': { label: '시스템',   family: 'system-ui, -apple-system, sans-serif', href: null },
  };

  function _injectStylesheet(href) {
    return new Promise((resolve) => {
      if (!href) return resolve();
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = href;
      link.onload = () => resolve(); link.onerror = () => resolve();
      document.head.appendChild(link);
    });
  }

  /**
   * 선택 시점에만 비동기 로드 후 rendition에 적용
   * [v4.0] waitForFontsWithTimeout 1.5s 타임아웃 가드:
   *   - document.fonts.load가 무한 대기에 빠지지 않도록 보호
   *   - 타임아웃 시 시스템 기본 서체로 자동 폴백
   */
  async function apply(fontId) {
    const def = FONTS[fontId];
    if (!def) return;
    if (!loaded.has(fontId)) {
      Toast.show(`${def.label} 서체 로딩 중...`, 'info');
      await _injectStylesheet(def.href);
      /* [v4.0] 1.5초 타임아웃 가드 — 무한 대기 차단 */
      if (def.href) {
        const fontLoaded = await waitForFontsWithTimeout(def.family, 1500);
        if (!fontLoaded) {
          /* 폴백: 시스템 서체 유지하고 경고만 표시 */
          console.warn(`[FontLazyLoader] ${def.label} 폰트 로딩 타임아웃 — 시스템 서체로 폴백`);
          Toast.show(`${def.label} 로딩이 지연되어 시스템 서체를 사용합니다.`, 'info');
        }
      }
      loaded.add(fontId);
    }
    if (store.rendition) {
      try { store.rendition.themes.override('font-family', def.family + ' !important'); } catch (_) {}
      /* [버그 3B] 인라인 테마도 즉시 재주입 (현재 iframe 문서에 반영) */
      try { reapplyInlineTheme(); } catch (_) {}
    }
    store.fontFamily = fontId;
    localStorage.setItem('fable_font_family', fontId);
  }

  function list() { return Object.entries(FONTS).map(([id, d]) => ({ id, label: d.label })); }
  return { apply, list, FONTS };
})();

function initFontSelector() {
  const sel = DOMProxy.get('font-family-select');
  if (!DOMProxy.exists('font-family-select')) return;
  /* 옵션 채우기 */
  sel.innerHTML = '';
  FontLazyLoader.list().forEach(({ id, label }) => {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = label;
    sel.appendChild(opt);
  });
  const saved = localStorage.getItem('fable_font_family') || 'gowun';
  sel.value = saved;
  sel.addEventListener('change', () => FontLazyLoader.apply(sel.value));
}


/* ══════════════════════════════════════════════════════════════════
   §31. 커스텀 테마 빌더
   ══════════════════════════════════════════════════════════════════ */
function initCustomThemeBuilder() {
  function syncColor(colorId, hexId, storeKey) {
    if (!DOMProxy.exists(colorId) || !DOMProxy.exists(hexId)) return;
    const colorEl = DOMProxy.get(colorId), hexEl = DOMProxy.get(hexId);
    colorEl.addEventListener('input', () => { const v = colorEl.value; hexEl.value = v; store[storeKey] = v; _saveStateToLS(); });
    hexEl.addEventListener('input', () => { const v = hexEl.value.trim(); if (/^#[0-9A-Fa-f]{6}$/.test(v)) { colorEl.value = v; store[storeKey] = v; _saveStateToLS(); } });
  }
  syncColor('input-user-bg',  'input-user-bg-hex',  'userBg');
  syncColor('input-user-ink', 'input-user-ink-hex', 'userInk');

  if (DOMProxy.exists('input-user-spacing')) {
    DOMProxy.get('input-user-spacing').addEventListener('input', () => {
      const v = parseFloat(DOMProxy.get('input-user-spacing').value);
      setTextSafe(DOMProxy.get('spacing-val'), v + 'em'); store.userSpacing = v; _saveStateToLS();
    });
  }
  if (DOMProxy.exists('input-user-leading')) {
    DOMProxy.get('input-user-leading').addEventListener('input', () => {
      const v = parseFloat(DOMProxy.get('input-user-leading').value);
      setTextSafe(DOMProxy.get('leading-val'), String(v)); store.userLeading = v; _saveStateToLS();
    });
  }
}


/* ══════════════════════════════════════════════════════════════════
   [v4.0] §31-A. 폰트 굵기 보정 슬라이더 (fontWeightBoost)
   E-Ink 단말기 및 저가형 디바이스용 가독성 향상
   범위: -100 ~ +400 (기본 0)
   ══════════════════════════════════════════════════════════════════ */
function initFontWeightBoostSlider() {
  const slider  = DOMProxy.get('input-font-weight-boost');
  const display = DOMProxy.get('font-weight-boost-val');
  if (!DOMProxy.exists('input-font-weight-boost')) return;

  /* 초기값 동기 */
  slider.value = String(store.fontWeightBoost ?? 0);
  setTextSafe(display, String(store.fontWeightBoost ?? 0));

  slider.addEventListener('input', () => {
    const v = parseInt(slider.value, 10);
    store.fontWeightBoost = v;
    setTextSafe(display, String(v));
    _saveStateToLS();
    /* 즉시 iframe 재주입 */
    try { reapplyInlineTheme(); } catch (_) {}
  });

  /* ReactiveStore 구독 — 외부(main.js)에서 store 변경 시 UI 동기화 */
  ReactiveStore.subscribe('fontWeightBoost', (v) => {
    if (slider.value !== String(v)) {
      slider.value = String(v);
      setTextSafe(display, String(v));
    }
  });
}

/* ══════════════════════════════════════════════════════════════════
   [v4.0] §31-B. 대비 스케일러 슬라이더 (contrastScale)
   범위: 0.5 ~ 2.0 (기본 1.0, 소수점 0.05 단위)
   ══════════════════════════════════════════════════════════════════ */
function initContrastScaleSlider() {
  const slider  = DOMProxy.get('input-contrast-scale');
  const display = DOMProxy.get('contrast-scale-val');
  if (!DOMProxy.exists('input-contrast-scale')) return;

  const fmt = (v) => parseFloat(v).toFixed(2);
  slider.value = String(store.contrastScale ?? 1.0);
  setTextSafe(display, fmt(store.contrastScale ?? 1.0));

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    store.contrastScale = v;
    setTextSafe(display, fmt(v));
    _saveStateToLS();
    try { reapplyInlineTheme(); } catch (_) {}
  });

  ReactiveStore.subscribe('contrastScale', (v) => {
    const s = String(v);
    if (slider.value !== s) {
      slider.value = s;
      setTextSafe(display, fmt(v));
    }
  });
}

/* ══════════════════════════════════════════════════════════════════
   [v4.0] §31-C. 눈 보호 타이머 분 설정 (eyeProtectMinutes)
   독립 number input — 기본 50분
   ══════════════════════════════════════════════════════════════════ */
function initEyeProtectMinutesInput() {
  const input   = DOMProxy.get('input-eye-protect-minutes');
  const display = DOMProxy.get('eye-protect-minutes-val');
  if (!DOMProxy.exists('input-eye-protect-minutes')) return;

  const val = store.eyeProtectMinutes ?? 50;
  input.value = String(val);
  setTextSafe(display, String(val) + '분');

  input.addEventListener('change', () => {
    const v = Math.max(5, Math.min(120, parseInt(input.value, 10) || 50));
    input.value = String(v);
    store.eyeProtectMinutes = v;
    setTextSafe(display, String(v) + '분');
    _saveStateToLS();
  });

  ReactiveStore.subscribe('eyeProtectMinutes', (v) => {
    if (input.value !== String(v)) {
      input.value = String(v);
      setTextSafe(display, String(v) + '분');
    }
  });
}

/* ══════════════════════════════════════════════════════════════════
   [v4.0] §31-D. 페이지 전환 옵션 선택 UI (pageTransition)
   라디오 버튼 또는 data-transition 버튼 그룹
   값: 'fade' | 'slide' | 'flip3d'
   ══════════════════════════════════════════════════════════════════ */
function initPageTransitionSelector() {
  /* 라디오 방식 */
  const radios = document.querySelectorAll('input[name="page-transition"]');
  if (radios.length > 0) {
    /* 초기값 */
    const cur = store.pageTransition || 'fade';
    radios.forEach(r => { r.checked = (r.value === cur); });

    radios.forEach(r => {
      r.addEventListener('change', () => {
        if (r.checked) {
          store.pageTransition = r.value;
          _saveStateToLS();
        }
      });
    });

    ReactiveStore.subscribe('pageTransition', (v) => {
      radios.forEach(r => { r.checked = (r.value === v); });
    });
    return;
  }

  /* data-transition 버튼 그룹 방식 */
  const btns = DOMProxy.qa('[data-transition]');
  if (btns.length > 0) {
    const cur = store.pageTransition || 'fade';
    btns.forEach(b => {
      b.classList.toggle('active', b.dataset.transition === cur);
      b.setAttribute('aria-checked', String(b.dataset.transition === cur));
    });
    btns.forEach(b => {
      b.addEventListener('click', () => {
        store.pageTransition = b.dataset.transition;
        _saveStateToLS();
        btns.forEach(x => {
          x.classList.toggle('active', x === b);
          x.setAttribute('aria-checked', String(x === b));
        });
      });
    });

    ReactiveStore.subscribe('pageTransition', (v) => {
      btns.forEach(b => {
        b.classList.toggle('active', b.dataset.transition === v);
        b.setAttribute('aria-checked', String(b.dataset.transition === v));
      });
    });
  }
}


/* ══════════════════════════════════════════════════════════════════
   §32~33. 키보드 힌트 / 오프라인 배너
   ══════════════════════════════════════════════════════════════════ */
function showKeyboardHint() {
  if (localStorage.getItem('fable_keyboard_hint_shown')) return;
  if (!DOMProxy.exists('keyboard-hint-layer')) return;
  DOMProxy.get('keyboard-hint-layer').style.display = 'flex';
  localStorage.setItem('fable_keyboard_hint_shown', '1');
}

function initOfflineBanner() {
  function update(offline) {
    ['offline-banner', 'offline-banner-viewer'].forEach(id => {
      if (DOMProxy.exists(id)) DOMProxy.get(id).style.display = offline ? 'flex' : 'none';
    });
  }
  window.addEventListener('offline', () => { update(true);  Toast.show('인터넷 연결이 끊겼습니다. 오프라인 모드로 작동 중입니다.'); });
  window.addEventListener('online',  async () => { update(false); Toast.show('인터넷 연결이 복원되었습니다.', 'success'); await AnnotationSyncEngine.syncPending(); });
  if (!navigator.onLine) update(true);
}


/* ══════════════════════════════════════════════════════════════════
   §35. 설정 저장 / 복원 — [v4.0] 항목 확장
   ══════════════════════════════════════════════════════════════════ */
function _saveStateToLS() {
  const snap = {
    fontSize:         store.fontSize,
    lineHeight:       store.lineHeight,
    theme:            store.theme,
    flow:             store.flow,
    userBg:           store.userBg,
    userInk:          store.userInk,
    userSpacing:      store.userSpacing,
    userLeading:      store.userLeading,
    /* [v4.0] 신규 저장 항목 */
    fontWeightBoost:  store.fontWeightBoost ?? 0,
    contrastScale:    store.contrastScale   ?? 1.0,
    eyeProtectMinutes: store.eyeProtectMinutes ?? 50,
    pageTransition:   store.pageTransition  ?? 'fade',
    onboardingDone:   store.onboardingDone  ?? false,
  };
  try { localStorage.setItem(STATE_KEY, JSON.stringify(snap)); } catch (_) {}
}

function _loadStateFromLS() {
  try {
    const raw = localStorage.getItem(STATE_KEY); if (!raw) return;
    const s = JSON.parse(raw);
    ReactiveStore.patch({
      fontSize:          s.fontSize          ?? 100,
      lineHeight:        s.lineHeight        ?? 'normal',
      theme:             s.theme             ?? 'paper',
      flow:              s.flow              ?? 'paginated',
      userBg:            s.userBg            ?? '#f4f1ea',
      userInk:           s.userInk           ?? '#1a1814',
      userSpacing:       s.userSpacing       ?? 0,
      userLeading:       s.userLeading       ?? 1.85,
      /* [v4.0] 신규 복원 항목 */
      fontWeightBoost:   s.fontWeightBoost   ?? 0,
      contrastScale:     s.contrastScale     ?? 1.0,
      eyeProtectMinutes: s.eyeProtectMinutes ?? 50,
      pageTransition:    s.pageTransition    ?? 'fade',
      onboardingDone:    s.onboardingDone    ?? false,
    });
  } catch (_) {}
}

/**
 * [v4.0] 신규 설정 UI 전체 초기화 진입점
 * main.js의 initButtonEventHandlers() 내에서 호출
 */
function initV4SettingsUI() {
  initFontWeightBoostSlider();
  initContrastScaleSlider();
  initEyeProtectMinutesInput();
  initPageTransitionSelector();
}


export {
  initFontUploader,
  FontLazyLoader,
  initFontSelector,
  initCustomThemeBuilder,
  initFontWeightBoostSlider,
  initContrastScaleSlider,
  initEyeProtectMinutesInput,
  initPageTransitionSelector,
  initV4SettingsUI,
  showKeyboardHint,
  initOfflineBanner,
  _saveStateToLS,
  _loadStateFromLS,
};
