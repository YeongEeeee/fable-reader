/**
 * src/ui/settings.js
 * ───────────────────────────────────────────────────────────────
 * 공용 설정 UI (서재/뷰어 양쪽에서 사용)
 *
 * 보존된 스펙:
 *   - 폰트 업로더 (FontFace 주입)
 *   - [2]-2 FontLazyLoader (서체 선택 시점 lazy @font-face 인젝션)
 *   - 커스텀 테마 빌더 (색/자간/행간)
 *   - 설정 LocalStorage 저장/복원
 *   - 키보드 단축키 힌트, 오프라인 배너
 * ─────────────────────────────────────────────────────────────── */

'use strict';

import {
  store, ReactiveStore, DOMProxy, Toast, setTextSafe, STATE_KEY,
} from '../store.js';
import { AnnotationSyncEngine } from '../sync.js';
import { injectCustomToIframe } from '../reader.js';

/* ══════════════════════════════════════════════════════════
   §30. 폰트 업로더
   ══════════════════════════════════════════════════════════ */
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

/* ══════════════════════════════════════════════════════════
   [2]-2 오프라인 폰트 동적 로딩 (Font Lazy Loading)
   서체 선택 시점에만 @font-face / Google Fonts를 비동기 인젝션
   ══════════════════════════════════════════════════════════ */
const FontLazyLoader = (() => {
  const loaded = new Set();
  /* 폰트 정의: id → { label, family, href(웹폰트), local(시스템) } */
  const FONTS = {
    'gowun':  { label: '고운바탕', family: "'Gowun Batang', serif", href: 'https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&display=swap' },
    'noto':   { label: '본명조',   family: "'Noto Serif KR', serif", href: 'https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;700&display=swap' },
    'sans':   { label: '본고딕',   family: "'Noto Sans KR', sans-serif", href: 'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;700&display=swap' },
    'nanum':  { label: '나눔명조', family: "'Nanum Myeongjo', serif", href: 'https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@400;700&display=swap' },
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

  /** 선택 시점에만 비동기 로드 후 rendition에 적용 */
  async function apply(fontId) {
    const def = FONTS[fontId];
    if (!def) return;
    if (!loaded.has(fontId)) {
      Toast.show(`${def.label} 서체 로딩 중...`, 'info');
      await _injectStylesheet(def.href);
      if (def.href && document.fonts?.ready) { try { await document.fonts.ready; } catch (_) {} }
      loaded.add(fontId);
    }
    if (store.rendition) {
      try { store.rendition.themes.override('font-family', def.family + ' !important'); } catch (_) {}
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


/* §31. 커스텀 테마 빌더 */
function initCustomThemeBuilder() {
  function syncColor(colorId, hexId, storeKey) {
    const colorEl = DOMProxy.get(colorId), hexEl = DOMProxy.get(hexId);
    colorEl.addEventListener('input', () => { const v=colorEl.value; hexEl.value=v; store[storeKey]=v; _saveStateToLS(); });
    hexEl.addEventListener('input', () => { const v=hexEl.value.trim(); if (/^#[0-9A-Fa-f]{6}$/.test(v)) { colorEl.value=v; store[storeKey]=v; _saveStateToLS(); } });
  }
  syncColor('input-user-bg', 'input-user-bg-hex', 'userBg');
  syncColor('input-user-ink','input-user-ink-hex','userInk');
  DOMProxy.get('input-user-spacing').addEventListener('input', () => { const v=parseFloat(DOMProxy.get('input-user-spacing').value); setTextSafe(DOMProxy.get('spacing-val'), v+'em'); store.userSpacing=v; _saveStateToLS(); });
  DOMProxy.get('input-user-leading').addEventListener('input', () => { const v=parseFloat(DOMProxy.get('input-user-leading').value); setTextSafe(DOMProxy.get('leading-val'), String(v)); store.userLeading=v; _saveStateToLS(); });
}


/* §32~33. 키보드 힌트 / 오프라인 배너 */
function showKeyboardHint() {
  if (localStorage.getItem('fable_keyboard_hint_shown')) return;
  DOMProxy.get('keyboard-hint-layer').style.display = 'flex';
  localStorage.setItem('fable_keyboard_hint_shown', '1');
}

function initOfflineBanner() {
  function update(offline) {
    [DOMProxy.get('offline-banner'), DOMProxy.get('offline-banner-viewer')].forEach(b => { b.style.display = offline ? 'flex' : 'none'; });
  }
  window.addEventListener('offline', () => { update(true); Toast.show('인터넷 연결이 끊겼습니다. 오프라인 모드로 작동 중입니다.'); });
  window.addEventListener('online',  async () => { update(false); Toast.show('인터넷 연결이 복원되었습니다.', 'success'); await AnnotationSyncEngine.syncPending(); });
  if (!navigator.onLine) update(true);
}


/* §35. 설정 저장 / 복원 */
function _saveStateToLS() {
  const snap = { fontSize: store.fontSize, lineHeight: store.lineHeight, theme: store.theme, flow: store.flow,
                 userBg: store.userBg, userInk: store.userInk, userSpacing: store.userSpacing, userLeading: store.userLeading };
  try { localStorage.setItem(STATE_KEY, JSON.stringify(snap)); } catch (_) {}
}

function _loadStateFromLS() {
  try {
    const raw = localStorage.getItem(STATE_KEY); if (!raw) return;
    const s = JSON.parse(raw);
    ReactiveStore.patch({
      fontSize: s.fontSize ?? 100, lineHeight: s.lineHeight ?? 'normal', theme: s.theme ?? 'paper', flow: s.flow ?? 'paginated',
      userBg: s.userBg ?? '#f4f1ea', userInk: s.userInk ?? '#1a1814', userSpacing: s.userSpacing ?? 0, userLeading: s.userLeading ?? 1.85,
    });
  } catch (_) {}
}


export {
  initFontUploader,
  FontLazyLoader,
  initFontSelector,
  initCustomThemeBuilder,
  showKeyboardHint,
  initOfflineBanner,
  _saveStateToLS,
  _loadStateFromLS,
};
