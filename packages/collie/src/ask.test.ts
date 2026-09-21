/** respond 생성 단위 테스트 (실제 LLM 호출 없음). 실행: `pnpm --filter @questail/collie exec tsx --test src/ask.test.ts` */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('states PUBLISHED_BY edges explicitly and forbids other relation types', () => {
    const prompt = buildRespondPrompt(
      'Lumen Reach 1과 같은 퍼블리셔의 게임을 추천해줘',
      ['Lumen Reach 1', 'Orbit Press 1', 'Other Game'],
      [
        { document: '1.md', sentence: 'Other Game의 publishers는 ["Orbit Press 1"]이다.', expression: 'Orbit Press 1' },
      ],
      [
        { type: 'PUBLISHED_BY', from: 'Lumen Reach 1', to: 'Orbit Press 1', verified: true },
        { type: 'PUBLISHED_BY', from: 'Other Game', to: 'Orbit Press 1', verified: true },
      ],
    );
    // 간선 종류 명시: PUBLISHED_BY가 published 관계로 풀어져 있다.
    assert.ok(prompt.includes('—PUBLISHED_BY→'));
    assert.ok(prompt.includes('published'));
    // 제약 문장: 주어진 간선 종류 외 관계 단정 금지 + 근거 밖 날조 금지.
    assert.ok(prompt.includes('Do not assert any relationship outside the Relations lines'));
    assert.ok(prompt.includes('Do not invent facts'));
    // Relations 줄에 developer 계열 간선 단정이 없음을 검증한다.
    // ("developed" 단어 자체는 legend/제약 설명에 나오므로 간선 표기 기준으로 판정)
    const relationLines = prompt.split('\n').filter((line) => line.startsWith('- ') && line.includes('→'));
    assert.ok(relationLines.length > 0);
    assert.ok(relationLines.every((line) => !line.includes('DEVELOPED_BY')));
    assert.ok(relationLines.every((line) => !line.includes('—DEVELOPED_BY→')));
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

  it('forwards selectedPath edge types to the respond prompt', async () => {
    const config = await testConfig();
    const ctx = createAskContextForTest(
      config,
      makeDeps({
        nodes: [
          { id: 'game-a', kind: 'game', label: 'Game A' },
          { id: 'pub-p', kind: 'publisher', label: 'Pub P' },
          { id: 'game-b', kind: 'game', label: 'Game B' },
        ],
        edges: [
          { type: 'PUBLISHED_BY', from: 'game-a', to: 'pub-p', verified: true },
          { type: 'PUBLISHED_BY', from: 'game-b', to: 'pub-p', verified: true },
        ],
        evidence: {
          'game-b': [{ document: 'games/Game B.md', sentence: 'Game B는 Pub P가 퍼블리싱했다.', expression: 'Pub P' }],
        },
      }),
    );
    const seen: string[] = [];
    const result = await runAsk(
      QUESTION,
      'demo',
      ctx,
      { baseUrl: 'http://x', model: 'm', apiKey: 'fake-key' },
      {
        complete: async (prompt: string) => {
          seen.push(prompt);
          return 'Game A와 Game B는 Pub P가 퍼블리싱했다.';
        },
      },
    );
    assert.equal(seen.length, 1);
    assert.ok(seen[0].includes('—PUBLISHED_BY→'));
    assert.ok(seen[0].includes('Do not assert any relationship outside the Relations lines'));
    const relationLines = seen[0].split('\n').filter((line) => line.startsWith('- ') && line.includes('→'));
    assert.ok(relationLines.length > 0);
    assert.ok(relationLines.every((line) => !line.includes('DEVELOPED_BY')));
    assert.equal(result.answer, 'Game A와 Game B는 Pub P가 퍼블리싱했다.');
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

  it('uses cwd .env before the user config when no request key exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'collie-ask-env-'));
    const home = join(root, 'home');
    mkdirSync(join(home, '.config', 'questail'), { recursive: true });
    writeFileSync(join(root, '.env'), 'QUESTAIL_LLM_API_KEY=local-key\nQUESTAIL_LLM_BASE_URL=http://local/v1\nQUESTAIL_LLM_MODEL=local-model\n');
    writeFileSync(join(home, '.config', 'questail', '.env'), 'QUESTAIL_LLM_API_KEY=user-key\nQUESTAIL_LLM_MODEL=user-model\n');
    assert.deepEqual(resolveQueryCredentials(undefined, { cwd: root, home }), {
      apiKey: 'local-key', baseUrl: 'http://local/v1', model: 'local-model',
    });
  });

  it('falls back to the user config when cwd .env has no API key', () => {
    const root = mkdtempSync(join(tmpdir(), 'collie-ask-env-'));
    const home = join(root, 'home');
    mkdirSync(join(home, '.config', 'questail'), { recursive: true });
    writeFileSync(join(root, '.env'), 'QUESTAIL_LLM_MODEL=local-model\n');
    writeFileSync(join(home, '.config', 'questail', '.env'), 'QUESTAIL_LLM_API_KEY=user-key\nQUESTAIL_LLM_BASE_URL=http://user/v1\nQUESTAIL_LLM_MODEL=user-model\n');
    assert.deepEqual(resolveQueryCredentials(undefined, { cwd: root, home }), {
      apiKey: 'user-key', baseUrl: 'http://user/v1', model: 'user-model',
    });
  });
});
