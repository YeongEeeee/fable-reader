/**
 * src/ui/uploader.js  ── Fable Premium v5.0
 * ─────────────────────────────────────────────────────────────────
 * 서재(Dashboard) 대개혁 — 태그 인프라, 스마트 폴더, 모바일 임포터,
 * 독서 리포트 HUD, 컴팩트 리스트 뷰, Flip 애니메이션 통합 고도화
 *
 * v5.0 신규 사항:
 *   [❶] 서재 레이아웃 3단 재배치 (스마트 태그 폴더 → 최근 읽은 책 → 도서 그리드)
 *   [❶] ReadingReport HUD 컴포넌트 서재 하단 이관 + showDashboardReport 토글 연동
 *   [❷] 사전 정의 장르 태그 시스템 (GENRE_TAGS 상수) + 컨텍스트 팝업 태그 선택기
 *   [❷] 드래그&드롭 태그 바인딩 (Desktop) + 태그 컬러 브랜딩
 *   [❸] 모바일 다중 파일 임포트 Bridge (<input multiple> 파이프라인)
 *   [파일시스템] EPUB opf dc:subject 자동 태깅 큐
 *   [파일시스템] 컴팩트 리스트 뷰 전환 토글
 *   [파일시스템] 오프라인 인덱서 강화 (IndexedDB 단독 쿼리)
 *   [파일시스템] 서재 진입 시 GC(releaseAll) 트리거
 *   [비주얼]    세피아 그라디언트 스켈레톤 웨이브
 *   [비주얼]    태그 팝업 글래스모피즘 팝오버
 *   [비주얼]    목표 달성 앰버 파티클 세레머니
 *   [비주얼]    최근 읽은 책 '이어읽기' 플로팅 카드 슬라이드인
 *   [비주얼]    태그 필터링 Flip CSS Grid 트랜지션
 *
 * 보존된 스펙:
 *   HashWorker, refreshLibraryData, 표지/HSL 플레이스홀더,
 *   폴더 바 D&D, 분석 대시보드, 도서 카드 메뉴,
 *   AbortController 그리드 렌더 뮤텍스, VirtualGridRenderer
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

import {
  store, ReactiveStore, DOMProxy, ErrorBoundary, Toast,
  setTextSafe, RECENT_MAX, ResourceRegistry,
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

/**
 * [v5.0 신규] LRU 본문 바이너리 무력화(database.js의
 * reapLeastRecentlyUsedBinaries) 가드 — 도서 카드/리스트의 모든 진입점
 * (썸네일 카드, 컴팩트 리스트, 최근 읽은 책)에서 책을 열기 전에 호출한다.
 * b.binaryEvicted === true 이거나 b.bytes가 비어있으면(용량 확보를 위해
 * 본문이 정리된 스텁 레코드) openEpubBook을 호출하지 않고 사용자에게
 * 재임포트를 안내하는 토스트만 표시한다. 정상 레코드는 그대로 통과시켜
 * 기존 동작을 보존한다.
 */
function _openBookGuarded(b) {
  if (!b) return;
  if (b.binaryEvicted || !b.bytes) {
    Toast.show(
      `'${b.title || '이 책'}'은 저장 공간 확보를 위해 본문이 정리되었습니다. 파일을 다시 추가해 주세요.`,
      'info',
    );
    return;
  }
  openEpubBook(b.bytes, true);
}

/** 사전 정의 장르 태그 및 컬러 브랜딩 */
/*
 * [버그 수정 — D-4] 장르 태그 칩 컬러 브랜딩 가시성 보정
 * ─────────────────────────────────────────────────────────────
 * 기존 색상은 라이트 테마 페이지 배경(#fcfbf7) 위 비활성 칩
 * (color-on-tint)과 활성 칩(흰색-on-saturated-color) 양쪽 모두에서
 * WCAG 2.1 AA 명도 대비(4.5:1)를 충족하지 못했다(실측 2.6~4.2:1).
 * 각 색상의 색조(hue)는 보존한 채 명도(lightness)만 조정하여 두
 * 상태 모두 4.5:1 이상을 만족하도록 재계산했다. 다크 테마에서는
 * 동일한 색상이 어두운 배경(#1a1a1e) 위에서 다시 대비 실패를
 * 일으키므로, _getTagColor()가 store.theme을 참조해 다크 모드일
 * 때는 더 밝은 변형(라이트 모드와 동일 hue, 상향 보정된 lightness)을
 * 반환하도록 분기한다.
 */
export const GENRE_TAGS = [
  { name: '판타지',    color: '#7264c9', bg: 'rgba(114,100,201,0.12)' },
  { name: '로맨스',    color: '#ba5076', bg: 'rgba(186,80,118,0.12)'  },
  { name: '무협',      color: '#906b3c', bg: 'rgba(144,107,60,0.12)'  },
  { name: 'SF/미스터리', color: '#3f7b97', bg: 'rgba(63,123,151,0.12)'  },
  { name: '현대판타지', color: '#467d57', bg: 'rgba(70,125,87,0.12)'   },
  { name: '일반소설',  color: '#7e7061', bg: 'rgba(126,112,97,0.12)'  },
];

/* 다크 테마용 — 동일 hue, 어두운 배경(#1a1a1e) 대비 4.5:1 이상을
   만족하도록 밝기를 끌어올린 변형. 활성 상태에서는 검정 텍스트를
   사용해 대비를 확보한다(흰 텍스트는 이 밝기에서 대비가 부족하다). */
const GENRE_TAGS_DARK = {
  '판타지':    '#8478d0',
  '로맨스':    '#c66e8d',
  '무협':      '#b4864c',
  'SF/미스터리': '#4c92b4',
  '현대판타지':  '#6ead81',
  '일반소설':   '#91806f',
};

/** 장르 태그 이름 → 컬러 맵 (라이트 테마 기준) */
const _TAG_COLOR_MAP = Object.fromEntries(GENRE_TAGS.map(g => [g.name, { color: g.color, bg: g.bg }]));

function _getTagColor(tagName) {
  const isDark = store.theme === 'dark';

  if (_TAG_COLOR_MAP[tagName]) {
    if (!isDark) return _TAG_COLOR_MAP[tagName];
    const darkColor = GENRE_TAGS_DARK[tagName] || _TAG_COLOR_MAP[tagName].color;
    return { color: darkColor, bg: _hexToRgba(darkColor, 0.16), darkActiveText: '#1a1814' };
  }

  /* 커스텀 태그: 이름 해시로 세피아 앰버 계열 생성. 라이트/다크 모두
     4.5:1 대비를 만족하도록 명도(L)를 모드별로 분리 계산한다. */
  let h = 0;
  for (let i = 0; i < tagName.length; i++) h = (h * 31 + tagName.charCodeAt(i)) & 0xffffff;
  const hue = 25 + (h % 30); /* 앰버-세피아 범위 (25°~55°) */
  const light = isDark ? 68 : 38; /* 다크 모드는 밝게, 라이트 모드는 어둡게 */
  const color = `hsl(${hue}, 55%, ${light}%)`;
  return {
    color,
    bg: `hsla(${hue}, 55%, ${light}%, ${isDark ? 0.18 : 0.12})`,
    darkActiveText: isDark ? '#1a1814' : undefined,
  };
}

function _hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function truncateTitle(title) {
  if (!title) return '제목 없음';
  return title.length > TITLE_MAX_LEN ? title.slice(0, TITLE_MAX_LEN) + '…' : title;
}

function _titleToHue(title) {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) & 0xffffff;
  return h % 360;
}

/* ── 장르 자동 태깅 정규식 맵 ── */
const _GENRE_PATTERNS = [
  { tag: '판타지',    re: /판타지|fantasy|ファンタジー/i },
  { tag: '로맨스',    re: /로맨스|romance|연애/i },
  { tag: '무협',      re: /무협|martial|武俠/i },
  { tag: 'SF/미스터리', re: /sf|sci[- ]fi|미스터리|mystery|스릴러|thriller|공상과학/i },
  { tag: '현대판타지', re: /현대\s*판타지|modern\s*fantasy/i },
  { tag: '일반소설',  re: /소설|novel|문학|literature/i },
];

/** opf 메타데이터 subject 문자열에서 장르 태그 자동 추출 */
function _detectGenreTags(subjectStr) {
  if (!subjectStr) return [];
  const matched = [];
  for (const { tag, re } of _GENRE_PATTERNS) {
    if (re.test(subjectStr)) matched.push(tag);
  }
  return [...new Set(matched)];
}

/* ── 전역 상태 초기화 가드 ── */
function _ensureSystemTags() {
  const stored = store.allTags || [];
  const genreNames = GENRE_TAGS.map(g => g.name);
  const merged = [...new Set([...genreNames, ...stored])];
  if (merged.length !== stored.length) {
    store.allTags = merged;
  }
}

/* ══════════════════════════════════════════════════════════
   §1. 스켈레톤 UI — 세피아 앰버 웨이브 펄스
   ══════════════════════════════════════════════════════════ */
const SkeletonUI = (() => {
  const CSS = `
    @keyframes fable-sepia-wave {
      0%   { background-position: -600px 0; }
      100% { background-position:  600px 0; }
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
      background: linear-gradient(
        105deg,
        #e8e0d0 0%,
        #d4c8b0 20%,
        #f0e8d8 40%,
        #e2c89a 60%,
        #d4c8b0 80%,
        #e8e0d0 100%
      );
      background-size: 1200px 100%;
      animation: fable-sepia-wave 2s cubic-bezier(0.4,0,0.6,1) infinite;
    }
    [data-theme="dark"] .skel-cover {
      background: linear-gradient(
        105deg,
        #2a2218 0%,
        #3a3028 20%,
        #2e2820 40%,
        #3e3222 60%,
        #3a3028 80%,
        #2a2218 100%
      );
      background-size: 1200px 100%;
    }
    .skel-line {
      height: 10px;
      border-radius: 4px;
      background: linear-gradient(
        105deg,
        #e8e0d0 0%, #f0e8d8 40%, #e2c89a 60%, #e8e0d0 100%
      );
      background-size: 1200px 100%;
      animation: fable-sepia-wave 2s cubic-bezier(0.4,0,0.6,1) infinite 0.1s;
    }
    .skel-line--short { width: 60%; }

    /* 컴팩트 리스트뷰 스켈레톤 */
    .skel-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 0;
      border-bottom: 1px solid rgba(120,100,80,0.08);
    }
    .skel-row-thumb {
      width: 44px;
      height: 62px;
      border-radius: 4px;
      flex-shrink: 0;
      background: linear-gradient(
        105deg,
        #e8e0d0 0%, #f0e8d8 40%, #e2c89a 60%, #e8e0d0 100%
      );
      background-size: 1200px 100%;
      animation: fable-sepia-wave 2s ease-in-out infinite;
    }
    .skel-row-content { flex: 1; display: flex; flex-direction: column; gap: 6px; }
  `;

  let _injected = false;
  function _inject() {
    if (_injected) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    _injected = true;
  }

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
      card.append(cover, line1, line2);
      frag.appendChild(card);
    }
    grid.appendChild(frag);
  }

  function mountList(container, count = 8) {
    _inject();
    if (!container) return;
    container.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
      const row = document.createElement('div');
      row.className = 'skel-row';
      row.setAttribute('aria-hidden', 'true');
      const thumb = document.createElement('div');
      thumb.className = 'skel-row-thumb';
      const content = document.createElement('div');
      content.className = 'skel-row-content';
      const l1 = document.createElement('div');
      l1.className = 'skel-line';
      const l2 = document.createElement('div');
      l2.className = 'skel-line skel-line--short';
      content.append(l1, l2);
      row.append(thumb, content);
      frag.appendChild(row);
    }
    container.appendChild(frag);
  }

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
    card.append(cover, line1, line2);
    return card;
  }

  return { mount, mountList, createCard };
})();

/* ══════════════════════════════════════════════════════════
   §2. HashWorker — Web Worker 해시 + EPUB opf 파서
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

  /* 장르 태그 + 사용자 태그 합산 */
  const tagSet = new Set(GENRE_TAGS.map(g => g.name));
  books.forEach(b => (b.tags || []).forEach(t => tagSet.add(t)));
  /* store.tags(설정 패널 커스텀 태그)도 포함 */
  (store.tags || []).forEach(t => tagSet.add(t));

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
   §4. 폴더 트리 계층화
   ══════════════════════════════════════════════════════════ */
function _buildFolderTree(folders, books) {
  const nodeMap = new Map();
  const roots   = [];

  folders.forEach(f => {
    nodeMap.set(f.id, { folder: f, children: [], bookCount: 0 });
  });

  books.forEach(b => {
    if (b.folderId && nodeMap.has(b.folderId)) {
      nodeMap.get(b.folderId).bookCount++;
    }
  });

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
   §6. 최근 읽은 책 '이어읽기' 플로팅 카드 (슬라이드인 애니메이션)
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
  recent.forEach((b, idx) => {
    const pct  = b.percent || 0;
    const item = document.createElement('div');
    item.className = 'recent-card';
    item.setAttribute('role', 'listitem');
    item.setAttribute('aria-label', `${b.title || '제목 없음'} 이어 읽기 (${pct}%)`);
    /* 슬라이드인 애니메이션 딜레이 (카드별 스태거) */
    item.style.animationDelay = `${idx * 60}ms`;
    item.classList.add('recent-card--slide-in');

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

    /* [이어서 몰입하기] 버튼 */
    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'recent-resume-btn';
    resumeBtn.textContent = '이어서 몰입하기 →';
    resumeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _openBookGuarded(b);
    });

    info.append(titleEl, progWrap, pctText, resumeBtn);
    item.append(cover, info);
    item.addEventListener('click', () => _openBookGuarded(b));
    frag.appendChild(item);
  });
  row.appendChild(frag);
}

/* ══════════════════════════════════════════════════════════
   §7. 폴더 칩 바 렌더링 — 계층 트리 + 흡입 D&D
   ══════════════════════════════════════════════════════════ */
const _DND_CSS = `
  @keyframes fable-suction {
    0%   { transform: scale(1.08); box-shadow: 0 0 0 3px var(--color-accent,#c47a3b); }
    60%  { transform: scale(0.92); box-shadow: 0 0 0 6px var(--color-accent,#c47a3b); }
    100% { transform: scale(1);    box-shadow: none; }
  }
  /* 최근 읽은 책 슬라이드인 */
  @keyframes fable-slide-in-up {
    from { opacity: 0; transform: translateY(18px); }
    to   { opacity: 1; transform: translateY(0);    }
  }
  .recent-card--slide-in {
    animation: fable-slide-in-up 0.38s cubic-bezier(0.34,1.32,0.64,1) both;
  }
  /* 태그 필터 Flip 트랜지션 */
  @keyframes fable-card-flip-in {
    from { opacity: 0; transform: scale(0.92) translateY(8px); }
    to   { opacity: 1; transform: scale(1)    translateY(0);   }
  }
  .book-card--flip-enter {
    animation: fable-card-flip-in 0.28s cubic-bezier(0.34,1.2,0.64,1) both;
  }
  /* 목표 달성 앰버 파티클 */
  @keyframes fable-particle-burst {
    0%   { opacity: 1; transform: translateY(0)     scale(1);   }
    60%  { opacity: 0.7; transform: translateY(-28px) scale(1.2); }
    100% { opacity: 0; transform: translateY(-52px) scale(0.4); }
  }
  .goal-particle {
    position: absolute;
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--color-accent, #c8864a);
    pointer-events: none;
    animation: fable-particle-burst var(--dur, 0.8s) ease-out both;
    box-shadow: 0 0 4px rgba(200,134,74,0.6);
  }
  .folder-chip.drop-target {
    transform: scale(1.08);
    box-shadow: 0 0 0 2px var(--color-accent,#c47a3b), 0 4px 16px rgba(196,122,59,0.25);
    transition: transform 180ms ease, box-shadow 180ms ease;
  }
  .folder-chip.suction-flash {
    animation: fable-suction 380ms ease forwards;
  }
  .folder-chip[data-depth="2"] { margin-left: 16px; font-size: 12px; }
  .folder-chip[data-depth="3"] { margin-left: 32px; font-size: 11px; }
  /* 컴팩트 리스트 뷰 */
  .library-grid--list {
    display: flex !important;
    flex-direction: column !important;
    gap: 0 !important;
  }
  .library-grid--list .book-card {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 12px;
    padding: 10px 4px;
    border-bottom: 1px solid rgba(120,100,80,0.08);
    border-radius: 0;
  }
  .library-grid--list .book-cover-wrap {
    width: 44px; height: 62px; flex-shrink: 0; border-radius: 4px; overflow: hidden;
  }
  .library-grid--list .book-card-title {
    font-size: 13.5px; font-weight: 500; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .library-grid--list .book-card-tags { display: flex; gap: 4px; flex-wrap: nowrap; }
  .library-grid--list .book-card-progress { display: none; }
  /* 태그 팝업 글래스모피즘 */
  .tag-context-popup {
    position: fixed;
    z-index: 9900;
    background: rgba(250,246,240,0.88);
    backdrop-filter: blur(12px) saturate(180%);
    -webkit-backdrop-filter: blur(12px) saturate(180%);
    border: 1px solid rgba(200,170,130,0.28);
    border-radius: 14px;
    box-shadow: 0 16px 48px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10);
    padding: 10px;
    min-width: 200px;
    max-width: 280px;
    animation: fx-popup-in 0.22s cubic-bezier(0.34,1.4,0.64,1) both;
  }
  [data-theme="dark"] .tag-context-popup {
    background: rgba(32,26,20,0.90);
    border-color: rgba(120,90,60,0.3);
  }
  .tag-context-popup-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--color-ink-muted, #8a7a6a);
    letter-spacing: 0.5px;
    text-transform: uppercase;
    padding: 2px 6px 8px;
    border-bottom: 1px solid rgba(120,100,80,0.10);
    margin-bottom: 6px;
  }
  .tag-context-popup-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 4px 2px;
  }
  .tag-context-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 5px 10px;
    border-radius: 20px;
    border: none;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: transform 0.15s ease, opacity 0.15s ease;
  }
  .tag-context-btn:hover { transform: scale(1.06); }
  .tag-context-btn.active { outline: 2px solid currentColor; }
  /*
   * [버그 수정 — D-7] 스마트 태그 폴더 그리드 아이콘 비주얼 정렬
   * ─────────────────────────────────────────────────────────────
   * .smart-tag-grid / .smart-tag-folder / .smart-tag-icon 등의 정의가
   * 이 인라인 <style> 블록과 fx.css §18에 중복 선언되어 있었다.
   * 두 선언이 서로 다른 grid-template-columns(120px vs 110px)와
   * gap(6px vs 5px) 값을 가지고 있어, 스타일시트 삽입 순서에 따라
   * 어느 쪽이 우선 적용되는지가 비결정적으로 갈렸고, 이로 인해
   * 폴더 아이콘과 폴더명 텍스트의 픽셀 그리드가 뷰포트/해상도에 따라
   * 미세하게 어긋나는 가시성 왜곡이 발생했다. fx.css §18을 단일
   * 진실 공급원으로 삼고 이 중복 선언을 제거한다(fx.css 쪽이 호버 시
   * 아이콘 확대 트랜지션 등 더 정교한 버전이므로 그쪽을 유지한다).
   */
  /* 대시보드 HUD */
  #dashboard-hud {
    padding: 16px 0 8px;
    transition: opacity 0.22s ease;
  }
  #dashboard-hud.hud-hidden { display: none !important; }
  /* 컴팩트 뷰 토글 버튼 */
  .library-view-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border-radius: 20px;
    border: 1px solid rgba(120,100,80,0.18);
    background: transparent;
    cursor: pointer;
    font-size: 12px;
    color: var(--color-ink-muted, #8a7a6a);
    transition: background 0.15s ease, color 0.15s ease;
  }
  .library-view-toggle.active {
    background: rgba(120,100,80,0.10);
    color: var(--color-ink, #1a1814);
  }
  /* 모바일 임포트 버튼 */
  .mobile-import-btn {
    display: none;
  }
  @media (hover: none) and (pointer: coarse) {
    .mobile-import-btn { display: inline-flex; align-items: center; gap: 6px; }
  }
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

  const del = document.createElement('span');
  del.className = 'folder-chip-del';
  del.textContent = '✕';
  del.setAttribute('role', 'button');
  del.setAttribute('aria-label', `${f.name} 폴더 삭제`);
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    if (confirm(`'${f.name}' 폴더를 삭제하면 폴더 안의 도서와 기록이 함께 삭제됩니다. 삭제하시겠습니까?`)) {
      StorageSystem.deleteFolder(f.id).then(async (result) => {
        if (store.activeFolderId === f.id) store.activeFolderId = null;
        const [books, folders] = await Promise.all([StorageSystem.getAllBooks(), StorageSystem.getAllFolders()]);
        ReactiveStore.patch({ libraryBooks: books, folders });
        const n = result?.deletedBooks || 0;
        Toast.show(n > 0 ? `폴더와 도서 ${n}권이 삭제되었습니다.` : '폴더가 삭제되었습니다.', 'success');
      });
    }
  });
  chip.appendChild(del);
  chip.addEventListener('click', () => { store.activeFolderId = f.id; });

  chip.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/fable-book')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; chip.classList.add('drop-target'); }
  });
  chip.addEventListener('dragleave', (e) => {
    if (!chip.contains(e.relatedTarget)) chip.classList.remove('drop-target');
  });
  chip.addEventListener('drop', async (e) => {
    e.preventDefault();
    chip.classList.remove('drop-target');
    const bookKey = e.dataTransfer.getData('text/fable-book');
    if (!bookKey) return;
    chip.classList.add('suction-flash');
    chip.addEventListener('animationend', () => chip.classList.remove('suction-flash'), { once: true });
    await StorageSystem.setBookFolder(bookKey, f.id);
    await refreshLibraryData();
    Toast.show(`'${f.name}'(으)로 이동했습니다.`, 'success');
  });

  return chip;
}

function _appendTreeNodes(nodes, depth, frag) {
  nodes.forEach(node => {
    const chip = _buildFolderChip(node.folder, node.bookCount, depth);
    frag.appendChild(chip);
    if (node.children.length) _appendTreeNodes(node.children, depth + 1, frag);
  });
}

function renderFolderBar(folders, books) {
  _injectDnDCSS();
  const bar = DOMProxy.get('folder-bar');
  if (!DOMProxy.exists('folder-bar')) return;
  bar.innerHTML = '';

  const frag = document.createDocumentFragment();

  const allChip = document.createElement('button');
  allChip.className = 'folder-chip' + (store.activeFolderId === null ? ' active' : '');
  allChip.textContent = `전체 (${books.length})`;
  allChip.setAttribute('role', 'tab');
  allChip.setAttribute('aria-selected', String(store.activeFolderId === null));
  allChip.addEventListener('click', () => { store.activeFolderId = null; });
  allChip.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('text/fable-book')) { e.preventDefault(); allChip.classList.add('drop-target'); }
  });
  allChip.addEventListener('dragleave', (e) => { if (!allChip.contains(e.relatedTarget)) allChip.classList.remove('drop-target'); });
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
  frag.appendChild(allChip);

  const folderTree = store.folderTree || _buildFolderTree(folders, books);
  _appendTreeNodes(folderTree, 1, frag);

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
    parentId: parentId,
    ts:       Date.now(),
  };
  StorageSystem.saveFolder(folder).then(async () => {
    await refreshLibraryData();
    Toast.show(`'${folder.name}' 폴더가 생성되었습니다.`, 'success');
  });
}

/* ══════════════════════════════════════════════════════════
   §7-B. 스마트 태그 폴더 그리드 (최상단 영역)
   ══════════════════════════════════════════════════════════ */
function renderSmartTagFolders(allTags, books) {
  _injectDnDCSS();
  const container = DOMProxy.get('smart-tag-section');
  if (!DOMProxy.exists('smart-tag-section')) return;

  const tagsToShow = allTags.slice(0, 12); /* 최대 12개 */
  if (!tagsToShow.length) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';

  /* 그리드 재렌더 */
  const grid = container.querySelector('.smart-tag-grid') || (() => {
    const g = document.createElement('div');
    g.className = 'smart-tag-grid';
    container.appendChild(g);
    return g;
  })();
  grid.innerHTML = '';

  const frag = document.createDocumentFragment();
  tagsToShow.forEach(tagName => {
    const cnt   = books.filter(b => (b.tags || []).includes(tagName)).length;
    const tc    = _getTagColor(tagName);
    const active = (store.activeTags || []).includes(tagName);

    const folder = document.createElement('div');
    folder.className = 'smart-tag-folder' + (active ? ' active' : '');
    folder.style.color = tc.color;
    folder.style.setProperty('--tag-color', tc.color);
    folder.style.setProperty('--tag-bg', tc.bg);
    folder.setAttribute('role', 'button');
    folder.setAttribute('aria-pressed', String(active));
    folder.setAttribute('aria-label', `${tagName} 필터 (${cnt}권)`);
    folder.title = tagName;

    if (active) {
      folder.style.background = tc.bg;
      folder.style.borderColor = tc.color;
    }

    const icon = document.createElement('div');
    icon.className = 'smart-tag-icon';
    icon.textContent = _getTagEmoji(tagName);

    const nameEl = document.createElement('div');
    nameEl.className = 'smart-tag-name';
    nameEl.textContent = tagName;

    const countEl = document.createElement('div');
    countEl.className = 'smart-tag-count';
    countEl.textContent = `${cnt}권`;

    folder.append(icon, nameEl, countEl);

    /* 클릭: AND 필터 토글 */
    folder.addEventListener('click', () => {
      const set = new Set(store.activeTags || []);
      set.has(tagName) ? set.delete(tagName) : set.add(tagName);
      store.activeTags = [...set];
    });

    /* 드롭 타깃: 책 카드 드래그 → 태그 자동 바인딩 */
    folder.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('text/fable-book')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        folder.classList.add('drop-target');
      }
    });
    folder.addEventListener('dragleave', (e) => {
      if (!folder.contains(e.relatedTarget)) folder.classList.remove('drop-target');
    });
    folder.addEventListener('drop', async (e) => {
      e.preventDefault();
      folder.classList.remove('drop-target');
      folder.classList.add('suction-flash');
      folder.addEventListener('animationend', () => folder.classList.remove('suction-flash'), { once: true });
      const bookKey = e.dataTransfer.getData('text/fable-book');
      if (!bookKey) return;
      const book = (store.libraryBooks || []).find(b => b.bookKey === bookKey);
      if (!book) return;
      const newTags = [...new Set([...(book.tags || []), tagName])];
      await StorageSystem.updateBookTags(bookKey, newTags);
      await refreshLibraryData();
      Toast.show(`'#${tagName}' 태그가 추가되었습니다.`, 'success');
    });

    frag.appendChild(folder);
  });
  grid.appendChild(frag);
}

function _getTagEmoji(tagName) {
  const map = { '판타지': '⚔️', '로맨스': '💕', '무협': '🥋', 'SF/미스터리': '🔭', '현대판타지': '🏙️', '일반소설': '📖' };
  return map[tagName] || '🏷️';
}

/* ══════════════════════════════════════════════════════════
   §8. 카드 메뉴 — 태그 컨텍스트 팝업 글래스모피즘
   ══════════════════════════════════════════════════════════ */
function _showTagContextPopup(book, anchorEl) {
  document.querySelectorAll('.tag-context-popup').forEach(p => p.remove());
  _injectDnDCSS();

  const popup = document.createElement('div');
  popup.className = 'tag-context-popup';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', '태그 선택');

  const titleDiv = document.createElement('div');
  titleDiv.className = 'tag-context-popup-title';
  titleDiv.textContent = '🏷 태그 선택';
  popup.appendChild(titleDiv);

  const grid = document.createElement('div');
  grid.className = 'tag-context-popup-grid';

  /* 현재 책의 태그 */
  const currentTags = new Set(book.tags || []);

  /* 전체 태그(장르 + 커스텀) 순서 렌더 */
  const allDisplayTags = store.allTags || GENRE_TAGS.map(g => g.name);

  allDisplayTags.forEach(tagName => {
    const tc     = _getTagColor(tagName);
    const active = currentTags.has(tagName);
    /* [버그 수정 — D-4] 다크 모드에서는 밝아진 칩 색상 위에 흰색
       텍스트를 올리면 대비가 부족하므로, darkActiveText(짙은 잉크색)
       를 우선 사용한다. */
    const activeTextColor = tc.darkActiveText || '#fff';

    const btn = document.createElement('button');
    btn.className = 'tag-context-btn' + (active ? ' active' : '');
    btn.style.background = active ? tc.color : tc.bg;
    btn.style.color      = active ? activeTextColor : tc.color;
    btn.textContent = '#' + tagName;

    btn.addEventListener('click', async () => {
      if (active) {
        currentTags.delete(tagName);
        btn.classList.remove('active');
        btn.style.background = tc.bg;
        btn.style.color      = tc.color;
      } else {
        currentTags.add(tagName);
        btn.classList.add('active');
        btn.style.background = tc.color;
        btn.style.color      = activeTextColor;
      }
      await StorageSystem.updateBookTags(book.bookKey, [...currentTags]);
      await refreshLibraryData();
    });
    grid.appendChild(btn);
  });

  /* 태그 직접 입력 */
  const inputRow = document.createElement('div');
  inputRow.style.cssText = 'display:flex;gap:6px;padding:8px 2px 2px;border-top:1px solid rgba(120,100,80,0.10);margin-top:6px;';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '새 태그 입력…';
  input.maxLength = 20;
  input.style.cssText = 'flex:1;padding:5px 8px;border-radius:8px;border:1px solid rgba(120,100,80,0.18);background:rgba(255,255,255,0.6);font-size:12px;outline:none;';
  const addBtn = document.createElement('button');
  addBtn.textContent = '추가';
  addBtn.style.cssText = 'padding:5px 10px;border-radius:8px;border:none;background:var(--color-accent,#c8864a);color:#fff;font-size:12px;cursor:pointer;';
  const doAdd = async () => {
    const val = input.value.trim().slice(0, 20);
    if (!val) return;
    currentTags.add(val);
    /* store.tags(커스텀 태그)에도 추가 */
    const stTags = [...new Set([...(store.tags || []), val])];
    store.tags = stTags;
    await StorageSystem.updateBookTags(book.bookKey, [...currentTags]);
    await refreshLibraryData();
    input.value = '';
    Toast.show(`'#${val}' 태그 추가됨`, 'success');
  };
  addBtn.addEventListener('click', doAdd);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
  inputRow.append(input, addBtn);

  popup.append(grid, inputRow);
  document.body.appendChild(popup);

  /* 위치 결정 */
  const rect = anchorEl.getBoundingClientRect();
  let left = rect.left, top = rect.bottom + 6;
  const pw = 280, ph = popup.offsetHeight || 260;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 6;
  popup.style.left = `${Math.max(8, left)}px`;
  popup.style.top  = `${Math.max(8, top)}px`;

  const closeH = (e) => { if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('pointerdown', closeH); } };
  setTimeout(() => document.addEventListener('pointerdown', closeH), 10);
}

function _showCardMenu(book, anchorEl) {
  document.querySelectorAll('.card-menu-popup').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'card-menu-popup';
  menu.setAttribute('role', 'menu');

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

  const div0 = document.createElement('div');
  div0.className = 'card-menu-divider';
  menu.appendChild(div0);

  /* [태그 추가 → 글래스모피즘 팝오버 트리거] */
  const tagItem = document.createElement('button');
  tagItem.className = 'card-menu-item';
  tagItem.setAttribute('role', 'menuitem');
  tagItem.textContent = '🏷 태그 추가/편집';
  tagItem.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.remove();
    _showTagContextPopup(book, tagItem);
  });
  menu.appendChild(tagItem);

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

  const rect = anchorEl.getBoundingClientRect();
  let left = rect.left, top = rect.bottom + 6;
  const mw = 210, mh = menu.offsetHeight || 300;
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
   §9. 독서 분석 대시보드 HUD — 서재 하단 이관 컴포넌트
   ─────────────────────────────────────────────────────────
   showDashboardReport store 구독으로 리액티브 마운트/디스마운트
   목표 달성 100% 시 앰버 파티클 세레머니 트리거
   ══════════════════════════════════════════════════════════ */
let _lastGoalPct = 0;

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
    const h   = Math.round((d.sec / maxSec) * 100);
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
      <div class="dash-card dash-card--goal" id="dash-goal-card" style="position:relative;overflow:hidden;">
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

  /* 목표 달성 세레머니 — 처음 100%에 도달할 때만 */
  if (goalPct >= 100 && _lastGoalPct < 100) {
    requestAnimationFrame(() => {
      const goalCard = document.getElementById('dash-goal-card');
      if (!goalCard) return;
      _fireGoalParticles(goalCard);
    });
  }
  _lastGoalPct = goalPct;
}

/** 앰버 빛 파티클 세레머니 */
function _fireGoalParticles(container) {
  const colors = ['#c8864a', '#e8a060', '#f0b878', '#d49050', '#b87040'];
  for (let i = 0; i < 18; i++) {
    const p = document.createElement('div');
    p.className = 'goal-particle';
    p.style.left    = `${20 + Math.random() * 60}%`;
    p.style.bottom  = `${10 + Math.random() * 30}%`;
    p.style.background = colors[Math.floor(Math.random() * colors.length)];
    const dur = 0.6 + Math.random() * 0.6;
    p.style.setProperty('--dur', `${dur}s`);
    p.style.animationDelay = `${Math.random() * 0.3}s`;
    p.style.width  = `${4 + Math.random() * 5}px`;
    p.style.height = p.style.width;
    container.appendChild(p);
    setTimeout(() => p.remove(), (dur + 0.3) * 1000);
  }
}

/* HUD 리액티브 마운트/디스마운트 */
function initDashboardHudToggle() {
  const hud = DOMProxy.get('dashboard-hud');
  if (!hud || hud === DOMProxy.VOID_NODE) return;

  function _apply(show) {
    if (show === false) {
      hud.classList.add('hud-hidden');
    } else {
      hud.classList.remove('hud-hidden');
    }
  }
  _apply(store.showDashboardReport);
  ReactiveStore.subscribe('showDashboardReport', _apply);
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
    const cnt    = books.filter(b => (b.tags || []).includes(t)).length;
    const active = store.activeTags.includes(t);
    const tc     = _getTagColor(t);

    const chip = document.createElement('button');
    chip.className = 'tag-chip' + (active ? ' active' : '');
    chip.textContent = `#${t} ${cnt}`;
    chip.setAttribute('aria-pressed', String(active));
    if (active) {
      chip.style.background  = tc.color;
      /* [버그 수정 — D-4] 다크 모드 밝은 칩 배경에는 짙은 텍스트 사용 */
      chip.style.color       = tc.darkActiveText || '#fff';
      chip.style.borderColor = tc.color;
    } else {
      chip.style.background  = tc.bg;
      chip.style.color       = tc.color;
      chip.style.borderColor = 'transparent';
    }

    /* D&D 드롭 타깃 */
    chip.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('text/fable-book')) { e.preventDefault(); chip.classList.add('drop-target'); }
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

  /* 컴팩트 리스트뷰 토글 버튼 */
  const viewToggle = document.createElement('button');
  viewToggle.className = 'library-view-toggle' + (store.libraryViewMode === 'list' ? ' active' : '');
  viewToggle.textContent = store.libraryViewMode === 'list' ? '▦ 그리드 뷰' : '≡ 리스트 뷰';
  viewToggle.setAttribute('aria-label', '서재 뷰 전환');
  viewToggle.addEventListener('click', () => {
    store.libraryViewMode = store.libraryViewMode === 'list' ? 'grid' : 'list';
    renderLibraryGrid();
  });
  frag.appendChild(viewToggle);

  bar.appendChild(frag);
}

/* ══════════════════════════════════════════════════════════
   §11. Virtual Scroll 그리드 렌더러
   ══════════════════════════════════════════════════════════ */
const VirtualGridRenderer = (() => {
  const CARD_MIN_W = 120;
  const CARD_GAP   = 12;
  const CARD_H     = 200;
  const OVERSCAN   = 2;

  let _state = null;

  function _clear() {
    if (!_state) return;
    _state.container.innerHTML = '';
    if (_state.scrollParent) _state.scrollParent.removeEventListener('scroll', _onScroll);
    _state = null;
  }

  function render(container, books, cardBuilder) {
    _clear();
    if (!container || !books.length) return;

    SkeletonUI.mount(container, Math.min(books.length, 12));

    const cw      = container.clientWidth || 320;
    const cols    = Math.max(1, Math.floor((cw + CARD_GAP) / (CARD_MIN_W + CARD_GAP)));
    const rowH    = CARD_H + CARD_GAP;
    const rowCount = Math.ceil(books.length / cols);

    container.innerHTML = '';
    container.style.position  = 'relative';
    container.style.overflowY = 'hidden';

    const spacer = document.createElement('div');
    spacer.style.cssText = `position:absolute;top:0;left:0;width:1px;height:${rowCount * rowH}px;pointer-events:none;`;
    container.appendChild(spacer);

    const rows = new Map();
    const pool = [];

    _state = { books, cols, rowH, rowCount, container, spacer, pool, rows, cardBuilder, scrollParent: null };

    let sp = container.parentElement;
    while (sp && sp !== document.body) {
      const os = getComputedStyle(sp).overflowY;
      if (os === 'auto' || os === 'scroll') break;
      sp = sp.parentElement;
    }
    _state.scrollParent = sp || window;
    _state.scrollParent.addEventListener('scroll', _onScroll, { passive: true });

    requestAnimationFrame(_syncRows);
  }

  function _visibleRowRange() {
    if (!_state) return { start: 0, end: 0 };
    const { container, rowH, rowCount, scrollParent } = _state;
    const rect = container.getBoundingClientRect();
    const vTop = scrollParent === window ? window.scrollY : (scrollParent.scrollTop || 0);
    const vH   = scrollParent === window ? window.innerHeight : scrollParent.clientHeight;
    const containerTop = rect.top + (scrollParent === window ? window.scrollY : scrollParent.scrollTop);
    const relTop  = vTop - containerTop;
    const startRow = Math.max(0, Math.floor(relTop / rowH) - OVERSCAN);
    const endRow   = Math.min(rowCount - 1, Math.ceil((relTop + vH) / rowH) + OVERSCAN);
    return { start: startRow, end: endRow };
  }

  function _syncRows() {
    if (!_state) return;
    const { start, end } = _visibleRowRange();
    const { books, cols, rowH, container, rows, pool, cardBuilder } = _state;

    rows.forEach((rowObj, rIdx) => {
      if (rIdx < start || rIdx > end) {
        rowObj.el.remove();
        pool.push(rowObj.el);
        rows.delete(rIdx);
      }
    });

    for (let r = start; r <= end; r++) {
      if (rows.has(r)) continue;
      const rowEl = pool.pop() || _createRowEl();
      rowEl.style.top = `${r * rowH}px`;
      rowEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      rowEl.innerHTML = '';
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
   §12. 개별 도서 카드 빌더 — Flip 입장 애니메이션 포함
   ══════════════════════════════════════════════════════════ */
function _buildBookCard(b, opts = {}) {
  _injectDnDCSS();
  const fullTitle = b.title || '제목 없음';
  const pct       = b.percent || 0;
  const isListMode = opts.listMode || store.libraryViewMode === 'list';

  const card = document.createElement('div');
  card.className = 'book-card book-card--flip-enter';
  card.setAttribute('role', 'listitem');
  card.setAttribute('aria-label', `${fullTitle} 열기 (${pct}% 읽음)`);
  card.draggable = true;
  card.dataset.bookKey = b.bookKey;

  /* Flip 입장 애니메이션 딜레이 해제 (누적 방지) */
  setTimeout(() => card.classList.remove('book-card--flip-enter'), 400);

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/fable-book', b.bookKey);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  const coverWrap = document.createElement('div');
  coverWrap.className = 'book-cover-wrap';
  coverWrap.dataset.tooltip = fullTitle;

  const skel = SkeletonUI.createCard();
  coverWrap.appendChild(skel);
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
  /* [버그 수정 — D-6] 컴팩트/그리드 뷰에서 제목이 말줄임 처리될 때
     마우스 호버 시 전체 제목을 보여주는 네이티브 툴팁. truncateTitle()
     은 표시 텍스트 자체를 10자로 자르므로, title 속성에는 잘리지 않은
     원본 fullTitle을 담아야 전체 텍스트가 노출된다. */
  titleEl.title = fullTitle;

  const tagRow = document.createElement('div');
  tagRow.className = 'book-card-tags';
  (b.tags || []).slice(0, isListMode ? 3 : 2).forEach(t => {
    const tc   = _getTagColor(t);
    const chip = document.createElement('span');
    chip.className = 'book-card-tag';
    chip.textContent = '#' + t;
    chip.style.color      = tc.color;
    chip.style.background = tc.bg;
    tagRow.appendChild(chip);
  });

  card.append(coverWrap, titleEl);
  if ((b.tags || []).length) card.appendChild(tagRow);

  card.addEventListener('click', () => _openBookGuarded(b));
  return card;
}

/** 컴팩트 리스트 뷰 행 빌더 */
function _buildBookRow(b) {
  _injectDnDCSS();
  const fullTitle = b.title || '제목 없음';
  const pct       = b.percent || 0;

  const row = document.createElement('div');
  row.className = 'book-card book-card--flip-enter';
  row.setAttribute('role', 'listitem');
  row.draggable = true;
  row.dataset.bookKey = b.bookKey;
  setTimeout(() => row.classList.remove('book-card--flip-enter'), 400);

  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/fable-book', b.bookKey);
    e.dataTransfer.effectAllowed = 'move';
  });

  const thumb = document.createElement('div');
  thumb.className = 'book-cover-wrap';
  thumb.style.cssText = 'width:44px;height:62px;flex-shrink:0;border-radius:4px;overflow:hidden;';
  thumb.appendChild(_buildCoverNode(b));

  const info = document.createElement('div');
  info.style.cssText = 'flex:1;min-width:0;';

  const titleEl = document.createElement('div');
  titleEl.className = 'book-card-title';
  titleEl.style.fontSize = '13.5px';
  titleEl.textContent = fullTitle;
  /* [버그 수정 — D-6] 컴팩트 리스트 뷰 제목 CSS 말줄임(ellipsis) 시
     마우스 호버로 전체 제목을 확인할 수 있도록 네이티브 툴팁 추가 */
  titleEl.title = fullTitle;

  const tagRow = document.createElement('div');
  tagRow.className = 'book-card-tags';
  (b.tags || []).slice(0, 3).forEach(t => {
    const tc   = _getTagColor(t);
    const chip = document.createElement('span');
    chip.className = 'book-card-tag';
    chip.textContent = '#' + t;
    chip.style.color      = tc.color;
    chip.style.background = tc.bg;
    tagRow.appendChild(chip);
  });

  const pctSpan = document.createElement('span');
  pctSpan.style.cssText = 'font-size:11px;color:var(--color-ink-muted,#8a7a6a);';
  pctSpan.textContent = `${pct}% 읽음`;

  info.append(titleEl, tagRow, pctSpan);

  const menuBtn = document.createElement('button');
  menuBtn.className = 'btn-card-menu';
  menuBtn.style.cssText = 'position:static;margin-left:auto;';
  menuBtn.textContent = '⋯';
  menuBtn.setAttribute('aria-label', `${fullTitle} 메뉴`);
  menuBtn.addEventListener('click', (e) => { e.stopPropagation(); _showCardMenu(b, menuBtn); });

  row.append(thumb, info, menuBtn);
  row.addEventListener('click', () => _openBookGuarded(b));
  return row;
}

/* ══════════════════════════════════════════════════════════
   §12-Z. [v5.0 신규 — 고도화 #5] 스마트 태그 다중 논리곱(AND) 검색
   엔진 — LibraryQueryEngine
   ─────────────────────────────────────────────────────────
   기존에는 renderLibraryGrid() 내부에 폴더/태그/텍스트 검색 필터가
   순차적으로 흩어져 있었다. 이를 단일 진실 공급원의 쿼리 파이프라인
   으로 통합하여:
     1) 폴더 필터(activeFolderId) → 단일 등호 비교, 가장 좁히는 효과가
        크므로 항상 1순위로 적용해 이후 단계의 입력 크기를 최소화한다.
     2) 태그 AND 교차 필터(activeTags) → 선택된 모든 태그를 동시에
        보유한 도서만 통과시킨다. 기존 `.every(t => arr.includes(t))`는
        태그 수(m) × 도서당 태그 수(k)에 비례해 매 비교마다 선형 탐색이
        반복되는 O(n·m·k) 패턴이었다. 도서별 tags 배열을 Set으로 1회
        변환한 뒤 selectedTags Set과 대조하면 비교 자체는 O(1)에 가깝게
        줄어들어, 태그 수가 늘어나는 서재일수록 체감 향상이 커진다.
     3) 텍스트 검색(librarySearch) → 제목/저자 소문자 비교는 그대로
        유지하되, 1)과 2)를 통과한 더 작은 부분집합에만 적용되도록
        순서를 고정해 불필요한 비교를 줄인다.
   각 단계는 독립 함수로 분리되어 단위 테스트 및 재사용(예: 전문 검색
   모달에서 동일 AND 교차 로직 재사용)이 용이하다.
   ══════════════════════════════════════════════════════════ */
const LibraryQueryEngine = (() => {

  /** 폴더 필터 — activeFolderId가 null이면 전체 통과 */
  function _filterByFolder(books, folderId) {
    if (folderId === null || folderId === undefined) return books;
    return books.filter(b => b.folderId === folderId);
  }

  /**
   * 태그 다중 논리곱(AND) 교차 필터
   * — selectedTags의 모든 항목을 보유한 도서만 통과
   * — 도서당 tags 배열을 Set으로 변환해 포함 여부 검사를 O(1)화
   */
  function _filterByTagsAND(books, selectedTags) {
    if (!selectedTags || !selectedTags.length) return books;
    return books.filter(b => {
      const bookTagSet = new Set(b.tags || []);
      /* selectedTags 쪽에서 every를 도는 것이 아니라, 가장 적은 쪽
         (보통 selectedTags가 더 짧음)을 기준으로 순회해 비교 횟수를
         최소화한다. */
      for (let i = 0; i < selectedTags.length; i++) {
        if (!bookTagSet.has(selectedTags[i])) return false;
      }
      return true;
    });
  }

  /** 제목/저자 부분 일치 텍스트 검색 (대소문자 무시) */
  function _filterByText(books, rawQuery) {
    const q = (rawQuery || '').trim().toLowerCase();
    if (!q) return books;
    return books.filter(b =>
      (b.title   || '').toLowerCase().includes(q) ||
      (b.creator || '').toLowerCase().includes(q)
    );
  }

  function _applySort(books, sortMode) {
    const sorted = books.slice();
    switch (sortMode) {
      case 'title':    sorted.sort((a, b) => (a.title || '').localeCompare(b.title || '')); break;
      case 'progress': sorted.sort((a, b) => (b.percent || 0) - (a.percent || 0)); break;
      case 'added':    sorted.sort((a, b) => (b.seq || 0) - (a.seq || 0)); break;
      case 'recent': default: sorted.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0)); break;
    }
    return sorted;
  }

  /**
   * 전체 쿼리 파이프라인 실행 — 폴더 → 태그 AND → 텍스트 → 정렬 순.
   * 좁히는 효과가 큰 필터를 먼저 적용해 다음 단계 입력을 줄인다.
   */
  function execute(allBooks, { folderId, activeTags, searchQuery, sortMode }) {
    let result = allBooks;
    result = _filterByFolder(result, folderId);
    result = _filterByTagsAND(result, activeTags);
    result = _filterByText(result, searchQuery);
    result = _applySort(result, sortMode);
    return result;
  }

  return { execute, _filterByFolder, _filterByTagsAND, _filterByText, _applySort };
})();

/* ══════════════════════════════════════════════════════════
   §13. renderLibraryGrid — Virtual Scroll 통합 진입점
   ══════════════════════════════════════════════════════════ */
let _gridRenderController = null;

function renderLibraryGrid() {
  const grid  = DOMProxy.get('library-grid');
  const empty = DOMProxy.get('library-empty');
  const count = DOMProxy.get('library-count');
  if (!DOMProxy.exists('library-grid')) return;

  if (_gridRenderController) _gridRenderController.abort();
  _gridRenderController = new AbortController();
  const signal = _gridRenderController.signal;

  const allBooks = store.libraryBooks || [];

  /* 상단 위젯 갱신 */
  renderAnalyticsDashboard(allBooks, store.readingLog || {});
  renderRecentBooks(allBooks);
  renderFolderBar(store.folders || [], allBooks);
  renderTagBar(store.allTags || [], allBooks);
  renderSmartTagFolders(store.allTags || [], allBooks);

  /* [v5.0] 단일 쿼리 파이프라인 — LibraryQueryEngine.execute() */
  const books = LibraryQueryEngine.execute(allBooks, {
    folderId:    store.activeFolderId,
    activeTags:  store.activeTags || [],
    searchQuery: store.librarySearch || '',
    sortMode:    store.sortMode,
  });

  if (signal.aborted) return;
  grid.innerHTML = '';

  const isListMode = store.libraryViewMode === 'list';
  if (isListMode) {
    grid.classList.add('library-grid--list');
  } else {
    grid.classList.remove('library-grid--list');
  }

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

  /* 리스트 뷰: 청크 렌더 (순서 중요) */
  if (isListMode) {
    SketelonUI_list: {
      SkeletonUI.mountList(grid, Math.min(books.length, 10));
    }
    requestAnimationFrame(() => {
      if (signal.aborted) return;
      grid.innerHTML = '';
      const frag = document.createDocumentFragment();
      books.forEach(b => frag.appendChild(_buildBookRow(b)));
      grid.appendChild(frag);
    });
    return;
  }

  /* 그리드 뷰: Virtual Scroll (50권+) vs 청크 렌더 */
  const USE_VIRTUAL = books.length >= 50;
  if (USE_VIRTUAL) {
    SkeletonUI.mount(grid, Math.min(books.length, 12));
    requestAnimationFrame(() => {
      if (signal.aborted) return;
      VirtualGridRenderer.render(grid, books, _buildBookCard);
    });
  } else {
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
   §14. 다중 파일 임포트 파이프라인
   ─────────────────────────────────────────────────────────
   모바일 브리지: <input type="file" multiple> 통한 대량 업로드
   EPUB opf dc:subject 자동 태깅 큐 포함
   ══════════════════════════════════════════════════════════ */
async function importEpubFiles(files) {
  if (!files || files.length === 0) return;

  const epubReady = await waitForEpubJS();
  if (!epubReady) {
    Toast.show('EPUB 엔진을 로드하지 못했습니다. 네트워크 확인 후 새로고침해 주세요.', 'error');
    return;
  }

  /* 뷰어 메모리 GC — 서재 임포트 시 뷰어 리소스 해제 */
  try { ResourceRegistry.releaseAll(); } catch (_) {}

  const fileArr = Array.from(files);
  const total   = fileArr.length;

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

    try { store.importProgressLabel = `${i + 1} / ${total} — ${file.name.slice(0, 20)}`; } catch (_) {}

    await ErrorBoundary.wrap('renderer', async () => {
      const buf  = await file.arrayBuffer();
      const book = window.ePub(buf.slice(0));
      const ok   = await awaitBookReady(book, 12000);
      if (!ok) {
        try { book.destroy(); } catch (_) {}
        Toast.show(`${file.name}: 분석 시간 초과로 건너뜁니다.`, 'error');
        return;
      }

      let title = file.name.replace(/\.epub$/i, ''), creator = '', publisher = '', subjects = '';
      try {
        const meta = await book.loaded.metadata;
        title     = meta.title     || title;
        creator   = meta.creator   || '';
        publisher = meta.publisher || '';
        subjects  = meta.subject   || '';
      } catch (_) {}

      /* dc:subject 자동 태깅 큐 */
      const autoTags = _detectGenreTags(subjects + ' ' + title);

      const coverDataUrl = await extractCoverDataUrl(book);
      try { book.destroy(); } catch (_) {}

      const bookKey = 'fable_cfi_' + (title + creator).replace(/[^a-zA-Z0-9가-힣]/g, '_').slice(0, 50);
      batch.push({ bookKey, buffer: buf, title, creator, coverDataUrl, fileHash, publisher, tags: autoTags });
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
   §15. 모바일 다중 파일 임포트 브리지
   ─────────────────────────────────────────────────────────
   showDirectoryPicker 불가 모바일 환경 대안:
   <input type="file" multiple accept=".epub"> 히든 인풋
   를 동적 생성하여 네이티브 파일 관리자 앱 연동
   ══════════════════════════════════════════════════════════ */
let _mobileFileInput = null;

function initMobileImportBridge() {
  /* 히든 인풋 단일 생성 */
  if (!_mobileFileInput) {
    _mobileFileInput = document.createElement('input');
    _mobileFileInput.type     = 'file';
    _mobileFileInput.multiple = true;
    _mobileFileInput.accept   = '.epub';
    _mobileFileInput.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;width:1px;height:1px;';
    _mobileFileInput.setAttribute('aria-hidden', 'true');
    document.body.appendChild(_mobileFileInput);

    _mobileFileInput.addEventListener('change', async (e) => {
      const files = e.target.files;
      if (files && files.length) {
        await importEpubFiles(files);
      }
      _mobileFileInput.value = ''; /* 동일 파일 재선택 허용 */
    });
  }

  /* 모바일 임포트 버튼 바인딩 */
  const mobileBtn = DOMProxy.get('mobile-import-btn');
  if (DOMProxy.exists('mobile-import-btn')) {
    mobileBtn.addEventListener('click', () => {
      _mobileFileInput.click();
    });
  }
}

/* ══════════════════════════════════════════════════════════
   §16. 서재 초기화 — store 구독 + 리액티브 연결
   ══════════════════════════════════════════════════════════ */
function initLibrarySubscriptions() {
  _ensureSystemTags();

  /* 서재 진입 시 GC 실행 */
  try { if (!store.isViewerOpen) ResourceRegistry.releaseAll(); } catch (_) {}

  /* store 변화 → 그리드 리렌더 */
  ReactiveStore.subscribe('libraryBooks',   () => renderLibraryGrid());
  ReactiveStore.subscribe('activeFolderId', () => renderLibraryGrid());
  ReactiveStore.subscribe('activeTags',     () => renderLibraryGrid());
  ReactiveStore.subscribe('sortMode',       () => renderLibraryGrid());
  ReactiveStore.subscribe('librarySearch',  () => renderLibraryGrid());
  ReactiveStore.subscribe('allTags',        () => renderLibraryGrid());

  /* HUD 토글 구독 */
  initDashboardHudToggle();

  /* 모바일 브리지 초기화 */
  initMobileImportBridge();
}

/* ══════════════════════════════════════════════════════════
   §17. computeFileHash — 폴백 해시 (외부 호환용)
   ══════════════════════════════════════════════════════════ */
function computeFileHash(file) {
  const seed = `${file.name}::${file.size}`;
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) + hash) + seed.charCodeAt(i);
  return `h${(hash >>> 0).toString(36)}_${file.size}`;
}

/* ══════════════════════════════════════════════════════════
   Exports — 중복 export 없이 단일 블록 정의
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
  renderSmartTagFolders,
  renderLibraryGrid,
  importEpubFiles,
  initLibrarySubscriptions,
  initMobileImportBridge,
  initDashboardHudToggle,
  LibraryQueryEngine,
};
