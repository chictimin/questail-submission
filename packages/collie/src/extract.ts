/**
 * P3-E LLM 관계 추출 배치 CLI (eligible corpus + demo corpus).
 *
 * - 입력 텍스트는 about_the_game 가시 본문만. frontmatter는 프롬프트에 절대
 *   넣지 않는다 (문서 식별용 appid 숫자 제외).
 * - 허용 relation 3종 + 방향 규칙만. 타 타입은 폐기한다.
 *   IN_SERIES GAME→SERIES(target "SERIES:<name>") / SEQUEL_OF sequel→prequel /
 *   SAME_UNIVERSE appid 오름차순(내림차순 폐기).
 * - span 검증: sentence는 본문 exact substring, expression은 문장 substring,
 *   대상 GAME appid는 corpus 내 존재. 실패 triple 폐기.
 * - IN_SERIES는 문서별 판정으로 끝내지 않고 2-phase global gate를 둔다.
 *   schema/span 통과분은 provisional로 모아 corpus 전체에서 normalized
 *   series label 기준 distinct GAME 멤버가 2 이상일 때만 accepted로 승격,
 *   0/1 member는 reason series_member_count_lt_2로 최종 rejected.
 *   (F3 Obsidian Tide·F6 Far Meridian·F8/F9 Aurora Cycle 함정 차단용.
 *   프롬프트가 아니라 검증 단계 규칙이며 정답지를 참조하지 않는다.)
 * - 자격증명은 ~/.config/questail/.env의 QUESTAIL_LLM_*만 읽어
 *   llm.ts resolveLlmCredentials로 주입한다. argv 키 전달 없음.
 *   키·redacted 값은 로그·manifest·trace·에러에 절대 싣지 않는다.
 * - 출력은 gitignore output root에만: 문서별 extract cache + run manifest +
 *   fixed seed 판정표 + demo metrics. 모델별 결과는 분리 보존한다.
 *
 * 실행: pnpm --filter @questail/collie exec tsx src/extract.ts --corpus real|demo [--limit N] [--model NAME]
 */

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CollieLlmError,
  completeChat,
  resolveLlmCredentials,
  type LlmCredentials,
} from './llm.js';
import { normalizeLabel } from './normalization.js';

// ─── 상수 ─────────────────────────────────────────────────────

/** 프롬프트 템플릿 버전. 바꾸면 promptHash가 달라져 cache가 무효화된다. */
export const PROMPT_VERSION = 'p3e-v3';

/** 판정표 표본 seed (숫자 상수). Math.random 사용 금지, stable hash 정렬로 표본. */
export const SAMPLE_SEED = 20260921;

/** 판정표 표본 수 (accepted 부족 시 전수). */
export const SAMPLE_SIZE = 30;

export const ALLOWED_TYPES = ['IN_SERIES', 'SEQUEL_OF', 'SAME_UNIVERSE'] as const;

export type RelationType = (typeof ALLOWED_TYPES)[number];

/** IN_SERIES global gate: 승격에 필요한 distinct GAME 멤버 수. */
export const SERIES_MIN_MEMBERS = 2;

const ENV_FILE = resolve(homedir(), '.config', 'questail', '.env');

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ROOT = resolve(APP_ROOT, '../..');

// ─── 해시·기초 ────────────────────────────────────────────────

export function sha256hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ─── env 로드 (값 출력 금지 — 호출자가 키를 로그에 싣지 않는다) ──

export function loadEnvFile(filePath: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(filePath)) return env;
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

export interface ExtractCredentialsInput {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
}

export function resolveExtractCredentials(env: Record<string, string>): ExtractCredentialsInput {
  const pick = (key: string): string | undefined => {
    const value = env[key]?.trim();
    return value ? value : undefined;
  };
  return {
    apiKey: pick('QUESTAIL_LLM_API_KEY'),
    baseUrl: pick('QUESTAIL_LLM_BASE_URL'),
    model: pick('QUESTAIL_LLM_MODEL'),
  };
}

/** 로그·manifest용 안전 baseUrl (userinfo가 있어도 제거). */
export function safeBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '[invalid-url]';
  }
}

/**
 * configHash — API key 또는 키 유래값을 절대 받지 않는다.
 * 서명상 키를 넣을 자리가 없다 (baseUrl·model·허용 relation·추출 설정만).
 */
export function extractConfigHash(input: {
  readonly baseUrl: string;
  readonly model: string;
  readonly allowed: readonly RelationType[];
}): string {
  return sha256hex(
    JSON.stringify({
      v: 1,
      baseUrl: input.baseUrl,
      model: input.model,
      promptVersion: PROMPT_VERSION,
      allowedTypes: [...input.allowed],
      directionRules: 'IN_SERIES:game-to-series-global-gate-2-members/SEQUEL_OF:title-direction-kept/SAME_UNIVERSE:title-mapped-then-appid-ascending',
    }),
  );
}

// ─── corpus별 허용 relation (config 정본) ─────────────────────

const COLLIE_CONFIG_PATH = resolve(PROJECT_ROOT, 'packages/collie/config/default.json');

/**
 * config graph.extraction.<corpus>.relations를 읽어 prompt·validator 양쪽에
 * 적용한다. 섹션·코퍼스 누락 시 전종 허용(후방 호환). 미지정 타입은 throw.
 */
export async function loadExtractionPolicy(
  corpus: 'real' | 'demo',
  configPath = COLLIE_CONFIG_PATH,
): Promise<readonly RelationType[]> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
  } catch {
    return [...ALLOWED_TYPES];
  }
  const relations =
    typeof raw === 'object' && raw !== null &&
    typeof (raw as { graph?: unknown }).graph === 'object' && (raw as { graph?: unknown }).graph !== null &&
    typeof ((raw as { graph: { extraction?: unknown } }).graph.extraction) === 'object' &&
    ((raw as { graph: { extraction?: unknown } }).graph.extraction) !== null
      ? ((raw as { graph: { extraction: Record<string, { relations?: unknown }> } }).graph.extraction)[corpus]?.relations
      : undefined;
  if (relations === undefined) return [...ALLOWED_TYPES];
  if (!Array.isArray(relations)) throw new Error(`config extraction.${corpus}.relations는 문자열 배열`);
  const allowed: RelationType[] = [];
  for (const entry of relations) {
    if (entry !== 'IN_SERIES' && entry !== 'SEQUEL_OF' && entry !== 'SAME_UNIVERSE') {
      throw new Error(`config extraction.${corpus}.relations 미지정 타입: ${String(entry)}`);
    }
    if (!allowed.includes(entry)) allowed.push(entry);
  }
  return ALLOWED_TYPES.filter((type) => allowed.includes(type));
}

// ─── 프롬프트 (본문만 + 방향 판정용 당 문서 제목. appid 숫자 금지) ──
// frontmatter 숫자 appid는 프롬프트·출력 어디에도 싣지 않는다. 당 문서 제목은
// SEQUEL_OF 방향 판정에 필요 최소 식별자라 포함한다 (태그·개발사 등 여타
// 메타데이터는 넣지 않는다).

export function buildPrompt(
  sourceTitle: string,
  body: string,
  allowed: readonly RelationType[] = [...ALLOWED_TYPES],
): string {
  const allow = new Set(allowed);
  const bullets: string[] = [];
  if (allow.has('SEQUEL_OF')) {
    bullets.push('{"type":"SEQUEL_OF","target":"<exact game title>","sentence":"...","expression":"..."} — the game above is a sequel of target. Keep the stated direction: target is the game it continues/follows.');
  }
  if (allow.has('IN_SERIES')) {
    bullets.push('{"type":"IN_SERIES","target":"SERIES:<name>","sentence":"...","expression":"..."} — the game above belongs to the named series (a series name, not a game title).');
  }
  if (allow.has('SAME_UNIVERSE')) {
    bullets.push('{"type":"SAME_UNIVERSE","target":"<exact game title>","sentence":"...","expression":"..."} — the game above shares its universe with target.');
  }
  return `You extract game relations from ONE game description. Output JSON ONLY: a list (possibly empty) of triples, no other text.

The game described below is titled "${sourceTitle}". Name every OTHER game ONLY by its exact title string. Never output numeric appids.

Allowed types and direction rules:
${bullets.map((bullet) => `- ${bullet}`).join('\n')}

Rules: sentence must be copied VERBATIM from the description below (exact substring) AND must explicitly state both the relation and the target title — no inference from title similarity, numbers, or prior knowledge. expression must be an exact substring of sentence. Never invent titles or series names. Discard anything else. If nothing qualifies, output [].

The following alone are never relations, no matter how suggestive the wording:
- a studio/developer that worked on a game ("studio behind") — not a sequel and not a shared universe;
- sharing a genre, or a genre being elevated — not a relation;
- a crossover or cameo mention — not a shared universe;
- "original <genre phrase>" (for example original shooter-looter) — not a reference to a previous game;
- title words that are also common nouns — a common-noun phrase is not a title match.

DESCRIPTION:
${body}`;
}

export function promptHashOf(prompt: string): string {
  return sha256hex(`${PROMPT_VERSION}\n${prompt}`);
}

// ─── corpus title 사전 (target title→appid 결정용) ──────────

export interface TitleIndex {
  readonly exact: ReadonlyMap<string, number>;
  readonly normalized: ReadonlyMap<string, readonly number[]>;
}

/** manifest titles로 구축. exact 우선, 동률은 정규화 매표. */
export function buildTitleIndex(entries: readonly { readonly appid: number; readonly title: string }[]): TitleIndex {
  const exact = new Map<string, number>();
  const normalized = new Map<string, number[]>();
  for (const entry of entries) {
    if (!exact.has(entry.title)) exact.set(entry.title, entry.appid);
    const norm = normalizeLabel(entry.title);
    let list = normalized.get(norm);
    if (!list) normalized.set(norm, (list = []));
    if (!list.includes(entry.appid)) list.push(entry.appid);
  }
  return { exact, normalized };
}

export type TitleResolution =
  | { readonly ok: true; readonly appid: number }
  | { readonly ok: false; readonly reason: 'target_title_unresolved' };

/**
 * exact 일치 우선, 없으면 정규화 일치 단일 후보. 0건·다중 매치는 전부
 * target_title_unresolved로 폐기 (Lumen Reach 99·Far Meridian 계열 자동 폐기).
 */
export function resolveTitleTarget(index: TitleIndex, title: string): TitleResolution {
  const candidates = index.normalized.get(normalizeLabel(title)) ?? [];
  // exact 일치도 정규화 단일 후보일 때만 유효. 동명 2건 이상이면 모호성으로 폐기.
  if (candidates.length === 1) {
    const direct = index.exact.get(title);
    return { ok: true, appid: direct ?? (candidates[0] as number) };
  }
  return { ok: false, reason: 'target_title_unresolved' };
}

// ─── triple 검증 (pure) ───────────────────────────────────────

export interface RawTriple {
  readonly type?: unknown;
  readonly target?: unknown;
  readonly sentence?: unknown;
  readonly expression?: unknown;
}

export interface CanonicalTriple {
  readonly type: RelationType;
  readonly source: number;
  readonly target: number | string;
  readonly sentence: string;
  readonly expression: string;
}

export type TripleVerdict =
  | { readonly ok: true; readonly triple: CanonicalTriple }
  | { readonly ok: false; readonly reason: string };

export function validateTriple(
  raw: RawTriple,
  ctx: { readonly sourceAppid: number; readonly body: string; readonly titles: TitleIndex },
  allowed: readonly RelationType[] = [...ALLOWED_TYPES],
): TripleVerdict {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'bad-entry' };
  }
  if (raw.type !== 'IN_SERIES' && raw.type !== 'SEQUEL_OF' && raw.type !== 'SAME_UNIVERSE') {
    return { ok: false, reason: 'unknown-type' };
  }
  // corpus policy 미허용 타입은 스키마 이전에 폐기한다 (real IN_SERIES 등).
  if (!allowed.includes(raw.type)) {
    return { ok: false, reason: 'type-not-allowed' };
  }
  const sentence = typeof raw.sentence === 'string' ? raw.sentence : '';
  if (!sentence.trim() || !ctx.body.includes(sentence)) {
    return { ok: false, reason: 'sentence-not-in-body' };
  }
  const expression = typeof raw.expression === 'string' ? raw.expression : '';
  if (!expression.trim() || !sentence.includes(expression)) {
    return { ok: false, reason: 'expression-not-in-sentence' };
  }
  if (raw.type === 'IN_SERIES') {
    if (typeof raw.target !== 'string') return { ok: false, reason: 'bad-series-target' };
    const match = raw.target.match(/^SERIES:(.+)$/);
    const name = match?.[1]?.trim() ?? '';
    if (!name) return { ok: false, reason: 'bad-series-target' };
    // SERIES 대상은 schema상 series node이므로 corpus GAME 존재 검증을 적용하지
    // 않는다. corpus 멤버 수 gate는 phase 2(global)에서 처리한다.
    return { ok: true, triple: { type: raw.type, source: ctx.sourceAppid, target: `SERIES:${name}`, sentence, expression } };
  }
  // GAME 대상: 제목 문자열만 받는다 (숫자 appid 출력 금지). 사전 매핑 실패 폐기.
  if (typeof raw.target !== 'string' || !raw.target.trim()) {
    return { ok: false, reason: 'bad-target' };
  }
  const resolved = resolveTitleTarget(ctx.titles, raw.target);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  if (resolved.appid === ctx.sourceAppid) {
    return { ok: false, reason: 'bad-target' };
  }
  if (raw.type === 'SAME_UNIVERSE') {
    // 둘 다 매핑 뒤 appid 오름차순으로 재정렬한다.
    const lo = Math.min(ctx.sourceAppid, resolved.appid);
    const hi = Math.max(ctx.sourceAppid, resolved.appid);
    return { ok: true, triple: { type: raw.type, source: lo, target: hi, sentence, expression } };
  }
  // SEQUEL_OF: LLM이 낸 title 관계 방향을 그대로 title→appid로 매핑한다.
  return { ok: true, triple: { type: raw.type, source: ctx.sourceAppid, target: resolved.appid, sentence, expression } };
}

/** ```json fence를 벗기고 배열을 돌려준다. 실패하면 throw (호출자가 error 기록). */
export function parseResponseText(text: string): RawTriple[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const payload = (fenced?.[1] ?? text).trim();
  const parsed: unknown = JSON.parse(payload);
  if (!Array.isArray(parsed)) throw new CollieLlmError('LLM_BAD_SHAPE', '추출 응답이 배열이 아닙니다.');
  return parsed as RawTriple[];
}

// ─── IN_SERIES 2-phase global gate (pure) ─────────────────────

export interface ProvisionalSeries {
  readonly triple: CanonicalTriple;
}

export interface SeriesGateResult {
  readonly accepted: readonly CanonicalTriple[];
  readonly rejected: readonly {
    readonly triple: CanonicalTriple;
    readonly reason: 'series_member_count_lt_2';
    readonly memberCount: number;
  }[];
}

/**
 * provisional IN_SERIES 후보를 normalized series label 기준으로 모아
 * distinct corpus GAME 멤버가 SERIES_MIN_MEMBERS(2) 이상일 때만 승격.
 * label 비교·멤버 집계 모두 정규화 label 기준이라 결정적이다.
 */
export function applySeriesGate(provisional: readonly CanonicalTriple[]): SeriesGateResult {
  const seriesOf = (triple: CanonicalTriple): string | undefined => {
    if (triple.type !== 'IN_SERIES' || typeof triple.target !== 'string') return undefined;
    const match = triple.target.match(/^SERIES:(.+)$/);
    const name = match?.[1]?.trim() ?? '';
    return name ? normalizeLabel(name) : undefined;
  };
  const members = new Map<string, Set<number>>();
  for (const triple of provisional) {
    const label = seriesOf(triple);
    if (label === undefined) continue;
    let set = members.get(label);
    if (!set) members.set(label, (set = new Set()));
    set.add(triple.source);
  }
  const accepted: CanonicalTriple[] = [];
  const rejected: { readonly triple: CanonicalTriple; readonly reason: 'series_member_count_lt_2'; readonly memberCount: number }[] = [];
  for (const triple of provisional) {
    const label = seriesOf(triple);
    const count = label === undefined ? 0 : (members.get(label)?.size ?? 0);
    if (count >= SERIES_MIN_MEMBERS) accepted.push(triple);
    else rejected.push({ triple, reason: 'series_member_count_lt_2', memberCount: count });
  }
  return { accepted, rejected };
}

// ─── 표본 (stable hash 정렬, RNG 없음) ────────────────────────

export function stableSampleKey(seed: number, appid: number, index: number): string {
  return sha256hex(`${seed}:${appid}:${index}`);
}

export interface SampleCandidate {
  readonly appid: number;
  readonly index: number;
  readonly triple: CanonicalTriple;
}

export function orderSample(candidates: readonly SampleCandidate[], seed: number, n: number): SampleCandidate[] {
  return [...candidates]
    .sort((a, b) => {
      const ka = stableSampleKey(seed, a.appid, a.index);
      const kb = stableSampleKey(seed, b.appid, b.index);
      return ka < kb ? -1 : 1;
    })
    .slice(0, n);
}

// ─── demo gold 기계 비교 (정답지 수정 없음) ────────────────────

export interface GoldEntry {
  readonly id: string;
  readonly type: string;
  readonly source: number;
  readonly target: number | string | null;
  readonly verdict: boolean;
  readonly evidenceDocument?: number;
  readonly sentence?: string;
  readonly expression?: unknown;
}

export interface DemoMetrics {
  readonly positiveSetSize: number;
  readonly truePositives: number;
  readonly matchedIds: readonly string[];
  readonly missedIds: readonly string[];
  readonly recall: number;
  readonly negativeSetSize: number;
  readonly falsePositives: number;
  readonly falsePositiveIds: readonly string[];
  readonly falsePositiveRate: number;
}

export interface ExtendedFlag {
  readonly triple: CanonicalTriple;
  readonly goldId: string;
}

export interface ExtendedFPs {
  /** negative gold의 evidenceDocument+정확 sentence/span 근거 emit (type 무관). */
  readonly negGrounded: readonly ExtendedFlag[];
  /** positive와 relation·endpoint 쌍 동일이나 방향 뒤집힘 (recall miss + precision FP). */
  readonly flipped: readonly ExtendedFlag[];
}

/**
 * 채점 결함 수정용 기계 플래그. 관계 의미는 판정하지 않고 문자열·방향
 * 일치만 본다. precision 합산(라벨 겹침 처리)은 호출자(리포트)가 명시한다.
 */
export function flagExtendedFPs(
  accepted: readonly CanonicalTriple[],
  gold: readonly GoldEntry[],
): ExtendedFPs {
  const negGrounded: ExtendedFlag[] = [];
  const flipped: ExtendedFlag[] = [];
  const falses = gold.filter((g) => !g.verdict);
  const trues = gold.filter((g) => g.verdict);
  for (const triple of accepted) {
    for (const entry of falses) {
      if (
        entry.evidenceDocument !== undefined &&
        triple.source === entry.evidenceDocument &&
        typeof entry.sentence === 'string' &&
        entry.sentence !== '' &&
        triple.sentence === entry.sentence &&
        typeof entry.expression === 'string' &&
        entry.expression !== '' &&
        triple.expression === entry.expression
      ) {
        negGrounded.push({ triple, goldId: entry.id });
        break;
      }
    }
    for (const entry of trues) {
      if (
        typeof entry.target !== 'number' ||
        typeof triple.target !== 'number' ||
        triple.type !== entry.type ||
        triple.source !== entry.target ||
        triple.target !== entry.source
      ) {
        continue;
      }
      flipped.push({ triple, goldId: entry.id });
      break;
    }
  }
  return { negGrounded, flipped };
}

/** positive: exact type+source+target. negative: 동일 type+source emit이면 FP. */
export function computeDemoMetrics(
  accepted: readonly CanonicalTriple[],
  gold: readonly GoldEntry[],
): DemoMetrics {
  const positives = gold.filter((g) => g.verdict);
  const negatives = gold.filter((g) => !g.verdict);
  const emittedKeys = new Set(accepted.map((t) => `${t.type}::${t.source}::${t.target}`));
  const emittedPairKeys = new Set(accepted.map((t) => `${t.type}::${t.source}`));
  const matched = positives.filter((g) => emittedKeys.has(`${g.type}::${g.source}::${g.target}`));
  const missed = positives.filter((g) => !emittedKeys.has(`${g.type}::${g.source}::${g.target}`));
  const fps = negatives.filter((g) => emittedPairKeys.has(`${g.type}::${g.source}`));
  const round3 = (n: number): number => Math.round(n * 1000) / 1000;
  return {
    positiveSetSize: positives.length,
    truePositives: matched.length,
    matchedIds: matched.map((g) => g.id),
    missedIds: missed.map((g) => g.id),
    recall: positives.length === 0 ? 0 : round3(matched.length / positives.length),
    negativeSetSize: negatives.length,
    falsePositives: fps.length,
    falsePositiveIds: fps.map((g) => g.id),
    falsePositiveRate: negatives.length === 0 ? 0 : round3(fps.length / negatives.length),
  };
}

// ─── 입출력 스키마 ────────────────────────────────────────────

export interface RejectedRecord {
  readonly triple: unknown;
  readonly reason: string;
  readonly memberCount?: number;
}

export interface DocCacheRecord {
  readonly version: 1;
  readonly appid: number;
  readonly bodySha256: string;
  readonly promptHash: string;
  readonly model: string;
  readonly configHash: string;
  readonly createdAt: string;
  /** schema/span 통과 provisional (IN_SERIES 포함). global gate 입력. */
  readonly provisional: readonly CanonicalTriple[];
  readonly accepted: readonly CanonicalTriple[];
  readonly rejected: readonly RejectedRecord[];
  readonly error?: { readonly code: string; readonly message: string };
}

export interface RunManifest {
  readonly version: 1;
  readonly runId: string;
  readonly corpus: 'real' | 'demo';
  readonly corpusFingerprint: string;
  readonly promptVersion: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly configHash: string;
  /** 실행 시점 corpus policy (config graph.extraction.<corpus>.relations). */
  readonly allowedRelations: readonly string[];
  readonly seed: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly inputs: readonly { readonly appid: number; readonly filename: string; readonly bodySha256: string }[];
  readonly results: readonly {
    readonly appid: number;
    readonly cached: boolean;
    readonly accepted: number;
    readonly rejected: number;
    readonly provisionalSeries: number;
    readonly acceptedSeries: number;
    readonly rejectedSeries: number;
    readonly errorCode?: string;
  }[];
  readonly stats: {
    readonly docs: number;
    readonly calls: number;
    readonly cacheHits: number;
    readonly acceptedTotal: number;
    readonly rejectedTotal: number;
    readonly provisionalSeriesTotal: number;
    readonly acceptedSeriesTotal: number;
    readonly rejectedSeriesTotal: number;
    readonly errors: number;
    /** 전송 프롬프트 평균 문자 수 (입력 크기 proxy). */
    readonly promptInputCharsAvg: number;
    /** 전종 허용 프롬프트 대비 절감 평균 문자 수 (real IN_SERIES 제거분). */
    readonly promptInputCharsSavedVsFull: number;
  };
}

interface CorpusDoc {
  readonly appid: number;
  readonly filename: string;
  readonly body: string;
  readonly bodySha256: string;
}

function bodyOf(text: string, filename: string): string {
  const close = text.indexOf('---', 3);
  if (!text.startsWith('---') || close === -1) throw new Error(`frontmatter 없음: ${filename}`);
  return text.slice(close + 3).trim();
}

function modelSlug(model: string): string {
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'model';
}

function runTimestamp(date = new Date()): string {
  const p = (n: number, len = 2): string => String(n).padStart(len, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function parseArgs(args: readonly string[]): {
  corpus: 'real' | 'demo';
  limit?: number;
  seed: number;
  model?: string;
} {
  let corpus: 'real' | 'demo' | undefined;
  let limit: number | undefined;
  let seed = SAMPLE_SEED;
  let model: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--corpus') {
      const value = args[++i];
      if (value !== 'real' && value !== 'demo') throw new Error('--corpus는 real|demo');
      corpus = value;
    } else if (arg === '--limit') {
      limit = Number(args[++i]);
      if (!Number.isInteger(limit) || (limit as number) <= 0) throw new Error('--limit은 양의 정수');
    } else if (arg === '--seed') {
      seed = Number(args[++i]);
      if (!Number.isInteger(seed)) throw new Error('--seed는 정수');
    } else if (arg === '--model') {
      const value = args[++i]?.trim();
      if (!value) throw new Error('--model은 비어 있을 수 없음');
      model = value;
    } else {
      throw new Error(`알 수 없는 옵션: ${arg}`);
    }
  }
  if (!corpus) throw new Error('--corpus real|demo 필수');
  return { corpus, limit, seed, model };
}

async function loadCorpusDocs(
  corpusRoot: string,
  includeAppids: ReadonlySet<number> | null,
): Promise<{ docs: CorpusDoc[]; fingerprint: string }> {
  const manifest = JSON.parse(await readFile(join(corpusRoot, 'manifest.json'), 'utf8')) as {
    readonly sourceFingerprint: string;
    readonly documents: readonly { readonly appid: number; readonly filename: string }[];
  };
  const docs: CorpusDoc[] = [];
  for (const entry of [...manifest.documents].sort((a, b) => a.appid - b.appid)) {
    if (includeAppids !== null && !includeAppids.has(entry.appid)) continue;
    const text = await readFile(join(corpusRoot, entry.filename), 'utf8');
    const body = bodyOf(text, entry.filename);
    docs.push({ appid: entry.appid, filename: entry.filename, body, bodySha256: sha256hex(body) });
  }
  return { docs, fingerprint: manifest.sourceFingerprint };
}

async function main(): Promise<void> {
  const { corpus, limit, seed, model: modelOverride } = parseArgs(process.argv.slice(2));
  const corpusRoot = resolve(
    PROJECT_ROOT,
    corpus === 'real' ? 'packages/collie/output/corpus' : 'packages/collie/demo-corpus',
  );
  const outRoot = resolve(PROJECT_ROOT, 'packages/collie/output/extract', corpus);
  const docsRoot = join(outRoot, 'docs');
  const runsRoot = join(outRoot, 'runs');
  await mkdir(docsRoot, { recursive: true });
  await mkdir(runsRoot, { recursive: true });

  // eligible corpus113: manifest excluded 제외. demo는 전수.
  let include: ReadonlySet<number> | null = null;
  if (corpus === 'real') {
    const realManifest = JSON.parse(await readFile(join(corpusRoot, 'manifest.json'), 'utf8')) as {
      readonly documents: readonly { readonly appid: number }[];
      readonly extractionExcluded: readonly { readonly appid: number }[];
    };
    const excluded = new Set(realManifest.extractionExcluded.map((e) => e.appid));
    include = new Set(realManifest.documents.map((d) => d.appid).filter((a) => !excluded.has(a)));
  }
  const { docs, fingerprint } = await loadCorpusDocs(corpusRoot, include);
  const targets = limit === undefined ? docs : docs.slice(0, limit);
  const manifestForTitles = JSON.parse(await readFile(join(corpusRoot, 'manifest.json'), 'utf8')) as {
    readonly documents: readonly { readonly appid: number; readonly title: string }[];
  };
  const titles = buildTitleIndex(manifestForTitles.documents);
  const titleByAppid = new Map(manifestForTitles.documents.map((d) => [d.appid, d.title] as const));

  const envCredentials = resolveLlmCredentials(resolveExtractCredentials(loadEnvFile(ENV_FILE)));
  // --model은 모델명만 덮어쓴다 (키·URL은 env 전용). manifest·hash는 유효 모델로 분리.
  const credentials: LlmCredentials = {
    ...envCredentials,
    ...(modelOverride ? { model: modelOverride } : {}),
  };
  if (!credentials.apiKey) {
    console.error('LLM 키 없음 (~/.config/questail/.env QUESTAIL_LLM_API_KEY). 스텁 triple을 만들지 않고 중단합니다.');
    process.exit(1);
  }
  if (!credentials.model) {
    console.error('LLM 모델 미설정 (QUESTAIL_LLM_MODEL). 중단합니다.');
    process.exit(1);
  }
  const allowed = await loadExtractionPolicy(corpus);
  const configHash = extractConfigHash({
    baseUrl: credentials.baseUrl,
    model: credentials.model,
    allowed,
  });
  const startedAt = new Date().toISOString();
  const runId = `run-${corpus}-${modelSlug(credentials.model)}-${runTimestamp()}`;

  let calls = 0;
  let cacheHits = 0;
  let promptCharsSum = 0;
  let promptCharsSavedSum = 0;
  const hitDocs = new Set<number>();
  const provisionalsByDoc = new Map<number, CanonicalTriple[]>();
  const immediateRejected = new Map<number, RejectedRecord[]>();
  const errorByDoc = new Map<number, { code: string; message: string }>();
  const promptHashByDoc = new Map<number, string>();

  for (const doc of targets) {
    const prompt = buildPrompt(titleByAppid.get(doc.appid) ?? '', doc.body, allowed);
    const promptHash = promptHashOf(prompt);
    promptHashByDoc.set(doc.appid, promptHash);
    promptCharsSum += prompt.length;
    promptCharsSavedSum += buildPrompt(titleByAppid.get(doc.appid) ?? '', doc.body).length - prompt.length;
    const cachePath = join(docsRoot, `${doc.appid}.json`);
    let cached: DocCacheRecord | undefined;
    try {
      const raw = JSON.parse(await readFile(cachePath, 'utf8')) as DocCacheRecord;
      if (
        raw.version === 1 &&
        raw.bodySha256 === doc.bodySha256 &&
        raw.promptHash === promptHash &&
        raw.model === credentials.model &&
        raw.configHash === configHash &&
        !raw.error &&
        Array.isArray(raw.provisional)
      ) {
        cached = raw;
      }
    } catch {
      cached = undefined;
    }
    if (cached) {
      cacheHits += 1;
      hitDocs.add(doc.appid);
      provisionalsByDoc.set(doc.appid, [...cached.provisional]);
      immediateRejected.set(doc.appid, [...cached.rejected.filter((r) => r.reason !== 'series_member_count_lt_2')]);
      continue;
    }
    calls += 1;
    const provisional: CanonicalTriple[] = [];
    const rejected: RejectedRecord[] = [];
    try {
      const response = await completeChat(
        credentials,
        [{ role: 'user', content: prompt }],
        { maxTokens: 1024 },
      );
        for (const rawTriple of parseResponseText(response)) {
          const verdict = validateTriple(
            rawTriple,
            {
              sourceAppid: doc.appid,
              body: doc.body,
              titles,
            },
            allowed,
          );
        if (verdict.ok) provisional.push(verdict.triple);
        else rejected.push({ triple: rawTriple, reason: verdict.reason });
      }
    } catch (error: unknown) {
      const code = error instanceof CollieLlmError ? error.code : 'EXTRACT_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      errorByDoc.set(doc.appid, { code, message });
    }
    provisionalsByDoc.set(doc.appid, provisional);
    immediateRejected.set(doc.appid, rejected);
  }

  // phase 2: corpus 전체 provisional IN_SERIES를 모아 global gate.
  const allProvisionalSeries: CanonicalTriple[] = [];
  for (const doc of targets) {
    for (const triple of provisionalsByDoc.get(doc.appid) ?? []) {
      if (triple.type === 'IN_SERIES') allProvisionalSeries.push(triple);
    }
  }
  const gate = applySeriesGate(allProvisionalSeries);
  const promoted = new Set<string>(gate.accepted.map((t) => `${t.source}::${t.target}::${t.sentence}`));
  const demoted = new Map<string, { readonly triple: CanonicalTriple; readonly memberCount: number }>(
    gate.rejected.map((r) => [`${r.triple.source}::${r.triple.target}::${r.triple.sentence}`, r] as const),
  );

  const results: {
    appid: number;
    cached: boolean;
    accepted: number;
    rejected: number;
    provisionalSeries: number;
    acceptedSeries: number;
    rejectedSeries: number;
    errorCode?: string;
  }[] = [];
  const pool: SampleCandidate[] = [];
  for (const doc of targets) {
    const promptHash = promptHashByDoc.get(doc.appid) as string;
    const immediate = immediateRejected.get(doc.appid) ?? [];
    const accepted: CanonicalTriple[] = [];
    const rejected: RejectedRecord[] = [...immediate];
    let provisionalSeries = 0;
    let acceptedSeries = 0;
    let rejectedSeries = 0;
    for (const triple of provisionalsByDoc.get(doc.appid) ?? []) {
      if (triple.type !== 'IN_SERIES') {
        accepted.push(triple);
        continue;
      }
      provisionalSeries += 1;
      const key = `${triple.source}::${triple.target}::${triple.sentence}`;
      if (promoted.has(key)) {
        accepted.push(triple);
        acceptedSeries += 1;
      } else {
        const info = demoted.get(key);
        rejected.push({
          triple,
          reason: 'series_member_count_lt_2',
          memberCount: info?.memberCount ?? 0,
        });
        rejectedSeries += 1;
      }
    }
    const error = errorByDoc.get(doc.appid);
    const record: DocCacheRecord = {
      version: 1,
      appid: doc.appid,
      bodySha256: doc.bodySha256,
      promptHash,
      model: credentials.model,
      configHash,
      createdAt: new Date().toISOString(),
      provisional: provisionalsByDoc.get(doc.appid) ?? [],
      accepted,
      rejected,
      ...(error ? { error } : {}),
    };
    await writeFile(join(docsRoot, `${doc.appid}.json`), `${JSON.stringify(record, null, 2)}\n`);
    results.push({
      appid: doc.appid,
      cached: hitDocs.has(doc.appid),
      accepted: accepted.length,
      rejected: rejected.length,
      provisionalSeries,
      acceptedSeries,
      rejectedSeries,
      ...(error ? { errorCode: error.code } : {}),
    });
    accepted.forEach((triple) => {
      pool.push({
        appid: doc.appid,
        index: pool.filter((p) => p.appid === doc.appid).length,
        triple,
      });
    });
  }

  const stats: RunManifest['stats'] = {
    docs: targets.length,
    calls,
    cacheHits,
    acceptedTotal: results.reduce((n, r) => n + r.accepted, 0),
    rejectedTotal: results.reduce((n, r) => n + r.rejected, 0),
    provisionalSeriesTotal: results.reduce((n, r) => n + r.provisionalSeries, 0),
    acceptedSeriesTotal: results.reduce((n, r) => n + r.acceptedSeries, 0),
    rejectedSeriesTotal: results.reduce((n, r) => n + r.rejectedSeries, 0),
    errors: results.filter((r) => r.errorCode !== undefined).length,
    promptInputCharsAvg: targets.length === 0 ? 0 : Math.round(promptCharsSum / targets.length),
    promptInputCharsSavedVsFull: targets.length === 0 ? 0 : Math.round(promptCharsSavedSum / targets.length),
  };
  const completedAt = new Date().toISOString();
  const manifest: RunManifest = {
    version: 1,
    runId,
    corpus,
    corpusFingerprint: fingerprint,
    promptVersion: PROMPT_VERSION,
    model: credentials.model,
    baseUrl: safeBaseUrl(credentials.baseUrl),
    configHash,
    allowedRelations: [...allowed],
    seed,
    startedAt,
    completedAt,
    inputs: targets.map((d) => ({ appid: d.appid, filename: d.filename, bodySha256: d.bodySha256 })),
    results,
    stats,
  };
  await writeFile(join(runsRoot, `${runId}.json`), `${JSON.stringify(manifest, null, 2)}\n`);

  const sample = orderSample(pool, seed, SAMPLE_SIZE);
  const sampleLines = [
    `# P3-E 판정표 (${corpus}, seed ${seed})`,
    '',
    `run: ${runId} / model: ${credentials.model} / accepted ${stats.acceptedTotal} 중 ${sample.length}건 (판정칸은 비워 둔다).`,
    '',
    '| # | 문서 | 문장 | 제안 triple | 판정 |',
    '|---|---|---|---|---|',
    ...sample.map((entry, i) =>
      `| ${i + 1} | ${entry.appid} | ${oneLine(entry.triple.sentence)} | ${entry.triple.type} ${entry.triple.source}→${entry.triple.target} / ${oneLine(entry.triple.expression)} |  |`,
    ),
    '',
  ];
  await writeFile(join(outRoot, `sample-${corpus}-seed${seed}.md`), sampleLines.join('\n'));

  if (corpus === 'demo') {
    const gold = JSON.parse(await readFile(join(corpusRoot, 'relations.gold.json'), 'utf8')) as {
      readonly entries: readonly GoldEntry[];
    };
    const acceptedAll: CanonicalTriple[] = [];
    for (const doc of targets) {
      const record = JSON.parse(await readFile(join(docsRoot, `${doc.appid}.json`), 'utf8')) as DocCacheRecord;
      acceptedAll.push(...record.accepted);
    }
    const metrics = computeDemoMetrics(acceptedAll, gold.entries);
    await writeFile(join(outRoot, `metrics-demo.json`), `${JSON.stringify({ runId, ...metrics }, null, 2)}\n`);
    console.log(`demo metrics: recall ${metrics.recall} (${metrics.truePositives}/12) FPR ${metrics.falsePositiveRate} (${metrics.falsePositives}/9)`);
  }

  console.log(
    `extract done: corpus=${corpus} docs=${stats.docs} calls=${calls} cacheHits=${cacheHits} accepted=${stats.acceptedTotal} rejected=${stats.rejectedTotal} series=${stats.provisionalSeriesTotal}/${stats.acceptedSeriesTotal}/${stats.rejectedSeriesTotal} errors=${stats.errors}`,
  );
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
