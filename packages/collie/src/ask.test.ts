/** respond 생성 단위 테스트 (실제 LLM 호출 없음). 실행: `pnpm --filter @questail/collie exec tsx --test src/ask.test.ts` */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEvidenceFallback,
  buildRespondPrompt,
  resolveQueryCredentials,
  runAsk,
} from './ask.js';
import { EMPTY, L0_ANSWER, makeDeps, testConfig } from './retrieve/fixtures.js';
import type { Config, GraphDeps } from './types.js';

const QUESTION = 'Game A와 같은 개발사의 게임을 추천해줘';

function createAskContextForTest(config: Config, deps: GraphDeps) {
  return { config, deps, corpusFingerprint: 'test-corpus' };
}

describe('buildRespondPrompt', () => {
  it('carries only path labels and evidence spans', () => {
    const prompt = buildRespondPrompt(QUESTION, ['Game A', 'Dev D', 'Game B'], [
      { document: '1.md', sentence: 'Game B는 Dev D가 개발했다.', expression: 'Dev D' },
    ]);
    assert.ok(prompt.includes('Game A → Dev D → Game B'));
    assert.ok(prompt.includes('Game B는 Dev D가 개발했다.'));
    assert.ok(prompt.includes('at most two sentences'));
    assert.ok(prompt.includes(QUESTION));
  });
});

describe('runAsk answer', () => {
  it('generates via injected complete on success', async () => {
    const config = await testConfig();
    const ctx = createAskContextForTest(config, makeDeps(L0_ANSWER));
    const seen: string[] = [];
    const result = await runAsk(
      QUESTION,
      'demo',
      ctx,
      { baseUrl: 'http://x', model: 'm', apiKey: 'fake-key' },
      {
        complete: async (prompt: string) => {
          seen.push(prompt);
          return '  Game A와 Game B는 Dev D가 만들었다.  ';
        },
      },
    );
    assert.equal(seen.length, 1);
    assert.equal(result.answer, 'Game A와 Game B는 Dev D가 만들었다.');
    assert.equal(result.trace.abstained, false);
  });

  it('omits answer on abstain without calling complete', async () => {
    const config = await testConfig();
    const ctx = createAskContextForTest(config, makeDeps(EMPTY));
    let called = 0;
    const result = await runAsk(
      '없는게임 zzz',
      'demo',
      ctx,
      { baseUrl: 'http://x', model: 'm', apiKey: 'fake-key' },
      {
        complete: async () => {
          called += 1;
          return 'never';
        },
      },
    );
    assert.equal(result.trace.abstained, true);
    assert.equal(result.answer, undefined);
    assert.equal(called, 0);
  });

  it('omits answer on forced skip but falls back on failure', async () => {
    const config = await testConfig();
    const skipped = await runAsk(
      QUESTION,
      'demo',
      createAskContextForTest(config, makeDeps(L0_ANSWER)),
      { baseUrl: 'http://x', model: 'm', apiKey: 'fake-key' },
      { complete: null },
    );
    assert.equal(skipped.answer, undefined);
    const failed = await runAsk(
      QUESTION,
      'demo',
      createAskContextForTest(config, makeDeps(L0_ANSWER)),
      { baseUrl: 'http://x', model: 'm', apiKey: 'fake-key' },
      {
        complete: async () => {
          throw new Error('LLM down');
        },
      },
    );
    assert.equal(failed.answer, 'Game B는 Dev D가 개발했다.');
    assert.equal(buildEvidenceFallback([]), undefined);
  });

  it('passes request credentials through untouched', () => {
    const creds = { baseUrl: 'http://x', model: 'm', apiKey: 'fake-key' };
    assert.equal(resolveQueryCredentials(creds), creds);
  });
});
