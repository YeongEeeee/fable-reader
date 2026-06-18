/**
 * src/ui/viewer.js  ── Fable Premium v5.0
 * ─────────────────────────────────────────────────────────────────
 * 독서(뷰어) UI + 부가 기능 모듈
 *
 * [v5.0 설정 UI/UX 대개혁]
 *   [QuickSettingsPopover] 뷰어 본문 중앙/하단 탭(Tap) 시 노출되는
 *     '맥락형 빠른 설정' 글래스모피즘 팝오버. 테마 즉시 전환(세피아↔다크↔라이트),
 *     글자 크기 +/-, 3D 페이지 넘김 ↔ 스크롤 모드 즉시 전환을 제공한다.
 *     자주 쓰는 설정만 노출하며, 심화 설정(자동 태깅/인사이트 주기/하이픈)은
 *     ui/settings.js 패널로 위임한다 (2단계 계층 구조).
 *   [GoalCelebration] 일일 독서 목표 100% 달성 시 앰버 파티클 세레머니를
 *     트리거한다. ReadingStatsTracker._updateUI()의 기존 1회성 토스트
 *     알림 지점에 연동되며, fx.css의 .goal-particle 키프레임을 사용한다.
 *     CSS 애니메이션과 동기화된 짧은 진동(Vibration API) 햅틱을 제안하고,
 *     store.fxAnimation === false 인 경우 파티클 생성을 생략한다.
 *
 * v4.0 고도화 사항:
 *   [OnboardingGuide]  store.onboardingDone === false 일 때 600ms 후 순차 하이라이트 온보딩
 *   [ReadingReport]    일자별 독서 시간·글자 수 시각화 위젯 렌더러
 *   [3D 페이지 전환]   pageTransition 상태에 따라 fade / slide / flip3d CSS 3D 레이어 연동
 *   [SearchEngine Worker] Spine 전역 검색 정규식 연산을 Web Worker로 이관 → UI 프리징 제로
 *
 * [버그 수정 v4.1]
 *   - updateTocActiveItem: 현재 챕터 자동 스크롤 정렬(scrollTop 보정) 추가
 *   - initAnnotationManager 래퍼 제거 — main.js가 AnnotationManager를
 *     deps로 직접 주입하므로 중복 래퍼 불필요 (export 목록에서 삭제)
 *   - truncateTitle import 제거 — viewer.js 내부 미사용
 *
 * [고도화 v4.2]
 *   - TTSSystem: stop() 메서드에 store.isTtsPlaying = false 상태 연동 추가
 *   - TTSSystem: play() / pauseResume() 에 store.isTtsPlaying 상태 동기화
 *   - TTSSystem: loadVoices() — speechSynthesis.getVoices() 동적 로드,
 *     한국어(ko-KR) 우선 정렬, store.ttsVoice URI 연동
 *   - TTSSystem: initVoiceSelector() — tts-voice-select DOM 셀렉트 박스 구성
 *   - LibraryFullTextSearch._renderResults: split(re) 루프의 stateful RegExp
 *     lastIndex 버그 수정 — reSplit(split용 gi) + reTest(test용 i, g 없음) 완전 분리
 *   - VirtualSearchList._renderChunk: 동일 RegExp 패턴 적용
 *
 * ※ 순환 의존성 차단:
 *   uploader.js와 viewer.js는 직접 상호 import 금지.
 *   uploader.js → refreshLibraryData만 단방향 import 허용.
 *   settings.js → viewer.js import 금지 (동일 원칙); 이 파일도 settings.js를
 *   import하지 않으며, 독서 프로필 동기화는 store를 매개로만 이루어진다.
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

import {
  store, ReactiveStore, DOMProxy, ErrorBoundary, Toast,
  setTextSafe, ResourceRegistry, RECENT_MAX,
} from '../store.js';
import { StorageSystem } from '../database.js';
import { AnnotationSyncEngine } from '../sync.js';
import { openEpubBook, waitForEpubJS, awaitBookReady, switchFlowMode } from '../reader.js';
import { refreshLibraryData } from './uploader.js';

/* ══════════════════════════════════════════════════════════
   §21. TOC 사이드바
   ══════════════════════════════════════════════════════════ */
function renderTocSidebar(tocData) {
  const container = DOMProxy.get('toc-list');
  if (!DOMProxy.exists('toc-list')) return;
  container.innerHTML = '';

  if (!tocData?.length) {
    const p = document.createElement('p');
    p.style.cssText = 'padding:20px;color:var(--color-ink-muted);font-size:13px;text-align:center;';
    p.textContent = '목차 정보가 없습니다.';
    container.appendChild(p);
    return;
  }

  const frag = document.createDocumentFragment();

  function appendItems(items, depth) {
    items.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'toc-item';
      btn.dataset.depth = String(Math.min(depth, 3));
      btn.dataset.href = item.href || '';
      btn.textContent = item.label?.trim() || '(제목 없음)';
      btn.setAttribute('role', 'listitem');
      btn.addEventListener('click', () => {
        if (store.rendition && item.href) store.rendition.display(item.href).catch(() => {});
        store.isTocOpen = false;
      });
      frag.appendChild(btn);
      if (item.subitems?.length) appendItems(item.subitems, depth + 1);
    });
  }

  appendItems(tocData, 1);
  container.appendChild(frag);
}

/*
 * [버그 수정] updateTocActiveItem
 * ──────────────────────────────────────────────────────────────
 * active 아이템 scrollTop 보정 추가 (scrollIntoView 미사용)
 * ──────────────────────────────────────────────────────────────
 */
function updateTocActiveItem(href) {
  const container = DOMProxy.get('toc-list');
  if (!container) return;

  let activeEl = null;
  container.querySelectorAll?.('.toc-item').forEach(item => {
    const ih       = item.dataset.href || '';
    const isActive = !!(ih && (
      href.includes(ih.split('#')[0]) || ih.includes(href.split('#')[0])
    ));
    item.classList.toggle('active', isActive);
    if (isActive && !activeEl) activeEl = item;
  });

  if (activeEl) {
    requestAnimationFrame(() => {
      try { container.scrollTop = activeEl.offsetTop; } catch (_) {}
    });
  }
}

/* ══════════════════════════════════════════════════════════
   §22. Virtual Search List (IntersectionObserver 재활용 풀)
   ══════════════════════════════════════════════════════════ */
const VirtualSearchList = (() => {
  const VISIBLE = 20, ITEM_H = 64;
  let allResults = [], renderedStart = 0, container = null,
      sentinel = null, observer = null, pool = [], _q = '';

  function _createItem() {
    const div = document.createElement('div');
    div.className = 'search-result-item';
    div.setAttribute('role', 'option');
    div.style.cssText = `min-height:${ITEM_H}px;padding:10px 16px;border-bottom:1px solid var(--color-border-soft);cursor:pointer;`;
    div.innerHTML = '<div class="sri-section" style="font-size:10px;color:var(--color-ink-muted);margin-bottom:3px;"></div>'
                  + '<p class="sri-snippet" style="font-size:12px;line-height:1.5;margin:0;color:var(--color-ink-soft);"></p>';
    return div;
  }

  function _renderChunk(start, q) {
    if (!container) return;
    const end  = Math.min(start + VISIBLE, allResults.length);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const m    = allResults[i], node = pool.pop() || _createItem();
      node.querySelector('.sri-section').textContent = `${i + 1}. ${(m.sectionHref || '').split('/').pop()}`;
      const snip = node.querySelector('.sri-snippet');
      snip.innerHTML = '';
      /* [v4.2 버그 수정] split(re) 루프의 stateful RegExp lastIndex 버그 수정
         reHighlight(test용 gi) + reSplit(split용 gi) 분리 후
         test() 호출 직후 lastIndex = 0 리셋으로 교번 매칭 오류 제거 */
      const reHighlight = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const reSplit     = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      m.context.split(reSplit).forEach(part => {
        if (reHighlight.test(part)) {
          const mk = document.createElement('mark');
          mk.className = 'fable-search-mark';
          mk.textContent = part;
          snip.appendChild(mk);
          reHighlight.lastIndex = 0;
        } else {
          snip.appendChild(document.createTextNode(part));
        }
      });
      node.onclick = async () => {
        DOMProxy.get('search-modal').style.display = 'none';
        store.isSearching = false;
        if (store.rendition && m.cfi) {
          try { await store.rendition.display(m.cfi); setTimeout(() => injectSearchHighlight(m.cfi), 400); } catch (_) {}
        }
      };
      frag.appendChild(node);
    }
    container.appendChild(frag);
    renderedStart = end;
  }

  function _setupSentinel() {
    sentinel = document.createElement('div');
    sentinel.style.height = '1px';
    container.appendChild(sentinel);
    observer = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting || renderedStart >= allResults.length) return;
      const old = container.querySelectorAll('.search-result-item');
      if (old.length > VISIBLE * 2) {
        Array.from(old).slice(0, old.length - VISIBLE).forEach(n => { pool.push(n); n.remove(); });
      }
      _renderChunk(renderedStart, _q);
      container.appendChild(sentinel);
    }, { threshold: 0.1 });
    observer.observe(sentinel);
  }

  function render(containerEl, results, query) {
    if (observer) { observer.disconnect(); observer = null; }
    pool = []; allResults = results; container = containerEl; renderedStart = 0; _q = query;
    container.innerHTML = '';
    if (!results.length) {
      const p = document.createElement('p');
      p.style.cssText = 'padding:20px;text-align:center;color:var(--color-ink-muted);font-size:13px;';
      p.textContent = '검색 결과가 없습니다.';
      container.appendChild(p);
      return;
    }
    _renderChunk(0, query);
    _setupSentinel();
  }

  function destroy() {
    if (observer) { observer.disconnect(); observer = null; }
    pool = []; allResults = []; container = null; sentinel = null;
  }

  return { render, destroy };
})();

/* ══════════════════════════════════════════════════════════
   §23. SearchEngine — Web Worker 이관 (UI 프리징 제로)
   ══════════════════════════════════════════════════════════ */
const _SEARCH_WORKER_SRC = /* js */`
'use strict';
let _index = [];
let _built = false;

self.onmessage = function(e) {
  const { type, payload, id } = e.data || {};

  if (type === 'INDEX') {
    _index = payload || [];
    _built = _index.length > 0;
    self.postMessage({ type: 'INDEX_READY', id, count: _index.length });
    return;
  }

  if (type === 'QUERY') {
    if (!_built) { self.postMessage({ type: 'RESULT', id, results: [] }); return; }
    const kw = (payload.keyword || '').toLowerCase().trim();
    if (kw.length < 2) { self.postMessage({ type: 'RESULT', id, results: [] }); return; }
    const results = [];
    const seen    = new Set();
    for (let i = 0; i < _index.length; i++) {
      const item = _index[i];
      if (item.context.toLowerCase().includes(kw) && !seen.has(item.cfi)) {
        seen.add(item.cfi);
        results.push(item);
        if (results.length >= 200) break;
      }
    }
    self.postMessage({ type: 'RESULT', id, results });
    return;
  }

  if (type === 'RESET') {
    _index = []; _built = false;
    self.postMessage({ type: 'RESET_DONE', id });
  }
};
`;

const SearchEngine = (() => {
  let _worker    = null;
  let _workerUrl = null;
  let _isBuilt   = false;
  let _pending   = new Map();
  let _seq       = 0;

  function _ensureWorker() {
    if (_worker) return;
    try {
      _workerUrl = URL.createObjectURL(
        new Blob([_SEARCH_WORKER_SRC], { type: 'application/javascript' })
      );
      _worker = new Worker(_workerUrl);
      _worker.onmessage = (e) => {
        const { type, id, results, count } = e.data || {};
        const ticket = _pending.get(id);
        if (ticket) {
          _pending.delete(id);
          if (type === 'RESULT')           ticket.resolve(results);
          else if (type === 'INDEX_READY') ticket.resolve(count);
          else if (type === 'RESET_DONE')  ticket.resolve(true);
        }
      };
      _worker.onerror = (err) => {
        console.error('[SearchEngine Worker]', err.message);
        _pending.forEach(t => t.reject(err));
        _pending.clear();
        _worker = null;
      };
    } catch (ex) {
      console.warn('[SearchEngine] Web Worker 생성 실패 — 메인스레드 폴백:', ex.message);
      _worker = null;
    }
  }

  function _send(type, payload) {
    return new Promise((resolve, reject) => {
      const id = ++_seq;
      _pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (_pending.has(id)) { _pending.delete(id); reject(new Error('Worker timeout: ' + type)); }
      }, 30000);
      _worker.postMessage({ type, payload, id });
    });
  }

  async function build(book) {
    if (_isBuilt || !book) return;
    _ensureWorker();
    const indexArr = [];
    const parser   = new DOMParser();
    const items    = book.spine?.items || [];
    for (const item of items) {
      try {
        const section = book.spine.get(item.href || item.idref);
        if (!section) continue;
        await section.load(book.load.bind(book));
        const doc = parser.parseFromString(section.content || '<html></html>', 'text/html');
        Array.from(doc.querySelectorAll('p,h1,h2,h3,li')).forEach(p => {
          const text = p.textContent?.trim() || '';
          if (text.length < 3) return;
          let cfi = '';
          try { cfi = section.cfiFromElement(p); } catch (_) { cfi = item.href || ''; }
          indexArr.push({ sectionHref: item.href || '', cfi, context: text.slice(0, 160) });
        });
        section.unload();
        await new Promise(r => setTimeout(r, 0));
      } catch (_) {}
    }
    if (_worker) {
      await _send('INDEX', indexArr);
      _isBuilt = true;
    } else {
      SearchEngine._fallbackIndex = indexArr;
      _isBuilt = true;
    }
  }

  async function query(keyword) {
    if (!_isBuilt || (keyword || '').length < 2) return [];
    if (_worker) {
      try { return await _send('QUERY', { keyword }); }
      catch (_) {}
    }
    const kw   = keyword.toLowerCase().trim();
    const arr  = SearchEngine._fallbackIndex || [];
    const out  = [];
    const seen = new Set();
    for (const item of arr) {
      if (item.context.toLowerCase().includes(kw) && !seen.has(item.cfi)) {
        seen.add(item.cfi); out.push(item);
        if (out.length >= 200) break;
      }
    }
    return out;
  }

  function destroy() {
    if (_worker) {
      try { _worker.terminate(); } catch (_) {}
      _worker = null;
    }
    if (_workerUrl) { URL.revokeObjectURL(_workerUrl); _workerUrl = null; }
    _pending.clear();
    _isBuilt = false;
    SearchEngine._fallbackIndex = null;
  }

  return { build, query, destroy, _fallbackIndex: null };
})();

async function runSearchExecution() {
  const q = DOMProxy.get('input-search-query').value?.trim() ?? '';
  if (q.length < 2) { Toast.show('검색어는 2글자 이상 입력하세요.', 'error'); return; }
  /* [v4.2] 검색 실행 시 isSearching 활성 */
  store.isSearching = true;
  const results = await SearchEngine.query(q);
  VirtualSearchList.render(DOMProxy.get('search-results-container'), results, q);
}

function injectSearchHighlight(cfi) {
  if (!store.rendition) return;
  try {
    /* [버그 수정 — C-8] 검색 결과 임시 하이라이트도 테마에 맞는
       명도/투명도로 보정하여 다크 모드에서 과도하게 밝지 않도록 한다. */
    store.rendition.annotations.add('highlight', cfi, {}, null, 'fable-search-hl', _resolveHighlightStyle('yellow'));
    setTimeout(() => {
      try { store.rendition?.annotations?.remove(cfi, 'highlight'); } catch (_) {}
    }, 3000);
  } catch (_) {}
}

/* ══════════════════════════════════════════════════════════
   §23-B. OnboardingGuide
   ══════════════════════════════════════════════════════════ */
const OnboardingGuide = (() => {
  let _overlay = null, _box = null, _tooltip = null, _step = 0, _timer = null;

  const STEPS = [
    { targetId: 'drop-zone',   title: '📚 EPUB 파일 추가',  body: 'EPUB 파일을 이 영역에 드래그하거나 탭하여 서재에 추가하세요.',               pos: 'bottom' },
    { targetId: 'top-bar',     title: '🔎 상단 메뉴',        body: '검색, 목차, TTS, 포모도로 등 다양한 독서 도구를 이용하세요.',               pos: 'bottom' },
    { targetId: 'bottom-bar',  title: '⚙️ 하단 메뉴',        body: '설정, 테마 변경, 페이지 넘김 효과를 커스터마이즈할 수 있습니다.',            pos: 'top'    },
  ];

  function _buildDOM() {
    if (_overlay) return;
    _overlay = document.createElement('div');
    _overlay.id = 'onboarding-overlay';
    _overlay.setAttribute('role', 'dialog');
    _overlay.setAttribute('aria-label', '온보딩 가이드');
    _overlay.style.cssText = 'position:fixed;inset:0;z-index:9900;background:rgba(0,0,0,0.55);pointer-events:all;transition:opacity 300ms ease';

    _box = document.createElement('div');
    _box.style.cssText = 'position:fixed;z-index:9910;border:2.5px solid var(--color-accent,#c47a3b);border-radius:8px;box-shadow:0 0 0 4000px rgba(0,0,0,0.55);pointer-events:none;transition:all 320ms cubic-bezier(0.4,0,0.2,1)';

    _tooltip = document.createElement('div');
    _tooltip.style.cssText = 'position:fixed;z-index:9920;background:var(--color-surface,#fff);color:var(--color-ink,#1a1814);border-radius:12px;padding:16px 20px;max-width:280px;box-shadow:0 8px 32px rgba(0,0,0,0.22);font-size:14px;line-height:1.6;pointer-events:all';

    document.body.appendChild(_overlay);
    document.body.appendChild(_box);
    document.body.appendChild(_tooltip);
    _overlay.addEventListener('click', _next);
  }

  function _renderStep(stepIdx) {
    if (stepIdx >= STEPS.length) { _finish(); return; }
    const step   = STEPS[stepIdx];
    const target = document.getElementById(step.targetId);
    if (!target) { _step++; _renderStep(_step); return; }

    const PAD  = 8;
    const rect = target.getBoundingClientRect();
    _box.style.top    = `${rect.top    - PAD}px`;
    _box.style.left   = `${rect.left   - PAD}px`;
    _box.style.width  = `${rect.width  + PAD * 2}px`;
    _box.style.height = `${rect.height + PAD * 2}px`;

    _tooltip.innerHTML = '';
    const h = document.createElement('div');
    h.style.cssText = 'font-size:15px;font-weight:700;margin-bottom:8px;';
    h.textContent = step.title;
    const p = document.createElement('p');
    p.style.cssText = 'font-size:13px;color:var(--color-ink-soft,#555);margin:0 0 12px;';
    p.textContent = step.body;
    const progress = document.createElement('div');
    progress.style.cssText = 'display:flex;gap:5px;align-items:center;margin-bottom:12px;';
    STEPS.forEach((_, i) => {
      const dot = document.createElement('span');
      dot.style.cssText = `display:inline-block;width:7px;height:7px;border-radius:50%;background:${i === stepIdx ? 'var(--color-accent,#c47a3b)' : 'var(--color-border-soft,#ccc)'};`;
      progress.appendChild(dot);
    });
    const btnRow  = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const skipBtn = document.createElement('button');
    skipBtn.textContent = '건너뛰기';
    skipBtn.style.cssText = 'padding:6px 12px;border:1px solid var(--color-border,#ccc);border-radius:6px;background:none;cursor:pointer;font-size:12px;';
    skipBtn.addEventListener('click', _finish);
    const nextBtn = document.createElement('button');
    nextBtn.textContent = stepIdx < STEPS.length - 1 ? '다음 →' : '시작하기 🎉';
    nextBtn.style.cssText = 'padding:6px 14px;border:none;border-radius:6px;background:var(--color-accent,#c47a3b);color:#fff;cursor:pointer;font-size:12px;font-weight:600;';
    nextBtn.addEventListener('click', _next);
    btnRow.appendChild(skipBtn);
    btnRow.appendChild(nextBtn);
    _tooltip.appendChild(h);
    _tooltip.appendChild(p);
    _tooltip.appendChild(progress);
    _tooltip.appendChild(btnRow);

    const TH = 180;
    if (step.pos === 'bottom') {
      let top = rect.bottom + PAD + 12;
      if (top + TH > window.innerHeight - 16) top = rect.top - TH - 12;
      _tooltip.style.top = `${Math.max(8, top)}px`;
    } else {
      let top = rect.top - TH - 12;
      if (top < 8) top = rect.bottom + PAD + 12;
      _tooltip.style.top = `${top}px`;
    }
    let left = rect.left;
    if (left + 280 > window.innerWidth - 8) left = window.innerWidth - 288;
    _tooltip.style.left = `${Math.max(8, left)}px`;
  }

  function _next() { _step++; _renderStep(_step); }

  function _finish() {
    [_overlay, _box, _tooltip].forEach(el => {
      if (!el) return;
      el.style.opacity = '0';
      el.style.pointerEvents = 'none';
      setTimeout(() => { try { el.remove(); } catch (_) {} }, 320);
    });
    _overlay = null; _box = null; _tooltip = null; _step = 0;
    clearTimeout(_timer);
    store.onboardingDone = true;
    try { localStorage.setItem('fable_onboarding_done', '1'); } catch (_) {}
  }

  function init() {
    if (store.onboardingDone || localStorage.getItem('fable_onboarding_done') === '1') {
      store.onboardingDone = true;
      return;
    }
    _timer = setTimeout(() => {
      _buildDOM();
      _step = 0;
      _renderStep(0);
    }, 600);
  }

  function rerun() {
    store.onboardingDone = false;
    try { localStorage.removeItem('fable_onboarding_done'); } catch (_) {}
    _timer = setTimeout(() => {
      _buildDOM();
      _step = 0;
      _renderStep(0);
    }, 100);
  }

  return { init, rerun };
})();

/* ══════════════════════════════════════════════════════════
   §23-B-2. [버그 수정 — C-7] QuickSettingsHint
   ─────────────────────────────────────────────────────────
   OnboardingGuide(§23-B)는 서재(업로더) 화면 부팅 시점에 한 번만
   실행되며, 그 시점에는 #quick-settings-popover가 아직 DOM에
   존재하지 않는다(뷰어 진입 후 본문 탭 시 동적으로 생성됨).
   따라서 v5.0 신규 기능인 빠른 설정 팝오버를 신규 유저가 인지할
   방법이 없었다. 이 모듈은 뷰어가 처음 열렸을 때 1회, 짧은 지연
   후 QuickSettingsPopover를 자동으로 열어 동일한 마스킹+툴팁
   디자인 언어로 안내 문구를 보여준 뒤, 일정 시간 후 자동으로
   팝오버를 닫는다. localStorage 가드로 평생 1회만 노출된다.
   ══════════════════════════════════════════════════════════ */
const QuickSettingsHint = (() => {
  const LS_KEY = 'fable_qsp_hint_shown';
  let _mask = null, _tooltip = null, _timer = null, _autoCloseTimer = null;

  function _alreadyShown() {
    try { return localStorage.getItem(LS_KEY) === '1'; } catch (_) { return true; }
  }

  function _markShown() {
    try { localStorage.setItem(LS_KEY, '1'); } catch (_) {}
  }

  function _dismiss() {
    clearTimeout(_autoCloseTimer);
    [_mask, _tooltip].forEach(el => {
      if (!el) return;
      el.style.opacity = '0';
      setTimeout(() => { try { el.remove(); } catch (_) {} }, 280);
    });
    _mask = null; _tooltip = null;
    QuickSettingsPopover.close();
    _markShown();
  }

  function _render() {
    const target = document.getElementById('quick-settings-popover');
    if (!target) return; /* open()이 아직 DOM을 만들지 못한 극단적 타이밍 — 조용히 포기 */

    const rect = target.getBoundingClientRect();
    const PAD  = 6;

    _mask = document.createElement('div');
    _mask.id = 'qsp-hint-mask';
    _mask.style.cssText = [
      'position:fixed', `top:${rect.top - PAD}px`, `left:${rect.left - PAD}px`,
      `width:${rect.width + PAD * 2}px`, `height:${rect.height + PAD * 2}px`,
      'z-index:9810', 'border-radius:24px',
      'border:2.5px solid var(--color-accent,#c47a3b)',
      'box-shadow:0 0 0 4000px rgba(0,0,0,0.45)',
      'pointer-events:none', 'opacity:0',
      'transition:opacity 280ms ease',
    ].join(';');

    _tooltip = document.createElement('div');
    _tooltip.id = 'qsp-hint-tooltip';
    _tooltip.style.cssText = [
      'position:fixed', `bottom:${window.innerHeight - rect.top + 14}px`, 'left:50%',
      'transform:translateX(-50%)', 'z-index:9820',
      'background:var(--color-surface,#fff)', 'color:var(--color-ink,#1a1814)',
      'border-radius:12px', 'padding:12px 18px', 'max-width:260px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.22)', 'font-size:13px', 'line-height:1.55',
      'text-align:center', 'pointer-events:none', 'opacity:0',
      'transition:opacity 280ms ease',
    ].join(';');
    _tooltip.textContent = '✨ 화면을 탭하면 테마·글자 크기·넘김 모드를 빠르게 바꿀 수 있어요.';

    document.body.appendChild(_mask);
    document.body.appendChild(_tooltip);
    requestAnimationFrame(() => {
      if (_mask) _mask.style.opacity = '1';
      if (_tooltip) _tooltip.style.opacity = '1';
    });

    _autoCloseTimer = setTimeout(_dismiss, 4200);
    ResourceRegistry.addTimer(_autoCloseTimer);
  }

  function maybeShow() {
    if (_alreadyShown()) return;

    clearTimeout(_timer);
    _timer = setTimeout(() => {
      QuickSettingsPopover.open();
      requestAnimationFrame(_render);
    }, 900);
    ResourceRegistry.addTimer(_timer);
  }

  return { maybeShow };
})();

/* ══════════════════════════════════════════════════════════
   §23-C. ReadingReport — 일자별 독서 데이터 시각화 위젯
   ══════════════════════════════════════════════════════════ */
const ReadingReport = (() => {
  let _currentRange = 7;

  function render(readingLog, containerId = 'reading-report-widget') {
    const container = document.getElementById(containerId);
    if (!container) return;

    const days      = _buildDayArray(readingLog, _currentRange);
    const maxSec    = Math.max(60,  ...days.map(d => d.sec));
    const maxChar   = Math.max(1,   ...days.map(d => d.chars));
    const todaySec  = days[days.length - 1]?.sec || 0;
    const totalSec  = days.reduce((s, d) => s + d.sec, 0);
    const totalChar = days.reduce((s, d) => s + d.chars, 0);
    const streak    = _calcStreak(readingLog);

    const BAR_W    = _currentRange <= 7 ? 28 : 12;
    const BAR_GAP  = _currentRange <= 7 ? 8  : 4;
    const CHART_H  = 80;
    const CHART_W  = days.length * (BAR_W + BAR_GAP) - BAR_GAP;

    let svgBars = '';
    days.forEach((d, i) => {
      const h       = Math.max(3, Math.round((d.sec  / maxSec)  * CHART_H));
      const hc      = Math.max(2, Math.round((d.chars / maxChar) * (CHART_H * 0.5)));
      const x       = i * (BAR_W + BAR_GAP);
      const min     = Math.round(d.sec / 60);
      const isToday = d.key === new Date().toISOString().slice(0, 10);
      svgBars += `
        <g class="report-bar-group" data-min="${min}" data-chars="${d.chars}" data-date="${d.key}">
          <title>${d.label}: ${min}분, ${d.chars.toLocaleString()}자</title>
          <rect x="${x}" y="${CHART_H - h}" width="${BAR_W}" height="${h}"
            rx="3" fill="${isToday ? 'var(--color-accent,#c47a3b)' : 'var(--color-border-soft,#d9d3c8)'}"
            style="transition:height 400ms ease;"/>
          <rect x="${x}" y="${CHART_H + 4}" width="${BAR_W}" height="${hc}"
            rx="2" fill="var(--color-accent-muted, rgba(196,122,59,0.28))"
            style="transition:height 400ms ease;"/>
          <text x="${x + BAR_W * 0.5}" y="${CHART_H + hc + 16}"
            text-anchor="middle" font-size="${_currentRange <= 7 ? 9 : 7}"
            fill="var(--color-ink-muted,#888)">${d.label}</text>
        </g>`;
    });
    const SVG_H = CHART_H + 50;

    container.innerHTML = '';

    const header  = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;';
    const titleEl = document.createElement('span');
    titleEl.style.cssText = 'font-size:13px;font-weight:600;color:var(--color-ink,#1a1814);';
    titleEl.textContent = `독서 리포트 — 최근 ${_currentRange}일`;
    const toggle  = document.createElement('div');
    toggle.style.cssText = 'display:flex;gap:4px;';
    [7, 30].forEach(n => {
      const btn = document.createElement('button');
      btn.textContent = `${n}일`;
      btn.style.cssText = `padding:3px 8px;border-radius:5px;border:1px solid var(--color-border,#ccc);font-size:11px;cursor:pointer;`
        + `background:${n === _currentRange ? 'var(--color-accent,#c47a3b)' : 'none'};`
        + `color:${n === _currentRange ? '#fff' : 'var(--color-ink-muted,#888)'};`;
      btn.addEventListener('click', () => { _currentRange = n; render(readingLog, containerId); });
      toggle.appendChild(btn);
    });
    header.appendChild(titleEl);
    header.appendChild(toggle);
    container.appendChild(header);

    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.setAttribute('viewBox', `0 0 ${CHART_W} ${SVG_H}`);
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', SVG_H);
    svgEl.setAttribute('aria-label', '독서 시간 차트');
    svgEl.innerHTML = svgBars;
    container.appendChild(svgEl);

    const summaryRow = document.createElement('div');
    summaryRow.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px;';
    const stats = [
      { label: '오늘',              value: `${Math.round(todaySec / 60)}분`   },
      { label: `${_currentRange}일 합계`, value: `${Math.round(totalSec / 60)}분` },
      { label: '연속 독서',          value: `${streak}일 🔥`                  },
    ];
    stats.forEach(s => {
      const card = document.createElement('div');
      card.style.cssText = 'text-align:center;background:var(--color-surface-subtle,#f9f7f4);border-radius:8px;padding:8px 4px;';
      const vEl = document.createElement('div');
      vEl.style.cssText = 'font-size:15px;font-weight:700;color:var(--color-ink,#1a1814);';
      vEl.textContent = s.value;
      const lEl = document.createElement('div');
      lEl.style.cssText = 'font-size:10px;color:var(--color-ink-muted,#888);margin-top:2px;';
      lEl.textContent = s.label;
      card.appendChild(vEl); card.appendChild(lEl);
      summaryRow.appendChild(card);
    });
    container.appendChild(summaryRow);

    if (totalChar > 0) {
      const charNote = document.createElement('p');
      charNote.style.cssText = 'margin:8px 0 0;font-size:11px;color:var(--color-ink-muted,#888);text-align:right;';
      charNote.textContent = `${_currentRange}일간 약 ${totalChar.toLocaleString()}자 읽음`;
      container.appendChild(charNote);
    }
  }

  function _buildDayArray(log, n) {
    const today  = new Date();
    const result = [];
    for (let i = n - 1; i >= 0; i--) {
      const d   = new Date(today);
      d.setDate(today.getDate() - i);
      const key  = d.toISOString().slice(0, 10);
      const rec  = log[key] || {};
      const sec  = typeof rec === 'number' ? rec : (rec.seconds || 0);
      const chars = rec.chars || 0;
      result.push({
        key, sec, chars,
        label: n <= 7 ? ['일','월','화','수','목','금','토'][d.getDay()] : String(d.getDate()),
      });
    }
    return result;
  }

  function _calcStreak(log) {
    let streak = 0;
    const today = new Date();
    for (let i = 0; i < 365; i++) {
      const d   = new Date(today);
      d.setDate(today.getDate() - i);
      const key  = d.toISOString().slice(0, 10);
      const rec  = log[key];
      const sec  = typeof rec === 'number' ? rec : (rec?.seconds || 0);
      if (sec > 0) streak++;
      else break;
    }
    return streak;
  }

  return { render };
})();

/* ══════════════════════════════════════════════════════════
   §23-D. 3D 종이 넘김 페이지 전환 레이어
   ══════════════════════════════════════════════════════════ */
/*
 * [v5.0 신규 — 고도화 #6] CSS 하드웨어 가속 강제 스위칭
 * ─────────────────────────────────────────────────────────────────
 * 기존 .fable-ptx--slide / .fable-ptx--flip-out / .fable-ptx--flip-in
 * 클래스는 transform/opacity 애니메이션만 정의했을 뿐 will-change
 * 힌트가 없었다. will-change 없이도 transform 애니메이션은 보통
 * 브라우저가 자체적으로 합성 레이어를 추론하지만, 애니메이션 시작과
 * 동시에 레이어 승격(promotion)이 일어나면 첫 프레임에 합성 비용이
 * 몰려 끊김(jank)이 발생할 수 있다. 애니메이션 시작 "직전"에
 * will-change: transform, opacity를 명시적으로 주입하면 브라우저가
 * 미리 GPU 레이어를 준비해두므로(레이어 승격을 애니메이션 시작 이전
 * 시점으로 앞당김), 자바스크립트 메인 스레드 연산 부담을 줄이고
 * 첫 프레임부터 GPU 합성 경로를 타도록 강제할 수 있다.
 *
 * 애니메이션 종료 후에는 will-change를 'auto'로 되돌려 GPU 메모리상의
 * 합성 레이어를 해제한다 — will-change를 영구히 남겨두면 오히려
 * 불필요한 레이어가 계속 유지되어 메모리/GPU 자원을 낭비하므로,
 * "전환이 진행되는 구간에서만" 한시적으로 활성화하는 것이 핵심이다.
 */
function _applyWillChange(el, props) {
  if (!el || !el.style) return;
  el.style.willChange = props;
}
function _clearWillChange(el) {
  if (!el || !el.style) return;
  el.style.willChange = 'auto';
}

const PageTransitionEngine = (() => {
  let _busy = false;
  const CSS = `
    @keyframes fable-fade-in { from { opacity:0; } to { opacity:1; } }
    @keyframes fable-slide-in { from { transform: translateX(6%); opacity:0; } to { transform: translateX(0); opacity:1; } }
    @keyframes fable-flip3d-out { 0% { transform: perspective(900px) rotateY(0deg); opacity:1; } 100% { transform: perspective(900px) rotateY(-90deg); opacity:0; } }
    @keyframes fable-flip3d-in  { 0% { transform: perspective(900px) rotateY(90deg); opacity:0; } 100% { transform: perspective(900px) rotateY(0deg);  opacity:1; } }
    .fable-ptx-layer { position:absolute; inset:0; z-index:8000; pointer-events:none; background:var(--color-page, #f4f1ea); transform-origin:left center; }
    .fable-ptx--fade    { animation: fable-fade-in   260ms ease forwards; }
    .fable-ptx--slide   { animation: fable-slide-in  280ms cubic-bezier(0.25,0.46,0.45,0.94) forwards; }
    .fable-ptx--flip-out { animation: fable-flip3d-out 200ms ease forwards; }
    .fable-ptx--flip-in  { animation: fable-flip3d-in  220ms ease 80ms forwards; opacity:0; }
  `;
  let _cssInjected = false;

  function _injectCSS() {
    if (_cssInjected) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    _cssInjected = true;
  }

  /*
   * [v5.0] 페이지 넘김 모드(flip3d/slide) 활성화 시 실제 책 콘텐츠를
   * 담는 viewer-viewport 자체에도 will-change를 동적으로 토글한다.
   * fade 모드는 transform을 사용하지 않으므로(순수 opacity) GPU 레이어
   * 승격의 이득이 작아 will-change를 적용하지 않고 자바스크립트 연산
   * 경로를 그대로 둔다 — 불필요한 합성 레이어 생성을 피해 메모리
   * 사용을 최소화하는 선택적 적용이다.
   */
  function syncHardwareAcceleration(mode) {
    const vp = _getViewport();
    if (!vp || vp === DOMProxy.VOID_NODE) return;
    if (mode === 'flip3d' || mode === 'slide') {
      _applyWillChange(vp, 'transform, opacity');
    } else {
      _clearWillChange(vp);
    }
  }

  function run(direction = 'next') {
    if (_busy) return;
    const mode = store.pageTransition || 'fade';
    if (mode === 'fade')   { _runFade();            return; }
    if (mode === 'slide')  { _runSlide(direction);  return; }
    if (mode === 'flip3d') { _runFlip3D(direction); return; }
  }

  function _getViewport() { return DOMProxy.get('viewer-viewport'); }

  function _runFade() {
    _injectCSS(); _busy = true;
    const vp = _getViewport();
    const layer = document.createElement('div');
    layer.className = 'fable-ptx-layer fable-ptx--fade';
    /* fade는 opacity 단독 전환이라 GPU 레이어 강제 승격 이득이 작지만,
       다른 두 모드와 동일한 일관된 인터페이스를 위해 가벼운 힌트만 부여. */
    _applyWillChange(layer, 'opacity');
    vp.appendChild(layer);
    layer.addEventListener('animationend', () => { _clearWillChange(layer); layer.remove(); _busy = false; }, { once: true });
    setTimeout(() => { if (layer.parentNode) { _clearWillChange(layer); layer.remove(); _busy = false; } }, 500);
  }

  function _runSlide(direction) {
    _injectCSS(); _busy = true;
    const vp = _getViewport();
    const layer = document.createElement('div');
    layer.className = 'fable-ptx-layer fable-ptx--slide';
    if (direction === 'prev') layer.style.animationName = 'fable-slide-in-rev';
    /* [v5.0] 슬라이드 전환 시작 직전 will-change를 주입해 GPU 합성
       레이어를 애니메이션 첫 프레임 이전에 미리 준비시킨다. */
    _applyWillChange(layer, 'transform, opacity');
    vp.appendChild(layer);
    layer.addEventListener('animationend', () => { _clearWillChange(layer); layer.remove(); _busy = false; }, { once: true });
    setTimeout(() => { if (layer.parentNode) { _clearWillChange(layer); layer.remove(); _busy = false; } }, 600);
  }

  function _runFlip3D(direction) {
    _injectCSS(); _busy = true;
    const vp = _getViewport();
    const layerOut = document.createElement('div');
    layerOut.className = 'fable-ptx-layer fable-ptx--flip-out';
    layerOut.style.transformOrigin = direction === 'next' ? 'left center' : 'right center';
    /* [v5.0] 3D 회전(rotateY)은 합성 비용이 가장 크므로 will-change를
       반드시 명시해 자바스크립트 메인 스레드 연산을 줄이고 GPU 경로를
       강제한다. backface-visibility는 fx.css의 .page-transition-flip3d
       규칙에서 이미 보존되고 있으므로 여기서는 will-change만 보강한다. */
    _applyWillChange(layerOut, 'transform, opacity');
    vp.appendChild(layerOut);
    const layerIn = document.createElement('div');
    layerIn.className = 'fable-ptx-layer fable-ptx--flip-in';
    layerIn.style.transformOrigin = direction === 'next' ? 'right center' : 'left center';
    _applyWillChange(layerIn, 'transform, opacity');
    vp.appendChild(layerIn);
    layerOut.addEventListener('animationend', () => { _clearWillChange(layerOut); layerOut.remove(); }, { once: true });
    layerIn.addEventListener('animationend',  () => { _clearWillChange(layerIn); layerIn.remove(); _busy = false; }, { once: true });
    setTimeout(() => {
      [layerOut, layerIn].forEach(el => { _clearWillChange(el); if (el.parentNode) el.remove(); });
      _busy = false;
    }, 600);
  }

  return { run, syncHardwareAcceleration };
})();

/* [v5.0] pageTransition 변경 시 viewer-viewport의 will-change를 즉시
   동기화 — 사용자가 설정 패널에서 모드를 바꾸는 순간부터 다음 페이지
   넘김 애니메이션이 올바른 가속 모드로 시작되도록 한다. */
ReactiveStore.subscribe('pageTransition', (mode) => {
  PageTransitionEngine.syncHardwareAcceleration(mode || 'fade');
});

/* ══════════════════════════════════════════════════════════
   §23-E. [v5.0 신규] 맥락형 빠른 설정(Contextual Quick Settings) 팝오버
   ─────────────────────────────────────────────────────────
   뷰어 본문(viewer-viewport) 중앙/하단 탭(Tap) 시 노출되는
   글래스모피즘 팝오버 툴바. 다음 3가지를 즉시 전환한다:
     1) 테마 순환 토글 (세피아=paper ↔ 다크=dark ↔ 라이트=white)
     2) 글자 크기 +/- 증감 (기존 btn-font-decrease/increase와 동일 step)
     3) 3D 페이지 넘김(paginated) ↔ 스크롤(scrolled) 모드 즉시 전환
   독서 흐름을 방해하지 않도록 자동 닫힘(외부 탭/Esc/팝오버 자체 재탭)과
   젠 모드(fxZenMode) 와 동일한 활동 감지 패턴을 공유한다.
   ══════════════════════════════════════════════════════════ */
const QuickSettingsPopover = (() => {
  let el = null;
  let _outsideHandler = null;
  let _autoCloseTimer = null;
  const AUTO_CLOSE_MS = 6000;
  const THEME_CYCLE = ['paper', 'dark', 'white'];

  function _injectCSSOnce() {
    if (DOMProxy.exists('quick-settings-popover')) return;
  }

  function _build() {
    const popover = document.createElement('div');
    popover.id = 'quick-settings-popover';
    popover.className = 'quick-settings-popover';
    popover.setAttribute('role', 'toolbar');
    popover.setAttribute('aria-label', '빠른 설정');

    /* 1) 테마 순환 토글 */
    const themeBtn = document.createElement('button');
    themeBtn.type = 'button';
    themeBtn.id = 'qsp-btn-theme';
    themeBtn.className = 'quick-settings-btn';
    themeBtn.setAttribute('aria-label', '테마 전환');
    themeBtn.title = '테마 전환 (세피아 → 다크 → 라이트)';
    const themeDot = document.createElement('span');
    themeDot.className = 'quick-settings-theme-dot';
    themeDot.dataset.themeDot = 'paper';
    themeBtn.appendChild(themeDot);

    const divider1 = document.createElement('div');
    divider1.className = 'quick-settings-divider';
    divider1.setAttribute('aria-hidden', 'true');

    /* 2) 글자 크기 +/- */
    const fontGroup = document.createElement('div');
    fontGroup.className = 'quick-settings-group';

    const fontMinusBtn = document.createElement('button');
    fontMinusBtn.type = 'button';
    fontMinusBtn.id = 'qsp-btn-font-minus';
    fontMinusBtn.className = 'quick-settings-btn';
    fontMinusBtn.setAttribute('aria-label', '글자 크기 줄이기');
    fontMinusBtn.textContent = 'A−';

    const fontLabel = document.createElement('span');
    fontLabel.id = 'qsp-font-label';
    fontLabel.className = 'quick-settings-font-label';
    fontLabel.textContent = `${store.fontSize}%`;

    const fontPlusBtn = document.createElement('button');
    fontPlusBtn.type = 'button';
    fontPlusBtn.id = 'qsp-btn-font-plus';
    fontPlusBtn.className = 'quick-settings-btn';
    fontPlusBtn.setAttribute('aria-label', '글자 크기 키우기');
    fontPlusBtn.textContent = 'A+';

    fontGroup.append(fontMinusBtn, fontLabel, fontPlusBtn);

    const divider2 = document.createElement('div');
    divider2.className = 'quick-settings-divider';
    divider2.setAttribute('aria-hidden', 'true');

    /* 3) 페이지 넘김 ↔ 스크롤 모드 토글 */
    const flowBtn = document.createElement('button');
    flowBtn.type = 'button';
    flowBtn.id = 'qsp-btn-flow';
    flowBtn.className = 'quick-settings-btn';
    flowBtn.setAttribute('aria-label', '보기 모드 전환');
    flowBtn.title = '3D 페이지 넘김 ↔ 스크롤 모드';
    flowBtn.textContent = store.flow === 'scrolled' ? '↕' : '▤';

    popover.append(themeBtn, divider1, fontGroup, divider2, flowBtn);
    return popover;
  }

  function _syncThemeDot() {
    const dot = DOMProxy.get('qsp-btn-theme')?.querySelector?.('.quick-settings-theme-dot');
    if (dot) dot.dataset.themeDot = THEME_CYCLE.includes(store.theme) ? store.theme : 'paper';
  }

  function _syncFontLabel() {
    setTextSafe(DOMProxy.get('qsp-font-label'), `${store.fontSize}%`);
  }

  function _syncFlowIcon() {
    const btn = DOMProxy.get('qsp-btn-flow');
    if (btn && btn !== DOMProxy.VOID_NODE) {
      btn.textContent = store.flow === 'scrolled' ? '↕' : '▤';
      btn.classList.toggle('active', store.flow === 'scrolled');
    }
  }

  function _resetAutoCloseTimer() {
    clearTimeout(_autoCloseTimer);
    _autoCloseTimer = setTimeout(close, AUTO_CLOSE_MS);
    ResourceRegistry.addTimer(_autoCloseTimer);
  }

  /*
   * [버그 수정 — C-3] 햅틱 반응 피드백 세분화 — 빠른 설정 버튼
   * ─────────────────────────────────────────────────────────────
   * 목표 달성 세레머니의 연속 진동(50-30-50ms)과 명확히 구분되도록,
   * 빠른 설정 패널의 단순 토글/증감 버튼에는 가벼운 단일 탭(10ms)만
   * 적용한다. Vibration API 미지원 환경 또는 사용자 상호작용 이전
   * 호출 시 발생하는 예외는 조용히 무시한다(A-9 가드).
   */
  function _lightTapHaptic() {
    try { navigator.vibrate?.(10); } catch (_) {}
  }

  function open() {
    if (!el) {
      _injectCSSOnce();
      el = _build();
      document.body.appendChild(el);

      DOMProxy.invalidate('qsp-btn-theme');
      DOMProxy.invalidate('qsp-font-label');
      DOMProxy.invalidate('qsp-btn-flow');

      el.querySelector('#qsp-btn-theme').addEventListener('click', (e) => {
        e.stopPropagation();
        _lightTapHaptic();
        const idx = THEME_CYCLE.indexOf(store.theme);
        const next = THEME_CYCLE[(idx + 1 + THEME_CYCLE.length) % THEME_CYCLE.length] || 'paper';
        store.theme = next;
        try { localStorage.setItem('fable_v3_state_theme_hint', next); } catch (_) {}
        _resetAutoCloseTimer();
      });

      el.querySelector('#qsp-btn-font-minus').addEventListener('click', (e) => {
        e.stopPropagation();
        _lightTapHaptic();
        store.fontSize = Math.max(60, store.fontSize - 5);
        _resetAutoCloseTimer();
      });
      el.querySelector('#qsp-btn-font-plus').addEventListener('click', (e) => {
        e.stopPropagation();
        _lightTapHaptic();
        store.fontSize = Math.min(200, store.fontSize + 5);
        _resetAutoCloseTimer();
      });

      el.querySelector('#qsp-btn-flow').addEventListener('click', async (e) => {
        e.stopPropagation();
        _lightTapHaptic();
        const next = store.flow === 'scrolled' ? 'paginated' : 'scrolled';
        store.flow = next;
        try { await switchFlowMode(next); } catch (err) { ErrorBoundary.handle('renderer', err, 'qsp:flow'); }
        _resetAutoCloseTimer();
      });

      el.addEventListener('pointerdown', (e) => e.stopPropagation());
    }

    _syncThemeDot();
    _syncFontLabel();
    _syncFlowIcon();

    requestAnimationFrame(() => { el.classList.add('is-open'); });
    store.quickPopoverOpen = true;

    if (!_outsideHandler) {
      _outsideHandler = (e) => {
        if (el && !el.contains?.(e.target)) close();
      };
      ResourceRegistry.addListener(document, 'pointerdown', _outsideHandler, { passive: true });
    }

    _resetAutoCloseTimer();
  }

  function close() {
    clearTimeout(_autoCloseTimer);
    if (el) el.classList.remove('is-open');
    store.quickPopoverOpen = false;
  }

  function toggle() {
    if (store.quickPopoverOpen) close();
    else open();
  }

  function isOpen() { return store.quickPopoverOpen === true; }

  return { open, close, toggle, isOpen };
})();

/* ══════════════════════════════════════════════════════════
   §23-F. [v5.0 신규] 목표 달성 앰버 파티클 세레머니 (GoalCelebration)
   ─────────────────────────────────────────────────────────
   일일 독서 목표(dailyGoalMin) 100% 달성 시 fx.css의 .goal-particle
   키프레임을 이용해 진행 바 주변에 앰버 파티클을 흩뿌린다.
   ReadingStatsTracker._updateUI()의 1회성 알림 지점(fill.dataset.notified)
   에서 호출되며, store.goalCelebrationShown 가드로 store 레벨에서도
   중복 실행을 차단한다. store.fxAnimation === false 인 경우 파티클 생성을
   생략하고 진동(Vibration API) 햅틱만 짧게 제안한다.
   ══════════════════════════════════════════════════════════ */
const GoalCelebration = (() => {
  const PARTICLE_COUNT = 14;
  const PARTICLE_COLORS = ['#c8864a', '#e0a868', '#a8682e'];

  function _vibrate() {
    /*
     * [버그 수정 — C-3] 햅틱 반응 피드백 세분화 — 목표 달성 세레머니
     * ─────────────────────────────────────────────────────────────
     * 앰버 파티클 버스트(_burstFrom)와 동기화된 연속 바이브레이션
     * 패턴(50ms 진동 - 30ms 정지 - 50ms 진동)을 사용한다. 빠른 설정
     * 버튼의 가벼운 단일 탭(10ms)과 명확히 구분되는 "성취감"의
     * 강도와 리듬을 전달한다. 디바이스가 미지원이거나 사용자
     * 상호작용 이전 호출(권한 예외) 시에는 조용히 무시한다.
     */
    try { navigator.vibrate?.([50, 30, 50]); } catch (_) {}
  }

  function _playChime() {
    /*
     * [버그 수정 — D-10] 목표 달성 차임 사운드 디자인 개선
     * ─────────────────────────────────────────────────────────────
     * 기존에는 880Hz→1320Hz로 상승하는 단일 사인파에 컴프레서나
     * 저역 필터가 전혀 없어, 고주파 + 무가공 신호 특유의 가늘고
     * 찌르는 듯한 인상을 주었다. 개선안:
     *   1) 기준 주파수를 따뜻하고 차분한 대역(523Hz, 음악적으로 C5)
     *      으로 낮춰 시작하고 완만하게 상승시킨다.
     *   2) BiquadFilterNode(lowpass, cutoff 2400Hz)를 신호 경로에
     *      추가해 고주파 성분의 거친 질감을 부드럽게 깎아낸다.
     *   3) DynamicsCompressorNode를 게인 다음, destination 직전에
     *      배치하여 피크를 완만하게 눌러 일관되고 부드러운 다이내믹을
     *      만든다.
     * 신호 경로: osc → filter(lowpass) → gain(envelope) → compressor
     *           → destination
     * 기존의 envelope 램프 패턴과 ctx.close() 정리 흐름은 그대로
     * 유지하여 리소스 누수 없이 동작한다.
     */
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();

      const osc        = ctx.createOscillator();
      const filter      = ctx.createBiquadFilter();
      const gain        = ctx.createGain();
      const compressor   = ctx.createDynamicsCompressor();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, ctx.currentTime);                          /* C5 — 따뜻한 기준음 */
      osc.frequency.exponentialRampToValueAtTime(659.25, ctx.currentTime + 0.22);      /* E5 — 완만한 상승 */

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2400, ctx.currentTime);
      filter.Q.setValueAtTime(0.7, ctx.currentTime);

      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.16, ctx.currentTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);

      compressor.threshold.setValueAtTime(-24, ctx.currentTime);
      compressor.knee.setValueAtTime(18, ctx.currentTime);
      compressor.ratio.setValueAtTime(8, ctx.currentTime);
      compressor.attack.setValueAtTime(0.003, ctx.currentTime);
      compressor.release.setValueAtTime(0.25, ctx.currentTime);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(compressor);
      compressor.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.6);
      setTimeout(() => { try { ctx.close(); } catch (_) {} }, 700);
    } catch (_) {}
  }

  function _burstFrom(anchorEl) {
    if (!anchorEl || anchorEl === DOMProxy.VOID_NODE) return;
    let rect = anchorEl.getBoundingClientRect?.();

    /* [v5.0 안전장치] 앵커 요소가 display:none인 모달(stats-modal) 내부에
       있을 경우 rect가 {0,0,0,0}으로 측정되어 파티클이 좌상단에 뭉치는
       시각적 결함이 발생한다. 이 경우 화면 하단 중앙으로 폴백한다. */
    const isInvisible = !rect || (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0);
    if (isInvisible) {
      rect = {
        left: window.innerWidth / 2 - 60, top: window.innerHeight - 160,
        width: 120, height: 8,
      };
    }

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed; left:0; top:0; width:0; height:0; pointer-events:none; z-index:9950;';
    document.body.appendChild(host);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = document.createElement('span');
      p.className = 'goal-particle';
      const size = 4 + Math.random() * 5;
      const tx   = (Math.random() - 0.5) * 70;
      const dur  = 0.6 + Math.random() * 0.5;
      const x    = rect.left + rect.width  * Math.random();
      const y    = rect.top  + rect.height * Math.random();
      p.style.left   = `${x}px`;
      p.style.top    = `${y}px`;
      p.style.width  = `${size}px`;
      p.style.height = `${size}px`;
      p.style.setProperty('--tx', `${tx}px`);
      p.style.setProperty('--dur', `${dur}s`);
      p.style.background = PARTICLE_COLORS[i % PARTICLE_COLORS.length];
      host.appendChild(p);
      p.addEventListener('animationend', () => p.remove(), { once: true });
    }

    setTimeout(() => { host.remove(); }, 1400);
  }

  function celebrate() {
    if (store.goalCelebrationShown) return;
    store.goalCelebrationShown = true;

    _vibrate();
    _playChime();

    if (store.fxAnimation === false) return;

    const fill = DOMProxy.get('goal-progress-fill');
    _burstFrom(fill);

    const card = DOMProxy.q('.dash-card--goal');
    if (card && card !== DOMProxy.VOID_NODE) {
      card.classList.add('goal-achieved');
      setTimeout(() => card.classList.remove('goal-achieved'), 1300);
    }
  }

  /* 새로운 날짜로 넘어가면(자정 경과) 가드를 재설정해야 하므로,
     readingSession.startTime 기준 날짜와 현재 날짜를 비교해 리셋한다.
     ReadingStatsTracker.startSession()이 새 세션을 열 때 호출된다. */
  function resetDailyGuard() {
    store.goalCelebrationShown = false;
  }

  return { celebrate, resetDailyGuard };
})();

/* ══════════════════════════════════════════════════════════
   §24-X. TTS 시스템
   ─────────────────────────────────────────────────────────
   [v4.2 고도화]
   · stop()       : speechSynthesis.cancel() + store.isTtsPlaying = false
                    + tts-player-bar 숨김 + progress 초기화
   · play()       : 재생 시작 시 store.isTtsPlaying = true,
                    onend / onerror 에서 false 로 복원
                    선택된 목소리(store.ttsVoice) 적용
   · pauseResume(): 일시정지/재개 시 store.isTtsPlaying 동기화
   · loadVoices() : speechSynthesis.getVoices() 비동기 로드
                    ko-KR 우선 정렬, store.ttsVoice 초기값 설정
   · initVoiceSelector(): tts-voice-select DOM 셀렉트 박스 구성
   ══════════════════════════════════════════════════════════ */
const TTSSystem = (() => {
  let utterance = null, isPaused = false, totalLen = 0;
  /* [v4.2] 로드된 목소리 배열 보존 — 한국어 우선, 이후 기타 다국어 정렬 */
  let _voices = [];

  /* ── 목소리 로드 ── */
  function loadVoices() {
    const raw = window.speechSynthesis?.getVoices?.() || [];
    if (raw.length === 0) return;

    const seen = new Set();
    _voices = raw.filter(v => {
      if (seen.has(v.voiceURI)) return false;
      seen.add(v.voiceURI);
      return true;
    }).sort((a, b) => {
      const aKo = a.lang.startsWith('ko') ? 0 : 1;
      const bKo = b.lang.startsWith('ko') ? 0 : 1;
      if (aKo !== bKo) return aKo - bKo;
      return a.lang.localeCompare(b.lang);
    });

    if (!store.ttsVoice) {
      const koVoice = _voices.find(v => v.lang.startsWith('ko'));
      store.ttsVoice = koVoice ? koVoice.voiceURI : (_voices[0]?.voiceURI || '');
    }
  }

  /* voiceschanged 이벤트 구독 — 비동기 로드 완료 시 재적재 */
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      loadVoices();
      _rebuildVoiceOptions();
    });
    loadVoices();
  }

  /* ── 셀렉트 박스 옵션 재구성 (내부 헬퍼) ── */
  function _rebuildVoiceOptions() {
    const sel = DOMProxy.get('tts-voice-select');
    if (!sel || sel === DOMProxy.VOID_NODE) return;
    sel.innerHTML = '';
    _voices.forEach(v => {
      const opt = document.createElement('option');
      opt.value       = v.voiceURI;
      opt.textContent = `${v.name} (${v.lang})`;
      sel.appendChild(opt);
    });
    sel.value = store.ttsVoice || '';
  }

  /* ── 셀렉트 박스 초기화 (main.js 에서 호출) ── */
  function initVoiceSelector() {
    loadVoices();
    _rebuildVoiceOptions();
  }

  /* ── 현재 선택된 목소리 객체 반환 ── */
  function _getSelectedVoice() {
    if (!store.ttsVoice || _voices.length === 0) return null;
    return _voices.find(v => v.voiceURI === store.ttsVoice) || null;
  }

  /* ── play ── */
  function play(text) {
    if (!text) return;
    window.speechSynthesis.cancel();
    totalLen  = text.length;
    utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 1.0;

    /* [v4.2] 선택된 목소리 적용 */
    const voice = _getSelectedVoice();
    if (voice) utterance.voice = voice;

    utterance.onboundary = (e) => {
      if (e.charIndex != null) {
        const fill = DOMProxy.get('tts-progress-fill');
        if (fill && fill !== DOMProxy.VOID_NODE)
          fill.style.width = `${Math.min(100, (e.charIndex / totalLen) * 100)}%`;
      }
    };
    utterance.onend = utterance.onerror = () => {
      store.isTtsPlaying = false;
      isPaused = false;
      const bar  = DOMProxy.get('tts-player-bar');
      const fill = DOMProxy.get('tts-progress-fill');
      if (bar  && bar  !== DOMProxy.VOID_NODE) bar.style.display  = 'none';
      if (fill && fill !== DOMProxy.VOID_NODE) fill.style.width   = '0%';
    };
    isPaused = false;
    window.speechSynthesis.speak(utterance);

    /* [v4.2] 재생 시작 시 isTtsPlaying true */
    store.isTtsPlaying = true;

    const bar = DOMProxy.get('tts-player-bar');
    if (bar && bar !== DOMProxy.VOID_NODE) bar.style.display = 'flex';
    setTextSafe(DOMProxy.get('btn-tts-play-pause'), '⏸');
  }

  /* ── pauseResume ── */
  function pauseResume() {
    if (!window.speechSynthesis.speaking && !isPaused) return;
    if (isPaused) {
      window.speechSynthesis.resume();
      isPaused = false;
      store.isTtsPlaying = true;
      setTextSafe(DOMProxy.get('btn-tts-play-pause'), '⏸');
    } else {
      window.speechSynthesis.pause();
      isPaused = true;
      store.isTtsPlaying = false;
      setTextSafe(DOMProxy.get('btn-tts-play-pause'), '▶');
    }
  }

  /* ── stop ── */
  function stop() {
    window.speechSynthesis.cancel();
    isPaused = false;
    utterance = null;
    store.isTtsPlaying = false;
    const bar  = DOMProxy.get('tts-player-bar');
    const fill = DOMProxy.get('tts-progress-fill');
    if (bar  && bar  !== DOMProxy.VOID_NODE) bar.style.display  = 'none';
    if (fill && fill !== DOMProxy.VOID_NODE) fill.style.width   = '0%';
    setTextSafe(DOMProxy.get('btn-tts-play-pause'), '▶');
  }

  return { play, pauseResume, stop, loadVoices, initVoiceSelector };
})();

/* ══════════════════════════════════════════════════════════
   §27. 독서 통계
   ══════════════════════════════════════════════════════════ */
const ReadingStatsTracker = (() => {
  let timer = null;
  let pendingSeconds = 0;

  /*
   * [v5.0 신규 — 고도화 #3] GoalCelebration 주행 가드 정밀화
   * ─────────────────────────────────────────────────────────────────
   * 기존 한계: _checkDateRollover()가 startSession() 호출 시점에만
   * 실행되었다. 자정 전(예: 23:50)에 독서를 시작해 세션을 끝내지 않고
   * 자정을 넘겨 계속 읽는 경우, setInterval은 계속 같은 세션으로
   * 동작하므로 startSession()이 재호출되지 않아 goalCelebrationShown
   * 가드가 갱신되지 않는다. 즉 "오늘 목표 달성 1회성 트리거"가 날짜가
   * 바뀐 뒤에도 실제로는 갱신되지 않을 수 있었다.
   *
   * 개선: 날짜 롤오버 체크를 1초 간격 tick(_updateUI 직전)에서도
   * 수행한다. 로컬 타임존 기준 Date().toDateString() 데이트 스탬프를
   * localStorage에 저장된 마지막 키와 비교하는 방식은 그대로 유지하되,
   * "세션 시작 시점"이 아니라 "매 tick"으로 검사 지점을 옮겨 자정을
   * 넘기는 장시간 세션에서도 정확히 1회만 리셋되도록 한다. 같은 틱
   * 안에서 중복 리셋이 발생하지 않도록 localStorage 키 갱신을 비교-후-
   * 기록 패턴으로 원자적으로 처리한다.
   *
   * 추가로, progress fill의 dataset.notified DOM 가드는 날짜가 바뀌어도
   * 자동으로 초기화되지 않는 별도의 1회성 트리거였다. 날짜 롤오버 시
   * 이 DOM 가드도 함께 리셋하여, store.goalCelebrationShown과
   * dataset.notified 두 가드가 항상 같은 "오늘" 기준으로 동기화되도록
   * 보장한다(불일치 시 자정 이후 목표 재달성에도 세레머니가 끝까지
   * 재발동하지 않는 회귀를 차단).
   */
  function _checkDateRollover() {
    const todayKey = new Date().toDateString();
    const lastKey  = localStorage.getItem('fable_goal_celebration_date');
    if (lastKey === todayKey) return false;

    localStorage.setItem('fable_goal_celebration_date', todayKey);
    GoalCelebration.resetDailyGuard();

    /* DOM 레벨 1회성 가드도 함께 리셋 — store 가드와 동기화 보장 */
    const fill = DOMProxy.get('goal-progress-fill');
    if (fill && fill !== DOMProxy.VOID_NODE && fill.dataset) {
      delete fill.dataset.notified;
    }
    return true;
  }

  function startSession() {
    store.readingSession.startTime = Date.now();
    _checkDateRollover();
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        /* [v5.0] 매 tick마다 날짜 롤오버를 점검해, 자정을 넘기는
           장시간 세션에서도 가드가 정확히 1회만 리셋되도록 한다. */
        _checkDateRollover();
        store.readingSession.accumulated++;
        pendingSeconds++;
        _updateUI();
        if (pendingSeconds >= 30) {
          StorageSystem.addReadingSeconds(pendingSeconds);
          pendingSeconds = 0;
        }
      }
    }, 1000);
    ResourceRegistry.addTimer(timer);
  }

  function stopSession() {
    clearInterval(timer);
    if (pendingSeconds > 0) { StorageSystem.addReadingSeconds(pendingSeconds); pendingSeconds = 0; }
  }

  function markPosition(cfi) { if (cfi) store.readingSession.positions.add(cfi); _updateUI(); }

  function _updateUI() {
    const total = store.readingSession.accumulated;
    const min   = Math.floor(total / 60);
    const sec   = total % 60;
    setTextSafe(DOMProxy.get('stat-reading-time'), `${min}분 ${sec}초`);
    setTextSafe(DOMProxy.get('stat-pages-read'), String(store.readingSession.positions.size));
    const goalMin = parseInt(localStorage.getItem('fable_daily_goal') || '30', 10);
    const fill    = DOMProxy.get('goal-progress-fill');
    const pct     = Math.min(100, (min / goalMin) * 100);
    fill.style.transition = 'width 600ms cubic-bezier(0.34,1.56,0.64,1)';
    fill.style.width = `${pct}%`;
    DOMProxy.q('.goal-track').setAttribute('aria-valuenow', Math.round(pct));
    if (pct >= 100 && fill.dataset.notified !== '1') {
      fill.dataset.notified = '1';
      Toast.show('🎉 오늘의 독서 목표를 달성했습니다!', 'success');
      /* [v5.0] 앰버 파티클 세레머니 — 효과음 + 햅틱 + 진행 바 파티클 버스트 */
      GoalCelebration.celebrate();
    }
  }

  return { startSession, stopSession, markPosition };
})();

/* ══════════════════════════════════════════════════════════
   §28. 컨텍스트 메뉴 (롱프레스)
   ══════════════════════════════════════════════════════════ */
function initContextMenu() {
  const viewer = DOMProxy.get('screen-viewer');
  if (!DOMProxy.exists('screen-viewer')) return;
  let longPressTimer = null, selectedText = '';

  function showMenu() {
    if (!selectedText) return;
    const m = DOMProxy.get('context-menu');
    m.style.display = 'flex';
    m.classList.add('slide-up');
  }
  function hideMenu() {
    const m = DOMProxy.get('context-menu');
    m.classList.remove('slide-up');
    setTimeout(() => { m.style.display = 'none'; }, 280);
  }

  const onStart = () => {
    longPressTimer = setTimeout(() => {
      if (store.rendition) {
        try {
          DOMProxy.get('viewer-viewport').querySelectorAll('iframe').forEach(f => {
            const s = f.contentWindow?.getSelection()?.toString()?.trim();
            if (s?.length > 1) selectedText = s;
          });
        } catch (_) {}
      }
      if (selectedText) showMenu();
    }, 600);
  };

  ResourceRegistry.addListener(viewer, 'touchstart', onStart, { passive: true });
  ResourceRegistry.addListener(viewer, 'touchend',   () => clearTimeout(longPressTimer), { passive: true });
  ResourceRegistry.addListener(viewer, 'touchmove',  () => clearTimeout(longPressTimer), { passive: true });
  ResourceRegistry.addListener(document, 'pointerdown', (e) => {
    if (!DOMProxy.get('context-menu').contains?.(e.target)) { hideMenu(); selectedText = ''; }
  }, { passive: true });

  DOMProxy.get('ctx-copy').addEventListener('click', () => {
    if (selectedText) navigator.clipboard?.writeText(selectedText).catch(() => {});
    Toast.show('클립보드에 복사했습니다.');
    hideMenu();
  });
  DOMProxy.get('ctx-tts').addEventListener('click', () => {
    if (selectedText) TTSSystem.play(selectedText);
    hideMenu();
  });
  DOMProxy.get('ctx-search').addEventListener('click', () => {
    const m = DOMProxy.get('search-modal'), i = DOMProxy.get('input-search-query');
    i.value = selectedText;
    m.style.display = 'flex';
    store.isSearching = true;
    runSearchExecution();
    hideMenu();
  });
  DOMProxy.get('ctx-highlight').addEventListener('click', () => {
    Toast.show('하이라이트 기능은 텍스트 선택 후 자동 추가됩니다.');
    hideMenu();
  });
}

/* ══════════════════════════════════════════════════════════
   §29. Annotation Manager
   ══════════════════════════════════════════════════════════ */

/*
 * [버그 수정 — C-8] 다크모드 전환 시 스마트 하이라이터 컬러 보정
 * ─────────────────────────────────────────────────────────────
 * epub.js의 rendition.annotations.add()는 'highlight' 타입에 대해
 * className만으로는 실제 SVG fill 색상이 바뀌지 않는다(고정값
 * fill:'yellow' 폴백) — styles 인자(6번째 파라미터)로 직접
 * fill/fill-opacity를 지정해야 한다. 또한 라이트 테마 기준의
 * 고정 알파값을 다크 테마에 그대로 쓰면 형광펜이 과도하게 밝아
 * 눈부심을 유발한다. 색상별 베이스 hue는 유지하면서, 테마에 따라
 * fill-opacity와 명도를 실시간 보정한다.
 */
const HIGHLIGHT_COLORS = {
  yellow: { light: '#ffd83c', dark: '#ad8a1a' },
  blue:   { light: '#64b4ff', dark: '#3d6f99' },
  green:  { light: '#5fdc8c', dark: '#327a4e' },
};

function _resolveHighlightStyle(colorKey) {
  const def = HIGHLIGHT_COLORS[colorKey] || HIGHLIGHT_COLORS.yellow;
  const isDark = store.theme === 'dark';
  return {
    fill: isDark ? def.dark : def.light,
    'fill-opacity': isDark ? '0.38' : '0.34',
    'mix-blend-mode': 'multiply',
  };
}

const AnnotationManager = (() => {
  let _rendition = null;
  /* 현재 뷰에 적용된 어노테이션을 테마 변경 시 재도색하기 위해
     cfiRange/color/uuid를 보존해 둔다. */
  let _activeAnnotations = [];

  function init(rendition) {
    _rendition = rendition;
    _activeAnnotations = [];
    rendition.on('selected', async (cfiRange, contents) => {
      const sel = contents.window.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim().length < 2) return;
      try {
        const ann = await AnnotationSyncEngine.create(store.bookKey, cfiRange, sel.toString().trim(), 'yellow');
        rendition.annotations.add(
          'highlight', cfiRange, { uuid: ann.uuid }, null,
          'hl-yellow', _resolveHighlightStyle('yellow'),
        );
        _activeAnnotations.push({ cfiRange, uuid: ann.uuid, color: 'yellow' });
        Toast.show('하이라이트가 저장되었습니다.', 'success');
      } catch (e) {
        ErrorBoundary.handle('storage', e, 'annotation:create');
      }
    });
  }

  function restoreAll(annotations) {
    if (!_rendition) return;
    annotations.forEach(ann => {
      const color = ann.color || 'yellow';
      try {
        _rendition.annotations.add(
          'highlight', ann.cfiRange, { uuid: ann.uuid }, null,
          'hl-' + color, _resolveHighlightStyle(color),
        );
        _activeAnnotations.push({ cfiRange: ann.cfiRange, uuid: ann.uuid, color });
      } catch (_) {}
    });
  }

  /*
   * [버그 수정 — C-8] 테마 전환 시 형광펜 재도색
   * ─────────────────────────────────────────────────────────────
   * epub.js는 이미 그려진 SVG highlight의 fill을 사후에 바꿀 API를
   * 제공하지 않으므로, 동일 cfiRange에 대해 remove 후 새 스타일로
   * 다시 add하는 방식으로 갱신한다. reapplyInlineTheme()과 같은
   * 흐름에서 store.theme 변경 직후 호출되도록 main.js에서 연동한다.
   */
  function repaintForTheme() {
    if (!_rendition || !_activeAnnotations.length) return;
    _activeAnnotations.forEach(({ cfiRange, uuid, color }) => {
      try {
        _rendition.annotations.remove(cfiRange, 'highlight');
        _rendition.annotations.add(
          'highlight', cfiRange, { uuid }, null,
          'hl-' + color, _resolveHighlightStyle(color),
        );
      } catch (_) {}
    });
  }

  function reset() { _rendition = null; _activeAnnotations = []; }

  return { init, restoreAll, reset, repaintForTheme };
})();

/* §34. 스크롤 맨위로 버튼 */
function bindScrollTopButton(view) {
  const btn    = DOMProxy.get('btn-scroll-top');
  const iframe = view?.element?.querySelector('iframe');
  if (!iframe) return;
  const cw = iframe.contentWindow;
  if (!cw) return;
  const onScroll = () => { btn.style.display = cw.scrollY > 200 ? 'flex' : 'none'; };
  ResourceRegistry.addListener(cw, 'scroll', onScroll, { passive: true });
  btn.onclick = () => cw.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ══════════════════════════════════════════════════════════
   §35. MetadataEditor
   ══════════════════════════════════════════════════════════ */
const MetadataEditor = (() => {
  let _book = null;

  function open(book) {
    _book = book;
    DOMProxy.get('meta-edit-title').value     = book.title || '';
    DOMProxy.get('meta-edit-creator').value   = book.creator || '';
    DOMProxy.get('meta-edit-publisher').value = book.publisher || '';
    const preview = DOMProxy.get('meta-edit-cover-preview');
    if (book.coverDataUrl) { preview.src = book.coverDataUrl; preview.style.display = 'block'; }
    else preview.style.display = 'none';
    preview.dataset.newCover = '';
    DOMProxy.get('metadata-modal').style.display = 'flex';
  }

  function close() { DOMProxy.get('metadata-modal').style.display = 'none'; _book = null; }

  async function save() {
    if (!_book) return;
    const preview = DOMProxy.get('meta-edit-cover-preview');
    const payload = {
      title:        DOMProxy.get('meta-edit-title').value.trim() || '제목 없음',
      creator:      DOMProxy.get('meta-edit-creator').value.trim(),
      publisher:    DOMProxy.get('meta-edit-publisher').value.trim(),
      coverDataUrl: preview.dataset.newCover || null,
    };
    await StorageSystem.updateBookMeta(_book.bookKey, payload);
    await refreshLibraryData();
    Toast.show('도서 정보가 수정되었습니다.', 'success');
    close();
  }

  function init() {
    if (!DOMProxy.exists('metadata-modal')) return;
    DOMProxy.get('btn-meta-edit-close').addEventListener('click', close);
    DOMProxy.get('btn-meta-edit-save').addEventListener('click', save);
    DOMProxy.get('meta-edit-cover-input').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const MAX = 200, ratio = Math.min(MAX / img.width, MAX / img.height, 1);
          canvas.width  = Math.round(img.width  * ratio);
          canvas.height = Math.round(img.height * ratio);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          const preview = DOMProxy.get('meta-edit-cover-preview');
          preview.src = dataUrl;
          preview.style.display = 'block';
          preview.dataset.newCover = dataUrl;
        };
        img.src = evt.target.result;
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    });
  }

  return { open, close, save, init };
})();

/* ══════════════════════════════════════════════════════════
   §36. AnnotationExporter (Markdown / JSON / PDF)
   ══════════════════════════════════════════════════════════ */
const AnnotationExporter = (() => {
  let _book = null;

  async function open(book) {
    _book = book;
    const anns = await StorageSystem.getAnnotationsByBook(book.bookKey);
    if (!anns.length) { Toast.show('내보낼 하이라이트/메모가 없습니다.', 'info'); return; }
    DOMProxy.get('export-modal').style.display = 'flex';
    setTextSafe(DOMProxy.get('export-modal-info'), `${book.title || '제목 없음'} — ${anns.length}개 항목`);
  }

  function close() { DOMProxy.get('export-modal').style.display = 'none'; _book = null; }

  function _download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportAs(format) {
    if (!_book) return;
    const anns      = await StorageSystem.getAnnotationsByBook(_book.bookKey);
    const safeTitle = (_book.title || 'book').replace(/[^a-zA-Z0-9가-힣]/g, '_').slice(0, 40);
    const sorted    = anns.slice().sort((a, b) => (a.device_timestamp || 0) - (b.device_timestamp || 0));

    if (format === 'json') {
      _download(`${safeTitle}_notes.json`, JSON.stringify(sorted, null, 2), 'application/json');
    } else if (format === 'markdown') {
      let md = `# ${_book.title || '제목 없음'}\n`;
      if (_book.creator) md += `*${_book.creator}*\n`;
      md += `\n> 하이라이트 ${sorted.length}개 · 내보낸 날짜 ${new Date().toLocaleDateString('ko-KR')}\n\n---\n\n`;
      sorted.forEach((a, i) => {
        md += `### ${i + 1}.\n> ${a.text || ''}\n\n`;
        if (a.note) md += `**메모:** ${a.note}\n\n`;
      });
      _download(`${safeTitle}_notes.md`, md, 'text/markdown');
    } else if (format === 'pdf') {
      _exportPdf(_book, sorted, safeTitle);
    }
    Toast.show('내보내기가 완료되었습니다.', 'success');
    close();
  }

  function _exportPdf(book, anns, safeTitle) {
    const lines = [];
    lines.push(book.title || '제목 없음');
    if (book.creator) lines.push(book.creator);
    lines.push(`Highlights: ${anns.length}`);
    lines.push('');
    anns.forEach((a, i) => {
      const text    = (a.text || '').replace(/[()\\]/g, ' ');
      const wrapped = text.match(/.{1,80}/g) || [text];
      lines.push(`${i + 1}. ${wrapped[0]}`);
      for (let j = 1; j < wrapped.length; j++) lines.push(`   ${wrapped[j]}`);
      if (a.note) lines.push(`   [Note] ${a.note}`);
      lines.push('');
    });
    let stream = 'BT /F1 11 Tf 50 780 Td 14 TL\n';
    lines.forEach(line => {
      const safe = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
      stream += `(${safe}) Tj T*\n`;
    });
    stream += 'ET';
    const objects = [];
    objects.push('<< /Type /Catalog /Pages 2 0 R >>');
    objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    let pdf = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((obj, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
    const xrefPos = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach(off => { pdf += String(off).padStart(10, '0') + ' 00000 n \n'; });
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
    _download(`${safeTitle}_notes.pdf`, pdf, 'application/pdf');
  }

  function init() {
    if (!DOMProxy.exists('export-modal')) return;
    DOMProxy.get('btn-export-close').addEventListener('click', close);
    DOMProxy.get('btn-export-md').addEventListener('click', () => exportAs('markdown'));
    DOMProxy.get('btn-export-json').addEventListener('click', () => exportAs('json'));
    DOMProxy.get('btn-export-pdf').addEventListener('click', () => exportAs('pdf'));
  }

  return { open, close, init };
})();

/* ══════════════════════════════════════════════════════════
   §37. LibraryFullTextSearch
   ══════════════════════════════════════════════════════════ */
const LibraryFullTextSearch = (() => {
  let _running = false;

  function open() {
    DOMProxy.get('fts-modal').style.display = 'flex';
    /* [v4.2] 전문 검색 모달 열릴 때 isSearching 활성 */
    store.isSearching = true;
    setTimeout(() => DOMProxy.get('fts-input').focus(), 60);
  }

  function close() {
    DOMProxy.get('fts-modal').style.display = 'none';
    /* [v4.2] 전문 검색 모달 닫힐 때 isSearching 해제 */
    store.isSearching = false;
  }

  async function run() {
    if (_running) return;
    const q = DOMProxy.get('fts-input').value.trim();
    if (q.length < 2) { Toast.show('검색어는 2글자 이상 입력하세요.', 'error'); return; }
    _running = true;
    const resultsEl = DOMProxy.get('fts-results');
    resultsEl.innerHTML = '<p class="fts-status">전체 서재 본문을 검색 중입니다...</p>';
    const books   = store.libraryBooks || [];
    const allHits = [];
    const ready   = await waitForEpubJS();
    if (!ready) { resultsEl.innerHTML = '<p class="fts-status">epub.js 로드 실패</p>'; _running = false; return; }
    for (const b of books) {
      await ErrorBoundary.wrap('renderer', async () => {
        const book = window.ePub(b.bytes.slice(0));
        const ok   = await awaitBookReady(book, 10000);
        if (!ok) { try { book.destroy(); } catch (_) {} return; }
        const parser = new DOMParser();
        const items  = book.spine?.items || [];
        let bookHits = 0;
        for (const item of items) {
          if (bookHits >= 5) break;
          try {
            const section = book.spine.get(item.href || item.idref);
            if (!section) continue;
            await section.load(book.load.bind(book));
            const doc   = parser.parseFromString(section.content || '<html></html>', 'text/html');
            const paras = Array.from(doc.querySelectorAll('p,h1,h2,h3,li'));
            for (const p of paras) {
              const text = p.textContent || '';
              const pos  = text.toLowerCase().indexOf(q.toLowerCase());
              if (pos >= 0) {
                let cfi = '';
                try { cfi = section.cfiFromElement(p); } catch (_) { cfi = item.href; }
                allHits.push({ bookKey: b.bookKey, title: b.title, cfi, snippet: text.slice(Math.max(0, pos - 30), pos + 50) });
                bookHits++;
                if (bookHits >= 5) break;
              }
            }
            section.unload();
          } catch (_) {}
        }
        try { book.destroy(); } catch (_) {}
      })();
      await new Promise(r => setTimeout(r, 0));
    }
    _running = false;
    _renderResults(allHits, q);
  }

  function _renderResults(hits, q) {
    const resultsEl = DOMProxy.get('fts-results');
    resultsEl.innerHTML = '';
    if (!hits.length) { resultsEl.innerHTML = '<p class="fts-status">검색 결과가 없습니다.</p>'; return; }
    VirtualListRenderer.render(resultsEl, hits, (hit) => {
      const item  = document.createElement('div');
      item.className = 'fts-result-item';
      const title = document.createElement('div');
      title.className = 'fts-result-title';
      title.textContent = `📖 ${hit.title || '제목 없음'}`;
      const snip  = document.createElement('div');
      snip.className = 'fts-result-snippet';
      snip.innerHTML = '';
      /* [v4.2 버그 수정] split(re) 루프의 stateful RegExp lastIndex 교번 매칭 버그 수정
         reSplit(split용 gi) + reTest(test용 i, g 플래그 없음) 완전 분리
         → reTest 는 lastIndex 변이 없으므로 루프 재진입 시 안전 */
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const reSplit = new RegExp(`(${escaped})`, 'gi');
      const reTest  = new RegExp(escaped, 'i');
      hit.snippet.split(reSplit).forEach(part => {
        if (reTest.test(part)) {
          const m = document.createElement('mark');
          m.textContent = part;
          snip.appendChild(m);
        } else {
          snip.appendChild(document.createTextNode(part));
        }
      });
      item.appendChild(title);
      item.appendChild(snip);
      item.addEventListener('click', async () => {
        close();
        const rec = await StorageSystem.getBook(hit.bookKey);
        if (rec) {
          await openEpubBook(rec.bytes, true);
          setTimeout(() => { try { store.rendition?.display(hit.cfi); } catch (_) {} }, 1200);
        }
      });
      return item;
    });
  }

  function init() {
    if (!DOMProxy.exists('fts-modal')) return;
    DOMProxy.get('btn-fts-close').addEventListener('click', close);
    DOMProxy.get('btn-fts-run').addEventListener('click', run);
    DOMProxy.get('fts-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  run();
      if (e.key === 'Escape') close();
    });
  }

  return { open, close, init };
})();

/* ══════════════════════════════════════════════════════════
   §38. VirtualListRenderer
   ══════════════════════════════════════════════════════════ */
const VirtualListRenderer = (() => {
  const CHUNK  = 20;
  const states = new WeakMap();

  function render(container, items, builderFn) {
    if (!container) return;
    container.innerHTML = '';
    let rendered = 0;
    const sentinel = document.createElement('div');
    sentinel.style.height = '1px';
    function renderChunk() {
      const end  = Math.min(rendered + CHUNK, items.length);
      const frag = document.createDocumentFragment();
      for (; rendered < end; rendered++) frag.appendChild(builderFn(items[rendered]));
      container.insertBefore(frag, sentinel);
    }
    renderChunk();
    container.appendChild(sentinel);
    const obs = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && rendered < items.length) {
        renderChunk();
        container.appendChild(sentinel);
      }
    }, { root: container, threshold: 0.1 });
    obs.observe(sentinel);
    states.set(container, obs);
  }

  function destroy(container) {
    const obs = states.get(container);
    if (obs) { obs.disconnect(); states.delete(container); }
  }

  return { render, destroy };
})();

/* ══════════════════════════════════════════════════════════
   §39. CloudBackup
   ══════════════════════════════════════════════════════════ */
const CloudBackup = (() => {
  async function backupToFile() {
    Toast.show('백업 데이터를 생성 중입니다...', 'info');
    const data = await StorageSystem.exportDatabase();
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `fable_backup_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    Toast.show('서재 백업 파일이 저장되었습니다.', 'success');
  }

  async function restoreFromFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!confirm('백업을 복원하면 동일 키의 기존 데이터가 덮어쓰기됩니다. 계속하시겠습니까?')) return;
      await StorageSystem.importDatabase(data);
      await refreshLibraryData();
      Toast.show('서재가 복원되었습니다.', 'success');
    } catch (err) {
      ErrorBoundary.handle('storage', err, 'restore');
      Toast.show('복원 실패: 유효하지 않은 백업 파일입니다.', 'error');
    }
  }

  function init() {
    if (DOMProxy.exists('restore-file-input')) {
      DOMProxy.get('restore-file-input').addEventListener('change', (e) => {
        if (e.target.files[0]) restoreFromFile(e.target.files[0]);
        e.target.value = '';
      });
    }
  }

  return { backupToFile, restoreFromFile, init };
})();

/* ══════════════════════════════════════════════════════════
   §40. Pomodoro 독서 타이머
   ─────────────────────────────────────────────────────────
   [v5.0 신규 — 고도화 #9] 백그라운드 오프셋 보정
   ─────────────────────────────────────────────────────────
   기존 한계: setInterval(_tick, 1000)이 매 호출마다 remaining을
   단순히 1씩 감소시키는 "카운트다운" 방식이었다. PWA가 백그라운드로
   전환되면(탭 비활성, 화면 잠금 등) 브라우저가 setInterval 콜백을
   스로틀하거나 완전히 정지시킨다. 복귀 시 밀린 tick들이 한꺼번에
   몰리거나 누락되어, 실제 경과 시간과 화면에 표시된 remaining 값이
   어긋나는 드리프트(drift)가 발생했다 — 예를 들어 1분간 백그라운드에
   있었다면 실제로는 25:00 → 24:00이어야 하지만, setInterval이
   정지했다가 복귀 후 단 한 번의 tick만 실행되면 24:59로 표시되는
   식의 오차가 누적된다.

   개선: remaining을 "매 tick마다 1씩 빼는" 상대적 카운터가 아니라,
   고정된 목표 종료 시각(_targetEndPerf, performance.now() 기준
   monotonic 타임스탬프)에서 현재 시각을 뺀 값으로 매번 다시 계산하는
   절대 기준 방식으로 전환했다. performance.now()는 시스템 시계 변경
   (사용자가 OS 시계를 조정하는 경우)에도 영향받지 않는 단조 증가
   타이머이므로, setInterval의 호출 빈도가 불규칙해지더라도(스로틀,
   탭 비활성 중 누락 등) 다음 tick이 실행되는 시점에 실제 경과
   시간을 정확히 반영해 자동으로 보정된다. 즉 콜백이 얼마나 자주
   호출되었는지가 아니라 "지금이 목표 시각으로부터 얼마나 지났는가"
   만으로 remaining을 도출하므로 드리프트가 구조적으로 발생하지 않는다.

   추가로 store.appInBackground 구독을 통해, 포모도로 팝업이 열려
   있는 동안 백그라운드로 전환되었다가 복귀하는 순간 즉시 1회
   재계산(_syncFromTarget)을 수행하여 화면 표시값이 다음 정규 tick
   (최대 1초)을 기다리지 않고 즉시 정확한 값으로 갱신되도록 한다.
   ══════════════════════════════════════════════════════════ */
const Pomodoro = (() => {
  const FOCUS = 25 * 60, BREAK = 5 * 60;
  let remaining       = FOCUS;
  let mode             = 'idle';
  let timer            = null;
  let _targetEndPerf   = null; /* performance.now() 기준 목표 종료 시각 */

  function _fmt(s) {
    const m = Math.floor(s / 60), sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  /* [v5.0] 목표 종료 시각 기준으로 remaining을 절대 재계산한다.
     setInterval 호출 누락/지연 여부와 무관하게 항상 정확한 값을
     도출하므로, 백그라운드 복귀 시에도 추가 보정 로직이 필요 없다. */
  function _recalcRemaining() {
    if (_targetEndPerf === null) return remaining;
    const remainMs = _targetEndPerf - performance.now();
    return Math.max(0, Math.ceil(remainMs / 1000));
  }

  function _setTarget(seconds) {
    remaining     = seconds;
    _targetEndPerf = performance.now() + seconds * 1000;
  }

  function _tick() {
    remaining = _recalcRemaining();
    setTextSafe(DOMProxy.get('pomodoro-time'), _fmt(remaining));
    if (remaining <= 0) {
      if (mode === 'focus') {
        Toast.show('🍅 집중 시간 완료! 5분 휴식하세요.', 'success');
        mode = 'break';
        _setTarget(BREAK);
      } else {
        Toast.show('휴식 끝! 다시 집중해 볼까요?', 'info');
        mode = 'focus';
        _setTarget(FOCUS);
      }
      store.pomodoroState = mode;
      _updateModeLabel();
    }
  }

  /* 백그라운드 복귀 즉시(다음 정규 tick을 기다리지 않고) 화면을
     재동기화한다 — 목표 시각이 이미 지나 있었다면 모드 전환까지
     즉시 처리해 누락된 라운드 전환이 방치되지 않도록 한다. */
  function _syncFromTarget() {
    if (!timer || _targetEndPerf === null) return;
    _tick();
  }

  function start() {
    if (mode === 'idle') { mode = 'focus'; _setTarget(FOCUS); }
    else if (_targetEndPerf === null) { _setTarget(remaining); }
    store.pomodoroState = mode;
    _updateModeLabel();
    clearInterval(timer);
    timer = setInterval(_tick, 1000);
    ResourceRegistry.addTimer(timer);
    DOMProxy.get('pomodoro-popup').style.display = 'flex';
    setTextSafe(DOMProxy.get('btn-pomodoro-toggle'), '⏸');
  }

  function pause() {
    /* 일시정지 시점의 실제 남은 시간을 동결해, 재개(start) 시
       _setTarget(remaining)으로 정확히 이어서 재개되도록 한다. */
    remaining = _recalcRemaining();
    _targetEndPerf = null;
    clearInterval(timer);
    timer = null;
    setTextSafe(DOMProxy.get('btn-pomodoro-toggle'), '▶');
  }

  function reset() {
    clearInterval(timer); timer = null; mode = 'idle';
    remaining = FOCUS; _targetEndPerf = null;
    store.pomodoroState = 'idle';
    setTextSafe(DOMProxy.get('pomodoro-time'), _fmt(FOCUS));
    _updateModeLabel();
    setTextSafe(DOMProxy.get('btn-pomodoro-toggle'), '▶');
  }

  function toggle() {
    const popup = DOMProxy.get('pomodoro-popup');
    if (popup.style.display === 'flex' && timer) pause();
    else start();
  }

  function openPopup() {
    const popup = DOMProxy.get('pomodoro-popup');
    popup.style.display = popup.style.display === 'flex' ? 'none' : 'flex';
  }

  function _updateModeLabel() {
    const label = mode === 'focus' ? '집중' : mode === 'break' ? '휴식' : '대기';
    setTextSafe(DOMProxy.get('pomodoro-mode'), label);
    DOMProxy.get('pomodoro-popup').dataset.mode = mode;
  }

  function init() {
    if (!DOMProxy.exists('pomodoro-popup')) return;
    setTextSafe(DOMProxy.get('pomodoro-time'), _fmt(FOCUS));
    DOMProxy.get('btn-pomodoro-toggle').addEventListener('click', toggle);
    DOMProxy.get('btn-pomodoro-reset').addEventListener('click', reset);
    DOMProxy.get('btn-pomodoro-close').addEventListener('click', () => {
      pause();
      DOMProxy.get('pomodoro-popup').style.display = 'none';
    });

    /* [v5.0] 백그라운드 → 포그라운드 복귀 즉시 재동기화.
       타이머가 실행 중일 때만 의미가 있으므로 _syncFromTarget 내부에서
       timer 존재 여부를 가드한다(idle/일시정지 상태에서는 no-op). */
    ResourceRegistry.addStoreSub(
      ReactiveStore.subscribe('appInBackground', (hidden) => {
        if (!hidden) _syncFromTarget();
      })
    );
  }

  return { init, start, pause, reset, toggle, openPopup };
})();

/* ══════════════════════════════════════════════════════════
   Exports
   ══════════════════════════════════════════════════════════ */
export {
  renderTocSidebar,
  updateTocActiveItem,
  VirtualSearchList,
  SearchEngine,
  runSearchExecution,
  injectSearchHighlight,
  OnboardingGuide,
  QuickSettingsHint,
  ReadingReport,
  PageTransitionEngine,
  QuickSettingsPopover,
  GoalCelebration,
  TTSSystem,
  ReadingStatsTracker,
  initContextMenu,
  AnnotationManager,
  bindScrollTopButton,
  MetadataEditor,
  AnnotationExporter,
  LibraryFullTextSearch,
  VirtualListRenderer,
  CloudBackup,
  Pomodoro,
};
