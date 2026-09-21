/**
 * 공유 타입 계약 — M2 Phase 0에서 고정.
 *
 * 워커는 이 파일을 수정하지 않는다. 계약 변경이 필요하면 오케스트레이터에게 먼저 알린다.
 * 근거: obsidian vault ai/sessions/2026-09-16-1146-handoff.md
 */

// ─── 게임 원장 (객관 데이터) ─────────────────────────────────

export type GameSource = 'auto' | 'manual';
export type Platform = 'steam' | 'psn' | 'xbox' | 'manual';

export interface NormalizedGame {
  /** 플랫폼 내 식별자 (e.g. Steam appId) */
  id: string;
  /** 플랫폼 식별자 */
  platform: Platform;
  /** 게임 제목 */
  title: string;
  /** 한국어 표시명. games 노트의 title_ko 파생 사본으로만 저장한다 (D9) */
  titleKo?: string;
  /** 데이터 출처 */
  source: GameSource;
  /** 총 플레이타임 (분) */
  playtimeMinutes: number;
  /** 업적 달성률 (0–100) */
  achievementPercent?: number;
  /** 마지막 플레이 일시 (Unix timestamp) */
  lastPlayedAt?: number;
  /** 게임 커버 이미지 URL */
  imageUrl?: string;
  /** 장르 태그 목록 */
  genres?: string[];
  /** 개발사 (D5: appdetails 승격) */
  developers?: string[];
  /** 퍼블리셔 (D5: appdetails 승격) */
  publishers?: string[];
  /** 출시일 (D5: appdetails 승격, 문자열 그대로 보존) */
  releaseDate?: string;
  /** 위시리스트 여부 (postie IWishlistService 승격) */
  wishlisted?: boolean;
}

/** appdetails 등 메타 소스에서 가져오는 원본 보강 데이터 (D5·D9·D10·D11) */
export interface GameMeta {
  appId: string;
  /** 스토어 표시명 — 영어 정본 (D9) */
  name?: string;
  /** 한국어 표시명. ko 응답 name에 한글이 있을 때만 채운다 (D9 title_ko, 실측 19/120건) */
  nameKo?: string;
  /** 지원 플랫폼 (appdetails data.platforms에서 true인 키만) */
  platforms?: string[];
  /** 장르 — 영문 정본 + 로케일 무관 id (D9). id는 ko 매핑표의 키다 */
  genres?: { id: string; name: string }[];
  developers?: string[];
  publishers?: string[];
  /** ISO 8601 날짜 (D9). 파싱 실패 시 undefined */
  releaseDate?: string;
  /** 스토어 원문 날짜 문자열 (en). 파싱 실패 진단용 */
  releaseDateRaw?: string;
  headerImage?: string;
  /** categories 3축 분해 (D11). 축에 속하지 않는 값은 파생에서 버린다 */
  categoryAxes?: {
    /** 플레이 형태 — 싱글·멀티·협동·PvP 등 */
    playMode: string[];
    /** 입력 방식 — 컨트롤러 지원 수준·VR 등 */
    input: string[];
    /** 기기/원격 — Remote Play·클라우드 등 */
    device: string[];
  };
  /** SteamSpy 유저 태그 상위 10 + 투표 수 (D10). 캐시 전용, 픽스처 커밋 금지 */
  userTags?: { tag: string; votes: number }[];
}

/**
 * games/*.md 노트에만 존재하는 주관 필드 (D1 필드 단위 보존 규칙).
 * library.md(객관 정본)에는 실리지 않는다.
 */
export interface SubjectiveGameFields {
  /** 0.5 단위 5점(10단계). 수기 전용, 입력은 M3 웹 UI 책임 */
  rating?: number;
  /** 한줄평 */
  note?: string;
  /** 기피 사유 */
  dislikeReasons?: string[];
  status?: 'playing' | 'completed' | 'dropped' | 'wishlist';
}

/** library.md 1개 — 객관 데이터 정본 (D1) */
export interface LibraryIndex {
  generatedAt: number;
  games: NormalizedGame[];
}

/** history.jsonl 한 줄 — 스냅샷 로그 (D1-a, 정본 아님·재생성 불가) */
export interface HistoryRecord {
  ts: number;
  gameId: string;
  platform: Platform;
  playtimeMinutes: number;
}

// ─── 취향 프로필 (profile/) ─────────────────────────────────

/** 라이브러리·위시·플레이타임 → 취향 프로필. analyze와 postie의 공유 입력 */
export interface TasteProfile {
  topGenres: { genre: string; weight: number }[];
  dislikedGenres?: string[];
  playtimeDistribution: { min: number; q1: number; median: number; q3: number; max: number };
  wishlistAppIds?: string[];
  /** 플레이타임(간접 신호)과 별점(직접 신호)의 갭 — 강렬했던 게임 / 습관적으로 붙잡은 게임 판별 */
  ratingPlaytimeGaps?: { gameId: string; gap: number }[];
}

// ─── LLM (D3: 단일 엔드포인트 + 무LLM 폴백) ─────────────────

export interface LlmOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /**
   * 추가 HTTP 헤더 (예: 게이트웨이 라우팅·캐싱용 식별자).
   * callLlm이 기본 헤더에 병합하되 authorization·content-type은 덮어쓰지 않는다.
   * 옵셔널이라 미지정 시 기존 동작 그대로다.
   */
  headers?: Record<string, string>;
  /**
   * 샘플링 온도 (예: 0 = 결정적 출력).
   * 지정된 경우에만 요청 바디에 실린다.
   * 옵셔널이라 미지정 시 기존 동작 그대로다.
   */
  temperature?: number;
}
