/**
 * P4-G serve·ask 테스트.
 *
 * 실행 (둘 다 같은 결과):
 *   `tsc -p packages/cli` 후 `node --test packages/cli/dist/collie-serve-ask.test.js`
 *   `pnpm --filter @questail/cli exec tsx --test src/collie-serve-ask.test.ts`
 *
 * ask는 순수 HTTP라 mock SSE 서버로 전부 검증한다. serve 실행은
 * collie 공개 export가 있어야 해서, 없으면 명확한 메시지와 함께
 * skip한다 (조용한 통과 금지). 프로세스 수준 테스트는 dist 산출물을
 * 요구하며, 없으면 skip한다 (6b와 같은 패턴).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as colliePublic from '@questail/collie';
import {
  ASK_USAGE,
  fetchAsk,
  groupEvidenceSpans,
  parseAskArgs,
  renderAskOutcome,
  runAskCommand,
  type AskOutcome,
} from './collie-ask.js';
import {
  SERVE_USAGE,
  parseServeArgs,
  requireServeApi,
  resolveServeAppOptions,
  resolveServePort,
} from './collie-serve.js';

// ─── dist/공개-export 가드 (명확 메시지 후 skip, 조용한 통과 금지) ───

const CLI_JS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const HAS_DIST = existsSync(CLI_JS);
const DIST_SKIP_MESSAGE = `dist 산출물 없음 (${CLI_JS}): tsc -p packages/cli 먼저 실행`;

const serveApiSurface = colliePublic as unknown as {
  createCollieApp?: unknown;
  serveCollieApp?: unknown;
  closeCollieServer?: unknown;
};
const HAS_SERVE_API =
  typeof serveApiSurface.createCollieApp === 'function' &&
  typeof serveApiSurface.serveCollieApp === 'function' &&
  typeof serveApiSurface.closeCollieServer === 'function';
const SERVE_SKIP_MESSAGE = 'collie serve 공개 export 대기 중 (서버 구현 후 실행)';

function runCli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  assert.ok(HAS_DIST, DIST_SKIP_MESSAGE);
  const result = spawnSync(process.execPath, [CLI_JS, ...args], { encoding: 'utf-8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * mock 서버와 같은 프로세스에서 동행하는 테스트용. spawnSync는 부모
 * 이벤트 루프를 막아 mock이 응답하지 못하는 교착에 빠지므로, 자식
 * 프로세스가 살아있는 동안 mock이 계속 서빙하도록 비동기로 기다린다.
 */
function runCliAsync(...args: string[]): Promise<CliResult> {
  assert.ok(HAS_DIST, DIST_SKIP_MESSAGE);
  return new Promise<CliResult>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI_JS, ...args]);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI 시간 초과: collie ${args.join(' ')}`));
    }, 25_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ status: code, stdout, stderr });
    });
  });
}

// ─── mock SSE 서버 ───

function sseBody(frames: readonly { event: string; data: unknown }[]): string {
  return (
    frames
      .map((frame) => `event: ${frame.event}\ndata: ${typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data)}`)
      .join('\n\n') + '\n\n'
  );
}

const ANSWER_LABELS = { 'game:1': 'Game One', 'dev-a': 'Dev A', 'game:2': 'Game Two' };

const ANSWER_TRACE = {
  runId: 'ret-test-answer',
  modelId: 'collie-deterministic',
  retrievalLevel: 0,
  corpusFingerprint: 'fp-test',
  attempts: [{ level: 0, outcome: 'paths_found', stopReason: 'paths_found' }],
  selectedPath: { nodes: ['game:1', 'dev-a', 'game:2'], edges: [] },
  evidenceSpans: [{ document: '1.md', sentence: 'Game One body.', expression: 'Game One' }],
  abstained: false,
};

const ABSTAIN_TRACE = {
  runId: 'ret-test-abstain',
  modelId: 'collie-deterministic',
  attempts: [{ level: 0, outcome: 'entity_unresolved', stopReason: 'no_paths' }],
  selectedPath: null,
  evidenceSpans: [],
  relaxationReason: 'L0 no_paths 후보 0',
  abstained: true,
};

interface MockAskServer {
  readonly url: string;
  readonly lastBody: () => unknown;
  readonly close: () => Promise<void>;
}

async function startMockAskServer(
  respond: (body: unknown) => { status: number; payload: unknown },
): Promise<MockAskServer> {
  let lastBody: unknown;
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/ask') {
      response.writeHead(404).end();
      return;
    }
    let text = '';
    request.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    request.on('end', () => {
      lastBody = JSON.parse(text) as unknown;
      const { status, payload } = respond(lastBody);
      if (status === 200 && typeof payload !== 'string') {
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(payload as string);
      } else if (typeof payload === 'string') {
        response.writeHead(status, { 'content-type': 'text/event-stream' }).end(payload);
      } else {
        response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
      }
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    lastBody: () => lastBody,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((error?: Error) => {
          if (error) reject(error);
          else resolvePromise();
        });
      }),
  };
}

async function closedPort(): Promise<number> {
  const server: Server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error?: Error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
  return port;
}

// ─── parse ───

describe('parseServeArgs', () => {
  it('빈 인자는 기본값', () => {
    assert.deepEqual(parseServeArgs([]), { port: undefined, demo: false, help: false });
  });

  it('--port 파싱', () => {
    assert.equal(parseServeArgs(['--port', '5000']).port, 5000);
  });

  it('--demo 파싱 (기본값 real)', () => {
    assert.equal(parseServeArgs([]).demo, false);
    assert.equal(parseServeArgs(['--demo']).demo, true);
    assert.equal(parseServeArgs(['--', '--demo']).demo, true);
    assert.equal(parseServeArgs(['--demo', '--port', '5000']).port, 5000);
  });

  it('잘못된 포트는 서버와 같은 메시지로 throw', () => {
    assert.throws(() => parseServeArgs(['--port', 'x']), /포트가 올바르지 않습니다: x/);
    assert.throws(() => parseServeArgs(['--port', '0']), /포트가 올바르지 않습니다/);
    assert.throws(() => parseServeArgs(['--port']), /값이 필요합니다/);
  });

  it('알 수 없는 옵션은 throw', () => {
    assert.throws(() => parseServeArgs(['--host', 'x']), /알 수 없는 옵션/);
  });
});

describe('resolveServePort', () => {
  it('우선순위 --port > COLLIE_PORT > 4173', () => {
    assert.equal(resolveServePort({ port: 5001, demo: false, help: false }, { COLLIE_PORT: '5002' }), 5001);
    assert.equal(resolveServePort({ port: undefined, demo: false, help: false }, { COLLIE_PORT: '5002' }), 5002);
    assert.equal(resolveServePort({ port: undefined, demo: false, help: false }, {}), 4173);
  });

  it('깨진 env 포트는 throw', () => {
    assert.throws(() => resolveServePort({ port: undefined, demo: false, help: false }, { COLLIE_PORT: 'nope' }), /포트가 올바르지 않습니다/);
  });
});

describe('resolveServeAppOptions', () => {
  it('기본(real)은 경로 없이 corpusMode real만 — build를 호출하지 않는다', async () => {
    const appOptions = await resolveServeAppOptions(
      { port: undefined, demo: false, help: false },
      {
        prepareCorpus: () => {
          throw new Error('real에서 호출되면 안 된다');
        },
        buildAndWriteGraph: () => {
          throw new Error('real에서 호출되면 안 된다');
        },
        mkdtemp: () => {
          throw new Error('real에서 호출되면 안 된다');
        },
      },
    );
    assert.deepEqual(appOptions, { corpusMode: 'real' });
  });

  it('--demo는 임시 corpus 준비·graph build 후 graphPath·corpusDir·corpusMode demo', async () => {
    const calls: string[] = [];
    const root = join(tmpdir(), 'questail-collie-demo-test');
    const appOptions = await resolveServeAppOptions(
      { port: undefined, demo: true, help: false },
      {
        prepareCorpus: async (args) => {
          calls.push(`prepare:${args.join(' ')}`);
          return { documentCount: 50 };
        },
        buildAndWriteGraph: async (corpusRoot, outputRoot) => {
          calls.push(`build:${corpusRoot} ${outputRoot}`);
          return {};
        },
        mkdtemp: async () => root,
      },
    );
    const corpusDir = join(root, 'corpus');
    const graphDir = join(root, 'graph');
    assert.deepEqual(calls, [`prepare:--demo --output-root ${corpusDir}`, `build:${corpusDir} ${graphDir}`]);
    assert.deepEqual(appOptions, {
      graphPath: join(graphDir, 'graph.v1.json'),
      corpusDir,
      corpusMode: 'demo',
    });
  });

  it('USAGE는 --demo를 안내한다', () => {
    assert.match(SERVE_USAGE, /--demo/);
  });
});

describe('parseAskArgs', () => {
  it('질문 결합 + 기본값 demo·4173', () => {
    assert.deepEqual(parseAskArgs(['Game', 'One', '같은', '개발사'], {}), {
      question: 'Game One 같은 개발사',
      mode: 'demo',
      baseUrl: 'http://127.0.0.1:4173',
      dev: false,
      help: false,
    });
  });

  it('--dev 플래그', () => {
    assert.equal(parseAskArgs(['q', '--dev'], {}).dev, true);
    assert.equal(parseAskArgs(['q'], {}).dev, false);
  });

  it('--mode·--port·--base-url', () => {
    const options = parseAskArgs(['q', '--mode', 'real', '--port', '5000'], {});
    assert.equal(options.mode, 'real');
    assert.equal(options.baseUrl, 'http://127.0.0.1:5000');
    assert.equal(parseAskArgs(['q', '--base-url', 'http://127.0.0.1:9999/'], {}).baseUrl, 'http://127.0.0.1:9999');
  });

  it('COLLIE_PORT env 반영', () => {
    assert.equal(parseAskArgs(['q'], { COLLIE_PORT: '4999' }).baseUrl, 'http://127.0.0.1:4999');
  });

  it('질문 없음·모드 오타·포트 오타는 throw', () => {
    assert.throws(() => parseAskArgs([], {}), /질문이 필요합니다/);
    assert.throws(() => parseAskArgs(['q', '--mode', 'weird'], {}), /알 수 없는 모드/);
    assert.throws(() => parseAskArgs(['q', '--port', 'x'], {}), /포트가 올바르지 않습니다/);
    assert.throws(() => parseAskArgs(['q', '--nope'], {}), /알 수 없는 옵션/);
  });
});

// ─── ask 계약 (mock SSE) ───

describe('fetchAsk (mock SSE)', () => {
  it('step* → result{mode, trace}를 받고 서버에 {question, mode}를 보낸다', async () => {
    const server = await startMockAskServer(() => ({
      status: 200,
      payload: sseBody([
        { event: 'step', data: { node: 'classify', level: 0, route: 'x' } },
        { event: 'step', data: { node: 'policy', level: 0 } },
        { event: 'step', data: { node: 'retrieve', level: 0 } },
        { event: 'result', data: { mode: 'demo', trace: ANSWER_TRACE, labels: ANSWER_LABELS } },
      ]),
    }));
    try {
      const steps: string[] = [];
      const outcome = await fetchAsk(
        { baseUrl: server.url, question: 'Game One', mode: 'demo' },
        (step) => {
          steps.push(step.node);
        },
      );
      assert.deepEqual(steps, ['classify', 'policy', 'retrieve']);
      assert.equal(outcome.mode, 'demo');
      assert.equal(outcome.trace.abstained, false);
      assert.deepEqual(outcome.labels, ANSWER_LABELS);
      assert.deepEqual(server.lastBody(), { question: 'Game One', mode: 'demo' });
    } finally {
      await server.close();
    }
  });

  it('answer가 있으면 그대로 통과시키고 없으면 undefined로 둔다', async () => {
    const withAnswer = await startMockAskServer(() => ({
      status: 200,
      payload: sseBody([
        { event: 'result', data: { mode: 'demo', trace: ANSWER_TRACE, labels: ANSWER_LABELS, answer: '정답 문장' } },
      ]),
    }));
    try {
      const outcome = await fetchAsk({ baseUrl: withAnswer.url, question: 'q', mode: 'demo' });
      assert.equal(outcome.answer, '정답 문장');
    } finally {
      await withAnswer.close();
    }

    const withoutAnswer = await startMockAskServer(() => ({
      status: 200,
      payload: sseBody([{ event: 'result', data: { mode: 'demo', trace: ANSWER_TRACE } }]),
    }));
    try {
      const outcome = await fetchAsk({ baseUrl: withoutAnswer.url, question: 'q', mode: 'demo' });
      assert.equal(outcome.answer, undefined);
    } finally {
      await withoutAnswer.close();
    }
  });

  it('labels 없는 result는 빈 맵으로 둔다', async () => {
    const server = await startMockAskServer(() => ({
      status: 200,
      payload: sseBody([{ event: 'result', data: { mode: 'demo', trace: ANSWER_TRACE } }]),
    }));
    try {
      const outcome = await fetchAsk({ baseUrl: server.url, question: 'q', mode: 'demo' });
      assert.deepEqual(outcome.labels, {});
    } finally {
      await server.close();
    }
  });

  it('보류 trace도 HTTP 200 result로 받는다', async () => {
    const server = await startMockAskServer(() => ({
      status: 200,
      payload: sseBody([{ event: 'result', data: { mode: 'demo', trace: ABSTAIN_TRACE } }]),
    }));
    try {
      const outcome = await fetchAsk({ baseUrl: server.url, question: 'zzz', mode: 'demo' });
      assert.equal(outcome.trace.abstained, true);
      assert.equal(outcome.trace.selectedPath, null);
    } finally {
      await server.close();
    }
  });

  it('error 이벤트·400·result 누락은 throw', async () => {
    const errorServer = await startMockAskServer(() => ({
      status: 200,
      payload: sseBody([{ event: 'error', data: { message: '폭발' } }]),
    }));
    await assert.rejects(() => fetchAsk({ baseUrl: errorServer.url, question: 'q', mode: 'demo' }), /서버 오류: 폭발/);
    await errorServer.close();

    const badServer = await startMockAskServer(() => ({ status: 400, payload: { error: 'question(문자열)이 필요합니다.' } }));
    await assert.rejects(
      () => fetchAsk({ baseUrl: badServer.url, question: 'q', mode: 'demo' }),
      /서버 오류 \(HTTP 400\): question\(문자열\)이 필요합니다\./,
    );
    await badServer.close();

    const emptyServer = await startMockAskServer(() => ({ status: 200, payload: sseBody([]) }));
    await assert.rejects(() => fetchAsk({ baseUrl: emptyServer.url, question: 'q', mode: 'demo' }), /result 없이 끝났습니다/);
    await emptyServer.close();
  });

  it('닫힌 포트는 연결 실패로 구분된다', async () => {
    const port = await closedPort();
    await assert.rejects(
      fetchAsk({ baseUrl: `http://127.0.0.1:${port}`, question: 'q', mode: 'demo' }),
      /서버에 연결할 수 없습니다.*questail collie serve/,
    );
  });
});

describe('renderAskOutcome (labels 3종)', () => {
  const labeled = {
    steps: [],
    mode: 'demo',
    trace: ANSWER_TRACE as unknown as AskOutcome['trace'],
    labels: ANSWER_LABELS,
  } as AskOutcome;

  it('labels 유: 표시제목만, 숫자 ID 없음', () => {
    const rendered = renderAskOutcome(labeled);
    assert.equal(rendered.abstained, false);
    assert.match(rendered.text, /경로: Game One → Dev A → Game Two/);
    assert.match(rendered.text, /\[Game One\] Game One body\./);
    assert.doesNotMatch(rendered.text, /game:1/);
    assert.doesNotMatch(rendered.text, /1\.md/);
  });

  it('labels 무: labels[id] ?? id 폴백', () => {
    const rendered = renderAskOutcome({ ...labeled, labels: {} });
    assert.match(rendered.text, /경로: game:1 → dev-a → game:2/);
    assert.match(rendered.text, /\[1\.md\] Game One body\./);
  });

  it('answer가 있으면 출력 맨 위에 둔다', () => {
    const rendered = renderAskOutcome({
      ...labeled,
      answer: '몬헌과 같은 CAPCOM 게임으로 Resident Evil 4가 있습니다.',
    });
    assert.equal(rendered.abstained, false);
    assert.equal(rendered.text.split('\n')[0], '몬헌과 같은 CAPCOM 게임으로 Resident Evil 4가 있습니다.');
    assert.match(rendered.text, /경로: Game One → Dev A → Game Two/);
  });

  it('answer가 없으면 현재 렌더 그대로 둔다', () => {
    const rendered = renderAskOutcome(labeled);
    assert.equal(rendered.text.split('\n')[0], 'mode=demo run=ret-test-answer');
  });

  it('dev: 표시제목 뒤에 (id) 병기', () => {
    const rendered = renderAskOutcome(labeled, { dev: true });
    assert.match(rendered.text, /경로: Game One \(game:1\) → Dev A \(dev-a\) → Game Two \(game:2\)/);
    assert.match(rendered.text, /\[Game One \(1\.md\)\] Game One body\./);
  });

  it('보류는 문구·시도·사유를 구분 표시', () => {
    const rendered = renderAskOutcome({
      steps: [],
      mode: 'demo',
      trace: ABSTAIN_TRACE as unknown as AskOutcome['trace'],
      labels: {},
    });
    assert.equal(rendered.abstained, true);
    assert.match(rendered.text, /답을 보류합니다/);
    assert.match(rendered.text, /entity_unresolved/);
    assert.match(rendered.text, /L0 no_paths/);
  });
});

describe('groupEvidenceSpans (화면과 같은 규칙)', () => {
  const spans = [
    { document: '1.md', sentence: 'tags: [Horror]', expression: 'Horror' },
    { document: '1.md', sentence: 'tags: [Horror]', expression: 'Survival Horror' },
    { document: '1.md', sentence: 'tags: [Horror]', expression: 'Horror' },
    { document: '1.md', sentence: '타이틀 문장', expression: 'Game One' },
    { document: '2.md', sentence: 'tags: [Horror]', expression: 'Horror' },
  ];

  it('(document, sentence)로 묶고 expression을 순서대로 모은다', () => {
    assert.deepEqual(groupEvidenceSpans(spans), [
      { document: '1.md', sentence: 'tags: [Horror]', expressions: ['Horror', 'Survival Horror'] },
      { document: '1.md', sentence: '타이틀 문장', expressions: ['Game One'] },
      { document: '2.md', sentence: 'tags: [Horror]', expressions: ['Horror'] },
    ]);
  });

  it('묶은 뒤 개수로 렌더하고 한 줄에 모아 찍는다', () => {
    const rendered = renderAskOutcome({
      steps: [],
      mode: 'demo',
      trace: {
        ...ANSWER_TRACE,
        evidenceSpans: spans,
      } as unknown as AskOutcome['trace'],
      labels: ANSWER_LABELS,
    } as AskOutcome);
    assert.match(rendered.text, /근거 3건:/);
    assert.match(rendered.text, /- \[Game One\] tags: \[Horror\] — Horror, Survival Horror/);
  });
});

describe('runAskCommand 종료 코드', () => {
  it('답변 0 · 보류 2', async () => {
    const answerServer = await startMockAskServer(() => ({
      status: 200,
      payload: sseBody([{ event: 'result', data: { mode: 'demo', trace: ANSWER_TRACE } }]),
    }));
    assert.equal(await runAskCommand({ question: 'q', mode: 'demo', baseUrl: answerServer.url, dev: false, help: false }), 0);
    await answerServer.close();

    const abstainServer = await startMockAskServer(() => ({
      status: 200,
      payload: sseBody([{ event: 'result', data: { mode: 'demo', trace: ABSTAIN_TRACE } }]),
    }));
    assert.equal(await runAskCommand({ question: 'q', mode: 'demo', baseUrl: abstainServer.url, dev: false, help: false }), 2);
    await abstainServer.close();
  });
});

// ─── serve 공개 export 상태 ───

describe('serve 공개 export 대기', { skip: HAS_SERVE_API ? 'serve export 존재함' : false }, () => {
  it('requireServeApi가 명확한 메시지로 throw', () => {
    assert.throws(() => requireServeApi(), /collie serve 공개 export가 아직 없습니다/);
  });
});

// ─── 프로세스 수준 (dist 필요) ───

describe('serve·ask CLI (프로세스 수준, dist 필요)', { skip: HAS_DIST ? false : DIST_SKIP_MESSAGE }, () => {
  it('serve --help·ask --help는 exit 0', () => {
    const serveHelp = runCli('collie', 'serve', '--help');
    assert.equal(serveHelp.status, 0);
    assert.match(serveHelp.stderr, /questail collie serve/);

    const askHelp = runCli('collie', 'ask', '--help');
    assert.equal(askHelp.status, 0);
    assert.match(askHelp.stderr, /questail collie ask/);
  });

  it('ask 질문 없음·모드 오타는 stderr + exit 1', () => {
    const missing = runCli('collie', 'ask');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /질문이 필요합니다/);

    const badMode = runCli('collie', 'ask', 'q', '--mode', 'weird');
    assert.equal(badMode.status, 1);
    assert.match(badMode.stderr, /알 수 없는 모드/);
  });

  it('ask 성공 시 exit 0, stdout에 표시제목 (ID 없음)', async () => {
    const server = await startMockAskServer(() => ({
      status: 200,
      payload: sseBody([
        { event: 'step', data: { node: 'classify', level: 0 } },
        { event: 'step', data: { node: 'retrieve', level: 0 } },
        { event: 'result', data: { mode: 'demo', trace: ANSWER_TRACE, labels: ANSWER_LABELS } },
      ]),
    }));
    try {
      const result = await runCliAsync('collie', 'ask', 'Game One', '--mode', 'demo', '--base-url', server.url);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /경로: Game One → Dev A → Game Two/);
      assert.match(result.stdout, /\[Game One\]/);
      assert.doesNotMatch(result.stdout, /game:1/);
      assert.match(result.stderr, /step retrieve level=0/);

      const dev = await runCliAsync('collie', 'ask', 'Game One', '--dev', '--base-url', server.url);
      assert.equal(dev.status, 0);
      assert.match(dev.stdout, /Game One \(game:1\)/);
    } finally {
      await server.close();
    }
  });

  it('ask 보류 시 exit 2, 연결 실패 시 exit 1로 구분', async () => {
    const server = await startMockAskServer(() => ({
      status: 200,
      payload: sseBody([{ event: 'result', data: { mode: 'demo', trace: ABSTAIN_TRACE } }]),
    }));
    try {
      const abstained = await runCliAsync('collie', 'ask', 'zzz', '--base-url', server.url);
      assert.equal(abstained.status, 2);
      assert.match(abstained.stdout, /답을 보류합니다/);
    } finally {
      await server.close();
    }

    const port = await closedPort();
    const refused = runCli('collie', 'ask', 'q', '--base-url', `http://127.0.0.1:${port}`);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /서버에 연결할 수 없습니다/);
  });

  it('USAGE 상수는 스캐폴드 범위를 벗어나지 않는다', () => {
    assert.match(SERVE_USAGE, /questail collie serve/);
    assert.match(ASK_USAGE, /questail collie ask/);
  });
});
