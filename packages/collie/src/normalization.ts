/**
 * P2-C deterministic normalization.
 *
 * 기준 mufa 실측과 빌더 구현은 별도 워커·별도 구현이며, 동등 지표 재현은
 * 독립 검증이다 (REPORT 근거용 기록).
 *
 * Rules: trim + casefold + whitespace collapse. JS에는 casefold가 없어
 * toLowerCase()로 근사한다 (대상 데이터는 영문 위주라 동등).
 * Alias는 config `graph.aliasTerms`를 그대로 받아 적용하고, 적용 건만
 * change log에 남긴다 (현재 config는 `{}`라 log는 빈 배열이어야 한다).
 */

export type EntityKind = 'tag' | 'developer' | 'publisher';

export type NodeKind = 'game' | EntityKind;

export interface AliasChange {
  readonly from: string;
  readonly to: string;
}

/** trim → 내부 공백 1칸 → 소문자. 결정적이며 멱등하다. */
export function normalizeLabel(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 안정 node ID: namespace + normalized label. 게임은 `game:<appid>`. */
export function makeNodeId(kind: NodeKind, key: string): string {
  return `${kind}:${key}`;
}

export function makeGameNodeId(appId: number): string {
  return makeNodeId('game', String(appId));
}

export interface Normalizer {
  /** normalize + alias 적용. alias 적중 시 changelog에 1건 추가. */
  normalize(raw: string): string;
  readonly changelog: readonly AliasChange[];
}

export function createNormalizer(
  aliases: Readonly<Record<string, string>> = {},
): Normalizer {
  const changelog: AliasChange[] = [];
  return {
    changelog,
    normalize(raw: string): string {
      const base = normalizeLabel(raw);
      const aliased = aliases[base] ?? base;
      if (aliased !== base) changelog.push({ from: base, to: aliased });
      return aliased;
    },
  };
}
