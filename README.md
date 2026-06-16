# 📖 Fable Premium v5.0 — Architecture & Engineering Specification

> **Pure Vanilla Web Stack · Vite PWA · IndexedDB v6 · Offline-First EPUB Reader**
>
> 이 문서는 Fable Premium v5.0의 아키텍처 결정 사항, 모듈 경계, 상태 흐름, 데이터베이스 명세, 비주얼 FX 레이어를 정리한 단일 진실 공급원(Single Source of Truth)입니다. 새로 합류한 개발자나 아키텍트가 이 문서를 통해 전체 시스템 구조를 파악하고 바로 유지보수에 참여할 수 있도록 작성되었습니다.

---

## 목차

1. [프로젝트 개요 & 철학](#1-프로젝트-개요--철학)
2. [물리 디렉터리 구조 & 경로 규칙](#2-물리-디렉터리-구조--경로-규칙)
3. [서재(Dashboard) 레이아웃 — 3단 구조](#3-서재dashboard-레이아웃--3단-구조)
4. [독서 리포트 HUD 토글 시스템](#4-독서-리포트-hud-토글-시스템)
5. [장르 태그 시스템 & 3-Way 리액티브 바인딩](#5-장르-태그-시스템--3-way-리액티브-바인딩)
6. [모바일 다중 파일 임포트 & 파일시스템 큐](#6-모바일-다중-파일-임포트--파일시스템-큐)
7. [IndexedDB v6 스토어 명세](#7-indexeddb-v6-스토어-명세)
8. [ReactiveStore 상태 엔진 & 구독 패턴](#8-reactivestore-상태-엔진--구독-패턴)
9. [ResourceRegistry & GC 전략](#9-resourceregistry--gc-전략)
10. [PWA 메타데이터 & 아이콘 참조 구조](#10-pwa-메타데이터--아이콘-참조-구조)
11. [Visual FX 명세](#11-visual-fx-명세)
12. [빌드 & 배포 가이드](#12-빌드--배포-가이드)
13. [보안 & XSS 방어](#13-보안--xss-방어)

---

## 1. 프로젝트 개요 & 철학

### 1-1. Pure Vanilla Web Stack

Fable Premium v5.0은 React, Vue, Svelte 등 외부 UI 프레임워크를 사용하지 않는 **순수 바닐라 웹 스택(Pure Vanilla Web Stack)** 기반의 EPUB 뷰어 PWA입니다. 가상 DOM(Virtual DOM) 레이어 없이 `Proxy` 기반 상태 엔진과 직접 DOM 조작을 결합해 프레임워크 수준의 리액티비티를 구현합니다.

- **상태 관리** — `store.js`의 ES6 `Proxy` 기반 `ReactiveStore`. 선언적 상태 구독 패턴을 프레임워크 의존 없이 제공합니다.
- **모듈 시스템** — ES Modules(ESM) 100% 기반. Vite/Rollup의 정적 분석 및 트리쉐이킹과 완전히 호환됩니다.
- **빌드 도구** — Vite + VitePWA(`injectManifest` 전략). `manualChunks`를 통한 수동 청크 분할로 초기 로드 페이로드를 최소화합니다.
- **오프라인 우선** — Workbox 기반 서비스 워커(`sw.js`) + IndexedDB v6 + CRDT LWW 병합 동기화.
- **렌더링 방식** — Folio 스타일 가로 분할 페이징. 뷰포트 높이는 `100vh`로 고정하며, 초기 렌더링 시 테마 미적용으로 인한 화면 깜빡임(FOUC)을 방지하기 위해 `index.html` 최상단에 동기 실행 인라인 스크립트를 삽입합니다.

### 1-2. v5.0 주요 변경 사항

| 카테고리 | v4.x | v5.0 |
|---|---|---|
| 서재 레이아웃 | 단순 도서 그리드 | 스마트 태그 폴더 → 이어읽기 슬라이드인 → 도서 그리드 (3단 수직 구조) |
| 독서 리포트 | 뷰어 내 고정 HUD | 서재 하단으로 이동 + `showDashboardReport` 리액티브 토글 |
| 태그 시스템 | 수동 폴더 기반 | `GENRE_TAGS` 사전 정의 6종 + 커스텀 태그 + OPF 자동 태깅 |
| 모바일 임포트 | `showDirectoryPicker` 단일 방식 | `<input multiple>` 브릿지 파이프라인 병행 |
| 파일 구조 | `src/*.js` 평면 배치 | `src/ui/` 서브 디렉터리 분리 (`uploader`, `viewer`, `settings`, `fx.css`) |
| GC 전략 | 수동 리소스 해제 | 서재 진입 시 `ResourceRegistry.releaseAll()` 자동 호출 |

---

## 2. 물리 디렉터리 구조 & 경로 규칙

### 2-1. 디렉터리 트리

```
fable-premium-v5/
├── index.html                  ← FOUC 방지 인라인 스크립트 내장 + 모듈 진입점
├── vite.config.js              ← VitePWA injectManifest 설정 + 수동 청크 분할
│
├── public/                     ← 빌드 시 컴파일 없이 dist/ 루트로 복사되는 정적 파일
│   ├── _redirects              ← Cloudflare Pages SPA 라우팅 폴백 설정
│   ├── icon.svg                ← 세피아 다크 베이스 오픈북 벡터 아이콘 (maskable 겸용)
│   └── manifest.json           ← PWA 메타데이터 (icon.svg 경로 참조 포함)
│
└── src/
    ├── main.js                 ← 앱 부트스트랩, 환경 변수 오류 격리, 전역 오케스트레이션
    ├── store.js                ← Proxy 기반 전역 상태 엔진, DOMProxy, LZStore, ResourceRegistry
    ├── database.js             ← StorageSystem — IndexedDB v6 비동기 래퍼, QuotaExceeded LRU 처리
    ├── sync.js                 ← AnnotationSyncEngine — LWW+CRDT 동기화, 비동기 직렬화 큐
    ├── reader.js               ← EpubReader 샌드박스, JSZip 런타임 초기화, 3D 전환, WPM 측정
    ├── sw.js                   ← Workbox 서비스 워커, CDN 프리캐시, 백그라운드 동기화
    ├── ui.js                   ← 공용 UI 헬퍼 (화면 전환, 로딩 오버레이, 리사이즈 마스크)
    ├── assets/
    │   └── style.css           ← Folio 기본 테마, 반응형 레이아웃
    └── ui/                     ← UI 인터랙션 전용 서브 디렉터리
        ├── uploader.js         ← 서재 레이아웃, 태그/스마트 폴더, 이어읽기, 도서 그리드, 리포트 HUD
        ├── viewer.js           ← 독서 화면 UI, 팝업, 타이머, 검색, 온보딩, 리포트 렌더러
        ├── settings.js         ← 설정 패널 UI — FX 토글, 슬라이더, 태그 관리, initFxSettingsUI
        └── fx.css              ← 글래스모피즘, 젠 모드 등 v5.0 비주얼 이펙트 전용 스타일시트
```

### 2-2. 경로 규칙 (Path Convention)

아래 두 규칙은 Vite/Rollup 빌드 오류와 런타임 모듈 해석 실패를 방지하기 위한 고정 규칙입니다. 경로가 하나라도 잘못되면 빌드가 실패하므로 반드시 준수해야 합니다.

#### Rule 1 — `src/ui/` 내부에서 코어 모듈 참조 시 상위 경로(`../`) 사용

`src/ui/` 하위 파일(`uploader.js`, `viewer.js`, `settings.js`)에서 코어 모듈을 가져올 때는 반드시 `../`를 사용합니다.

```js
// ✅ CORRECT — src/ui/uploader.js 내부
import { store, ReactiveStore, DOMProxy, ResourceRegistry } from '../store.js';
import { StorageSystem }                                     from '../database.js';
import { openEpubBook, extractCoverDataUrl }                 from '../reader.js';
import { AnnotationSyncEngine }                              from '../sync.js';

// ❌ WRONG — 경로 오류로 빌드 실패
import { store } from 'store.js';
import { store } from './store.js';
```

#### Rule 2 — `src/main.js`에서 UI 모듈 가져올 때 `./ui/` 명시

`main.js`에서 UI 인터랙션 모듈을 가져올 때는 반드시 `./ui/` 서브 디렉터리를 명시합니다. 루트 레벨의 `./ui.js`와 혼동하지 않도록 주의합니다.

```js
// ✅ CORRECT — src/main.js 내부
import { initUploaderModule }  from './ui/uploader.js';  // 서재 모듈
import { initViewerModule }    from './ui/viewer.js';    // 뷰어 모듈
import { initSettingsPanel }   from './ui/settings.js';  // 설정 패널
import { showScreen }          from './ui.js';           // 공용 UI 헬퍼 (루트 레벨)

// ❌ WRONG
import { initUploaderModule }  from './uploader.js';   // 경로 누락
import { initViewerModule }    from './ui.js';         // 잘못된 모듈 참조
```

#### Rule 3 — 단방향 의존성 그래프

순환 참조(Circular Dependency)는 Rollup 빌드 경고 및 런타임 `undefined` 오류를 유발합니다. 아래 단방향 그래프를 유지합니다.

```
main.js
  ├── ui.js              (공용 헬퍼 — 코어 모듈 미참조)
  ├── ui/uploader.js  ──→  store.js, database.js, reader.js
  │                   ──→  ui/viewer.js (MetadataEditor, AnnotationExporter)
  ├── ui/viewer.js    ──→  store.js, database.js, sync.js, reader.js
  ├── ui/settings.js  ──→  store.js, database.js
  ├── store.js           (최하위 기반 — 다른 모듈을 import하지 않음)
  ├── database.js     ──→  store.js
  ├── sync.js         ──→  store.js, database.js
  └── reader.js       ──→  store.js
```

> `store.js`는 `ui.js`를 포함한 어떤 상위 모듈도 가져오지 않습니다. 이 제약이 순환 참조를 구조적으로 방지하는 핵심입니다.

---

## 3. 서재(Dashboard) 레이아웃 — 3단 구조

v5.0에서 서재 화면은 **3단 수직 렌더링 파이프라인**으로 재구성되었습니다. 각 섹션은 독립적으로 마운트되며, `ReactiveStore` 구독을 통해 상태 변화에 개별적으로 반응합니다.

### 3-1. 렌더링 파이프라인 (상단 → 하단)

```
┌─────────────────────────────────────────────────────┐
│  ① renderSmartTagFolders()                          │
│     스마트 태그 폴더 그리드 (CSS Grid)                │
│     - GENRE_TAGS 6종 + 커스텀 태그 폴더 렌더링       │
│     - 태그 클릭 → store.activeTags 필터 갱신         │
│     - CSS Grid Flip 애니메이션 정렬 트랜지션          │
├─────────────────────────────────────────────────────┤
│  ② renderRecentBooks()                              │
│     이어읽기 플로팅 카드 슬라이드인                    │
│     - store.libraryBooks 중 최근 열람 RECENT_MAX(3)개│
│     - 카드 슬라이드인 모션 (translateY + opacity)    │
│     - 카드 탭 → 해당 EPUB 재개                       │
├─────────────────────────────────────────────────────┤
│  ③ renderMainBooksGrid()                            │
│     도서 카드 그리드 또는 컴팩트 리스트 뷰             │
│     - store.sortMode: 'recent' | 'alpha' | 'tag'   │
│     - AbortController 기반 렌더 뮤텍스               │
│     - VirtualGridRenderer (대량 도서 가상 렌더링)     │
├─────────────────────────────────────────────────────┤
│  ④ ReadingReport HUD (showDashboardReport = true)   │
│     주간 독서 추이 / 오늘 목표 달성률 / 인사이트        │
│     → 설정창 스위치 OFF 시 즉시 언마운트              │
└─────────────────────────────────────────────────────┘
```

### 3-2. 섹션별 상세 명세

#### ① `renderSmartTagFolders()` — 태그 폴더 그리드

- `grid-template-columns: repeat(auto-fill, minmax(80px, 1fr))` 기반 CSS Grid로 뷰포트 폭에 자동 적응합니다.
- `store.allTags` 변경을 구독하여 태그 폴더 그리드를 실시간으로 다시 그립니다.
- 각 태그 폴더 카드는 `GENRE_TAGS` 기반 컬러 브랜딩을 사용하며, 커스텀 태그의 경우 이름 해시값으로 앰버-세피아 계열 색상을 동적으로 생성합니다.
- 폴더를 클릭하면 해당 태그가 `store.activeTags`에 토글(추가/제거)되고, `renderMainBooksGrid()`가 이를 구독하여 필터를 적용합니다.

#### ② `renderRecentBooks()` — 이어읽기 슬라이드인

- 최근 열람 순으로 정렬된 `RECENT_MAX = 3`개의 도서를 가로 슬라이드 카드로 렌더링합니다.
- 카드 진입 애니메이션: `translateY(20px) → translateY(0)` + `opacity: 0 → 1` (stagger delay 적용).
- 표지 이미지가 없는 경우 제목 해시 기반 HSL 색상으로 플레이스홀더를 자동 생성합니다.

#### ③ `renderMainBooksGrid()` — 도서 카드 그리드

- **AbortController 뮤텍스** — 이전 렌더 작업이 완료되기 전에 재호출이 발생하면 이전 작업을 중단(`abort`)하여 DOM 경쟁 상태를 방지합니다.
- **VirtualGridRenderer** — 100권 이상의 대량 도서 환경에서 뷰포트 밖의 카드는 렌더링을 건너뛰는 `IntersectionObserver` 기반 지연 로딩을 적용합니다.
- **컴팩트 리스트 뷰** — 설정에서 토글 시 카드 그리드에서 1행 리스트 뷰로 전환됩니다. (`store.compactView` 구독)
- `store.librarySearch` 구독을 통해 제목 및 저자를 실시간으로 필터링합니다.

---

## 4. 독서 리포트 HUD 토글 시스템

### 4-1. 배경

v4.x에서 `ReadingReport` 컴포넌트는 뷰어 화면 내부에 고정 HUD 형태로 표시되었습니다. v5.0에서는 이를 **서재 하단 섹션으로 이동**하여 독서 화면의 몰입감을 보장하고, 사용자가 설정에서 리포트 표시 여부를 직접 제어할 수 있도록 개선했습니다.

### 4-2. 리액티브 토글 흐름

```
[설정 패널 — settings.js]
  사용자: "독서 리포트 표시" 스위치 조작
        │
        ▼
  store.showDashboardReport = true / false
        │
        ▼  (ReactiveStore 구독 — rAF 배치 플러시)
        │
[서재 — uploader.js]
  ReactiveStore.subscribe('showDashboardReport', (val) => {
    if (val) mountReadingReport();
    else     unmountReadingReport();
  })
        │
        ▼
  [ReadingReport 컴포넌트]
  - 주간 독서 추이 바 차트 (store.readingLog 집계)
  - 오늘 목표 달성률 게이지 (store.dailyGoalMin 기준)
  - 실시간 인사이트 텍스트 (측정 WPM, 연속 독서 시간 등)
```

### 4-3. 상태 흐름 시퀀스

```
User Action            store.js              uploader.js (서재)
─────────────────────────────────────────────────────────────────
스위치 ON  ──────────→  showDashboardReport = true
                                │
                                └──→ _flush() via rAF
                                          │
                                          ▼
                               구독 콜백 실행
                                          │
                                          ▼
                               mountReadingReport()
                               DOM에 #reading-report 삽입
                               readingLog 데이터 집계 후 렌더링

스위치 OFF ──────────→  showDashboardReport = false
                                │
                                └──→ _flush() via rAF
                                          │
                                          ▼
                               unmountReadingReport()
                               #reading-report.remove()
─────────────────────────────────────────────────────────────────
```

> `mountReadingReport()`와 `unmountReadingReport()`는 `display: none` 방식이 아닌 **DOM 삽입/제거 방식**으로 구현됩니다. 리포트가 비활성 상태일 때 `readingLog` 집계 연산이 실행되지 않으며, 불필요한 메모리 점유가 발생하지 않습니다.

---

## 5. 장르 태그 시스템 & 3-Way 리액티브 바인딩

### 5-1. `GENRE_TAGS` 상수 (사전 정의 6종)

앱 초기화 시 `_ensureSystemTags()`가 호출되며, 아래 6종의 장르 태그가 `store.allTags`에 자동으로 추가됩니다. 이 태그들은 사용자가 삭제할 수 없는 시스템 태그이며, 커스텀 태그와 병합되어 서재의 태그 폴더를 구성합니다.

```js
export const GENRE_TAGS = [
  { name: '판타지',      color: '#7c6fcd', bg: 'rgba(124,111,205,0.12)' },
  { name: '로맨스',      color: '#c46a8a', bg: 'rgba(196,106,138,0.12)' },
  { name: '무협',        color: '#b0834a', bg: 'rgba(176,131,74,0.12)'  },
  { name: 'SF/미스터리', color: '#4a8fb0', bg: 'rgba(74,143,176,0.12)'  },
  { name: '현대판타지',  color: '#6aab7e', bg: 'rgba(106,171,126,0.12)' },
  { name: '일반소설',    color: '#8a7a6a', bg: 'rgba(138,122,106,0.12)' },
];
```

| 태그명 | 컬러 | 배경 알파 | 분위기 |
|---|---|---|---|
| 판타지 | `#7c6fcd` (뮤티드 퍼플) | 0.12 | 신비, 마법 |
| 로맨스 | `#c46a8a` (뮤티드 로즈) | 0.12 | 감성, 따뜻함 |
| 무협 | `#b0834a` (세피아 앰버) | 0.12 | 고풍, 동양적 |
| SF/미스터리 | `#4a8fb0` (스틸 블루) | 0.12 | 냉철, 미래적 |
| 현대판타지 | `#6aab7e` (뮤티드 그린) | 0.12 | 현대, 청량 |
| 일반소설 | `#8a7a6a` (웜 그레이) | 0.12 | 클래식, 정제 |

커스텀 태그는 이름 문자열의 해시값을 기반으로 **앰버-세피아 계열(Hue 25°~55°)** 색상을 동적으로 생성하여 Fable의 전체 세피아 톤 디자인과 일관성을 유지합니다.

### 5-2. 3-Way 리액티브 바인딩 구조

태그 시스템은 세 지점이 `store.allTags` 단일 상태를 공유하는 **3-Way 리액티브 바인딩** 패턴으로 동작합니다.

```
┌─────────────────────────────────────────────────────────────┐
│  [설정 패널 — settings.js]                                   │
│  <input type="text" id="new-tag-input">                     │
│  <button id="add-tag-btn">태그 생성</button>                 │
│                                                             │
│  addTagBtn.addEventListener('click', () => {                │
│    const name = input.value.trim();                         │
│    if (name) store.allTags = [...store.allTags, name];      │
│  })                                                         │
└──────────────────────┬──────────────────────────────────────┘
                       │  store.allTags = [...]
                       │  (Proxy setter → _notify('allTags'))
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  [ReactiveStore — store.js]                                 │
│  requestAnimationFrame(() => {                              │
│    subscribers.get('allTags').forEach(fn => fn(newValue));  │
│  })                                                         │
└──────────┬──────────────────────────┬───────────────────────┘
           │                          │
           ▼                          ▼
┌──────────────────────┐  ┌──────────────────────────────────┐
│ [서재 — uploader.js] │  │ [태그 팝오버 — uploader.js]      │
│ renderSmartTag        │  │ 글래스모피즘 팝오버 메뉴에        │
│ Folders() 재호출      │  │ 실시간 태그 목록 동기화           │
│ 태그 폴더 그리드 갱신 │  │ (도서 카드 우클릭 컨텍스트 메뉴)  │
└──────────────────────┘  └──────────────────────────────────┘
```

### 5-3. 드래그 앤 드롭 태그 매핑 (Desktop)

데스크톱 환경에서 도서 카드를 태그 폴더 위로 드래그하면 태그를 즉시 매핑할 수 있습니다.

```
1. 도서 카드 드래그 시작 → dragstart 이벤트 → bookKey 전달
2. 태그 폴더 위 진입    → dragover 이벤트 → 폴더 하이라이트
3. 폴더에 드롭          → drop 이벤트
   → StorageSystem.updateBookTags(bookKey, [...existingTags, droppedTag])
   → IndexedDB books 스토어 tags 필드 업데이트
   → store.libraryBooks 갱신 → renderMainBooksGrid() 재호출
```

### 5-4. IndexedDB `multiEntry` 인덱스 기반 교차 쿼리

`books` 스토어의 `tags` 필드에는 `{ multiEntry: true }` 인덱스가 설정되어 있습니다. 단일 도서가 여러 태그를 가질 때 각 태그가 독립 인덱스 항목으로 등록되어, 태그를 교차 조건으로 필터링할 수 있습니다.

```js
// books 스토어 태그 인덱스 생성
bookStore.createIndex('tags', 'tags', { unique: false, multiEntry: true });

// 다중 태그 필터링 쿼리 예시 (tagA AND tagB 교차 조회)
async function queryBooksByTags(tagArray) {
  const tx = db.transaction(['books'], 'readonly');
  const index = tx.objectStore('books').index('tags');
  const results = new Map();

  for (const tag of tagArray) {
    const cursor = await index.getAll(IDBKeyRange.only(tag));
    cursor.forEach(book => {
      const count = (results.get(book.bookKey) || 0) + 1;
      results.set(book.bookKey, count);
    });
  }

  // tagArray의 모든 태그를 가진 도서만 반환 (AND 조건)
  return [...results.entries()]
    .filter(([, count]) => count === tagArray.length)
    .map(([bookKey]) => bookKey);
}
```

---

## 6. 모바일 다중 파일 임포트 & 파일시스템 큐

### 6-1. 브라우저 호환성 문제와 대응 방식

`showDirectoryPicker` Web API는 Chromium 기반 데스크톱 브라우저에서만 안정적으로 동작하며, iOS Safari 및 Android WebView 환경에서는 샌드박스 보안 정책으로 인해 사용이 불가능하거나 동작이 불안정합니다. v5.0에서는 이 제한을 우회하기 위해 **HTML5 `<input type="file" multiple>` 브릿지 파이프라인**을 병행 도입했습니다.

```
┌─────────────────────────────────────────────────────────────┐
│  환경 감지 (userAgent 또는 maxTouchPoints > 0)               │
│         │                          │                         │
│         ▼ 모바일                    ▼ 데스크톱               │
│  <input type="file"          showDirectoryPicker()          │
│    multiple                  (폴더 전체 선택)                 │
│    accept=".epub">                                           │
│  (다중 파일 선택 네이티브 UI)                                  │
└──────────────┬──────────────────────────────────────────────┘
               │ FileList 반환
               ▼
┌─────────────────────────────────────────────────────────────┐
│  임포트 큐 파이프라인 (ImportQueue)                           │
│  - FileList → Array.from() → 직렬 처리 큐 생성               │
│  - 각 파일에 대해:                                            │
│    1. ArrayBuffer 읽기 (FileReader API)                     │
│    2. SHA-256 해시 계산 (HashWorker 백그라운드)               │
│    3. 중복 검사 (IndexedDB fileHash 유니크 인덱스)             │
│    4. EPUB OPF 메타데이터 파싱 → dc:subject 추출              │
│    5. 장르 태그 자동 매핑                                      │
│    6. StorageSystem.saveBook() 비동기 저장                   │
└─────────────────────────────────────────────────────────────┘
```

### 6-2. HashWorker & OPF 메타데이터 자동 태깅

`HashWorker`는 메인 스레드를 차단하지 않고 백그라운드에서 EPUB 파일을 처리하는 Web Worker입니다.

```js
// EPUB 임포트 처리 흐름
async function processEpubImport(file) {
  const buffer = await file.arrayBuffer();

  // 1. SHA-256 해시 계산 (중복 방지)
  const hashArray = await crypto.subtle.digest('SHA-256', buffer);
  const fileHash  = Array.from(new Uint8Array(hashArray))
                         .map(b => b.toString(16).padStart(2, '0')).join('');

  // 2. JSZip으로 EPUB 압축 해제 → OPF 파일 탐색
  const zip      = await JSZip.loadAsync(buffer);
  const opfEntry = Object.values(zip.files).find(f => f.name.endsWith('.opf'));
  const opfText  = opfEntry ? await opfEntry.async('text') : '';

  // 3. dc:subject 태그 추출
  const subjectMatches = [...opfText.matchAll(/<dc:subject[^>]*>(.*?)<\/dc:subject>/gi)];
  const subjectStr     = subjectMatches.map(m => m[1]).join(' ');

  // 4. 장르 패턴 매핑
  const autoTags = _detectGenreTags(subjectStr);
  // 예: ['판타지', 'SF/미스터리']

  return { fileHash, autoTags };
}

// 장르 감지 패턴 정의
const _GENRE_PATTERNS = [
  { tag: '판타지',      re: /판타지|fantasy|ファンタジー/i },
  { tag: '로맨스',      re: /로맨스|romance|연애/i },
  { tag: '무협',        re: /무협|martial|武俠/i },
  { tag: 'SF/미스터리', re: /sf|sci[- ]fi|미스터리|mystery|스릴러|thriller|공상과학/i },
  { tag: '현대판타지',  re: /현대\s*판타지|modern\s*fantasy/i },
  { tag: '일반소설',    re: /소설|novel|문학|literature/i },
];
```

### 6-3. PWA Shortcuts 명세 (`manifest.json`)

Fable Premium v5.0은 홈 화면 아이콘 길게 누름(Android) 또는 우클릭(Desktop)으로 접근할 수 있는 2개의 빠른 바로가기를 제공합니다.

| 바로가기 | `short_name` | URL | 동작 |
|---|---|---|---|
| 최근 읽은 책 이어읽기 | 이어읽기 | `/?action=resume` | 마지막으로 열람한 EPUB을 즉시 재개 |
| 새 도서 추가 | 도서 추가 | `/?action=import` | 파일 임포트 UI 진입 |

`main.js` 부트스트랩 단계에서 `URLSearchParams`로 `action` 파라미터를 파싱하여 각 숏컷의 의도를 처리합니다.

---

## 7. IndexedDB v6 스토어 명세

### 7-1. 오브젝트 스토어 구성

| 스토어명 | keyPath | 주요 인덱스 | 역할 |
|---|---|---|---|
| `books` | `bookKey` | `folderId`, `fileHash`(unique), `tags`(multiEntry), `seq` | EPUB 메타데이터, 진행률, 표지 이미지 |
| `annotations` | `uuid` | `bookKey`, `pendingSync` | 하이라이트·메모 주석, CRDT 동기화 큐 |
| `folders` | `id` | — | 폴더 계층 구조 |
| `readingLog` | `date` | — | 일별 독서 시간 로그 (분 단위) |
| `meta` | `key` | — | 내부 시퀀스 카운터, DB 메타 정보 |

### 7-2. `books` 스토어 레코드 스키마

```js
{
  bookKey:      string,   // SHA-256 해시 기반 고유 키
  title:        string,   // EPUB 메타데이터 dc:title
  creator:      string,   // EPUB 메타데이터 dc:creator
  coverDataUrl: string,   // Base64 인코딩된 표지 이미지 (없으면 null)
  fileHash:     string,   // 파일 무결성 SHA-256 해시 (유니크 인덱스)
  folderId:     string,   // 소속 폴더 ID (null = 미분류)
  tags:         string[], // 장르·커스텀 태그 배열 (multiEntry 인덱스)
  progress:     number,   // 독서 진행률 0.0 ~ 1.0
  lastCFI:      string,   // 마지막으로 읽은 EPUB CFI 위치
  lastOpenedAt: number,   // 최근 열람 Unix 타임스탬프
  seq:          number,   // 내부 정렬용 시퀀스 번호
  sizeBytes:    number,   // 파일 크기 (Bytes)
  data:         string,   // EPUB ArrayBuffer → Base64 직렬화
}
```

### 7-3. Cascade Delete

폴더를 삭제하면 해당 폴더의 도서와 그 도서에 연결된 모든 주석이 **단일 트랜잭션** 내에서 함께 제거됩니다. 고아 레코드(Orphan Records)가 발생하지 않습니다.

```
deleteFolder(folderId)
  └─ readwrite 트랜잭션 시작
       ├─ folders 스토어 → folderId 레코드 삭제
       ├─ books 스토어 → folderId 인덱스로 조회 → 해당 도서 전체 삭제
       │    └─ 각 bookKey에 대해
       │         └─ annotations 스토어 → bookKey 인덱스로 조회 → 주석 전체 삭제
       └─ 트랜잭션 커밋 (원자적 보장)
```

### 7-4. 300ms 디바운스 진행률 저장

독서 중 CFI 위치가 변경될 때마다 즉시 DB에 쓰는 대신, **300ms 디바운스** 후 최종 위치만 기록하여 IndexedDB 쓰기 횟수를 줄입니다.

```js
let _progressDebounceTimer = null;

function updateBookProgress(bookKey, progress, cfi) {
  clearTimeout(_progressDebounceTimer);
  _progressDebounceTimer = setTimeout(async () => {
    await StorageSystem.updateBookProgress(bookKey, progress, cfi);
  }, 300);
}
```

---

## 8. ReactiveStore 상태 엔진 & 구독 패턴

### 8-1. Proxy 기반 리액티비티

`store.js`의 `ReactiveStore`는 ES6 `Proxy`를 사용해 상태 변경을 감지하고, `requestAnimationFrame` 기반 배치 플러시로 연속적인 상태 변경이 발생해도 한 프레임에 한 번만 구독자를 호출합니다.

```js
// 상태 변경 → 구독자 알림 흐름
store.someKey = newValue;
//       │
//       ▼ Proxy setter
//   target[key] = value;  (동등값이면 무시)
//   _notify(key);
//       │
//       ▼ _notify()
//   pendingKeys.add(key);
//   requestAnimationFrame(_flush);  (flushQueued 플래그로 중복 방지)
//       │
//       ▼ _flush() (다음 프레임)
//   subscribers.get(key).forEach(fn => fn(newValue));
//   subscribers.get('*').forEach(fn => fn(key, newValue));  // 와일드카드
```

### 8-2. 전체 상태 키 레퍼런스 (v5.0 기준)

| 상태 키 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `book` | Object\|null | null | 현재 열린 EPUB book 인스턴스 |
| `rendition` | Object\|null | null | epub.js rendition 인스턴스 |
| `isViewerOpen` | boolean | false | 뷰어 화면 활성 여부 |
| `isTocOpen` | boolean | false | 목차 패널 활성 여부 |
| `isSettingsOpen` | boolean | false | 설정 패널 활성 여부 |
| `navBarsVisible` | boolean | true | 젠 모드 UI 표시 여부 |
| `fontSize` | number | 100 | 폰트 크기 (%) |
| `lineHeight` | string | `'normal'` | 줄간격 (`'narrow'` \| `'normal'` \| `'wide'`) |
| `theme` | string | `'paper'` | 테마 (`'paper'` \| `'dark'` \| `'sepia'` \| `'custom'`) |
| `flow` | string | `'paginated'` | 레이아웃 (`'paginated'` \| `'scrolled'`) |
| `fontFamily` | string | `'gowun'` | 폰트 패밀리 |
| `libraryBooks` | Array | `[]` | 서재 도서 목록 |
| `allTags` | Array | `[]` | 전체 태그 목록 (장르 + 커스텀) |
| `activeTags` | Array | `[]` | 현재 활성 필터 태그 |
| `sortMode` | string | `'recent'` | 정렬 기준 |
| `showDashboardReport` | boolean | false | 독서 리포트 HUD 표시 여부 |
| `readingLog` | Object | `{}` | 일별 독서 시간 로그 |
| `dailyGoalMin` | number | 30 | 일일 독서 목표 (분) |
| `measuredWpm` | number | 0 | 실시간 측정 WPM |
| `autoScrollWpm` | number | 250 | 자동 스크롤 목표 WPM |
| `autoScrollActive` | boolean | false | 자동 스크롤 활성 여부 |
| `eyeProtectActive` | boolean | false | 눈 보호 타이머 활성 여부 |
| `eyeProtectMinutes` | number | 50 | 연속 독서 제한 시간 (분) |
| `pageTransition` | string | `'fade'` | 페이지 전환 효과 (`'fade'` \| `'slide'` \| `'flip3d'`) |
| `onboardingDone` | boolean | false | 온보딩 최초 완료 여부 |
| `fontWeightBoost` | number | 0 | E-Ink 폰트 굵기 보정 오프셋 |
| `contrastScale` | number | 1.0 | E-Ink 대비 스케일 |
| `crdtVectorClock` | Object | `{}` | CRDT OR-Set 벡터 클락 |
| `appInBackground` | boolean | false | 백그라운드 절전 신호 |
| `scrubberHoverPct` | number | -1 | 스크러버 미리보기 위치 (`-1` = 비활성) |

---

## 9. ResourceRegistry & GC 전략

### 9-1. 리소스 추적 및 일괄 해제 (`releaseAll`)

Fable v5.0은 화면 전환 시 이전 화면에서 생성된 모든 리소스를 `ResourceRegistry`를 통해 중앙에서 추적하고, `releaseAll()` 한 번 호출로 일괄 해제합니다.

| 리소스 유형 | 등록 메서드 | 해제 방법 |
|---|---|---|
| DOM 이벤트 리스너 | `addListener(target, type, fn, opts)` | `removeEventListener` |
| ReactiveStore 구독 | `addStoreSub(unsubFn)` | `unsubFn()` |
| 타이머 | `addTimer(id)` | `clearTimeout` + `clearInterval` |
| ResizeObserver | `addResizeObserver(obs)` | `obs.disconnect()` |
| IntersectionObserver | `addIntersectionObserver(obs)` | `obs.disconnect()` |
| requestAnimationFrame | `addRaf(id)` | `cancelAnimationFrame` |

### 9-2. 서재 진입 시 GC 흐름

뷰어에서 서재로 이동할 때, 뷰어 모듈이 생성한 모든 리소스가 해제됩니다. 모바일 환경에서 메모리 부족을 방지하는 핵심 안전장치입니다.

```
[뷰어 → 서재 전환]
          │
          ▼
  ui.js: showScreen('uploader')
          │
          ▼
  viewer.js: destroyCurrentRenditionContext()
          │
          ├─ store.rendition.destroy()      // epub.js 렌더러 해제
          ├─ ResourceRegistry.releaseAll()  // 모든 리소스 일괄 해제
          │    ├─ DOM 이벤트 리스너 제거
          │    ├─ 스토어 구독 해제
          │    ├─ 타이머 / rAF 취소
          │    ├─ ResizeObserver 해제
          │    └─ IntersectionObserver 해제
          ├─ store.book = null
          └─ store.isViewerOpen = false
```

### 9-3. 스마트 슬립 가드 (visibilitychange 기반)

앱이 백그라운드로 전환(탭 전환, 화면 잠금 등)되면 `store.appInBackground = true` 신호를 발행합니다. WPM 트래커, 자동 스크롤 드라이버, 눈 보호 타이머 등 지속 실행 루프는 이 신호를 구독하여 rAF 및 타이머를 즉시 일시 중지합니다.

```js
// store.js 내 슬립 가드 (전역 설치)
document.addEventListener('visibilitychange', () => {
  store.appInBackground = document.visibilityState === 'hidden';
});

// 소비 모듈 예시 (자동 스크롤 드라이버)
ReactiveStore.subscribe('appInBackground', (isBackground) => {
  if (isBackground) pauseAutoScroll();
  else              resumeAutoScroll();
});
```

---

## 10. PWA 메타데이터 & 아이콘 참조 구조

### 10-1. `public/manifest.json` 주요 필드

```json
{
  "name":             "Fable Premium",
  "short_name":       "Fable",
  "display":          "standalone",
  "orientation":      "any",
  "background_color": "#1f1a14",
  "theme_color":      "#c8864a",
  "lang":             "ko",
  "start_url":        ".",
  "scope":            "/"
}
```

| 필드 | 값 | 설명 |
|---|---|---|
| `background_color` | `#1f1a14` | 스플래시 화면 배경색 (다크 세피아) |
| `theme_color` | `#c8864a` | 브라우저 주소창 및 UI 색상 (앰버 골드) |
| `display` | `standalone` | 브라우저 UI 없이 독립 앱으로 실행 |

### 10-2. `public/icon.svg` 참조 구조

`public/icon.svg`는 세피아 다크 베이스의 오픈북 모티프를 담은 벡터 아이콘으로, `manifest.json`에서 두 가지 목적(`any` + `maskable`)으로 참조됩니다.

```json
"icons": [
  { "src": "/icon.svg", "sizes": "any",    "type": "image/svg+xml", "purpose": "any"      },
  { "src": "/icon.svg", "sizes": "512x512","type": "image/svg+xml", "purpose": "maskable" }
]
```

- **`purpose: any`** — 투명 배경 SVG 원본을 그대로 사용하는 일반 앱 아이콘
- **`purpose: maskable`** — Android 어댑티브 아이콘. 안전 영역(Safe Zone) 내에 핵심 콘텐츠가 위치합니다.
- SVG 포맷을 사용하므로 모든 해상도(HDPI, Retina)에서 무손실 렌더링이 보장됩니다.

### 10-3. FOUC 방지 인라인 스크립트 (`index.html`)

`index.html` 최상단에 위치한 인라인 스크립트는 DOM 파싱 이전에 동기적으로 실행됩니다. `localStorage`에서 테마 데이터를 파싱하여 `document.documentElement`에 즉시 `data-theme` 속성을 부여함으로써, 페이지 로드 초기의 스타일 미적용 깜빡임(FOUC)을 방지합니다.

```html
<head>
  <!-- FOUC 방지 — 반드시 <head> 최상단에 위치해야 합니다 -->
  <script>
    (function() {
      try {
        const raw = localStorage.getItem('fable_v3_state');
        if (raw) {
          const state = JSON.parse(raw);
          const theme = state?.data?.theme || 'paper';
          document.documentElement.setAttribute('data-theme', theme);
        }
      } catch (_) {}
    })();
  </script>
</head>
```

---

## 11. Visual FX 명세

`src/ui/fx.css`는 Fable Premium v5.0의 비주얼 아이덴티티를 담당하는 전용 스타일시트입니다. 아래 이펙트들은 별도의 설정 없이 배포 즉시 동작하는 프로덕션 상태로 구현되어 있습니다.

### 11-1. FX 클래스 & CSS 프로퍼티 매핑

| FX 이름 | 클래스 | 핵심 CSS 프로퍼티 | 동작 |
|---|---|---|---|
| 세피아 앰버 스켈레톤 웨이브 | `.fx-skeleton` | `@keyframes fable-sepia-wave` `background: linear-gradient(90deg, ...)` `animation: fable-sepia-wave 1.4s infinite` | 도서 카드 로딩 중 세피아→앰버→세피아 그라디언트 웨이브 |
| 컨텍스트 메뉴 글래스모피즘 팝오버 | `.fx-glass-popover` | `backdrop-filter: blur(12px)` `background: rgba(...)` `border: 1px solid rgba(255,255,255,0.12)` | 도서 카드 우클릭 메뉴의 반투명 블러 팝오버 |
| 목표 달성 파티클 애니메이션 | `.fx-amber-particle` | `@keyframes particle-burst` `transform: translate() scale()` `opacity: 0→1→0` | 일일 독서 목표 달성 시 앰버 입자 방사형 애니메이션 |
| 이어읽기 카드 슬라이드인 | `.fx-slide-in-card` | `@keyframes card-slide-in` `transform: translateY(20px)→translateY(0)` `opacity: 0→1` | 서재 진입 시 최근 읽은 책 카드 등장 모션 |
| CSS Grid Flip 정렬 트랜지션 | `.fx-grid-item` | `transition: transform 350ms cubic-bezier(.4,0,.2,1)` `will-change: transform` | 태그 필터 변경 시 도서 카드 재배치 Flip 애니메이션 |
| 젠 모드 UI 페이드아웃 | `.zen-fade-out` | `transition: opacity 400ms ease` `opacity: 0` `pointer-events: none` | 2000ms 비활동 시 네비게이션 바 페이드아웃 |
| 3D 페이지 플립 전환 | `.page-flip3d` | `transform-style: preserve-3d` `@keyframes flip3d-turn` `perspective: 1200px` | `'flip3d'` 모드 활성 시 3D 원근 회전 페이지 전환 |
| E-Ink 대비 스케일 | `[data-einked]` | `filter: contrast(var(--contrast-scale))` | E-Ink 단말 대비 보정 CSS 변수 실시간 적용 |

### 11-2. 세피아 앰버 스켈레톤 웨이브 (`fable-sepia-wave`)

```css
@keyframes fable-sepia-wave {
  0%   { background-position: -600px 0; }
  100% { background-position:  600px 0; }
}

.fx-skeleton {
  background: linear-gradient(
    90deg,
    rgba(196, 134,  74, 0.06) 0%,
    rgba(196, 134,  74, 0.18) 40%,
    rgba(218, 165, 100, 0.28) 50%,
    rgba(196, 134,  74, 0.18) 60%,
    rgba(196, 134,  74, 0.06) 100%
  );
  background-size: 1200px 100%;
  animation: fable-sepia-wave 1.4s ease-in-out infinite;
}
```

### 11-3. 컨텍스트 메뉴 글래스모피즘 팝오버

```css
.fx-glass-popover {
  backdrop-filter: blur(12px) saturate(180%);
  -webkit-backdrop-filter: blur(12px) saturate(180%);
  background: rgba(31, 26, 20, 0.72);
  border: 1px solid rgba(196, 134, 74, 0.20);
  border-radius: 12px;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.36),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
```

### 11-4. 목표 달성 파티클 애니메이션

일일 목표 달성 시점에 JavaScript가 `fx-amber-particle` 클래스를 가진 DOM 요소를 동적으로 생성하고 방사형으로 배치합니다. CSS 애니메이션이 완료되면 자동으로 요소가 제거됩니다.

```css
@keyframes particle-burst {
  0%   { transform: translate(0, 0) scale(1);   opacity: 1; }
  100% { transform: var(--tx, 60px) var(--ty, -80px) scale(0.2); opacity: 0; }
}

.fx-amber-particle {
  position: fixed;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: radial-gradient(circle, #f4a542, #c8864a);
  animation: particle-burst 0.8s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
  pointer-events: none;
  z-index: 9999;
}
```

---

## 12. 빌드 & 배포 가이드

### 12-1. 중복 Export 방지 (Duplicate Export Guard)

동일 모듈 내에서 같은 식별자를 두 번 이상 export하면 Vite/Rollup 빌드가 실패합니다. 인라인 export와 하단 통합 export 중 **하나의 방식만 사용**합니다.

```js
// ❌ WRONG — 인라인 export + 하단 통합 export 중복
export function renderSmartTagFolders() { ... }  // 인라인 선언 export
export { renderSmartTagFolders };                // 하단 재export → 빌드 실패

// ✅ CORRECT — 방법 A: 인라인 export만 사용
export function renderSmartTagFolders() { ... }

// ✅ CORRECT — 방법 B: 하단 통합 export만 사용
function renderSmartTagFolders() { ... }
export { renderSmartTagFolders };
```

### 12-2. 순환 참조 방지 (Circular Dependency Prevention)

```
✅ 허용: store.js → (없음)
✅ 허용: database.js → store.js
✅ 허용: sync.js → store.js, database.js
✅ 허용: reader.js → store.js
✅ 허용: ui/uploader.js → store.js, database.js, reader.js, ui/viewer.js
✅ 허용: ui/viewer.js → store.js, database.js, sync.js, reader.js
✅ 허용: main.js → 모두

❌ 금지: store.js → ui.js          (순환 발생)
❌ 금지: database.js → reader.js   (순환 발생)
❌ 금지: reader.js → ui/viewer.js  (순환 발생)
❌ 금지: sync.js → reader.js       (순환 발생)
```

모듈 간 직접 참조 없이 상태를 전달해야 할 때는 `store.js` 리액티브 구독 패턴 또는 상위 컨텍스트(`main.js`)를 매개로 처리합니다.

### 12-3. Vite 빌드 설정 주요 사항

- **injectManifest 전략** — VitePWA 플러그인이 `sw.js`를 직접 컴파일하고 프리캐시 매니페스트를 자동으로 삽입합니다.
- **수동 청크 분할** — `manualChunks`로 vendor(jszip, epubjs) / core(store, database, sync) / ui(viewer, uploader, settings) 청크를 분리하여 초기 로드 크기를 최소화합니다.
- **`public/` 디렉터리** — `_redirects`, `icon.svg`, `manifest.json`은 빌드 과정에서 컴파일 없이 `dist/` 루트로 복사됩니다.

### 12-4. Cloudflare Pages 배포 설정 (`_redirects`)

```
/* /index.html 200
```

SPA에서 클라이언트 사이드 라우팅이 동작하려면 Cloudflare Pages가 404 대신 `index.html`을 반환해야 합니다. `public/_redirects` 파일이 없으면 새로고침 시 404가 발생하므로 반드시 포함되어야 합니다.

### 12-5. 배포 전 체크리스트

```
□ src/ui/ 내 파일의 import 경로가 모두 ../store.js 형태인지 확인
□ main.js의 UI 모듈 import가 ./ui/uploader.js 형태인지 확인
□ 각 파일에서 동일 식별자의 중복 export가 없는지 확인
□ 순환 참조 발생 여부 확인 (npx madge --circular src/)
□ public/_redirects 파일 존재 여부 확인
□ public/manifest.json의 /icon.svg 경로 참조 확인
□ vite build 성공 후 dist/ 디렉터리 구조 검증
□ Lighthouse PWA 감사 점수 확인 (목표: 100)
```

---

## 13. 보안 & XSS 방어

### 13-1. `textContent` 우선 원칙

사용자 입력 데이터나 외부 소스(EPUB 메타데이터)에서 가져온 텍스트를 DOM에 삽입할 때는 **`textContent` 또는 `setTextSafe()` 헬퍼를 사용합니다.** `innerHTML`에 신뢰할 수 없는 문자열을 직접 할당하면 EPUB 파일 내에 포함된 악성 스크립트가 실행될 수 있습니다.

```js
// store.js에 정의된 XSS 방어 헬퍼
export function setTextSafe(el, text) {
  if (el && el !== DOMProxy.VOID_NODE)
    el.textContent = String(text ?? '');
}

// ✅ CORRECT
setTextSafe(titleEl, book.title);
titleEl.textContent = book.creator;

// ❌ WRONG
titleEl.innerHTML = book.title;  // XSS 취약점
```

### 13-2. 하위 호환 필수 보존 동작 (v4.2 이후)

아래 두 가지 동작은 사용자 경험 보호를 위해 어떤 리팩토링에서도 제거하거나 변경해서는 안 됩니다.

1. **스페이스바 단축키 입력 가드** — 텍스트 입력 필드(`input`, `textarea`)에 포커스가 있을 때 스페이스바 키 이벤트가 페이지 전환 단축키로 처리되지 않도록 버블링을 차단합니다.

2. **TTS 재생 중 스크러버 조작 차단** — TTS 재생 중 스크러버를 드래그하면 오디오 위치와 텍스트 위치가 어긋나는 버그가 발생합니다. `store.ttsActive`가 `true`인 상태에서는 스크러버 인터랙션을 차단합니다.

### 13-3. `_bootstrapFable` 전역 예외 처리

`main.js`의 부트스트랩 함수 `_bootstrapFable`은 `try-catch`로 감싸져 있습니다. 초기화 과정에서 발생한 예외가 `unhandledrejection`으로 전파되는 것을 막고, `ErrorBoundary.handle('global', err)`를 통해 Toast 알림으로 처리합니다(Graceful Degradation).

---

## 부록: 모듈별 Export 인덱스

| 모듈 | 주요 Export |
|---|---|
| `store.js` | `store`, `ReactiveStore`, `LZStore`, `DOMProxy`, `ErrorBoundary`, `Toast`, `ResourceRegistry`, `setTextSafe`, `_abToBase64`, `_base64ToAb`, `LH_MAP`, `STATE_KEY`, `DB_NAME`, `DB_VER`, `RECENT_MAX` |
| `database.js` | `StorageSystem` |
| `sync.js` | `AnnotationSyncEngine` |
| `reader.js` | `openEpubBook`, `extractCoverDataUrl`, `awaitBookReady`, `waitForEpubJS` |
| `ui.js` | `showScreen`, `setLoadingOverlay`, `setResizeMask` |
| `ui/uploader.js` | `initUploaderModule`, `refreshLibraryData`, `GENRE_TAGS`, `truncateTitle` |
| `ui/viewer.js` | `initViewerModule`, `MetadataEditor`, `AnnotationExporter` |
| `ui/settings.js` | `initSettingsPanel`, `initFxSettingsUI` |

---

*© 2025 Fable Premium — Pure Vanilla Web Stack Architecture. All specifications subject to change with version updates.*

*Document version: v5.0.0*
