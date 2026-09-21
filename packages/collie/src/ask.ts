/**
 * P4-G ask 파이프라인 (신규).
 *
 * graph.ts shell은 읽기 전용으로 classify/policy 기록에만 쓰고 수정하지
 * 않는다. EvidencePack·재생성은 타입·LLM이 없어 최소 배선에서 제외한다.
 * 실제 답변 조립(LLM 여부)은 후속 단계 몫이며, 이 파이프라인은
 * step{node,level}* + result{mode, trace} 계약까지만 책임진다.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyQuestion, toCoreClassify, validateGameTitles, type AppRoute, type ClassifyComplete } from './graph.js';
import { runShell } from './graph.js';
import { loadDefaultConfig, parseConfig } from './types.js';
import { readFileSync } from 'node:fs';
import { retrieve, type RetrieveMode, type RetrieveResult } from './retrieve/index.js';
import { loadGraphAdapter } from './graph-deps.js';
import { loadEnvFile, resolveExtractCredentials } from './extract.js';
import {
  CollieLlmError,
  completeChat,
  hasApiKey,
  maskApiKeyText,
  resolveLlmCredentials,
  type LlmCredentials,
} from './llm.js';

/** LLM 호출 없이 기록하는 프롬프트 자리 표시자. 템플릿 본체는 없다. */
export const RETRIEVE_PROMPT_ID = 'collie-retrieve-v1:evidence-grounded,no-llm';

export function retrievePromptFingerprint(): string {
  return `sha256:${createHash('sha256').update(RETRIEVE_PROMPT_ID, 'utf8').digest('hex')}`;
}

export const FALLBACK_MODEL_ID = 'collie-deterministic';

export interface AskContextOptions {
  readonly configPath?: string;
  readonly graphPath?: string;
  readonly corpusDir?: string;
}

export interface AskContext {
  readonly config: Awaited<ReturnType<typeof loadDefaultConfig>>;
  readonly deps: ReturnType<typeof loadGraphAdapter>['deps'];
  readonly corpusFingerprint: string;
}

export function defaultConfigPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'config', 'default.json');
}

/** 생성자 sync 유지를 위해 sync 읽기만 쓴다(parseConfig는 sync). */
export function createAskContext(options: AskContextOptions = {}): AskContext {
  const configPath = options.configPath ?? defaultConfigPath();
  const config = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')) as unknown);
  const adapter = loadGraphAdapter({ graphPath: options.graphPath, corpusDir: options.corpusDir });
  return { config, deps: adapter.deps, corpusFingerprint: adapter.corpusFingerprint };
}

export interface AskStep {
  readonly node: string;
  readonly level: number;
  readonly route?: string;
  readonly appRoute?: AppRoute;
  readonly category?: string;
  readonly confidence?: number;
  readonly reason?: string;
  readonly gameTitles?: readonly string[];
  readonly keySource?: 'request' | 'env' | 'none';
}

export interface AskResult extends RetrieveResult {
  readonly steps: readonly AskStep[];
  /** 노드ID → 표시제목. RunTrace 내부는 손대지 않고 형제로 둔다. 소비자는 labels[id] ?? id로 표시한다. */
  readonly labels?: Readonly<Record<string, string>>;
  /** 생성 답변 1~2문장. trace에 넣지 않는다. abstain이면 싣지 않는다. */
  readonly answer?: string;
  /**
   * respond 생성이 실패해 근거 폴백으로 대체됐을 때의 사유(키 마스킹됨).
   * 검색 결과(trace)는 그대로 있고 answer만 폴백이다. 성공·생략 시 없음.
   */
  readonly generationWarning?: string;
}

export interface RunAskOptions {
  /** 미지정 시 completeChat 실경로. null이면 생성 강제 생략(결정적 폴백). */
  readonly complete?: ClassifyComplete | null;
}

/** 선택 경로의 간선 1개(표시용 라벨 기준). runAsk가 id→label로 바꿔 넘긴다. */
export interface RespondPathEdge {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly verified?: boolean;
}

/** 간선 종류 → 사람이 읽는 관계 동사. PUBLISHED_BY를 DEVELOPED_BY로 바꿔 말하는 실패를 막는다. */
function describeRespondEdge(edge: RespondPathEdge): string {
  const verified = edge.verified === undefined ? '' : edge.verified ? ' (verified)' : ' (unverified)';
  switch (edge.type) {
    case 'DEVELOPED_BY':
      return `- ${edge.from} —DEVELOPED_BY→ ${edge.to}: ${edge.to} developed ${edge.from}${verified}`;
    case 'PUBLISHED_BY':
      return `- ${edge.from} —PUBLISHED_BY→ ${edge.to}: ${edge.to} published ${edge.from} (did NOT develop it)${verified}`;
    case 'HAS_TAG':
      return `- ${edge.from} —HAS_TAG→ ${edge.to}: ${edge.from} is tagged ${edge.to}${verified}`;
    case 'SEQUEL_OF':
      return `- ${edge.from} —SEQUEL_OF→ ${edge.to}: ${edge.from} is a sequel of ${edge.to}${verified}`;
    default:
      return `- ${edge.from} —${edge.type}→ ${edge.to}${verified}`;
  }
}

/** 선택 경로+간선 종류+근거 span만으로 답한다. 근거 밖 사실 금지, 부족하면 모른다고. */
export function buildRespondPrompt(
  question: string,
  pathLabels: readonly string[],
  evidence: readonly { document: string; sentence: string; expression: string }[],
  pathEdges: readonly RespondPathEdge[] = [],
): string {
  const relationLines =
    pathEdges.length === 0
      ? []
      : [
          'Relations (the ONLY relationships you may assert; each line states the exact edge type):',
          ...pathEdges.map(describeRespondEdge),
        ];
  return [
    'Answer in Korean, at most two sentences, using only the facts below.',
    'The Evidence lines are database fields, not prose: `developers: ["X"]` means X developed the game,',
    '`publishers: ["Y"]` means Y published it, `tags: [...]` lists its tags. Use the exact spellings',
    'from the Evidence expressions for names.',
    'Do not assert any relationship outside the Relations lines above: when only a PUBLISHED_BY edge is',
    'given, do not say anyone developed the game, and vice versa. Do not invent facts not stated in',
    'the Relations or Evidence. If the facts are truly insufficient, say you do not know.',
    'Compose the path endpoints into a sentence (who made what, what it is).',
    'Example: a path Monster Hunter Wilds → CAPCOM → Resident Evil 4 with tag Survival Horror becomes',
    '"Monster Hunter Wilds를 만든 CAPCOM이 Resident Evil 4도 만들었고 서바이벌 호러입니다."',
    'If the facts are truly insufficient, say you do not know.',
    '',
    `Path: ${pathLabels.join(' → ')}`,
    ...relationLines,
    'Evidence:',
    ...evidence.slice(0, 8).map((span) => `- [${span.document}] ${span.sentence} (${span.expression})`),
    '',
    `Question: ${question}`,
  ].join('\n');
}

/** 근거 표시 폴백: 원문 문장 최대 3개를 이어 붙인다(결정적). */
export function buildEvidenceFallback(
  evidence: readonly { document: string; sentence: string; expression: string }[],
): string | undefined {
  if (evidence.length === 0) return undefined;
  return evidence
    .slice(0, 3)
    .map((span) => span.sentence)
    .join(' ');
}

/**
 * 질의 경로 자격증명 우선순위: 요청 키 > process.env > 실행 디렉터리
 * `.env` > ~/.config/questail/.env. 서버는 브라우저에서 키를 받을 필요가 없다.
 * llm.ts 경로 재사용. 키 원문을 로그·응답에 싣지 않는다.
 * process.env를 파일보다 우선한다: 명령 앞 일회성 지정이 파일 설정을
 * 이기는 것이 관행이고 컨테이너·CI의 표준 주입 경로이기 때문이다.
 */
export function resolveQueryCredentials(
  request?: LlmCredentials,
  paths: { readonly cwd?: string; readonly home?: string; readonly env?: NodeJS.ProcessEnv } = {},
): LlmCredentials {
  if (request && hasApiKey(request)) return request;
  const fromEnv = resolveLlmCredentials(resolveExtractCredentials(pickQueryEnv(paths.env ?? process.env)));
  if (hasApiKey(fromEnv)) return fromEnv;
  const localEnvPath = resolve(paths.cwd ?? process.cwd(), '.env');
  const local = resolveLlmCredentials(resolveExtractCredentials(loadEnvFile(localEnvPath)));
  if (hasApiKey(local)) return local;
  const userEnvPath = resolve(paths.home ?? homedir(), '.config', 'questail', '.env');
  return resolveLlmCredentials(resolveExtractCredentials(loadEnvFile(userEnvPath)));
}

/** process.env에서 QUESTAIL_LLM_* 세 키만 뽑는다. 값 출력·보관은 하지 않는다. */
function pickQueryEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of ['QUESTAIL_LLM_API_KEY', 'QUESTAIL_LLM_BASE_URL', 'QUESTAIL_LLM_MODEL'] as const) {
    const value = env[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

export async function runAsk(
  question: string,
  mode: RetrieveMode,
  ctx: AskContext,
  credentials?: LlmCredentials,
  options: RunAskOptions = {},
): Promise<AskResult> {
  const allNodes = await ctx.deps.listNodes();
  const labels: Record<string, string> = {};
  for (const node of allNodes) labels[node.id] = node.label;
  const indexTitles = new Set(
    allNodes.filter((node) => node.kind === 'game').map((node) => node.label),
  );
  const titles = [...indexTitles].sort();
  const effective = resolveQueryCredentials(credentials);
  const keySource = credentials && hasApiKey(credentials) ? 'request' : hasApiKey(effective) ? 'env' : 'none';

  let appRoute: AppRoute | undefined;
  let category: string | undefined;
  let confidence = 0;
  let reason = 'llm-key-missing';
  let gameTitles: readonly string[] = [];
  if (hasApiKey(effective)) {
    try {
      const classified = await classifyQuestion(
        question,
        titles,
        (prompt) =>
          completeChat(effective, [{ role: 'user', content: prompt }], { maxTokens: 512, timeoutMs: 30000 }),
      );
      // tools일 때만 core ClassifyResult를 조립한다. routeQuestion 호출은
      // AgentDeps 배선이 필요해 후속 몫이며, graph면 라우터를 거치지 않는다.
      const validated = validateGameTitles(classified.gameTitles, indexTitles);
      const core = classified.route === 'tools' ? toCoreClassify({ ...classified, gameTitles: validated }) : undefined;
      appRoute = classified.route;
      category = core?.category;
      confidence = classified.confidence;
      reason = classified.reason;
      gameTitles = validated;
    } catch (error: unknown) {
      // 분류는 부가 경로라 실패해도 결정적 검색을 막지 않는다. 키 원문은
      // CollieLlmError에 절대 실리지 않으므로 reason에 code만 둔다.
      const code = error instanceof CollieLlmError ? error.code : 'unknown';
      reason = `classifier-error:${code}`;
    }
  }

  const shell = await runShell(question);
  const steps: AskStep[] = [
    {
      node: 'classify',
      level: 0,
      route: shell.route,
      ...(appRoute === undefined ? {} : { appRoute }),
      category,
      confidence,
      reason,
      gameTitles,
      keySource,
    },
    { node: 'policy', level: 0 },
  ];
  const { trace, mode: echoed } = await retrieve({
    question,
    mode,
    config: ctx.config,
    deps: ctx.deps,
    corpusFingerprint: ctx.corpusFingerprint,
    promptFingerprint: retrievePromptFingerprint(),
    modelId: effective.model?.trim() ? (effective.model as string).trim() : FALLBACK_MODEL_ID,
    ...(gameTitles.length > 0 ? { startTitles: [...gameTitles] } : {}),
  });
  for (const attempt of trace.attempts) steps.push({ node: 'retrieve', level: attempt.level });

  // respond: 경로를 찾았을 때만 생성한다. 무키·강제생략은 answer 없이
  // 근거만 표시(기존 동작 유지). 키 있음+실패·타임아웃만 근거 폴백한다.
  // 생성 실패는 조용히 넘기지 않고 stderr 한 줄 경고 + generationWarning에 남긴다.
  let answer: string | undefined;
  let generationWarning: string | undefined;
  if (trace.selectedPath !== null && trace.selectedPath !== undefined) {
    if (hasApiKey(effective) && options.complete !== null) {
      const fallback = buildEvidenceFallback(trace.evidenceSpans);
      const complete = options.complete ?? ((prompt: string) =>
        completeChat(effective, [{ role: 'user', content: prompt }], { maxTokens: 256, timeoutMs: 30000 }));
      try {
        const pathLabels = trace.selectedPath.nodes.map((id) => labels[id] ?? id);
        const pathEdges = trace.selectedPath.edges.map((edge) => ({
          type: edge.type,
          from: labels[edge.from] ?? edge.from,
          to: labels[edge.to] ?? edge.to,
          verified: edge.verified,
        }));
        const generated = await complete(buildRespondPrompt(question, pathLabels, trace.evidenceSpans, pathEdges));
        const text = generated.trim();
        answer = text ? text : fallback;
      } catch (error: unknown) {
        const reason = maskApiKeyText(
          error instanceof Error ? error.message : String(error),
          effective.apiKey,
        );
        generationWarning = `respond 생성 실패, 근거 폴백 사용: ${reason}`;
        console.warn(`[collie] ${generationWarning}`);
        answer = fallback;
      }
    }
  }
  return {
    trace,
    mode: echoed,
    steps,
    labels,
    ...(answer === undefined ? {} : { answer }),
    ...(generationWarning === undefined ? {} : { generationWarning }),
  };
}
