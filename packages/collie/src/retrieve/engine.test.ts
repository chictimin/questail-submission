/** P3-F DoD 5종. 실행: `pnpm --filter @questail/collie exec tsx --test src/retrieve/engine.test.ts` */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configHash, type Config } from '../types.js';
import { retrieve, type RetrieveInput, type RetrieveMode } from './engine.js';
import { DENY_BRIDGE, EMPTY, L0_ANSWER, L2_SUCCESS_WITH_L0_TAG, MIXED_GATE, NORMAL_WITH_TAG, RARE_TAG, TAG_NO_EVIDENCE, TAG_ONLY, TAG_RARITY, makeDeps, testConfig, withRelationAllow } from './fixtures.js';

function inputOf(
  config: Config,
  question: string,
  spec: Parameters<typeof makeDeps>[0],
  mode: RetrieveMode = 'demo',
): RetrieveInput {
  return {
    question,
    mode,
    config,
    deps: makeDeps(spec),
    corpusFingerprint: 'test-corpus',
    promptFingerprint: 'sha256:test-prompt',
    modelId: 'test-model',
    startedAt: '2026-09-21T00:00:00.000Z',
  };
}

describe('P3-F L0 answer', () => {
  it('succeeds at L0 with a single attempt', async () => {
    const config = await testConfig();
    const { trace, mode } = await retrieve(
      inputOf(config, 'Game A와 같은 개발사의 게임을 추천해줘', L0_ANSWER),
    );
    assert.equal(mode, 'demo');
    assert.equal(trace.abstained, false);
    assert.equal(trace.retrievalLevel, 0);
    assert.equal(trace.relaxationReason, undefined);
    assert.equal(trace.attempts.length, 1);
    assert.deepEqual(trace.attempts[0]?.level, 0);
    assert.deepEqual(trace.attempts[0]?.outcome, 'paths_found');
    assert.deepEqual(trace.attempts[0]?.stopReason, 'paths_found');
    assert.deepEqual(trace.selectedPath?.nodes, ['game-a', 'dev-d', 'game-b']);
    assert.ok(trace.evidenceSpans.length >= 1);
    assert.equal(trace.configHash, configHash(config));
    assert.ok(Object.isFrozen(trace.configSnapshot));
    assert.equal(trace.corpusFingerprint, 'test-corpus');
  });

  it('derives a deterministic runId and honors overrides', async () => {
    const config = await testConfig();
    const base = inputOf(config, 'Game A와 같은 개발사의 게임을 추천해줘', L0_ANSWER, 'real');
    const first = await retrieve(base);
    const second = await retrieve({ ...base, startedAt: '2026-09-22T00:00:00.000Z' });
    assert.equal(first.mode, 'real');
    assert.equal(first.trace.runId, second.trace.runId);
    const pinned = await retrieve({ ...base, runId: 'ret-pinned' });
    assert.equal(pinned.trace.runId, 'ret-pinned');
  });
});

describe('P3-F escalation success', () => {
  it('fails L0/L1 and succeeds at L2 rare-tag-and-verified', async () => {
    const config = await testConfig();
    const { trace } = await retrieve(
      inputOf(config, 'Game A와 이어지는 RareTag 게임을 추천해줘', RARE_TAG),
    );
    assert.equal(trace.abstained, false);
    assert.equal(trace.retrievalLevel, 2);
    assert.deepEqual(
      trace.attempts.map((a) => a.level),
      [0, 1, 2],
    );
    assert.ok(trace.attempts.slice(0, 2).every((a) => a.blockedHubs.includes('tag-rare')));
    assert.match(trace.relaxationReason ?? '', /L0.*L1.*L2 paths_found/);
    assert.ok((trace.selectedPath?.edges.length ?? 0) >= 1);
    assert.ok(trace.evidenceSpans.length >= 1);
  });
});

describe('P3-F relation disabled/enabled', () => {
  it('abstains when L2+ relation is disabled, succeeds when enabled', async () => {
    const config = await testConfig();
    const question = 'Game A와 이어지는 RareTag 게임을 추천해줘';
    const disabled = await retrieve(
      inputOf(withRelationAllow(config, false), question, RARE_TAG),
    );
    assert.equal(disabled.trace.abstained, true);
    assert.equal(disabled.trace.selectedPath, null);
    assert.deepEqual(
      disabled.trace.attempts.map((a) => a.level),
      [0, 1, 2, 3, 4],
    );
    assert.match(disabled.trace.relaxationReason ?? '', /relation-disabled/);
    assert.match(disabled.trace.relaxationReason ?? '', /abstain$/);

    const enabled = await retrieve(inputOf(config, question, RARE_TAG));
    assert.equal(enabled.trace.abstained, false);
    assert.equal(enabled.trace.retrievalLevel, 2);
  });
});

describe('P3-F L4 direct restriction', () => {
  it('blocks the denylist bridge at every level including L4', async () => {
    const config = await testConfig();
    const { trace } = await retrieve(
      inputOf(config, 'Game A와 Action 태그 게임을 연결해줘', DENY_BRIDGE),
    );
    assert.equal(trace.abstained, true);
    assert.equal(trace.selectedPath, null);
    assert.deepEqual(
      trace.attempts.map((a) => a.level),
      [0, 1, 2, 3, 4],
    );
    assert.deepEqual(trace.attempts[4]?.stopReason, 'level_exhausted');
    assert.ok(trace.attempts.every((a) => a.blockedHubs.includes('tag-action')));
    assert.match(trace.relaxationReason ?? '', /denylist/);
  });
});

describe('P3-F full abstain trace', () => {
  it('records L0~L4 entity_unresolved with structured fields', async () => {
    const config = await testConfig();
    const { trace, mode } = await retrieve(inputOf(config, '없는게임 xyz', EMPTY));
    assert.equal(mode, 'demo');
    assert.equal(trace.abstained, true);
    assert.equal(trace.selectedPath, null);
    assert.deepEqual(trace.evidenceSpans, []);
    assert.equal(trace.retrievalLevel, undefined);
    assert.equal(trace.attempts.length, 5);
    assert.deepEqual(
      trace.attempts.map((a) => [a.level, a.outcome, a.stopReason]),
      [
        [0, 'entity_unresolved', 'no_paths'],
        [1, 'entity_unresolved', 'no_paths'],
        [2, 'entity_unresolved', 'no_paths'],
        [3, 'entity_unresolved', 'no_paths'],
        [4, 'entity_unresolved', 'level_exhausted'],
      ],
    );
    assert.deepEqual(
      trace.attempts.map((a) => a.radius),
      config.graph.levels.map((level) => level.radius),
    );
    assert.match(trace.relaxationReason ?? '', /L0.*L4.*abstain/);
  });
});

describe('P3-F tag-fallback exclusivity', () => {
  it('does not fire when the normal path succeeds despite a tag candidate', async () => {
    const config = await testConfig();
    const { trace } = await retrieve(
      inputOf(config, 'Game A와 같은 개발사의 게임을 추천해줘', NORMAL_WITH_TAG),
    );
    assert.equal(trace.abstained, false);
    assert.equal(trace.retrievalLevel, 0);
    assert.equal(trace.attempts.length, 1);
    assert.deepEqual(trace.selectedPath?.nodes, ['game-a', 'dev-d', 'game-b']);
    assert.equal(trace.relaxationReason, undefined);
    assert.ok(!(trace.relaxationReason ?? '').includes('tag-fallback'));
  });

  it('does not fire on L2 escalation success', async () => {
    const config = await testConfig();
    const { trace } = await retrieve(
      inputOf(config, 'Game A와 이어지는 RareTag 게임을 추천해줘', RARE_TAG),
    );
    assert.equal(trace.abstained, false);
    assert.equal(trace.retrievalLevel, 2);
    assert.ok(!(trace.relaxationReason ?? '').includes('tag-fallback'));
    assert.match(trace.relaxationReason ?? '', /L2 paths_found/);
  });

  it('does not overwrite an L2 success with an L0 tag candidate', async () => {
    const config = await testConfig();
    const { trace } = await retrieve(
      inputOf(config, 'Game A와 이어지는 RareTag 게임을 추천해줘', L2_SUCCESS_WITH_L0_TAG),
    );
    assert.equal(trace.abstained, false);
    assert.equal(trace.retrievalLevel, 2);
    assert.deepEqual(trace.selectedPath?.nodes, ['game-a', 'game-b']);
    assert.ok(!(trace.relaxationReason ?? '').includes('tag-fallback'));
  });
});

describe('P3-F tag fallback', () => {
  it('answers tag-only L0 candidates that used to abstain', async () => {
    const config = await testConfig();
    const { trace } = await retrieve(
      inputOf(config, 'Game A와 비슷한 게임을 추천해줘', TAG_ONLY),
    );
    assert.equal(trace.abstained, false);
    assert.equal(trace.retrievalLevel, 0);
    assert.deepEqual(trace.selectedPath?.nodes, ['game-a', 'tag-cozy', 'game-b']);
    assert.ok(trace.evidenceSpans.length >= 1);
  });

  it('prefers the rarer bridge tag', async () => {
    const config = await testConfig();
    const { trace } = await retrieve(
      inputOf(config, 'Game A와 비슷한 게임을 추천해줘', TAG_RARITY),
    );
    assert.equal(trace.abstained, false);
    assert.deepEqual(trace.selectedPath?.nodes, ['game-a', 'tag-narrow', 'game-b']);
  });

  it('leaves a tag-fallback marker in the trace', async () => {
    const config = await testConfig();
    const { trace } = await retrieve(
      inputOf(config, 'Game A와 비슷한 게임을 추천해줘', TAG_ONLY),
    );
    assert.equal(trace.abstained, false);
    assert.match(trace.relaxationReason ?? '', /tag-fallback/);
    assert.equal(trace.attempts.length, 1);
    assert.equal(trace.attempts[0]?.outcome, 'paths_found');
    assert.ok((trace.selectedPath?.edges.length ?? 0) > 0);
    assert.ok(trace.selectedPath?.edges.every((edge) => edge.type === 'HAS_TAG'));
  });

  it('still abstains when evidence is short even via fallback', async () => {
    const config = await testConfig();
    const { trace } = await retrieve(
      inputOf(config, 'Game A와 비슷한 게임을 추천해줘', TAG_NO_EVIDENCE),
    );
    assert.equal(trace.abstained, true);
    assert.equal(trace.selectedPath, null);
    assert.match(trace.relaxationReason ?? '', /abstain$/);
    assert.ok(!(trace.relaxationReason ?? '').includes('tag-fallback'));
  });

  it('does not fire when a non-tag candidate exists', async () => {
    const config = await testConfig();
    const { trace } = await retrieve(
      inputOf(config, 'Game A와 비슷한 게임을 추천해줘', MIXED_GATE),
    );
    assert.equal(trace.abstained, true);
    assert.equal(trace.selectedPath, null);
    assert.ok(!(trace.relaxationReason ?? '').includes('tag-fallback'));
  });
});
