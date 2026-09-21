/** resolve 정규화 단위 테스트. 실행: `pnpm --filter @questail/collie exec tsx --test src/retrieve/resolve.test.ts` */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Config, GraphNode } from '../types.js';
import { normalizeLabel, resolveStarts } from './resolve.js';

function cfg(aliasTerms: Record<string, readonly string[]>): Config {
  return {
    version: 1,
    graph: {
      canonicalNodeTypes: [],
      canonicalEdgeTypes: [],
      aliasTerms,
      stopTerms: [],
      maxPaths: 1,
      maxCandidates: 1,
      answerEvidenceMin: 1,
      maxRadius: 1,
      levels: [],
    },
  };
}

function node(id: string, label: string): GraphNode {
  return { id, kind: 'game', label };
}

describe('normalizeLabel', () => {
  it('strips specials on both sides and keeps Korean', () => {
    assert.equal(normalizeLabel("Baldur's Gate 3"), 'baldurs gate 3');
    assert.equal(normalizeLabel('Baldurs Gate 3'), 'baldurs gate 3');
    assert.equal(normalizeLabel("Alan Wake's American Nightmare"), 'alan wakes american nightmare');
    assert.equal(normalizeLabel('Divinity: Original Sin 2'), 'divinity original sin 2');
    assert.equal(normalizeLabel('Co-op Campaign'), 'coop campaign');
    assert.equal(normalizeLabel('Capcom Co., Ltd.'), 'capcom co ltd');
    assert.equal(normalizeLabel('Mirror’s Edge™'), 'mirrors edge');
    assert.equal(normalizeLabel('발더스 게이트 3'), '발더스 게이트 3');
    assert.equal(normalizeLabel('  발게  '), '발게');
  });
});

describe('resolveStarts', () => {
  const baldur = node('game:1086940', "Baldur's Gate 3");

  it('matches labels across apostrophes', () => {
    const resolved = resolveStarts('Baldurs Gate 3 추천해줘', cfg({}), [baldur]);
    assert.deepEqual(resolved.nodeIds, ['game:1086940']);
  });

  it('consumes aliasTerms data as-is (title_ko, 약칭)', () => {
    const config = cfg({ "Baldur's Gate 3": ['발더스 게이트 3', '발게'] });
    assert.deepEqual(resolveStarts('발게 해줘', config, [baldur]).nodeIds, ['game:1086940']);
    assert.deepEqual(resolveStarts('발더스 게이트 3 어때', config, [baldur]).nodeIds, ['game:1086940']);
  });

  it('keeps current behavior when aliasTerms is empty', () => {
    const resolved = resolveStarts('발더스 게이트 3 어때', cfg({}), [baldur]);
    assert.deepEqual(resolved.nodeIds, []);
  });

  it('preserves union without arbitrary selection', () => {
    const nodes = [baldur, node('game:105600', 'Terraria')];
    const resolved = resolveStarts('Baldurs Gate 3이랑 Terraria 비교해줘', cfg({}), nodes);
    assert.deepEqual(resolved.nodeIds, ['game:105600', 'game:1086940']);
  });
});
