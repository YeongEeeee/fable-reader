/**
 * src/ui/uploader.js  ── Fable Premium v4.0
 * ─────────────────────────────────────────────────────────────────
 * 서재(책장) UI + 업로더 인터랙션
 *
 * v4.0 고도화 사항:
 *   [다중 서재 폴더 트리 계층화]  계층 트리형 폴더 구조 + 흡입 D&D 애니메이션
 *   [가상 청크 그리드 렌더러]     1000권+ 대량 서재 Virtual Scroll (뷰포트 기반 마운트/언마운트)
 *   [스켈레톤 UI]               로딩 시 keyframe shimmer 플레이스홀더 노출
 *
 * 보존된 스펙:
 *   HashWorker, refreshLibraryData, 표지/HSL 플레이스홀더,
 *   최근 읽은 책, 폴더 바 D&D, 태그 바, 분석 대시보드,
 *   도서 카드 메뉴, AbortController 그리드 렌더 뮤텍스,
 *   [L3] 다중 파일 순차 등록 파이프라인 + 배치 트랜잭션 + 중복 방지
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

import {
  store, ReactiveStore, DOMProxy, ErrorBoundary, Toast,
  setTextSafe, RECENT_MAX,
} from '../store.js';
import { StorageSystem } from '../database.js';
import {
  openEpubBook, extractCoverDataUrl, awaitBookReady, waitForEpubJS,
} from '../reader.js';
import { MetadataEditor, AnnotationExporter } from './viewer.js';

/* ══════════════════════════════════════════════════════════
   §0. 상수 및 공유 헬퍼
   ══════════════════════════════════════════════════════════ */
const TITLE_MAX_LEN = 10;

export function truncateTitle(title) {
  if (!title) return '제목 없음';
  return title.length > TITLE_MAX_LEN ? title.slice(0, TITLE_MAX_LEN) + '…' : title;
}

function _titleToHue(title) {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) & 0xffffff;
  return h % 360;
}

/* ══════════════════════════════════════════════════════════
   §1. 스켈레톤 UI — shimmer keyframe 플레이스홀더
   ── 표지 / 카드 데이터가 로드되기 전 자동 노출
   ══════════════════════════════════════════════════════════ */
const SkeletonUI = (() => {
  const CSS = `
    @keyframes fable-shimmer {
      0%   { background-position: -400px 0; }
      100% { background-position:  400px 0; }
    }
    .skel-card {
      border-radius: 8px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .skel-cover {
      width: 100%;
      aspect-ratio: 2/3;
      border-radius: 6px;
      background: linear-gradient(90deg,
        var(--color-border-soft,#e0dbd3) 25%,
        var(--color-surface,#f4f1ea) 50%,
        var(--color-border-soft,#e0dbd3) 75%);
      background-size: 800px 100%;
      animation: fable-shimmer 1.4s ease-in-out infinite;
    }
    .skel-line {
      height: 10px;
      border-radius: 4px;
      background: linear-gradient(90deg,
        var(--color-border-soft,#e0dbd3) 25%,
        var(--color-surface,#f4f1ea) 50%,
        var(--color-border-soft,#e0dbd3) 75%);
      background-size: 800px 100%;
      animation: fable-shimmer 1.4s ease-in-out infinite;
    }
    .skel-line--short { width: 60%; }
  `;

  let _injected = false;
  function _inject() {
    if (_injected) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    _injected = true;
  }

  /**
   * 그리드 컨테이너에 count개의 스켈레톤 카드를 삽입
   * @param {HTMLElement} grid
   * @param {number} count
   */
  function mount(grid, count = 8) {
    _inject();
    if (!grid) return;
    grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const card = document.createElement('div');
      card.className = 'skel-card';
      card.setAttribute('aria-hidden', 'true');
      const cover = document.createElement('div');
      cover.className = 'skel-cover';
      const line1 = document.createElement('div');
      line1.className = 'skel-line';
      const line2 = document.createElement('div');
      line2.className = 'skel-line skel-line--short';
      card.appendChild(cover);
      card.appendChild(line1);
      card.appendChild(line2);
      frag.appendChild(card);
    }
    grid.appendChild(frag);
  }

  /** 스켈레톤 카드 단일 생성 (virtual scroll 지연 로딩용) */
  function createCard() {
    _inject();
    const card = document.createElement('div');
    card.className = 'skel-card';
    card.setAttribute('aria-hidden', 'true');
    const cover = document.createElement('div');
    cover.className = 'skel-cover';
    const line1 = document.createElement('div');
    line1.className = 'skel-line';
    const line2 = document.createElement('div');
    line2.className = 'skel-line skel-line--short';
    card.appendChild(cover);
    card.appendChild(line1);
    card.appendChild(line2);
    return card;
  }

  return { mount, createCard };
})();

/* ══════════════════════════════════════════════════════════
   §2. HashWorker — Web Worker 해시 연산
   ══════════════════════════════════════════════════════════ */
const HashWorker = (() => {
  let worker = null, seq = 0;
  const pending = new Map();

  function _ensure() {
    if (worker) return;
    const code = `
      self.onmessage = function(e) {
        var id=e.data.id, name=e.data.name, size=e.data.size, sample=e.data.sample;
        var seed=name+'::'+size+'::'; var hash=5381;
        for(var i=0;i<seed.length;i++) hash=((hash<<5)+hash)+seed.charCodeAt(i);
        var bytes=new Uint8Array(sample);
        for(var j=0;j<bytes.length;j+=64) hash=((hash<<5)+hash)+bytes[j];
        self.postMessage({id:id,hash:'h'+(hash>>>0).toString(36)+'_'+size});
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

  function _fallback(file) {
    const seed = `${file.name}::${file.size}`;
    let hash = 5381;
    for (let i = 0; i < seed.length; i++) hash = ((hash << 5) + hash) + seed.charCodeAt(i);
    return `h${(hash >>> 0).toString(36)}_${file.size}`;
  }

  async function compute(file) {
    _ensure();
    if (!worker) return _fallback(file);
    try {
      const sample = await file.slice(0, 65536).arrayBuffer();
      return await new Promise(resolve => {
        const id = ++seq;
        pending.set(id, resolve);
        worker.postMessage({ id, name: file.name, size: file.size, sample }, [sample]);
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(_fallback(file)); } }, 3000);
      });
    } catch (_) { return _fallback(file); }
  }

  function destroy() { if (worker) { worker.terminate(); worker = null; } pending.clear(); }

  return { compute, destroy };
})();

/* ══════════════════════════════════════════════════════════
   §3. refreshLibraryData — 단일 트랜잭션 묶음 로드
   ══════════════════════════════════════════════════════════ */
async function refreshLibraryData() {
  const [books, folders, readingLog] = await Promise.all([
    StorageSystem.getAllBooks(),
    StorageSystem.getAllFolders(),
    StorageSystem.getReadingLog(),
  ]);
  const tagSet = new Set();
  books.forEach(b => (b.tags || []).forEach(t => tagSet.add(t)));

  /* 계층형 폴더 트리 구성 */
  const folderTree = _buildFolderTree(folders, books);

  ReactiveStore.patch({
    libraryBooks: books,
    folders,
    readingLog,
    allTags: [...tagSet].sort(),
    folderTree,
  });
}

/* ══════════════════════════════════════════════════════════
   §4. 폴더 트리 계층화 — 다중 서재 트리 구조
   ─────────────────────────────────────────────────────────
   folders 배열에 parentId 필드가 있으면 다단 트리로,
   없으면 단일 뎁스 평면 트리로 구성됩니다.
   결과: TreeNode[] = { folder, children[], bookCount }
   ══════════════════════════════════════════════════════════ */
function _buildFolderTree(folders, books) {
  const nodeMap = new Map();
  const roots   = [];

  /* 노드 초기화 */
  folders.forEach(f => {
    nodeMap.set(f.id, { folder: f, children: [], bookCount: 0 });
  });

  /* 도서 카운트 귀속 */
  books.forEach(b => {
    if (b.folderId && nodeMap.has(b.folderId)) {
      nodeMap.get(b.folderId).bookCount++;
    }
  });

  /* 트리 계층 연결 */
  folders.forEach(f => {
    const node = nodeMap.get(f.id);
    if (f.parentId && nodeMap.has(f.parentId)) {
      nodeMap.get(f.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  });

  return roots;
}

/* ══════════════════════════════════════════════════════════
   §5. 표지 노드 생성 헬퍼
   ══════════════════════════════════════════════════════════ */
function _buildCoverNode(book) {
  if (book.coverDataUrl) {
    const img = document.createElement('img');
    img.className = 'book-cover-img';
    img.src       = book.coverDataUrl;
    img.alt       = book.title || '표지';
    img.loading   = 'lazy';
    img.onerror   = () => img.replaceWith(_buildPlaceholder(book.title || ''));
    return img;
  }
  return _buildPlaceholder(book.title || '');
}

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

/* ══════════════════════════════════════════════════════════
   §6. 최근 읽은 책 렌더링
   ══════════════════════════════════════════════════════════ */
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
    const pct  = b.percent || 0;
    const item = document.createElement('div');
    item.className = 'recent-card';
    item.setAttribute('role', 'listitem');
    item.setAttribute('aria-label', `${b.title || '제목 없음'} 이어 읽기 (${pct}%)`);

    const cover = document.createElement('div');
    cover.className = 'recent-cover';
    cover.appendChild(_buildCoverNode(b));

    const info     = document.createElement('div');
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

/* ══════════════════════════════════════════════════════════
   §7. 폴더 칩 바 렌더링 — 계층 트리 + 흡입 D&D 애니메이션
   ─────────────────────────────────────────────────────────
   드래그한 카드를 폴더 칩 위에 올리면:
   1) 칩이 scale(1.08) + glow 효과로 하이라이트
   2) 드롭 완료 시 'suction' 키프레임(수축→소멸) 트리거
   ══════════════════════════════════════════════════════════ */

/* 흡입 애니메이션 CSS (단일 주입) */
const _DND_CSS = `
  @keyframes fable-suction {
    0%   { transform: scale(1.08); box-shadow: 0 0 0 3px var(--color-accent,#c47a3b); }
    60%  { transform: scale(0.92); box-shadow: 0 0 0 6px var(--color-accent,#c47a3b); }
    100% { transform: scale(1);    box-shadow: none; }
  }
  .folder-chip.drop-target {
    transform: scale(1.08);
    box-shadow: 0 0 0 2px var(--color-accent,#c47a3b), 0 4px 16px rgba(196,122,59,0.25);
    transition: transform 180ms ease, box-shadow 180ms ease;
  }
  .folder-chip.suction-flash {
    animation: fable-suction 380ms ease forwards;
  }
  /* 계층 트리 들여쓰기 */
  .folder-chip[data-depth="2"] { margin-left: 16px; font-size: 12px; }
  .folder-chip[data-depth="3"] { margin-left: 32px; font-size: 11px; }
`;
let _dndCSSInjected = false;
function _injectDnDCSS() {
  if (_dndCSSInjected) return;
  const style = document.createElement('style');
  style.textContent = _DND_CSS;
  document.head.appendChild(style);
  _dndCSSInjected = true;
}

function _buildFolderChip(f, cnt, depth = 1) {
  const chip = document.createElement('button');
  chip.className = 'folder-chip' + (store.activeFolderId === f.id ? ' active' : '');
  chip.setAttribute('role', 'tab');
  chip.setAttribute('aria-selected', String(store.activeFolderId === f.id));
  chip.dataset.folderId = f.id;
  chip.dataset.depth    = String(depth);

  const icon    = depth === 1 ? '📁' : '📂';
  const label   = document.createElement('span');
  label.textContent = `${icon} ${f.name} (${cnt})`;
  chip.appendChild(label);

  /* 폴더 삭제 버튼 */
  const del = document.createElement('span');
  del.className = 'folder-chip-del';
  del.textContent = '✕';
  del.setAttribute('role', 'button');
  del.setAttribute('aria-label', `${f.name} 폴더 삭제`);
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    const warn = '이 폴더를 삭제하면 폴더 안의 모든 도서와 독서 퍼센트 기록, 하이라이트가 영구적으로 함께 삭제됩니다. 정말 삭제하시겠습니까?';
    if (confirm(warn)) {
      StorageSystem.deleteFolder(f.id).then(async (result) => {
        if (store.activeFolderId === f.id) store.activeFolderId = null;
        const [books, folders] = await Promise.all([
          StorageSystem.getAllBooks(), StorageSystem.getAllFolders(),
        ]);
        ReactiveStore.patch({ libraryBooks: books, folders });
        const n = result?.deletedBooks || 0;
        Toast.show(n > 0 ? `폴더와 도서 ${n}권이 삭제되었습니다.` : '폴더가 삭제되었습니다.', 'success');
      });
    }
  });
  chip.appendChild(del);

  chip.addEventListener('click', () => { store.activeFolderId = f.id; });

  /* ── 드롭 타깃 이벤트 (흡입 애니메이션 포함) ── */
  chip.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/fable-book')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      chip.classList.add('drop-target');
    }
  });
  chip.addEventListener('dragleave', (e) => {
    /* 자식 요소로의 이동 시 오탐 방지 */
    if (!chip.contains(e.relatedTarget)) chip.classList.remove('drop-target');
  });
  chip.addEventListener('drop', async (e) => {
    e.preventDefault();
    chip.classList.remove('drop-target');
    const bookKey = e.dataTransfer.getData('text/fable-book');
    if (!bookKey) return;

    /* 흡입 애니메이션 트리거 */
    chip.classList.add('suction-flash');
    chip.addEventListener('animationend', () => chip.classList.remove('suction-flash'), { once: true });

    await StorageSystem.setBookFolder(bookKey, f.id);
    await refreshLibraryData();
    Toast.show(`'${f.name}'(으)로 이동했습니다.`, 'success');
  });

  return chip;
}

/**
 * 폴더 트리를 재귀적으로 칩 배열로 변환
 * @param {TreeNode[]} nodes
 * @param {number} depth
 * @param {DocumentFragment} frag
 */
function _appendTreeNodes(nodes, depth, frag) {
  nodes.forEach(node => {
    const chip = _buildFolderChip(node.folder, node.bookCount, depth);
    frag.appendChild(chip);
    /* 자식 폴더 재귀 렌더 */
    if (node.children.length) {
      _appendTreeNodes(node.children, depth + 1, frag);
    }
  });
}

function renderFolderBar(folders, books) {
  _injectDnDCSS();
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

  /* 드롭 타깃: 폴더에서 빼기 */
  allChip.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/fable-book')) { e.preventDefault(); allChip.classList.add('drop-target'); }
  });
  allChip.addEventListener('dragleave', (e) => {
    if (!allChip.contains(e.relatedTarget)) allChip.classList.remove('drop-target');
  });
  allChip.addEventListener('drop', async (e) => {
    e.preventDefault();
    allChip.classList.remove('drop-target');
    allChip.classList.add('suction-flash');
    allChip.addEventListener('animationend', () => allChip.classList.remove('suction-flash'), { once: true });
    const bookKey = e.dataTransfer.getData('text/fable-book');
    if (!bookKey) return;
    await StorageSystem.setBookFolder(bookKey, null);
    await refreshLibraryData();
    Toast.show('폴더에서 제외했습니다.', 'success');
  });

  /* 계층 트리 폴더 칩 렌더 */
  const folderTree = store.folderTree || _buildFolderTree(folders, books);
  _appendTreeNodes(folderTree, 1, frag);

  /* 폴더 생성 버튼 */
  const addChip = document.createElement('button');
  addChip.className = 'folder-chip folder-chip--add';
  addChip.textContent = '+ 폴더';
  addChip.setAttribute('aria-label', '새 폴더 생성');
  addChip.addEventListener('click', createFolderPrompt);
  frag.appendChild(addChip);

  bar.appendChild(frag);
}

function createFolderPrompt(parentId = null) {
  const name = prompt('새 폴더 이름을 입력하세요:');
  if (!name || !name.trim()) return;
  const folder = {
    id:       'folder_' + Date.now().toString(36),
    name:     name.trim().slice(0, 30),
    parentId: parentId,   /* 계층 구조 지원 */
    ts:       Date.now(),
  };
  StorageSystem.saveFolder(folder).then(async () => {
    await refreshLibraryData();
    Toast.show(`'${folder.name}' 폴더가 생성되었습니다.`, 'success');
  });
}

/* ══════════════════════════════════════════════════════════
   §8. 카드 메뉴 (폴더 지정 + 태그 + 메타편집 + 삭제)
   ══════════════════════════════════════════════════════════ */
function _showCardMenu(book, anchorEl) {
  document.querySelectorAll('.card-menu-popup').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'card-menu-popup';
  menu.setAttribute('role', 'menu');

  /* 폴더 이동 헤더 */
  const head = document.createElement('div');
  head.className = 'card-menu-head';
  head.textContent = '폴더로 이동';
  menu.appendChild(head);

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

  /* 태그 편집 */
  const tagItem = document.createElement('button');
  tagItem.className = 'card-menu-item';
  tagItem.setAttribute('role', 'menuitem');
  tagItem.textContent = '🏷 태그 편집';
  tagItem.addEventListener('click', async (e) => {
    e.stopPropagation();
    menu.remove();
    const cur   = (book.tags || []).join(', ');
    const input = prompt('태그를 쉼표(,)로 구분해 입력하세요:', cur);
    if (input === null) return;
    const tags = [...new Set(input.split(',').map(t => t.trim()).filter(Boolean).map(t => t.slice(0, 20)))].slice(0, 8);
    await StorageSystem.updateBookTags(book.bookKey, tags);
    await refreshLibraryData();
    Toast.show('태그가 저장되었습니다.', 'success');
  });
  menu.appendChild(tagItem);

  /* 메타데이터 편집 */
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

  /* 메모/하이라이트 내보내기 */
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
    if (confirm('이 도서를 삭제하면 독서 기록과 하이라이트·메모가 함께 영구 삭제됩니다. 삭제하시겠습니까?')) {
      StorageSystem.deleteBook(book.bookKey).then(async () => {
        await refreshLibraryData();
        Toast.show('도서와 관련 기록이 삭제되었습니다.', 'success');
      });
    }
  });
  menu.appendChild(delItem);

  document.body.appendChild(menu);

  /* 위치 결정 (뷰포트 오버플로우 방지) */
  const rect = anchorEl.getBoundingClientRect();
  let left = rect.left, top = rect.bottom + 6;
  const mw = 200, mh = menu.offsetHeight || 280;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = rect.top - mh - 6;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top  = `${Math.max(8, top)}px`;

  const closeHandler = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', closeHandler); }
  };
  setTimeout(() => document.addEventListener('pointerdown', closeHandler), 10);
}

/* ══════════════════════════════════════════════════════════
   §9. 독서 분석 대시보드
   ══════════════════════════════════════════════════════════ */
function renderAnalyticsDashboard(books, readingLog) {
  const wrap = DOMProxy.get('dashboard-section');
  if (!DOMProxy.exists('dashboard-section')) return;

  const days  = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const rec = readingLog[key];
    const sec = typeof rec === 'number' ? rec : (rec?.seconds || 0);
    days.push({ key, label: ['일','월','화','수','목','금','토'][d.getDay()], sec });
  }
  const maxSec   = Math.max(60, ...days.map(d => d.sec));
  const todaySec = days[days.length - 1].sec;
  const goalSec  = (store.dailyGoalMin || 30) * 60;
  const goalPct  = Math.min(100, Math.round((todaySec / goalSec) * 100));
  const weekSec  = days.reduce((s, d) => s + d.sec, 0);
  const weekMin  = Math.round(weekSec / 60);

  const inProgress = books.filter(b => (b.percent || 0) > 0 && (b.percent || 0) < 100);
  const avgPct = inProgress.length
    ? Math.round(inProgress.reduce((s, b) => s + b.percent, 0) / inProgress.length)
    : 0;

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
   §10. 태그 다중 필터 바
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
    const cnt  = books.filter(b => (b.tags || []).includes(t)).length;
    const chip = document.createElement('button');
    const active = store.activeTags.includes(t);
    chip.className = 'tag-chip' + (active ? ' active' : '');
    chip.textContent = `#${t} ${cnt}`;
    chip.setAttribute('aria-pressed', String(active));

    /* 태그 칩도 드롭 타깃으로 연동 */
    chip.setAttribute('draggable', 'false');
    chip.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('text/fable-book')) {
        e.preventDefault();
        chip.classList.add('drop-target');
      }
    });
    chip.addEventListener('dragleave', (e) => {
      if (!chip.contains(e.relatedTarget)) chip.classList.remove('drop-target');
    });
    chip.addEventListener('drop', async (e) => {
      e.preventDefault();
      chip.classList.remove('drop-target');
      chip.classList.add('suction-flash');
      chip.addEventListener('animationend', () => chip.classList.remove('suction-flash'), { once: true });
      const bookKey = e.dataTransfer.getData('text/fable-book');
      if (!bookKey) return;
      const book = (store.libraryBooks || []).find(b => b.bookKey === bookKey);
      if (!book) return;
      const newTags = [...new Set([...(book.tags || []), t])];
      await StorageSystem.updateBookTags(bookKey, newTags);
      await refreshLibraryData();
      Toast.show(`'#${t}' 태그가 추가되었습니다.`, 'success');
    });

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

/* ══════════════════════════════════════════════════════════
   §11. 가상 청크 그리드 렌더러 (Virtual Scroll)
   ─────────────────────────────────────────────────────────
   1000권+ 서재에서도 화면에 보이는 행(Row)만 DOM에 마운트하여
   메모리와 렌더링 오버헤드를 최소화합니다.

   알고리즘:
   ① 컨테이너 크기와 카드 크기를 기반으로 columns / rowH 계산
   ② 전체 높이를 spacer div로 예약하여 스크롤바 정확도 유지
   ③ IntersectionObserver + scroll event 이중 감시로
      뷰포트 진입 행(row) 단위 DOM 마운트 / 이탈 행 언마운트
   ══════════════════════════════════════════════════════════ */
const VirtualGridRenderer = (() => {
  const CARD_MIN_W = 120; /* 카드 최소 너비(px) */
  const CARD_GAP   = 12;  /* 그리드 gap(px) */
  const CARD_H     = 200; /* 카드 추정 높이(px) */
  const OVERSCAN   = 2;   /* 뷰포트 위/아래 여분 행 수 */

  let _state = null; /* { books, cols, rowH, rowCount, container, spacer, pool, rows, scrollParent } */

  function _clear() {
    if (!_state) return;
    _state.container.innerHTML = '';
    if (_state.scrollParent) _state.scrollParent.removeEventListener('scroll', _onScroll);
    _state = null;
  }

  /**
   * 그리드를 초기화하고 가상 스크롤 시작
   * @param {HTMLElement} container
   * @param {Object[]} books
   * @param {Function} cardBuilder  (book) => HTMLElement
   */
  function render(container, books, cardBuilder) {
    _clear();
    if (!container || !books.length) return;

    /* 스켈레톤 노출 → 실제 카드 교체 */
    SkeletonUI.mount(container, Math.min(books.length, 12));

    /* 레이아웃 계산 */
    const cw   = container.clientWidth || 320;
    const cols = Math.max(1, Math.floor((cw + CARD_GAP) / (CARD_MIN_W + CARD_GAP)));
    const rowH = CARD_H + CARD_GAP;
    const rowCount = Math.ceil(books.length / cols);

    /* 전체 높이를 spacer로 예약 */
    container.innerHTML = '';
    container.style.position = 'relative';
    container.style.overflowY = 'hidden'; /* 외부 스크롤 컨테이너 사용 */

    const spacer = document.createElement('div');
    spacer.style.cssText = `position:absolute;top:0;left:0;width:1px;height:${rowCount * rowH}px;pointer-events:none;`;
    container.appendChild(spacer);

    /* 행 레이어 래퍼 */
    const rows = new Map(); /* rowIndex → { el, books[] } */
    const pool = [];        /* 재사용 행 요소 풀 */

    _state = { books, cols, rowH, rowCount, container, spacer, pool, rows, cardBuilder, scrollParent: null };

    /* 스크롤 부모 탐색 (overflow-y:auto 또는 body) */
    let sp = container.parentElement;
    while (sp && sp !== document.body) {
      const os = getComputedStyle(sp).overflowY;
      if (os === 'auto' || os === 'scroll') break;
      sp = sp.parentElement;
    }
    _state.scrollParent = sp || window;
    _state.scrollParent.addEventListener('scroll', _onScroll, { passive: true });

    /* 초기 렌더 */
    requestAnimationFrame(_syncRows);
  }

  /** 현재 뷰포트에 보여야 할 행 범위 계산 */
  function _visibleRowRange() {
    if (!_state) return { start: 0, end: 0 };
    const { container, rowH, rowCount, scrollParent } = _state;
    const rect = container.getBoundingClientRect();
    const vTop = scrollParent === window
      ? window.scrollY
      : (scrollParent.scrollTop || 0);
    const vH   = scrollParent === window ? window.innerHeight : scrollParent.clientHeight;

    const containerTop = rect.top + (scrollParent === window ? window.scrollY : scrollParent.scrollTop);
    const relTop  = vTop - containerTop;
    const startRow = Math.max(0, Math.floor(relTop / rowH) - OVERSCAN);
    const endRow   = Math.min(_state.rowCount - 1, Math.ceil((relTop + vH) / rowH) + OVERSCAN);
    return { start: startRow, end: endRow };
  }

  /** 행 DOM 마운트 / 언마운트 동기화 */
  function _syncRows() {
    if (!_state) return;
    const { start, end } = _visibleRowRange();
    const { books, cols, rowH, container, rows, pool, cardBuilder } = _state;

    /* 범위 밖 행 언마운트 → 풀로 반납 */
    rows.forEach((rowObj, rIdx) => {
      if (rIdx < start || rIdx > end) {
        rowObj.el.remove();
        pool.push(rowObj.el);
        rows.delete(rIdx);
      }
    });

    /* 범위 내 행 마운트 */
    for (let r = start; r <= end; r++) {
      if (rows.has(r)) continue;

      const rowEl = pool.pop() || _createRowEl();
      rowEl.style.top    = `${r * rowH}px`;
      rowEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      rowEl.innerHTML    = ''; /* 재사용 초기화 */

      const startIdx = r * cols;
      const endIdx   = Math.min(startIdx + cols, books.length);
      for (let i = startIdx; i < endIdx; i++) {
        rowEl.appendChild(cardBuilder(books[i]));
      }

      container.appendChild(rowEl);
      rows.set(r, { el: rowEl });
    }
  }

  function _createRowEl() {
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;left:0;right:0;display:grid;gap:${CARD_GAP}px;`;
    return el;
  }

  const _onScroll = () => requestAnimationFrame(_syncRows);

  function destroy() { _clear(); }

  return { render, destroy };
})();

/* ══════════════════════════════════════════════════════════
   §12. 개별 도서 카드 빌더 (D&D 소스 + 스켈레톤 to 실제 카드)
   ══════════════════════════════════════════════════════════ */
function _buildBookCard(b) {
  _injectDnDCSS();
  const fullTitle = b.title || '제목 없음';
  const pct       = b.percent || 0;

  const card = document.createElement('div');
  card.className = 'book-card';
  card.setAttribute('role', 'listitem');
  card.setAttribute('aria-label', `${fullTitle} 열기 (${pct}% 읽음)`);
  card.draggable = true;
  card.dataset.bookKey = b.bookKey;

  /* 드래그 시작 */
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/fable-book', b.bookKey);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  const coverWrap = document.createElement('div');
  coverWrap.className = 'book-cover-wrap';
  coverWrap.dataset.tooltip = fullTitle;

  /* 스켈레톤 → 실제 표지 교체 패턴 */
  const skel = SkeletonUI.createCard();
  coverWrap.appendChild(skel);

  /* 비동기적으로 실제 표지 노드 교체 (rAF 큐 활용) */
  requestAnimationFrame(() => {
    const coverNode = _buildCoverNode(b);
    if (skel.parentNode === coverWrap) skel.replaceWith(coverNode);
    else coverWrap.insertBefore(coverNode, coverWrap.firstChild);
  });

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
   §13. renderLibraryGrid — Virtual Scroll 통합 진입점
   ─────────────────────────────────────────────────────────
   [AbortController 뮤텍스] 연속 폴더/태그 클릭 시 이전 렌더 중단
   [VirtualGridRenderer]    1000권+ 시 뷰포트 기반 마운트/언마운트
   ══════════════════════════════════════════════════════════ */
let _gridRenderController = null;

function renderLibraryGrid() {
  const grid  = DOMProxy.get('library-grid');
  const empty = DOMProxy.get('library-empty');
  const count = DOMProxy.get('library-count');
  if (!DOMProxy.exists('library-grid')) return;

  /* AbortController 뮤텍스 */
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

  if (store.activeFolderId !== null) books = books.filter(b => b.folderId === store.activeFolderId);
  if (store.activeTags.length) books = books.filter(b => store.activeTags.every(t => (b.tags || []).includes(t)));

  const q = (store.librarySearch || '').trim().toLowerCase();
  if (q) books = books.filter(b =>
    (b.title || '').toLowerCase().includes(q) || (b.creator || '').toLowerCase().includes(q)
  );

  switch (store.sortMode) {
    case 'title':    books.sort((a, b) => (a.title || '').localeCompare(b.title || '')); break;
    case 'progress': books.sort((a, b) => (b.percent || 0) - (a.percent || 0)); break;
    case 'added':    books.sort((a, b) => (b.seq || 0) - (a.seq || 0)); break;
    case 'recent': default: books.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0)); break;
  }

  if (signal.aborted) return;
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

  /* 1000권 이상이거나 모바일 환경: Virtual Scroll 사용 */
  const USE_VIRTUAL = books.length >= 50;

  if (USE_VIRTUAL) {
    /* 스켈레톤 즉시 표시 후 Virtual Grid 초기화 */
    SkeletonUI.mount(grid, Math.min(books.length, 12));
    /* rAF 큐에서 실제 Virtual Scroll 부착 */
    requestAnimationFrame(() => {
      if (signal.aborted) return;
      VirtualGridRenderer.render(grid, books, _buildBookCard);
    });
  } else {
    /* 소규모 서재: 기존 청크 렌더 (빠름) */
    const frag  = document.createDocumentFragment();
    const CHUNK = 24;
    let idx = 0;

    function renderChunk() {
      if (signal.aborted) return;
      const end = Math.min(idx + CHUNK, books.length);
      for (; idx < end; idx++) frag.appendChild(_buildBookCard(books[idx]));
      if (idx < books.length) {
        requestAnimationFrame(renderChunk);
      } else {
        if (!signal.aborted) grid.appendChild(frag);
      }
    }

    SkeletonUI.mount(grid, Math.min(books.length, 8));
    requestAnimationFrame(() => {
      if (!signal.aborted) { grid.innerHTML = ''; renderChunk(); }
    });
  }
}

/* ══════════════════════════════════════════════════════════
   §14. 다중 파일 순차 등록 파이프라인
   ══════════════════════════════════════════════════════════ */
async function importEpubFiles(files) {
  if (!files || files.length === 0) return;

  const epubReady = await waitForEpubJS();
  if (!epubReady) {
    Toast.show('EPUB 엔진(epub.js/JSZip)을 로드하지 못했습니다. 네트워크 확인 후 새로고침해 주세요.', 'error');
    return;
  }

  const fileArr = Array.from(files);
  const total   = fileArr.length;

  /* 진행률 표시는 ImportProgress 유틸 사용 (store.js import 외부 처리 가정) */
  try { store.importProgressVisible = true; store.importProgressLabel = `0 / ${total} 도서 추가 중...`; } catch (_) {}

  let successCount = 0, dupCount = 0;
  const batch = [];

  for (let i = 0; i < fileArr.length; i++) {
    const file = fileArr[i];

    if (!file.name.toLowerCase().endsWith('.epub')) {
      Toast.show(`${file.name}: EPUB 파일이 아닙니다.`, 'error');
      continue;
    }

    const fileHash = await HashWorker.compute(file);
    const existing = await StorageSystem.findBookByHash(fileHash);
    if (existing) { dupCount++; continue; }
    if (batch.some(r => r.fileHash === fileHash)) { dupCount++; continue; }

    try {
      store.importProgressLabel = `${i + 1} / ${total} — ${file.name.slice(0, 20)}`;
    } catch (_) {}

    await ErrorBoundary.wrap('renderer', async () => {
      const buf  = await file.arrayBuffer();
      const book = window.ePub(buf.slice(0));
      const ok   = await awaitBookReady(book, 12000);
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

    await new Promise(r => setTimeout(r, 0));
  }

  if (batch.length) {
    await ErrorBoundary.wrap('storage', () => StorageSystem.batchSaveBooks(batch))();
  }

  try { store.importProgressVisible = false; } catch (_) {}
  await refreshLibraryData();

  let msg = '';
  if (successCount > 0) msg += `${successCount}권 추가`;
  if (dupCount > 0)     msg += `${msg ? ', ' : ''}중복 ${dupCount}권 제외`;
  if (msg) Toast.show(msg + ' 완료', 'success');
}

/* ══════════════════════════════════════════════════════════
   Exports
   ══════════════════════════════════════════════════════════ */
export {
  computeFileHash,
  HashWorker,
  SkeletonUI,
  VirtualGridRenderer,
  refreshLibraryData,
  renderRecentBooks,
  renderFolderBar,
  createFolderPrompt,
  renderAnalyticsDashboard,
  renderTagBar,
  renderLibraryGrid,
  importEpubFiles,
};

/* computeFileHash 폴백 export (외부 참조 호환) */
function computeFileHash(file) {
  const seed = `${file.name}::${file.size}`;
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) + hash) + seed.charCodeAt(i);
  return `h${(hash >>> 0).toString(36)}_${file.size}`;
}
