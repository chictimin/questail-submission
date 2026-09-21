/**
 * 에이전트 계층 타입 계약.
 *
 * questail-collie(아이펠 과제 제출물, 2026-09-18 `20eb941` 에서 동결)에서 이식했다.
 * 이식하며 바꾼 두 가지가 이 파일의 핵심이다.
 *
 * 1. **파일시스템을 모른다.** collie 의 도구 계층은 `data/mock/games/` 를 직접
 *    readdir 했다. core 는 배포물이라 특정 디렉터리 구조를 알면 안 된다 —
 *    게임 노트는 `AgentDeps.notes` 로 주입받는다. 경로 해석은 앱의 일이다.
 * 2. **근거 문서 id 가 열린 문자열이다.** collie 의 `DocId` 는 `D-A`~`D-F` 고정
 *    유니온이었다. 그 집합은 collie 문서 구성이지 core 의 것이 아니다.
 */

import type { LibraryIndex, TasteProfile } from '../types.js';

// ── 질의 분류 ───────────────────────────────────────────────────────────────

export type QueryCategory =
  | 'HISTORY' // 보유·플레이타임·마지막 플레이·업적률
  | 'TASTE' // 상위 장르·플레이타임 분포·위시 경향
  | 'SUBJECTIVE' // 별점·상태·기피 사유
  | 'DATA_OPS' // 왜 비었나·언제 갱신됐나·자동/수기 구분
  | 'OUT_OF_SCOPE'; // 공략·시세·미보유 게임 평가

export const CATEGORIES: readonly QueryCategory[] = [
  'HISTORY',
  'TASTE',
  'SUBJECTIVE',
  'DATA_OPS',
  'OUT_OF_SCOPE',
] as const;

// ── 근거 ────────────────────────────────────────────────────────────────────

/**
 * 근거 문서 식별자. 앱이 정한다.
 * collie 는 `D-A`~`D-F` 를 썼고 그 표기는 인용 검사 기본 패턴으로 남아 있다.
 */
export type DocId = string;

export interface EvidenceChunk {
  /** 안정적인 인용 키. 예: 'D-D#업적-데이터' */
  id: string;
  docId: DocId;
  /** 이 청크를 근거로 쓰는 카테고리(복수 가능) */
  categories: QueryCategory[];
  heading: string;
  text: string;
}

// ── 도구 ────────────────────────────────────────────────────────────────────

export type ToolName =
  | 'lookup_library'
  | 'get_game_note'
  | 'get_taste_profile'
  | 'search_docs'
  | 'get_achievement_stats'
  | 'get_wishlist'
  | 'find_rating_playtime_gaps'
  | 'get_field_coverage'
  | 'describe_schema'
  | 'escalate';

export interface ToolCall {
  tool: ToolName;
  args: Record<string, unknown>;
  /** 이 호출이 실제로 끌어온 근거 청크 id 목록 */
  chunkIds: string[];
}

// ── 분류 결과 ───────────────────────────────────────────────────────────────

/**
 * 질의 분류기의 산출물. **분류기 자체는 core 에 없다** — LLM 프롬프트에 묶여 있어
 * 앱에 남는다(T3). core 가 이 타입을 갖는 이유는 `routeQuestion` 의 입력이기
 * 때문이다. 즉 이것은 앱 분류기와 core 라우터 사이의 계약이다.
 *
 * 라우터가 실제로 읽는 것은 `category` 와 `gameTitles` 둘뿐이다.
 * `confidence` · `reason` 은 앱의 이관(escalate) 판단과 로깅 몫이지만,
 * 앱이 분류 결과를 그대로 넘길 수 있도록 원형을 유지한다.
 */
export interface ClassifyResult {
  category: QueryCategory;
  /** 0~1. 임계값 미만이면 이관한다 — 분류와 이관 판단은 분리한다 */
  confidence: number;
  reason: string;
  /**
   * 질문에 등장하는 게임의 라이브러리 정식 표기.
   * 전사(해석)는 LLM 이, 검증은 라우터가 한다 — 이 배열은 후보일 뿐이며
   * 인덱스에 없는 표기는 라우터가 버린다. 없으면 빈 배열이다.
   */
  gameTitles: string[];
}

// ── 게임 노트 ───────────────────────────────────────────────────────────────

/**
 * 게임 1건의 주관 필드 항목.
 *
 * core 는 이 배열을 **받기만 한다**. md 를 읽어 이 모양으로 만드는 것은 앱이며,
 * 파싱 자체는 core 의 `parseGameNote` · `extractSubjectiveFields` 를 쓰면 된다.
 */
export interface NoteEntry {
  title: string;
  gameId: string;
  rating?: number;
  status?: string;
  note?: string;
  dislikeReasons?: string[];
}

// ── 검증 ────────────────────────────────────────────────────────────────────

export type ViolationRule =
  | 'UNGROUNDED_NUMBER' // 근거 스니펫에 없는 숫자를 답변이 주장
  | 'UNKNOWN_GAME' // library 에 없는 게임명을 사실처럼 언급
  | 'CITED_WHILE_OUT_OF_SCOPE'; // OUT_OF_SCOPE 인데 근거를 인용

export interface Violation {
  rule: ViolationRule;
  detail: string;
}

export interface VerifyResult {
  passed: boolean;
  violations: Violation[];
}

export interface VerifyOptions {
  /**
   * 답변 속 근거 인용 표기를 잡는 패턴. 기본값은 collie 표기(`D-A`~`D-F`)다.
   * 다른 문서 체계를 쓰는 앱은 여기서 갈아끼운다.
   */
  citationPattern?: RegExp;
}

// ── 의존성 주입 ─────────────────────────────────────────────────────────────

/**
 * 도구·라우터가 필요로 하는 전부. 앱이 조립해 주입한다.
 *
 * collie 의 `CollieDeps` 에서 `callLlm` · `onStep` · `confidenceThreshold` 를 뺐다 —
 * 그 셋은 그래프(앱 계층)의 관심사이고, 이식 대상인 도구·라우터는 LLM 을 호출하지 않는다.
 * 대신 `notes` 가 들어왔다. collie 에서는 모듈 전역 캐시 뒤에 숨어 있던 값이다.
 */
export interface AgentDeps {
  library: LibraryIndex;
  profile: TasteProfile;
  /** 근거 문서를 청킹한 전체 집합 */
  chunks: EvidenceChunk[];
  /** 게임별 주관 노트 전량. 앱이 읽어서 넣는다 */
  notes: NoteEntry[];
  /**
   * canonical 영문 장르명 → 한국어 별칭 목록 (D9 영문화 이후 한국어 질의 연결용).
   * 앱이 `tools/genre-ko.json` 단일 정본에서 조립해 주입한다.
   * core는 JSON·파일시스템을 직접 읽지 않는다.
   * 없으면 canonical 직접 매칭만 한다(하위 호환).
   */
  genreAliases?: Record<string, string[]>;
}
