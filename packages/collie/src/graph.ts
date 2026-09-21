/**
 * collie app shell 그래프 (P2-D).
 *
 * StateGraph + StateSchema + 조건부 엣지 뼈대만 둔다. 검색(P3-F)과 LLM 관계
 * 추출(P3-E), 실제 core 도구 배선(P4-G)은 아직 연결하지 않는다. retrieve
 * 스텁은 항상 빈 paths를 돌려주므로 셸 실행은 결정적으로 abstain한다.
 * 실패 확장 사다리(retrieve -> escalate -> policy back-edge)의 위상만
 * 먼저 둔다. 셸 정책은 예산을 항상 소진으로 판정하므로 escalate 분기는
 * 타지 않는다. 실제 레벨 상승·재실행 정책은 P3-F가 소유한다.
 */
import { END, START, ReducedValue, StateGraph, StateSchema } from '@langchain/langgraph';
import { CATEGORIES, type ClassifyResult, type QueryCategory } from '@questail/core';
import { z } from 'zod';

/** classify 자리표시자. 실제 분기는 P4-G에서 앱이 정한다. core router를 쓰지 않는다. */
export const SHELL_ROUTE_PENDING = 'graph_pending';

/** LLM 분류기 주입 seam. classify는 순수 함수로, 호출자는 ask.ts 하나다. */
export type ClassifyComplete = (prompt: string) => Promise<string>;

export function buildClassifyPrompt(question: string, titles: readonly string[]): string {
  return [
    'You are a query router for a personal game-library assistant. The user question may be Korean.',
    'Pick exactly one route:',
    '- graph: game relations, recommendations, connections, comparisons, series, same developer/genre (graph search)',
    '- tools: library record lookups (holdings, playtime, ratings, status, data freshness)',
    '- refuse: only truly out of scope (walkthroughs, prices, evaluating games not owned)',
    'When route is tools, also pick exactly one category:',
    '- HISTORY: holdings, playtime, last played, achievements',
    '- TASTE: top genres, playtime distribution, wishlist trends',
    '- DATA_OPS: why empty, when updated, auto vs manual',
    '- SUBJECTIVE: ratings, status, avoidance reasons',
    '- OUT_OF_SCOPE: walkthroughs, prices, games not owned',
    'Pick gameTitles ONLY from the library list below, using exact spellings. Empty array if none appear.',
    'Respond with JSON only: {"route": <graph|tools|refuse>, "category": <required when tools>, "confidence": <0-1>, "reason": <Korean, one line>, "gameTitles": [<exact titles>]}',
    '',
    'Library titles:',
    ...titles.map((title) => `- ${title}`),
    '',
    `Question: ${question}`,
  ].join('\n');
}

/**
 * 앱 소유 라우팅 타입. core 다섯 카테고리에 그래프 관계 질의 자리가 없어
 * 앱에서 route를 먼저 가른다. tools일 때만 core ClassifyResult를 조립해
 * routeQuestion에 넘기고, graph면 core 라우터를 거치지 않고 바로 탐색한다.
 */
export type AppRoute = 'graph' | 'tools' | 'refuse';

export interface AppClassifyResult {
  route: AppRoute;
  gameTitles: string[];
  confidence: number;
  reason: string;
  /** route=tools일 때만 유효. */
  category?: QueryCategory;
}

const APP_ROUTES: readonly string[] = ['graph', 'tools', 'refuse'];

const APP_FALLBACK: AppClassifyResult = {
  route: 'refuse',
  gameTitles: [],
  confidence: 0,
  reason: 'unparseable-classifier-output',
};

export function parseClassifyResult(text: string): AppClassifyResult {
  try {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    const data = JSON.parse(cleaned) as {
      route?: unknown;
      category?: unknown;
      confidence?: unknown;
      reason?: unknown;
      gameTitles?: unknown;
    };
    if (typeof data !== 'object' || data === null) return APP_FALLBACK;
    if (typeof data.route !== 'string' || !APP_ROUTES.includes(data.route)) return APP_FALLBACK;
    const route = data.route as AppRoute;
    const confidence =
      typeof data.confidence === 'number' && data.confidence >= 0 && data.confidence <= 1
        ? data.confidence
        : 0;
    const reason = typeof data.reason === 'string' ? data.reason : '';
    const gameTitles = Array.isArray(data.gameTitles)
      ? data.gameTitles.filter((entry): entry is string => typeof entry === 'string')
      : [];
    if (route !== 'tools') return { route, gameTitles, confidence, reason };
    const category = (CATEGORIES as readonly string[]).includes(data.category as string)
      ? (data.category as QueryCategory)
      : 'OUT_OF_SCOPE';
    return { route, gameTitles, confidence, reason, category };
  } catch {
    return APP_FALLBACK;
  }
}

/** route=tools일 때 core routeQuestion에 넘길 ClassifyResult를 조립한다. */
export function toCoreClassify(result: AppClassifyResult): ClassifyResult {
  return {
    category: result.route === 'tools' ? (result.category ?? 'OUT_OF_SCOPE') : 'OUT_OF_SCOPE',
    confidence: result.confidence,
    reason: result.reason,
    gameTitles: result.gameTitles,
  };
}

/** resolve는 검증만: 인덱스 정식 표기만 통과, 없으면 버린다. union 유지·임의 선택 금지. */
export function validateGameTitles(
  candidates: readonly string[],
  indexTitles: ReadonlySet<string>,
): string[] {
  return candidates.filter((title) => indexTitles.has(title));
}

export async function classifyQuestion(
  question: string,
  titles: readonly string[],
  complete: ClassifyComplete,
): Promise<AppClassifyResult> {
  return parseClassifyResult(await complete(buildClassifyPrompt(question, titles)));
}
/** verify가 아직 돌지 않은 초기 표시. */
export const VERIFY_NOT_RUN = 'not_verified';
/** 셸 정책 레벨. 완화는 P3-F retrieval이 소유한다. */
export const SHELL_LEVEL = 0;

const AttemptSchema = z.object({
  level: z.number(),
  outcome: z.enum(['paths_found', 'no_paths']),
});

const EvidenceSpanSchema = z.object({
  document: z.number(),
  span: z.string(),
});

const VerifySchema = z.object({
  passed: z.boolean(),
  reason: z.string(),
});

export const CollieShellState = new StateSchema({
  question: z.string(),
  route: z.string(),
  level: z.number(),
  attempts: new ReducedValue(z.array(AttemptSchema).default([]), {
    inputSchema: z.array(AttemptSchema),
    reducer: (current, update) => [...current, ...update],
  }),
  paths: new ReducedValue(z.array(z.string()).default([]), {
    inputSchema: z.array(z.string()),
    reducer: (current, update) => [...current, ...update],
  }),
  evidence: new ReducedValue(z.array(EvidenceSpanSchema).default([]), {
    inputSchema: z.array(EvidenceSpanSchema),
    reducer: (current, update) => [...current, ...update],
  }),
  answer: z.string(),
  verify: VerifySchema,
  abstained: z.boolean(),
  regenerated: z.boolean(),
  /** 확장 예산 placeholder. 셸 정책은 항상 0(소진)으로 둔다. */
  escalationBudget: z.number(),
  /** escalate 노드를 거친 레벨 기록. 예산이 막아 셸에서는 비어 있다. */
  escalations: new ReducedValue(z.array(z.number()).default([]), {
    inputSchema: z.array(z.number()),
    reducer: (current, update) => [...current, ...update],
  }),
});

export type ShellState = typeof CollieShellState.State;
export type ShellUpdate = typeof CollieShellState.Update;

export function initialShellState(question: string): ShellState {
  return {
    question,
    route: SHELL_ROUTE_PENDING,
    level: SHELL_LEVEL,
    attempts: [],
    paths: [],
    evidence: [],
    answer: '',
    verify: { passed: false, reason: VERIFY_NOT_RUN },
    abstained: false,
    regenerated: false,
    escalationBudget: 0,
    escalations: [],
  };
}

export function classifyNode(state: ShellState): ShellUpdate {
  void state;
  return { route: SHELL_ROUTE_PENDING };
}

export function policyNode(state: ShellState): ShellUpdate {
  void state;
  // 셸 단계의 예산 판정은 항상 소진. 실제 정책은 P3-F가 둔다.
  return { level: SHELL_LEVEL, escalationBudget: 0 };
}

/** 검색 스텁. P3-F가 실제 retrieval로 교체한다. */
export function retrieveNode(state: ShellState): ShellUpdate {
  return { attempts: [{ level: state.level, outcome: 'no_paths' }] };
}

/** 확장 기록 스텁. 레벨 상승·재실행 정책은 P3-F가 둔다. */
export function escalateNode(state: ShellState): ShellUpdate {
  return { escalations: [state.level] };
}

/** 답변 스텁. 두 번째 진입이면 재생성으로 기록한다. */
export function answerNode(state: ShellState): ShellUpdate {
  const regenerated = state.verify.reason !== VERIFY_NOT_RUN;
  return {
    answer: `[collie-stub] ${state.question}`,
    regenerated,
  };
}

/** 검증 스텁. answer 근거 접지 검사는 P4-G verifier가 소유한다. */
export function verifyNode(state: ShellState): ShellUpdate {
  const passed = state.answer.length > 0;
  return { verify: { passed, reason: passed ? 'stub_answer_present' : 'empty_answer' } };
}

export function abstainNode(state: ShellState): ShellUpdate {
  void state;
  return { abstained: true, answer: '' };
}

export function routeAfterRetrieve(state: ShellState): 'respond' | 'escalate' | 'abstain' {
  if (state.paths.length > 0) return 'respond';
  return state.escalations.length < state.escalationBudget ? 'escalate' : 'abstain';
}

export function routeAfterVerify(state: ShellState): 'respond' | typeof END {
  if (state.verify.passed) return END;
  return state.regenerated ? END : 'respond';
}

export function createShellGraph() {
  return new StateGraph(CollieShellState)
    .addNode('classify', classifyNode)
    .addNode('policy', policyNode)
    .addNode('retrieve', retrieveNode)
    .addNode('respond', answerNode)
    .addNode('check', verifyNode)
    .addNode('escalate', escalateNode)
    .addNode('abstain', abstainNode)
    .addEdge(START, 'classify')
    .addEdge('classify', 'policy')
    .addEdge('policy', 'retrieve')
    .addConditionalEdges('retrieve', routeAfterRetrieve, {
      respond: 'respond',
      escalate: 'escalate',
      abstain: 'abstain',
    })
    .addEdge('escalate', 'policy')
    .addEdge('respond', 'check')
    .addConditionalEdges('check', routeAfterVerify, { respond: 'respond', [END]: END })
    .addEdge('abstain', END)
    .compile();
}

export interface ShellResult {
  readonly question: string;
  readonly route: string;
  readonly level: number;
  readonly attempts: readonly { readonly level: number; readonly outcome: 'paths_found' | 'no_paths' }[];
  readonly abstained: boolean;
  readonly regenerated: boolean;
  readonly escalationCount: number;
  readonly answer: string;
  readonly verifyReason: string;
}

export async function runShell(question: string): Promise<ShellResult> {
  const graph = createShellGraph();
  const finalState = await graph.invoke(initialShellState(question));
  return {
    question: finalState.question,
    route: finalState.route,
    level: finalState.level,
    attempts: finalState.attempts,
    abstained: finalState.abstained,
    regenerated: finalState.regenerated,
    escalationCount: finalState.escalations.length,
    answer: finalState.answer,
    verifyReason: finalState.verify.reason,
  };
}
