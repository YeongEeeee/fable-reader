/**
 * src/ui/viewer.js
 * ───────────────────────────────────────────────────────────────
 * 독서(뷰어) UI + 부가 기능 모듈
 *
 * 보존된 스펙:
 *   - TOC 사이드바, 가상 검색 리스트, 전문 검색 엔진
 *   - TTS, 독서 통계 트래커, 롱프레스 컨텍스트 메뉴
 *   - AnnotationManager (LWW 동기화 연동)
 *   - MetadataEditor, AnnotationExporter(MD/JSON/PDF), 풀텍스트 서재 검색
 *   - VirtualListRenderer, CloudBackup(WebDAV/Drive 프레임워크), Pomodoro
 *   - 스크롤 맨위로 버튼
 * ─────────────────────────────────────────────────────────────── */

'use strict';

import {
  store, DOMProxy, ErrorBoundary, Toast,
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
    p.textContent = '목차 정보가 없습니다.'; container.appendChild(p); return;
  }
  const frag = document.createDocumentFragment();
  function appendItems(items, depth) {
    items.forEach(item => {
      const btn = document.createElement('button');
      btn.className     = 'toc-item'; btn.dataset.depth = String(Math.min(depth, 3));
      btn.dataset.href  = item.href || ''; btn.textContent = item.label?.trim() || '(제목 없음)';
      btn.setAttribute('role', 'listitem');
      btn.addEventListener('click', () => {
        if (store.rendition && item.href) store.rendition.display(item.href).catch(() => {});
        store.isTocOpen = false;
      });
      frag.appendChild(btn);
      if (item.subitems?.length) appendItems(item.subitems, depth + 1);
    });
  }
  appendItems(tocData, 1); container.appendChild(frag);
}

function updateTocActiveItem(href) {
  DOMProxy.get('toc-list').querySelectorAll?.('.toc-item').forEach(item => {
    const ih = item.dataset.href || '';
    item.classList.toggle('active', !!(ih && (href.includes(ih.split('#')[0]) || ih.includes(href.split('#')[0]))));
  });
}

/* ══════════════════════════════════════════════════════════
   §22. Virtual Search List (IntersectionObserver 재활용 풀)
   ══════════════════════════════════════════════════════════ */
const VirtualSearchList = (() => {
  const VISIBLE = 20, ITEM_H = 64;
  let allResults = [], renderedStart = 0, container = null, sentinel = null, observer = null, pool = [], _q = '';

  function _createItem() {
    const div = document.createElement('div');
    div.className = 'search-result-item';
    div.setAttribute('role', 'option');
    div.style.cssText = `min-height:${ITEM_H}px;padding:10px 16px;border-bottom:1px solid var(--color-border-soft);cursor:pointer;`;
    div.innerHTML = '<div class="sri-section" style="font-size:10px;color:var(--color-ink-muted);margin-bottom:3px;"></div><p class="sri-snippet" style="font-size:12px;line-height:1.5;margin:0;color:var(--color-ink-soft);"></p>';
    return div;
  }

  function _renderChunk(start, q) {
    if (!container) return;
    const end = Math.min(start + VISIBLE, allResults.length);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const m = allResults[i], node = pool.pop() || _createItem();
      node.querySelector('.sri-section').textContent = `${i+1}. ${(m.sectionHref||'').split('/').pop()}`;
      const snip = node.querySelector('.sri-snippet'); snip.innerHTML = '';
      const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})`, 'gi');
      m.context.split(re).forEach(part => {
        if (re.test(part)) { const mk = document.createElement('mark'); mk.className='fable-search-mark'; mk.textContent=part; snip.appendChild(mk); re.lastIndex=0; }
        else snip.appendChild(document.createTextNode(part));
      });
      node.onclick = async () => {
        DOMProxy.get('search-modal').style.display = 'none';
        if (store.rendition && m.cfi) { try { await store.rendition.display(m.cfi); setTimeout(() => injectSearchHighlight(m.cfi), 400); } catch (_) {} }
      };
      frag.appendChild(node);
    }
    container.appendChild(frag); renderedStart = end;
  }

  function _setupSentinel() {
    sentinel = document.createElement('div'); sentinel.style.height = '1px';
    container.appendChild(sentinel);
    observer = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting || renderedStart >= allResults.length) return;
      const old = container.querySelectorAll('.search-result-item');
      if (old.length > VISIBLE * 2) { Array.from(old).slice(0, old.length - VISIBLE).forEach(n => { pool.push(n); n.remove(); }); }
      _renderChunk(renderedStart, _q); container.appendChild(sentinel);
    }, { threshold: 0.1 });
    observer.observe(sentinel);
  }

  function render(containerEl, results, query) {
    if (observer) { observer.disconnect(); observer = null; }
    pool = []; allResults = results; container = containerEl; renderedStart = 0; _q = query;
    container.innerHTML = '';
    if (!results.length) {
      const p = document.createElement('p'); p.style.cssText='padding:20px;text-align:center;color:var(--color-ink-muted);font-size:13px;';
      p.textContent='검색 결과가 없습니다.'; container.appendChild(p); return;
    }
    _renderChunk(0, query); _setupSentinel();
  }

  function destroy() { if (observer) { observer.disconnect(); observer = null; } pool=[]; allResults=[]; container=null; sentinel=null; }
  return { render, destroy };
})();

/* ══════════════════════════════════════════════════════════
   §23. 전문 검색 엔진
   ══════════════════════════════════════════════════════════ */
const SearchEngine = (() => {
  let index = new Map(), isBuilt = false;

  async function build(book) {
    if (isBuilt || !book) return;
    index.clear();
    const parser = new DOMParser(), items = book.spine?.items || [];
    for (const item of items) {
      try {
        const section = book.spine.get(item.href || item.idref);
        if (!section) continue;
        await section.load(book.load.bind(book));
        const doc = parser.parseFromString(section.content || '<html></html>', 'text/html');
        Array.from(doc.querySelectorAll('p,h1,h2,h3,li')).forEach(p => {
          const text = p.textContent?.trim() || '';
          if (text.length < 3) return;
          let cfi = ''; try { cfi = section.cfiFromElement(p); } catch (_) { cfi = item.href || ''; }
          new Set(text.toLowerCase().split(/\s+/).filter(w => w.length >= 2)).forEach(word => {
            if (!index.has(word)) index.set(word, []);
            index.get(word).push({ sectionHref: item.href || '', cfi, context: text.slice(0, 120) });
          });
        });
        section.unload(); await new Promise(r => setTimeout(r, 0));
      } catch (_) {}
    }
    isBuilt = true;
  }

  function query(keyword) {
    if (!isBuilt || keyword.length < 2) return [];
    const kw = keyword.toLowerCase().trim(), results = [], seen = new Set();
    for (const [key, list] of index.entries()) {
      if (key.includes(kw)) list.forEach(r => { if (!seen.has(r.cfi)) { seen.add(r.cfi); results.push(r); } });
      if (results.length >= 200) break;
    }
    return results;
  }

  function destroy() { index.clear(); isBuilt = false; }
  return { build, query, destroy };
})();

function runSearchExecution() {
  const q = DOMProxy.get('input-search-query').value?.trim() ?? '';
  if (q.length < 2) { Toast.show('검색어는 2글자 이상 입력하세요.', 'error'); return; }
  VirtualSearchList.render(DOMProxy.get('search-results-container'), SearchEngine.query(q), q);
}

function injectSearchHighlight(cfi) {
  if (!store.rendition) return;
  try { store.rendition.annotations.add('highlight', cfi, {}, null, 'fable-search-hl'); setTimeout(() => { try { store.rendition?.annotations?.remove(cfi, 'highlight'); } catch (_) {} }, 3000); }
  catch (_) {}
}


const TTSSystem = (() => {
  let utterance = null, isPaused = false, totalLen = 0;
  function play(text) {
    if (!text) return;
    window.speechSynthesis.cancel(); totalLen = text.length;
    utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'ko-KR'; utterance.rate = 1.0;
    utterance.onboundary = (e) => { if (e.charIndex != null) { DOMProxy.get('tts-progress-fill').style.width = `${Math.min(100,(e.charIndex/totalLen)*100)}%`; } };
    utterance.onend = utterance.onerror = () => { DOMProxy.get('tts-player-bar').style.display='none'; DOMProxy.get('tts-progress-fill').style.width='0%'; };
    isPaused = false; window.speechSynthesis.speak(utterance);
    DOMProxy.get('tts-player-bar').style.display = 'flex'; setTextSafe(DOMProxy.get('btn-tts-play-pause'), '⏸');
  }
  function pauseResume() {
    if (isPaused) { window.speechSynthesis.resume(); isPaused = false; setTextSafe(DOMProxy.get('btn-tts-play-pause'), '⏸'); }
    else { window.speechSynthesis.pause(); isPaused = true; setTextSafe(DOMProxy.get('btn-tts-play-pause'), '▶'); }
  }
  function stop() { window.speechSynthesis.cancel(); DOMProxy.get('tts-player-bar').style.display='none'; }
  return { play, pauseResume, stop };
})();

/* ══════════════════════════════════════════════════════════
   §27. 독서 통계
   ══════════════════════════════════════════════════════════ */
const ReadingStatsTracker = (() => {
  let timer = null;
  let pendingSeconds = 0; /* readingLog 일괄 커밋 버퍼 */
  function startSession() {
    store.readingSession.startTime = Date.now();
    clearInterval(timer);
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        store.readingSession.accumulated++;
        pendingSeconds++;
        _updateUI();
        /* [1]-4 30초마다 일별 독서로그 일괄 적재 */
        if (pendingSeconds >= 30) { StorageSystem.addReadingSeconds(pendingSeconds); pendingSeconds = 0; }
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
    const total = store.readingSession.accumulated, min = Math.floor(total / 60), sec = total % 60;
    setTextSafe(DOMProxy.get('stat-reading-time'), `${min}분 ${sec}초`);
    setTextSafe(DOMProxy.get('stat-pages-read'), String(store.readingSession.positions.size));
    const goalMin = parseInt(localStorage.getItem('fable_daily_goal') || '30', 10);
    const fill = DOMProxy.get('goal-progress-fill'), pct = Math.min(100, (min / goalMin) * 100);
    fill.style.transition = 'width 600ms cubic-bezier(0.34,1.56,0.64,1)'; fill.style.width = `${pct}%`;
    DOMProxy.q('.goal-track').setAttribute('aria-valuenow', Math.round(pct));
    if (pct >= 100 && fill.dataset.notified !== '1') { fill.dataset.notified = '1'; Toast.show('\uD83C\uDF89 오늘의 독서 목표를 달성했습니다!', 'success'); }
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

  function showMenu() { if (!selectedText) return; const m = DOMProxy.get('context-menu'); m.style.display='flex'; m.classList.add('slide-up'); }
  function hideMenu() { const m = DOMProxy.get('context-menu'); m.classList.remove('slide-up'); setTimeout(() => { m.style.display='none'; }, 280); }

  const onStart = (e) => {
    longPressTimer = setTimeout(() => {
      if (store.rendition) {
        try { DOMProxy.get('viewer-viewport').querySelectorAll('iframe').forEach(f => { const s = f.contentWindow?.getSelection()?.toString()?.trim(); if (s?.length > 1) selectedText = s; }); } catch (_) {}
      }
      if (selectedText) showMenu();
    }, 600);
  };
  ResourceRegistry.addListener(viewer, 'touchstart', onStart, { passive: true });
  ResourceRegistry.addListener(viewer, 'touchend',   () => clearTimeout(longPressTimer), { passive: true });
  ResourceRegistry.addListener(viewer, 'touchmove',  () => clearTimeout(longPressTimer), { passive: true });
  ResourceRegistry.addListener(document, 'pointerdown', (e) => { if (!DOMProxy.get('context-menu').contains?.(e.target)) { hideMenu(); selectedText = ''; } }, { passive: true });

  DOMProxy.get('ctx-copy').addEventListener('click', () => { if (selectedText) navigator.clipboard?.writeText(selectedText).catch(() => {}); Toast.show('클립보드에 복사했습니다.'); hideMenu(); });
  DOMProxy.get('ctx-tts').addEventListener('click', () => { if (selectedText) TTSSystem.play(selectedText); hideMenu(); });
  DOMProxy.get('ctx-search').addEventListener('click', () => {
    const m=DOMProxy.get('search-modal'), i=DOMProxy.get('input-search-query'); i.value=selectedText; m.style.display='flex'; runSearchExecution(); hideMenu();
  });
  DOMProxy.get('ctx-highlight').addEventListener('click', () => { Toast.show('하이라이트 기능은 텍스트 선택 후 자동 추가됩니다.'); hideMenu(); });
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
      } catch (e) { ErrorBoundary.handle('storage', e, 'annotation:create'); }
    });
  }
  function restoreAll(annotations) {
    if (!_rendition) return;
    annotations.forEach(ann => { try { _rendition.annotations.add('highlight', ann.cfiRange, { uuid: ann.uuid }, null, 'hl-' + (ann.color||'yellow')); } catch (_) {} });
  }
  function reset() { _rendition = null; }
  return { init, restoreAll, reset };
})();

function initAnnotationManager(rendition) { AnnotationManager.init(rendition); }


/* §34. 스크롤 맨위로 버튼 */
function bindScrollTopButton(view) {
  const btn = DOMProxy.get('btn-scroll-top');
  const iframe = view?.element?.querySelector('iframe');
  if (!iframe) return;
  const cw = iframe.contentWindow; if (!cw) return;
  const onScroll = () => { btn.style.display = cw.scrollY > 200 ? 'flex' : 'none'; };
  ResourceRegistry.addListener(cw, 'scroll', onScroll, { passive: true });
  btn.onclick = () => cw.scrollTo({ top: 0, behavior: 'smooth' });
}

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
      title:     DOMProxy.get('meta-edit-title').value.trim() || '제목 없음',
      creator:   DOMProxy.get('meta-edit-creator').value.trim(),
      publisher: DOMProxy.get('meta-edit-publisher').value.trim(),
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
    /* 표지 재업로드 */
    DOMProxy.get('meta-edit-cover-input').addEventListener('change', (e) => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        /* canvas 리사이즈로 200px 썸네일화 */
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const MAX = 200, ratio = Math.min(MAX / img.width, MAX / img.height, 1);
          canvas.width = Math.round(img.width * ratio); canvas.height = Math.round(img.height * ratio);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
          const preview = DOMProxy.get('meta-edit-cover-preview');
          preview.src = dataUrl; preview.style.display = 'block'; preview.dataset.newCover = dataUrl;
        };
        img.src = evt.target.result;
      };
      reader.readAsDataURL(file); e.target.value = '';
    });
  }

  return { open, close, save, init };
})();

/* ══════════════════════════════════════════════════════════
   [1]-7 어노테이션 익스포트 (Markdown / JSON / PDF)
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
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportAs(format) {
    if (!_book) return;
    const anns = await StorageSystem.getAnnotationsByBook(_book.bookKey);
    const safeTitle = (_book.title || 'book').replace(/[^a-zA-Z0-9가-힣]/g, '_').slice(0, 40);
    const sorted = anns.slice().sort((a, b) => (a.device_timestamp || 0) - (b.device_timestamp || 0));

    if (format === 'json') {
      _download(`${safeTitle}_notes.json`, JSON.stringify(sorted, null, 2), 'application/json');
    } else if (format === 'markdown') {
      let md = `# ${_book.title || '제목 없음'}\n`;
      if (_book.creator) md += `*${_book.creator}*\n`;
      md += `\n> 하이라이트 ${sorted.length}개 · 내보낸 날짜 ${new Date().toLocaleDateString('ko-KR')}\n\n---\n\n`;
      sorted.forEach((a, i) => {
        md += `### ${i + 1}. \n`;
        md += `> ${a.text || ''}\n\n`;
        if (a.note) md += `**메모:** ${a.note}\n\n`;
        md += `\n`;
      });
      _download(`${safeTitle}_notes.md`, md, 'text/markdown');
    } else if (format === 'pdf') {
      /* 의존성 없는 경량 PDF 생성 (텍스트 기반) */
      _exportPdf(_book, sorted, safeTitle);
    }
    Toast.show('내보내기가 완료되었습니다.', 'success');
    close();
  }

  /* 외부 라이브러리 없이 최소 PDF 1.4 문서를 직접 조립 */
  function _exportPdf(book, anns, safeTitle) {
    const lines = [];
    lines.push(`${book.title || '제목 없음'}`);
    if (book.creator) lines.push(`${book.creator}`);
    lines.push(`Highlights: ${anns.length}`);
    lines.push('');
    anns.forEach((a, i) => {
      const text = (a.text || '').replace(/[()\\]/g, ' ');
      /* 한 줄 80자 단위로 분할 */
      const wrapped = text.match(/.{1,80}/g) || [text];
      lines.push(`${i + 1}. ${wrapped[0]}`);
      for (let j = 1; j < wrapped.length; j++) lines.push(`   ${wrapped[j]}`);
      if (a.note) lines.push(`   [Note] ${a.note}`);
      lines.push('');
    });

    /* PDF content stream */
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
   [1]-5 풀텍스트 로컬 서재 검색 (전 도서 본문 → CFI 점프)
   ══════════════════════════════════════════════════════════ */
const LibraryFullTextSearch = (() => {
  let _running = false;

  function open() {
    DOMProxy.get('fts-modal').style.display = 'flex';
    setTimeout(() => DOMProxy.get('fts-input').focus(), 60);
  }
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

    /* [B1] ePub 가드 */
    const ready = await waitForEpubJS();
    if (!ready) { resultsEl.innerHTML = '<p class="fts-status">epub.js 로드 실패</p>'; _running = false; return; }

    for (const b of books) {
      await ErrorBoundary.wrap('renderer', async () => {
        const book = window.ePub(b.bytes.slice(0));
        const ok = await awaitBookReady(book, 10000);
        if (!ok) { try { book.destroy(); } catch (_) {} return; }
        const parser = new DOMParser();
        const items = book.spine?.items || [];
        let bookHits = 0;
        for (const item of items) {
          if (bookHits >= 5) break; /* 책당 최대 5건 */
          try {
            const section = book.spine.get(item.href || item.idref);
            if (!section) continue;
            await section.load(book.load.bind(book));
            const doc = parser.parseFromString(section.content || '<html></html>', 'text/html');
            const paras = Array.from(doc.querySelectorAll('p,h1,h2,h3,li'));
            for (const p of paras) {
              const text = p.textContent || '';
              const pos = text.toLowerCase().indexOf(q.toLowerCase());
              if (pos >= 0) {
                let cfi = ''; try { cfi = section.cfiFromElement(p); } catch (_) { cfi = item.href; }
                allHits.push({
                  bookKey: b.bookKey, title: b.title, cfi,
                  snippet: text.slice(Math.max(0, pos - 30), pos + 50),
                });
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

    /* [2]-4 가상 스크롤: 보이는 항목만 렌더 */
    VirtualListRenderer.render(resultsEl, hits, (hit) => {
      const item = document.createElement('div');
      item.className = 'fts-result-item';
      const title = document.createElement('div');
      title.className = 'fts-result-title';
      title.textContent = `📖 ${hit.title || '제목 없음'}`;
      const snip = document.createElement('div');
      snip.className = 'fts-result-snippet';
      /* 키워드 강조 */
      const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      snip.innerHTML = '';
      hit.snippet.split(re).forEach(part => {
        if (re.test(part)) { const m = document.createElement('mark'); m.textContent = part; snip.appendChild(m); re.lastIndex = 0; }
        else snip.appendChild(document.createTextNode(part));
      });
      item.appendChild(title); item.appendChild(snip);
      item.addEventListener('click', async () => {
        close();
        const rec = await StorageSystem.getBook(hit.bookKey);
        if (rec) {
          await openEpubBook(rec.bytes, true);
          /* 렌더 후 해당 CFI로 점프 */
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
   [2]-4 범용 가상 스크롤 렌더러 (TOC / 검색 결과 공용)
   IntersectionObserver sentinel + DOM 재활용
   ══════════════════════════════════════════════════════════ */
const VirtualListRenderer = (() => {
  const CHUNK = 20;
  const states = new WeakMap();

  function render(container, items, builderFn) {
    if (!container) return;
    container.innerHTML = '';
    let rendered = 0;

    const sentinel = document.createElement('div');
    sentinel.style.height = '1px';

    function renderChunk() {
      const end = Math.min(rendered + CHUNK, items.length);
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
   [1]-8 클라우드 수동 백업 / 복원 (WebDAV + Google Drive 프레임워크)
   ══════════════════════════════════════════════════════════ */
const CloudBackup = (() => {
  /* 로컬 파일 백업 (즉시 가용) */
  async function backupToFile() {
    Toast.show('백업 데이터를 생성 중입니다...', 'info');
    const data = await StorageSystem.exportDatabase();
    const json = JSON.stringify(data);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `fable_backup_${new Date().toISOString().slice(0,10)}.json`;
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

  /* ── WebDAV 프레임워크 스텁 ── */
  const WebDAV = {
    async upload(url, user, pass, data) {
      /* PUT 요청으로 프라이빗 WebDAV 서버에 업로드 */
      const auth = 'Basic ' + btoa(`${user}:${pass}`);
      return fetch(url, { method: 'PUT', headers: { 'Authorization': auth, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    },
    async download(url, user, pass) {
      const auth = 'Basic ' + btoa(`${user}:${pass}`);
      const res = await fetch(url, { headers: { 'Authorization': auth } });
      if (!res.ok) throw new Error(`WebDAV ${res.status}`);
      return res.json();
    },
  };

  /* ── Google Drive 프레임워크 스텁 (OAuth 토큰 필요) ── */
  const GoogleDrive = {
    async upload(accessToken, data) {
      const metadata = { name: `fable_backup_${Date.now()}.json`, mimeType: 'application/json' };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', new Blob([JSON.stringify(data)], { type: 'application/json' }));
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
    /* 백업 버튼 클릭은 initLibraryControls에서 바인딩됨 — 여기선 복원 input만 처리 */
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
   [1]-12 포모도로 독서 타이머 (25분 집중 / 5분 휴식)
   ══════════════════════════════════════════════════════════ */
const Pomodoro = (() => {
  const FOCUS = 25 * 60, BREAK = 5 * 60;
  let remaining = FOCUS, mode = 'idle', timer = null;

  function _fmt(s) { const m = Math.floor(s / 60), sec = s % 60; return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`; }

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
  function reset() { clearInterval(timer); timer = null; mode = 'idle'; remaining = FOCUS; store.pomodoroState = 'idle'; setTextSafe(DOMProxy.get('pomodoro-time'), _fmt(FOCUS)); _updateModeLabel(); setTextSafe(DOMProxy.get('btn-pomodoro-toggle'), '▶'); }
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
    DOMProxy.get('btn-pomodoro-close').addEventListener('click', () => { pause(); DOMProxy.get('pomodoro-popup').style.display = 'none'; });
  }
  function openPopup() {
    const popup = DOMProxy.get('pomodoro-popup');
    popup.style.display = popup.style.display === 'flex' ? 'none' : 'flex';
  }

  return { init, start, pause, reset, toggle, openPopup };
})();

export {
  renderTocSidebar,
  updateTocActiveItem,
  VirtualSearchList,
  SearchEngine,
  runSearchExecution,
  injectSearchHighlight,
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
