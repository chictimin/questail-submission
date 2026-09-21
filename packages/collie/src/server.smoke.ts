/**
 * server shell smoke: start/stop, /health, ask SSE contract, redaction.
 * 키는 응답·로그 어디에도 원문으로 나오지 않아야 한다.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  closeCollieServer,
  createCollieApp,
  parsePort,
  serveCollieApp,
} from './server.js';
import { completeWithLlm, redactSecrets, resolveLlmCredentials } from './llm.js';

const SECRET = 'sk-test-9f8e7d6c5b4a';

async function startEphemeral() {
  const server = serveCollieApp(createCollieApp(), { port: 0 });
  try {
    let port: number | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = server.address();
      if (current !== null && typeof current === 'object') {
        port = current.port;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(port !== undefined, '서버가 listen하지 않았습니다.');
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const response = await fetch(`${base}/health`);
        if (response.ok) return { server, base };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error('서버가 준비되지 않았습니다.');
  } catch (error) {
    await closeCollieServer(server).catch(() => undefined);
    throw error;
  }
}

interface SseEvent {
  event: string;
  data: string;
}

async function readSseEvents(response: Response): Promise<SseEvent[]> {
  const text = await response.text();
  const events: SseEvent[] = [];
  for (const chunk of text.split('\n\n')) {
    const eventLine = chunk.split('\n').find((line) => line.startsWith('event:'));
    const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
    if (eventLine && dataLine) {
      events.push({ event: eventLine.slice('event:'.length).trim(), data: dataLine.slice('data:'.length).trim() });
    }
  }
  return events;
}

describe('parsePort', () => {
  it('기본 4173, --port 플래그와 env를 덮는다', () => {
    assert.equal(parsePort([], {}), 4173);
    assert.equal(parsePort(['--port', '4801'], {}), 4801);
    assert.equal(parsePort([], { COLLIE_PORT: '4802' }), 4802);
    assert.equal(parsePort(['--port', '4803'], { COLLIE_PORT: '4802' }), 4803);
    assert.throws(() => parsePort(['--port', '0'], {}));
  });
});

describe('llm boundary', () => {
  it('redact는 중첩 키를 지우고 complete는 키 유무로 오류를 가른다', async () => {
    const redacted = redactSecrets({ credentials: { apiKey: SECRET, model: 'm' } });
    assert.deepEqual(redacted, { credentials: { apiKey: '[redacted]', model: 'm' } });
    await assert.rejects(() => completeWithLlm(resolveLlmCredentials({}), 'hi'), /LLM 키가 없어/);
    await assert.rejects(
      () => completeWithLlm(resolveLlmCredentials({ apiKey: SECRET }), 'hi'),
      /P3-E 전까지 비활성화/,
    );
  });
});

describe('collie server', () => {
  it('기동/종료와 /health', async () => {
    const { server, base } = await startEphemeral();
    try {
      const response = await fetch(`${base}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, service: 'collie', mode: 'retrieve-v1' });
    } finally {
      await closeCollieServer(server);
    }
  });

  it('POST /ask는 SSE step*→result 계약을 지키고 키를 echo하지 않는다', async () => {
    const { server, base } = await startEphemeral();
    try {
      const missingMode = await fetch(`${base}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '헤일로 인피닛은 어느 시리즈인가?' }),
      });
      assert.equal(missingMode.status, 400);
      const response = await fetch(`${base}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '헤일로 인피닛은 어느 시리즈인가?', mode: 'real' }),
      });
      assert.equal(response.status, 200);
      assert.ok((response.headers.get('content-type') ?? '').includes('text/event-stream'));
      const text = await response.text();
      const events = await readSseEvents(new Response(text));
      assert.ok(events.length >= 3);
      assert.ok(events.slice(0, -1).every((entry) => entry.event === 'step'));
      const last = events[events.length - 1];
      assert.equal(last?.event, 'result');
      const result = JSON.parse(last?.data ?? '{}') as Record<string, unknown>;
      assert.equal(result['mode'], 'real');
      const trace = result['trace'] as Record<string, unknown>;
      assert.equal(typeof trace['abstained'], 'boolean');
      assert.ok(Array.isArray(trace['attempts']));
      assert.ok(!text.includes(SECRET));
    } finally {
      await closeCollieServer(server);
    }
  });

  it('키 있는 ask도 같은 SSE 계약으로 답하고 키 원문을 숨긴다', async () => {
    const { server, base } = await startEphemeral();
    try {
      const response = await fetch(`${base}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ question: 'q', mode: 'demo', credentials: { apiKey: SECRET } }),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      const events = await readSseEvents(new Response(text));
      assert.equal(events[events.length - 1]?.event, 'result');
      assert.ok(!text.includes(SECRET));
    } finally {
      await closeCollieServer(server);
    }
  });

  it('SSE는 step 뒤 result, 질문 없으면 error 이벤트를 낸다', async () => {
    const { server, base } = await startEphemeral();
    try {
      const ok = await fetch(`${base}/stream/ask?question=${encodeURIComponent('Lumen Reach 1은 어느 시리즈인가?')}`, {
        headers: { accept: 'text/event-stream' },
      });
      assert.ok((ok.headers.get('content-type') ?? '').includes('text/event-stream'));
      const events = await readSseEvents(ok);
      assert.ok(events.length >= 3);
      assert.ok(events.slice(0, -1).every((entry) => entry.event === 'step'));
      const last = events[events.length - 1];
      assert.equal(last?.event, 'result');
      const result = JSON.parse(last?.data ?? '{}') as Record<string, unknown>;
      assert.equal(result['mode'], 'real');
      assert.ok(typeof (result['trace'] as Record<string, unknown>)['abstained'] === 'boolean');

      const missing = await fetch(`${base}/stream/ask`, { headers: { accept: 'text/event-stream' } });
      const errorEvents = await readSseEvents(missing);
      assert.deepEqual(errorEvents.map((entry) => entry.event), ['error']);
    } finally {
      await closeCollieServer(server);
    }
  });
});
