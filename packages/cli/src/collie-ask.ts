/**
 * `questail collie ask` — headless runAsk 계약 호출 (P4-G).
 *
 * 같은 runAsk 계약의 HTTP 호출이다: POST /ask {question, mode} →
 * SSE step{node,level}* → result{mode, trace}. serve 화면과 같은
 * runAsk를 때리므로 같은 질문에는 같은 답이 온다. collie import는
 * 없다 (순수 HTTP + 로컬 렌더).
 *
 * 종료 코드: 0 답변, 2 보류(abstain), 1 사용법·연결·서버 오류.
 */

export type AskMode = 'real' | 'demo';

export const DEFAULT_ASK_PORT = 4173;
export const ENV_PORT_KEY = 'COLLIE_PORT';
const FETCH_TIMEOUT_MS = 30_000;

export const ASK_USAGE = [
  '사용법:',
  '  questail collie ask <질문> [--mode <real|demo>] [--port <n>] [--base-url <url>] [--dev]',
  '',
  '  --mode <real|demo>  검색 모드 (기본값 demo, 서버는 명시 필수라 CLI가 대신 명시한다)',
  '  --port <n>          collie serve 포트 (기본값 4173·COLLIE_PORT env)',
  '  --base-url <url>    서버 기준 주소 직접 지정 (--port보다 우선)',
  '  --dev               ID 병기 표시 (기본 출력은 표시제목만, 숫자 ID 없음)',
  '  -h, --help          이 도움말을 보여준다',
  '',
  '종료 코드: 0 답변, 2 보류(근거 부족), 1 오류.',
].join('\n');

export interface AskOptions {
  readonly question: string;
  readonly mode: AskMode;
  readonly baseUrl: string;
  /** true면 표시제목 뒤에 (id)를 병기한다. 기본값은 제목만. */
  readonly dev: boolean;
  readonly help: boolean;
}

function parsePortValue(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    // 서버 parsePort와 같은 메시지라 양쪽이 같은 입력을 같은 이유로 거부한다.
    throw new Error(`포트가 올바르지 않습니다: ${raw}`);
  }
  return port;
}

/**
 * `collie ask` 뒤의 인자만 받는다. 질문은 위치 인자 전체를 공백으로
 * 이어 붙인다. 관례는 build와 같다: 선행 `--` 분리자를 걷어내고,
 * 알 수 없는 옵션은 throw한다 (호출자가 stderr+usage+exit 1).
 */
export function parseAskArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): AskOptions {
  const rest = args[0] === '--' ? args.slice(1) : [...args];
  const words: string[] = [];
  let mode: AskMode = 'demo';
  let portFlag: string | undefined;
  let baseUrl: string | undefined;
  let dev = false;
  let help = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === '--mode') {
      const value = rest[index + 1];
      if (value !== 'real' && value !== 'demo') throw new Error(`알 수 없는 모드: ${value ?? ''} (real|demo 중 명시)`);
      mode = value;
      index += 1;
    } else if (arg === '--port') {
      const value = rest[index + 1];
      if (value === undefined) throw new Error('값이 필요합니다: --port <n>');
      portFlag = value;
      index += 1;
    } else if (arg === '--base-url') {
      const value = rest[index + 1];
      if (value === undefined) throw new Error('값이 필요합니다: --base-url <url>');
      baseUrl = value.replace(/\/+$/, '');
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--dev') {
      dev = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`알 수 없는 옵션: ${arg}`);
    } else {
      words.push(arg);
    }
  }
  const question = words.join(' ').trim();
  if (!help && question === '') throw new Error('질문이 필요합니다.');
  const port = portFlag !== undefined ? parsePortValue(portFlag) : parsePortValue(env[ENV_PORT_KEY] ?? String(DEFAULT_ASK_PORT));
  return { question, mode, baseUrl: baseUrl ?? `http://127.0.0.1:${port}`, dev, help };
}

export interface AskStepEvent {
  readonly node: string;
  readonly level: number;
  readonly route?: string;
}

export interface AskAttemptSnapshot {
  readonly level?: number;
  readonly outcome?: string;
  readonly stopReason?: string;
}

export interface AskTraceSnapshot {
  readonly runId?: string;
  readonly modelId?: string;
  readonly retrievalLevel?: number;
  readonly relaxationReason?: string;
  readonly attempts?: readonly AskAttemptSnapshot[];
  readonly selectedPath?: { readonly nodes?: readonly string[] } | null;
  readonly evidenceSpans?: readonly {
    readonly document?: string;
    readonly sentence?: string;
    readonly expression?: string;
  }[];
  readonly abstained?: boolean;
}

export interface AskOutcome {
  readonly steps: readonly AskStepEvent[];
  readonly mode: AskMode;
  readonly trace: AskTraceSnapshot;
  /** 노드ID → 표시제목. 서버가 생략하면 빈 맵으로 둔다. */
  readonly labels: Readonly<Record<string, string>>;
  /** 서버가 조립한 답변 문장. 없으면 현재 렌더 그대로 둔다. */
  readonly answer?: string;
}

function parseSseBlock(block: string): { event: string; data: string } | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (event === undefined) return undefined;
  return { event, data: dataLines.join('\n') };
}

/**
 * SSE 스트림을 읽어 step을 모으고 result를 반환한다. error 이벤트나
 * result 없는 종료는 throw한다. onStep이 있으면 도착 즉시 호출한다
 * (stderr 진행 표시용).
 */
export async function readAskStream(
  body: ReadableStream<Uint8Array>,
  onStep?: (step: AskStepEvent) => void,
): Promise<
  Omit<AskOutcome, 'mode' | 'labels' | 'answer'> & {
    mode: unknown;
    labels: Readonly<Record<string, string>>;
    answer?: string;
  }
> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const steps: AskStepEvent[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const frame = parseSseBlock(block);
      if (frame === undefined) continue;
      if (frame.event === 'step') {
        const step = JSON.parse(frame.data) as AskStepEvent;
        steps.push(step);
        onStep?.(step);
      } else if (frame.event === 'result') {
        const result = JSON.parse(frame.data) as {
          mode?: unknown;
          trace?: unknown;
          labels?: unknown;
          answer?: unknown;
        };
        if (typeof result.mode !== 'string' || typeof result.trace !== 'object' || result.trace === null) {
          throw new Error('서버 응답 형식 오류: result에 mode·trace가 없습니다.');
        }
        const labels =
          typeof result.labels === 'object' && result.labels !== null
            ? (result.labels as Readonly<Record<string, string>>)
            : {};
        const answer = typeof result.answer === 'string' && result.answer.trim() !== '' ? result.answer : undefined;
        return { steps, mode: result.mode, trace: result.trace as AskTraceSnapshot, labels, answer };
      } else if (frame.event === 'error') {
        let message = frame.data;
        try {
          message = String((JSON.parse(frame.data) as { message?: unknown }).message ?? frame.data);
        } catch {
          // JSON이 아니면 원문 그대로
        }
        throw new Error(`서버 오류: ${message}`);
      }
    }
    if (done) break;
  }
  throw new Error('서버 응답이 result 없이 끝났습니다.');
}

function connectionError(baseUrl: string): Error {
  return new Error(`서버에 연결할 수 없습니다: ${baseUrl} (questail collie serve가 실행 중인지 확인하세요)`);
}

/** POST /ask 한 번. 진행 step은 onStep으로 흘려보낸다. */
export async function fetchAsk(
  options: Pick<AskOptions, 'baseUrl' | 'question' | 'mode'>,
  onStep?: (step: AskStepEvent) => void,
): Promise<AskOutcome> {
  const { baseUrl, question, mode } = options;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, mode }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw connectionError(baseUrl);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let detail = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === 'string') detail = parsed.error;
    } catch {
      // JSON이 아니면 원문 앞부분 그대로
    }
    throw new Error(`서버 오류 (HTTP ${response.status}): ${detail}`);
  }
  if (!response.body) throw new Error('서버 응답 본문이 비어 있습니다.');
  const outcome = await readAskStream(response.body, onStep);
  if (outcome.mode !== 'real' && outcome.mode !== 'demo') {
    throw new Error('서버 응답 형식 오류: mode가 real|demo가 아닙니다.');
  }
  return {
    steps: outcome.steps,
    mode: outcome.mode,
    trace: outcome.trace,
    labels: outcome.labels,
    ...(outcome.answer === undefined ? {} : { answer: outcome.answer }),
  };
}

export interface RenderedAsk {
  /** stdout에 찍을 본문. */
  readonly text: string;
  readonly abstained: boolean;
}

export interface RenderAskOptions {
  /** true면 표시제목 뒤에 (id)를 병기한다. 기본 출력은 제목만이다. */
  readonly dev?: boolean;
}

interface EvidenceGroup {
  readonly document: string;
  readonly sentence: string;
  readonly expressions: readonly string[];
}

/**
 * 근거 중복 표시 제거: (document, sentence)로 묶고 expression을 모아
 * 한 줄로 보여준다. 화면(UI groupedEvidence)과 같은 규칙이다 —
 * 빈 표현은 버리고 중복은 첫 등장만 남기며 순서를 유지한다.
 * 근거 수 표기는 묶은 뒤 개수다.
 */
export function groupEvidenceSpans(
  spans:
    | readonly {
        readonly document?: string;
        readonly sentence?: string;
        readonly expression?: string;
      }[]
    | undefined,
): EvidenceGroup[] {
  const groups: { document: string; sentence: string; expressions: string[] }[] = [];
  const seen = new Map<string, (typeof groups)[number]>();
  for (const span of spans ?? []) {
    const key = `${span?.document}|${span?.sentence}`;
    let group = seen.get(key);
    if (!group) {
      group = { document: span?.document ?? '?', sentence: span?.sentence ?? '', expressions: [] };
      seen.set(key, group);
      groups.push(group);
    }
    const expression = span?.expression == null ? '' : String(span.expression);
    if (expression && !group.expressions.includes(expression)) group.expressions.push(expression);
  }
  return groups;
}

/**
 * result{mode, trace, labels, answer?} 렌더. 답/보류를 문자열로 구분한다.
 * AskResult.answer가 있으면 출력 맨 위에 두고, 없으면 현재 렌더 그대로 둔다.
 * 경로는 labels[id] ?? id로 표시하고, 근거 문서는 같은 게임 노드의
 * 제목으로 푼다 (`<appid>.md` → labels[`game:<appid>`]).
 */
export function renderAskOutcome(outcome: AskOutcome, options: RenderAskOptions = {}): RenderedAsk {
  const { mode, trace, labels } = outcome;
  const dev = options.dev === true;
  const display = (id: string): string => {
    const title = labels[id] ?? id;
    return dev && title !== id ? `${title} (${id})` : title;
  };
  const displayDocument = (document: string): string => {
    const stem = document.endsWith('.md') ? document.slice(0, -'.md'.length) : undefined;
    const title = stem !== undefined ? (labels[`game:${stem}`] ?? document) : document;
    return dev && title !== document ? `${title} (${document})` : title;
  };
  const header = `mode=${mode}${trace.runId ? ` run=${trace.runId}` : ''}`;
  const nodes = trace.selectedPath?.nodes ?? [];
  if (trace.abstained === true || nodes.length === 0) {
    const lines = ['답을 보류합니다 (근거 부족).', header];
    const attempts = (trace.attempts ?? []).map(
      (attempt) => `L${attempt.level ?? '?'} ${attempt.outcome ?? '?'} (${attempt.stopReason ?? '?'})`,
    );
    if (attempts.length > 0) lines.push(`시도: ${attempts.join(', ')}`);
    if (trace.relaxationReason) lines.push(`사유: ${trace.relaxationReason}`);
    if (outcome.answer !== undefined) lines.unshift(outcome.answer);
    return { text: lines.join('\n'), abstained: true };
  }
  const lines = [header, `경로: ${nodes.map(display).join(' → ')}`];
  const groups = groupEvidenceSpans(trace.evidenceSpans);
  if (groups.length > 0) {
    lines.push(`근거 ${groups.length}건:`);
    for (const group of groups) {
      lines.push(`- [${displayDocument(group.document)}] ${group.sentence} — ${group.expressions.join(', ')}`);
    }
  }
  if (outcome.answer !== undefined) lines.unshift(outcome.answer);
  return { text: lines.join('\n'), abstained: false };
}

/**
 * `collie ask` 한 번 실행: step은 stderr에 흘리고 최종 렌더를
 * stdout에 찍는다. 반환값이 프로세스 종료 코드다 (0 답변·2 보류).
 */
export async function runAskCommand(options: AskOptions): Promise<number> {
  const outcome = await fetchAsk(options, (step) => {
    console.error(`step ${step.node} level=${step.level}`);
  });
  const rendered = renderAskOutcome(outcome, { dev: options.dev });
  console.log(rendered.text);
  return rendered.abstained ? 2 : 0;
}
