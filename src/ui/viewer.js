/**
 * src/ui/viewer.js  ── Fable Premium v4.0
 * ─────────────────────────────────────────────────────────────────
 * 독서(뷰어) UI + 부가 기능 모듈
 *
 * v4.0 고도화 사항:
 *   [OnboardingGuide]  store.onboardingDone === false 일 때 600ms 후 순차 하이라이트 온보딩
 *   [ReadingReport]    일자별 독서 시간·글자 수 시각화 위젯 렌더러
 *   [3D 페이지 전환]   pageTransition 상태에 따라 fade / slide / flip3d CSS 3D 레이어 연동
 *   [SearchEngine Worker] Spine 전역 검색 정규식 연산을 Web Worker로 이관 → UI 프리징 제로
 *
 * 보존된 스펙:
 *   TOC 사이드바, 가상 검색 리스트, TTS, 독서 통계 트래커,
 *   롱프레스 컨텍스트 메뉴, AnnotationManager(LWW 동기화 연동),
 *   MetadataEditor, AnnotationExporter(MD/JSON/PDF),
 *   LibraryFullTextSearch, VirtualListRenderer,
 *   CloudBackup(WebDAV/Drive), Pomodoro, 스크롤 맨위로 버튼
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

import {
  store, ReactiveStore, DOMProxy, ErrorBoundary, Toast,
  setTextSafe, ResourceRegistry, RECENT_MAX,
} from '../store.js';
import { StorageSystem } from '../database.js';
import { AnnotationSyncEngine } from '../sync.js';
import { openEpubBook, waitForEpubJS, awaitBookReady } from '../reader.js';
import { refreshLibraryData, truncateTitle } from './uploader.js';

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

function updateTocActiveItem(href) {
  DOMProxy.get('toc-list').querySelectorAll?.('.toc-item').forEach(item => {
    const ih = item.dataset.href || '';
    item.classList.toggle(
      'active',
      !!(ih && (href.includes(ih.split('#')[0]) || ih.includes(href.split('#')[0])))
    );
  });
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
    const end = Math.min(start + VISIBLE, allResults.length);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const m = allResults[i], node = pool.pop() || _createItem();
      node.querySelector('.sri-section').textContent = `${i + 1}. ${(m.sectionHref || '').split('/').pop()}`;
      const snip = node.querySelector('.sri-snippet');
      snip.innerHTML = '';
      const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      m.context.split(re).forEach(part => {
        if (re.test(part)) {
          const mk = document.createElement('mark');
          mk.className = 'fable-search-mark';
          mk.textContent = part;
          snip.appendChild(mk);
          re.lastIndex = 0;
        } else {
          snip.appendChild(document.createTextNode(part));
        }
      });
      node.onclick = async () => {
        DOMProxy.get('search-modal').style.display = 'none';
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
   ─────────────────────────────────────────────────────────
   핵심 구조:
   · SearchWorker: 인라인 Blob Worker로 Spine 파싱/정규식 매칭을 격리
   · SearchEngine: Worker 생명주기 관리 + 메인스레드 캐시 관리자
   ══════════════════════════════════════════════════════════ */

/* ── Web Worker 소스 (인라인 Blob) ── */
const _SEARCH_WORKER_SRC = /* js */`
'use strict';

/* Spine 텍스트 인덱스를 전달받아 키워드 검색 후 결과 반환 */
let _index = [];   /* [{ sectionHref, cfi, context }] */
let _built = false;

self.onmessage = function(e) {
  const { type, payload, id } = e.data || {};

  if (type === 'INDEX') {
    /* 메인스레드에서 직렬화된 인덱스 배열을 수신하여 저장 */
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

/* ── SearchEngine (워커 생명주기 + 인덱스 빌더) ── */
const SearchEngine = (() => {
  let _worker    = null;   /* Web Worker 인스턴스 */
  let _workerUrl = null;   /* Blob URL (메모리 해제용) */
  let _isBuilt   = false;
  let _pending   = new Map(); /* requestId → { resolve, reject } */
  let _seq       = 0;

  /** Worker 초기화 (최초 1회) */
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
          if (type === 'RESULT')      ticket.resolve(results);
          else if (type === 'INDEX_READY') ticket.resolve(count);
          else if (type === 'RESET_DONE')  ticket.resolve(true);
        }
      };
      _worker.onerror = (err) => {
        console.error('[SearchEngine Worker]', err.message);
        /* 워커 오류 시 모든 대기 Promise 거부 처리 */
        _pending.forEach(t => t.reject(err));
        _pending.clear();
        _worker = null;
      };
    } catch (ex) {
      console.warn('[SearchEngine] Web Worker 생성 실패 — 메인스레드 폴백:', ex.message);
      _worker = null;
    }
  }

  /** 워커로 메시지를 전송하고 응답 Promise를 반환 */
  function _send(type, payload) {
    return new Promise((resolve, reject) => {
      const id = ++_seq;
      _pending.set(id, { resolve, reject });
      /* 타임아웃 안전망 (30s) */
      setTimeout(() => {
        if (_pending.has(id)) { _pending.delete(id); reject(new Error('Worker timeout: ' + type)); }
      }, 30000);
      _worker.postMessage({ type, payload, id });
    });
  }

  /**
   * book의 Spine 전체를 파싱하여 검색 인덱스를 빌드하고 Worker에 전달
   * — 메인스레드에서는 DOM 파싱(DOMParser)만 수행하고 무거운 색인 연산은 워커에 위임
   */
  async function build(book) {
    if (_isBuilt || !book) return;
    _ensureWorker();

    const indexArr = [];
    const parser = new DOMParser();
    const items  = book.spine?.items || [];

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
        /* 프레임 양보 — 메인스레드 60fps 유지 */
        await new Promise(r => setTimeout(r, 0));
      } catch (_) {}
    }

    if (_worker) {
      await _send('INDEX', indexArr);
      _isBuilt = true;
    } else {
      /* 워커 없음 폴백: 메인스레드에서 직접 보유 */
      SearchEngine._fallbackIndex = indexArr;
      _isBuilt = true;
    }
  }

  /** 키워드 검색 — Worker가 있으면 Worker에서, 없으면 메인스레드 폴백 */
  async function query(keyword) {
    if (!_isBuilt || (keyword || '').length < 2) return [];

    if (_worker) {
      try { return await _send('QUERY', { keyword }); }
      catch (_) { /* 폴백 */ }
    }

    /* 메인스레드 폴백 */
    const kw   = keyword.toLowerCase().trim();
    const arr  = SearchEngine._fallbackIndex || [];
    const out  = [];
    const seen = new Set();
    for (const item of arr) {
      if (item.context.toLowerCase().includes(kw) && !seen.has(item.cfi)) {
        seen.add(item.cfi);
        out.push(item);
        if (out.length >= 200) break;
      }
    }
    return out;
  }

  /** 워커 소멸 + 메모리 정리 */
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
  /* 비동기 Worker 쿼리 — UI 프리징 없음 */
  const results = await SearchEngine.query(q);
  VirtualSearchList.render(DOMProxy.get('search-results-container'), results, q);
}

function injectSearchHighlight(cfi) {
  if (!store.rendition) return;
  try {
    store.rendition.annotations.add('highlight', cfi, {}, null, 'fable-search-hl');
    setTimeout(() => {
      try { store.rendition?.annotations?.remove(cfi, 'highlight'); } catch (_) {}
    }, 3000);
  } catch (_) {}
}

/* ══════════════════════════════════════════════════════════
   §23-B. OnboardingGuide
   ─────────────────────────────────────────────────────────
   store.onboardingDone === false 일 때 600ms 후 자동 구동.
   업로드 영역 → 상단 메뉴 → 하단 메뉴 뷰포트를 순차적으로
   반투명 오버레이 + 하이라이트 레이어 + 툴팁으로 안내.
   ══════════════════════════════════════════════════════════ */
const OnboardingGuide = (() => {
  let _overlay = null, _box = null, _tooltip = null, _step = 0, _timer = null;

  const STEPS = [
    {
      targetId: 'drop-zone',
      title:    '📚 EPUB 파일 추가',
      body:     'EPUB 파일을 이 영역에 드래그하거나 탭하여 서재에 추가하세요.',
      pos:      'bottom',
    },
    {
      targetId: 'top-bar',
      title:    '🔎 상단 메뉴',
      body:     '검색, 목차, TTS, 포모도로 등 다양한 독서 도구를 이용하세요.',
      pos:      'bottom',
    },
    {
      targetId: 'bottom-bar',
      title:    '⚙️ 하단 메뉴',
      body:     '설정, 테마 변경, 페이지 넘김 효과를 커스터마이즈할 수 있습니다.',
      pos:      'top',
    },
  ];

  /** 오버레이 레이어 DOM 구성 (최초 1회) */
  function _buildDOM() {
    if (_overlay) return;

    _overlay = document.createElement('div');
    _overlay.id = 'onboarding-overlay';
    _overlay.setAttribute('role', 'dialog');
    _overlay.setAttribute('aria-label', '온보딩 가이드');
    _overlay.style.cssText = [
      'position:fixed;inset:0;z-index:9900',
      'background:rgba(0,0,0,0.55)',
      'pointer-events:all',
      'transition:opacity 300ms ease',
    ].join(';');

    /* 하이라이트 박스 */
    _box = document.createElement('div');
    _box.style.cssText = [
      'position:fixed;z-index:9910',
      'border:2.5px solid var(--color-accent,#c47a3b)',
      'border-radius:8px',
      'box-shadow:0 0 0 4000px rgba(0,0,0,0.55)',
      'pointer-events:none',
      'transition:all 320ms cubic-bezier(0.4,0,0.2,1)',
    ].join(';');

    /* 툴팁 카드 */
    _tooltip = document.createElement('div');
    _tooltip.style.cssText = [
      'position:fixed;z-index:9920',
      'background:var(--color-surface,#fff)',
      'color:var(--color-ink,#1a1814)',
      'border-radius:12px',
      'padding:16px 20px',
      'max-width:280px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.22)',
      'font-size:14px;line-height:1.6',
      'pointer-events:all',
    ].join(';');

    document.body.appendChild(_overlay);
    document.body.appendChild(_box);
    document.body.appendChild(_tooltip);

    /* 오버레이 클릭 시 다음 단계 진행 */
    _overlay.addEventListener('click', _next);
  }

  /** 특정 단계 렌더링 */
  function _renderStep(stepIdx) {
    if (stepIdx >= STEPS.length) { _finish(); return; }
    const step   = STEPS[stepIdx];
    const target = document.getElementById(step.targetId);

    if (!target) { _next(); return; }

    const rect = target.getBoundingClientRect();
    const PAD  = 6;

    /* 하이라이트 박스 위치 */
    _box.style.left   = `${rect.left - PAD}px`;
    _box.style.top    = `${rect.top  - PAD}px`;
    _box.style.width  = `${rect.width  + PAD * 2}px`;
    _box.style.height = `${rect.height + PAD * 2}px`;

    /* 툴팁 내용 */
    _tooltip.innerHTML = '';
    const h = document.createElement('strong');
    h.style.cssText = 'display:block;margin-bottom:6px;font-size:15px;';
    h.textContent = step.title;
    const p = document.createElement('p');
    p.style.cssText = 'margin:0 0 12px;';
    p.textContent = step.body;

    const progress = document.createElement('div');
    progress.style.cssText = 'display:flex;gap:5px;align-items:center;margin-bottom:12px;';
    STEPS.forEach((_, i) => {
      const dot = document.createElement('span');
      dot.style.cssText = `display:inline-block;width:7px;height:7px;border-radius:50%;`
        + `background:${i === stepIdx ? 'var(--color-accent,#c47a3b)' : 'var(--color-border-soft,#ccc)'};`;
      progress.appendChild(dot);
    });

    const btnRow = document.createElement('div');
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

    /* 툴팁 위치 결정 (top/bottom) */
    const TH = 180; /* 툴팁 추정 높이 */
    if (step.pos === 'bottom') {
      let top = rect.bottom + PAD + 12;
      if (top + TH > window.innerHeight - 16) top = rect.top - TH - 12;
      _tooltip.style.top  = `${Math.max(8, top)}px`;
    } else {
      let top = rect.top - TH - 12;
      if (top < 8) top = rect.bottom + PAD + 12;
      _tooltip.style.top  = `${top}px`;
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
    /* 완료 영구 저장 */
    store.onboardingDone = true;
    try { localStorage.setItem('fable_onboarding_done', '1'); } catch (_) {}
  }

  /** 외부 진입점 — viewer 초기화 후 600ms 딜레이로 자동 구동 */
  function init() {
    /* 이미 완료 처리되었으면 생략 */
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

  /** 수동 재실행 (설정에서 '가이드 다시 보기' 클릭 시) */
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
   §23-C. ReadingReport — 일자별 독서 데이터 시각화 위젯
   ─────────────────────────────────────────────────────────
   · 일별 독서 시간(분) SVG 바 차트
   · 일별 읽은 글자 수(estimatedChars) 보조 차트
   · 7일 / 30일 토글
   ══════════════════════════════════════════════════════════ */
const ReadingReport = (() => {
  let _containerId = 'reading-report-widget';
  let _currentRange = 7; /* 7 또는 30 */

  /**
   * @param {Object} readingLog  { 'YYYY-MM-DD': { seconds, chars? } }
   * @param {string} [containerId]
   */
  function render(readingLog, containerId = _containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const days = _buildDayArray(readingLog, _currentRange);
    const maxSec  = Math.max(60, ...days.map(d => d.sec));
    const maxChar = Math.max(1,  ...days.map(d => d.chars));
    const todaySec = days[days.length - 1]?.sec || 0;
    const totalSec = days.reduce((s, d) => s + d.sec, 0);
    const totalChar = days.reduce((s, d) => s + d.chars, 0);
    const streak = _calcStreak(readingLog);

    /* ── SVG 바 차트 생성 ── */
    const BAR_W = _currentRange <= 7 ? 28 : 12;
    const BAR_GAP = _currentRange <= 7 ? 8 : 4;
    const CHART_H = 80;
    const CHART_W = days.length * (BAR_W + BAR_GAP) - BAR_GAP;

    let svgBars = '';
    days.forEach((d, i) => {
      const h   = Math.max(3, Math.round((d.sec  / maxSec)  * CHART_H));
      const hc  = Math.max(2, Math.round((d.chars / maxChar) * (CHART_H * 0.5)));
      const x   = i * (BAR_W + BAR_GAP);
      const min = Math.round(d.sec / 60);
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

    /* ── 컨테이너 렌더링 ── */
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;';
    const titleEl = document.createElement('span');
    titleEl.style.cssText = 'font-size:13px;font-weight:600;color:var(--color-ink,#1a1814);';
    titleEl.textContent = `독서 리포트 — 최근 ${_currentRange}일`;

    const toggle = document.createElement('div');
    toggle.style.cssText = 'display:flex;gap:4px;';
    [7, 30].forEach(n => {
      const btn = document.createElement('button');
      btn.textContent = `${n}일`;
      btn.style.cssText = `padding:3px 8px;border-radius:5px;border:1px solid var(--color-border,#ccc);`
        + `font-size:11px;cursor:pointer;`
        + `background:${n === _currentRange ? 'var(--color-accent,#c47a3b)' : 'none'};`
        + `color:${n === _currentRange ? '#fff' : 'var(--color-ink-muted,#888)'};`;
      btn.addEventListener('click', () => { _currentRange = n; render(readingLog, containerId); });
      toggle.appendChild(btn);
    });

    header.appendChild(titleEl);
    header.appendChild(toggle);
    container.appendChild(header);

    /* SVG 차트 */
    const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgEl.setAttribute('viewBox', `0 0 ${CHART_W} ${SVG_H}`);
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', SVG_H);
    svgEl.setAttribute('aria-label', '독서 시간 차트');
    svgEl.innerHTML = svgBars;
    container.appendChild(svgEl);

    /* 요약 카드 행 */
    const summaryRow = document.createElement('div');
    summaryRow.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px;';
    const stats = [
      { label: '오늘', value: `${Math.round(todaySec / 60)}분` },
      { label: `${_currentRange}일 합계`, value: `${Math.round(totalSec / 60)}분` },
      { label: '연속 독서', value: `${streak}일 🔥` },
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

    /* 글자 수 요약 */
    if (totalChar > 0) {
      const charNote = document.createElement('p');
      charNote.style.cssText = 'margin:8px 0 0;font-size:11px;color:var(--color-ink-muted,#888);text-align:right;';
      charNote.textContent = `${_currentRange}일간 약 ${totalChar.toLocaleString()}자 읽음`;
      container.appendChild(charNote);
    }
  }

  /** readingLog에서 날짜 배열 구성 */
  function _buildDayArray(log, n) {
    const today = new Date();
    const result = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const rec = log[key] || {};
      const sec = typeof rec === 'number' ? rec : (rec.seconds || 0);
      const chars = rec.chars || 0;
      result.push({
        key,
        sec,
        chars,
        label: n <= 7
          ? ['일','월','화','수','목','금','토'][d.getDay()]
          : String(d.getDate()),
      });
    }
    return result;
  }

  /** 연속 독서 일수 계산 */
  function _calcStreak(log) {
    let streak = 0;
    const today = new Date();
    for (let i = 0; i < 365; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const rec = log[key];
      const sec = typeof rec === 'number' ? rec : (rec?.seconds || 0);
      if (sec > 0) streak++;
      else break;
    }
    return streak;
  }

  return { render };
})();

/* ══════════════════════════════════════════════════════════
   §23-D. 3D 종이 넘김 페이지 전환 레이어
   ─────────────────────────────────────────────────────────
   store.pageTransition ∈ { 'fade', 'slide', 'flip3d' }
   epub.js rendition.on('relocated') 직전에 CSS 전환 레이어를
   뷰어 위에 동적 삽입하여 애니메이션을 실행한 후 자동 제거.
   ══════════════════════════════════════════════════════════ */
const PageTransitionEngine = (() => {
  /* 한 번에 하나의 전환만 실행 */
  let _busy = false;

  /* 전환별 CSS 주입 (한 번만) */
  const CSS = `
    @keyframes fable-fade-in { from { opacity:0; } to { opacity:1; } }

    @keyframes fable-slide-in {
      from { transform: translateX(6%); opacity:0; }
      to   { transform: translateX(0);  opacity:1; }
    }

    @keyframes fable-flip3d-out {
      0%   { transform: perspective(900px) rotateY(0deg);   opacity:1; }
      100% { transform: perspective(900px) rotateY(-90deg); opacity:0; }
    }
    @keyframes fable-flip3d-in {
      0%   { transform: perspective(900px) rotateY(90deg);  opacity:0; }
      100% { transform: perspective(900px) rotateY(0deg);   opacity:1; }
    }

    .fable-ptx-layer {
      position:absolute; inset:0; z-index:8000;
      pointer-events:none;
      background:var(--color-page, #f4f1ea);
      transform-origin:left center;
    }
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

  /**
   * 전환 실행
   * @param {'prev'|'next'} direction
   */
  function run(direction = 'next') {
    if (_busy) return;
    const mode = store.pageTransition || 'fade';
    if (mode === 'fade')   { _runFade(); return; }
    if (mode === 'slide')  { _runSlide(direction); return; }
    if (mode === 'flip3d') { _runFlip3D(direction); return; }
  }

  function _getViewport() { return DOMProxy.get('viewer-viewport'); }

  function _runFade() {
    _injectCSS();
    _busy = true;
    const vp = _getViewport();
    const layer = document.createElement('div');
    layer.className = 'fable-ptx-layer fable-ptx--fade';
    vp.appendChild(layer);
    layer.addEventListener('animationend', () => { layer.remove(); _busy = false; }, { once: true });
    setTimeout(() => { if (layer.parentNode) { layer.remove(); _busy = false; } }, 500);
  }

  function _runSlide(direction) {
    _injectCSS();
    _busy = true;
    const vp = _getViewport();
    const layer = document.createElement('div');
    layer.className = 'fable-ptx-layer fable-ptx--slide';
    if (direction === 'prev') layer.style.animationName = 'fable-slide-in-rev';
    vp.appendChild(layer);
    layer.addEventListener('animationend', () => { layer.remove(); _busy = false; }, { once: true });
    setTimeout(() => { if (layer.parentNode) { layer.remove(); _busy = false; } }, 600);
  }

  function _runFlip3D(direction) {
    _injectCSS();
    _busy = true;
    const vp = _getViewport();

    /* OUT 레이어 (현재 페이지가 뒤집혀 나가는 효과) */
    const layerOut = document.createElement('div');
    layerOut.className = 'fable-ptx-layer fable-ptx--flip-out';
    layerOut.style.transformOrigin = direction === 'next' ? 'left center' : 'right center';
    vp.appendChild(layerOut);

    /* IN 레이어 (새 페이지가 들어오는 효과) */
    const layerIn = document.createElement('div');
    layerIn.className = 'fable-ptx-layer fable-ptx--flip-in';
    layerIn.style.transformOrigin = direction === 'next' ? 'right center' : 'left center';
    vp.appendChild(layerIn);

    layerOut.addEventListener('animationend', () => layerOut.remove(), { once: true });
    layerIn.addEventListener('animationend',  () => { layerIn.remove(); _busy = false; }, { once: true });
    setTimeout(() => {
      [layerOut, layerIn].forEach(el => { if (el.parentNode) el.remove(); });
      _busy = false;
    }, 600);
  }

  return { run };
})();

/* ══════════════════════════════════════════════════════════
   §24-X. TTS 시스템
   ══════════════════════════════════════════════════════════ */
const TTSSystem = (() => {
  let utterance = null, isPaused = false, totalLen = 0;

  function play(text) {
    if (!text) return;
    window.speechSynthesis.cancel();
    totalLen  = text.length;
    utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ko-KR';
    utterance.rate = 1.0;
    utterance.onboundary = (e) => {
      if (e.charIndex != null) {
        DOMProxy.get('tts-progress-fill').style.width = `${Math.min(100, (e.charIndex / totalLen) * 100)}%`;
      }
    };
    utterance.onend = utterance.onerror = () => {
      DOMProxy.get('tts-player-bar').style.display = 'none';
      DOMProxy.get('tts-progress-fill').style.width = '0%';
    };
    isPaused = false;
    window.speechSynthesis.speak(utterance);
    DOMProxy.get('tts-player-bar').style.display = 'flex';
    setTextSafe(DOMProxy.get('btn-tts-play-pause'), '⏸');
  }

  function pauseResume() {
    if (isPaused) {
      window.speechSynthesis.resume();
      isPaused = false;
      setTextSafe(DOMProxy.get('btn-tts-play-pause'), '⏸');
    } else {
      window.speechSynthesis.pause();
      isPaused = true;
      setTextSafe(DOMProxy.get('btn-tts-play-pause'), '▶');
    }
  }

  function stop() { window.speechSynthesis.cancel(); DOMProxy.get('tts-player-bar').style.display = 'none'; }

  return { play, pauseResume, stop };
})();

/* ══════════════════════════════════════════════════════════
   §27. 독서 통계
   ══════════════════════════════════════════════════════════ */
const ReadingStatsTracker = (() => {
  let timer = null;
  let pendingSeconds = 0;

  function startSession() {
    store.readingSession.startTime = Date.now();
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        store.readingSession.accumulated++;
        pendingSeconds++;
        _updateUI();
        /* 30초마다 일별 독서로그 일괄 적재 */
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
    const fill = DOMProxy.get('goal-progress-fill');
    const pct  = Math.min(100, (min / goalMin) * 100);
    fill.style.transition = 'width 600ms cubic-bezier(0.34,1.56,0.64,1)';
    fill.style.width = `${pct}%`;
    DOMProxy.q('.goal-track').setAttribute('aria-valuenow', Math.round(pct));
    if (pct >= 100 && fill.dataset.notified !== '1') {
      fill.dataset.notified = '1';
      Toast.show('🎉 오늘의 독서 목표를 달성했습니다!', 'success');
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

  function showMenu() { if (!selectedText) return; const m = DOMProxy.get('context-menu'); m.style.display = 'flex'; m.classList.add('slide-up'); }
  function hideMenu() { const m = DOMProxy.get('context-menu'); m.classList.remove('slide-up'); setTimeout(() => { m.style.display = 'none'; }, 280); }

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
  ResourceRegistry.addListener(viewer, 'touchend',  () => clearTimeout(longPressTimer), { passive: true });
  ResourceRegistry.addListener(viewer, 'touchmove', () => clearTimeout(longPressTimer), { passive: true });
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
const AnnotationManager = (() => {
  let _rendition = null;

  function init(rendition) {
    _rendition = rendition;
    rendition.on('selected', async (cfiRange, contents) => {
      const sel = contents.window.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim().length < 2) return;
      try {
        const ann = await AnnotationSyncEngine.create(store.bookKey, cfiRange, sel.toString().trim(), 'yellow');
        rendition.annotations.add('highlight', cfiRange, { uuid: ann.uuid }, null, 'hl-yellow');
        Toast.show('하이라이트가 저장되었습니다.', 'success');
      } catch (e) {
        ErrorBoundary.handle('storage', e, 'annotation:create');
      }
    });
  }

  function restoreAll(annotations) {
    if (!_rendition) return;
    annotations.forEach(ann => {
      try { _rendition.annotations.add('highlight', ann.cfiRange, { uuid: ann.uuid }, null, 'hl-' + (ann.color || 'yellow')); }
      catch (_) {}
    });
  }

  function reset() { _rendition = null; }

  return { init, restoreAll, reset };
})();

function initAnnotationManager(rendition) { AnnotationManager.init(rendition); }

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
    objects.forEach((obj, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    });
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
   §37. LibraryFullTextSearch (전 도서 본문 → CFI 점프)
   ══════════════════════════════════════════════════════════ */
const LibraryFullTextSearch = (() => {
  let _running = false;

  function open()  { DOMProxy.get('fts-modal').style.display = 'flex'; setTimeout(() => DOMProxy.get('fts-input').focus(), 60); }
  function close() { DOMProxy.get('fts-modal').style.display = 'none'; }

  async function run() {
    if (_running) return;
    const q = DOMProxy.get('fts-input').value.trim();
    if (q.length < 2) { Toast.show('검색어는 2글자 이상 입력하세요.', 'error'); return; }
    _running = true;
    const resultsEl = DOMProxy.get('fts-results');
    resultsEl.innerHTML = '<p class="fts-status">전체 서재 본문을 검색 중입니다...</p>';

    const books = store.libraryBooks || [];
    const allHits = [];

    const ready = await waitForEpubJS();
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
      const item = document.createElement('div');
      item.className = 'fts-result-item';
      const title = document.createElement('div');
      title.className = 'fts-result-title';
      title.textContent = `📖 ${hit.title || '제목 없음'}`;
      const snip = document.createElement('div');
      snip.className = 'fts-result-snippet';
      const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      snip.innerHTML = '';
      hit.snippet.split(re).forEach(part => {
        if (re.test(part)) { const m = document.createElement('mark'); m.textContent = part; snip.appendChild(m); re.lastIndex = 0; }
        else snip.appendChild(document.createTextNode(part));
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
    DOMProxy.get('fts-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  }

  return { open, close, init };
})();

/* ══════════════════════════════════════════════════════════
   §38. 범용 가상 스크롤 렌더러 (VirtualListRenderer)
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
   §39. CloudBackup (WebDAV + Google Drive 프레임워크)
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

  const WebDAV = {
    async upload(url, user, pass, data) {
      const auth = 'Basic ' + btoa(`${user}:${pass}`);
      return fetch(url, { method: 'PUT', headers: { 'Authorization': auth, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    },
    async download(url, user, pass) {
      const auth = 'Basic ' + btoa(`${user}:${pass}`);
      const res  = await fetch(url, { headers: { 'Authorization': auth } });
      if (!res.ok) throw new Error(`WebDAV ${res.status}`);
      return res.json();
    },
  };

  const GoogleDrive = {
    async upload(accessToken, data) {
      const metadata = { name: `fable_backup_${Date.now()}.json`, mimeType: 'application/json' };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file',     new Blob([JSON.stringify(data)], { type: 'application/json' }));
      return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST', headers: { 'Authorization': `Bearer ${accessToken}` }, body: form,
      });
    },
    async download(accessToken, fileId) {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error(`Drive ${res.status}`);
      return res.json();
    },
  };

  function init() {
    if (DOMProxy.exists('restore-file-input')) {
      DOMProxy.get('restore-file-input').addEventListener('change', (e) => {
        if (e.target.files[0]) restoreFromFile(e.target.files[0]);
        e.target.value = '';
      });
    }
  }

  return { backupToFile, restoreFromFile, WebDAV, GoogleDrive, init };
})();

/* ══════════════════════════════════════════════════════════
   §40. Pomodoro 독서 타이머
   ══════════════════════════════════════════════════════════ */
const Pomodoro = (() => {
  const FOCUS = 25 * 60, BREAK = 5 * 60;
  let remaining = FOCUS, mode = 'idle', timer = null;

  function _fmt(s) {
    const m = Math.floor(s / 60), sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function _tick() {
    remaining--;
    setTextSafe(DOMProxy.get('pomodoro-time'), _fmt(remaining));
    if (remaining <= 0) {
      if (mode === 'focus') { Toast.show('🍅 집중 시간 완료! 5분 휴식하세요.', 'success'); mode = 'break'; remaining = BREAK; }
      else { Toast.show('휴식 끝! 다시 집중해 볼까요?', 'info'); mode = 'focus'; remaining = FOCUS; }
      store.pomodoroState = mode;
      _updateModeLabel();
    }
  }

  function start() {
    if (mode === 'idle') { mode = 'focus'; remaining = FOCUS; }
    store.pomodoroState = mode;
    _updateModeLabel();
    clearInterval(timer);
    timer = setInterval(_tick, 1000);
    ResourceRegistry.addTimer(timer);
    DOMProxy.get('pomodoro-popup').style.display = 'flex';
    setTextSafe(DOMProxy.get('btn-pomodoro-toggle'), '⏸');
  }

  function pause() { clearInterval(timer); timer = null; setTextSafe(DOMProxy.get('btn-pomodoro-toggle'), '▶'); }

  function reset() {
    clearInterval(timer); timer = null; mode = 'idle'; remaining = FOCUS;
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
  }

  function openPopup() {
    const popup = DOMProxy.get('pomodoro-popup');
    popup.style.display = popup.style.display === 'flex' ? 'none' : 'flex';
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
  ReadingReport,
  PageTransitionEngine,
  TTSSystem,
  ReadingStatsTracker,
  initContextMenu,
  AnnotationManager,
  initAnnotationManager,
  bindScrollTopButton,
  MetadataEditor,
  AnnotationExporter,
  LibraryFullTextSearch,
  VirtualListRenderer,
  CloudBackup,
  Pomodoro,
};
