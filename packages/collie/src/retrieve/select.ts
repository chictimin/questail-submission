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

export const TAG_FALLBACK_REASON = 'ok(tag-fallback)';

function orderKey(path: GraphPath): string {
  return path.nodes.join('>');
}

function tagBridgeLabels(path: GraphPath, nodes: ReadonlyMap<string, GraphNode>): string[] {
  const labels: string[] = [];
  for (const nodeId of path.nodes) {
    const node = nodes.get(nodeId);
    if (node?.kind === 'tag') labels.push(node.label);
  }
  return labels;
}

async function rarityOf(
  deps: GraphDeps,
  path: GraphPath,
  nodes: ReadonlyMap<string, GraphNode>,
): Promise<{ sum: number; max: number }> {
  const labels = tagBridgeLabels(path, nodes);
  let sum = 0;
  let max = 0;
  for (const label of labels) {
    const df = await deps.documentFrequency(label, 'tag');
    sum += df;
    if (df > max) max = df;
  }
  return { sum, max };
}

/**
 * 태그 폴백 선정 (결과 기준 폴백의 두 번째 단계).
 *
 * 진입 조건은 엔진이 보장한다: 정상 선정이 전 레벨에서 실패했고 해당
 * 레벨 후보가 전부 태그 전용일 때만 호출된다. 후보 집합 자체는
 * expandPaths가 정책(df·denylist·반경)을 적용해 만든 것을 그대로 쓰므로
 * 정책을 우회하지 않는다. 정렬은 브리지 태그 df 합 오름차순(희소 우선),
 * 동률은 최대 df, 경로 길이, 결정적 orderKey 순이다.
 */
export async function selectTagFallback(
  deps: GraphDeps,
  candidates: readonly GraphPath[],
  opts: SelectOptions,
): Promise<Selection> {
  const tagOnly = candidates.filter((path) => !path.edges.some(isNonTagEdge));
  if (tagOnly.length === 0) {
    return { path: null, evidence: [], eligibleCount: 0, reason: 'no-tag-candidates' };
  }
  const scored: { path: GraphPath; sum: number; max: number }[] = [];
  for (const path of tagOnly) {
    const rarity = await rarityOf(deps, path, opts.nodes);
    scored.push({ path, sum: rarity.sum, max: rarity.max });
  }
  scored.sort((a, b) => {
    if (a.sum !== b.sum) return a.sum - b.sum;
    if (a.max !== b.max) return a.max - b.max;
    if (a.path.nodes.length !== b.path.nodes.length) return a.path.nodes.length - b.path.nodes.length;
    const ka = orderKey(a.path);
    const kb = orderKey(b.path);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const ordered = scored.map((entry) => entry.path).slice(0, Math.max(opts.maxPaths, 0));

  let best: EvidenceSpan[] = [];
  for (const path of ordered) {
    const evidence = await collectEvidence(deps, path, opts.nodes);
    if (evidence.length > best.length) best = evidence;
    if (evidence.length >= opts.answerEvidenceMin) {
      return { path, evidence, eligibleCount: tagOnly.length, reason: TAG_FALLBACK_REASON };
    }
  }

  return {
    path: null,
    evidence: best,
    eligibleCount: tagOnly.length,
    reason: `evidence-shortfall(best ${best.length}<min ${opts.answerEvidenceMin})`,
  };
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
