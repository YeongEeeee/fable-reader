/**
 * src/ui/settings.js  ── Fable Premium v5.0
 * ───────────────────────────────────────────────────────────────────
 * 공용 설정 UI (서재/뷰어 양쪽에서 사용)
 *
 * v5.0 설정 UI/UX 대개혁 — 2단계 계층 구조:
 *   [❶-독서 프로필] ReadingProfilePresets — '편안한 읽기'/'밀도 높은 읽기'/'대형 활자'
 *     3종 썸네일 버튼. 클릭 시 store.READING_PROFILES 테이블 기준으로
 *     fontSize/lineHeight/userSpacing/fontWeightBoost를 한 번에 동기화.
 *   [❷-심화 설정] AdvancedSettingsSection — 자주 건드리지 않는 설정을
 *     뷰어 팝오버에서 분리하여 이 패널로 위임:
 *       A) [자동 태깅 활성화] 스위치 (autoTaggingEnabled)
 *       B) [인사이트 요약 주기] 일간/주간 세그먼트 컨트롤 (insightSummaryInterval)
 *       C) [한국어 하이픈/줄 정렬] 토글 (hyphenateKorean)
 *   [❸-태그관리] 태그 관리 섹션 (유지)
 *   [❶-HUD스위치] showDashboardReport 토글 스위치 렌더링 세그먼트 (유지)
 *   [v5.0 FX] initFxSettingsUI(): 비주얼 특수효과 제어 섹션 (유지)
 *
 * ※ 뷰어 내 자주 쓰는 설정(테마/글자크기/넘김모드)은 ui/viewer.js의
 *   QuickSettingsPopover로 분리되었다. 이 파일은 "한 번 설정하면 잘
 *   건드리지 않는" 설정 패널 전용이며, viewer.js를 import하지 않는다
 *   (순환 참조 차단 — uploader.js와 동일한 단방향 규칙 적용).
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
  READING_PROFILES,
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
    /* [버그 수정 — C-6] 젠 모드 진입 타이밍 커스텀 제어 — 사용자가
       설정 패널에서 선택한 비활동 감지 시간(초)을 저장한다. */
    zenIdleDelaySec:      store.zenIdleDelaySec      ?? 2,
    /* v5.0 서재 */
    showDashboardReport:  store.showDashboardReport  ?? true,
    tags:                 store.tags                 ?? [],
    libraryViewMode:      store.libraryViewMode      ?? 'grid',
    dailyGoalMin:         store.dailyGoalMin         ?? 30,
    /* v5.0 설정 UI 대개혁 */
    readingProfile:         store.readingProfile         ?? 'comfortable',
    autoTaggingEnabled:     store.autoTaggingEnabled     ?? true,
    insightSummaryInterval: store.insightSummaryInterval ?? 'weekly',
    hyphenateKorean:        store.hyphenateKorean        ?? false,
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
      /* [버그 수정 — C-6] 저장된 사용자 젠 모드 진입 타이밍 복원 */
      zenIdleDelaySec:      s.zenIdleDelaySec      ?? 2,
      /* v5.0 서재 */
      showDashboardReport:  s.showDashboardReport  ?? true,
      tags:                 Array.isArray(s.tags) ? s.tags : [],
      libraryViewMode:      s.libraryViewMode      ?? 'grid',
      dailyGoalMin:         s.dailyGoalMin         ?? 30,
      /* v5.0 설정 UI 대개혁 */
      readingProfile:         s.readingProfile         ?? 'comfortable',
      autoTaggingEnabled:     s.autoTaggingEnabled     ?? true,
      insightSummaryInterval: s.insightSummaryInterval ?? 'weekly',
      hyphenateKorean:        s.hyphenateKorean        ?? false,
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
    _bindZenIdleDelaySlider();
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
    { id: 'fx-toggle-zen',       storeKey: 'fxZenMode',   label: '몰입형 젠 모드 (자동 UI 숨김)',    description: '조작이 없으면 일정 시간 후 상하단 바를 자동으로 숨깁니다. 아래에서 진입 시간을 조절할 수 있습니다.' },
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

  /*
   * [버그 수정 — C-6] 젠 모드 진입 타이밍 커스텀 슬라이더
   * ─────────────────────────────────────────────────────────────
   * 1~10초 범위에서 사용자가 직접 비활동 감지 시간을 조절할 수
   * 있도록 한다. fxZenMode 토글이 꺼져 있을 때는 슬라이더를
   * 비활성화(disabled) 상태로 시각적으로 표시해 설정이 무의미함을
   * 알린다.
   */
  const zenDelayRow = document.createElement('div');
  zenDelayRow.id = 'zen-idle-delay-row';
  zenDelayRow.className = 'adv-segment-row';

  const zenDelayText = document.createElement('div');
  zenDelayText.className = 'fx-toggle-text';
  const zenDelayLabel = document.createElement('span');
  zenDelayLabel.className = 'fx-toggle-label';
  zenDelayLabel.textContent = '젠 모드 진입 시간';
  const zenDelayDesc = document.createElement('span');
  zenDelayDesc.className = 'fx-toggle-desc';
  zenDelayDesc.id = 'zen-idle-delay-desc';
  zenDelayDesc.textContent = `${store.zenIdleDelaySec ?? 2}초간 조작이 없으면 상하단 바를 숨깁니다.`;
  zenDelayText.append(zenDelayLabel, zenDelayDesc);

  const zenDelaySlider = document.createElement('input');
  zenDelaySlider.type = 'range';
  zenDelaySlider.id = 'input-zen-idle-delay';
  zenDelaySlider.min = '1';
  zenDelaySlider.max = '10';
  zenDelaySlider.step = '1';
  zenDelaySlider.value = String(store.zenIdleDelaySec ?? 2);
  zenDelaySlider.style.cssText = 'flex-shrink:0; width:120px;';

  zenDelayRow.append(zenDelayText, zenDelaySlider);
  section.appendChild(zenDelayRow);

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
  _bindZenIdleDelaySlider();
}

/*
 * [버그 수정 — C-6] 젠 모드 진입 시간 슬라이더 바인딩
 * ─────────────────────────────────────────────────────────────
 * input 이벤트로 store.zenIdleDelaySec를 실시간 갱신하고, 설명
 * 텍스트의 초 단위 숫자도 함께 동기화한다. fxZenMode가 꺼져 있으면
 * 슬라이더를 disabled 처리해 무의미한 조작을 막는다.
 */
function _bindZenIdleDelaySlider() {
  const slider = DOMProxy.get('input-zen-idle-delay');
  const desc   = DOMProxy.get('zen-idle-delay-desc');
  if (!slider || slider === DOMProxy.VOID_NODE) return;

  function _syncDisabledState() {
    const enabled = store.fxZenMode !== false;
    slider.disabled = !enabled;
    slider.style.opacity = enabled ? '1' : '0.45';
  }

  slider.value = String(store.zenIdleDelaySec ?? 2);
  _syncDisabledState();

  slider.addEventListener('input', () => {
    const v = Math.max(1, Math.min(10, parseInt(slider.value, 10) || 2));
    store.zenIdleDelaySec = v;
    setTextSafe(desc, `${v}초간 조작이 없으면 상하단 바를 숨깁니다.`);
    _saveStateToLS();
  });

  ReactiveStore.subscribe('zenIdleDelaySec', (v) => {
    if (slider.value !== String(v)) slider.value = String(v);
    setTextSafe(desc, `${v}초간 조작이 없으면 상하단 바를 숨깁니다.`);
  });

  ReactiveStore.subscribe('fxZenMode', _syncDisabledState);
}

function initFxSettingsUI() {
  _mountFxSection();
  applyFxState();
}

/* ══════════════════════════════════════════════════════════════════
   §34-A. [v5.0 신규] 독서 프로필 / 비주얼 프리셋
   ─────────────────────────────────────────────────────────────────
   '편안한 읽기' / '밀도 높은 읽기' / '대형 활자' 3종 썸네일 버튼.
   클릭 시 READING_PROFILES 테이블을 기준으로 fontSize, lineHeight,
   userSpacing, fontWeightBoost를 ReactiveStore.patch()로 한 번에 동기화한다.
   사용자가 개별 슬라이더(폰트 굵기 보정 등)를 직접 조작하면
   store.readingProfile이 'custom-profile'로 전환되어 active 표시가 풀린다.

   [버그 수정 — C-5] 프로필 변경 시 페이드 인/아웃 FX 트랜지션
   ─────────────────────────────────────────────────────────────────
   기존에는 reapplyInlineTheme()이 즉시 동기적으로 <style>을 갈아
   끼워 폰트 크기/굵기가 한 프레임에 뚝 끊겨 바뀌었다. 본문 iframe의
   body에 짧은 opacity 트랜지션을 걸어 "옅어짐 → 스타일 교체 →
   다시 밝아짐" 흐름으로 우아하게 전환한다. store.fxAnimation이
   false인 경우(저사양/모션 최소화 선호)에는 트랜지션을 생략하고
   즉시 적용해 회귀 없이 동작한다.
   ══════════════════════════════════════════════════════════════════ */
function _getIframeBodies() {
  try {
    const contents = store.rendition?.getContents?.() || [];
    const arr = Array.isArray(contents) ? contents : [contents];
    return arr.map(c => c?.document?.body).filter(Boolean);
  } catch (_) { return []; }
}

function _fadeApplyProfileStyle(applyFn) {
  if (store.fxAnimation === false || !store.rendition) { applyFn(); return; }
  const bodies = _getIframeBodies();
  if (!bodies.length) { applyFn(); return; }

  const FADE_OUT_MS = 140, FADE_IN_MS = 220;
  bodies.forEach(b => {
    b.style.transition = `opacity ${FADE_OUT_MS}ms ease`;
    b.style.opacity = '0.18';
  });
  setTimeout(() => {
    applyFn();
    /* 새로 주입된 <style>이 적용된 직후 body가 새로 생성되거나
       동일 참조일 수 있으므로, 다시 한 번 최신 body 목록을 가져와
       복귀 트랜지션을 건다. */
    const freshBodies = _getIframeBodies();
    (freshBodies.length ? freshBodies : bodies).forEach(b => {
      b.style.transition = `opacity ${FADE_IN_MS}ms ease`;
      b.style.opacity = '1';
    });
    setTimeout(() => {
      (freshBodies.length ? freshBodies : bodies).forEach(b => { b.style.transition = ''; b.style.opacity = ''; });
    }, FADE_IN_MS + 30);
  }, FADE_OUT_MS);
}

function _applyReadingProfile(profileId) {
  const profile = READING_PROFILES[profileId];
  if (!profile) return;

  _fadeApplyProfileStyle(() => {
    ReactiveStore.patch({
      fontSize:        profile.fontSize,
      lineHeight:       profile.lineHeight,
      userSpacing:      profile.userSpacing,
      fontWeightBoost:  profile.fontWeightBoost,
      readingProfile:   profileId,
    });
    try { reapplyInlineTheme(); } catch (_) {}
  });

  _saveStateToLS();
  Toast.show(`'${profile.label}' 프로필이 적용되었습니다.`, 'success');
}

function _renderProfileThumbnail(profileId, profile) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'profile-preset-card';
  card.dataset.profile = profileId;
  card.setAttribute('role', 'radio');
  card.setAttribute('aria-checked', String(store.readingProfile === profileId));

  /* 썸네일 미리보기 — 글자 크기/줄 간격 비율을 시각적으로 축약 표현 */
  const thumb = document.createElement('div');
  thumb.className = 'profile-preset-thumb';
  thumb.style.cssText = `
    --thumb-font-scale: ${(profile.fontSize / 100).toFixed(2)};
    --thumb-line-gap: ${profile.lineHeight === 'narrow' ? '3px' : profile.lineHeight === 'wide' ? '8px' : '5px'};
  `;
  for (let i = 0; i < 4; i++) {
    const bar = document.createElement('span');
    bar.className = 'profile-preset-bar';
    if (i === 3) bar.classList.add('profile-preset-bar--short');
    thumb.appendChild(bar);
  }

  const labelEl = document.createElement('span');
  labelEl.className = 'profile-preset-label';
  labelEl.textContent = profile.label;

  const descEl = document.createElement('span');
  descEl.className = 'profile-preset-desc';
  descEl.textContent = profile.description;

  card.append(thumb, labelEl, descEl);
  return card;
}

function _mountReadingProfileSection() {
  if (DOMProxy.exists('reading-profile-section')) {
    _bindReadingProfileSection();
    return;
  }

  const panel = DOMProxy.get('settings-panel');
  if (!panel || panel === DOMProxy.VOID_NODE) return;

  const section = document.createElement('div');
  section.id = 'reading-profile-section';
  section.className = 'settings-section reading-profile-section';

  const header = document.createElement('div');
  header.className = 'settings-section-header';
  const title = document.createElement('h3');
  title.className = 'settings-section-title';
  title.textContent = '📖 독서 프로필';
  header.appendChild(title);
  section.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'profile-preset-grid';
  grid.setAttribute('role', 'radiogroup');
  grid.setAttribute('aria-label', '독서 프로필 프리셋');

  Object.entries(READING_PROFILES).forEach(([profileId, profile]) => {
    grid.appendChild(_renderProfileThumbnail(profileId, profile));
  });
  section.appendChild(grid);

  const style = document.createElement('style');
  style.textContent = `
    .reading-profile-section { padding: 16px 20px 18px; border-top: 1px solid rgba(120,100,80,0.12); }
    .profile-preset-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .profile-preset-card {
      display: flex; flex-direction: column; align-items: center; gap: 6px;
      padding: 12px 8px 10px; border-radius: 12px;
      border: 1.5px solid rgba(120,100,80,0.18); background: rgba(255,255,255,0.4);
      cursor: pointer; transition: border-color 0.18s ease, transform 0.15s ease, background 0.18s ease;
      font-family: inherit;
    }
    [data-theme="dark"] .profile-preset-card { background: rgba(30,24,18,0.35); }
    .profile-preset-card:hover { transform: translateY(-1px); border-color: var(--color-accent, #c8864a); }
    .profile-preset-card[aria-checked="true"] {
      border-color: var(--color-accent, #c8864a);
      background: rgba(200,134,74,0.10);
      box-shadow: 0 0 0 2px rgba(200,134,74,0.16);
    }
    .profile-preset-thumb {
      width: 100%; height: 38px; display: flex; flex-direction: column;
      gap: var(--thumb-line-gap, 5px); justify-content: center; padding: 0 6px;
    }
    .profile-preset-bar {
      display: block; height: calc(3px * var(--thumb-font-scale, 1));
      min-height: 2px; border-radius: 2px;
      background: var(--color-ink-muted, #8a7a6a); opacity: 0.55; width: 100%;
    }
    .profile-preset-bar--short { width: 60%; }
    .profile-preset-label { font-size: 12.5px; font-weight: 600; color: var(--color-ink, #1a1814); }
    .profile-preset-desc  { font-size: 10.5px; color: var(--color-ink-muted, #8a7a6a); text-align: center; line-height: 1.35; }
  `;
  document.head.appendChild(style);

  panel.appendChild(section);

  _bindReadingProfileSection();
}

function _bindReadingProfileSection() {
  const cards = DOMProxy.qa('.profile-preset-card');
  if (!cards.length) return;

  cards.forEach(card => {
    card.addEventListener('click', () => {
      _applyReadingProfile(card.dataset.profile);
    });
  });

  function _syncActiveState(activeId) {
    cards.forEach(card => {
      const ok = card.dataset.profile === activeId;
      card.setAttribute('aria-checked', String(ok));
    });
  }

  _syncActiveState(store.readingProfile);
  ReactiveStore.subscribe('readingProfile', (v) => _syncActiveState(v));

  /* 사용자가 개별 폰트 굵기 슬라이더를 직접 조작하면 프리셋 동기화가
     깨졌음을 알리기 위해 'custom-profile'로 전환한다. fontSize/lineHeight
     자체는 뷰어 팝오버에서도 직접 바뀌므로 동일 가드를 적용한다. */
  ['fontSize', 'lineHeight', 'userSpacing', 'fontWeightBoost'].forEach(key => {
    ReactiveStore.subscribe(key, () => {
      const profile = READING_PROFILES[store.readingProfile];
      if (!profile) return;
      const matches =
        store.fontSize === profile.fontSize &&
        store.lineHeight === profile.lineHeight &&
        store.userSpacing === profile.userSpacing &&
        store.fontWeightBoost === profile.fontWeightBoost;
      if (!matches) store.readingProfile = 'custom-profile';
    });
  });
}

function initReadingProfileUI() {
  _mountReadingProfileSection();
}

/* ══════════════════════════════════════════════════════════════════
   §34-B. [v5.0 신규] 심화 설정 섹션 (Advanced Settings)
   ─────────────────────────────────────────────────────────────────
   한 번 설정하면 잘 건드리지 않는 설정을 뷰어 팝오버에서 분리하여
   이 패널로 위임:
     A) [자동 태깅 활성화] 스위치 — autoTaggingEnabled
     B) [인사이트 요약 주기] 일간/주간 세그먼트 — insightSummaryInterval
     C) [한국어 하이픈/줄 정렬] 토글 — hyphenateKorean
   ══════════════════════════════════════════════════════════════════ */
function _mountAdvancedSettingsSection() {
  if (DOMProxy.exists('advanced-settings-section')) {
    _bindAdvancedSettingsSection();
    return;
  }

  const panel = DOMProxy.get('settings-panel');
  if (!panel || panel === DOMProxy.VOID_NODE) return;

  const section = document.createElement('div');
  section.id = 'advanced-settings-section';
  section.className = 'settings-section advanced-settings-section';

  const header = document.createElement('div');
  header.className = 'settings-section-header';
  const title = document.createElement('h3');
  title.className = 'settings-section-title';
  title.textContent = '🛠 심화 설정';
  header.appendChild(title);
  section.appendChild(header);

  /* A) 자동 태깅 스위치 */
  const taggingRow = document.createElement('label');
  taggingRow.className = 'fx-toggle-row';
  taggingRow.htmlFor = 'adv-toggle-auto-tagging';

  const taggingText = document.createElement('div');
  taggingText.className = 'fx-toggle-text';
  const taggingLabel = document.createElement('span');
  taggingLabel.className = 'fx-toggle-label';
  taggingLabel.textContent = '자동 태깅 활성화';
  const taggingDesc = document.createElement('span');
  taggingDesc.className = 'fx-toggle-desc';
  taggingDesc.textContent = '도서를 추가할 때 제목/메타데이터 기반으로 장르 태그를 자동 추론합니다.';
  taggingText.append(taggingLabel, taggingDesc);

  const taggingSwitchWrap = document.createElement('div');
  taggingSwitchWrap.className = 'fx-toggle-switch-wrap';
  const taggingCheckbox = document.createElement('input');
  taggingCheckbox.type = 'checkbox';
  taggingCheckbox.id = 'adv-toggle-auto-tagging';
  taggingCheckbox.className = 'fx-toggle-checkbox';
  taggingCheckbox.checked = store.autoTaggingEnabled !== false;
  const taggingTrack = document.createElement('span');
  taggingTrack.className = 'fx-toggle-track';
  taggingTrack.setAttribute('aria-hidden', 'true');
  taggingSwitchWrap.append(taggingCheckbox, taggingTrack);

  taggingRow.append(taggingText, taggingSwitchWrap);
  section.appendChild(taggingRow);

  /* B) 인사이트 요약 주기 세그먼트 */
  const intervalRow = document.createElement('div');
  intervalRow.className = 'adv-segment-row';
  intervalRow.setAttribute('role', 'group');
  intervalRow.setAttribute('aria-label', '인사이트 요약 주기');

  const intervalLabelWrap = document.createElement('div');
  intervalLabelWrap.className = 'fx-toggle-text';
  const intervalLabel = document.createElement('span');
  intervalLabel.className = 'fx-toggle-label';
  intervalLabel.textContent = '인사이트 요약 주기';
  const intervalDesc = document.createElement('span');
  intervalDesc.className = 'fx-toggle-desc';
  intervalDesc.textContent = '서재 하단 HUD 인사이트 카드의 데이터 집계 단위를 설정합니다.';
  intervalLabelWrap.append(intervalLabel, intervalDesc);

  const segmentControl = document.createElement('div');
  segmentControl.className = 'adv-segment-control';
  segmentControl.setAttribute('role', 'radiogroup');

  const segments = [
    { value: 'daily',  label: '일간' },
    { value: 'weekly', label: '주간' },
  ];
  segments.forEach(({ value, label }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ctrl-btn ctrl-btn--text adv-segment-btn';
    btn.dataset.interval = value;
    btn.textContent = label;
    btn.setAttribute('role', 'radio');
    segmentControl.appendChild(btn);
  });

  intervalRow.append(intervalLabelWrap, segmentControl);
  section.appendChild(intervalRow);

  /* C) 한국어 하이픈/줄 정렬 토글 */
  const hyphenRow = document.createElement('label');
  hyphenRow.className = 'fx-toggle-row';
  hyphenRow.htmlFor = 'adv-toggle-hyphenate';

  const hyphenText = document.createElement('div');
  hyphenText.className = 'fx-toggle-text';
  const hyphenLabel = document.createElement('span');
  hyphenLabel.className = 'fx-toggle-label';
  hyphenLabel.textContent = '한국어 하이픈 / 양쪽 정렬';
  const hyphenDesc = document.createElement('span');
  hyphenDesc.className = 'fx-toggle-desc';
  hyphenDesc.textContent = '본문 우측 여백 들쭉날쭉함을 줄이기 위해 자동 줄바꿈 보정을 적용합니다.';
  hyphenText.append(hyphenLabel, hyphenDesc);

  const hyphenSwitchWrap = document.createElement('div');
  hyphenSwitchWrap.className = 'fx-toggle-switch-wrap';
  const hyphenCheckbox = document.createElement('input');
  hyphenCheckbox.type = 'checkbox';
  hyphenCheckbox.id = 'adv-toggle-hyphenate';
  hyphenCheckbox.className = 'fx-toggle-checkbox';
  hyphenCheckbox.checked = store.hyphenateKorean === true;
  const hyphenTrack = document.createElement('span');
  hyphenTrack.className = 'fx-toggle-track';
  hyphenTrack.setAttribute('aria-hidden', 'true');
  hyphenSwitchWrap.append(hyphenCheckbox, hyphenTrack);

  hyphenRow.append(hyphenText, hyphenSwitchWrap);
  section.appendChild(hyphenRow);

  const style = document.createElement('style');
  style.textContent = `
    .advanced-settings-section { padding: 16px 20px 18px; border-top: 1px solid rgba(120,100,80,0.12); }
    .adv-segment-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid rgba(120,100,80,0.07); }
    .adv-segment-control { display: inline-flex; gap: 6px; flex-shrink: 0; }
    .adv-segment-btn { padding: 6px 14px; font-size: 12.5px; }
  `;
  document.head.appendChild(style);

  panel.appendChild(section);

  _bindAdvancedSettingsSection();
}

function _bindAdvancedSettingsSection() {
  /* A) 자동 태깅 */
  const taggingCheckbox = DOMProxy.get('adv-toggle-auto-tagging');
  if (taggingCheckbox && taggingCheckbox !== DOMProxy.VOID_NODE) {
    taggingCheckbox.checked = store.autoTaggingEnabled !== false;
    taggingCheckbox.addEventListener('change', () => {
      store.autoTaggingEnabled = taggingCheckbox.checked;
      _saveStateToLS();
      Toast.show(
        taggingCheckbox.checked ? '자동 태깅이 활성화되었습니다.' : '자동 태깅이 비활성화되었습니다.',
        'info'
      );
    });
    ReactiveStore.subscribe('autoTaggingEnabled', (v) => { taggingCheckbox.checked = (v !== false); });
  }

  /* B) 인사이트 요약 주기 */
  const intervalBtns = DOMProxy.qa('.adv-segment-btn');
  if (intervalBtns.length) {
    function _syncIntervalBtns(cur) {
      intervalBtns.forEach(b => {
        const ok = b.dataset.interval === cur;
        b.classList.toggle('active', ok);
        b.setAttribute('aria-checked', String(ok));
      });
    }
    _syncIntervalBtns(store.insightSummaryInterval || 'weekly');
    intervalBtns.forEach(b => {
      b.addEventListener('click', () => {
        store.insightSummaryInterval = b.dataset.interval;
        _saveStateToLS();
      });
    });
    ReactiveStore.subscribe('insightSummaryInterval', (v) => _syncIntervalBtns(v));
  }

  /* C) 한국어 하이픈/정렬 */
  const hyphenCheckbox = DOMProxy.get('adv-toggle-hyphenate');
  if (hyphenCheckbox && hyphenCheckbox !== DOMProxy.VOID_NODE) {
    hyphenCheckbox.checked = store.hyphenateKorean === true;
    hyphenCheckbox.addEventListener('change', () => {
      store.hyphenateKorean = hyphenCheckbox.checked;
      _saveStateToLS();
      try { reapplyInlineTheme(); } catch (_) {}
    });
    ReactiveStore.subscribe('hyphenateKorean', (v) => { hyphenCheckbox.checked = (v === true); });
  }
}

function initAdvancedSettingsUI() {
  _mountAdvancedSettingsSection();
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
  /* v5.0 독서 프로필 프리셋 */
  initReadingProfileUI();
  /* v5.0 심화 설정 섹션 (자동 태깅 / 인사이트 주기 / 하이픈) */
  initAdvancedSettingsUI();
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
  initReadingProfileUI,
  initAdvancedSettingsUI,
};
