/**
 * 실제 실행되는 도구 9종. 전부 AgentDeps 주입 데이터에서 조회하며 외부 I/O는 없다.
 * 호출되지 않은 도구는 기록에 남지 않는다.
 *
 * questail-collie `src/nodes/tools.ts`(동결 `20eb941`)에서 이식했다.
 * 이식하며 바뀐 점 하나: collie 는 게임 노트를 디스크(`data/mock/games/`)에서
 * readdir 해 모듈 전역 캐시에 담았으나, core 는 파일시스템을 모르므로
 * 노트 전량을 `AgentDeps.notes` 로 주입받는다. `gamesDir` · `loadNoteEntries` ·
 * `noteCache` 는 사라지고, `findNoteEntry(titleOrAppid, notes)` 는 동기 순수 함수다.
 */

import type {
  AgentDeps,
  EvidenceChunk,
  NoteEntry,
  QueryCategory,
  ToolName,
} from './types.js';
import type { LibraryIndex, NormalizedGame, TasteProfile } from '../types.js';

export interface SelectedCall {
  tool: ToolName;
  args: Record<string, unknown>;
}

/** 공백 제거·소문자 정규화. "엘든링"과 "엘든 링"을 같은 것으로 본다. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** 제목이 키워드를 포함하면 매칭. 역방향(키워드가 제목을 포함)은 쓰지 않는다 —
    "Hades II" 조회가 "Hades" 행을 끌어오는 식의 오접근을 막기 위함이다. */
function titleMatches(title: string, keyword: string): boolean {
  const t = norm(title);
  const k = norm(keyword);
  if (t === '' || k === '') return false;
  return t.includes(k);
}

/** Unix timestamp(초·밀리초 자동 판별)를 YYYY-MM-DD로. renderRow와 같은 기준. */
function formatIndexTs(ts: number): string {
  const ms = ts > 4102444800 ? ts : ts * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** 라이브러리 기준 시각 한 줄. 갱신 시점 질문(C4-02)의 근거다. */
function generatedAtLine(library: LibraryIndex): string {
  return `라이브러리 기준 시각(generated_at): ${formatIndexTs(library.generatedAt)} (${library.generatedAt})`;
}

/**
 * 플레이타임(분) 단일 표기. 분과 시간(약, 내림)을 함께 남긴다.
 * verify의 checkUngroundedNumbers가 답변 속 숫자를 근거 문자열에서 대조하므로
 * 시간 표기(예: 347)가 근거에 없으면 "몇 시간" 정답이 위반으로 잡힌다 (C1-01).
 * 0 이하·비유한 값은 기존 표기(`${minutes}분`) 그대로 둔다 — 없던 문구를 만들지 않는다.
 * 분→시간 환산은 이 함수가 유일한 출처다. 렌더 지점은 직접 나누지 말고 이 함수를 쓴다.
 */
function formatPlaytimeMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return `${minutes}분`;
  return `${minutes}분(약 ${Math.floor(minutes / 60)}시간)`;
}

function renderRow(g: NormalizedGame): string {
  const parts = [`${g.title} (${g.platform}/${g.id})`, `플레이타임 ${formatPlaytimeMinutes(g.playtimeMinutes)}`];
  if (g.achievementPercent !== undefined) parts.push(`업적 ${g.achievementPercent}%`);
  if (g.genres && g.genres.length > 0) parts.push(`장르 ${g.genres.join(', ')}`);
  if (g.lastPlayedAt !== undefined) {
    // lastPlayedAt 정본은 초 단위(Unix timestamp). 2100년을 넘는 값만
    // 밀리초 오기입으로 보고 예외 처리한다. 표시는 YYYY-MM-DD로 통일.
    const ms = g.lastPlayedAt > 4102444800 ? g.lastPlayedAt : g.lastPlayedAt * 1000;
    parts.push(`마지막 플레이 ${new Date(ms).toISOString().slice(0, 10)}`);
  }
  return parts.join(' | ');
}

// ── lookup_library ──────────────────────────────────────────────────────────

export interface LookupArgs {
  titleOrKeyword?: string;
  genre?: string;
  emptyGenre?: boolean;
  topByPlaytime?: number;
  /**
   * topByPlaytime의 정렬 방향. 'desc'(기본)는 최다 플레이, 'asc'는 최소 플레이다.
   * 방향이 없으면 "가장 적게 플레이한 게임"이 최다 플레이 게임으로 뒤집힌다.
   */
  playtimeOrder?: 'asc' | 'desc';
}

function parseLookupArgs(args: Record<string, unknown>): LookupArgs {
  const out: LookupArgs = {};
  const kw = strArg(args, 'titleOrKeyword');
  if (kw) out.titleOrKeyword = kw;
  const genre = strArg(args, 'genre');
  if (genre) out.genre = genre;
  if (args.emptyGenre === true) out.emptyGenre = true;
  const top = args.topByPlaytime;
  if (typeof top === 'number' && Number.isFinite(top) && top > 0) {
    out.topByPlaytime = Math.min(50, Math.floor(top));
  }
  const order = strArg(args, 'playtimeOrder');
  if (order === 'asc' || order === 'desc') out.playtimeOrder = order;
  return out;
}

/** 적용된 필터를 사람이 읽는 한 줄로 만든다 (근거의 모수 표기용). */
function describeLookupArgs(args: LookupArgs): string {
  const parts: string[] = [];
  if (args.titleOrKeyword) parts.push(`제목/키워드 "${args.titleOrKeyword}"`);
  if (args.genre) parts.push(`장르 ${args.genre}`);
  if (args.emptyGenre) parts.push('장르 결측');
  if (args.topByPlaytime !== undefined) {
    const dir = args.playtimeOrder === 'asc' ? '가장 적은' : '가장 많은';
    parts.push(`플레이타임 ${dir} 순 상위 ${args.topByPlaytime}건`);
  }
  return parts.length > 0 ? parts.join(', ') : '없음';
}

/**
 * 매칭된 행만 반환한다. 필터가 하나도 없으면 빈 결과를 낸다
 * (전체 테이블 반환 금지).
 */
export function runLookupLibrary(
  rawArgs: Record<string, unknown>,
  library: LibraryIndex,
  category: QueryCategory,
): EvidenceChunk[] {
  const args = parseLookupArgs(rawArgs);
  let rows = library.games;
  if (args.titleOrKeyword) {
    const kw = args.titleOrKeyword;
    // 정확일치 우선: 키워드와 완전히 같은 제목이 있으면 그것만 쓴다.
    // ("Hades II" 조회가 "Hades" 행을 끌어오는 식의 오접근 방지)
    const exact = rows.filter((g) => norm(g.title) === norm(kw));
    rows = exact.length > 0
      ? exact
      : rows.filter((g) => titleMatches(g.title, kw));
  }
  if (args.genre) {
    const ng = norm(args.genre);
    rows = rows.filter((g) => (g.genres ?? []).some((x) => {
      const nx = norm(x);
      return nx.includes(ng) || ng.includes(nx);
    }));
  }
  if (args.emptyGenre) {
    rows = rows.filter((g) => !g.genres || g.genres.length === 0);
  }
  if (args.topByPlaytime !== undefined) {
    const asc = args.playtimeOrder === 'asc';
    const sorted = [...rows].sort((a, b) =>
      asc ? a.playtimeMinutes - b.playtimeMinutes : b.playtimeMinutes - a.playtimeMinutes);
    const n = Math.min(args.topByPlaytime, sorted.length);
    // 동률은 자르지 않는다. 0분 게임이 여러 개인데 "가장 적은 게임"으로
    // 임의의 한 건만 답하면 근거가 답을 확정하지 못한다. 상한 50건.
    let end = n;
    const boundary = n > 0 ? sorted[n - 1].playtimeMinutes : undefined;
    while (end < sorted.length && end < 50 && sorted[end].playtimeMinutes === boundary) end++;
    rows = sorted.slice(0, end);
  }
  const id = (i: number): string => `D-A#lookup:${i}`;
  if (rows.length === 0) {
    return [{
      id: id(0),
      docId: 'D-A',
      categories: [category],
      heading: '라이브러리 조회 결과 없음',
      text: `lookup_library: 전체 보유 ${library.games.length}건 중 조건에 맞는 게임이 없다 (조건: ${describeLookupArgs(args)})`,
    }];
  }
  const capped = rows.slice(0, 20);
  const more = rows.length > capped.length ? `\n외 ${rows.length - capped.length}건 생략` : '';
  // 모수(전체 보유 수)와 필터 조건을 근거에 함께 남긴다.
  // 이게 없으면 답변 LLM이 "조회 1건"을 "라이브러리에 1개뿐"으로 읽는다.
  const total = library.games.length;
  const scope = `전체 보유 ${total}건 중 조건에 맞는 ${rows.length}건 (조건: ${describeLookupArgs(args)})`;
  return [{
    id: id(0),
    docId: 'D-A',
    categories: [category],
    heading: `라이브러리 조회 ${rows.length}건 / 전체 ${total}건`,
    text: `${scope}\n${capped.map(renderRow).join('\n')}${more}\n${generatedAtLine(library)}`,
  }];
}

// ── 게임명 정규화 (라우터 규칙 2) ────────────────────────────────────────────
// 라이브러리 인덱스만 쓴다. 정확일치(질문이 인덱스 제목을 포함 — 긴 제목 우선) >
// 부분일치(질문의 숫자 토큰이 정확히 하나의 제목에만 들어 있음) > 실패(null).
// 한글→영문 별칭표 같은 것은 두지 않는다 — 인덱스에 없는 대응은 만들지 않는다.

export interface ResolvedGame {
  title: string;
  gameId: string;
  kind: 'exact' | 'partial';
}

function digitTokens(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/[0-9]+(?:\.[0-9]+)?/g)) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

export function resolveGameReference(question: string, library: LibraryIndex): ResolvedGame | null {
  // 정확일치: 질문 속 라틴 문자 span 전체가 인덱스 제목과 같을 때만.
  // 부분 문자열 매칭은 "Hades II" 언급을 "Hades"로 오접근하므로 쓰지 않는다.
  const spans = question.match(/[A-Za-z0-9'’\-]+(?: +[A-Za-z0-9'’\-]+)*/g) ?? [];
  let best: NormalizedGame | null = null;
  for (const span of spans) {
    const ns = norm(span);
    for (const g of library.games) {
      if (norm(g.title) === ns && (!best || norm(best.title).length < ns.length)) best = g;
    }
  }
  if (best) return { title: best.title, gameId: best.id, kind: 'exact' };
  const digits = digitTokens(question);
  if (digits.length > 0) {
    const cands = library.games.filter((g) => digits.every((d) => g.title.includes(d)));
    if (cands.length === 1 && cands[0]) {
      return { title: cands[0].title, gameId: cands[0].id, kind: 'partial' };
    }
  }
  return null;
}

/**
 * LLM 후보 표기의 인덱스 검증 (계약 v3). 후보와 완전히 같은 제목이 인덱스에
 * 있을 때만 정식 표기를 돌려준다. 없으면 null — 라우터는 문자열 매칭으로 폴백한다.
 */
export function findLibraryTitle(candidate: string, library: LibraryIndex): string | null {
  const nc = norm(candidate);
  if (nc === '') return null;
  const hit = library.games.find((g) => norm(g.title) === nc);
  return hit ? hit.title : null;
}

// ── get_game_note ───────────────────────────────────────────────────────────
// 노트는 주입받는다. md 를 읽어 NoteEntry 로 만드는 것은 앱의 일이다
// (core 의 parseGameNote · extractSubjectiveFields 를 쓰면 된다).

/** 게임 1건의 주관 필드 항목. 없으면 null (라우터의 필드 단위 결측 판정용). */
export function findNoteEntry(titleOrAppid: string, notes: NoteEntry[]): NoteEntry | null {
  const q = titleOrAppid.trim();
  if (q === '') return null;
  // game_id 정확일치 > 제목 정확일치 > 제목 부분일치.
  // ("Hollow Knight" 조회가 "Hollow Knight: Silksong" 노트를 잡는 오접근 방지)
  const byId = notes.find((e) => e.gameId !== '' && e.gameId === q);
  if (byId) return byId;
  const exact = notes.find((e) => e.title !== '' && norm(e.title) === norm(q));
  if (exact) return exact;
  return notes.find(
    (e) => e.title !== '' && titleMatches(e.title, q),
  ) ?? null;
}

/** 해당 게임 1건의 주관 필드만 반환. 없으면 "노트 없음". */
export function runGameNote(
  rawArgs: Record<string, unknown>,
  notes: NoteEntry[],
  category: QueryCategory,
): EvidenceChunk[] {
  const q = strArg(rawArgs, 'titleOrAppid') ?? '';
  const hit = findNoteEntry(q, notes);
  const mk = (heading: string, text: string): EvidenceChunk => ({
    id: `D-B#note:${norm(hit?.title ?? q) || 'unknown'}`,
    docId: 'D-B',
    categories: [category],
    heading,
    text,
  });
  if (!hit) return [mk('노트 없음', `get_game_note: "${q}"에 해당하는 게임 노트가 없다`)];
  const lines = [`${hit.title} 노트`];
  if (hit.rating !== undefined) lines.push(`별점: ${hit.rating}`);
  if (hit.status !== undefined) lines.push(`상태: ${hit.status}`);
  if (hit.note !== undefined) lines.push(`한줄평: ${hit.note}`);
  if (hit.dislikeReasons !== undefined) lines.push(`기피 사유: ${hit.dislikeReasons.join(', ')}`);
  if (lines.length === 1) lines.push('주관 기록 없음');
  return [mk(`${hit.title} 주관 기록`, lines.join('\n'))];
}

// ── get_taste_profile ───────────────────────────────────────────────────────

export function runTasteProfile(profile: TasteProfile, category: QueryCategory): EvidenceChunk[] {
  const lines = ['취향 프로필 요약'];
  lines.push(`상위 장르: ${profile.topGenres.slice(0, 5).map((g) => `${g.genre} ${g.weight}`).join(', ')}`);
  const d = profile.playtimeDistribution;
  lines.push(`플레이타임 분포(분): 최소 ${d.min} · Q1 ${d.q1} · 중앙 ${d.median} · Q3 ${d.q3} · 최대 ${d.max}`);
  lines.push(`위시리스트: ${profile.wishlistAppIds?.length ?? 0}건`);
  if (profile.dislikedGenres && profile.dislikedGenres.length > 0) {
    lines.push(`기피 장르: ${profile.dislikedGenres.join(', ')}`);
  }
  if (profile.ratingPlaytimeGaps && profile.ratingPlaytimeGaps.length > 0) {
    lines.push(
      `별점-플레이 갭 상위: ${profile.ratingPlaytimeGaps.slice(0, 3).map((g) => `${g.gameId} ${g.gap}`).join(', ')}`,
    );
  }
  return [{
    id: 'D-C#profile',
    docId: 'D-C',
    categories: [category],
    heading: '취향 프로필',
    text: lines.join('\n'),
  }];
}

// ── search_docs ─────────────────────────────────────────────────────────────

function parseKeywords(rawArgs: Record<string, unknown>): string[] {
  const v = rawArgs.keywords;
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const k of v) {
    if (typeof k === 'string' && k.trim() !== '' && !out.includes(k.trim())) out.push(k.trim());
    if (out.length >= 8) break;
  }
  return out;
}

/** 카테고리 1차 필터 후 키워드 점수 상위 3청크만. 카테고리 전체 투입 금지. */
export function runSearchDocs(
  rawArgs: Record<string, unknown>,
  deps: AgentDeps,
  category: QueryCategory,
): EvidenceChunk[] {
  const keywords = parseKeywords(rawArgs).map((k) => k.toLowerCase());
  if (keywords.length === 0) return [];
  const scored = deps.chunks
    .filter((c) => c.categories.includes(category))
    .map((c) => {
      const hay = `${c.heading}\n${c.text}`.toLowerCase();
      let score = 0;
      for (const k of keywords) {
        let i = hay.indexOf(k);
        while (i >= 0) {
          score++;
          i = hay.indexOf(k, i + k.length);
        }
      }
      return { c, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return scored.map((s) => s.c);
}

// ── get_achievement_stats ───────────────────────────────────────────────────
// 업적 달성률은 라이브러리 행의 achievement_pct에만 있다. 현재 데이터는 전량
// 공백이므로 "수집 없음" 청크가 정상 출력이다 (0%와 혼동하지 않는다).

export const ACHIEVEMENT_EMPTY_HEADING = '업적 달성률 없음';

function achievementRows(titleOrKeyword: string | undefined, library: LibraryIndex): NormalizedGame[] {
  if (!titleOrKeyword) return library.games;
  return library.games.filter((g) => titleMatches(g.title, titleOrKeyword));
}

export function runAchievementStats(
  rawArgs: Record<string, unknown>,
  library: LibraryIndex,
  category: QueryCategory,
): EvidenceChunk[] {
  const kw = strArg(rawArgs, 'titleOrKeyword');
  const rows = achievementRows(kw, library);
  const scope = kw ?? '전 게임';
  const valued = rows.filter((g) => g.achievementPercent !== undefined);
  if (valued.length === 0) {
    return [{
      id: 'D-A#achievement:missing',
      docId: 'D-A',
      categories: [category],
      heading: ACHIEVEMENT_EMPTY_HEADING,
      text: `get_achievement_stats: ${scope}의 업적 달성률은 수집되어 있지 않다 (조회 ${rows.length}건 모두 공백)`,
    }];
  }
  const lines = valued.slice(0, 20).map((g) => `${g.title}: 업적 달성률 ${g.achievementPercent}%`);
  if (valued.length > 20) lines.push(`외 ${valued.length - 20}건 생략`);
  return [{
    id: 'D-A#achievement:hit',
    docId: 'D-A',
    categories: [category],
    heading: `업적 달성률 ${valued.length}건`,
    text: lines.join('\n'),
  }];
}

/** 업적 조회가 결측인가. 라우터 규칙 3의 판정용 (값이 하나도 없을 때만 true). */
export function isAchievementMissing(library: LibraryIndex, titleOrKeyword?: string): boolean {
  return achievementRows(titleOrKeyword, library).every((g) => g.achievementPercent === undefined);
}

// ── get_wishlist ────────────────────────────────────────────────────────────
// 찜 membership의 정본은 취향 프로필의 wishlistAppIds다. 제목 표기는 게임 노트에서
// 메기고, 노트가 없으면 라이브러리·없으면 appId 그대로 둔다.

export const WISHLIST_EMPTY_HEADING = '위시리스트 없음';

export function runWishlistSync(
  profile: TasteProfile,
  titleOf: (gameId: string) => string,
  category: QueryCategory,
): EvidenceChunk[] {
  const ids = profile.wishlistAppIds ?? [];
  if (ids.length === 0) {
    return [{
      id: 'D-C#wishlist:missing',
      docId: 'D-C',
      categories: [category],
      heading: WISHLIST_EMPTY_HEADING,
      text: 'get_wishlist: 위시리스트가 비어 있다',
    }];
  }
  const names = ids.map(titleOf);
  const shown = names.slice(0, 20).join(', ');
  const more = names.length > 20 ? `\n외 ${names.length - 20}건 생략` : '';
  return [{
    id: 'D-C#wishlist',
    docId: 'D-C',
    categories: [category],
    heading: `위시리스트 ${ids.length}건`,
    text: `위시리스트: ${ids.length}건 담겨 있다\n${shown}${more}`,
  }];
}

export function runWishlist(
  profile: TasteProfile,
  notes: NoteEntry[],
  category: QueryCategory,
): EvidenceChunk[] {
  return runWishlistSync(profile, (gameId) => {
    const hit = notes.find((e) => e.gameId === gameId);
    return hit && hit.title !== '' ? hit.title : gameId;
  }, category);
}

// ── find_rating_playtime_gaps ───────────────────────────────────────────────
// core 취향 프로필의 ratingPlaytimeGaps를 방향별로 정렬한다.
// long_low(오래 했는데 별점 낮음)는 gap 오름차순, short_high(짧은데 별점 높음)는
// gap 내림차순의 상위를 취하고 라이브러리(플레이타임)+노트(별점)로 숫자를 메운다.

export const GAPS_EMPTY_HEADING = '별점-플레이타임 갭 없음';

export type GapDirection = 'long_low' | 'short_high';

function parseDirection(rawArgs: Record<string, unknown>): GapDirection {
  return rawArgs.direction === 'short_high' ? 'short_high' : 'long_low';
}

export function runRatingPlaytimeGaps(
  rawArgs: Record<string, unknown>,
  deps: AgentDeps,
  category: QueryCategory,
): EvidenceChunk[] {
  const direction = parseDirection(rawArgs);
  const gaps = [...(deps.profile.ratingPlaytimeGaps ?? [])].sort((a, b) =>
    direction === 'short_high' ? b.gap - a.gap : a.gap - b.gap,
  );
  const entries = deps.notes;
  const lines: string[] = [];
  for (const g of gaps) {
    const row = deps.library.games.find((x) => x.id === g.gameId);
    const note = entries.find((e) => e.gameId === g.gameId);
    if (!row || note?.rating === undefined) continue;
    const title = row.title !== '' ? row.title : g.gameId;
    lines.push(`${title} | 플레이타임 ${formatPlaytimeMinutes(row.playtimeMinutes)} | 별점 ${note.rating} (gap ${g.gap})`);
    if (lines.length >= 3) break;
  }
  if (lines.length === 0) {
    return [{
      id: 'D-C#gaps:missing',
      docId: 'D-C',
      categories: [category],
      heading: GAPS_EMPTY_HEADING,
      text: `find_rating_playtime_gaps: ${direction}에 해당하는 게임이 없다 (별점 입력이 없어 교차할 수 없음)`,
    }];
  }
  return [{
    id: `D-C#gaps:${direction}`,
    docId: 'D-C',
    categories: [category],
    heading: `별점-플레이타임 갭 상위 ${lines.length}건 (${direction})`,
    text: lines.join('\n'),
  }];
}

// ── get_field_coverage ──────────────────────────────────────────────────────
// "비어 있나/있나" 질문용. 0건도 정상 출력이다 (결측 현황 자체가 답이므로
// isEmptyResult 대상이 아니다).

export const COVERAGE_FIELDS = ['genre', 'developers', 'achievement', 'rating'] as const;
export type CoverageField = (typeof COVERAGE_FIELDS)[number];

function parseCoverageField(rawArgs: Record<string, unknown>): CoverageField | null {
  const v = rawArgs.field;
  return typeof v === 'string' && (COVERAGE_FIELDS as readonly string[]).includes(v)
    ? (v as CoverageField)
    : null;
}

export function runFieldCoverage(
  rawArgs: Record<string, unknown>,
  library: LibraryIndex,
  notes: NoteEntry[],
  category: QueryCategory,
): EvidenceChunk[] {
  const field = parseCoverageField(rawArgs);
  const miss = (text: string): EvidenceChunk[] => [{
    id: 'D-A#coverage:missing',
    docId: 'D-A',
    categories: [category],
    heading: '결측 현황 조회 — 필드 미지정',
    text: `get_field_coverage: field가 없다 (${String(rawArgs.field ?? '')}) — genre·developers·achievement·rating 중 하나로 묻는다. ${text}`,
  }];
  if (!field) return miss('조회할 필드를 정하지 못했기 때문이다.');
  if (field === 'genre') {
    const empty = library.games.filter((g) => !g.genres || g.genres.length === 0);
    const names = empty.map((g) => g.title).join(', ');
    return [{
      id: 'D-A#coverage:genre',
      docId: 'D-A',
      categories: [category],
      heading: '장르 결측 현황',
      text: `장르 정보가 비어 있는 게임이 ${empty.length}건 있다${empty.length > 0 ? `: ${names}` : ''}`,
    }];
  }
  if (field === 'developers') {
    const filled = library.games.filter((g) => g.developers && g.developers.length > 0);
    const names = filled.slice(0, 20).map((g) => g.title).join(', ');
    return [{
      id: 'D-A#coverage:developers',
      docId: 'D-A',
      categories: [category],
      heading: '개발사 결측 현황',
      text: `개발사 정보가 있는 게임은 ${filled.length}건이다. developers 항목은 전량 비어 있다${filled.length > 0 ? `: ${names}` : ''}`,
    }];
  }
  if (field === 'achievement') {
    const filled = library.games.filter((g) => g.achievementPercent !== undefined);
    return [{
      id: 'D-A#coverage:achievement',
      docId: 'D-A',
      categories: [category],
      heading: '업적 결측 현황',
      text: `업적 달성률이 수집된 게임은 ${filled.length}건이다. 업적 데이터는 전 게임 공백이다.`,
    }];
  }
  const entries = notes;
  const missing = entries.filter((e) => e.rating === undefined);
  const names = missing.slice(0, 20).map((e) => e.title !== '' ? e.title : e.gameId).join(', ');
  const more = missing.length > 20 ? ` 외 ${missing.length - 20}건 생략` : '';
  return [{
    id: 'D-B#coverage:rating',
    docId: 'D-B',
    categories: [category],
    heading: '별점 결측 현황',
    text: `별점이 입력되지 않은 게임이 ${missing.length}건 있다${missing.length > 0 ? `: ${names}${more}` : ''} (미입력은 0점이 아니라 평가 없음이다)`,
  }];
}

// ── describe_schema ─────────────────────────────────────────────────────────
// "어디서 보나" 질문용. 답은 제품 스키마 토폴로지(객관=library.md 정본,
// 주관=games/*.md 정본 — policy-collection 제1조·제6조)이며 질의별 동적 값이 아니다.
// 토픽은 키워드군으로 판정하고, 해당 없으면 두 계층 전체를 답한다 (결측 없음).

interface SchemaEntry {
  keys: string[];
  file: string;
  layer: string;
  note: string;
}

const SCHEMA_MAP: SchemaEntry[] = [
  { keys: ['rating', '별점', '평점'], file: 'games/*.md 게임별 노트', layer: '주관 데이터 (수기 입력)', note: '별점은 library.md에서 볼 수 없다. 별점의 정본은 게임별 노트다.' },
  { keys: ['note', '한줄평', '메모', 'dislike', '기피'], file: 'games/*.md 게임별 노트', layer: '주관 데이터 (수기 입력)', note: '한줄평·기피 사유의 정본은 게임별 노트다.' },
  { keys: ['status', '상태', '중단', '완료', 'dropped'], file: 'games/*.md 게임별 노트', layer: '주관 데이터 (수기 입력)', note: '상태의 정본은 게임별 노트다.' },
  { keys: ['playtime', '플레이타임', '플레이 시간', '시간', '분'], file: 'library.md', layer: '객관 데이터 (자동 수집)', note: '플레이타임의 정본은 library.md 인덱스다.' },
  { keys: ['achievement', '업적', '달성률'], file: 'library.md', layer: '객관 데이터 (자동 수집)', note: '업적 달성률은 library.md 열이다. 현재는 전량 미수집(공백)이다.' },
  { keys: ['genre', '장르'], file: 'library.md', layer: '객관 데이터 (자동 수집)', note: '장르 태그의 정본은 library.md다. 출처는 Steam appdetails다.' },
  { keys: ['developer', '개발사', 'publisher', '퍼블리셔'], file: 'library.md', layer: '객관 데이터 (자동 수집)', note: '개발사·퍼블리셔 열은 library.md에 있으나 현재 전량 비어 있다.' },
  { keys: ['wishlist', '찜', '위시'], file: 'taste-profile.json + games/*.md', layer: '위시 목록·주관 상태', note: '찜 목록은 taste-profile.json의 wishlistAppIds다. 찜 게임은 보유 인덱스(library.md)에 없고 게임 노트만 있다(status: wishlist).' },
  { keys: ['taste', '취향', '선호', 'topgenres', '분포', '상위 장르'], file: 'taste-profile.json', layer: '계산 산출물', note: '취향 프로필(상위 장르·플레이 분포)은 taste-profile.json이다.' },
  { keys: ['generated', '갱신', '시각', '언제', '동기화'], file: 'library.md', layer: '객관 데이터 정본의 메타', note: '데이터 기준 시각은 library.md의 generated_at이다.' },
  { keys: ['history', '스냅샷', '로그', '변화'], file: 'history.jsonl', layer: '스냅샷 로그 (정본 아님, 재생성 불가)', note: '시점별 스냅샷은 history.jsonl에 append only로 쌓인다.' },
  { keys: ['source', '수기', '자동', '수집', '입력'], file: 'library.md + games/*.md', layer: '수집 계층 구분', note: '객관 필드는 자동 수집(library.md), 주관 필드(별점·한줄평·상태·기피 사유)는 수기 입력(게임 노트)이다.' },
];

export function runDescribeSchema(
  rawArgs: Record<string, unknown>,
  category: QueryCategory,
): EvidenceChunk[] {
  const topic = strArg(rawArgs, 'topic') ?? '';
  const nt = norm(topic);
  const hit = SCHEMA_MAP.find((e) => e.keys.some((k) => {
    const nk = norm(k);
    return nk !== '' && (nt.includes(nk) || nk.includes(nt));
  }));
  if (hit) {
    return [{
      id: `D-D#schema:${norm(hit.keys[0] ?? 'topic') || 'topic'}`,
      docId: 'D-D',
      categories: [category],
      heading: `스키마 안내 (${hit.file})`,
      text: `${topic || hit.keys[0]}: ${hit.file}에서 본다. ${hit.layer}이다. ${hit.note}`,
    }];
  }
  const layers = SCHEMA_MAP.map((e) => `- ${e.keys[0]}: ${e.file} (${e.layer})`).join('\n');
  return [{
    id: 'D-D#schema:layers',
    docId: 'D-D',
    categories: [category],
    heading: '데이터 계층 전체 안내',
    text: `데이터는 객관 데이터와 주관 데이터로 나뉜다 (두 계층을 섞지 않는다).\n${layers}`,
  }];
}

// ── 결측 판정 (라우터 규칙 3·5용) ───────────────────────────────────────────
// 도구 출력 텍스트를 파싱하지 않는다 — 각 도구가 "빈 결과"일 때 내는 고정
// heading 상수로만 판정한다. coverage·describe·taste는 0건도 정상 소견이라
// 결측이 될 수 없고, 노트의 필드 단위 결측은 findNoteEntry로 직접 본다.

export const LOOKUP_EMPTY_HEADING = '라이브러리 조회 결과 없음';
export const NOTE_EMPTY_HEADING = '노트 없음';

export function isEmptyResult(tool: ToolName, chunks: EvidenceChunk[]): boolean {
  if (chunks.length === 0) return tool !== 'escalate';
  const heading = chunks[0]?.heading ?? '';
  switch (tool) {
    case 'lookup_library':
      return heading === LOOKUP_EMPTY_HEADING;
    case 'get_achievement_stats':
      return heading === ACHIEVEMENT_EMPTY_HEADING;
    case 'get_wishlist':
      return heading === WISHLIST_EMPTY_HEADING;
    case 'find_rating_playtime_gaps':
      return heading === GAPS_EMPTY_HEADING;
    default:
      return false;
  }
}

// ── 실행기 ──────────────────────────────────────────────────────────────────

export function executeTool(
  tool: ToolName,
  args: Record<string, unknown>,
  deps: AgentDeps,
  category: QueryCategory,
): EvidenceChunk[] {
  switch (tool) {
    case 'lookup_library':
      return runLookupLibrary(args, deps.library, category);
    case 'get_game_note':
      return runGameNote(args, deps.notes, category);
    case 'get_taste_profile':
      return runTasteProfile(deps.profile, category);
    case 'search_docs':
      return runSearchDocs(args, deps, category);
    case 'get_achievement_stats':
      return runAchievementStats(args, deps.library, category);
    case 'get_wishlist':
      return runWishlist(deps.profile, deps.notes, category);
    case 'find_rating_playtime_gaps':
      return runRatingPlaytimeGaps(args, deps, category);
    case 'get_field_coverage':
      return runFieldCoverage(args, deps.library, deps.notes, category);
    case 'describe_schema':
      return runDescribeSchema(args, category);
    case 'escalate':
      return [];
  }
}
