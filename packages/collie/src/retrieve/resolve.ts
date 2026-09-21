/**
 * P3-F 시작 엔티티 resolve (결정적, LLM 없음).
 *
 * 질문 정규화 문자열에 노드 label(또는 aliasTerms 별칭)이 substring으로
 * 들어있으면 시작 노드로 삼는다. denylist 언급은 L4 direct-only 판정용으로
 * 함께 추출한다. 매칭 0건이면 entity_unresolved로 취급한다.
 */
import type { Config, GraphNode } from '../types.js';

/**
 * 정규화: 소문자 → 특수문자 제거 → 공백 정리. 한글은 그대로 둔다.
 *
 * 아포스트로피·콜론·하이픈·마침표·™·따옴표 등은 양쪽에서 지운 뒤 비교한다
 * ("Baldur's Gate 3"→"baldurs gate 3", "Co-op"→"coop"). 제거(치환 아님)라
 * "Baldurs"와 "Baldur's"가 같은 키가 된다. 한글 음절·자모·숫자는 보존한다.
 */
export function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\u3131-\u318e\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ResolvedStart {
  /** 결정적 순서(노드 id 오름차순). */
  readonly nodeIds: readonly string[];
  /** 질문에 언급된 denylist 원문 term. */
  readonly mentionedDenylist: readonly string[];
}

export function resolveStarts(
  question: string,
  config: Config,
  nodes: readonly GraphNode[],
): ResolvedStart {
  const q = normalizeLabel(question);

  const aliasToCanon = new Map<string, string>();
  for (const [canon, aliases] of Object.entries(config.graph.aliasTerms)) {
    const canonNorm = normalizeLabel(canon);
    for (const alias of aliases) {
      const aliasNorm = normalizeLabel(alias);
      if (aliasNorm) aliasToCanon.set(aliasNorm, canonNorm);
    }
  }

  const byNorm = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const key = normalizeLabel(node.label);
    const list = byNorm.get(key);
    if (list) list.push(node);
    else byNorm.set(key, [node]);
  }

  const matched = new Set<string>();
  if (q) {
    for (const [normLabel, group] of byNorm) {
      if (normLabel && q.includes(normLabel)) {
        for (const node of group) matched.add(node.id);
      }
    }
    for (const [aliasNorm, canonNorm] of aliasToCanon) {
      if (q.includes(aliasNorm)) {
        for (const node of byNorm.get(canonNorm) ?? []) matched.add(node.id);
      }
    }
  }

  const denyTerms = new Set<string>();
  for (const level of config.graph.levels) {
    for (const term of level.denylist) denyTerms.add(term);
  }
  const mentioned = [...denyTerms].filter((term) => {
    const norm = normalizeLabel(term);
    return norm !== '' && q.includes(norm);
  });

  return { nodeIds: [...matched].sort(), mentionedDenylist: mentioned.sort() };
}
