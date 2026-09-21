/** 분류기 주입식 단위 테스트 (실제 LLM 호출 없음). 실행: `pnpm --filter @questail/collie exec tsx --test src/classify.test.ts` */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClassifyPrompt,
  classifyNode,
  classifyQuestion,
  initialShellState,
  parseClassifyResult,
  toCoreClassify,
  validateGameTitles,
} from './graph.js';

const TITLES = ["Baldur's Gate 3", 'Terraria', 'Stardew Valley'];

describe('buildClassifyPrompt', () => {
  it('injects the full library list and route instruction', () => {
    const prompt = buildClassifyPrompt('발더스 게이트 전투는?', TITLES);
    for (const title of TITLES) assert.ok(prompt.includes(title));
    assert.ok(prompt.includes('JSON only'));
    assert.ok(prompt.includes('graph|tools|refuse'));
  });
});

describe('parseClassifyResult routes', () => {
  it('parses graph without category', () => {
    assert.deepEqual(
      parseClassifyResult('{"route":"graph","confidence":0.9,"reason":"관계","gameTitles":["Terraria"]}'),
      { route: 'graph', confidence: 0.9, reason: '관계', gameTitles: ['Terraria'] },
    );
  });

  it('parses tools with a valid category', () => {
    assert.deepEqual(
      parseClassifyResult(
        '{"route":"tools","category":"HISTORY","confidence":0.8,"reason":"보유","gameTitles":[]}',
      ),
      { route: 'tools', confidence: 0.8, reason: '보유', gameTitles: [], category: 'HISTORY' },
    );
  });

  it('defaults tools category to OUT_OF_SCOPE when missing', () => {
    assert.deepEqual(
      parseClassifyResult('{"route":"tools","confidence":0.5,"reason":"x","gameTitles":[]}').category,
      'OUT_OF_SCOPE',
    );
  });

  it('parses refuse and falls back to refuse on garbage', () => {
    assert.equal(
      parseClassifyResult('{"route":"refuse","confidence":0.9,"reason":"공략","gameTitles":[]}').route,
      'refuse',
    );
    assert.deepEqual(parseClassifyResult('not json'), {
      route: 'refuse',
      gameTitles: [],
      confidence: 0,
      reason: 'unparseable-classifier-output',
    });
    assert.equal(parseClassifyResult('{"route":"nope"}').route, 'refuse');
  });
});

describe('toCoreClassify', () => {
  it('assembles core result only for tools', () => {
    assert.deepEqual(
      toCoreClassify({ route: 'tools', gameTitles: ['Terraria'], confidence: 0.8, reason: 'r', category: 'HISTORY' }),
      { category: 'HISTORY', confidence: 0.8, reason: 'r', gameTitles: ['Terraria'] },
    );
    assert.deepEqual(
      toCoreClassify({ route: 'graph', gameTitles: ['Terraria'], confidence: 0.9, reason: 'r' }).category,
      'OUT_OF_SCOPE',
    );
  });
});

describe('validateGameTitles', () => {
  it('keeps index hits and drops the rest without selection', () => {
    const index = new Set(TITLES);
    assert.deepEqual(validateGameTitles(["Baldur's Gate 3", '없는 게임', 'Terraria'], index), [
      "Baldur's Gate 3",
      'Terraria',
    ]);
    assert.deepEqual(validateGameTitles(['없는 게임'], index), []);
  });
});

describe('classifyQuestion', () => {
  it('delegates to the injected complete and parses', async () => {
    const seen: string[] = [];
    const result = await classifyQuestion(
      '별점 알려줘',
      TITLES,
      async (prompt: string) => {
        seen.push(prompt);
        return '{"route":"tools","category":"SUBJECTIVE","confidence":0.9,"reason":"별점","gameTitles":[]}';
      },
    );
    assert.equal(seen.length, 1);
    assert.ok(seen[0]?.includes('Stardew Valley'));
    assert.deepEqual(result, {
      route: 'tools',
      confidence: 0.9,
      reason: '별점',
      gameTitles: [],
      category: 'SUBJECTIVE',
    });
  });

  it('propagates complete failures to the caller', async () => {
    await assert.rejects(
      classifyQuestion(
        'q',
        TITLES,
        async () => {
          throw new Error('LLM down');
        },
      ),
      /LLM down/,
    );
  });
});

describe('classifyNode', () => {
  it('stays a stub without context and uses the classifier with context', async () => {
    const state = initialShellState('q');
    assert.deepEqual(await classifyNode(state), { route: 'graph_pending' });
  });
});
