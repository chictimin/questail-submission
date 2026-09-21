/** P1-B config 계약 전용 테스트. 실행: `pnpm --filter @questail/collie exec tsx --test src/config.test.ts` */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANONICAL_DENYLIST,
  CANONICAL_EDGE_TYPES,
  CANONICAL_NODE_TYPES,
  ConfigError,
  RARE_TAG_AND_VERIFIED_TRANSITION,
  configHash,
  loadConfigFile,
  parseConfig,
  safeParseConfig,
  snapshotConfig,
  validateConfig,
  type Config,
} from './types.js';

const here = dirname(fileURLToPath(import.meta.url));
const defaultPath = resolve(here, '..', 'config', 'default.json');

async function loadDefault(): Promise<Config> {
  return loadConfigFile(defaultPath);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function graphOf(config: Config): Record<string, unknown> {
  return clone(config) as unknown as Record<string, unknown>;
}

function levelsOf(config: Record<string, unknown>): Record<string, unknown>[] {
  return (config['graph'] as Record<string, unknown>)['levels'] as Record<string, unknown>[];
}

describe('default.json plan values', () => {
  it('loads and validates clean', async () => {
    const config = await loadDefault();
    assert.deepEqual(validateConfig(config), []);
    assert.equal(config.version, 1);
    assert.deepEqual(
      config.graph.levels.map((level) => level.level),
      [0, 1, 2, 3, 4],
    );
  });

  it('canonical node/edge sets', async () => {
    const config = await loadDefault();
    assert.deepEqual([...config.graph.canonicalNodeTypes].sort(), [...CANONICAL_NODE_TYPES].sort());
    assert.ok(!config.graph.canonicalNodeTypes.includes('genre'));
    assert.ok(config.graph.canonicalNodeTypes.includes('concept'));
    assert.deepEqual([...config.graph.canonicalEdgeTypes].sort(), [...CANONICAL_EDGE_TYPES].sort());
  });

  it('budgets and caps (20/20/1, maxRadius 3, stopTerms empty)', async () => {
    const config = await loadDefault();
    assert.equal(config.graph.maxPaths, 20);
    assert.equal(config.graph.maxCandidates, 20);
    assert.equal(config.graph.answerEvidenceMin, 1);
    assert.equal(config.graph.maxRadius, 3);
    assert.deepEqual(config.graph.stopTerms, []);
  });

  it('L0 planned numbers (n2, tag 3..15, dev/pub 2..10)', async () => {
    const config = await loadDefault();
    const l0 = config.graph.levels[0]!;
    assert.equal(l0.radius, 2);
    assert.deepEqual(l0.tagDf, { min: 3, max: 15 });
    assert.deepEqual(l0.developerDf, { min: 2, max: 10 });
    assert.deepEqual(l0.publisherDf, { min: 2, max: 10 });
    assert.equal(l0.allowVerifiedRelation, false);
  });

  it('L2 tag min 2 with verified allowed', async () => {
    const config = await loadDefault();
    const l2 = config.graph.levels[2]!;
    assert.equal(l2.tagDf.min, 2);
    assert.equal(l2.allowVerifiedRelation, true);
  });

  it('every level carries the full 4-entry denylist', async () => {
    const config = await loadDefault();
    for (const level of config.graph.levels) {
      assert.deepEqual([...level.denylist].sort(), [...CANONICAL_DENYLIST].sort());
    }
  });

  it('denylistMode: L0~L3 block-expansion, L4 explicit-direct-only with radius 3', async () => {
    const config = await loadDefault();
    for (const level of config.graph.levels.slice(0, 4)) {
      assert.equal(level.denylistMode, 'block-expansion');
    }
    const l4 = config.graph.levels[4]!;
    assert.equal(l4.denylistMode, 'explicit-direct-only');
    assert.equal(l4.radius, 3);
  });
});

describe('invalid configs are rejected', () => {
  it('level inheritance via extends key', async () => {
    const config = graphOf(await loadDefault());
    levelsOf(config)[1] = { extends: 'L0', level: 1 };
    const issues = validateConfig(config);
    assert.ok(issues.some((issue) => issue.message.includes('inheritance')), JSON.stringify(issues));
  });

  it('level inheritance by omission (missing tagDf)', async () => {
    const config = graphOf(await loadDefault());
    delete levelsOf(config)[2]!['tagDf'];
    const issues = validateConfig(config);
    assert.ok(issues.some((issue) => issue.path.includes('tagDf')), JSON.stringify(issues));
  });

  it('range inverted (min > max)', async () => {
    const config = await loadDefault();
    (config.graph.levels[0] as unknown as Record<string, unknown>)['tagDf'] = { min: 20, max: 15 };
    const issues = validateConfig(config);
    assert.ok(issues.some((issue) => issue.message.includes('inverted')), JSON.stringify(issues));
  });

  it('radius exceeds maxRadius', async () => {
    const config = await loadDefault();
    (config.graph.levels[3] as unknown as Record<string, unknown>)['radius'] = 9;
    const issues = validateConfig(config);
    assert.ok(issues.some((issue) => issue.message.includes('maxRadius')), JSON.stringify(issues));
  });

  it('simultaneous relaxation in one step (radius + df at L0→L1)', async () => {
    const config = await loadDefault();
    const l1 = config.graph.levels[1] as unknown as Record<string, unknown>;
    l1['radius'] = 3;
    l1['tagDf'] = { min: 1, max: 30 };
    // L0(radius 2, tag 3..15) -> L1(radius 3, tag 1..30): L0→L1은 radius만 허용
    const issues = validateConfig(config);
    assert.ok(issues.some((issue) => issue.message.includes('L0→L1')), JSON.stringify(issues));
  });

  it('invalid denylistMode value', async () => {
    const config = await loadDefault();
    (config.graph.levels[0] as unknown as Record<string, unknown>)['denylistMode'] = 'block-everything';
    const issues = validateConfig(config);
    assert.ok(issues.some((issue) => issue.path.includes('denylistMode')), JSON.stringify(issues));
  });

  it('L4 must be explicit-direct-only', async () => {
    const config = await loadDefault();
    (config.graph.levels[4] as unknown as Record<string, unknown>)['denylistMode'] = 'block-expansion';
    const issues = validateConfig(config);
    assert.ok(issues.some((issue) => issue.message.includes('explicit-direct-only')), JSON.stringify(issues));
  });

  it('node set deviation (genre instead of concept)', async () => {
    const config = graphOf(await loadDefault());
    (config['graph'] as Record<string, unknown>)['canonicalNodeTypes'] = [
      'game',
      'tag',
      'developer',
      'publisher',
      'series',
      'genre',
    ];
    const issues = validateConfig(config);
    assert.ok(issues.some((issue) => issue.path.includes('canonicalNodeTypes')), JSON.stringify(issues));
  });

  it('denylist missing one of the 4', async () => {
    const config = await loadDefault();
    (config.graph.levels[2] as unknown as Record<string, unknown>)['denylist'] = [
      'Singleplayer',
      'Multiplayer',
      'Action',
    ];
    const issues = validateConfig(config);
    assert.ok(issues.some((issue) => issue.path.includes('denylist')), JSON.stringify(issues));
  });

  it('parseConfig throws ConfigError carrying issues', async () => {    const config = await loadDefault();
    (config.graph.levels[0] as unknown as Record<string, unknown>)['tagDf'] = { min: 9, max: 1 };
    assert.throws(() => parseConfig(config), ConfigError);
    const result = safeParseConfig(config);
    assert.equal(result.success, false);
    assert.ok(result.success === false && result.issues.length > 0);
  });
});

describe('transition grammar', () => {
  it('L1→L2 named compound passes, flip without tagDf.min is rejected', async () => {
    const clean = await loadDefault();
    assert.deepEqual(validateConfig(clean), []);
    const config = await loadDefault();
    (config.graph.levels[2] as unknown as Record<string, unknown>)['tagDf'] = { min: 3, max: 15 };
    const issues = validateConfig(config);
    assert.ok(
      issues.some((issue) => issue.message.includes(RARE_TAG_AND_VERIFIED_TRANSITION)),
      JSON.stringify(issues),
    );
  });

  it('tagDf.min alone at L1→L2 is rejected (pair required)', async () => {
    const config = await loadDefault();
    (config.graph.levels[2] as unknown as Record<string, unknown>)['allowVerifiedRelation'] = false;
    const issues = validateConfig(config);
    assert.ok(
      issues.some((issue) => issue.message.includes(RARE_TAG_AND_VERIFIED_TRANSITION)),
      JSON.stringify(issues),
    );
  });

  it('allow flip outside L1→L2 is rejected (L0, L2→L3)', async () => {
    const atL0 = await loadDefault();
    (atL0.graph.levels[0] as unknown as Record<string, unknown>)['allowVerifiedRelation'] = true;
    assert.ok(
      validateConfig(atL0).some((issue) => issue.message.includes('L0→L1')),
      JSON.stringify(validateConfig(atL0)),
    );
    const atL3 = await loadDefault();
    (atL3.graph.levels[3] as unknown as Record<string, unknown>)['allowVerifiedRelation'] = false;
    assert.ok(
      validateConfig(atL3).some((issue) => issue.message.includes('L2→L3')),
      JSON.stringify(validateConfig(atL3)),
    );
  });

  it('L2→L3 allows only df caps: min relaxation is rejected', async () => {
    const config = await loadDefault();
    (config.graph.levels[3] as unknown as Record<string, unknown>)['tagDf'] = { min: 1, max: 25 };
    const issues = validateConfig(config);
    assert.ok(issues.some((issue) => issue.message.includes('L2→L3')), JSON.stringify(issues));
  });

  it('L3→L4 freezes radius/df/allow/denylist: any value change is rejected', async () => {
    const dfChanged = await loadDefault();
    (dfChanged.graph.levels[4] as unknown as Record<string, unknown>)['tagDf'] = { min: 2, max: 30 };
    assert.ok(
      validateConfig(dfChanged).some((issue) => issue.message.includes('L3→L4')),
      JSON.stringify(validateConfig(dfChanged)),
    );
    const radiusChanged = await loadDefault();
    (radiusChanged.graph.levels[4] as unknown as Record<string, unknown>)['radius'] = 2;
    assert.ok(
      validateConfig(radiusChanged).some((issue) => issue.message.includes('L3→L4')),
      JSON.stringify(validateConfig(radiusChanged)),
    );
  });

  it('denylistMode change outside L3→L4 is rejected', async () => {
    const config = await loadDefault();
    (config.graph.levels[2] as unknown as Record<string, unknown>)['denylistMode'] = 'explicit-direct-only';
    const issues = validateConfig(config);
    assert.ok(issues.length > 0, JSON.stringify(issues));
  });
});

describe('hash and snapshot helpers', () => {
  it('configHash is stable regardless of key order', async () => {
    const a = await loadDefault();
    const shuffled = graphOf(a);
    const graph = shuffled['graph'] as Record<string, unknown>;
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(graph).sort().reverse()) reordered[key] = graph[key];
    shuffled['graph'] = reordered;
    assert.equal(configHash(a), configHash(parseConfig(shuffled)));
  });

  it('configHash changes when policy changes', async () => {
    const a = await loadDefault();
    const b = clone(a);
    (b.graph.levels[4] as unknown as Record<string, unknown>)['denylistMode'] = 'block-expansion';
    assert.notEqual(configHash(a), configHash(b));
  });

  it('snapshotConfig is frozen and decoupled from the source', async () => {
    const config = await loadDefault();
    const snapshot = snapshotConfig(config);
    assert.ok(Object.isFrozen(snapshot));
    assert.deepEqual(snapshot, config.graph);
    (config.graph.levels[0] as unknown as Record<string, unknown>)['radius'] = 99;
    assert.equal(snapshot.levels[0]!.radius, 2);
  });
});
