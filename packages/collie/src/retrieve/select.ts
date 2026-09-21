/**
 * P3-F 후보 선정 (결정적, LLM 없음).
 *
 * 성공 조건: non-TAG edge(HAS_TAG 제외) 최소 1개 포함 + 수집 근거가
 * config answerEvidenceMin 이상. 근거는 경로상 game 노드에서
 * deps.evidenceSpans로 모아 document|sentence|expression 기준 중복 제거한다.
 * 실패해도 best 근거는 trace용으로 돌려준다.
 */
import type { EvidenceSpan, GraphDeps, GraphEdge, GraphNode, GraphPath } from '../types.js';

export function isNonTagEdge(edge: GraphEdge): boolean {
  return edge.type !== 'HAS_TAG';
}

export interface SelectOptions {
  readonly answerEvidenceMin: number;
  readonly maxPaths: number;
  readonly nodes: ReadonlyMap<string, GraphNode>;
}

export interface Selection {
  readonly path: GraphPath | null;
  /** 성공 시 선택 근거, 실패 시 best 후보 근거. */
  readonly evidence: readonly EvidenceSpan[];
  /** non-TAG 필터를 통과한 후보 수. */
  readonly eligibleCount: number;
  readonly reason: string;
}

function evidenceKey(span: EvidenceSpan): string {
  return `${span.document}|${span.sentence}|${span.expression}`;
}

async function collectEvidence(
  deps: GraphDeps,
  path: GraphPath,
  nodes: ReadonlyMap<string, GraphNode>,
): Promise<EvidenceSpan[]> {
  const seen = new Set<string>();
  const out: EvidenceSpan[] = [];
  for (const nodeId of path.nodes) {
    if (nodes.get(nodeId)?.kind !== 'game') continue;
    const spans = await deps.evidenceSpans(nodeId);
    for (const span of spans) {
      const key = evidenceKey(span);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(span);
    }
  }
  return out;
}

function orderKey(path: GraphPath): string {
  return path.nodes.join('>');
}

export async function selectPath(
  deps: GraphDeps,
  candidates: readonly GraphPath[],
  opts: SelectOptions,
): Promise<Selection> {
  const eligible = candidates.filter((path) => path.edges.some(isNonTagEdge));
  const ordered = [...eligible]
    .sort((a, b) => {
      if (a.nodes.length !== b.nodes.length) return a.nodes.length - b.nodes.length;
      const nonTagA = a.edges.filter(isNonTagEdge).length;
      const nonTagB = b.edges.filter(isNonTagEdge).length;
      if (nonTagA !== nonTagB) return nonTagB - nonTagA;
      const ka = orderKey(a);
      const kb = orderKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    })
    .slice(0, Math.max(opts.maxPaths, 0));

  let best: EvidenceSpan[] = [];
  for (const path of ordered) {
    const evidence = await collectEvidence(deps, path, opts.nodes);
    if (evidence.length > best.length) best = evidence;
    if (evidence.length >= opts.answerEvidenceMin) {
      return { path, evidence, eligibleCount: eligible.length, reason: 'ok' };
    }
  }

  if (eligible.length === 0) {
    return { path: null, evidence: best, eligibleCount: 0, reason: 'no-non-tag-edge' };
  }
  return {
    path: null,
    evidence: best,
    eligibleCount: eligible.length,
    reason: `evidence-shortfall(best ${best.length}<min ${opts.answerEvidenceMin})`,
  };
}
