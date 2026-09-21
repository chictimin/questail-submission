/**
 * P2-C deterministic graph builder.
 *
 * 기준 mufa 실측과 빌더 구현은 별도 워커·별도 구현이며, 동등 지표 재현은
 * 독립 검증이다 (REPORT 근거용 기록).
 *
 * 입력: prepare가 출력한 canonical MD 126건 + manifest.json.
 * 126 문서 전부가 GAME 노드가 된다 (113 extractionEligible와 혼동 금지 —
 * eligible 여부는 GAME 노드 메타로만 분리한다).
 *
 * 동결 규칙 (지표 대조 전 고정, 사후 조정 금지):
 * - 정규화: trim + casefold(toLowerCase 근사) + 공백 1칸.
 * - 별칭: config 정본(aliasTerms)을 역변환한 alias→canonical을 정규화
 *   label에 적용, 적용 건은 changelog 기록. buildGraph 직접 호출 시에는
 *   명시 options로 주입한다.
 * - 제외: config 정본(stopTerms)을 df 집계 전에 제거, 적용 건은 changelog
 *   기록 (현재 빈 집합).
 * - HAS_TAG: 게임별 votes 내림차순 rank (동률은 정규화 label 오름차순) 상위
 *   TAG_TOP_K(=10, SteamSpy 수집 정책). df bounds + denylist는 아래 상수
 *   (repo config/default.json levels[0]와 동일 값).
 * - DEVELOPED_BY / PUBLISHED_BY: df bounds만.
 * - 허브: 유효 그래프에서 게임별 서로 다른 이웃 게임 수 상위 10%.
 *   gold 경로의 중간·종점에서 제외 (시작점은 제외하지 않는다).
 * - gold: 서로 다른 게임만 잇는 방향 multigraph 2홉/3홉. 기본 강제 규칙은
 *   DEVELOPED_BY 최소 1개 포함 ('develops').
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createNormalizer,
  makeGameNodeId,
  makeNodeId,
  normalizeLabel,
  type EntityKind,
} from './normalization.js';
import {
  DETERMINISTIC_EDGE_TYPES,
  GRAPH_VERSION,
  type AliasChangeRecord,
  type DeterministicEdge,
  type DeterministicEdgeType,
  type ExclusionRecord,
  type GoldMetrics,
  type GraphMetrics,
  type GraphNode,
  type GraphPolicySnapshot,
  type GraphV1,
} from './graph-data.js';

// ─── 동결 정책 ────────────────────────────────────────────────

const TAG_TOP_K = 10;
const TAG_DF_MIN = 3;
const TAG_DF_MAX = 15;
const DEV_DF_MIN = 2;
const DEV_DF_MAX = 10;
const PUB_DF_MIN = 2;
const PUB_DF_MAX = 10;
/** repo config/default.json levels[*].denylist와 동일. df와 무관하게 항상 제외. */
const DENYLIST = ['Singleplayer', 'Multiplayer', 'Action', 'Adventure'];
const HUB_TOP_FRACTION = 0.1;

/**
 * 정책 정본은 packages/collie/config/default.json 한 곳이다.
 * 하드코딩 별칭표·자동 병합 규칙(prefix/substring/첫단어/접미사 stripping)은
 * 두지 않는다 — 아래 loadCollieConfig()가 canonical→aliases[] 스키마를
 * alias→canonical으로 결정적으로 역변환하고, 명시 매핑만 적용한다.
 * node kind는 namespace로 분리되므로 교차병합이 없다.
 *
 * 바인딩 근거 (동일회사 exact alias 3건, 코퍼스 실측):
 * - 'Capcom'(개발사 221040·퍼블리셔 220440+221040) → 'CAPCOM Co., Ltd.'
 *   (양쪽 각 8건): dev df 8→9·pub df 8→10 (유효범위 2~10 통과 유지).
 * - 'Telltale'(250320 개발사·퍼블리셔) → 'Telltale Games'(207610 개발사):
 *   dev df 1+1→2로 신규 유효, DEVELOPED_BY +2 edge. pub 'telltale'은
 *   df 1 그대로 무효.
 * - 'The Fun Pimps'(251570 개발사) → 'The Fun Pimps Entertainment LLC'
 *   (251570 퍼블리셔): dev·pub 각 df 1 그대로 무효라 edge·지표 영향 0
 *   (changelog에만 기록).
 * 3건 적용 후 정본 지표: non-tag starts 115·L2 18,113·L3 665,979,
 * develops starts 111·L2 7,033 (capcom-only 대비 non-tag L2 +49).
 * 보류(절대 병합 금지): 2K←2K Marin, Ubisoft←Ubisoft Montreal,
 * BunnyHop←BunnyHopHome, Bethesda·Paradox 역할별 법인,
 * '(Mac)'/'(Linux)' 접미 제거 같은 일반 규칙.
 */
const CONFIG_RELATIVE_PATH = 'packages/collie/config/default.json';

interface CollieFileConfig {
  readonly graph?: {
    readonly aliasTerms?: Readonly<Record<string, readonly string[]>>;
    readonly stopTerms?: readonly string[];
  };
}

export interface ResolvedAliases {
  /** alias(normalized) → canonical(normalized). 빌더 입력 형태. */
  readonly aliasToCanonical: Readonly<Record<string, string>>;
  readonly stopTerms: readonly string[];
}

/**
 * canonical→aliases[]를 alias→canonical로 역변환한다.
 * canonical·alias 모두 정렬 순회라 결정적이다. 한 alias를 두 canonical이
 * 주장하면 정렬상 앞선 canonical이 이긴다 (현재 config에 충돌 없음).
 */
export function invertAliasTerms(
  canonicalMap: Readonly<Record<string, readonly string[]>> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const canonical of Object.keys(canonicalMap).sort()) {
    const canonNorm = normalizeLabel(canonical);
    const aliases = canonicalMap[canonical] ?? [];
    for (const alias of [...aliases].sort()) {
      const aliasNorm = normalizeLabel(alias);
      if (aliasNorm === canonNorm) continue;
      if (!(aliasNorm in out)) out[aliasNorm] = canonNorm;
    }
  }
  return out;
}

export async function loadCollieConfig(
  configPath = resolve(PROJECT_ROOT, CONFIG_RELATIVE_PATH),
): Promise<ResolvedAliases> {
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as CollieFileConfig;
  return {
    aliasToCanonical: invertAliasTerms(raw.graph?.aliasTerms ?? {}),
    stopTerms: [...(raw.graph?.stopTerms ?? [])],
  };
}

export type GoldRequirement = 'develops' | 'non-tag';

/**
 * 정본 기본값. 'develops'(DEVELOPED_BY 최소 1개)는 참고 보조 통계로만 둔다.
 * relationEdges가 비어 있는 현재 결정적 측정에서 non-tag = DEV 또는 PUB 1개 이상.
 */
const DEFAULT_GOLD_REQUIREMENT: GoldRequirement = 'non-tag';

// ─── 입력 파싱 ────────────────────────────────────────────────

export interface ParsedDoc {
  readonly appid: number;
  readonly filename: string;
  readonly title: string;
  readonly developers: readonly string[];
  readonly publishers: readonly string[];
  readonly tags: readonly string[];
  readonly votes: Readonly<Record<string, number>>;
}

interface CorpusManifestDoc {
  readonly appid: number;
  readonly filename: string;
  readonly title: string;
  readonly canonicalBody?: { readonly characters?: number };
}

interface CorpusManifest {
  readonly sourceFingerprint: string;
  readonly documentCount: number;
  readonly documents: readonly CorpusManifestDoc[];
  readonly extractionEligible: number;
  readonly extractionExcluded: readonly { readonly appid: number }[];
}

/** frontmatter `key: <JSON>` 한 줄씩만 읽는다. 본문은 건드리지 않는다. */
export function parseFrontmatterDoc(text: string, filename: string): ParsedDoc {
  const close = text.indexOf('---', 3);
  if (!text.startsWith('---') || close === -1) {
    throw new Error(`frontmatter 없음: ${filename}`);
  }
  const record: Record<string, unknown> = {};
  for (const line of text.slice(3, close).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep === -1) throw new Error(`frontmatter 파싱 실패: ${filename}: ${line}`);
    record[trimmed.slice(0, sep).trim()] = JSON.parse(trimmed.slice(sep + 1).trim());
  }
  const appid = record['appid'];
  if (typeof appid !== 'number') throw new Error(`appid 없음: ${filename}`);
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const votes = record['votes'];
  return {
    appid,
    filename,
    title: typeof record['title'] === 'string' ? record['title'] : '',
    developers: strArray(record['developers']),
    publishers: strArray(record['publishers']),
    tags: strArray(record['tags']),
    votes:
      votes !== null && typeof votes === 'object' && !Array.isArray(votes)
        ? (votes as Record<string, number>)
        : {},
  };
}

export interface RankedTag {
  readonly raw: string;
  readonly normalized: string;
  readonly votes: number;
  /** votes 내림차순, 동률은 정규화 label 오름차순 후 1-based 위치. */
  readonly rank: number;
}

/** rank는 전체 태그 기준, 상위 TAG_TOP_K만 사용한다. */
export function rankTags(
  doc: ParsedDoc,
  normalize: (raw: string) => string,
): RankedTag[] {
  const entries = Object.entries(doc.votes).map(([raw, votes]) => ({
    raw,
    normalized: normalize(raw),
    votes: typeof votes === 'number' ? votes : 0,
  }));
  entries.sort((a, b) => b.votes - a.votes || (a.normalized < b.normalized ? -1 : 1));
  return entries.map((e, i) => ({ ...e, rank: i + 1 }));
}

// ─── 그래프 구축 ──────────────────────────────────────────────

export interface BuiltGraph {
  readonly nodes: GraphNode[];
  readonly edges: DeterministicEdge[];
  readonly df: {
    readonly tag: ReadonlyMap<string, number>;
    readonly developer: ReadonlyMap<string, number>;
    readonly publisher: ReadonlyMap<string, number>;
  };
  readonly aliases: AliasChangeRecord[];
  readonly exclusions: ExclusionRecord[];
  readonly eligible: ReadonlySet<number>;
  readonly policy: GraphPolicySnapshot;
  readonly manifestFingerprint: string;
  readonly documentCount: number;
  readonly extractionEligibleCount: number;
}

function dfOf(docs: ParsedDoc[], kind: EntityKind, normalize: (r: string) => string): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set<string>();
    const raws = kind === 'tag' ? doc.tags : kind === 'developer' ? doc.developers : doc.publishers;
    for (const raw of raws) seen.add(normalize(raw));
    for (const label of seen) df.set(label, (df.get(label) ?? 0) + 1);
  }
  return df;
}

export function buildGraph(
  docs: ParsedDoc[],
  manifest: CorpusManifest,
  options: {
    readonly aliases?: Readonly<Record<string, string>>;
    readonly excludedTerms?: readonly string[];
  } = {},
): BuiltGraph {
  /**
   * 명시 options 경로 (테스트용). 별칭·제외어를 직접 지정한다.
   * production 기본 경로(buildAndWriteGraph)는 config 정본에서 읽은 값을
   * 전달해야 한다 — 이 함수가 config를 직접 읽지 않는다.
   */
  const aliases = options.aliases ?? {};
  const excluded = new Set((options.excludedTerms ?? []).map((t) => normalizeLabel(t)));
  const normalizer = createNormalizer(aliases);
  const normalize = (raw: string): string => normalizer.normalize(raw);

  const ordered = [...docs].sort((a, b) => a.appid - b.appid);
  const excludedAppids = new Set(manifest.extractionExcluded.map((e) => e.appid));
  const eligible = new Set(ordered.map((d) => d.appid).filter((a) => !excludedAppids.has(a)));

  const dfDev = dfOf(ordered, 'developer', normalize);
  const dfPub = dfOf(ordered, 'publisher', normalize);

  // HAS_TAG는 rank 상위 TAG_TOP_K만 df에 넣는다 (수집 정책).
  const dfTag = new Map<string, Set<number>>();
  for (const doc of ordered) {
    const top = new Set(
      rankTags(doc, normalize)
        .filter((t) => t.rank <= TAG_TOP_K)
        .map((t) => t.normalized),
    );
    for (const label of top) {
      let s = dfTag.get(label);
      if (!s) dfTag.set(label, (s = new Set()));
      s.add(doc.appid);
    }
  }
  const dfTagCount = new Map([...dfTag].map(([k, v]) => [k, v.size] as const));

  const denied = new Set(DENYLIST.map((t) => normalizeLabel(t)));
  const isValid = (kind: EntityKind, label: string): boolean => {
    if (excluded.has(label)) return false;
    if (kind === 'tag') {
      if (denied.has(label)) return false;
      const df = dfTagCount.get(label) ?? 0;
      return df >= TAG_DF_MIN && df <= TAG_DF_MAX;
    }
    const table = kind === 'developer' ? dfDev : dfPub;
    const df = table.get(label) ?? 0;
    const [lo, hi] = kind === 'developer' ? [DEV_DF_MIN, DEV_DF_MAX] : [PUB_DF_MIN, PUB_DF_MAX];
    return df >= lo && df <= hi;
  };

  const nodes: GraphNode[] = [];
  const edges: DeterministicEdge[] = [];
  const entitySeen = new Set<string>();

  const emitEntity = (kind: EntityKind, label: string): string => {
    const id = makeNodeId(kind, label);
    if (!entitySeen.has(id)) {
      entitySeen.add(id);
      nodes.push({ id, kind, label });
    }
    return id;
  };

  const emitEdge = (
    type: DeterministicEdgeType,
    gameId: string,
    entityId: string,
    provenance: DeterministicEdge['provenance'],
  ): void => {
    edges.push({ id: `${type}:${gameId}:${entityId}`, type, from: gameId, to: entityId, provenance });
  };

  const manifestByAppid = new Map(manifest.documents.map((d) => [d.appid, d] as const));

  for (const doc of ordered) {
    const gameId = makeGameNodeId(doc.appid);
    const meta = manifestByAppid.get(doc.appid);
    nodes.push({
      id: gameId,
      kind: 'game',
      label: doc.title,
      game: {
        appid: doc.appid,
        title: doc.title,
        filename: doc.filename,
        extractionEligible: eligible.has(doc.appid),
        canonicalBodyCharacters: meta?.canonicalBody?.characters ?? 0,
      },
    });

    for (const ranked of rankTags(doc, normalize)) {
      if (ranked.rank > TAG_TOP_K) continue;
      if (!isValid('tag', ranked.normalized)) continue;
      emitEdge('HAS_TAG', gameId, emitEntity('tag', ranked.normalized), {
        appId: doc.appid,
        document: doc.filename,
        df: dfTagCount.get(ranked.normalized) ?? 0,
        rank: ranked.rank,
        votes: ranked.votes,
      });
    }
    const emitName = (
      type: 'DEVELOPED_BY' | 'PUBLISHED_BY',
      kind: EntityKind,
      raws: readonly string[],
    ): void => {
      const seen = new Set<string>();
      for (const raw of raws) {
        const label = normalize(raw);
        if (seen.has(label)) continue;
        seen.add(label);
        if (!isValid(kind, label)) continue;
        const table = kind === 'developer' ? dfDev : dfPub;
        emitEdge(type, gameId, emitEntity(kind, label), {
          appId: doc.appid,
          document: doc.filename,
          df: table.get(label) ?? 0,
        });
      }
    };
    emitName('DEVELOPED_BY', 'developer', doc.developers);
    emitName('PUBLISHED_BY', 'publisher', doc.publishers);
  }

  nodes.sort((a, b) => (a.id < b.id ? -1 : 1));
  edges.sort((a, b) => (a.id < b.id ? -1 : 1));

  // changelog 산출물: label 단위 병합 (적용 appid 목록 포함).
  const aliasGroups = new Map<string, { to: string; appids: Set<number> }>();
  for (const doc of ordered) {
    const raws = [...doc.tags, ...doc.developers, ...doc.publishers];
    for (const raw of raws) {
      const base = normalizeLabel(raw);
      const to = aliases[base];
      if (to !== undefined && to !== base) {
        let g = aliasGroups.get(base);
        if (!g) aliasGroups.set(base, (g = { to, appids: new Set() }));
        g.appids.add(doc.appid);
      }
    }
  }
  const aliasRecords: AliasChangeRecord[] = [...aliasGroups]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([label, g]) => ({ label, canonical: g.to, appids: [...g.appids].sort((x, y) => x - y) }));

  const exclusionGroups = new Map<string, Set<number>>();
  if (excluded.size > 0) {
    for (const doc of ordered) {
      const raws = [...doc.tags, ...doc.developers, ...doc.publishers];
      for (const raw of raws) {
        const label = normalizer.normalize(raw);
        if (excluded.has(label)) {
          let s = exclusionGroups.get(label);
          if (!s) exclusionGroups.set(label, (s = new Set()));
          s.add(doc.appid);
        }
      }
    }
  }
  const exclusionRecords: ExclusionRecord[] = [...exclusionGroups]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([label, s]) => ({ label, appids: [...s].sort((x, y) => x - y) }));

  const policy: GraphPolicySnapshot = {
    tagTopK: TAG_TOP_K,
    tagDfMin: TAG_DF_MIN,
    tagDfMax: TAG_DF_MAX,
    devDfMin: DEV_DF_MIN,
    devDfMax: DEV_DF_MAX,
    pubDfMin: PUB_DF_MIN,
    pubDfMax: PUB_DF_MAX,
    denylist: DENYLIST,
    aliases,
    excludedTerms: [...excluded],
    hubTopFraction: HUB_TOP_FRACTION,
    goldRequirement: DEFAULT_GOLD_REQUIREMENT,
  };

  return {
    nodes,
    edges,
    df: { tag: dfTagCount, developer: dfDev, publisher: dfPub },
    aliases: aliasRecords,
    exclusions: exclusionRecords,
    eligible,
    policy,
    manifestFingerprint: manifest.sourceFingerprint,
    documentCount: manifest.documentCount,
    extractionEligibleCount: manifest.extractionEligible,
  };
}

// ─── 측정 (연결성·브릿지·gold) ────────────────────────────────

/** 게임별 서로 다른 이웃 게임 집합 (유효 edge 경유). */
export function gameNeighbors(graph: BuiltGraph): Map<string, Set<string>> {
  const byEntity = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    let s = byEntity.get(e.to);
    if (!s) byEntity.set(e.to, (s = new Set()));
    s.add(e.from);
  }
  const neighbors = new Map<string, Set<string>>();
  for (const n of graph.nodes) {
    if (n.kind !== 'game') continue;
    neighbors.set(n.id, new Set());
  }
  for (const members of byEntity.values()) {
    const list = [...members];
    for (const a of list) {
      const set = neighbors.get(a);
      if (!set) continue;
      for (const b of list) if (b !== a) set.add(b);
    }
  }
  return neighbors;
}

export function connectedComponents(neighbors: Map<string, Set<string>>): string[][] {
  const seen = new Set<string>();
  const comps: string[][] = [];
  for (const start of neighbors.keys()) {
    if (seen.has(start)) continue;
    const comp: string[] = [];
    const stack = [start];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      comp.push(cur);
      for (const nb of neighbors.get(cur) ?? []) if (!seen.has(nb)) stack.push(nb);
    }
    comps.push(comp.sort());
  }
  return comps.sort((a, b) => b.length - a.length);
}

/** 상위 HUB_TOP_FRACTION 게임 (동률 포함). 내림차순 상위 10% 경계값. */
export function computeHubs(neighbors: Map<string, Set<string>>): Set<string> {
  const entries = [...neighbors].map(([id, set]) => ({ id, degree: set.size }));
  entries.sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : 1));
  const cutoffIndex = Math.ceil(entries.length * HUB_TOP_FRACTION) - 1;
  const cutoff = entries[Math.max(0, cutoffIndex)]?.degree ?? 0;
  return new Set(entries.filter((e) => e.degree >= cutoff && cutoff > 0).map((e) => e.id));
}

interface Hop {
  readonly to: string;
  readonly kind: 'tag' | 'developer' | 'publisher';
}

function hopLists(graph: BuiltGraph): Map<string, Hop[]> {
  const byEntity = new Map<string, { kind: Hop['kind']; members: string[] }>();
  for (const e of graph.edges) {
    const kind: Hop['kind'] =
      e.type === 'HAS_TAG' ? 'tag' : e.type === 'DEVELOPED_BY' ? 'developer' : 'publisher';
    let slot = byEntity.get(e.to);
    if (!slot) byEntity.set(e.to, (slot = { kind, members: [] }));
    slot.members.push(e.from);
  }
  const hops = new Map<string, Hop[]>();
  for (const { kind, members } of byEntity.values()) {
    const sorted = [...members].sort();
    for (const a of sorted) {
      let list = hops.get(a);
      if (!list) hops.set(a, (list = []));
      for (const b of sorted) if (b !== a) list.push({ to: b, kind });
    }
  }
  return hops;
}

function forcedOk(kinds: readonly string[], requirement: GoldRequirement): boolean {
  if (requirement === 'develops') return kinds.includes('developer');
  return kinds.some((k) => k === 'developer' || k === 'publisher');
}

/**
 * 방향 multigraph 길이 2·3 경로 (서로 다른 게임만, 중간·종점 허브 제외).
 * hop마다 공유 entity가 다르므로 (s,x,y) 삼중항도 셀 수 있으나, 기준
 * 대조용 기본값은 multigraph 그대로 센다.
 */
export function enumerateGoldPaths(
  graph: BuiltGraph,
  hubs: ReadonlySet<string>,
  requirement: GoldRequirement,
  length: 2 | 3,
): { readonly total: number; readonly starts: readonly number[]; readonly byKinds: Readonly<Record<string, number>> } {
  const hops = hopLists(graph);
  const idToAppid = new Map(graph.nodes.filter((n) => n.kind === 'game').map((n) => [n.id, n.game?.appid ?? 0] as const));
  type Cursor = { start: string; nodes: readonly string[]; kinds: readonly string[]; count: number };
  let cursors = new Map<string, Cursor>();
  for (const [s, list] of hops) {
    for (const h of list) {
      const key = `${s}|${s},${h.to}|${h.kind}`;
      const prev = cursors.get(key);
      if (prev) prev.count += 1;
      else cursors.set(key, { start: s, nodes: [s, h.to], kinds: [h.kind], count: 1 });
    }
  }
  for (let step = 2; step <= length; step += 1) {
    const next = new Map<string, Cursor>();
    for (const c of cursors.values()) {
      if (c.nodes.length !== step) continue;
      const last = c.nodes[c.nodes.length - 1] as string;
      for (const h of hops.get(last) ?? []) {
        if (c.nodes.includes(h.to)) continue;
        const key = `${c.start}|${[...c.nodes, h.to].join(',')}|${[...c.kinds, h.kind].join(',')}`;
        const prev = next.get(key);
        if (prev) prev.count += c.count;
        else next.set(key, { start: c.start, nodes: [...c.nodes, h.to], kinds: [...c.kinds, h.kind], count: c.count });
      }
    }
    cursors = next;
  }
  let total = 0;
  const starts = new Set<number>();
  const byKinds: Record<string, number> = {};
  for (const c of cursors.values()) {
    if (c.nodes.length !== length + 1) continue;
    if (!forcedOk(c.kinds, requirement)) continue;
    if (c.nodes.slice(1).some((id) => hubs.has(id))) continue;
    total += c.count;
    starts.add(idToAppid.get(c.start) ?? 0);
    const key = c.kinds.join('+');
    byKinds[key] = (byKinds[key] ?? 0) + c.count;
  }
  starts.delete(0);
  return { total, starts: [...starts].sort((a, b) => a - b), byKinds };
}

const pct1 = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;

export function computeMetrics(graph: BuiltGraph, requirement: GoldRequirement = DEFAULT_GOLD_REQUIREMENT): GraphMetrics {
  const neighbors = gameNeighbors(graph);
  const comps = connectedComponents(neighbors);
  const hubs = computeHubs(neighbors);
  const gold = ((): GoldMetrics => {
    const g2 = enumerateGoldPaths(graph, hubs, requirement, 2);
    const g3 = enumerateGoldPaths(graph, hubs, requirement, 3);
    return {
      requirement,
      startGames: g2.starts.length,
      startAppids: g2.starts,
      pathsLength2: g2.total,
      pathsLength2ByKinds: g2.byKinds,
      pathsLength3: g3.total,
    };
  })();
  const goldDevelops: GoldMetrics =
    requirement === 'develops'
      ? gold
      : (() => {
          const g2 = enumerateGoldPaths(graph, hubs, 'develops', 2);
          const g3 = enumerateGoldPaths(graph, hubs, 'develops', 3);
          return {
            requirement: 'develops' as const,
            startGames: g2.starts.length,
            startAppids: g2.starts,
            pathsLength2: g2.total,
            pathsLength2ByKinds: g2.byKinds,
            pathsLength3: g3.total,
          };
        })();
  const gameIds = new Set(graph.nodes.filter((n) => n.kind === 'game').map((n) => n.id));
  const countKind = (kind: GraphNode['kind']): number =>
    graph.nodes.filter((n) => n.kind === kind).length;
  const bridged = [...neighbors].filter(([, set]) => set.size > 0).length;
  return {
    gameNodes: countKind('game'),
    tagNodes: countKind('tag'),
    developerNodes: countKind('developer'),
    publisherNodes: countKind('publisher'),
    deterministicEdges: graph.edges.length,
    largestComponentGames: comps[0]?.length ?? 0,
    largestComponentPct: pct1(comps[0]?.length ?? 0, gameIds.size),
    bridgedGames: bridged,
    bridgedPct: pct1(bridged, gameIds.size),
    gold,
    goldDevelops,
  };
}

export function buildEnvelope(graph: BuiltGraph, requirement: GoldRequirement = DEFAULT_GOLD_REQUIREMENT): GraphV1 {
  return {
    version: GRAPH_VERSION,
    createdAt: new Date().toISOString(),
    corpus: {
      manifestFingerprint: graph.manifestFingerprint,
      documentCount: graph.documentCount,
      extractionEligibleCount: graph.extractionEligibleCount,
    },
    policy: { ...graph.policy, goldRequirement: requirement },
    normalization: { aliases: graph.aliases, exclusions: graph.exclusions },
    nodes: graph.nodes,
    deterministicEdges: graph.edges,
    relationEdges: [],
    metrics: computeMetrics(graph, requirement),
  };
}

// ─── 입출력 ───────────────────────────────────────────────────

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ROOT = resolve(APP_ROOT, '../..');

export async function buildAndWriteGraph(
  corpusRoot = resolve(PROJECT_ROOT, 'packages/collie/output/corpus'),
  outputRoot = resolve(PROJECT_ROOT, 'packages/collie/output/graph'),
  requirement: GoldRequirement = DEFAULT_GOLD_REQUIREMENT,
  configPath = resolve(PROJECT_ROOT, CONFIG_RELATIVE_PATH),
): Promise<GraphV1> {
  const manifest = JSON.parse(await readFile(join(corpusRoot, 'manifest.json'), 'utf8')) as CorpusManifest;
  const files = (await readdir(corpusRoot)).filter((f) => f.endsWith('.md')).sort();
  const docs: ParsedDoc[] = [];
  for (const file of files) {
    docs.push(parseFrontmatterDoc(await readFile(join(corpusRoot, file), 'utf8'), file));
  }
  const config = await loadCollieConfig(configPath);
  const envelope = buildEnvelope(
    buildGraph(docs, manifest, {
      aliases: { ...config.aliasToCanonical },
      excludedTerms: [...config.stopTerms],
    }),
    requirement,
  );
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(outputRoot, 'graph.v1.json'), `${JSON.stringify(envelope, null, 2)}\n`);
  return envelope;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  buildAndWriteGraph(opt('--corpus-root'), opt('--output-root'))
    .then((g) => console.log(
      `graph.v1: games=${g.metrics.gameNodes} edges=${g.metrics.deterministicEdges} ` +
      `lcc=${g.metrics.largestComponentGames} bridged=${g.metrics.bridgedGames} ` +
      `goldStarts=${g.metrics.gold.startGames} goldL2=${g.metrics.gold.pathsLength2}`,
    ))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

export { DETERMINISTIC_EDGE_TYPES };
