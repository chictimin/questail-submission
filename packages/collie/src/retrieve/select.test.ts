/** selectTagFallback 단위 테스트. 실행: `pnpm --filter @questail/collie exec tsx --test src/retrieve/select.test.ts` */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EvidenceSpan, GraphEdge, GraphNode, GraphPath } from '../types.js';
import { makeDeps } from './fixtures.js';
import { TAG_FALLBACK_REASON, selectTagFallback, type SelectOptions } from './select.js';

function span(document: string, sentence: string, expression: string): EvidenceSpan {
  return { document, sentence, expression };
}

function edge(type: string, from: string, to: string): GraphEdge {
  return { type, from, to, verified: true };
}

function path(nodes: readonly string[], edges: readonly GraphEdge[]): GraphPath {
  return { nodes: [...nodes], edges: [...edges] };
}

const NODES: { readonly id: string; readonly kind: 'game' | 'tag' | 'developer'; readonly label: string }[] = [
  { id: 'game-a', kind: 'game', label: 'Game A' },
  { id: 'game-b', kind: 'game', label: 'Game B' },
  { id: 'game-c', kind: 'game', label: 'Game C' },
  { id: 'tag-narrow', kind: 'tag', label: 'NarrowTag' },
  { id: 'tag-wide', kind: 'tag', label: 'WideTag' },
  { id: 'dev-d', kind: 'developer', label: 'Dev D' },
];

const nodeById = new Map(NODES.map((node) => [node.id, node] as const));

const narrowPath = path(
  ['game-a', 'tag-narrow', 'game-b'],
  [edge('HAS_TAG', 'game-a', 'tag-narrow'), edge('HAS_TAG', 'game-b', 'tag-narrow')],
);
const widePath = path(
  ['game-a', 'tag-wide', 'game-c'],
  [edge('HAS_TAG', 'game-a', 'tag-wide'), edge('HAS_TAG', 'game-c', 'tag-wide')],
);
const devPath = path(
  ['game-a', 'dev-d', 'game-b'],
  [edge('DEVELOPED_BY', 'game-a', 'dev-d'), edge('DEVELOPED_BY', 'game-b', 'dev-d')],
);

function setup(answerEvidenceMin: number): { opts: SelectOptions; deps: ReturnType<typeof makeDeps> } {
  const deps = makeDeps({
    nodes: NODES.map((node) => ({ id: node.id, kind: node.kind, label: node.label })),
    edges: [],
    df: { 'tag:NarrowTag': 4, 'tag:WideTag': 12 },
    evidence: {
      'game-b': [
        span('games/Game B.md', 'Game B는 NarrowTag 게임이다.', 'NarrowTag'),
        span('games/Game B.md', 'Game B는 Dev D가 개발했다.', 'Dev D'),
      ],
      'game-c': [span('games/Game C.md', 'Game C는 WideTag 게임이다.', 'WideTag')],
    },
  });
  return { opts: { answerEvidenceMin, maxPaths: 20, nodes: nodeById }, deps };
}

describe('selectTagFallback rarity', () => {
  it('sorts by bridge df sum ascending so the rarer tag wins regardless of input order', async () => {
    const { deps, opts } = setup(1);
    const selection = await selectTagFallback(deps, [widePath, narrowPath], opts);
    assert.deepEqual(selection.path?.nodes, ['game-a', 'tag-narrow', 'game-b']);
    assert.equal(selection.reason, TAG_FALLBACK_REASON);
    assert.equal(selection.eligibleCount, 2);
    assert.ok(selection.evidence.length >= 1);
  });

  it('ignores non-tag candidates even when they carry more evidence', async () => {
    const { deps, opts } = setup(1);
    // devPath는 game-b 근거 2건으로 개별 최다지만 non-tag라 제외돼야 한다.
    const selection = await selectTagFallback(deps, [devPath, widePath], opts);
    assert.deepEqual(selection.path?.nodes, ['game-a', 'tag-wide', 'game-c']);
    assert.equal(selection.eligibleCount, 1);
    assert.equal(selection.reason, TAG_FALLBACK_REASON);
  });
});

describe('selectTagFallback evidence gate', () => {
  it('holds the same evidence minimum and abstains on shortfall', async () => {
    const { deps, opts } = setup(2);
    const selection = await selectTagFallback(deps, [widePath], opts);
    assert.equal(selection.path, null);
    assert.equal(selection.eligibleCount, 1);
    assert.match(selection.reason, /^evidence-shortfall/);
    assert.equal(selection.evidence.length, 1);
  });

  it('reports no-tag-candidates when every candidate has a non-tag edge', async () => {
    const { deps, opts } = setup(1);
    const selection = await selectTagFallback(deps, [devPath], opts);
    assert.equal(selection.path, null);
    assert.equal(selection.eligibleCount, 0);
    assert.equal(selection.reason, 'no-tag-candidates');
    assert.deepEqual(selection.evidence, []);
  });
});

describe('selectTagFallback marker contract', () => {
  it('keeps the literal reason the screen splits on', async () => {
    assert.equal(TAG_FALLBACK_REASON, 'ok(tag-fallback)');
  });
});
