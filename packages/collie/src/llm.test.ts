/** llm HTTP 에러 처리 단위 테스트 (실제 provider 호출 없음, fetch 스텁). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CollieLlmError,
  HTTP_ERROR_BODY_SNIPPET_LENGTH,
  completeChat,
} from './llm.js';

const CREDS = { baseUrl: 'http://provider/v1', model: 'gpt-4o', apiKey: 'secret-key-123' };

/** fetch를 고정 응답으로 바꿔 실행하고 복원한다. */
async function withFetch(response: Response, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function catchLlmError(run: () => Promise<unknown>): Promise<CollieLlmError> {
  try {
    await run();
  } catch (error: unknown) {
    assert.ok(error instanceof CollieLlmError);
    return error;
  }
  assert.fail('completeChat이 실패해야 한다');
}

describe('completeChat HTTP errors', () => {
  it('includes the provider error body in the message', async () => {
    await withFetch(
      new Response(`{"error": "model 'gpt-4o' not found"}`, {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
      async () => {
        const error = await catchLlmError(() => completeChat(CREDS, [{ role: 'user', content: 'hi' }]));
        assert.equal(error.code, 'LLM_HTTP_ERROR');
        assert.ok(error.message.includes('404'));
        assert.ok(error.message.includes(`model 'gpt-4o' not found`));
      },
    );
  });

  it('masks an API key leaked in the error body', async () => {
    await withFetch(
      new Response(`{"error": "key secret-key-123 is invalid for model gpt-4o"}`, {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
      async () => {
        const error = await catchLlmError(() => completeChat(CREDS, [{ role: 'user', content: 'hi' }]));
        assert.equal(error.code, 'LLM_HTTP_ERROR');
        assert.ok(!error.message.includes('secret-key-123'));
        assert.ok(error.message.includes('[redacted]'));
      },
    );
  });

  it('truncates long error bodies to the snippet limit', async () => {
    const body = `x`.repeat(HTTP_ERROR_BODY_SNIPPET_LENGTH + 300);
    await withFetch(
      new Response(body, { status: 500, headers: { 'content-type': 'text/plain' } }),
      async () => {
        const error = await catchLlmError(() => completeChat(CREDS, [{ role: 'user', content: 'hi' }]));
        assert.equal(error.code, 'LLM_HTTP_ERROR');
        assert.ok(error.message.includes('x'.repeat(HTTP_ERROR_BODY_SNIPPET_LENGTH)));
        assert.ok(!error.message.includes(body));
      },
    );
  });

  it('omits the snippet when the error body is empty', async () => {
    await withFetch(
      new Response('', { status: 500, headers: { 'content-type': 'text/plain' } }),
      async () => {
        const error = await catchLlmError(() => completeChat(CREDS, [{ role: 'user', content: 'hi' }]));
        assert.equal(error.code, 'LLM_HTTP_ERROR');
        assert.equal(error.message, 'LLM HTTP 오류: 500');
      },
    );
  });
});
