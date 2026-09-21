/**
 * P4-G GraphDeps 어댑터 (읽기 전용).
 *
 * P2-C graph.v1 + output/corpus 청크를 retrieve()의 GraphDeps 포트로
 * 맞춘다. games/·output/**에는 쓰지 않는다.
 *
 * evidence 조건(P4-G 승인 조건 1): span.sentence는 문서 원문 verbatim만.
 * frontmatter 필드값 인용은 md 파일의 실제 substring이라 허용되나, 문서에
 * 없는 문장형 텍스트는 만들지 않는다. sentence가 frontmatter 원문 한 줄
 * (`key: [...]` 형태)이라 필드 provenance가 문장 자체에 드러나며,
 * document에는 코퍼스 경로를 달아 UI가 본문 인용으로 오해하지 않게 한다.
 * 본문 문장 분할·요약은 하지 않는다(앞 2문장도 뽑지 않는다).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvidenceSpan, GraphDeps, GraphEdge, GraphNode } from './types.js';
import type { GraphV1 } from './graph-data.js';

export interface GraphAdapter {
  readonly deps: GraphDeps;
  /** envelope.corpus.manifestFingerprint — RunTrace.corpusFingerprint용. */
  readonly corpusFingerprint: string;
  readonly graphPath: string;
}

export interface GraphAdapterOptions {
  readonly graphPath?: string;
  readonly corpusDir?: string;
}

export function defaultGraphPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'output', 'graph', 'graph.v1.json');
}

function quotedValues(listBody: string): string[] {
  const out: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(listBody)) !== null) {
    out.push(match[1]?.replace(/\\"/g, '"') ?? '');
  }
  return out.filter((value) => value !== '');
}

function frontmatterLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return [];
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return [];
  return lines.slice(1, end);
}

/**
 * 게임 코퍼스 1건에서 verbatim span을 뽑는다. sentence는 항상 파일 원문
 * 한 줄 전체, expression은 그 줄 안의 필드값이다. 최대 8건.
 */
export function gameEvidenceSpans(document: string, text: string): EvidenceSpan[] {
  const lines = frontmatterLines(text);
  const lineOf = (key: string): string | undefined =>
    lines.find((line) => line.match(new RegExp(`^${key}\\s*:`, '')));
  const spans: EvidenceSpan[] = [];

  const titleLine = lineOf('title');
  if (titleLine) {
    const value = quotedValues(titleLine)[0] ?? titleLine.replace(/^title\s*:\s*/, '').trim();
    if (value) spans.push({ document, sentence: titleLine, expression: value });
  }
  for (const key of ['developers', 'publishers'] as const) {
    const line = lineOf(key);
    if (!line) continue;
    const bracket = line.match(/\[(.*)\]\s*$/);
    for (const value of quotedValues(bracket?.[1] ?? '').slice(0, 2)) {
      spans.push({ document, sentence: line, expression: value });
    }
  }
  const tagsLine = lineOf('tags');
  const votesLine = lineOf('votes');
  if (tagsLine) {
    const tags = quotedValues(tagsLine.match(/\[(.*)\]\s*$/)?.[1] ?? '');
    let top = tags.slice(0, 3);
    if (votesLine) {
      const votes = new Map<string, number>();
      const pattern = /"((?:[^"\\]|\\.)*)"\s*:\s*(\d+)/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(votesLine)) !== null) {
        votes.set(match[1] ?? '', Number(match[2] ?? 0));
      }
      top = [...tags].sort((a, b) => (votes.get(b) ?? 0) - (votes.get(a) ?? 0)).slice(0, 3);
    }
    for (const tag of top) spans.push({ document, sentence: tagsLine, expression: tag });
  }
  return spans.slice(0, 8);
}

function appIdOfGameNode(nodeId: string): string | undefined {
  const match = nodeId.match(/^game:(.+)$/);
  return match?.[1];
}

export function loadGraphAdapter(options: GraphAdapterOptions = {}): GraphAdapter {
  const graphPath = options.graphPath ?? defaultGraphPath();
  const corpusDir = options.corpusDir ?? resolve(dirname(graphPath), '..', 'corpus');
  const envelope = JSON.parse(readFileSync(graphPath, 'utf8')) as GraphV1;

  const nodes: GraphNode[] = envelope.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    label: node.label,
  }));
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));

  const adjacency = new Map<string, GraphEdge[]>();
  const push = (nodeId: string, edge: GraphEdge): void => {
    const list = adjacency.get(nodeId);
    if (list) list.push(edge);
    else adjacency.set(nodeId, [edge]);
  };
  for (const edge of envelope.deterministicEdges) {
    const record: GraphEdge = { type: edge.type, from: edge.from, to: edge.to, verified: true };
    push(edge.from, record);
    push(edge.to, record);
  }
  const verifiedKeys = new Set<string>();
  for (const edge of envelope.relationEdges) {
    const accepted = edge.status === 'accepted';
    const record: GraphEdge = { type: edge.type, from: edge.from, to: edge.to, verified: accepted };
    push(edge.from, record);
    push(edge.to, record);
    if (accepted) verifiedKeys.add(`${edge.type}::${edge.from}::${edge.to}`);
  }

  // df는 provenance 선착순. 같은 term은 빌드 시점 동일 df를 공유한다.
  const dfByTerm = new Map<string, number>();
  for (const edge of envelope.deterministicEdges) {
    const entity = nodeById.get(edge.to);
    if (!entity || entity.kind === 'game') continue;
    const key = `${entity.kind}:${entity.label}`;
    if (!dfByTerm.has(key)) dfByTerm.set(key, edge.provenance.df);
  }

  const deps: GraphDeps = {
    listNodes: async (kind?: string) => (kind ? nodes.filter((n) => n.kind === kind) : [...nodes]),
    neighbors: async (nodeId: string) => [...(adjacency.get(nodeId) ?? [])],
    documentFrequency: async (term: string, kind: 'tag' | 'developer' | 'publisher') =>
      dfByTerm.get(`${kind}:${term}`) ?? 0,
    evidenceSpans: async (nodeId: string) => {
      const appId = appIdOfGameNode(nodeId);
      if (!appId) return [];
      const file = resolve(corpusDir, `${appId}.md`);
      if (!existsSync(file)) return [];
      return gameEvidenceSpans(`${appId}.md`, readFileSync(file, 'utf8'));
    },
    verifiedEdgeKeys: async () => new Set(verifiedKeys),
  };

  return { deps, corpusFingerprint: envelope.corpus.manifestFingerprint, graphPath };
}
