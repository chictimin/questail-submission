/**
 * `questail collie serve` — 얇은 배선 (P4-G).
 *
 * collie 공개 entry(`@questail/collie`)의 serve API만 쓴다. 내부 경로
 * (dist 하위 직접 import)는 두지 않는다. 서버 실물의 공개 export가
 * 아직 없으면 requireServeApi()가 명확한 메시지로 throw하고, export가
 * 들어오는 순간 그대로 동작한다 (seam 외 분기 없음).
 *
 * `--demo`는 합성 50건 corpus를 임시 디렉터리에 준비·graph build한 뒤
 * 그 산출물을 가리키는 graphPath·corpusDir과 corpusMode demo로
 * createCollieApp을 구동한다. 기본(real)은 corpusMode real만 넘기고
 * graph·corpus 경로는 서버 기본값에 맡긴다.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as colliePublic from '@questail/collie';

export const SERVE_DEFAULT_PORT = 4173;
export const LOOPBACK_HOST = '127.0.0.1';
export const ENV_PORT_KEY = 'COLLIE_PORT';

export const SERVE_USAGE = [
  '사용법:',
  '  questail collie serve [--demo] [--port <n>]',
  '',
  '  --demo       합성 50건 demo corpus를 임시 생성·build해 서빙 (기본값 real)',
  '  --port <n>   바인드 포트 (기본값 4173·COLLIE_PORT env, 127.0.0.1 고정)',
  '  -h, --help   이 도움말을 보여준다',
].join('\n');

export interface ServeOptions {
  /** --port 값. 생략 시 COLLIE_PORT env·기본값으로 resolveServePort가 정한다. */
  readonly port: number | undefined;
  /** --demo 값. true면 임시 demo corpus·graph를 build해 서빙한다. */
  readonly demo: boolean;
  readonly help: boolean;
}

/**
 * `collie serve` 뒤의 인자만 받는다. 관례는 build와 같다: 선행 `--`
 * 분리자를 걷어내고, 알 수 없는 옵션은 throw한다.
 */
export function parseServeArgs(args: readonly string[]): ServeOptions {
  const rest = args[0] === '--' ? args.slice(1) : [...args];
  let port: number | undefined;
  let demo = false;
  let help = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === '--port') {
      const value = rest[index + 1];
      if (value === undefined) throw new Error('값이 필요합니다: --port <n>');
      port = parsePortValue(value);
      index += 1;
    } else if (arg === '--demo') {
      demo = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else {
      throw new Error(`알 수 없는 옵션: ${arg}`);
    }
  }
  return { port, demo, help };
}

export function parsePortValue(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    // 서버 parsePort와 같은 메시지라 양쪽이 같은 입력을 같은 이유로 거부한다.
    throw new Error(`포트가 올바르지 않습니다: ${raw}`);
  }
  return port;
}

/** 우선순위 --port > COLLIE_PORT env > 4173 (서버 parsePort와 동일). */
export function resolveServePort(
  options: ServeOptions,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (options.port !== undefined) return options.port;
  const raw = env[ENV_PORT_KEY];
  if (raw === undefined || raw === '') return SERVE_DEFAULT_PORT;
  return parsePortValue(raw);
}

export type ServeCorpusMode = 'real' | 'demo';

/** createCollieApp에 넘길 앱 옵션. real은 경로 없이 corpusMode만 둔다. */
export interface ServeAppOptions {
  readonly graphPath?: string;
  readonly corpusDir?: string;
  readonly corpusMode: ServeCorpusMode;
}

export interface DemoBuildDeps {
  readonly prepareCorpus: (args: readonly string[]) => Promise<{ readonly documentCount: number }>;
  readonly buildAndWriteGraph: (corpusRoot: string, outputRoot: string) => Promise<unknown>;
  readonly mkdtemp: (prefix: string) => Promise<string>;
}

export function defaultDemoBuildDeps(): DemoBuildDeps {
  const api = colliePublic as unknown as {
    prepareCorpus?: DemoBuildDeps['prepareCorpus'];
    buildAndWriteGraph?: DemoBuildDeps['buildAndWriteGraph'];
  };
  if (typeof api.prepareCorpus !== 'function' || typeof api.buildAndWriteGraph !== 'function') {
    throw new Error('collie demo build 공개 export가 아직 없습니다 (prepare/build 구현 대기 중).');
  }
  return {
    prepareCorpus: api.prepareCorpus,
    buildAndWriteGraph: api.buildAndWriteGraph,
    mkdtemp: (prefix: string) => mkdtemp(prefix),
  };
}

/**
 * serve 모드 → createCollieApp 옵션. demo면 임시 루트 아래 corpus·graph를
 * 만들고 그 경로와 corpusMode demo를 돌려준다. real이면 경로 없이
 * corpusMode real만 돌려준다 (서버 기본 graph·corpus 사용).
 */
export async function resolveServeAppOptions(
  options: ServeOptions,
  deps?: DemoBuildDeps,
): Promise<ServeAppOptions> {
  if (!options.demo) return { corpusMode: 'real' };
  const build = deps ?? defaultDemoBuildDeps();
  const root = await build.mkdtemp(join(tmpdir(), 'questail-collie-demo-'));
  const corpusDir = join(root, 'corpus');
  const graphDir = join(root, 'graph');
  await build.prepareCorpus(['--demo', '--output-root', corpusDir]);
  await build.buildAndWriteGraph(corpusDir, graphDir);
  return { graphPath: join(graphDir, 'graph.v1.json'), corpusDir, corpusMode: 'demo' };
}

/** collie 공개 entry에서 기대하는 serve API 최소면. hono 타입은 CLI가 모른다. */
export interface CollieServeApi {
  readonly createCollieApp: (options?: ServeAppOptions) => {
    readonly fetch: (request: Request) => Response | Promise<Response>;
  };
  readonly serveCollieApp: (
    app: unknown,
    options?: { readonly port?: number; readonly hostname?: string },
  ) => unknown;
  readonly closeCollieServer?: (server: unknown) => Promise<void>;
}

export function requireServeApi(): CollieServeApi {
  const api = colliePublic as unknown as Partial<CollieServeApi>;
  if (typeof api.createCollieApp !== 'function' || typeof api.serveCollieApp !== 'function') {
    throw new Error('collie serve 공개 export가 아직 없습니다 (서버 구현 대기 중).');
  }
  return api as CollieServeApi;
}

function readActualPort(server: unknown, fallback: number): number {
  const address = (server as { address?: () => { port?: unknown } | null }).address?.();
  return typeof address?.port === 'number' ? address.port : fallback;
}

/**
 * serve 한 번 실행: loopback에 바인드하고 SIGINT·SIGTERM에 정상 종료한다.
 * serve()가 이벤트 루프를 붙잡으므로 성공 시 이 함수는 끝나지 않는다.
 */
export async function runServeCommand(options: ServeOptions): Promise<never> {
  const port = resolveServePort(options);
  const api = requireServeApi();
  const appOptions = await resolveServeAppOptions(options);
  const app = api.createCollieApp(appOptions);
  const server = api.serveCollieApp(app, { port, hostname: LOOPBACK_HOST });
  console.error(`collie serve: http://${LOOPBACK_HOST}:${readActualPort(server, port)} (loopback 고정)`);
  const shutdown = (): void => {
    void Promise.resolve(api.closeCollieServer?.(server)).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return new Promise<never>(() => {});
}
