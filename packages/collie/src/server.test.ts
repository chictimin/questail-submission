/**
 * P4-G ask 계약 테스트 (tmp 미니 graph.v1 기반, real 파일 읽기 없음).
 * 실행: `pnpm --filter @questail/collie exec tsx --test src/server.test.ts`
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createCollieApp } from './server.js';

const SECRET = 'sk-test-p4g-redact-me';

interface SseEvent {
  event: string;
  data: string;
}

function readSseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const chunk of text.split('\n\n')) {
    const lines = chunk.split('\n');
    const eventLine = lines.find((line) => line.startsWith('event:'));
    const dataLine = lines.find((line) => line.startsWith('data:'));
    if (eventLine && dataLine) {
      events.push({
        event: eventLine.slice('event:'.length).trim(),
        data: dataLine.slice('data:'.length).trim(),
      });
    }
  }
  return events;
}

function corpusDoc(appId: number, title: string): string {
  return [
    '---',
    `appid: ${appId}`,
    `title: "${title}"`,
    'developers: ["Dev A"]',
    'publishers: ["Dev A"]',
    'tags: ["RPG", "Strategy"]',
    'votes: {"RPG": 100, "Strategy": 50}',
    '---',
    '',
    `${title} body.`,
    '',
  ].join('\n');
}

function buildMiniGraph(): { graphPath: string; corpusDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'collie-p4g-'));
  const corpusDir = join(root, 'corpus');
  mkdirSync(corpusDir);
  const envelope = {
    version: 'graph.v1',
    createdAt: '2026-09-21T00:00:00.000Z',
    corpus: { manifestFingerprint: 'test-manifest-abc', documentCount: 2, extractionEligibleCount: 2 },
    policy: {},
    normalization: { aliases: [], exclusions: [] },
    nodes: [
      { id: 'game:1', kind: 'game', label: 'Game One' },
      { id: 'dev-a', kind: 'developer', label: 'Dev A' },
      { id: 'game:2', kind: 'game', label: 'Game Two' },
    ],
    deterministicEdges: [
      {
        id: 'DEVELOPED_BY:game:1:dev-a',
        type: 'DEVELOPED_BY',
        from: 'game:1',
        to: 'dev-a',
        provenance: { appId: 1, document: '1.md', df: 5 },
      },
      {
        id: 'DEVELOPED_BY:game:2:dev-a',
        type: 'DEVELOPED_BY',
        from: 'game:2',
        to: 'dev-a',
        provenance: { appId: 2, document: '2.md', df: 5 },
      },
    ],
    relationEdges: [],
    metrics: {},
  };
  const graphPath = join(root, 'graph.v1.json');
  writeFileSync(graphPath, JSON.stringify(envelope));
  writeFileSync(join(corpusDir, '1.md'), corpusDoc(1, 'Game One'));
  writeFileSync(join(corpusDir, '2.md'), corpusDoc(2, 'Game Two'));
  return { graphPath, corpusDir };
}

async function postAsk(
  app: ReturnType<typeof createCollieApp>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request('/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('P4-G POST /ask contract', () => {
  it('streams step* then result{mode, trace} for a real question', async () => {
    const { graphPath, corpusDir } = buildMiniGraph();
    const app = createCollieApp({ graphPath, corpusDir });
    const response = await postAsk(app, { question: 'Game One와 같은 개발사의 게임', mode: 'real' });
    assert.equal(response.status, 200);
    assert.ok((response.headers.get('content-type') ?? '').includes('text/event-stream'));
    const events = readSseEvents(await response.text());
    assert.deepEqual(
      events.map((entry) => entry.event),
      ['step', 'step', 'step', 'result'],
    );
    const steps = events.slice(0, 3).map((entry) => JSON.parse(entry.data) as Record<string, unknown>);
    assert.deepEqual(
      steps.map((step) => step['node']),
      ['classify', 'policy', 'retrieve'],
    );
    assert.deepEqual(
      steps.map((step) => step['level']),
      [0, 0, 0],
    );
    const result = JSON.parse(events[3]?.data ?? '{}') as Record<string, unknown>;
    assert.equal(result['mode'], 'real');
    assert.deepEqual(result['labels'], { 'game:1': 'Game One', 'dev-a': 'Dev A', 'game:2': 'Game Two' });
    const trace = result['trace'] as Record<string, unknown>;
    assert.equal(trace['abstained'], false);
    assert.equal(trace['retrievalLevel'], 0);
    const path = (trace['selectedPath'] as Record<string, unknown>)['nodes'] as string[];
    // 시작 타이틀은 LLM 분류에 따라 달라질 수 있어 순서 무관하게 단언한다.
    assert.equal(path.length, 3);
    assert.equal(path[1], 'dev-a');
    assert.deepEqual([...path].sort(), ['dev-a', 'game:1', 'game:2']);
    assert.ok(((trace['evidenceSpans'] as unknown[]) ?? []).length >= 1);
    assert.equal(trace['corpusFingerprint'], 'test-manifest-abc');
    assert.ok(typeof trace['configHash'] === 'string');
    // answer는 키 있을 때만 생성되므로 문자열이거나 부재다.
    assert.ok(result['answer'] === undefined || (typeof result['answer'] === 'string' && result['answer'] !== ''));
  });

  it('returns HTTP 200 with abstained trace when nothing resolves', async () => {
    const { graphPath, corpusDir } = buildMiniGraph();
    const app = createCollieApp({ graphPath, corpusDir });
    const response = await postAsk(app, { question: '없는게임 zzz', mode: 'demo' });
    assert.equal(response.status, 200);
    const events = readSseEvents(await response.text());
    assert.equal(events[events.length - 1]?.event, 'result');
    const result = JSON.parse(events[events.length - 1]?.data ?? '{}') as Record<string, unknown>;
    assert.equal(result['mode'], 'demo');
    const trace = result['trace'] as Record<string, unknown>;
    assert.equal(trace['abstained'], true);
    assert.equal(trace['selectedPath'], null);
    assert.equal((trace['attempts'] as unknown[]).length, 5);
    assert.ok(!('answer' in result));
  });

  it('rejects missing question or undeclared mode with 400', async () => {
    const { graphPath, corpusDir } = buildMiniGraph();
    const app = createCollieApp({ graphPath, corpusDir });
    assert.equal((await postAsk(app, {})).status, 400);
    assert.equal((await postAsk(app, { question: 'Game One' })).status, 400);
    assert.equal((await postAsk(app, { question: 'Game One', mode: 'weird' })).status, 400);
  });

  it('keeps credentials in request memory and redacts them', async () => {
    const { graphPath, corpusDir } = buildMiniGraph();
    const app = createCollieApp({ graphPath, corpusDir });
    const logged: string[] = [];
    const original = console.log;
    console.log = (line?: unknown) => {
      logged.push(String(line));
    };
    try {
      const response = await postAsk(
        app,
        { question: 'Game One', mode: 'real', credentials: { apiKey: SECRET, model: 'm' } },
        { authorization: `Bearer ${SECRET}` },
      );
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(!text.includes(SECRET));
      assert.ok(logged.length > 0);
      assert.ok(logged.every((line) => !line.includes(SECRET)));
      assert.ok(logged.some((line) => line.includes('"keyPresent":true')));
    } finally {
      console.log = original;
    }
  });

  it('serves /health, / and fixtures', async () => {
    const { graphPath, corpusDir } = buildMiniGraph();
    const app = createCollieApp({ graphPath, corpusDir });
    assert.deepEqual(await (await app.request('/health')).json(), {
      ok: true,
      service: 'collie',
      mode: 'retrieve-v1',
    });
    const index = await app.request('/');
    assert.equal(index.status, 200);
    assert.ok((index.headers.get('content-type') ?? '').includes('text/html'));
    assert.ok((await index.text()).includes('questail-collie'));
    const fixture = await app.request('/fixtures/config.json');
    assert.equal(fixture.status, 200);
    assert.ok((fixture.headers.get('content-type') ?? '').includes('application/json'));
    assert.equal((await app.request('/fixtures/../server.ts')).status, 404);
  });

  it('GET /stream/ask wraps the same contract via query', async () => {
    const { graphPath, corpusDir } = buildMiniGraph();
    const app = createCollieApp({ graphPath, corpusDir });
    const ok = await app.request('/stream/ask?question=Game%20One&mode=demo');
    const events = readSseEvents(await ok.text());
    assert.ok(events.length >= 3);
    assert.ok(events.slice(0, -1).every((entry) => entry.event === 'step'));
    assert.equal(events[events.length - 1]?.event, 'result');
    const missing = await app.request('/stream/ask');
    assert.deepEqual(
      readSseEvents(await missing.text()).map((entry) => entry.event),
      ['error'],
    );
  });
});

describe('P4-G corpusMode enforcement', () => {
  it("POST /ask는 corpusMode와 다른 mode를 409로 거부한다", async () => {
    const { graphPath, corpusDir } = buildMiniGraph();
    const app = createCollieApp({ graphPath, corpusDir, corpusMode: 'demo' });
    const mismatch = await postAsk(app, { question: 'Game One', mode: 'real' });
    assert.equal(mismatch.status, 409);
    const body = (await mismatch.json()) as Record<string, unknown>;
    assert.match(String(body['error']), /mode 불일치/);
    assert.match(String(body['error']), /demo/);
  });

  it('POST /ask는 corpusMode와 같은 mode를 그대로 서빙한다', async () => {
    const { graphPath, corpusDir } = buildMiniGraph();
    const app = createCollieApp({ graphPath, corpusDir, corpusMode: 'demo' });
    const response = await postAsk(app, { question: 'Game One와 같은 개발사의 게임', mode: 'demo' });
    assert.equal(response.status, 200);
    const events = readSseEvents(await response.text());
    assert.equal(events[events.length - 1]?.event, 'result');
  });

  it('demo corpus도 서버 측 LLM 응답을 result.answer로 보낸다', async () => {
    const { graphPath, corpusDir } = buildMiniGraph();
    const app = createCollieApp({ graphPath, corpusDir, corpusMode: 'demo' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { max_tokens: number };
      const content = payload.max_tokens === 512
        ? JSON.stringify({ route: 'graph', gameTitles: ['Game One'], confidence: 1, reason: 'test' })
        : 'Game One과 Game Two는 Dev A가 개발했습니다.';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    };
    try {
      const response = await postAsk(
        app,
        { question: 'Game One와 같은 개발사의 게임', mode: 'demo' },
        { authorization: 'Bearer server-side-test-key' },
      );
      const events = readSseEvents(await response.text());
      const result = JSON.parse(events[events.length - 1]?.data ?? '{}') as Record<string, unknown>;
      assert.equal(result['answer'], 'Game One과 Game Two는 Dev A가 개발했습니다.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('GET /stream/ask는 corpusMode와 다른 mode를 error 이벤트로 거부한다', async () => {
    const { graphPath, corpusDir } = buildMiniGraph();
    const app = createCollieApp({ graphPath, corpusDir, corpusMode: 'real' });
    const mismatch = await app.request('/stream/ask?question=Game%20One&mode=demo');
    const events = readSseEvents(await mismatch.text());
    assert.deepEqual(events.map((entry) => entry.event), ['error']);
    assert.match(events[0]?.data ?? '', /mode 불일치/);
    const ok = await app.request('/stream/ask?question=Game%20One&mode=real');
    const okEvents = readSseEvents(await ok.text());
    assert.equal(okEvents[okEvents.length - 1]?.event, 'result');
  });

  it('corpusMode 미지정 시 real·demo를 모두 받는다 (기존 동작 유지)', async () => {
    const { graphPath, corpusDir } = buildMiniGraph();
    const app = createCollieApp({ graphPath, corpusDir });
    assert.equal((await postAsk(app, { question: 'Game One', mode: 'real' })).status, 200);
    assert.equal((await postAsk(app, { question: 'Game One', mode: 'demo' })).status, 200);
  });
});

describe('P4-G GET /eval/questions', () => {
  it('serves the 12-item set with draft/pending statuses', async () => {
    const { graphPath, corpusDir } = buildMiniGraph();
    const app = createCollieApp({ graphPath, corpusDir });
    const response = await app.request('/eval/questions');
    assert.equal(response.status, 200);
    assert.ok((response.headers.get('content-type') ?? '').includes('application/json'));
    const items = (await response.json()) as Record<string, unknown>[];
    assert.equal(items.length, 12);
    assert.deepEqual(
      items.map((item) => item['id']),
      ['Q01', 'Q02', 'Q03', 'Q04', 'Q05', 'Q06', 'Q07', 'Q08', 'Q09', 'Q10', 'Q11', 'Q12'],
    );
    for (const item of items.slice(0, 11)) assert.equal(item['status'], 'draft');
    const q12 = items[11] as Record<string, unknown>;
    assert.equal(q12?.['status'], 'pending');
    assert.equal(q12?.['question'], '');
    for (const item of items.slice(0, 9)) {
      const expect = item['expect'] as Record<string, unknown>;
      assert.equal(expect?.['kind'], 'answer');
      assert.equal(typeof expect?.['level'], 'number');
    }
    assert.deepEqual((items[9] as Record<string, unknown>)['expect'], {
      kind: 'abstain',
      reason: 'no-start-entity',
    });
    assert.deepEqual((items[10] as Record<string, unknown>)['expect'], {
      kind: 'abstain',
      reason: 'no-paths',
    });
  });
});
