/**
 * src/ui/settings.js  ── Fable Premium v5.0
 * ───────────────────────────────────────────────────────────────────
 * 공용 설정 UI (서재/뷰어 양쪽에서 사용)
 *
 * v5.0 대개혁 신규 사항:
 *   [❸-태그관리] 태그 관리 섹션 신설
 *     A) 커스텀 태그 생성기 (<input> + [태그 생성] 버튼)
 *     B) store.tags 배열 push → 3-Way 리액티브 바인딩
 *     C) 장르 태그 칩 미리보기 (GENRE_TAGS 컬러 브랜딩)
 *   [❶-HUD스위치] showDashboardReport 토글 스위치 렌더링 세그먼트
 *     → store.showDashboardReport 리액티브 연동
 *   [v5.0 FX] initFxSettingsUI(): 비주얼 특수효과 제어 섹션 (유지)
 *
 * 변경 사항 (v4.0 — 유지):
 *   - fontWeightBoost / contrastScale / eyeProtectMinutes / pageTransition
 *   - _saveStateToLS / _loadStateFromLS (v5.0 항목 확장)
 *   - applyFxState(): html data-fx-* 어트리뷰트 선언적 바인딩
 * ───────────────────────────────────────────────────────────────────
 */

'use strict';

import {
  store, ReactiveStore, DOMProxy, Toast, setTextSafe, STATE_KEY,
} from '../store.js';
import { AnnotationSyncEngine } from '../sync.js';
import { injectCustomToIframe, reapplyInlineTheme, waitForFontsWithTimeout } from '../reader.js';
import { GENRE_TAGS } from './uploader.js';

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
   §31. 폰트 지연 로딩 (Font Lazy Loading)
   ══════════════════════════════════════════════════════════════════ */
const FontLazyLoader = (() => {
  const loaded = new Set();
  const FONTS = {
    'gowun':  { label: '고운바탕', family: "'Gowun Batang', serif",         href: 'https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&display=swap' },
    'noto':   { label: '본명조',   family: "'Noto Serif KR', serif",         href: 'https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;700&display=swap' },
    'sans':   { label: '본고딕',   family: "'Noto Sans KR', sans-serif",     href: 'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;700&display=swap' },
    'nanum':  { label: '나눔명조', family: "'Nanum Myeongjo', serif",        href: 'https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@400;700&display=swap' },
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

  async function apply(fontId) {
    const def = FONTS[fontId];
    if (!def) return;
    if (!loaded.has(fontId)) {
      Toast.show(`${def.label} 서체 로딩 중...`, 'info');
      await _injectStylesheet(def.href);
      if (def.href) {
        const fontLoaded = await waitForFontsWithTimeout(def.family, 1500);
        if (!fontLoaded) {
          console.warn(`[FontLazyLoader] ${def.label} 폰트 로딩 타임아웃 — 시스템 서체로 폴백`);
          Toast.show(`${def.label} 로딩이 지연되어 시스템 서체를 사용합니다.`, 'info');
        }
      }
      loaded.add(fontId);
    }
    if (store.rendition) {
      try { store.rendition.themes.override('font-family', def.family + ' !important'); } catch (_) {}
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
   §31-A. 커스텀 테마 빌더
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
   §31-B. 폰트 굵기 보정 슬라이더 (fontWeightBoost)
   ══════════════════════════════════════════════════════════════════ */
function initFontWeightBoostSlider() {
  const slider  = DOMProxy.get('input-font-weight-boost');
  const display = DOMProxy.get('font-weight-boost-val');
  if (!DOMProxy.exists('input-font-weight-boost')) return;

  slider.value = String(store.fontWeightBoost ?? 0);
  setTextSafe(display, String(store.fontWeightBoost ?? 0));

  slider.addEventListener('input', () => {
    const v = parseInt(slider.value, 10);
    store.fontWeightBoost = v;
    setTextSafe(display, String(v));
    _saveStateToLS();
    try { reapplyInlineTheme(); } catch (_) {}
  });

  ReactiveStore.subscribe('fontWeightBoost', (v) => {
    if (slider.value !== String(v)) { slider.value = String(v); setTextSafe(display, String(v)); }
  });
}

/* ══════════════════════════════════════════════════════════════════
   §31-C. 대비 스케일러 슬라이더 (contrastScale)
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
    if (slider.value !== s) { slider.value = s; setTextSafe(display, fmt(v)); }
  });
}

/* ══════════════════════════════════════════════════════════════════
   §31-D. 눈 보호 타이머 분 설정 (eyeProtectMinutes)
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
    if (input.value !== String(v)) { input.value = String(v); setTextSafe(display, String(v) + '분'); }
  });
}

/* ══════════════════════════════════════════════════════════════════
   §31-E. 페이지 전환 옵션 선택 UI (pageTransition)
   ══════════════════════════════════════════════════════════════════ */
function initPageTransitionSelector() {
  const radios = document.querySelectorAll('input[name="page-transition"]');
  if (radios.length > 0) {
    const cur = store.pageTransition || 'fade';
    radios.forEach(r => { r.checked = (r.value === cur); });
    radios.forEach(r => {
      r.addEventListener('change', () => { if (r.checked) { store.pageTransition = r.value; _saveStateToLS(); } });
    });
    ReactiveStore.subscribe('pageTransition', (v) => { radios.forEach(r => { r.checked = (r.value === v); }); });
    return;
  }

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
        btns.forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-checked', String(x === b)); });
      });
    });
    ReactiveStore.subscribe('pageTransition', (v) => {
      btns.forEach(b => { b.classList.toggle('active', b.dataset.transition === v); b.setAttribute('aria-checked', String(b.dataset.transition === v)); });
    });
  }
}

/* ══════════════════════════════════════════════════════════════════
   §32. 키보드 힌트 / 오프라인 배너
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
  window.addEventListener('offline', () => { update(true); Toast.show('인터넷 연결이 끊겼습니다. 오프라인 모드로 작동 중입니다.'); });
  window.addEventListener('online', async () => { update(false); Toast.show('인터넷 연결이 복원되었습니다.', 'success'); await AnnotationSyncEngine.syncPending(); });
  if (!navigator.onLine) update(true);
}

/* ══════════════════════════════════════════════════════════════════
   §33. 설정 저장 / 복원 — v5.0 항목 확장
   ══════════════════════════════════════════════════════════════════ */
function _saveStateToLS() {
  const snap = {
    fontSize:             store.fontSize,
    lineHeight:           store.lineHeight,
    theme:                store.theme,
    flow:                 store.flow,
    userBg:               store.userBg,
    userInk:              store.userInk,
    userSpacing:          store.userSpacing,
    userLeading:          store.userLeading,
    /* v4.0 */
    fontWeightBoost:      store.fontWeightBoost      ?? 0,
    contrastScale:        store.contrastScale        ?? 1.0,
    eyeProtectMinutes:    store.eyeProtectMinutes    ?? 50,
    pageTransition:       store.pageTransition       ?? 'fade',
    onboardingDone:       store.onboardingDone       ?? false,
    /* v5.0 FX */
    fxAnimation:          store.fxAnimation          ?? true,
    fxBlur:               store.fxBlur              ?? true,
    fxZenMode:            store.fxZenMode            ?? true,
    /* v5.0 서재 */
    showDashboardReport:  store.showDashboardReport  ?? true,
    tags:                 store.tags                 ?? [],
    libraryViewMode:      store.libraryViewMode      ?? 'grid',
    dailyGoalMin:         store.dailyGoalMin         ?? 30,
  };
  try { localStorage.setItem(STATE_KEY, JSON.stringify(snap)); } catch (_) {}
}

function _loadStateFromLS() {
  try {
    const raw = localStorage.getItem(STATE_KEY); if (!raw) return;
    const s = JSON.parse(raw);
    ReactiveStore.patch({
      fontSize:             s.fontSize             ?? 100,
      lineHeight:           s.lineHeight           ?? 'normal',
      theme:                s.theme               ?? 'paper',
      flow:                 s.flow                ?? 'paginated',
      userBg:               s.userBg              ?? '#f4f1ea',
      userInk:              s.userInk             ?? '#1a1814',
      userSpacing:          s.userSpacing         ?? 0,
      userLeading:          s.userLeading         ?? 1.85,
      /* v4.0 */
      fontWeightBoost:      s.fontWeightBoost      ?? 0,
      contrastScale:        s.contrastScale        ?? 1.0,
      eyeProtectMinutes:    s.eyeProtectMinutes    ?? 50,
      pageTransition:       s.pageTransition       ?? 'fade',
      onboardingDone:       s.onboardingDone       ?? false,
      /* v5.0 FX */
      fxAnimation:          s.fxAnimation          ?? true,
      fxBlur:               s.fxBlur              ?? true,
      fxZenMode:            s.fxZenMode            ?? true,
      /* v5.0 서재 */
      showDashboardReport:  s.showDashboardReport  ?? true,
      tags:                 Array.isArray(s.tags) ? s.tags : [],
      libraryViewMode:      s.libraryViewMode      ?? 'grid',
      dailyGoalMin:         s.dailyGoalMin         ?? 30,
    });
  } catch (_) {}
}

/* ══════════════════════════════════════════════════════════════════
   §34. 비주얼 특수효과(FX) 제어
   ══════════════════════════════════════════════════════════════════ */
function applyFxState() {
  const html = document.documentElement;

  if (store.fxAnimation === false) {
    html.setAttribute('data-fx-anim', 'off');
  } else {
    html.removeAttribute('data-fx-anim');
  }

  if (store.fxBlur === false) {
    html.setAttribute('data-fx-blur', 'off');
  } else {
    html.removeAttribute('data-fx-blur');
  }

  if (store.fxZenMode === false) {
    html.setAttribute('data-fx-zen', 'off');
  } else {
    html.removeAttribute('data-fx-zen');
  }
}

function _bindFxToggle(checkboxId, storeKey) {
  const el = DOMProxy.get(checkboxId);
  if (!el || el === DOMProxy.VOID_NODE) return;

  el.checked = store[storeKey] !== false;

  el.addEventListener('change', () => {
    store[storeKey] = el.checked;
    applyFxState();
    _saveStateToLS();
  });

  ReactiveStore.subscribe(storeKey, (v) => {
    el.checked = (v !== false);
    applyFxState();
  });
}

function _mountFxSection() {
  if (DOMProxy.exists('fx-settings-section')) {
    _bindFxToggle('fx-toggle-animation', 'fxAnimation');
    _bindFxToggle('fx-toggle-blur',      'fxBlur');
    _bindFxToggle('fx-toggle-zen',       'fxZenMode');
    return;
  }

  const panel = DOMProxy.get('settings-panel');
  if (!panel || panel === DOMProxy.VOID_NODE) return;

  const section = document.createElement('div');
  section.id = 'fx-settings-section';
  section.className = 'settings-section fx-section';

  const header = document.createElement('div');
  header.className = 'settings-section-header';
  const title = document.createElement('h3');
  title.className = 'settings-section-title';
  title.textContent = '✨ 비주얼 효과 및 애니메이션 설정';
  header.appendChild(title);
  section.appendChild(header);

  const items = [
    { id: 'fx-toggle-animation', storeKey: 'fxAnimation', label: '애니메이션 및 페이지 전환 효과',  description: '3D 플립, 페이드, 팝업 트랜지션을 활성화합니다.' },
    { id: 'fx-toggle-blur',      storeKey: 'fxBlur',      label: '글래스모피즘 및 백드롭 블러 효과', description: '상하단 바에 반투명 블러 배경을 적용합니다. 저사양 기기에서는 끄면 성능이 향상됩니다.' },
    { id: 'fx-toggle-zen',       storeKey: 'fxZenMode',   label: '몰입형 젠 모드 (자동 UI 숨김)',    description: '2초간 조작이 없으면 상하단 바를 자동으로 숨깁니다.' },
  ];

  items.forEach(item => {
    const row = document.createElement('label');
    row.className = 'fx-toggle-row';
    row.htmlFor = item.id;

    const textGroup = document.createElement('div');
    textGroup.className = 'fx-toggle-text';
    const labelEl = document.createElement('span');
    labelEl.className = 'fx-toggle-label';
    labelEl.textContent = item.label;
    const descEl = document.createElement('span');
    descEl.className = 'fx-toggle-desc';
    descEl.textContent = item.description;
    textGroup.append(labelEl, descEl);

    const switchWrap = document.createElement('div');
    switchWrap.className = 'fx-toggle-switch-wrap';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id   = item.id;
    checkbox.className = 'fx-toggle-checkbox';
    checkbox.checked = store[item.storeKey] !== false;
    const track = document.createElement('span');
    track.className = 'fx-toggle-track';
    track.setAttribute('aria-hidden', 'true');
    switchWrap.append(checkbox, track);

    row.append(textGroup, switchWrap);
    section.appendChild(row);
  });

  const style = document.createElement('style');
  style.textContent = `
    .fx-section { padding: 16px 20px 20px; border-top: 1px solid rgba(120,100,80,0.12); }
    .settings-section-title { font-size: 13px; font-weight: 600; color: var(--color-ink-muted, #7a6a5a); margin: 0 0 14px; letter-spacing: 0.3px; }
    .fx-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; cursor: pointer; border-bottom: 1px solid rgba(120,100,80,0.07); }
    .fx-toggle-row:last-of-type { border-bottom: none; }
    .fx-toggle-text { display: flex; flex-direction: column; gap: 2px; flex: 1; }
    .fx-toggle-label { font-size: 13.5px; font-weight: 500; color: var(--color-ink, #1a1814); }
    .fx-toggle-desc  { font-size: 11.5px; color: var(--color-ink-muted, #8a7a6a); line-height: 1.4; }
    .fx-toggle-switch-wrap { position: relative; flex-shrink: 0; }
    .fx-toggle-checkbox { position: absolute; opacity: 0; width: 0; height: 0; }
    .fx-toggle-track { display: block; width: 44px; height: 24px; border-radius: 12px; background: rgba(120,100,80,0.22); cursor: pointer; transition: background 0.22s ease, box-shadow 0.22s ease; position: relative; }
    .fx-toggle-track::after { content: ''; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.22); transition: transform 0.22s cubic-bezier(0.4,0,0.2,1); }
    .fx-toggle-checkbox:checked + .fx-toggle-track { background: var(--color-accent, #c8864a); box-shadow: 0 0 0 2px rgba(200,134,74,0.22); }
    .fx-toggle-checkbox:checked + .fx-toggle-track::after { transform: translateX(20px); }
    .fx-toggle-checkbox:focus-visible + .fx-toggle-track { outline: 2px solid var(--color-accent, #c8864a); outline-offset: 2px; }
    /* 태그 관리 섹션 */
    .tag-mgmt-section { padding: 16px 20px 20px; border-top: 1px solid rgba(120,100,80,0.12); }
    .tag-mgmt-title { font-size: 13px; font-weight: 600; color: var(--color-ink-muted, #7a6a5a); margin: 0 0 12px; letter-spacing: 0.3px; }
    .tag-mgmt-genre-grid { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
    .tag-mgmt-genre-chip { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 20px; font-size: 11.5px; font-weight: 500; border: none; cursor: default; }
    .tag-mgmt-input-row { display: flex; gap: 8px; margin-bottom: 10px; }
    .tag-mgmt-input { flex: 1; padding: 7px 10px; border-radius: 8px; border: 1px solid rgba(120,100,80,0.22); background: rgba(255,255,255,0.5); font-size: 13px; color: var(--color-ink, #1a1814); outline: none; transition: border-color 0.18s ease; }
    [data-theme="dark"] .tag-mgmt-input { background: rgba(30,24,18,0.5); color: #f0e8d8; }
    .tag-mgmt-input:focus { border-color: var(--color-accent, #c8864a); }
    .tag-mgmt-add-btn { padding: 7px 14px; border-radius: 8px; border: none; background: var(--color-accent, #c8864a); color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap; transition: opacity 0.18s ease, transform 0.15s ease; }
    .tag-mgmt-add-btn:hover { opacity: 0.88; transform: scale(1.04); }
    .tag-mgmt-add-btn:active { transform: scale(0.97); }
    .tag-mgmt-custom-list { display: flex; flex-wrap: wrap; gap: 6px; min-height: 24px; }
    .tag-mgmt-custom-chip { display: inline-flex; align-items: center; gap: 5px; padding: 4px 8px 4px 10px; border-radius: 20px; background: rgba(120,100,80,0.10); border: 1px solid rgba(120,100,80,0.16); font-size: 12px; color: var(--color-ink, #1a1814); }
    .tag-mgmt-custom-del { border: none; background: none; cursor: pointer; font-size: 13px; line-height: 1; color: var(--color-ink-muted, #8a7a6a); padding: 0 2px; transition: color 0.15s ease; }
    .tag-mgmt-custom-del:hover { color: #c03a2b; }
    /* HUD 토글 섹션 */
    .hud-toggle-section { padding: 14px 20px 16px; border-top: 1px solid rgba(120,100,80,0.12); }
    .hud-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .hud-toggle-text { display: flex; flex-direction: column; gap: 2px; flex: 1; }
    .hud-toggle-label { font-size: 13.5px; font-weight: 500; color: var(--color-ink, #1a1814); }
    .hud-toggle-desc  { font-size: 11.5px; color: var(--color-ink-muted, #8a7a6a); line-height: 1.4; }
  `;
  document.head.appendChild(style);

  panel.appendChild(section);

  items.forEach(item => { _bindFxToggle(item.id, item.storeKey); });
}

function initFxSettingsUI() {
  _mountFxSection();
  applyFxState();
}

/* ══════════════════════════════════════════════════════════════════
   §35. [v5.0 신규] 태그 관리 섹션 — 커스텀 태그 동적 생성기
   ─────────────────────────────────────────────────────────────────
   - 장르 태그(GENRE_TAGS) 미리보기 칩 렌더
   - <input> + [태그 생성] 버튼 → store.tags push
   - 커스텀 태그 칩 삭제 버튼 → store.tags splice
   - 3-Way 리액티브: store.tags 변화 → 이 섹션 + 태그 바 + 팝업 자동 동기화
   ══════════════════════════════════════════════════════════════════ */
function _mountTagManagementSection() {
  /* 이미 마운트된 경우 바인딩만 수행 */
  if (DOMProxy.exists('tag-mgmt-section')) {
    _bindTagManagementSection();
    return;
  }

  const panel = DOMProxy.get('settings-panel');
  if (!panel || panel === DOMProxy.VOID_NODE) return;

  const section = document.createElement('div');
  section.id = 'tag-mgmt-section';
  section.className = 'tag-mgmt-section';

  /* 섹션 타이틀 */
  const titleEl = document.createElement('h3');
  titleEl.className = 'tag-mgmt-title';
  titleEl.textContent = '🏷 태그 및 서재 분류 관리';
  section.appendChild(titleEl);

  /* 장르 태그 미리보기 */
  const genreLabel = document.createElement('div');
  genreLabel.style.cssText = 'font-size:11.5px;color:var(--color-ink-muted,#8a7a6a);margin-bottom:6px;';
  genreLabel.textContent = '기본 장르 태그';
  section.appendChild(genreLabel);

  const genreGrid = document.createElement('div');
  genreGrid.className = 'tag-mgmt-genre-grid';
  GENRE_TAGS.forEach(({ name, color, bg }) => {
    const chip = document.createElement('span');
    chip.className = 'tag-mgmt-genre-chip';
    chip.textContent = '#' + name;
    chip.style.color      = color;
    chip.style.background = bg;
    chip.style.border     = `1px solid ${color}44`;
    genreGrid.appendChild(chip);
  });
  section.appendChild(genreGrid);

  /* 커스텀 태그 생성 입력 영역 */
  const customLabel = document.createElement('div');
  customLabel.style.cssText = 'font-size:11.5px;color:var(--color-ink-muted,#8a7a6a);margin:10px 0 6px;';
  customLabel.textContent = '커스텀 태그 생성';
  section.appendChild(customLabel);

  const inputRow = document.createElement('div');
  inputRow.className = 'tag-mgmt-input-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.id   = 'tag-mgmt-input';
  input.className   = 'tag-mgmt-input';
  input.placeholder = '태그 이름 입력 (최대 20자)…';
  input.maxLength   = 20;

  const addBtn = document.createElement('button');
  addBtn.id = 'tag-mgmt-add-btn';
  addBtn.className = 'tag-mgmt-add-btn';
  addBtn.textContent = '태그 생성';

  inputRow.append(input, addBtn);
  section.appendChild(inputRow);

  /* 커스텀 태그 칩 목록 */
  const customList = document.createElement('div');
  customList.id = 'tag-mgmt-custom-list';
  customList.className = 'tag-mgmt-custom-list';
  section.appendChild(customList);

  panel.appendChild(section);

  _bindTagManagementSection();
}

function _bindTagManagementSection() {
  const input      = DOMProxy.get('tag-mgmt-input');
  const addBtn     = DOMProxy.get('tag-mgmt-add-btn');
  const customList = DOMProxy.get('tag-mgmt-custom-list');

  if (!input || input === DOMProxy.VOID_NODE) return;

  /* 커스텀 태그 목록 렌더 함수 */
  function _renderCustomTags() {
    const tags = store.tags || [];
    customList.innerHTML = '';
    if (!tags.length) {
      const empty = document.createElement('span');
      empty.style.cssText = 'font-size:11.5px;color:var(--color-ink-muted,#8a7a6a);';
      empty.textContent = '생성된 커스텀 태그가 없습니다.';
      customList.appendChild(empty);
      return;
    }
    tags.forEach((tagName, idx) => {
      const chip = document.createElement('span');
      chip.className = 'tag-mgmt-custom-chip';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = '#' + tagName;
      chip.appendChild(nameSpan);

      const delBtn = document.createElement('button');
      delBtn.className = 'tag-mgmt-custom-del';
      delBtn.textContent = '✕';
      delBtn.setAttribute('aria-label', `#${tagName} 태그 삭제`);
      delBtn.addEventListener('click', () => {
        const newTags = (store.tags || []).filter((_, i) => i !== idx);
        store.tags = newTags;
        _saveStateToLS();
        Toast.show(`'#${tagName}' 태그가 삭제되었습니다.`, 'info');
      });
      chip.appendChild(delBtn);
      customList.appendChild(chip);
    });
  }

  /* 태그 추가 핸들러 */
  function _addTag() {
    const val = input.value.trim().slice(0, 20);
    if (!val) { Toast.show('태그 이름을 입력해 주세요.', 'error'); return; }
    /* 장르 태그와 중복 체크 */
    const genreNames = GENRE_TAGS.map(g => g.name);
    if (genreNames.includes(val)) { Toast.show(`'#${val}'은 기본 장르 태그입니다.`, 'info'); input.value = ''; return; }
    const existing = store.tags || [];
    if (existing.includes(val)) { Toast.show(`'#${val}' 태그가 이미 존재합니다.`, 'info'); input.value = ''; return; }

    store.tags = [...existing, val];
    _saveStateToLS();
    input.value = '';
    Toast.show(`'#${val}' 태그가 생성되었습니다.`, 'success');
  }

  addBtn.addEventListener('click', _addTag);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); _addTag(); } });

  /* store.tags 변화 → 커스텀 칩 목록 리액티브 동기화 */
  ReactiveStore.subscribe('tags', () => { _renderCustomTags(); });

  /* 초기 렌더 */
  _renderCustomTags();
}

function initTagManagementUI() {
  _mountTagManagementSection();
}

/* ══════════════════════════════════════════════════════════════════
   §36. [v5.0 신규] 서재 하단 HUD 표시 토글 스위치
   ─────────────────────────────────────────────────────────────────
   설정 패널 내 showDashboardReport 온/오프 토글 세그먼트
   store.showDashboardReport ↔ #dashboard-hud 리액티브 연동
   ══════════════════════════════════════════════════════════════════ */
function _mountDashboardHudToggle() {
  if (DOMProxy.exists('hud-toggle-section')) {
    _bindDashboardHudToggle();
    return;
  }

  const panel = DOMProxy.get('settings-panel');
  if (!panel || panel === DOMProxy.VOID_NODE) return;

  const section = document.createElement('div');
  section.id = 'hud-toggle-section';
  section.className = 'hud-toggle-section';

  const row = document.createElement('label');
  row.className = 'hud-toggle-row';
  row.htmlFor   = 'hud-toggle-checkbox';
  row.style.cursor = 'pointer';

  const textGroup = document.createElement('div');
  textGroup.className = 'hud-toggle-text';

  const labelEl = document.createElement('span');
  labelEl.className = 'hud-toggle-label';
  labelEl.textContent = '📊 독서 리포트 HUD 표시';

  const descEl = document.createElement('span');
  descEl.className = 'hud-toggle-desc';
  descEl.textContent = '서재 하단의 주간 독서 추이, 목표 달성률, 인사이트 카드 표시를 설정합니다.';

  textGroup.append(labelEl, descEl);

  const switchWrap = document.createElement('div');
  switchWrap.className = 'fx-toggle-switch-wrap'; /* 동일 스위치 스타일 재사용 */

  const checkbox = document.createElement('input');
  checkbox.type      = 'checkbox';
  checkbox.id        = 'hud-toggle-checkbox';
  checkbox.className = 'fx-toggle-checkbox';
  checkbox.checked   = store.showDashboardReport !== false;

  const track = document.createElement('span');
  track.className = 'fx-toggle-track';
  track.setAttribute('aria-hidden', 'true');

  switchWrap.append(checkbox, track);
  row.append(textGroup, switchWrap);
  section.appendChild(row);

  panel.appendChild(section);

  _bindDashboardHudToggle();
}

function _bindDashboardHudToggle() {
  const checkbox = DOMProxy.get('hud-toggle-checkbox');
  if (!checkbox || checkbox === DOMProxy.VOID_NODE) return;

  checkbox.checked = store.showDashboardReport !== false;

  checkbox.addEventListener('change', () => {
    store.showDashboardReport = checkbox.checked;
    _saveStateToLS();
  });

  ReactiveStore.subscribe('showDashboardReport', (v) => {
    checkbox.checked = (v !== false);
  });
}

function initDashboardHudToggleUI() {
  _mountDashboardHudToggle();
}

/* ══════════════════════════════════════════════════════════════════
   §37. [v5.0] 설정 UI 전체 초기화 진입점
   ══════════════════════════════════════════════════════════════════ */
function initV4SettingsUI() {
  initFontWeightBoostSlider();
  initContrastScaleSlider();
  initEyeProtectMinutesInput();
  initPageTransitionSelector();
  /* v5.0 FX 제어 패널 */
  initFxSettingsUI();
  /* v5.0 태그 관리 섹션 */
  initTagManagementUI();
  /* v5.0 HUD 토글 스위치 */
  initDashboardHudToggleUI();
}

/* ══════════════════════════════════════════════════════════════════
   Exports — 중복 export 없이 단일 블록 정의
   ══════════════════════════════════════════════════════════════════ */
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
  applyFxState,
  initFxSettingsUI,
  initTagManagementUI,
  initDashboardHudToggleUI,
};
