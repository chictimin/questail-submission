/**
 * P3-F 테스트 전용 fixture (인메모리 fake GraphDeps + 합성 그래프).
 *
 * demo gold·eval·코퍼스에는 손대지 않는다. 모든 그래프는 작고 결정적이며
 * DoD 5종(L0 answer·escalation·relation off/on·L4 직접제한·full abstain)을
 * 가린다. Config는 default.json 읽기 + 부분 override만 쓴다.
 */
import {
  loadDefaultConfig,
  type Config,
  type EvidenceSpan,
  type GraphDeps,
  type GraphEdge,
  type GraphNode,
} from '../types.js';

export interface FakeNode {
  readonly id: string;
  readonly kind: 'game' | 'tag' | 'developer' | 'publisher';
  readonly label: string;
}

export interface FakeEdge {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly verified?: boolean;
}

export interface FakeSpec {
  readonly nodes: readonly FakeNode[];
  readonly edges: readonly FakeEdge[];
  /** 'tag:Label' → df. 없으면 5. */
  readonly df?: Readonly<Record<string, number>>;
  readonly evidence?: Readonly<Record<string, readonly EvidenceSpan[]>>;
  readonly verifiedKeys?: readonly string[];
}

export function makeDeps(spec: FakeSpec): GraphDeps {
  const nodes: GraphNode[] = spec.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label }));
  const edges: GraphEdge[] = spec.edges.map((e) => ({
    type: e.type,
    from: e.from,
    to: e.to,
    verified: e.verified ?? false,
  }));
  return {
    listNodes: async (kind?: string) => (kind ? nodes.filter((n) => n.kind === kind) : [...nodes]),
    neighbors: async (nodeId: string) => edges.filter((e) => e.from === nodeId || e.to === nodeId),
    documentFrequency: async (term: string, kind: 'tag' | 'developer' | 'publisher') =>
      spec.df?.[`${kind}:${term}`] ?? 5,
    evidenceSpans: async (nodeId: string) => [...(spec.evidence?.[nodeId] ?? [])],
    verifiedEdgeKeys: async () => new Set(spec.verifiedKeys ?? []),
  };
}

function span(document: string, sentence: string, expression: string): EvidenceSpan {
  return { document, sentence, expression };
}

/** L0 2홉 답변 그래프: Game A —DEVELOPED_BY→ Dev D ←DEVELOPED_BY— Game B. */
export const L0_ANSWER: FakeSpec = {
  nodes: [
    { id: 'game-a', kind: 'game', label: 'Game A' },
    { id: 'dev-d', kind: 'developer', label: 'Dev D' },
    { id: 'game-b', kind: 'game', label: 'Game B' },
  ],
  edges: [
    { type: 'DEVELOPED_BY', from: 'game-a', to: 'dev-d', verified: true },
    { type: 'DEVELOPED_BY', from: 'game-b', to: 'dev-d', verified: true },
  ],
  evidence: {
    'game-b': [span('games/Game B.md', 'Game B는 Dev D가 개발했다.', 'Dev D')],
  },
};

/**
 * L2 완화 그래프: RareTag(df 2)는 L0/L1 tagDf.min 3에 막히고,
 * SEQUEL_OF verified relation은 L2 allow에서 열린다.
 */
export const RARE_TAG: FakeSpec = {
  nodes: [
    { id: 'game-a', kind: 'game', label: 'Game A' },
    { id: 'tag-rare', kind: 'tag', label: 'RareTag' },
    { id: 'game-b', kind: 'game', label: 'Game B' },
  ],
  edges: [
    { type: 'HAS_TAG', from: 'game-a', to: 'tag-rare', verified: true },
    { type: 'HAS_TAG', from: 'game-b', to: 'tag-rare', verified: true },
    { type: 'SEQUEL_OF', from: 'game-a', to: 'game-b', verified: true },
  ],
  df: { 'tag:RareTag': 2 },
  evidence: {
    'game-a': [span('games/Game A.md', 'Game A는 RareTag를 쓴다.', 'RareTag')],
    'game-b': [span('games/Game B.md', 'Game B는 Game A의 속편이다.', '속편')],
  },
  verifiedKeys: ['SEQUEL_OF::game-a::game-b'],
};

/** denylist bridge 그래프: Game A —HAS_TAG→ Action ←HAS_TAG— Game B. */
export const DENY_BRIDGE: FakeSpec = {
  nodes: [
    { id: 'game-a', kind: 'game', label: 'Game A' },
    { id: 'tag-action', kind: 'tag', label: 'Action' },
    { id: 'game-b', kind: 'game', label: 'Game B' },
  ],
  edges: [
    { type: 'HAS_TAG', from: 'game-a', to: 'tag-action', verified: true },
    { type: 'HAS_TAG', from: 'game-b', to: 'tag-action', verified: true },
  ],
};

export const EMPTY: FakeSpec = { nodes: [], edges: [] };

/**
 * 태그 폴백 발동 그래프: Game A —HAS_TAG→ Cozy ←HAS_TAG— Game B.
 * non-tag 간선이 없어 정상 선정은 전 레벨 실패하고 폴백이 답한다.
 * Cozy(df 5)는 L0 tagDf 3~15 안에 있고 denylist에도 없다.
 */
export const TAG_ONLY: FakeSpec = {
  nodes: [
    { id: 'game-a', kind: 'game', label: 'Game A' },
    { id: 'tag-cozy', kind: 'tag', label: 'Cozy' },
    { id: 'game-b', kind: 'game', label: 'Game B' },
  ],
  edges: [
    { type: 'HAS_TAG', from: 'game-a', to: 'tag-cozy', verified: true },
    { type: 'HAS_TAG', from: 'game-b', to: 'tag-cozy', verified: true },
  ],
  df: { 'tag:Cozy': 5 },
  evidence: {
    'game-b': [span('games/Game B.md', 'Game B는 Cozy한 게임이다.', 'Cozy')],
  },
};

/**
 * 희소 태그 우선 그래프: NarrowTag(df 4)와 WideTag(df 12) 중
 * df 합이 작은 NarrowTag 경로를 골라야 한다. 둘 다 L0 범위에 있다.
 */
export const TAG_RARITY: FakeSpec = {
  nodes: [
    { id: 'game-a', kind: 'game', label: 'Game A' },
    { id: 'tag-narrow', kind: 'tag', label: 'NarrowTag' },
    { id: 'tag-wide', kind: 'tag', label: 'WideTag' },
    { id: 'game-b', kind: 'game', label: 'Game B' },
    { id: 'game-c', kind: 'game', label: 'Game C' },
  ],
  edges: [
    { type: 'HAS_TAG', from: 'game-a', to: 'tag-narrow', verified: true },
    { type: 'HAS_TAG', from: 'game-b', to: 'tag-narrow', verified: true },
    { type: 'HAS_TAG', from: 'game-a', to: 'tag-wide', verified: true },
    { type: 'HAS_TAG', from: 'game-c', to: 'tag-wide', verified: true },
  ],
  df: { 'tag:NarrowTag': 4, 'tag:WideTag': 12 },
  evidence: {
    'game-b': [span('games/Game B.md', 'Game B는 NarrowTag 게임이다.', 'NarrowTag')],
    'game-c': [span('games/Game C.md', 'Game C는 WideTag 게임이다.', 'WideTag')],
  },
};

/** 근거 부족 그래프: TAG_ONLY와 같은 모양이지만 근거가 없어 폴백도 답하지 않는다. */
export const TAG_NO_EVIDENCE: FakeSpec = {
  nodes: [
    { id: 'game-a', kind: 'game', label: 'Game A' },
    { id: 'tag-cozy', kind: 'tag', label: 'Cozy' },
    { id: 'game-b', kind: 'game', label: 'Game B' },
  ],
  edges: [
    { type: 'HAS_TAG', from: 'game-a', to: 'tag-cozy', verified: true },
    { type: 'HAS_TAG', from: 'game-b', to: 'tag-cozy', verified: true },
  ],
  df: { 'tag:Cozy': 5 },
};

/**
 * 혼합 게이트 그래프: non-tag 후보(DEVELOPED_BY)가 있어도 근거가
 * 모자라면 전부-태그-전용 조건이 깨져 폴백에 들어가지 않고 보류한다.
 */
export const MIXED_GATE: FakeSpec = {
  nodes: [
    { id: 'game-a', kind: 'game', label: 'Game A' },
    { id: 'dev-d', kind: 'developer', label: 'Dev D' },
    { id: 'game-b', kind: 'game', label: 'Game B' },
    { id: 'tag-cozy', kind: 'tag', label: 'Cozy' },
    { id: 'game-c', kind: 'game', label: 'Game C' },
  ],
  edges: [
    { type: 'DEVELOPED_BY', from: 'game-a', to: 'dev-d', verified: true },
    { type: 'DEVELOPED_BY', from: 'game-b', to: 'dev-d', verified: true },
    { type: 'HAS_TAG', from: 'game-a', to: 'tag-cozy', verified: true },
    { type: 'HAS_TAG', from: 'game-c', to: 'tag-cozy', verified: true },
  ],
  df: { 'tag:Cozy': 5 },
  evidence: {
    // 태그 경로(game-c)에는 근거가 있어 게이트가 없으면 폴백이 답해버린다.
    // 게이트가 있으면 non-tag 후보 존재로 폴백에 들어가지 않고 보류한다.
    'game-c': [span('games/Game C.md', 'Game C는 Cozy한 게임이다.', 'Cozy')],
  },
};

/**
 * L2 배타성 그래프: L0에 태그 전용 후보(Cozy)가 있어도 정상 선정이
 * L2에서 성공하므로 폴백이 L2 성공을 덮어써서는 안 된다.
 */
export const L2_SUCCESS_WITH_L0_TAG: FakeSpec = {
  nodes: [
    { id: 'game-a', kind: 'game', label: 'Game A' },
    { id: 'tag-rare', kind: 'tag', label: 'RareTag' },
    { id: 'game-b', kind: 'game', label: 'Game B' },
    { id: 'tag-cozy', kind: 'tag', label: 'Cozy' },
    { id: 'game-c', kind: 'game', label: 'Game C' },
  ],
  edges: [
    { type: 'HAS_TAG', from: 'game-a', to: 'tag-rare', verified: true },
    { type: 'HAS_TAG', from: 'game-b', to: 'tag-rare', verified: true },
    { type: 'SEQUEL_OF', from: 'game-a', to: 'game-b', verified: true },
    { type: 'HAS_TAG', from: 'game-a', to: 'tag-cozy', verified: true },
    { type: 'HAS_TAG', from: 'game-c', to: 'tag-cozy', verified: true },
  ],
  df: { 'tag:RareTag': 2, 'tag:Cozy': 5 },
  evidence: {
    'game-a': [span('games/Game A.md', 'Game A는 RareTag를 쓴다.', 'RareTag')],
    'game-b': [span('games/Game B.md', 'Game B는 Game A의 속편이다.', '속편')],
    'game-c': [span('games/Game C.md', 'Game C는 Cozy한 게임이다.', 'Cozy')],
  },
  verifiedKeys: ['SEQUEL_OF::game-a::game-b'],
};

/**
 * 배타성 그래프: 정상 경로(DEVELOPED_BY)와 태그 후보가 공존해도
 * 정상 선정이 성공하므로 폴백이 발동하지 않아야 한다.
 */
export const NORMAL_WITH_TAG: FakeSpec = {
  nodes: [
    { id: 'game-a', kind: 'game', label: 'Game A' },
    { id: 'dev-d', kind: 'developer', label: 'Dev D' },
    { id: 'game-b', kind: 'game', label: 'Game B' },
    { id: 'tag-cozy', kind: 'tag', label: 'Cozy' },
    { id: 'game-c', kind: 'game', label: 'Game C' },
  ],
  edges: [
    { type: 'DEVELOPED_BY', from: 'game-a', to: 'dev-d', verified: true },
    { type: 'DEVELOPED_BY', from: 'game-b', to: 'dev-d', verified: true },
    { type: 'HAS_TAG', from: 'game-a', to: 'tag-cozy', verified: true },
    { type: 'HAS_TAG', from: 'game-c', to: 'tag-cozy', verified: true },
  ],
  df: { 'tag:Cozy': 5 },
  evidence: {
    'game-b': [span('games/Game B.md', 'Game B는 Dev D가 개발했다.', 'Dev D')],
    'game-c': [span('games/Game C.md', 'Game C는 Cozy한 게임이다.', 'Cozy')],
  },
};

export async function testConfig(): Promise<Config> {
  return loadDefaultConfig();
}

/** L2~L4 relation 허용을 한 번에 뒤집는다(엔진 동작 대조용, 검증용 아님). */
export function withRelationAllow(config: Config, allow: boolean): Config {
  const clone = structuredClone(config) as unknown as {
    graph: { levels: { allowVerifiedRelation: boolean }[] };
  };
  for (const index of [2, 3, 4]) {
    const level = clone.graph.levels[index];
    if (level) level.allowVerifiedRelation = allow;
  }
  return clone as unknown as Config;
}
