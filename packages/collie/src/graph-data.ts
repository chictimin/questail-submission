/**
 * P2-C graph data contracts (`graph.v1` envelope).
 *
 * 기준 mufa 실측과 빌더 구현은 별도 워커·별도 구현이며, 동등 지표 재현은
 * 독립 검증이다 (REPORT 근거용 기록).
 *
 * - 결정적 edge 3종(HAS_TAG / DEVELOPED_BY / PUBLISHED_BY)은 아래
 *   DETERMINISTIC_EDGE_TYPES로만 생성한다. config `graph.canonicalEdgeTypes`
 *   (IN_SERIES / SEQUEL_OF / SAME_UNIVERSE)는 LLM 추출 relation 전용이라
 *   relationEdges 쪽에만 둔다 (현재는 빈 배열로 공존 자리 확보).
 * - genres / platforms / categories는 edge가 아니라 속성이다. 만들지 않는다.
 */

export const GRAPH_VERSION = 'graph.v1' as const;

export const DETERMINISTIC_EDGE_TYPES = [
  'HAS_TAG',
  'DEVELOPED_BY',
  'PUBLISHED_BY',
] as const;

export type DeterministicEdgeType =
  (typeof DETERMINISTIC_EDGE_TYPES)[number];

export type NodeKind = 'game' | 'tag' | 'developer' | 'publisher';

export interface GameNodeMeta {
  readonly appid: number;
  readonly title: string;
  readonly filename: string;
  /** manifest extractionExcluded에 없으면 true (126 중 113). */
  readonly extractionEligible: boolean;
  readonly canonicalBodyCharacters: number;
}

export interface GraphNode {
  readonly id: string;
  readonly kind: NodeKind;
  /** entity는 normalized label, game은 원제목. */
  readonly label: string;
  readonly game?: GameNodeMeta;
}

export interface EdgeProvenance {
  readonly appId: number;
  readonly document: string;
  /** df = 코퍼스 전체 문서 빈도 (빌드 시점). */
  readonly df: number;
  /** HAS_TAG만: 게임별 votes 내림차순 rank (1-based). */
  readonly rank?: number;
  /** HAS_TAG만: 해당 태그 투표수. */
  readonly votes?: number;
}

export interface DeterministicEdge {
  readonly id: string;
  readonly type: DeterministicEdgeType;
  /** 항상 GAME node id. */
  readonly from: string;
  readonly to: string;
  readonly provenance: EdgeProvenance;
}

/** LLM 추출 relation 자리. P2-C는 생성하지 않고 빈 배열로 둔다. */
export interface RelationEdge {
  readonly id: string;
  /** config canonicalEdgeTypes 등 LLM relation 전용 타입이 온다. */
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly status: 'accepted' | 'pending';
}

export interface AliasChangeRecord {
  readonly label: string;
  readonly canonical: string;
  readonly appids: readonly number[];
}

export interface ExclusionRecord {
  readonly label: string;
  readonly appids: readonly number[];
}

export interface GraphPolicySnapshot {
  readonly tagTopK: number;
  readonly tagDfMin: number;
  readonly tagDfMax: number;
  readonly devDfMin: number;
  readonly devDfMax: number;
  readonly pubDfMin: number;
  readonly pubDfMax: number;
  readonly denylist: readonly string[];
  readonly aliases: Readonly<Record<string, string>>;
  readonly excludedTerms: readonly string[];
  /** 상위 10% 게임을 허브로 보고 gold 경로 중간·종점에서 제외. */
  readonly hubTopFraction: number;
  /**
   * gold 강제 규칙 정본: 'non-tag' = DEVELOPED_BY·PUBLISHED_BY·향후 relation
   * 중 최소 1개. 'develops'는 참고 보조 통계용으로만 둔다.
   */
  readonly goldRequirement: string;
}

export interface GoldMetrics {
  readonly requirement: string;
  readonly startGames: number;
  readonly startAppids: readonly number[];
  readonly pathsLength2: number;
  readonly pathsLength2ByKinds: Readonly<Record<string, number>>;
  readonly pathsLength3: number;
}

export interface GraphMetrics {
  readonly gameNodes: number;
  readonly tagNodes: number;
  readonly developerNodes: number;
  readonly publisherNodes: number;
  readonly deterministicEdges: number;
  readonly largestComponentGames: number;
  readonly largestComponentPct: number;
  readonly bridgedGames: number;
  readonly bridgedPct: number;
  /** 정본 gold (기본 non-tag). */
  readonly gold: GoldMetrics;
  /** 참고 보조 통계 (develops-only). 정본 판단용이 아니라 대조용이다. */
  readonly goldDevelops: GoldMetrics;
}

export interface GraphV1 {
  readonly version: typeof GRAPH_VERSION;
  readonly createdAt: string;
  readonly corpus: {
    readonly manifestFingerprint: string;
    readonly documentCount: number;
    readonly extractionEligibleCount: number;
  };
  readonly policy: GraphPolicySnapshot;
  readonly normalization: {
    readonly aliases: readonly AliasChangeRecord[];
    readonly exclusions: readonly ExclusionRecord[];
  };
  readonly nodes: readonly GraphNode[];
  readonly deterministicEdges: readonly DeterministicEdge[];
  readonly relationEdges: readonly RelationEdge[];
  readonly metrics: GraphMetrics;
}
