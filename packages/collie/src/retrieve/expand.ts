/**
 * P3-F n-hop expansion (결정적 BFS, LLM 없음).
 *
 * 레벨 정책 적용 순서: relation switch → denylist → df 범위 → 반경.
 * - relation edge는 allowVerifiedRelation && verifiedEdgeKeys 적중 때만 사용.
 * - denylist 노드는 bridge로 쓰지 않는다. block-expansion이면 종점 매칭만
 *   허용하고, explicit-direct-only(L4)이면 질문언급 denylist도 시작노드
 *   직결 1홉 종점으로만 허용한다.
 * - tag/developer/publisher bridge는 documentFrequency가 레벨 df 범위
 *   안일 때만 통과한다. game 노드는 df 대상이 아니다.
 * - 후보는 시작노드가 아닌 game 노드에서 끝나는 radius 이내 경로다.
 */
import type {
  GraphDeps,
  GraphEdge,
  GraphNode,
  GraphPath,
  RetrievalLevelPolicy,
} from '../types.js';
import { normalizeLabel } from './resolve.js';

export interface ExpandOptions {
  readonly policy: RetrievalLevelPolicy;
  readonly starts: readonly string[];
  readonly mentionedDenylist: readonly string[];
  /** config.graph.canonicalEdgeTypes — LLM relation 전용 타입 집합. */
  readonly relationTypes: readonly string[];
  readonly verifiedKeys: ReadonlySet<string>;
  readonly maxCandidates: number;
  readonly nodes: ReadonlyMap<string, GraphNode>;
}

export interface ExpansionResult {
  readonly candidates: readonly GraphPath[];
  readonly blockedHubs: readonly string[];
  /** 'nodeId: reason' — hub handling 사유 trace. */
  readonly blockReasons: readonly string[];
  readonly capped: boolean;
}

interface QueueEntry {
  readonly nodeId: string;
  readonly pathNodes: readonly string[];
  readonly pathEdges: readonly GraphEdge[];
}

function dfRangeOf(policy: RetrievalLevelPolicy, kind: string): { min: number; max: number } | null {
  if (kind === 'tag') return policy.tagDf;
  if (kind === 'developer') return policy.developerDf;
  if (kind === 'publisher') return policy.publisherDf;
  return null;
}

export function verifiedKeyOf(edge: GraphEdge): string {
  return `${edge.type}::${edge.from}::${edge.to}`;
}

export async function expandPaths(deps: GraphDeps, opts: ExpandOptions): Promise<ExpansionResult> {
  const denyNorm = new Set(opts.policy.denylist.map(normalizeLabel));
  const mentionedNorm = new Set(opts.mentionedDenylist.map(normalizeLabel));
  const isDirectOnly = opts.policy.denylistMode === 'explicit-direct-only';
  const startSet = new Set(opts.starts);

  const candidates: GraphPath[] = [];
  const blocked = new Map<string, string>();
  const block = (nodeId: string, reason: string): void => {
    if (!blocked.has(nodeId)) blocked.set(nodeId, reason);
  };

  const dfCache = new Map<string, number>();
  async function dfOf(node: GraphNode): Promise<number> {
    const key = `${node.kind}:${node.label}`;
    const cached = dfCache.get(key);
    if (cached !== undefined) return cached;
    const df = await deps.documentFrequency(
      node.label,
      node.kind as 'tag' | 'developer' | 'publisher',
    );
    dfCache.set(key, df);
    return df;
  }

  const visited = new Set<string>(opts.starts);
  const queue: QueueEntry[] = opts.starts.map((nodeId) => ({
    nodeId,
    pathNodes: [nodeId],
    pathEdges: [],
  }));

  let capped = false;
  let head = 0;
  while (head < queue.length) {
    const entry = queue[head] as QueueEntry;
    head += 1;
    const hops = entry.pathEdges.length;
    if (hops >= opts.policy.radius) continue;

    const edges = await deps.neighbors(entry.nodeId);
    for (const edge of edges) {
      if (candidates.length >= opts.maxCandidates) {
        capped = true;
        break;
      }
      const nextId = edge.from === entry.nodeId ? edge.to : edge.to === entry.nodeId ? edge.from : null;
      if (nextId === null) continue;
      const next = opts.nodes.get(nextId);
      if (!next) continue;

      // 1. relation switch — verified/정책 allow 때만 사용.
      if (opts.relationTypes.includes(edge.type)) {
        const key = verifiedKeyOf(edge);
        if (!opts.policy.allowVerifiedRelation) {
          block(nextId, `relation-disabled(${edge.type})`);
          continue;
        }
        if (!opts.verifiedKeys.has(key)) {
          block(nextId, `relation-unverified(${key})`);
          continue;
        }
      }

      const labelNorm = normalizeLabel(next.label);
      const isDenied = denyNorm.has(labelNorm);

      // 2. denylist — bridge 금지.
      if (isDenied) {
        const fromStart = startSet.has(entry.nodeId) && hops === 0;
        const mentioned = mentionedNorm.has(labelNorm);
        if (isDirectOnly) {
          if (!(mentioned && fromStart)) {
            block(nextId, mentioned ? 'denylist-direct-only-indirect' : 'denylist-direct-only-unmentioned');
            continue;
          }
          // 언급+직결: 종점으로만 허용하고 통과는 금지.
          block(nextId, 'denylist-bridge-blocked(direct-endpoint-only)');
          continue;
        }
        // block-expansion: 종점 매칭만 허용하고 통과는 금지.
        block(nextId, 'denylist-bridge-blocked');
        continue;
      }

      // 3. df 범위 — entity bridge만 검사.
      const range = dfRangeOf(opts.policy, next.kind);
      if (range !== null) {
        const df = await dfOf(next);
        if (df < range.min || df > range.max) {
          block(nextId, `df-out-of-range(df=${df},range=${range.min}-${range.max})`);
          continue;
        }
      }

      const nodes = [...entry.pathNodes, nextId];
      const pathEdges = [...entry.pathEdges, edge];
      if (next.kind === 'game' && !startSet.has(nextId)) {
        candidates.push({ nodes, edges: pathEdges });
        if (candidates.length >= opts.maxCandidates) {
          capped = true;
          break;
        }
      }
      if (!visited.has(nextId)) {
        visited.add(nextId);
        queue.push({ nodeId: nextId, pathNodes: nodes, pathEdges });
      }
    }
    if (capped) break;
  }

  return {
    candidates,
    blockedHubs: [...blocked.keys()],
    blockReasons: [...blocked.entries()].map(([id, reason]) => `${id}: ${reason}`),
    capped,
  };
}
