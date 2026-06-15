/**
 * src/ui/uploader.js
 * ───────────────────────────────────────────────────────────────
 * 서재(책장) UI + 업로더 인터랙션
 *
 * 보존된 스펙:
 *   - HashWorker (Web Worker 해시 + 메인스레드 폴백)
 *   - refreshLibraryData (books/folders/tags/readingLog → store)
 *   - 표지/HSL 플레이스홀더, 최근 읽은 책, 폴더 바(드래그&드롭),
 *     태그 바, 분석 대시보드, 도서 카드 메뉴, 가상 청크 그리드 렌더
 *   - [2]-9 AbortController 그리드 렌더 뮤텍스
 *   - [L3] 다중 파일 순차 등록 파이프라인 + [2]-3 배치 트랜잭션 + 중복 방지
 * ─────────────────────────────────────────────────────────────── */

'use strict';

import {
  store, ReactiveStore, DOMProxy, ErrorBoundary, Toast,
  setTextSafe, RECENT_MAX, ImportProgress,
} from '../store.js';
import { StorageSystem } from '../database.js';
import {
  openEpubBook, extractCoverDataUrl, awaitBookReady, waitForEpubJS,
} from '../reader.js';
import { MetadataEditor } from './viewer.js';
import { AnnotationExporter } from './viewer.js';

/* ══════════════════════════════════════════════════════════
   §24. [L1/L2/v5] 서재 렌더링 헬퍼
   ══════════════════════════════════════════════════════════ */
const TITLE_MAX_LEN = 10; /* [L2] 말줄임표 최대 글자 수 */

export function truncateTitle(title) {
  if (!title) return '제목 없음';
  return title.length > TITLE_MAX_LEN ? title.slice(0, TITLE_MAX_LEN) + '…' : title;
}

function computeFileHash(file) {
  const seed = `${file.name}::${file.size}`;
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) + hash) + seed.charCodeAt(i);
  return `h${(hash >>> 0).toString(36)}_${file.size}`;
}

/* ══════════════════════════════════════════════════════════
   [2]-10 Web Worker 해시 연산 — 메인 스레드 60fps 유지
   대용량 파일은 내용 일부 + 메타로 해시를 백그라운드에서 산출
   ══════════════════════════════════════════════════════════ */
const HashWorker = (() => {
  let worker = null;
  let seq = 0;
  const pending = new Map();

  function _ensure() {
    if (worker) return;
    const code = `
      self.onmessage = function(e) {
        var id = e.data.id, name = e.data.name, size = e.data.size, sample = e.data.sample;
        var seed = name + '::' + size + '::';
        var hash = 5381;
        for (var i = 0; i < seed.length; i++) hash = ((hash << 5) + hash) + seed.charCodeAt(i);
        var bytes = new Uint8Array(sample);
        for (var j = 0; j < bytes.length; j += 64) hash = ((hash << 5) + hash) + bytes[j];
        self.postMessage({ id: id, hash: 'h' + (hash >>> 0).toString(36) + '_' + size });
      };
    `;
    try {
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (e) => {
        const { id, hash } = e.data;
        const res = pending.get(id);
        if (res) { res(hash); pending.delete(id); }
      };
      worker.onerror = () => { worker = null; };
    } catch (_) { worker = null; }
  }

  /** 파일 해시를 워커에서 산출 (실패 시 메인스레드 폴백) */
  async function compute(file) {
    _ensure();
    if (!worker) return computeFileHash(file);
    try {
      const sample = await file.slice(0, 65536).arrayBuffer();
      return await new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        worker.postMessage({ id, name: file.name, size: file.size, sample }, [sample]);
        /* 타임아웃 폴백 */
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(computeFileHash(file)); } }, 3000);
      });
    } catch (_) { return computeFileHash(file); }
  }

  function destroy() { if (worker) { worker.terminate(); worker = null; } pending.clear(); }
  return { compute, destroy };
})();

/**
 * [v6] 서재 데이터 로드 → Reactive Store 반영
 * books / folders / 태그집계 / readingLog 를 단일 트랜잭션 묶음으로 로드
 */
async function refreshLibraryData() {
  const [books, folders, readingLog] = await Promise.all([
    StorageSystem.getAllBooks(),
    StorageSystem.getAllFolders(),
    StorageSystem.getReadingLog(),
  ]);
  /* 전역 태그 집계 */
  const tagSet = new Set();
  books.forEach(b => (b.tags || []).forEach(t => tagSet.add(t)));
  ReactiveStore.patch({
    libraryBooks: books,
    folders,
    readingLog,
    allTags: [...tagSet].sort(),
  });
}

/** [L1] 표지 또는 HSL 플레이스홀더 노드 생성 */
function _buildCoverNode(book) {
  if (book.coverDataUrl) {
    const img = document.createElement('img');
    img.className = 'book-cover-img';
    img.src       = book.coverDataUrl;
    img.alt       = book.title || '표지';
    img.loading   = 'lazy';
    /* [보완] 표지 로드 실패 시 HSL 플레이스홀더로 폴백 */
    img.onerror = () => { img.replaceWith(_buildPlaceholder(book.title || '')); };
    return img;
  }
  return _buildPlaceholder(book.title || '');
}

/** [보완] 제목 첫 글자 기반 HSL 플레이스홀더 */
function _buildPlaceholder(title) {
  const placeholder = document.createElement('div');
  placeholder.className = 'book-cover-placeholder';
  const hue = _titleToHue(title);
  placeholder.style.background = `hsl(${hue}, 32%, 70%)`;
  placeholder.setAttribute('aria-hidden', 'true');
  const initials = document.createElement('span');
  initials.textContent = (title.trim()[0] || 'E').toUpperCase();
  placeholder.appendChild(initials);
  return placeholder;
}

/**
 * [요구2-최상단] 최근 읽은 책 3권 렌더링 (진행률 포함)
 */
function renderRecentBooks(books) {
  const section = DOMProxy.get('recent-section');
  const row     = DOMProxy.get('recent-row');
  if (!DOMProxy.exists('recent-row')) return;

  const recent = books
    .filter(b => b.lastReadAt)
    .sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0))
    .slice(0, RECENT_MAX);

  if (!recent.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  row.innerHTML = '';

  const frag = document.createDocumentFragment();
  recent.forEach(b => {
    const pct = b.percent || 0;
    const item = document.createElement('div');
    item.className = 'recent-card';
    item.setAttribute('role', 'listitem');
    item.setAttribute('aria-label', `${b.title || '제목 없음'} 이어 읽기 (${pct}%)`);

    const cover = document.createElement('div');
    cover.className = 'recent-cover';
    cover.appendChild(_buildCoverNode(b));

    const info = document.createElement('div');
    info.className = 'recent-info';

    const titleEl = document.createElement('div');
    titleEl.className = 'recent-title';
    titleEl.textContent = b.title || '제목 없음';

    const progWrap = document.createElement('div');
    progWrap.className = 'recent-progress-track';
    progWrap.setAttribute('role', 'progressbar');
    progWrap.setAttribute('aria-valuenow', String(pct));
    progWrap.setAttribute('aria-valuemin', '0');
    progWrap.setAttribute('aria-valuemax', '100');
    const progFill = document.createElement('div');
    progFill.className = 'recent-progress-fill';
    progFill.style.width = `${pct}%`;
    progWrap.appendChild(progFill);

    const pctText = document.createElement('span');
    pctText.className = 'recent-pct';
    pctText.textContent = `${pct}% 읽음`;

    info.appendChild(titleEl);
    info.appendChild(progWrap);
    info.appendChild(pctText);

    item.appendChild(cover);
    item.appendChild(info);
    item.addEventListener('click', () => openEpubBook(b.bytes, true));
    frag.appendChild(item);
  });
  row.appendChild(frag);
}

/**
 * [요구2-중단] 폴더 칩 바 렌더링
 */
function renderFolderBar(folders, books) {
  const bar = DOMProxy.get('folder-bar');
  if (!DOMProxy.exists('folder-bar')) return;
  bar.innerHTML = '';

  const frag = document.createDocumentFragment();

  /* '전체' 칩 */
  const allChip = document.createElement('button');
  allChip.className = 'folder-chip' + (store.activeFolderId === null ? ' active' : '');
  allChip.textContent = `전체 (${books.length})`;
  allChip.setAttribute('role', 'tab');
  allChip.setAttribute('aria-selected', String(store.activeFolderId === null));
  allChip.addEventListener('click', () => { store.activeFolderId = null; });
  frag.appendChild(allChip);

  /* 폴더 칩들 */
  folders.forEach(f => {
    const cnt = books.filter(b => b.folderId === f.id).length;
    const chip = document.createElement('button');
    chip.className = 'folder-chip' + (store.activeFolderId === f.id ? ' active' : '');
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', String(store.activeFolderId === f.id));

    const label = document.createElement('span');
    label.textContent = `📁 ${f.name} (${cnt})`;
    chip.appendChild(label);

    /* 폴더 삭제 버튼 */
    const del = document.createElement('span');
    del.className = 'folder-chip-del';
    del.textContent = '✕';
    del.setAttribute('role', 'button');
    del.setAttribute('aria-label', `${f.name} 폴더 삭제`);
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      /* [요구1-3] 파괴적 유실 방지 — 엄격한 Cascade 경고 */
      const warn = '이 폴더를 삭제하면 폴더 안의 모든 도서와 독서 퍼센트 기록, 하이라이트가 영구적으로 함께 삭제됩니다. 정말 삭제하시겠습니까?';
      if (confirm(warn)) {
        /* [요구1-4] 트랜잭션 원자성 — DB cascade 완료(await) 직후 store 1회 갱신 */
        StorageSystem.deleteFolder(f.id).then(async (result) => {
          if (store.activeFolderId === f.id) store.activeFolderId = null;
          /* 단일 트랜잭션 settle 후 libraryBooks + folders를 한 번에 patch (플리커 제로) */
          const [books, folders] = await Promise.all([
            StorageSystem.getAllBooks(),
            StorageSystem.getAllFolders(),
          ]);
          ReactiveStore.patch({ libraryBooks: books, folders });
          const n = result?.deletedBooks || 0;
          Toast.show(n > 0 ? `폴더와 도서 ${n}권이 삭제되었습니다.` : '폴더가 삭제되었습니다.', 'success');
        });
      }
    });
    chip.appendChild(del);

    chip.addEventListener('click', () => { store.activeFolderId = f.id; });

    /* [3]-8 드롭 타깃: 도서 카드를 폴더 칩 위로 드롭하면 이동 */
    chip.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('text/fable-book')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        chip.classList.add('drop-target');
      }
    });
    chip.addEventListener('dragleave', () => chip.classList.remove('drop-target'));
    chip.addEventListener('drop', async (e) => {
      e.preventDefault();
      chip.classList.remove('drop-target');
      const bookKey = e.dataTransfer.getData('text/fable-book');
      if (!bookKey) return;
      await StorageSystem.setBookFolder(bookKey, f.id);
      await refreshLibraryData();
      Toast.show(`'${f.name}'(으)로 이동했습니다.`, 'success');
    });

    frag.appendChild(chip);
  });

  /* '전체' 칩도 드롭 타깃 (폴더에서 빼기) */
  allChip.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/fable-book')) { e.preventDefault(); allChip.classList.add('drop-target'); }
  });
  allChip.addEventListener('dragleave', () => allChip.classList.remove('drop-target'));
  allChip.addEventListener('drop', async (e) => {
    e.preventDefault();
    allChip.classList.remove('drop-target');
    const bookKey = e.dataTransfer.getData('text/fable-book');
    if (!bookKey) return;
    await StorageSystem.setBookFolder(bookKey, null);
    await refreshLibraryData();
    Toast.show('폴더에서 제외했습니다.', 'success');
  });

  /* 폴더 생성 버튼 */
  const addChip = document.createElement('button');
  addChip.className = 'folder-chip folder-chip--add';
  addChip.textContent = '+ 폴더';
  addChip.setAttribute('aria-label', '새 폴더 생성');
  addChip.addEventListener('click', createFolderPrompt);
  frag.appendChild(addChip);

  bar.appendChild(frag);
}

/** 폴더 생성 프롬프트 */
function createFolderPrompt() {
  const name = prompt('새 폴더 이름을 입력하세요:');
  if (!name || !name.trim()) return;
  const folder = { id: 'folder_' + Date.now().toString(36), name: name.trim().slice(0, 30), ts: Date.now() };
  StorageSystem.saveFolder(folder).then(async () => {
    await refreshLibraryData();
    Toast.show(`'${folder.name}' 폴더가 생성되었습니다.`, 'success');
  });
}

/**
 * [요구2-도서카드] 카드 메뉴 (폴더 지정 + 삭제)
 */
function _showCardMenu(book, anchorEl) {
  document.querySelectorAll('.card-menu-popup').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'card-menu-popup';
  menu.setAttribute('role', 'menu');

  const head = document.createElement('div');
  head.className = 'card-menu-head';
  head.textContent = '폴더로 이동';
  menu.appendChild(head);

  /* 폴더 없음(전체) 옵션 */
  const noneItem = document.createElement('button');
  noneItem.className = 'card-menu-item' + (book.folderId == null ? ' checked' : '');
  noneItem.setAttribute('role', 'menuitem');
  noneItem.textContent = '📚 폴더 없음';
  noneItem.addEventListener('click', async (e) => {
    e.stopPropagation();
    await StorageSystem.setBookFolder(book.bookKey, null);
    await refreshLibraryData();
    menu.remove();
  });
  menu.appendChild(noneItem);

  store.folders.forEach(f => {
    const item = document.createElement('button');
    item.className = 'card-menu-item' + (book.folderId === f.id ? ' checked' : '');
    item.setAttribute('role', 'menuitem');
    item.textContent = `📁 ${f.name}`;
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      await StorageSystem.setBookFolder(book.bookKey, f.id);
      await refreshLibraryData();
      menu.remove();
      Toast.show(`'${f.name}'(으)로 이동했습니다.`, 'success');
    });
    menu.appendChild(item);
  });

  /* 새 폴더 생성 후 이동 */
  const newFolder = document.createElement('button');
  newFolder.className = 'card-menu-item card-menu-item--accent';
  newFolder.setAttribute('role', 'menuitem');
  newFolder.textContent = '+ 새 폴더에 추가';
  newFolder.addEventListener('click', async (e) => {
    e.stopPropagation();
    const name = prompt('새 폴더 이름:');
    if (name && name.trim()) {
      const folder = { id: 'folder_' + Date.now().toString(36), name: name.trim().slice(0, 30), ts: Date.now() };
      await StorageSystem.saveFolder(folder);
      await StorageSystem.setBookFolder(book.bookKey, folder.id);
      await refreshLibraryData();
      Toast.show(`'${folder.name}'에 추가되었습니다.`, 'success');
    }
    menu.remove();
  });
  menu.appendChild(newFolder);

  const divider0 = document.createElement('div');
  divider0.className = 'card-menu-divider';
  menu.appendChild(divider0);

  /* [1]-6 태그 편집 */
  const tagItem = document.createElement('button');
  tagItem.className = 'card-menu-item';
  tagItem.setAttribute('role', 'menuitem');
  tagItem.textContent = '🏷 태그 편집';
  tagItem.addEventListener('click', async (e) => {
    e.stopPropagation();
    menu.remove();
    const cur = (book.tags || []).join(', ');
    const input = prompt('태그를 쉼표(,)로 구분해 입력하세요:', cur);
    if (input === null) return;
    const tags = [...new Set(input.split(',').map(t => t.trim()).filter(Boolean).map(t => t.slice(0, 20)))].slice(0, 8);
    await StorageSystem.updateBookTags(book.bookKey, tags);
    await refreshLibraryData();
    Toast.show('태그가 저장되었습니다.', 'success');
  });
  menu.appendChild(tagItem);

  /* [1]-11 메타데이터 편집 */
  const metaItem = document.createElement('button');
  metaItem.className = 'card-menu-item';
  metaItem.setAttribute('role', 'menuitem');
  metaItem.textContent = '✏️ 정보 편집';
  metaItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.remove();
    MetadataEditor.open(book);
  });
  menu.appendChild(metaItem);

  /* [1]-7 메모/하이라이트 내보내기 */
  const exportItem = document.createElement('button');
  exportItem.className = 'card-menu-item';
  exportItem.setAttribute('role', 'menuitem');
  exportItem.textContent = '📤 메모 내보내기';
  exportItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.remove();
    AnnotationExporter.open(book);
  });
  menu.appendChild(exportItem);

  const divider = document.createElement('div');
  divider.className = 'card-menu-divider';
  menu.appendChild(divider);

  /* 삭제 */
  const delItem = document.createElement('button');
  delItem.className = 'card-menu-item card-menu-item--danger';
  delItem.setAttribute('role', 'menuitem');
  delItem.textContent = '🗑 서재에서 삭제';
  delItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.remove();
    /* [요구1-2] 도서 삭제 시 하이라이트/메모 연쇄 제거 안내 */
    if (confirm('이 도서를 삭제하면 독서 기록과 하이라이트·메모가 함께 영구 삭제됩니다. 삭제하시겠습니까?')) {
      StorageSystem.deleteBook(book.bookKey).then(async () => {
        await refreshLibraryData();
        Toast.show('도서와 관련 기록이 삭제되었습니다.', 'success');
      });
    }
  });
  menu.appendChild(delItem);

  document.body.appendChild(menu);

  /* 위치 — 앵커 기준, 뷰포트 오버플로우 방지 */
  const rect = anchorEl.getBoundingClientRect();
  let left = rect.left;
  let top  = rect.bottom + 6;
  const mw = 200, mh = menu.offsetHeight || 280;
  if (left + mw > window.innerWidth - 8)  left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8)  top = rect.top - mh - 6;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top  = `${Math.max(8, top)}px`;

  /* 외부 클릭 닫기 */
  const closeHandler = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', closeHandler); }
  };
  setTimeout(() => document.addEventListener('pointerdown', closeHandler), 10);
}

/* ══════════════════════════════════════════════════════════
   [1]-4/10 독서 분석 대시보드 (주간 추이 + 목표 달성률 + 인사이트)
   ══════════════════════════════════════════════════════════ */
function renderAnalyticsDashboard(books, readingLog) {
  const wrap = DOMProxy.get('dashboard-section');
  if (!DOMProxy.exists('dashboard-section')) return;

  /* 최근 7일 막대 그래프 데이터 */
  const days = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ key, label: ['일','월','화','수','목','금','토'][d.getDay()], sec: readingLog[key] || 0 });
  }
  const maxSec = Math.max(60, ...days.map(d => d.sec));
  const todaySec = days[days.length - 1].sec;
  const goalSec  = (store.dailyGoalMin || 30) * 60;
  const goalPct  = Math.min(100, Math.round((todaySec / goalSec) * 100));

  /* 주간 합계 */
  const weekSec = days.reduce((s, d) => s + d.sec, 0);
  const weekMin = Math.round(weekSec / 60);

  /* 인사이트: 평균 진행률 + 완독 예상 */
  const inProgress = books.filter(b => (b.percent || 0) > 0 && (b.percent || 0) < 100);
  const avgPct = inProgress.length ? Math.round(inProgress.reduce((s, b) => s + b.percent, 0) / inProgress.length) : 0;

  /* 막대 그래프 */
  const bars = days.map(d => {
    const h = Math.round((d.sec / maxSec) * 100);
    const min = Math.round(d.sec / 60);
    return `<div class="dash-bar-col">
      <div class="dash-bar-wrap"><div class="dash-bar" style="height:${h}%" title="${min}분"></div></div>
      <span class="dash-bar-label">${d.label}</span>
    </div>`;
  }).join('');

  wrap.innerHTML = `
    <div class="dash-grid">
      <div class="dash-card dash-card--chart">
        <div class="dash-card-head">주간 독서 추이</div>
        <div class="dash-chart">${bars}</div>
        <div class="dash-week-total">이번 주 ${weekMin}분</div>
      </div>
      <div class="dash-card dash-card--goal">
        <div class="dash-card-head">오늘 목표 달성률</div>
        <div class="dash-ring" style="--goal:${goalPct}">
          <span class="dash-ring-pct">${goalPct}%</span>
        </div>
        <div class="dash-goal-detail">${Math.round(todaySec/60)} / ${store.dailyGoalMin || 30}분</div>
      </div>
      <div class="dash-card dash-card--insight">
        <div class="dash-card-head">인사이트</div>
        <ul class="dash-insight-list">
          <li><span>읽는 중</span><strong>${inProgress.length}권</strong></li>
          <li><span>평균 진행률</span><strong>${avgPct}%</strong></li>
          <li><span>서재 도서</span><strong>${books.length}권</strong></li>
        </ul>
      </div>
    </div>`;
}

/* ══════════════════════════════════════════════════════════
   [1]-6 스마트 태그 다중 필터 바
   ══════════════════════════════════════════════════════════ */
function renderTagBar(allTags, books) {
  const bar = DOMProxy.get('tag-bar');
  if (!DOMProxy.exists('tag-bar')) return;
  bar.innerHTML = '';

  if (!allTags.length) {
    const hint = document.createElement('span');
    hint.className = 'tag-empty-hint';
    hint.textContent = '도서 메뉴에서 태그를 추가할 수 있습니다';
    bar.appendChild(hint);
    return;
  }

  const frag = document.createDocumentFragment();
  allTags.forEach(t => {
    const cnt = books.filter(b => (b.tags || []).includes(t)).length;
    const chip = document.createElement('button');
    const active = store.activeTags.includes(t);
    chip.className = 'tag-chip' + (active ? ' active' : '');
    chip.textContent = `#${t} ${cnt}`;
    chip.setAttribute('aria-pressed', String(active));
    chip.addEventListener('click', () => {
      const set = new Set(store.activeTags);
      set.has(t) ? set.delete(t) : set.add(t);
      store.activeTags = [...set];
    });
    frag.appendChild(chip);
  });

  /* 정렬 셀렉터 */
  const sortSel = document.createElement('select');
  sortSel.className = 'sort-select';
  sortSel.setAttribute('aria-label', '도서 정렬 기준');
  [['recent','최근 읽음'],['title','제목순'],['progress','진행률'],['added','추가순']].forEach(([v, label]) => {
    const opt = document.createElement('option');
    opt.value = v; opt.textContent = label;
    if (store.sortMode === v) opt.selected = true;
    sortSel.appendChild(opt);
  });
  sortSel.addEventListener('change', () => { store.sortMode = sortSel.value; });
  frag.appendChild(sortSel);

  bar.appendChild(frag);
}

/**
 * [요구2-하단 + v6] 도서 그리드 렌더링
 *  - 대시보드/태그/폴더/정렬/검색 필터 적용
 *  - [2]-9 AbortController 뮤텍스: 연속 폴더 클릭 시 이전 렌더 중단
 *  - [3]-8 카드 드래그&드롭으로 폴더 이동
 */
let _gridRenderController = null;

function renderLibraryGrid() {
  const grid  = DOMProxy.get('library-grid');
  const empty = DOMProxy.get('library-empty');
  const count = DOMProxy.get('library-count');
  if (!DOMProxy.exists('library-grid')) return;

  /* [2]-9 이전 렌더 중단 */
  if (_gridRenderController) _gridRenderController.abort();
  _gridRenderController = new AbortController();
  const signal = _gridRenderController.signal;

  const allBooks = store.libraryBooks || [];

  /* 상단 위젯 갱신 */
  renderAnalyticsDashboard(allBooks, store.readingLog || {});
  renderRecentBooks(allBooks);
  renderFolderBar(store.folders || [], allBooks);
  renderTagBar(store.allTags || [], allBooks);

  /* ── 필터 파이프라인 ── */
  let books = allBooks.slice();

  /* 폴더 필터 */
  if (store.activeFolderId !== null) books = books.filter(b => b.folderId === store.activeFolderId);

  /* 태그 다중 필터 (AND) */
  if (store.activeTags.length) {
    books = books.filter(b => store.activeTags.every(t => (b.tags || []).includes(t)));
  }

  /* 서재 검색어 (제목/저자) */
  const q = (store.librarySearch || '').trim().toLowerCase();
  if (q) books = books.filter(b => (b.title || '').toLowerCase().includes(q) || (b.creator || '').toLowerCase().includes(q));

  /* 정렬 */
  switch (store.sortMode) {
    case 'title':    books.sort((a, b) => (a.title || '').localeCompare(b.title || '')); break;
    case 'progress': books.sort((a, b) => (b.percent || 0) - (a.percent || 0)); break;
    case 'added':    books.sort((a, b) => (b.seq || 0) - (a.seq || 0)); break;
    case 'recent':
    default:         books.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0)); break;
  }

  grid.innerHTML = '';

  if (!allBooks.length) {
    if (empty) empty.style.display = 'flex';
    if (count) count.textContent = '';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (count) count.textContent = `${books.length}권`;

  if (!books.length) {
    const p = document.createElement('p');
    p.style.cssText = 'grid-column:1/-1;text-align:center;padding:30px;color:var(--color-ink-muted);font-size:13px;';
    p.textContent = '조건에 맞는 도서가 없습니다.';
    grid.appendChild(p);
    return;
  }

  /* [2]-4 대량 그리드는 청크 단위로 렌더 (AbortController 중단 가능) */
  const frag = document.createDocumentFragment();
  const CHUNK = 24;
  let idx = 0;

  function renderChunk() {
    if (signal.aborted) return;
    const end = Math.min(idx + CHUNK, books.length);
    for (; idx < end; idx++) {
      frag.appendChild(_buildBookCard(books[idx]));
    }
    if (idx < books.length) {
      requestAnimationFrame(renderChunk);
    } else {
      if (!signal.aborted) grid.appendChild(frag);
    }
    /* 첫 청크는 즉시 부착해 체감 속도 향상 */
    if (idx === Math.min(CHUNK, books.length) && grid.childElementCount === 0) {
      grid.appendChild(frag);
    }
  }
  /* 단순화: 한 번에 부착하되 signal 확인 */
  if (signal.aborted) return;
  books.forEach(b => frag.appendChild(_buildBookCard(b)));
  if (!signal.aborted) grid.appendChild(frag);
}

/** 개별 도서 카드 빌더 ([3]-8 드래그 소스 포함) */
function _buildBookCard(b) {
  const fullTitle = b.title || '제목 없음';
  const pct = b.percent || 0;

  const card = document.createElement('div');
  card.className = 'book-card';
  card.setAttribute('role', 'listitem');
  card.setAttribute('aria-label', `${fullTitle} 열기 (${pct}% 읽음)`);
  card.draggable = true;
  card.dataset.bookKey = b.bookKey;

  /* [3]-8 드래그 시작 */
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/fable-book', b.bookKey);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  const coverWrap = document.createElement('div');
  coverWrap.className = 'book-cover-wrap';
  coverWrap.dataset.tooltip = fullTitle;
  coverWrap.appendChild(_buildCoverNode(b));

  if (pct > 0) {
    const badge = document.createElement('div');
    badge.className = 'book-progress-badge';
    badge.textContent = `${pct}%`;
    coverWrap.appendChild(badge);
  }

  const menuBtn = document.createElement('button');
  menuBtn.className = 'btn-card-menu';
  menuBtn.textContent = '⋯';
  menuBtn.title = '도서 메뉴';
  menuBtn.setAttribute('aria-label', `${fullTitle} 메뉴`);
  menuBtn.setAttribute('aria-haspopup', 'menu');
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); _showCardMenu(b, menuBtn); });
  coverWrap.appendChild(menuBtn);

  const progLine = document.createElement('div');
  progLine.className = 'book-card-progress';
  const progLineFill = document.createElement('div');
  progLineFill.className = 'book-card-progress-fill';
  progLineFill.style.width = `${pct}%`;
  progLine.appendChild(progLineFill);
  coverWrap.appendChild(progLine);

  const titleEl = document.createElement('div');
  titleEl.className = 'book-card-title';
  titleEl.textContent = truncateTitle(fullTitle);

  /* 태그 미니칩 */
  if ((b.tags || []).length) {
    const tagRow = document.createElement('div');
    tagRow.className = 'book-card-tags';
    b.tags.slice(0, 2).forEach(t => {
      const chip = document.createElement('span');
      chip.className = 'book-card-tag';
      chip.textContent = t;
      tagRow.appendChild(chip);
    });
    card.appendChild(coverWrap);
    card.appendChild(titleEl);
    card.appendChild(tagRow);
  } else {
    card.appendChild(coverWrap);
    card.appendChild(titleEl);
  }

  card.addEventListener('click', () => openEpubBook(b.bytes, true));
  return card;
}

/* ══════════════════════════════════════════════════════════
   §25. [L3] 다중 파일 순차 등록 파이프라인 + [보완] 중복 방지
   ══════════════════════════════════════════════════════════ */
async function importEpubFiles(files) {
  if (!files || files.length === 0) return;

  /* [B1] ePub 가드 먼저 */
  const epubReady = await waitForEpubJS();
  if (!epubReady) {
    Toast.show('EPUB 엔진(epub.js/JSZip)을 로드하지 못했습니다. 네트워크 확인 후 새로고침해 주세요.', 'error');
    return;
  }

  const fileArr = Array.from(files);
  const total   = fileArr.length;

  /*
   * [버그1 수정] 파일 등록 = 서재 추가 전용 동선.
   * ───────────────────────────────────────────────────────────
   * 과거: 단일 파일 업로드 시 openEpubBook()을 호출해 저장과 동시에
   *       뷰어로 강제 진입했음(동선 오류).
   * 변경: 단일/다중 구분 없이 '메타·표지 추출 → 서재 저장 → 갱신'만
   *       수행하고, 뷰어 진입은 절대 하지 않는다.
   *       (실제 책 열기는 서재 그리드에서 카드 클릭 시에만 발생)
   */
  ImportProgress.show(`0 / ${total} 도서 추가 중...`);
  let successCount = 0, dupCount = 0;
  const batch = []; /* { bookKey, buffer, title, creator, coverDataUrl, fileHash, publisher } */

  for (let i = 0; i < fileArr.length; i++) {
    const file = fileArr[i];

    if (!file.name.toLowerCase().endsWith('.epub')) {
      Toast.show(`${file.name}: EPUB 파일이 아닙니다.`, 'error');
      continue;
    }

    /* [보완] 중복 파일 등록 방지 (이름+크기 해시, 워커 산출) */
    const fileHash = await HashWorker.compute(file);
    const existing = await StorageSystem.findBookByHash(fileHash);
    if (existing) { dupCount++; continue; }
    /* 같은 배치 내 중복도 차단 */
    if (batch.some(r => r.fileHash === fileHash)) { dupCount++; continue; }

    ImportProgress.update(
      Math.round(((i + 0.5) / total) * 100),
      `${i + 1} / ${total} — ${file.name.slice(0, 20)}`
    );

    await ErrorBoundary.wrap('renderer', async () => {
      const buf  = await file.arrayBuffer();
      const book = window.ePub(buf.slice(0));
      /* book.ready 타임아웃 가드 — 멈춤 방지 (JSZip 누락/손상 EPUB 대비) */
      const ok = await awaitBookReady(book, 12000);
      if (!ok) {
        try { book.destroy(); } catch (_) {}
        Toast.show(`${file.name}: 분석 시간 초과로 건너뜁니다.`, 'error');
        return;
      }

      let title = file.name.replace(/\.epub$/i, ''), creator = '', publisher = '';
      try {
        const meta = await book.loaded.metadata;
        title     = meta.title     || title;
        creator   = meta.creator   || '';
        publisher = meta.publisher || '';
      } catch (_) {}

      const coverDataUrl = await extractCoverDataUrl(book);
      try { book.destroy(); } catch (_) {}

      const bookKey = 'fable_cfi_' + (title + creator).replace(/[^a-zA-Z0-9가-힣]/g, '_').slice(0, 50);
      batch.push({ bookKey, buffer: buf, title, creator, coverDataUrl, fileHash, publisher });
      successCount++;
    })();

    /* 프레임 양보 (메타 파싱은 무겁지만 디스크 쓰기는 배치로 1회만) */
    await new Promise(r => setTimeout(r, 0));
  }

  /* [2]-3 모든 도서를 단일 readwrite 트랜잭션으로 일괄 저장 */
  if (batch.length) {
    await ErrorBoundary.wrap('storage', () => StorageSystem.batchSaveBooks(batch))();
  }

  ImportProgress.update(100, '완료!');
  await new Promise(r => setTimeout(r, 600));
  ImportProgress.hide();

  await refreshLibraryData();

  let msg = '';
  if (successCount > 0) msg += `${successCount}권 추가`;
  if (dupCount > 0)     msg += `${msg ? ', ' : ''}중복 ${dupCount}권 제외`;
  if (msg) Toast.show(msg + ' 완료', 'success');
}


export {
  computeFileHash,
  HashWorker,
  refreshLibraryData,
  renderRecentBooks,
  renderFolderBar,
  createFolderPrompt,
  renderAnalyticsDashboard,
  renderTagBar,
  renderLibraryGrid,
  importEpubFiles,
};
