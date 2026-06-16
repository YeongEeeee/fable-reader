# 📖 Fable Premium v5.0 — 마스터 마이크로아키텍처 스펙 문서

> **Pure Vanilla Web Stack · Vite PWA · IndexedDB v6 · Offline-First EPUB Reader**
>
> 본 문서는 Fable Premium v5.0의 모든 아키텍처 결정사항, 모듈 경계, 상태 흐름, 데이터베이스 명세, 비주얼 FX 레이어를 집대성한 단일 진실 공급원(Single Source of Truth)입니다. 신규 합류 개발자 및 아키텍트는 이 문서 하나로 전체 시스템을 파악하고 즉시 유지보수에 투입될 수 있습니다.

---

## 목차

1. [프로젝트 개요 & 철학](#1-프로젝트-개요--철학)
2. [물리 디렉터리 구조 & 아키텍처 규칙](#2-물리-디렉터리-구조--아키텍처-규칙)
3. [서재(Dashboard) 레이아웃 3단 대개혁](#3-서재dashboard-레이아웃-3단-대개혁)
4. [독서 리포트 HUD 토글 시스템](#4-독서-리포트-hud-토글-시스템)
5. [지능형 장르 태그 시스템 & 3-Way 리액티브 바인딩](#5-지능형-장르-태그-시스템--3-way-리액티브-바인딩)
6. [모바일 다중 파일 임포트 브릿지 & 고급 파일시스템 큐](#6-모바일-다중-파일-임포트-브릿지--고급-파일시스템-큐)
7. [IndexedDB v6 스토어 명세](#7-indexeddb-v6-스토어-명세)
8. [ReactiveStore 상태 엔진 & 구독 패턴](#8-reactivestore-상태-엔진--구독-패턴)
9. [ResourceRegistry & 스마트 GC 아키텍처](#9-resourceregistry--스마트-gc-아키텍처)
10. [PWA 메타데이터 & 아이콘 참조 관계](#10-pwa-메타데이터--아이콘-참조-관계)
11. [비주얼 이펙트 & 감성 디테일 (Visual FX Spec)](#11-비주얼-이펙트--감성-디테일-visual-fx-spec)
12. [컴파일 가드 & 배포 지침 (Build Guide)](#12-컴파일-가드--배포-지침-build-guide)
13. [보안 가드 & XSS 방어 레이어](#13-보안-가드--xss-방어-레이어)

---

## 1. 프로젝트 개요 & 철학

### 1-1. Pure Vanilla Web Stack

Fable Premium v5.0은 React, Vue, Svelte 등 외부 프레임워크의 **가상 DOM(Virtual DOM) 오버헤드를 완전히 배제한 순수 바닐라 웹 스택(Pure Vanilla Web Stack)** 위에서 동작하는 고성능 EPUB 뷰어 PWA이다.

- **상태 관리**: `store.js`의 ES6 `Proxy` 기반 `ReactiveStore` — 프레임워크 없이 선언적 리액티비티 구현
- **모듈 시스템**: ES Modules(ESM) 100% 기반, Vite/Rollup의 정적 분석 및 트리쉐이킹 풀 호환
- **빌드 도구**: Vite + VitePWA(injectManifest 전략) — 수동 청크 분할 빌드 최적화
- **오프라인 우선**: Workbox 기반 서비스 워커(`sw.js`) + IndexedDB v6 + CRDT LWW 병합 동기화
- **렌더링 철학**: Folio 스타일 가로 분할 페이징, 100vh 뷰포트 제어, FOUC 방지 뮤텍스 인라인 가드

### 1-2. v5.0 대개혁 핵심 변경 요약

| 카테고리 | v4.x | v5.0 |
|---|---|---|
| 서재 레이아웃 | 단순 도서 그리드 | 스마트 태그폴더 → 이어읽기 슬라이드인 → 도서 그리드 3단 구조 |
| 독서 리포트 | 뷰어 내 HUD 고정 | 서재 하단 이관 + `showDashboardReport` 리액티브 토글 |
| 태그 시스템 | 수동 폴더 기반 | GENRE_TAGS 사전 정의 6종 + 커스텀 태그 + opf 자동 태깅 |
| 모바일 임포트 | `showDirectoryPicker` 단일 | `<input multiple>` 브릿지 파이프라인 병행 |
| 물리 구조 | `src/*.js` 플랫 배치 | `src/ui/` 서브 디렉터리 격리 (uploader/viewer/settings/fx.css) |
| GC 전략 | 수동 소멸 | 서재 진입 시 `ResourceRegistry.releaseAll()` 자동 트리거 |

---

## 2. 물리 디렉터리 구조 & 아키텍처 규칙

### 2-1. 정형화된 디렉터리 트리

```
fable-premium-v5/
├── index.html                  ← FOUC 차단 뮤텍스 가드 인라인 내장 + 모듈 진입점 바인딩
├── vite.config.js              ← VitePWA injectManifest 전략 + 수동 청크 분할 설정
│
├── public/                     ← 빌드 시 컴파일 없이 dist/ 루트로 그대로 복사
│   ├── _redirects              ← Cloudflare Pages SPA 라우팅 무한루프 방지 가드
│   ├── icon.svg                ← 세피아 다크 베이스 오픈북 벡터 아이콘 (maskable 겸용)
│   └── manifest.json           ← PWA 독립 구동 웹앱 메타데이터 (icon.svg 경로 매핑)
│
└── src/
    ├── main.js                 ← 시스템 부트스트랩 + 환경변수 크래시 격리 + 전역 오케스트레이션
    ├── store.js                ← Proxy 기반 전역 상태 엔진 + DOMProxy + LZStore + ResourceRegistry
    ├── database.js             ← StorageSystem IndexedDB v6 비동기 래퍼 + QuotaExceeded LRU 방어
    ├── sync.js                 ← AnnotationSyncEngine LWW+CRDT 양방향 동기화 + 비동기 직렬화 큐
    ├── reader.js               ← EpubReader 샌드박스 + jszip 런타임 가드 + 3D 전환 + WPM 엔진
    ├── sw.js                   ← Workbox 서비스 워커 + CDN 격리 프리캐싱 + 백그라운드 동기화
    ├── ui.js                   ← 공용 UI 헬퍼 (Viewer↔Uploader 전환, 로딩 오버레이, 리사이즈 마스크)
    ├── assets/
    │   └── style.css           ← Folio 기본 테마 + 반응형 레이아웃
    └── ui/                     ← UI 인터랙션 전용 서브 디렉터리
        ├── uploader.js         ← 서재 대개혁: 태그/스마트폴더/이어읽기/도서그리드/리포트 HUD
        ├── viewer.js           ← 독서 화면 UI + 팝업 + 타이머 + 검색 + 온보딩 + 리포트 렌더러
        ├── settings.js         ← 설정 패널 UI: FX 토글 + 슬라이더 + 태그 관리 + initFxSettingsUI
        └── fx.css              ← 글래스모피즘 + 젠 모드 등 v5.0 비주얼 특수효과 전역 스타일시트
```

### 2-2. ⚠️ 수석 아키텍트의 상대 경로 준수 규칙 (Hard Rules)

이 규칙은 Vite/Rollup 빌드 실패와 런타임 모듈 해석 오류를 원천 차단하기 위한 **절대 불변 규칙**이다. 단 한 글자의 경로 오류도 빌드 크래시를 초래한다.

#### Rule 1: `src/ui/` 내부 → 코어 엔진 참조 시 상위 경로 필수

`src/ui/` 서브 디렉터리 아래 위치한 파일(`uploader.js`, `viewer.js`, `settings.js`)에서 코어 엔진을 import할 때는 반드시 **한 단계 상위 경로(`../`)를 명확히 조준**해야 한다.

```js
// ✅ CORRECT — src/ui/uploader.js 내부
import { store, ReactiveStore, DOMProxy, ResourceRegistry } from '../store.js';
import { StorageSystem }                                     from '../database.js';
import { openEpubBook, extractCoverDataUrl }                 from '../reader.js';
import { AnnotationSyncEngine }                              from '../sync.js';

// ❌ WRONG — 경로 누락으로 빌드 즉시 실패
import { store } from 'store.js';
import { store } from './store.js';
```

#### Rule 2: `src/main.js` → UI 모듈 바인딩 시 서브 디렉터리 명확 조준

최상위 전역 오케스트레이터인 `main.js`에서 UI 인터랙션 모듈을 바인딩할 때는 반드시 **`./ui/` 서브 디렉터리를 명시**해야 하며, 루트 레벨의 `./ui.js`와 혼동해서는 안 된다.

```js
// ✅ CORRECT — src/main.js 내부
import { initUploaderModule }  from './ui/uploader.js';  // 서재 모듈
import { initViewerModule }    from './ui/viewer.js';    // 뷰어 모듈
import { initSettingsPanel }   from './ui/settings.js';  // 설정 패널
import { showScreen }          from './ui.js';           // 공용 UI 헬퍼 (루트)

// ❌ WRONG — 루트의 ui.js와 혼동
import { initUploaderModule }  from './uploader.js';   // 경로 미스
import { initViewerModule }    from './ui.js';         // 잘못된 모듈 참조
```

#### Rule 3: 모듈 단방향 의존성 그래프

순환 참조(Circular Dependency)는 Rollup 빌드 경고 및 런타임 `undefined` 실패를 유발한다. 아래 단방향 흐름을 반드시 준수한다.

```
main.js
  ├── ui.js              (공용 헬퍼, 코어 미참조)
  ├── ui/uploader.js  ──→  store.js, database.js, reader.js
  │                   ──→  ui/viewer.js (MetadataEditor, AnnotationExporter 참조)
  ├── ui/viewer.js    ──→  store.js, database.js, sync.js, reader.js
  ├── ui/settings.js  ──→  store.js, database.js
  ├── store.js           (최하위 기반 — 다른 모듈을 import하지 않음)
  ├── database.js     ──→  store.js만 참조
  ├── sync.js         ──→  store.js, database.js
  └── reader.js       ──→  store.js
```

> **핵심 원칙**: `store.js`는 `ui.js`를 포함한 어떤 상위 모듈도 import하지 않는다. 이 규칙이 순환 참조의 원천을 차단한다.

---

## 3. 서재(Dashboard) 레이아웃 3단 대개혁

v5.0의 가장 큰 시각적 변화는 서재 화면의 **유기적 3단 수직 렌더링 파이프라인**이다. 각 섹션은 독립적으로 마운트되고 독립적인 ReactiveStore 구독을 통해 상태 변화에 반응한다.

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
│     이어읽기 플로팅 카드 슬라이드인 진입점             │
│     - store.libraryBooks 중 최근 열람 RECENT_MAX(3)개│
│     - 카드 슬라이드인 모션 (translateY + opacity)    │
│     - 카드 탭 → 즉시 해당 EPUB 재개                  │
├─────────────────────────────────────────────────────┤
│  ③ renderMainBooksGrid()                            │
│     도서 카드 그리드 또는 컴팩트 리스트 뷰             │
│     - store.sortMode: 'recent' | 'alpha' | 'tag'   │
│     - AbortController 기반 그리드 렌더 뮤텍스 보장   │
│     - VirtualGridRenderer 대량 도서 가상 렌더링       │
├─────────────────────────────────────────────────────┤
│  ④ ReadingReport HUD (showDashboardReport = true)   │
│     주간 독서 추이 / 오늘 목표 달성률 / 인사이트        │
│     → 설정창 스위치 OFF 시 즉시 언마운트              │
└─────────────────────────────────────────────────────┘
```

### 3-2. 섹션별 상세 명세

#### ① `renderSmartTagFolders()` — 스마트 태그 폴더 그리드

- **CSS Grid** 기반 고성능 태그 폴더 정렬. `grid-template-columns: repeat(auto-fill, minmax(80px, 1fr))` 형태로 화면 크기에 자동 적응
- `store.allTags` 배열의 변화를 구독하여 태그 폴더 그리드를 실시간 리렌더링
- 각 태그 폴더 카드는 `GENRE_TAGS` 기반 컬러 브랜딩 또는 커스텀 태그의 이름 해시 기반 앰버-세피아 계열 색상 자동 적용
- 폴더 클릭 시 `store.activeTags`에 해당 태그를 toggle 추가/제거 → `renderMainBooksGrid()`가 구독하여 필터 적용

#### ② `renderRecentBooks()` — 이어읽기 플로팅 카드 슬라이드인

- `RECENT_MAX = 3`개의 최근 읽은 도서를 독서 시간 역순으로 정렬하여 가로 슬라이드 카드로 렌더링
- 카드 진입 시 `translateY(20px) → translateY(0)` + `opacity: 0 → 1` 애니메이션 (stagger delay 적용)
- 표지 이미지가 없을 경우 HSL 플레이스홀더(제목 해시 기반 색상) 자동 생성

#### ③ `renderMainBooksGrid()` — 도서 카드 그리드

- **AbortController 뮤텍스**: 이전 렌더 루프가 완료되기 전 재호출 시 이전 작업을 즉시 중단(abort)하여 DOM 경쟁 상태 원천 차단
- **VirtualGridRenderer**: 100권 이상의 대량 도서 환경에서 뷰포트 외부 카드는 렌더링하지 않는 지연 로딩(IntersectionObserver 기반)
- **컴팩트 리스트 뷰**: 설정에서 토글 시 카드 그리드 → 1행 리스트 뷰로 전환 (`store.compactView` 구독)
- `store.librarySearch` 구독 → 제목/저자 실시간 필터링

---

## 4. 독서 리포트 HUD 토글 시스템

### 4-1. 개혁 배경

v4.x에서는 `ReadingReport` 컴포넌트가 뷰어 화면 내부에 고정 HUD로 표시되었다. v5.0에서는 이를 **서재 하단 섹션으로 이관**하여 독서 화면의 몰입감을 극대화하고, 사용자가 설정에서 리포트 표시 여부를 직접 제어할 수 있도록 리팩토링했다.

### 4-2. 리액티브 토글 메커니즘

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

### 4-3. 상태 흐름 시퀀스 (텍스트 다이어그램)

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
                               readingLog 데이터 집계 렌더링

스위치 OFF ──────────→  showDashboardReport = false
                                │
                                └──→ _flush() via rAF
                                          │
                                          ▼
                               unmountReadingReport()
                               #reading-report.remove()
─────────────────────────────────────────────────────────────────
```

> **설계 원칙**: `mountReadingReport()`와 `unmountReadingReport()`는 각각 DOM 삽입/제거 방식으로 처리하여 리포트가 비활성 상태일 때 `readingLog` 집계 연산이 완전히 비활성화되도록 보장한다. `display: none` 방식이 아닌 DOM 마운트/언마운트 방식을 채택하여 불필요한 메모리 점유를 원천 차단한다.

---

## 5. 지능형 장르 태그 시스템 & 3-Way 리액티브 바인딩

### 5-1. GENRE_TAGS 사전 정의 상수 (6종)

시스템 부팅 시(`_ensureSystemTags()` 호출) 아래 6종의 장르 태그가 `store.allTags`에 자동 주입된다. 이 태그들은 삭제 불가능한 시스템 태그로, 커스텀 태그와 병합되어 서재 태그 폴더를 구성한다.

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

커스텀 태그의 경우, 태그 이름 문자열의 해시값으로 **앰버-세피아 계열(Hue 25°~55°)** 색상을 동적 생성하여 Fable의 전반적 세피아 톤 브랜딩과 일관성을 유지한다.

### 5-2. 3-Way 리액티브 바인딩 원리

태그 시스템은 세 지점이 `store.allTags`라는 단일 상태를 통해 동기화되는 **3-Way 리액티브 바인딩** 패턴을 채택한다.

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

데스크톱 환경에서는 도서 카드를 태그 폴더 위로 드래그하여 태그를 즉시 매핑할 수 있다.

```
1. 도서 카드 드래그 시작 → dragstart 이벤트 → bookKey 전달
2. 태그 폴더 위 진입    → dragover 이벤트 → 폴더 하이라이트
3. 폴더에 드롭          → drop 이벤트
   → StorageSystem.updateBookTags(bookKey, [...existingTags, droppedTag])
   → IndexedDB books 스토어 tags 필드 업데이트
   → store.libraryBooks 갱신 → renderMainBooksGrid() 재호출
```

### 5-4. IndexedDB `multiEntry: true` 인덱스 기반 교차 쿼리

IndexedDB `books` 스토어의 `tags` 필드에는 `{ multiEntry: true }` 인덱스가 설정되어 있어, 단일 도서가 다중 태그를 가질 때 각 태그를 독립 인덱스 엔트리로 등록한다.

```js
// books 스토어 태그 인덱스 생성
bookStore.createIndex('tags', 'tags', { unique: false, multiEntry: true });

// 복합 태그 필터링 쿼리 예시 (태그A AND 태그B 교차 조회)
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

  // tagArray의 모든 태그를 보유한 도서만 반환 (AND 연산)
  return [...results.entries()]
    .filter(([, count]) => count === tagArray.length)
    .map(([bookKey]) => bookKey);
}
```

---

## 6. 모바일 다중 파일 임포트 브릿지 & 고급 파일시스템 큐

### 6-1. 모바일 샌드박스 한계 & 브릿지 아키텍처

`showDirectoryPicker` Web API는 Chromium 기반 데스크톱 브라우저에서만 안정적으로 동작하며, iOS Safari 및 Android WebView 환경에서는 샌드박스 보안 정책으로 인해 사용이 불가능하거나 불안정하다. v5.0에서는 이를 우회하기 위해 **HTML5 `<input type="file">` 브릿지 파이프라인**을 병행 도입했다.

```
┌─────────────────────────────────────────────────────────────┐
│  모바일 환경 감지 (userAgent 또는 maxTouchPoints > 0)         │
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
│    4. EPUB opf 메타데이터 파싱 → dc:subject 추출              │
│    5. 자동 장르 태그 매핑                                      │
│    6. StorageSystem.saveBook() 비동기 저장                   │
└─────────────────────────────────────────────────────────────┘
```

### 6-2. HashWorker & opf 메타데이터 자동 태깅 큐

`HashWorker`는 메인 스레드 블로킹 없이 백그라운드에서 EPUB 파일을 처리하는 Web Worker이다.

```js
// HashWorker 처리 흐름 (개념 코드)
async function processEpubImport(file) {
  const buffer = await file.arrayBuffer();

  // 1. SHA-256 해시 계산 (중복 방지)
  const hashArray = await crypto.subtle.digest('SHA-256', buffer);
  const fileHash  = Array.from(new Uint8Array(hashArray))
                         .map(b => b.toString(16).padStart(2, '0')).join('');

  // 2. JSZip으로 EPUB 압축 해제 → opf 파일 탐색
  const zip      = await JSZip.loadAsync(buffer);
  const opfEntry = Object.values(zip.files).find(f => f.name.endsWith('.opf'));
  const opfText  = opfEntry ? await opfEntry.async('text') : '';

  // 3. dc:subject 태그 정규식 추출
  const subjectMatches = [...opfText.matchAll(/<dc:subject[^>]*>(.*?)<\/dc:subject>/gi)];
  const subjectStr     = subjectMatches.map(m => m[1]).join(' ');

  // 4. 장르 패턴 매핑
  const autoTags = _detectGenreTags(subjectStr);
  // 예: '판타지', 'SF/미스터리' 자동 반환

  return { fileHash, autoTags };
}

// 장르 패턴 정의
const _GENRE_PATTERNS = [
  { tag: '판타지',      re: /판타지|fantasy|ファンタジー/i },
  { tag: '로맨스',      re: /로맨스|romance|연애/i },
  { tag: '무협',        re: /무협|martial|武俠/i },
  { tag: 'SF/미스터리', re: /sf|sci[- ]fi|미스터리|mystery|스릴러|thriller|공상과학/i },
  { tag: '현대판타지',  re: /현대\s*판타지|modern\s*fantasy/i },
  { tag: '일반소설',    re: /소설|novel|문학|literature/i },
];
```

### 6-3. `manifest.json` PWA Shortcuts 명세

Fable Premium v5.0은 홈 화면 아이콘 길게 누름(Android) 또는 우클릭(Desktop)으로 접근 가능한 2개의 빠른 바로가기를 제공한다.

| 바로가기명 | `short_name` | URL | 동작 |
|---|---|---|---|
| 최근 읽은 책 이어읽기 | 이어읽기 | `/?action=resume` | 마지막 열람 EPUB 즉시 재개 |
| 새 도서 추가 | 도서 추가 | `/?action=import` | 파일 임포트 UI 즉시 진입 |

`main.js` 부트스트랩 시 `URLSearchParams`로 `action` 파라미터를 파싱하여 해당 숏컷의 의도를 처리한다.

---

## 7. IndexedDB v6 스토어 명세

### 7-1. 오브젝트 스토어 구성

| 스토어명 | keyPath | 주요 인덱스 | 용도 |
|---|---|---|---|
| `books` | `bookKey` | `folderId`, `fileHash`(unique), `tags`(multiEntry), `seq` | EPUB 도서 메타데이터 + 진행률 + 표지 |
| `annotations` | `uuid` | `bookKey`, `pendingSync` | 하이라이트/메모 주석 + CRDT 동기화 큐 |
| `folders` | `id` | — | 폴더 계층 구조 |
| `readingLog` | `date` | — | 일별 독서 시간 로그 (분 단위) |
| `meta` | `key` | — | 내부 시퀀스 카운터, DB 메타 |

### 7-2. `books` 스토어 레코드 스키마

```js
{
  bookKey:      string,   // SHA-256 해시 기반 고유 키
  title:        string,   // EPUB 메타데이터 dc:title
  creator:      string,   // EPUB 메타데이터 dc:creator
  coverDataUrl: string,   // Base64 표지 이미지 또는 null
  fileHash:     string,   // 파일 무결성 SHA-256 해시 (유니크)
  folderId:     string,   // 소속 폴더 ID (null = 미분류)
  tags:         string[], // 장르/커스텀 태그 배열 (multiEntry 인덱스)
  progress:     number,   // 독서 진행률 0.0 ~ 1.0
  lastCFI:      string,   // 마지막 읽은 EPUB CFI 위치
  lastOpenedAt: number,   // 최근 열람 Unix 타임스탬프
  seq:          number,   // 내부 정렬용 시퀀스 번호
  sizeBytes:    number,   // 파일 크기 (Bytes)
  data:         string,   // EPUB ArrayBuffer → Base64 직렬화
}
```

### 7-3. Cascade Delete 보장

폴더 삭제 시 소속 도서 및 해당 도서의 모든 주석이 **단일 트랜잭션** 내에서 제거되어 고아 레코드(orphan records) 발생을 원천 차단한다.

```
deleteFolder(folderId)
  └─ 단일 readwrite 트랜잭션 열기
       ├─ folders 스토어 → folderId 레코드 삭제
       ├─ books 스토어 → folderId 인덱스 조회 → 해당 도서 전체 삭제
       │    └─ 각 bookKey에 대해
       │         └─ annotations 스토어 → bookKey 인덱스 조회 → 해당 주석 전체 삭제
       └─ 트랜잭션 커밋 (원자적 보장)
```

### 7-4. 300ms 디바운스 진행률 동기화

독서 중 CFI 위치가 변경될 때마다 즉시 DB에 쓰는 대신, **300ms 디바운스** 후 한 번만 기록하여 IndexedDB 쓰기 폭주를 방지한다.

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

`store.js`의 `ReactiveStore`는 ES6 `Proxy`를 사용하여 상태 변경을 감지하고, `requestAnimationFrame` 기반 배치 플러시로 불필요한 연속 리렌더링을 방지한다.

```js
// 상태 변경 → 자동 구독자 알림 흐름
store.someKey = newValue;
//       │
//       ▼ Proxy setter
//   target[key] = value;  (동등값 무시 최적화)
//   _notify(key);
//       │
//       ▼ _notify()
//   pendingKeys.add(key);
//   requestAnimationFrame(_flush);  (중복 방지: flushQueued 플래그)
//       │
//       ▼ _flush() (다음 프레임)
//   subscribers.get(key).forEach(fn => fn(newValue));
//   subscribers.get('*').forEach(fn => fn(key, newValue));  // 와일드카드
```

### 8-2. 주요 상태 키 레퍼런스 (v5.0 기준 전체 목록)

| 상태 키 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `book` | Object\|null | null | 현재 열린 EPUB book 인스턴스 |
| `rendition` | Object\|null | null | epub.js rendition 인스턴스 |
| `isViewerOpen` | boolean | false | 뷰어 화면 활성 여부 |
| `isTocOpen` | boolean | false | 목차 패널 활성 여부 |
| `isSettingsOpen` | boolean | false | 설정 패널 활성 여부 |
| `navBarsVisible` | boolean | true | 젠 모드 UI 표시 여부 |
| `fontSize` | number | 100 | 폰트 크기 (%) |
| `lineHeight` | string | 'normal' | 줄간격 ('narrow'\|'normal'\|'wide') |
| `theme` | string | 'paper' | 테마 ('paper'\|'dark'\|'sepia'\|'custom') |
| `flow` | string | 'paginated' | 레이아웃 ('paginated'\|'scrolled') |
| `fontFamily` | string | 'gowun' | 폰트 패밀리 |
| `libraryBooks` | Array | [] | 서재 도서 목록 |
| `allTags` | Array | [] | 전체 태그 목록 (장르 + 커스텀) |
| `activeTags` | Array | [] | 현재 활성 필터 태그 |
| `sortMode` | string | 'recent' | 정렬 모드 |
| `showDashboardReport` | boolean | false | 독서 리포트 HUD 표시 여부 |
| `readingLog` | Object | {} | 일별 독서 시간 로그 |
| `dailyGoalMin` | number | 30 | 일일 독서 목표 (분) |
| `measuredWpm` | number | 0 | 실시간 측정 WPM |
| `autoScrollWpm` | number | 250 | 자동 스크롤 목표 WPM |
| `autoScrollActive` | boolean | false | 자동 스크롤 활성 여부 |
| `eyeProtectActive` | boolean | false | 눈 보호 타이머 활성 여부 |
| `eyeProtectMinutes` | number | 50 | 연속 독서 한계 (분) |
| `pageTransition` | string | 'fade' | 페이지 전환 효과 ('fade'\|'slide'\|'flip3d') |
| `onboardingDone` | boolean | false | 온보딩 최초 완료 여부 |
| `fontWeightBoost` | number | 0 | E-Ink 폰트 굵기 보정 오프셋 |
| `contrastScale` | number | 1.0 | E-Ink 대비 스케일 |
| `crdtVectorClock` | Object | {} | CRDT OR-Set 벡터 클락 |
| `appInBackground` | boolean | false | 백그라운드 절전 신호 |
| `scrubberHoverPct` | number | -1 | 스크러버 미리보기 위치 (-1=비활성) |

---

## 9. ResourceRegistry & 스마트 GC 아키텍처

### 9-1. 자원 누수 제로 보장 (`releaseAll`)

Fable v5.0은 단일 페이지 애플리케이션(SPA)의 화면 전환 시 이전 화면의 모든 리소스가 완벽히 소멸되도록 `ResourceRegistry`를 통해 6가지 유형의 자원을 중앙 관리한다.

| 자원 유형 | 등록 메서드 | 소멸 방법 |
|---|---|---|
| DOM 이벤트 리스너 | `addListener(target, type, fn, opts)` | `removeEventListener` |
| ReactiveStore 구독 | `addStoreSub(unsubFn)` | `unsubFn()` |
| 타이머 | `addTimer(id)` | `clearTimeout` + `clearInterval` |
| ResizeObserver | `addResizeObserver(obs)` | `obs.disconnect()` |
| IntersectionObserver | `addIntersectionObserver(obs)` | `obs.disconnect()` |
| requestAnimationFrame | `addRaf(id)` | `cancelAnimationFrame` |

### 9-2. 서재 진입 시 스마트 GC 트리거

뷰어 화면에서 서재로 복귀할 때, 뷰어 모듈이 생성한 모든 리소스를 `releaseAll()`로 일괄 소멸시킨다. 이는 모바일 기기의 메모리 고갈을 방지하는 핵심 안전장치다.

```
[뷰어 → 서재 전환 이벤트]
          │
          ▼
  ui.js: showScreen('uploader')
          │
          ▼
  viewer.js: destroyCurrentRenditionContext()
          │
          ├─ store.rendition.destroy()   // epub.js 렌더러 소멸
          ├─ ResourceRegistry.releaseAll() // 모든 리소스 일괄 소멸
          │    ├─ DOM 이벤트 리스너 제거
          │    ├─ 스토어 구독 해제
          │    ├─ 타이머/rAF 취소
          │    ├─ ResizeObserver 해제
          │    └─ IntersectionObserver 해제
          ├─ store.book = null
          └─ store.isViewerOpen = false
```

### 9-3. 스마트 슬립 가드 (visibilitychange 기반)

앱이 백그라운드로 전환될 때(탭 전환, 화면 잠금 등) `store.appInBackground = true` 신호를 발행한다. WPM 트래커, 자동 스크롤 드라이버, 눈 보호 타이머 등 지속 실행 루프는 이 신호를 구독하여 rAF/타이머를 즉시 일시 정지, 불필요한 배터리 소모와 연산 낭비를 방지한다.

```js
// store.js 내 슬립 가드 (전역 설치)
document.addEventListener('visibilitychange', () => {
  store.appInBackground = document.visibilityState === 'hidden';
});

// 소비자 모듈 예시 (자동 스크롤 드라이버)
ReactiveStore.subscribe('appInBackground', (isBackground) => {
  if (isBackground) pauseAutoScroll();
  else              resumeAutoScroll();
});
```

---

## 10. PWA 메타데이터 & 아이콘 참조 관계

### 10-1. `public/manifest.json` 핵심 명세

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

| 필드 | 값 | 의미 |
|---|---|---|
| `background_color` | `#1f1a14` | 스플래시 화면 배경 (다크 세피아) |
| `theme_color` | `#c8864a` | 브라우저 UI 색상 (앰버 골드) |
| `display` | `standalone` | 브라우저 UI 없이 독립 앱 실행 |

### 10-2. `public/icon.svg` 참조 구조

`public/icon.svg`는 세피아 다크 베이스의 오픈북 메타포를 담은 Fable의 공식 벡터 아이콘으로, `manifest.json`에서 두 가지 목적(`any` + `maskable`)으로 중복 참조된다.

```json
"icons": [
  { "src": "/icon.svg", "sizes": "any",    "type": "image/svg+xml", "purpose": "any"       },
  { "src": "/icon.svg", "sizes": "512x512","type": "image/svg+xml", "purpose": "maskable"  }
]
```

- **`purpose: any`**: 일반 앱 아이콘 (투명 배경 SVG 원본)
- **`purpose: maskable`**: Android 어댑티브 아이콘 (안전 영역 내 콘텐츠 보장)
- SVG 포맷을 사용하므로 모든 해상도(HDPI, Retina)에서 무손실 렌더링 보장

### 10-3. FOUC 방지 뮤텍스 가드 (`index.html`)

`index.html` 최상단에는 DOM 파싱 전 동기적으로 실행되는 인라인 스크립트가 삽입되어 있다. 이 가드는 `localStorage`에서 테마 데이터를 동기 파싱하여 `document` 노드에 즉시 클래스/속성을 주입함으로써, EPUB 독자에게 치명적인 하얀 화면 깜빡임(FOUC: Flash of Unstyled Content)을 원천 차단한다.

```html
<head>
  <!-- FOUC 차단 뮤텍스 가드 — 반드시 최상단 유지 -->
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

## 11. 비주얼 이펙트 & 감성 디테일 (Visual FX Spec)

`src/ui/fx.css`는 Fable Premium v5.0의 비주얼 아이덴티티를 정의하는 전용 스타일시트로, 아래 이펙트들이 즉시 배포 가능한 프로덕션 상태로 구현되어 있다.

### 11-1. 비주얼 FX 클래스 & CSS 프로퍼티 매핑 테이블

| FX 이름 | 적용 클래스 | 핵심 CSS 프로퍼티 | 동작 설명 |
|---|---|---|---|
| 세피아 앰버 스켈레톤 웨이브 | `.fx-skeleton` | `@keyframes fable-sepia-wave` `background: linear-gradient(90deg, ...)` `animation: fable-sepia-wave 1.4s infinite` | 도서 카드 로딩 중 세피아→앰버→세피아 그라디언트 웨이브 펄스 |
| 컨텍스트 메뉴 글래스모피즘 팝오버 | `.fx-glass-popover` | `backdrop-filter: blur(12px)` `background: rgba(var(--sepia-base), 0.7)` `border: 1px solid rgba(255,255,255,0.12)` | 도서 카드 우클릭 메뉴의 반투명 블러 팝오버 |
| 목표 달성 앰버 파티클 세레머니 | `.fx-amber-particle` | `@keyframes particle-burst` `transform: translate() scale()` `opacity: 0→1→0` | 일일 독서 목표 달성 시 앰버 입자 가속도 제어 버스트 |
| 이어읽기 플로팅 카드 슬라이드인 | `.fx-slide-in-card` | `@keyframes card-slide-in` `transform: translateY(20px)→translateY(0)` `opacity: 0→1` | 서재 진입 시 최근 읽은 책 카드의 부드러운 등장 모션 |
| CSS Grid Flip 정렬 트랜지션 | `.fx-grid-item` | `transition: transform 350ms cubic-bezier(.4,0,.2,1)` `will-change: transform` | 태그 필터 변경 시 도서 카드 그리드 재배치 Flip 애니메이션 |
| 젠 모드 UI 페이드아웃 | `.zen-fade-out` | `transition: opacity 400ms ease` `opacity: 0` `pointer-events: none` | 2000ms 비활동 시 네비게이션 바 투명 소멸 |
| 3D 페이지 플립 전환 | `.page-flip3d` | `transform-style: preserve-3d` `@keyframes flip3d-turn` `perspective: 1200px` | 'flip3d' 모드 활성 시 책장 넘김 3D 원근 회전 |
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

### 11-4. 목표 달성 앰버 파티클 세레머니

목표 달성 순간, JavaScript에서 `fx-amber-particle` 클래스를 가진 DOM 엘리먼트를 동적 생성하여 방사형으로 배치한 뒤, CSS 애니메이션이 완료되면 자동 제거하는 **Zero-Overhead 세레머니 시스템**이다.

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

## 12. 컴파일 가드 & 배포 지침 (Build Guide)

### 12-1. 중복 Export 절대 금지 규칙 (Duplicate Export Guard)

Vite/Rollup은 동일 모듈 내 동일 식별자가 두 번 이상 export될 경우 **즉시 빌드를 실패**시킨다. 선언 방식을 무조건 단일화한다.

```js
// ❌ WRONG — 인라인 export + 하단 통합 export 중복
export function renderSmartTagFolders() { ... }  // 인라인 선언 export
export { renderSmartTagFolders };                // 하단 재export → 빌드 크래시

// ✅ CORRECT — 하나의 방식만 선택
// 방법 A: 인라인 export만 사용
export function renderSmartTagFolders() { ... }

// 방법 B: 통합 export만 사용
function renderSmartTagFolders() { ... }
export { renderSmartTagFolders };
```

### 12-2. 순환 참조 원천 차단 (Circular Dependency Prevention)

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

상위 컨텍스트(main.js)나 `store.js` 리액티브 구독 패턴을 매개로 처리하면 모듈 간 직접 참조 없이 상태 전이를 구현할 수 있다.

### 12-3. Vite 빌드 설정 (vite.config.js 핵심 포인트)

- **injectManifest 전략**: VitePWA 플러그인은 `sw.js`를 직접 컴파일하여 프리캐시 매니페스트를 자동 주입
- **수동 청크 분할**: `manualChunks`로 vendor(jszip, epubjs) / core(store, database, sync) / ui(viewer, uploader, settings) 청크를 분리하여 초기 로딩 페이로드 최소화
- **`public/` 디렉터리**: `_redirects`, `icon.svg`, `manifest.json`은 빌드 시 컴파일 없이 `dist/` 루트로 복사됨

### 12-4. Cloudflare Pages 배포 가드 (`_redirects`)

```
/* /index.html 200
```

이 단일 라인은 SPA 라우팅 시 Cloudflare Pages가 404를 반환하는 대신 `index.html`을 서빙하도록 강제한다. `public/_redirects` 파일이 없거나 내용이 변경되면 새로고침 시 앱이 404로 사멸한다.

### 12-5. 배포 전 최종 체크리스트

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

## 13. 보안 가드 & XSS 방어 레이어

### 13-1. textContent 우선 원칙

사용자 입력 데이터나 외부 소스(EPUB 메타데이터)에서 가져온 텍스트를 DOM에 삽입할 때는 **반드시 `textContent` 또는 `setTextSafe()` 헬퍼를 사용**한다. `innerHTML`의 직접 사용은 사용자 제공 EPUB 파일에 포함된 악성 스크립트 삽입 공격을 허용할 수 있다.

```js
// store.js 내 XSS 방어 헬퍼
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

### 13-2. v4.2 유실 방지 가드 (반드시 보존)

아래 두 가드는 사용자 경험 보호를 위한 **필수 보존 스펙**으로, 어떠한 리팩토링에서도 제거되어서는 안 된다.

1. **스페이스바 단축키 입력 가드**: 텍스트 입력 필드(`input`, `textarea`)에 포커스가 있을 때 스페이스바 키가 페이지 전환 단축키로 오인식되지 않도록 이벤트 버블링을 차단한다.

2. **TTS 재생 중 스크러버 조작 차단**: 텍스트 음성 변환(TTS)이 재생 중일 때 독자가 스크러버를 드래그하면 TTS 오디오가 현재 위치와 불일치하는 버그가 발생한다. 이를 방지하기 위해 TTS 활성 상태(`store.ttsActive`)에서는 스크러버 인터랙션을 블로킹한다.

### 13-3. `_bootstrapFable` 전역 예외 경계

`main.js`의 최상위 부트스트랩 함수 `_bootstrapFable`은 `try-catch`로 래핑되어, 초기화 과정의 어떠한 예외도 앱 전체 사멸(unhandled rejection)을 유발하지 않도록 격리한다. 예외 발생 시 `ErrorBoundary.handle('global', err)`를 통해 Toast 알림으로 우아하게 강등(graceful degradation)된다.

---

## 부록: 모듈별 핵심 Export 인덱스

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

*문서 버전: v5.0.0 | 최종 수정: 서재 대개혁 대통합 배포 기준*
