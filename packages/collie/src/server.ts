/**
 * collie app 서버 (P4-G).
 *
 * Hono + @hono/node-server. loopback(127.0.0.1)에만 바인드하고, 포트는
 * 기본 4173이며 --port 플래그·COLLIE_PORT env로 덮을 수 있다.
 *
 * 계약: POST /ask {question, mode, credentials?} → SSE step{node,level}*
 * → result{mode, trace}. 거절도 HTTP 200에 trace.abstained=true.
 * 요청 자격증명은 메모리 객체로만 받고 log/응답에 키를 싣지 않는다
 * (redactSecrets + keyPresent boolean 로그만). 요청에 키가 없으면 runAsk가
 * 서버 실행 디렉터리 `.env`의 QUESTAIL_LLM_*을 읽는다. 브라우저가 provider에
 * 직접 요청하지 않는다.
 * 정적 public/ 서빙으로 화면이 same-origin /ask를 쓰게 한다.
 */
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SSEStreamingApi } from 'hono/streaming';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAskContext, runAsk, type AskContext, type AskResult } from './ask.js';
import type { RetrieveMode } from './retrieve/index.js';
import {
  hasApiKey,
  redactSecrets,
  resolveLlmCredentials,
  type LlmCredentials,
  type LlmCredentialsInput,
} from './llm.js';

export const DEFAULT_PORT = 4173;
export const LOOPBACK_HOST = '127.0.0.1';
export const ENV_PORT_KEY = 'COLLIE_PORT';
export const ASK_VERSION = 'retrieve-v1';
const MAX_PORT = 65535;

export function parsePort(argv: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): number {
  const flagIndex = argv.indexOf('--port');
  const raw = flagIndex >= 0 ? argv[flagIndex + 1] : env[ENV_PORT_KEY];
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`포트가 올바르지 않습니다: ${raw}`);
  }
  return port;
}

export interface CollieBindOptions {
  readonly port?: number;
  /** loopback 고정. 0.0.0.0 같은 외부 바인드는 지원하지 않는다. */
  readonly hostname?: typeof LOOPBACK_HOST;
}

export function resolveBindOptions(options: CollieBindOptions = {}): { port: number; hostname: typeof LOOPBACK_HOST } {
  const hostname = options.hostname ?? LOOPBACK_HOST;
  if (hostname !== LOOPBACK_HOST) throw new Error('collie 서버는 127.0.0.1에만 바인드합니다.');
  return { port: options.port ?? DEFAULT_PORT, hostname };
}

export interface CollieAppOptions {
  readonly configPath?: string;
  readonly graphPath?: string;
  readonly corpusDir?: string;
  /** 지정 시 요청 mode와 다르면 POST 409·stream error로 거부한다. 미지정 시 검사하지 않는다. */
  readonly corpusMode?: RetrieveMode;
  readonly publicDir?: string;
  readonly evalPath?: string;
}

interface AskBody {
  readonly question?: unknown;
  readonly mode?: unknown;
  /** 요청 메모리 전용. 저장·echo하지 않는다. */
  readonly credentials?: LlmCredentialsInput;
}

function readBearer(headerValue: string | undefined): string | undefined {
  const match = headerValue?.match(/^Bearer (.+)$/);
  return match?.[1]?.trim() ? match[1].trim() : undefined;
}

function defaultPublicDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'public');
}

function defaultEvalPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'eval', 'questions.json');
}

function isValidMode(value: unknown): value is RetrieveMode {
  return value === 'real' || value === 'demo';
}

function corpusModeMismatch(corpusMode: RetrieveMode): string {
  return `mode 불일치: 이 서버는 '${corpusMode}' corpus만 서빙합니다.`;
}

function resolveRequestCredentials(body: AskBody, authorization: string | undefined): LlmCredentials {
  // 요청 단위 메모리 객체. 이 범위를 벗어나 보관하지 않는다.
  return resolveLlmCredentials({
    ...body.credentials,
    apiKey: readBearer(authorization) ?? body.credentials?.apiKey,
  });
}

function errorPayload(error: unknown): string {
  const message = error instanceof Error ? error.message : '실행 실패';
  return JSON.stringify(redactSecrets({ message }));
}

async function emitAskResult(stream: SSEStreamingApi, result: AskResult): Promise<void> {
  for (const step of result.steps) {
    // SSE 계약은 명시 화이트리스트만 싣는다. 필드 추가가 자동 확장되면 안 된다.
    await stream.writeSSE({
      event: 'step',
      data: JSON.stringify({
        node: step.node,
        level: step.level,
        ...(step.route === undefined ? {} : { route: step.route }),
        ...(step.appRoute === undefined ? {} : { appRoute: step.appRoute }),
        ...(step.category === undefined ? {} : { category: step.category }),
        ...(typeof step.confidence === 'number' ? { confidence: step.confidence } : {}),
        ...(step.reason === undefined ? {} : { reason: step.reason }),
        ...(step.gameTitles === undefined ? {} : { gameTitles: step.gameTitles }),
        ...(step.keySource === undefined ? {} : { keySource: step.keySource }),
      }),
    });
  }
  await stream.writeSSE({
    event: 'result',
    data: JSON.stringify({
      mode: result.mode,
      trace: result.trace,
      ...(result.labels === undefined ? {} : { labels: result.labels }),
      ...(result.answer === undefined ? {} : { answer: result.answer }),
    }),
  });
}

export function createCollieApp(options: CollieAppOptions = {}): Hono {
  const ctx: AskContext = createAskContext(options);
  const corpusMode = options.corpusMode;
  const publicDir = options.publicDir ?? defaultPublicDir();
  const indexHtml = readFileSync(resolve(publicDir, 'index.html'), 'utf8');
  const fixturesDir = resolve(publicDir, 'fixtures');
  const evalPath = options.evalPath ?? defaultEvalPath();

  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, service: 'collie', mode: ASK_VERSION }));

  app.get('/', (c) => c.text(indexHtml, 200, { 'content-type': 'text/html; charset=utf-8' }));

  app.get('/fixtures/:name', (c) => {
    const name = c.req.param('name');
    if (!/^[\w-]+\.json$/.test(name)) return c.text('not found', 404);
    const file = resolve(fixturesDir, name);
    if (!file.startsWith(fixturesDir + sep) || !existsSync(file)) return c.text('not found', 404);
    return c.text(readFileSync(file, 'utf8'), 200, { 'content-type': 'application/json; charset=utf-8' });
  });

  // 평가셋 모달용. 디스크에서 매번 읽어 새로고침을 반영한다. UI 인라인 금지.
  app.get('/eval/questions', (c) => {
    if (!existsSync(evalPath)) return c.text('not found', 404);
    return c.text(readFileSync(evalPath, 'utf8'), 200, { 'content-type': 'application/json; charset=utf-8' });
  });

  app.post('/ask', async (c) => {
    const body = await c.req.json<AskBody>().catch((): AskBody => ({}));
    if (typeof body.question !== 'string' || body.question.trim() === '') {
      return c.json({ error: 'question(문자열)이 필요합니다.' }, 400);
    }
    if (!isValidMode(body.mode)) {
      return c.json({ error: "mode는 'real'|'demo' 중 명시해야 합니다." }, 400);
    }
    if (corpusMode !== undefined && body.mode !== corpusMode) {
      return c.json({ error: corpusModeMismatch(corpusMode) }, 409);
    }
    const question = body.question.trim();
    const mode = body.mode;
    const credentials = resolveRequestCredentials(body, c.req.header('authorization'));
    console.log(JSON.stringify({ method: 'POST', path: '/ask', mode, keyPresent: hasApiKey(credentials) }));
    return streamSSE(c, async (stream) => {
      try {
        await emitAskResult(stream, await runAsk(question, mode, ctx, credentials));
      } catch (error: unknown) {
        await stream.writeSSE({ event: 'error', data: errorPayload(error) });
      }
    });
  });

  app.get('/stream/ask', (c) => {
    const question = c.req.query('question')?.trim() ?? '';
    const modeParam = c.req.query('mode')?.trim() ?? 'real';
    return streamSSE(c, async (stream) => {
      if (question === '') {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: 'question(문자열)이 필요합니다.' }) });
        return;
      }
      if (!isValidMode(modeParam)) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: "mode는 'real'|'demo' 중 명시해야 합니다." }) });
        return;
      }
      if (corpusMode !== undefined && modeParam !== corpusMode) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: corpusModeMismatch(corpusMode) }) });
        return;
      }
      const credentials = resolveRequestCredentials({}, c.req.header('authorization'));
      try {
        await emitAskResult(stream, await runAsk(question, modeParam, ctx, credentials));
      } catch (error: unknown) {
        await stream.writeSSE({ event: 'error', data: errorPayload(error) });
      }
    });
  });

  return app;
}

export function serveCollieApp(app: Hono, options: CollieBindOptions = {}): ServerType {
  const bind = resolveBindOptions(options);
  return serve({ fetch: app.fetch, port: bind.port, hostname: bind.hostname });
}

export function closeCollieServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    // fetch keep-alive 소켓이 닫힘을 막으므로 먼저 끊는다.
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close((error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
