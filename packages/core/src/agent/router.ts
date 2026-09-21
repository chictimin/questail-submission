/**
 * 결정적 도구 라우터.
 *
 * LLM을 부르지 않는다. 카테고리 + 질문 키워드 + 1차 조회 결과(데이터 상태)로
 * 도구 집합을 정한다. 규칙 조건에는 문항 id·특정 게임명·특정 질문 문자열을
 * 넣지 않는다 — 필드 이름과 데이터 상태에서만 유도한다.
 *
 * questail-collie `src/nodes/router.ts`(동결 `20eb941`)에서 이식했다.
 * 이식하며 바뀐 점: 노트 조회가 동기 순수 함수(`findNoteEntry(arg, deps.notes)`)가
 * 되면서 내부 `await` 가 사라졌다. `routeQuestion` 자체는 `async` 을 유지한다 —
 * 외부 시그니처 `(question, classify, deps)` 가 W-B 채점 하네스의 호출 계약이다.
 *
 * 규칙 번호는 계약 문서의 '결정적 라우터 규칙'을 따른다:
 * 1. 질문에서 도구 1차 선택 (키워드 규칙 + 카테고리)
 * 2. 게임명은 classify의 gameTitles 후보를 인덱스로 검증해 쓴다 (계약 v3).
 *    검증 실패면 기존 문자열 매칭(정확 span > 유일 숫자)으로 폴백한다.
 * 3. 1차 조회 결과가 빈 값·결측이면 search_docs 자동 추가
 * 5. 라이브러리 조회 0건이면 get_wishlist도 조회
 * 4. 주의 대상 필드면 결측이 아니어도 search_docs 추가
 */

import {
  executeTool,
  findLibraryTitle,
  findNoteEntry,
  isEmptyResult,
  resolveGameReference,
} from './tools.js';
import type {
  AgentDeps,
  ClassifyResult,
  EvidenceChunk,
  QueryCategory,
  ToolName,
} from './types.js';
import { detectLocale } from '../i18n.js';

export interface RoutedCall { tool: ToolName; args: Record<string, unknown>; }

/** 질문에서 2자 이상 토큰을 뽑는다. search_docs 키워드용. */
export function keywordsFrom(question: string): string[] {
  const out: string[] = [];
  for (const tok of question.split(/[^\p{L}\p{N}]+/gu)) {
    if (tok.length >= 2 && !out.includes(tok)) out.push(tok);
    if (out.length >= 8) break;
  }
  return out;
}

function has(q: string, ...subs: string[]): boolean {
  return subs.some((s) => q.includes(s));
}

/** 조사·어미가 붙은 형태까지 잡는다 ("얼마야" O, "얼마나" X). */
function hasTokenPrefix(q: string, prefix: string, exclude: readonly string[] = []): boolean {
  return q
    .split(/[^\p{L}\p{N}]+/gu)
    .some((t) => t.startsWith(prefix) && !exclude.includes(t));
}

/** 프로필 상위 장르 목록(데이터)에서 질문에 등장한 장르를 찾는다. */
function genreOf(question: string, deps: AgentDeps): string | null {
  for (const g of deps.profile.topGenres) {
    if (g.genre !== '' && question.includes(g.genre)) return g.genre;
  }
  // D9 영문화 이후: canonical 직접 매칭이 실패하면 주입 별칭(한국어)으로 연결한다.
  // topGenres에 있는 canonical의 별칭만 본다 — 인덱스에 없는 대응은 만들지 않는다.
  const aliases = deps.genreAliases;
  if (!aliases) return null;
  for (const g of deps.profile.topGenres) {
    if (g.genre === '') continue;
    const list = aliases[g.genre];
    if (!list) continue;
    for (const a of list) {
      if (a !== '' && question.includes(a)) return g.genre;
    }
  }
  return null;
}

/** 순위 질문의 N. "상위 N·N개·N건"에서 숫자를 읽고, "제일·가장·1위"는 1이다. */
function topNOf(question: string): number | undefined {
  const m = /(?:상위|top)\s*(\d+)|(\d+)\s*[개건위]/i.exec(question);
  if (m) {
    const n = Number(m[1] ?? m[2]);
    if (Number.isFinite(n) && n > 0) return Math.min(50, Math.floor(n));
  }
  if (has(question, '제일', '가장', '1위', '첫 번째', '첫번째')) return 1;
  return undefined;
}

/**
 * 플레이타임 순위 질문의 정렬 방향. 방향어가 없으면 null이다.
 * null이면 topByPlaytime을 아예 붙이지 않는다 — 방향을 모른 채 내림차순으로
 * 답하면 "가장 적게 한 게임"에 최다 플레이 게임을 답하게 된다.
 * 오답보다 무근거가 낫다는 판단이다.
 */
function playtimeOrderOf(question: string): 'asc' | 'desc' | null {
  const asc = has(question, '적게', '적은', '짧', '최소', '조금', '덜 ', '낮은 플레이');
  const desc = has(question, '오래', '오랜', '길게', '긴 ', '많이', '많은', '최다', '최대', '붙잡');
  if (asc && !desc) return 'asc';
  if (desc && !asc) return 'desc';
  return null;
}

type CoverageField = 'genre' | 'developers' | 'achievement' | 'rating';

/** 결측·보유 질문의 대상 필드. 필드 이름 키워드에서만 유도한다. */
function coverageFieldOf(question: string): CoverageField | null {
  if (has(question, '장르')) return 'genre';
  if (has(question, '개발사', '개발자', '제작사')) return 'developers';
  if (has(question, '업적', '달성률')) return 'achievement';
  if (has(question, '별점', '평점')) return 'rating';
  return null;
}

/** 주관 필드 요청 여부. get_game_note 결과의 필드 단위 결측 판정용. */
function requestedNoteFields(question: string): Array<'rating' | 'status' | 'note' | 'dislikeReasons'> {
  const out: Array<'rating' | 'status' | 'note' | 'dislikeReasons'> = [];
  if (has(question, '별점', '평점')) out.push('rating');
  if (has(question, '한줄평', '한줄 평', '메모', '코멘트')) out.push('note');
  if (has(question, '상태', '그만', '중단', '완료', '클리어', '플레이중')) out.push('status');
  if (has(question, '기피', '왜', '이유', '사유')) out.push('dislikeReasons');
  return out;
}

// ── 카테고리별 1차 선택 (규칙 1) ────────────────────────────────────────────

function selectHistory(question: string, deps: AgentDeps, primaryTitle: string | null): RoutedCall[] {
  if (has(question, '업적', '달성률')) {
    const ref = primaryTitle ?? resolveGameReference(question, deps.library)?.title;
    return [{ tool: 'get_achievement_stats', args: ref ? { titleOrKeyword: ref } : {} }];
  }
  if (has(question, '위시', '찜')) return [{ tool: 'get_wishlist', args: {} }];
  if (has(question, '갱신', 'generated', '기준 시각', '동기화')) {
    return [{ tool: 'lookup_library', args: {} }];
  }
  const args: Record<string, unknown> = {};
  const ref = primaryTitle ?? resolveGameReference(question, deps.library)?.title;
  if (ref) args.titleOrKeyword = ref;
  const genre = genreOf(question, deps);
  if (genre) args.genre = genre;
  const top = topNOf(question);
  const order = playtimeOrderOf(question);
  // 방향이 확정될 때만 순위 조회다. 방향어가 없으면 순위 질문으로 보지 않는다.
  if (top !== undefined && order !== null) {
    args.topByPlaytime = top;
    args.playtimeOrder = order;
  }
  if (args.titleOrKeyword === undefined && args.genre === undefined && args.topByPlaytime === undefined) {
    args.titleOrKeyword = question;
  }
  return [{ tool: 'lookup_library', args }];
}

function selectTaste(question: string, deps: AgentDeps): RoutedCall[] {
  const ratingTalk = has(question, '별점', '평점', '평가');
  const longSide = has(question, '오래', '오랜', '길게', '많이', '붙잡', '습관', '그라인드');
  const shortSide = has(question, '짧', '잠깐', '단시간');
  const lowSide = has(question, '낮', '저평가', '별로', '실망', '불만');
  const highSide = has(question, '높', '고평가', '강렬', '인상');
  const wantLongLow = ratingTalk && longSide && lowSide && !(shortSide && highSide);
  const wantShortHigh = ratingTalk && shortSide && highSide && !(longSide && lowSide);
  if (wantLongLow) return [{ tool: 'find_rating_playtime_gaps', args: { direction: 'long_low' } }];
  if (wantShortHigh) return [{ tool: 'find_rating_playtime_gaps', args: { direction: 'short_high' } }];
  const genre = genreOf(question, deps);
  if (genre && has(question, '제일', '순위', '오래', '많이', '상위', 'top', '1위', '가장')) {
    return [{
      tool: 'lookup_library',
      args: {
        genre,
        topByPlaytime: topNOf(question) ?? 1,
        playtimeOrder: playtimeOrderOf(question) ?? 'desc',
      },
    }];
  }
  // 장르가 없어도 플레이타임 최대·최소 질의는 개별 게임 조회다.
  // 취향 프로필에는 분포 통계만 있고 게임별 행이 없어 "근거가 없다"로 끝난다.
  const top = topNOf(question);
  const order = playtimeOrderOf(question);
  if (top !== undefined && order !== null && has(question, '플레이', '플레이타임', '시간')) {
    return [{ tool: 'lookup_library', args: { topByPlaytime: top, playtimeOrder: order } }];
  }
  return [{ tool: 'get_taste_profile', args: {} }];
}

function selectSubjective(question: string, deps: AgentDeps, primaryTitle: string | null): RoutedCall[] {
  const calls: RoutedCall[] = [];
  const ref = primaryTitle ?? resolveGameReference(question, deps.library)?.title;
  calls.push({ tool: 'get_game_note', args: { titleOrAppid: ref ?? question } });
  if (has(question, '몇 분', '얼마나', '시간', '플레이했', '플레이한')) {
    calls.push({ tool: 'lookup_library', args: { titleOrKeyword: ref ?? question } });
  }
  return calls;
}

function selectDataOps(question: string, deps: AgentDeps): RoutedCall[] {
  void deps;
  const field = coverageFieldOf(question);
  if (field && has(question, '비어', '비었', '없', '있', '결측', '공백', '채워')) {
    return [{ tool: 'get_field_coverage', args: { field } }];
  }
  if (has(question, '어디서', '어디에', '어디', '계층', '정본', '파일', '볼 수', '보나', '보는', '보면', '저장')) {
    const topic = field ?? keywordsFrom(question)[0] ?? question.slice(0, 20);
    return [{ tool: 'describe_schema', args: { topic } }];
  }
  if (has(question, '갱신', 'generated', '기준 시각', '동기화')) {
    return [{ tool: 'lookup_library', args: {} }];
  }
  return [{ tool: 'search_docs', args: { keywords: keywordsFrom(question) } }];
}

function selectPrimary(
  question: string,
  category: QueryCategory,
  deps: AgentDeps,
  primaryTitle: string | null,
): RoutedCall[] {
  switch (category) {
    case 'HISTORY':
      return selectHistory(question, deps, primaryTitle);
    case 'TASTE':
      return selectTaste(question, deps);
    case 'SUBJECTIVE':
      return selectSubjective(question, deps, primaryTitle);
    case 'DATA_OPS':
      return selectDataOps(question, deps);
    case 'OUT_OF_SCOPE':
      return [];
  }
}

// ── 라우터 본체 ─────────────────────────────────────────────────────────────

let enLocaleWarned = false;

/**
 * ko-only 가드. LANG 기반 로케일이 en이면 첫 호출 1회만 경고한다.
 * routeQuestion은 문항마다 불리므로 매번 찍지 않는다.
 * core는 라이브러리이므로 throw하지 않고 console.warn으로 끝낸다.
 */
function warnOnceIfEnglish(): void {
  if (enLocaleWarned || detectLocale() !== 'en') return;
  enLocaleWarned = true;
  console.warn(
    '[questail] agent router is Korean-only — English questions do not error but silently route worse (no ranking, schema fallback, or direct escalate). See tools/eval/README.md.',
  );
}

/**
 * 결정적 도구 라우터. LLM을 부르지 않는다.
 * 게임명은 classify가 준 gameTitles 후보를 인덱스로 검증해 쓰고 (계약 v3),
 * 검증에 실패하면 기존 문자열 매칭으로 폴백한다.
 *
 * 한국어 질의 전용이다. 규칙 조건이 한국어 키워드 substring 매칭이라
 * 영어 질문은 에러 없이 조용히 나빠진다:
 * - 방향어 부재 → playtimeOrderOf null → 순위 조회 탈락
 * - 필드명 부재 → coverageFieldOf null → search_docs 폴백
 * - 가격 키워드 불일치 → OUT_OF_SCOPE에서 escalate 직행
 * en 로케일에서는 첫 호출 1회만 console.warn한다 (throw하지 않는다).
 */
export async function routeQuestion(
  question: string,
  classify: ClassifyResult,
  deps: AgentDeps,
): Promise<RoutedCall[]> {
  warnOnceIfEnglish();
  const category = classify.category;
  if (category === 'OUT_OF_SCOPE') {
    const calls: RoutedCall[] = [];
    if (has(question, '가격', '시세', '비용', '할인', '정가') || hasTokenPrefix(question, '얼마', ['얼마나'])) {
      calls.push({ tool: 'search_docs', args: { keywords: ['가격', '시세', '수집', '범위'] } });
    }
    calls.push({ tool: 'escalate', args: { category } });
    return calls;
  }

  // 계약 v3: LLM 후보 중 인덱스에 실재하는 첫 표기를 쓴다. 전멸이면 폴백한다.
  let primaryTitle: string | null = null;
  for (const cand of classify.gameTitles) {
    const hit = findLibraryTitle(cand, deps.library);
    if (hit) {
      primaryTitle = hit;
      break;
    }
  }

  const calls: RoutedCall[] = selectPrimary(question, category, deps, primaryTitle);
  // 1차 실행 — 결측 감지용. search_docs는 키워드만 확정하고 실행하지 않는다.
  const chunksByTool = new Map<ToolName, EvidenceChunk[]>();
  for (const c of calls) {
    chunksByTool.set(c.tool, executeTool(c.tool, c.args, deps, category));
  }

  // 규칙 5: 라이브러리 조회 0건이면 get_wishlist도 조회한다 (결과 0건만 본다).
  const lookupEmpty = calls.some((c) => c.tool === 'lookup_library' && isEmptyResult(c.tool, chunksByTool.get(c.tool) ?? []));
  if (lookupEmpty && !calls.some((c) => c.tool === 'get_wishlist')) {
    calls.push({ tool: 'get_wishlist', args: {} });
    chunksByTool.set('get_wishlist', executeTool('get_wishlist', {}, deps, category));
  }

  const searchKeywords: string[] = [];
  const wantSearch = (...kws: string[]): void => {
    for (const k of kws) {
      if (!searchKeywords.includes(k)) searchKeywords.push(k);
    }
  };

  // 규칙 3: 1차 조회가 빈 값·결측이면 search_docs를 자동 추가한다.
  for (const c of calls) {
    if (c.tool === 'search_docs' || c.tool === 'escalate') continue;
    if (isEmptyResult(c.tool, chunksByTool.get(c.tool) ?? [])) {
      wantSearch(...keywordsFrom(question));
    }
  }
  // 노트의 필드 단위 결측: 노트는 있어도 요청한 주관 필드가 비었으면 결측이다.
  for (const c of calls) {
    if (c.tool !== 'get_game_note') continue;
    const arg = c.args['titleOrAppid'];
    if (typeof arg !== 'string') continue;
    const entry = findNoteEntry(arg, deps.notes);
    const wanted = requestedNoteFields(question);
    if (!entry || wanted.some((f) => entry[f] === undefined)) {
      wantSearch(...keywordsFrom(question));
    }
  }

  // 규칙 4: 주의 대상 필드면 결측이 아니어도 search_docs를 추가한다.
  // 매핑은 docs/_mapping.md의 청크 id가 가리키는 주제로 건다.
  const uses = (t: ToolName): boolean => calls.some((c) => c.tool === t);
  if (uses('get_taste_profile') && has(question, '장르', '좋아', '선호', '최애', '싫어', '기피', '상위')) {
    wantSearch('topGenres', '선호', '기피', '겹침', '가중치'); // D-F#topgenres-주의, D-F#기피-상위-겹침
  }
  if (uses('get_wishlist')) {
    wantSearch('찜', '보유', '위시', '구분'); // D-E#찜-보유-구분
  }
  if (uses('find_rating_playtime_gaps')) {
    wantSearch('별점', '갭', '미입력', '주관'); // D-E#별점-미입력, D-F#미반영-신호
  }
  if (uses('describe_schema')) {
    const topic = calls.find((c) => c.tool === 'describe_schema')?.args['topic'];
    if (typeof topic === 'string' && topic !== '') wantSearch(topic);
    wantSearch('입력', '계층', '정본', '수기'); // D-E#입력-계층, D-D#데이터-계층
  }
  if (uses('get_field_coverage')) {
    const field = calls.find((c) => c.tool === 'get_field_coverage')?.args['field'];
    if (typeof field === 'string' && field !== '') wantSearch(field);
    wantSearch('출처', '수집', 'appdetails', '이유');
  }

  if (searchKeywords.length > 0 && !uses('search_docs')) {
    calls.push({ tool: 'search_docs', args: { keywords: searchKeywords.slice(0, 8) } });
  }
  return calls;
}
