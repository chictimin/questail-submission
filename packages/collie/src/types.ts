/** 앱 계층 전용 계약입니다. core에는 파일 경로나 그래프 상태를 노출하지 않습니다. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RetrievalPolicy {
  readonly level: number;
  readonly maxResults: number;
  readonly tagDocumentFrequency: { readonly min: number; readonly max: number };
  readonly developerDocumentFrequency: { readonly min: number; readonly max: number };
  readonly denyTags: readonly string[];
}

/**
 * collie 앱 전용 그래프 검색 계약(P1-B)입니다. core는 이 파일을 절대 읽지 않습니다.
 *
 * 검증은 zod와 같은 결과 모양(`safeParseConfig`/`parseConfig`)의 무의존 구현입니다.
 * `packages/collie/package.json`이 동결(pogo 소유)이라 `zod` 의존성을 추가할 수 없어
 * 동일 semantics를 순수 TypeScript로 구현했습니다. 의존성 1줄 추가 후 zod로 교체
 * 가능하며, reject 조건(상속·역전·반경·동시완화)은 그대로 유지됩니다.
 */
export interface DocumentFrequencyRange {
  readonly min: number;
  readonly max: number;
}

/**
 * L0~L4 중 한 레벨의 완전 policy snapshot입니다. 다른 레벨을 참조하는 키
 * (`extends`·`inherit`·`base`·`parent`·`mixin`)를 가지면 invalid입니다.
 * 빠진 필드를 상위·전역값으로 메우는 상속도 허용하지 않습니다.
 */
export type DenylistMode = 'block-expansion' | 'explicit-direct-only';

export interface RetrievalLevelPolicy {
  readonly level: number;
  readonly radius: number;
  readonly tagDf: DocumentFrequencyRange;
  readonly developerDf: DocumentFrequencyRange;
  readonly publisherDf: DocumentFrequencyRange;
  /**
   * verified relation edge를 후보에 허용/추가합니다. 경로 전체에 요구하는
   * 뜻이 아닙니다. L0/L1 false, L2~L4 true가 정본입니다.
   */
  readonly allowVerifiedRelation: boolean;
  /**
   * 이 레벨의 차단 대상 목록. 전 레벨이 정본 4종
   * (Singleplayer·Multiplayer·Action·Adventure)을 전부 명시합니다.
   */
  readonly denylist: readonly string[];
  /**
   * `block-expansion`: denylist 항목을 bridge·hub 확장에는 쓰지 않고
   * endpoint 매칭에는 허용합니다. `explicit-direct-only`(L4 전용):
   * 질문이 명시한 denylist 태그는 시작/종점 직접 사실(direct edge)로만
   * 쓰고 bridge로 쓰지 않습니다.
   */
  readonly denylistMode: DenylistMode;
}

/** 정본 정책. validator가 집합 일치를 강제합니다. */
export const CANONICAL_NODE_TYPES: readonly string[] = [
  'game',
  'tag',
  'developer',
  'publisher',
  'series',
  'concept',
];
export const CANONICAL_EDGE_TYPES: readonly string[] = ['IN_SERIES', 'SEQUEL_OF', 'SAME_UNIVERSE'];
export const CANONICAL_DENYLIST: readonly string[] = [
  'Singleplayer',
  'Multiplayer',
  'Action',
  'Adventure',
];

export interface GraphConfig {
  readonly canonicalNodeTypes: readonly string[];
  readonly canonicalEdgeTypes: readonly string[];
  /** canonical 용어 → 별칭 목록. 비어 있으면 별칭 없이 동작합니다. */
  readonly aliasTerms: Readonly<Record<string, readonly string[]>>;
  /**
   * 전역 영구 차단 목록 자리. denylist(레벨별)와 의미가 충돌하므로
   * 정본은 빈 배열을 둡니다. 필드는 스키마 안정용으로 유지합니다.
   */
  readonly stopTerms: readonly string[];
  readonly maxPaths: number;
  readonly maxCandidates: number;
  readonly answerEvidenceMin: number;
  /** 전 레벨 radius의 상한. 레벨 radius가 이를 넘으면 invalid입니다. */
  readonly maxRadius: number;
  /** 정확히 5개(L0~L4), 순서대로, 전부 완전 snapshot이어야 합니다. */
  readonly levels: readonly RetrievalLevelPolicy[];
}

export interface Config {
  readonly version: 1;
  /** corpus prepare 경로 — 기존 필드, 선택으로 유지(호환용). */
  readonly outputRoot?: string;
  /** 기존 corpus 필드, 선택으로 유지(호환용). */
  readonly corpus?: {
    readonly minimumAboutCharacters: number;
    readonly sourceUrlTemplate: string;
  };
  readonly graph: GraphConfig;
}

/** 그래프 탐색 중 변하는 실행 상태(재개·리플레이용). */
export interface State {
  readonly level: number;
  readonly radius: number;
  readonly visitedNodeIds: readonly string[];
  readonly blockedHubs: readonly string[];
  readonly collectedEvidence: readonly EvidenceSpan[];
}

export interface GraphNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
}

export interface GraphEdge {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly verified: boolean;
}

export interface GraphPath {
  readonly nodes: readonly string[];
  readonly edges: readonly GraphEdge[];
}

export interface EvidenceSpan {
  readonly document: string;
  readonly sentence: string;
  readonly expression: string;
}

/**
 * 그래프 접근 의존성 — 앱이 주입합니다. core는 이 타입을 모릅니다.
 * 파일시스템·캐시 해석은 전부 앱의 몫입니다.
 */
export interface GraphDeps {
  readonly listNodes: (kind?: string) => Promise<readonly GraphNode[]>;
  readonly neighbors: (nodeId: string) => Promise<readonly GraphEdge[]>;
  readonly documentFrequency: (term: string, kind: 'tag' | 'developer' | 'publisher') => Promise<number>;
  readonly evidenceSpans: (nodeId: string) => Promise<readonly EvidenceSpan[]>;
  /** `"${type}::${from}::${to}"` 집합. L2+ `allowVerifiedRelation`의 판정 입력입니다. */
  readonly verifiedEdgeKeys: () => Promise<ReadonlySet<string>>;
}

export interface AttemptTrace {
  readonly level: number;
  readonly radius: number;
  /** 기존 outcome — 호환용으로 유지합니다. */
  readonly outcome: 'paths_found' | 'no_paths' | 'no_source_chunks' | 'entity_unresolved';
  readonly pathsFound: number;
  readonly evidenceSpans: number;
  readonly blockedHubs: readonly string[];
  readonly stopReason: 'paths_found' | 'no_paths' | 'budget_exhausted' | 'all_hubs_blocked' | 'level_exhausted';
}

export interface RunTrace {
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly configHash: string;
  /** 실행 시점 config의 동결 snapshot — 재현용. */
  readonly configSnapshot: GraphConfig;
  /** `manifest.sourceFingerprint` 값(prepare.ts 산출). */
  readonly corpusFingerprint: string;
  /** 프롬프트 템플릿 sha256 + 모델 id. LLM 호출이 없어도 기록합니다. */
  readonly promptFingerprint: string;
  readonly modelId: string;
  readonly retrievalLevel?: number;
  readonly relaxationReason?: string;
  readonly attempts: readonly AttemptTrace[];
  readonly selectedPath?: GraphPath | null;
  readonly evidenceSpans: readonly EvidenceSpan[];
  readonly abstained?: boolean;
}

// ─── 검증·해시 헬퍼 (무의존, zod 결과 모양) ───

export interface ConfigIssue {
  readonly path: string;
  readonly message: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[]) {
    super(`invalid collie config:\n${issues.map((issue) => `  ${issue.path}: ${issue.message}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

const INHERIT_KEYS = ['extends', 'inherit', 'base', 'parent', 'mixin'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** 순서 무관 집합 일치(중복 불허). */
function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length && expected.every((entry) => actual.includes(entry));
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function checkDfRange(value: unknown, path: string, issues: ConfigIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'df range must be an object with min/max' });
    return;
  }
  const { min, max } = value;
  if (typeof min !== 'number' || !Number.isInteger(min) || min < 0) {
    issues.push({ path: `${path}.min`, message: 'min must be an integer >= 0' });
  }
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) {
    issues.push({ path: `${path}.max`, message: 'max must be an integer >= 0' });
  }
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    issues.push({ path, message: `range inverted: min ${min} > max ${max}` });
  }
}

function widened(previous: { min: number; max: number }, next: { min: number; max: number }): boolean {
  return next.min < previous.min || next.max > previous.max;
}

function equalDf(previous: { min: number; max: number }, next: { min: number; max: number }): boolean {
  return next.min === previous.min && next.max === previous.max;
}

/** L1→L2 명명 복합 완화: tag 하한 완화와 verified 허용이 함께 일어나는 전이. */
export const RARE_TAG_AND_VERIFIED_TRANSITION = 'rare-tag-and-verified-relation';

function removedEntries(previous: readonly string[], next: readonly string[]): boolean {
  const kept = new Set(next);
  return previous.some((entry) => !kept.has(entry));
}

/**
 * 구조 검증. 빈 배열이면 valid입니다.
 * reject 조건: 레벨 상속 키, df 역전, maxRadius 위반, 정본 집합 이탈
 * (node/edge/denylist), denylistMode 위반(L0~L3 block-expansion·L4 explicit-direct-only),
 * 그리고 아래 전이 문법에 없는 완화 조합.
 *
 * 전이 문법(좁히기는 항상 자유, 넓히기만 제한):
 * L0→L1 radius만 · L1→L2 명명 복합 `rare-tag-and-verified-relation`
 * (tagDf.min 감소와 allow false→true가 정확히 함께 — 단독·역방향 모두 reject) ·
 * L2→L3 df caps(max)만 · L3→L4 mode 전환만(radius/df/allow/denylist 값 동결).
 */
export function validateConfig(input: unknown): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (!isRecord(input)) return [{ path: '$', message: 'config must be an object' }];
  if (input['version'] !== 1) issues.push({ path: 'version', message: 'version must be 1' });

  const graph = input['graph'];
  if (!isRecord(graph)) {
    issues.push({ path: 'graph', message: 'graph must be an object' });
    return issues;
  }

  const nodeTypes = graph['canonicalNodeTypes'];
  if (!isStringArray(nodeTypes) || !sameSet(nodeTypes, CANONICAL_NODE_TYPES)) {
    issues.push({ path: 'graph.canonicalNodeTypes', message: `must be exactly {${CANONICAL_NODE_TYPES.join(', ')}}` });
  }
  const edgeTypes = graph['canonicalEdgeTypes'];
  if (!isStringArray(edgeTypes) || !sameSet(edgeTypes, CANONICAL_EDGE_TYPES)) {
    issues.push({ path: 'graph.canonicalEdgeTypes', message: `must be exactly {${CANONICAL_EDGE_TYPES.join(', ')}}` });
  }

  const aliasTerms = graph['aliasTerms'];
  if (!isRecord(aliasTerms)) {
    issues.push({ path: 'graph.aliasTerms', message: 'aliasTerms must be an object' });
  } else {
    for (const [key, aliases] of Object.entries(aliasTerms)) {
      if (!isStringArray(aliases) || aliases.length === 0) {
        issues.push({ path: `graph.aliasTerms.${key}`, message: 'aliases must be a non-empty string array' });
      }
    }
  }
  if (!isStringArray(graph['stopTerms'])) {
    issues.push({ path: 'graph.stopTerms', message: 'stopTerms must be a string array' });
  }

  if (!isPositiveInt(graph['maxPaths'])) issues.push({ path: 'graph.maxPaths', message: 'must be a positive integer' });
  if (!isPositiveInt(graph['maxCandidates'])) {
    issues.push({ path: 'graph.maxCandidates', message: 'must be a positive integer' });
  }
  if (!isPositiveInt(graph['answerEvidenceMin'])) {
    issues.push({ path: 'graph.answerEvidenceMin', message: 'must be a positive integer' });
  }
  if (
    typeof graph['maxPaths'] === 'number' &&
    typeof graph['maxCandidates'] === 'number' &&
    graph['maxCandidates'] < graph['maxPaths']
  ) {
    issues.push({ path: 'graph.maxCandidates', message: 'maxCandidates must be >= maxPaths' });
  }

  const maxRadius = graph['maxRadius'];
  if (!isPositiveInt(maxRadius)) {
    issues.push({ path: 'graph.maxRadius', message: 'must be a positive integer' });
    return issues;
  }

  const levels = graph['levels'];
  if (!Array.isArray(levels) || levels.length !== 5) {
    issues.push({ path: 'graph.levels', message: 'levels must be an array of exactly 5 (L0~L4)' });
    return issues;
  }

  const parsed: RetrievalLevelPolicy[] = [];
  levels.forEach((level, index) => {
    const path = `graph.levels[${index}]`;
    if (!isRecord(level)) {
      issues.push({ path, message: 'level must be an object' });
      return;
    }
    for (const key of INHERIT_KEYS) {
      if (key in level) issues.push({ path: `${path}.${key}`, message: 'level inheritance is forbidden: snapshot must be complete' });
    }
    if (level['level'] !== index) {
      issues.push({ path: `${path}.level`, message: `level must be ${index} in order` });
    }
    const radius = level['radius'];
    if (!isPositiveInt(radius)) {
      issues.push({ path: `${path}.radius`, message: 'radius must be a positive integer' });
    } else if (radius > (maxRadius as number)) {
      issues.push({ path: `${path}.radius`, message: `radius ${radius} exceeds maxRadius ${maxRadius as number}` });
    }
    checkDfRange(level['tagDf'], `${path}.tagDf`, issues);
    checkDfRange(level['developerDf'], `${path}.developerDf`, issues);
    checkDfRange(level['publisherDf'], `${path}.publisherDf`, issues);
    if (typeof level['allowVerifiedRelation'] !== 'boolean') {
      issues.push({ path: `${path}.allowVerifiedRelation`, message: 'must be a boolean' });
    }
    if (!isStringArray(level['denylist']) || !sameSet(level['denylist'], CANONICAL_DENYLIST)) {
      issues.push({ path: `${path}.denylist`, message: `denylist must be exactly {${CANONICAL_DENYLIST.join(', ')}}` });
    }
    const expectedMode = index === 4 ? 'explicit-direct-only' : 'block-expansion';
    if (level['denylistMode'] !== expectedMode) {
      issues.push({ path: `${path}.denylistMode`, message: `L${index} denylistMode must be ${expectedMode}` });
    }
    if (
      typeof level['radius'] === 'number' &&
      isRecord(level['tagDf']) &&
      isRecord(level['developerDf']) &&
      isRecord(level['publisherDf'])
    ) {
      parsed[index] = level as unknown as RetrievalLevelPolicy;
    }
  });

  // 전이 문법: 계획된 완화 조합만 허용합니다. 좁히기(강화)는 항상 자유입니다.
  for (let index = 1; index < parsed.length; index += 1) {
    const previous = parsed[index - 1];
    const next = parsed[index];
    if (!previous || !next) continue;
    const path = `graph.levels[${index}]`;
    const forbid = (message: string): void => {
      issues.push({ path, message });
    };
    const radiusWidened = next.radius > previous.radius;
    const tagMinWidened = next.tagDf.min < previous.tagDf.min;
    const tagMaxWidened = next.tagDf.max > previous.tagDf.max;
    const devWidened = widened(previous.developerDf, next.developerDf);
    const pubWidened = widened(previous.publisherDf, next.publisherDf);
    const allowChanged = previous.allowVerifiedRelation !== next.allowVerifiedRelation;
    const modeChanged = previous.denylistMode !== next.denylistMode;
    const denylistShrunk = removedEntries(previous.denylist, next.denylist);
    if (index === 1) {
      if (tagMinWidened || tagMaxWidened || devWidened || pubWidened) {
        forbid('L0→L1 transition allows only radius relaxation, not df');
      }
      if (allowChanged) forbid('L0→L1 transition must not change allowVerifiedRelation');
      if (modeChanged) forbid('L0→L1 transition must not change denylistMode');
      if (denylistShrunk) forbid('L0→L1 transition must not shrink denylist');
    } else if (index === 2) {
      const namedPair =
        !previous.allowVerifiedRelation && next.allowVerifiedRelation && tagMinWidened;
      if ((allowChanged || tagMinWidened) && !namedPair) {
        forbid(
          `L1→L2 transition must be the named ${RARE_TAG_AND_VERIFIED_TRANSITION}: tagDf.min decrease and allowVerifiedRelation false→true together`,
        );
      }
      if (tagMaxWidened || devWidened || pubWidened) {
        forbid(`L1→L2 transition allows only tagDf.min relaxation plus the named ${RARE_TAG_AND_VERIFIED_TRANSITION} flip`);
      }
      if (radiusWidened) forbid('L1→L2 transition must not widen radius');
      if (modeChanged) forbid('L1→L2 transition must not change denylistMode');
      if (denylistShrunk) forbid('L1→L2 transition must not shrink denylist');
    } else if (index === 3) {
      if (tagMinWidened) forbid('L2→L3 transition allows only df caps (max) relaxation, not min');
      if (radiusWidened) forbid('L2→L3 transition must not widen radius');
      if (allowChanged) forbid('L2→L3 transition must not change allowVerifiedRelation');
      if (modeChanged) forbid('L2→L3 transition must not change denylistMode');
      if (denylistShrunk) forbid('L2→L3 transition must not shrink denylist');
    } else {
      if (next.radius !== previous.radius) forbid('L3→L4 transition must not change radius');
      if (!equalDf(previous.tagDf, next.tagDf)) forbid('L3→L4 transition must not change tagDf');
      if (!equalDf(previous.developerDf, next.developerDf)) {
        forbid('L3→L4 transition must not change developerDf');
      }
      if (!equalDf(previous.publisherDf, next.publisherDf)) {
        forbid('L3→L4 transition must not change publisherDf');
      }
      if (allowChanged) forbid('L3→L4 transition must not change allowVerifiedRelation');
      if (!sameSet(previous.denylist, next.denylist)) forbid('L3→L4 transition must not change denylist');
    }
  }

  return issues;
}

export type SafeParseConfig =
  | { readonly success: true; readonly data: Config }
  | { readonly success: false; readonly issues: readonly ConfigIssue[] };

export function safeParseConfig(input: unknown): SafeParseConfig {
  const issues = validateConfig(input);
  if (issues.length > 0) return { success: false, issues };
  return { success: true, data: input as Config };
}

/** invalid이면 ConfigError를 던집니다. */
export function parseConfig(input: unknown): Config {
  const result = safeParseConfig(input);
  if (!result.success) throw new ConfigError(result.issues);
  return result.data;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** graph 섹션의 canonical sha256 — 키 순서와 무관하게 안정적입니다. */
export function configHash(config: Config): string {
  return createHash('sha256').update(stableStringify(config.graph), 'utf8').digest('hex');
}

/** RunTrace.configSnapshot용 동결 복사본. 원본 변경이 trace에 번지지 않습니다. */
export function snapshotConfig(config: Config): GraphConfig {
  const copy = structuredClone(config.graph) as GraphConfig;
  const freeze = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(freeze);
      Object.freeze(value);
      return;
    }
    if (isRecord(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  freeze(copy);
  return copy;
}

/** JSON 파일을 읽어 parse합니다. JSON 문법 오류는 ConfigError가 아니라 SyntaxError입니다. */
export async function loadConfigFile(filePath: string): Promise<Config> {
  return parseConfig(JSON.parse(await readFile(filePath, 'utf8')) as unknown);
}

/** `packages/collie/config/default.json` 경로. */
export async function loadDefaultConfig(): Promise<Config> {
  const here = dirname(fileURLToPath(import.meta.url));
  return loadConfigFile(resolve(here, '..', 'config', 'default.json'));
}
