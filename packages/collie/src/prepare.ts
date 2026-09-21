import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MINIMUM_ABOUT_CHARACTERS = 800;
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ROOT = resolve(APP_ROOT, '../..');

interface AppDetailsCache {
  readonly v?: number;
  readonly appId?: string;
  readonly fetchedAt?: number;
  readonly raw?: { readonly en?: SteamApp; readonly ko?: SteamApp };
}

interface SteamApp {
  readonly type?: string;
  readonly name?: string;
  readonly steam_appid?: number;
  readonly developers?: readonly string[];
  readonly publishers?: readonly string[];
  readonly genres?: readonly { readonly id?: string; readonly description?: string }[];
  readonly platforms?: Record<string, boolean>;
  readonly release_date?: { readonly date?: string };
  readonly dlc?: readonly number[];
  readonly about_the_game?: string;
}

interface SteamSpyCache {
  readonly raw?: { readonly tags?: Record<string, number> };
}

export interface CorpusDocument {
  readonly appid: number;
  readonly filename: string;
  readonly title: string;
  readonly sourceUrl: string;
  /** The cache's raw.en.about_the_game, retained only as a hash/provenance boundary. */
  readonly sourceHtml: { readonly sha256: string; readonly characters: number; readonly origin: 'raw.en.about_the_game' };
  /** The Markdown body and the only text permitted as LLM relation-extraction input. */
  readonly canonicalBody: { readonly sha256: string; readonly characters: number };
}

export interface ExtractionExclusion {
  readonly appid: number;
  readonly reason: 'no_visible_text' | 'below_minimum_visible_text';
  readonly canonicalBodyCharacters: number;
}

export interface FiveNumberSummary {
  readonly min: number;
  readonly q1: number;
  readonly median: number;
  readonly q3: number;
  readonly max: number;
}

export interface CorpusManifest {
  readonly version: 1;
  readonly createdAt: string;
  readonly sourceFingerprint: string;
  readonly documentCount: number;
  readonly documents: readonly CorpusDocument[];
  /** Documents eligible for body-only LLM relation extraction; graph nodes/edges use all documents. */
  readonly extractionEligible: number;
  readonly extractionExcluded: readonly ExtractionExclusion[];
  readonly canonicalBodyCharacters: FiveNumberSummary;
}

function parseArgs(args: readonly string[]) {
  let cacheRoot: string | undefined;
  let outputRoot = resolve(PROJECT_ROOT, 'packages/collie/output/corpus');
  let demo = false;
  let validateGold = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--demo') demo = true;
    else if (arg === '--validate-gold') validateGold = true;
    else if (arg === '--cache-root') cacheRoot = args[++index];
    else if (arg === '--output-root') outputRoot = resolve(args[++index] ?? outputRoot);
    else throw new Error(`알 수 없는 옵션: ${arg}`);
  }
  return { cacheRoot, outputRoot: resolve(outputRoot), demo, validateGold };
}

async function files(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

function isoDate(value: string | undefined): string | null {
  if (!value) return null;
  const months: Record<string, string> = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const dayFirst = value.match(/^(\d{1,2})\s+([A-Za-z]{3}),?\s+(\d{4})$/);
  if (dayFirst?.[2] && months[dayFirst[2]]) return `${dayFirst[3]}-${months[dayFirst[2]]}-${dayFirst[1].padStart(2, '0')}`;
  const monthFirst = value.match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (monthFirst?.[1] && months[monthFirst[1]]) return `${monthFirst[3]}-${months[monthFirst[1]]}-${monthFirst[2].padStart(2, '0')}`;
  return null;
}

function yaml(value: unknown): string { return JSON.stringify(value); }

/**
 * title_ko 결정: raw.ko.name이 en과 다를 때만 싣는다 (코퍼스 실측 29건).
 * LLM 분류기 프롬프트에 영문 제목과 함께 주입하면 한글 질문 매칭이 좋아진다.
 */
export function selectTitleKo(enName: string | undefined, koName: string | undefined): string | undefined {
  if (!enName || !koName) return undefined;
  if (koName === enName) return undefined;
  return koName;
}

/**
 * Separates Steam's HTML provenance from the canonical visible text.  The
 * caller stores the former as a digest in frontmatter; only this result is
 * emitted as the Markdown body and may enter an LLM extraction prompt.
 */
export function canonicalBodyText(sourceHtml: string | undefined): string {
  return (sourceHtml ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_whole, value: string) => {
      const codePoint = value[0]?.toLowerCase() === 'x' ? Number.parseInt(value.slice(1), 16) : Number.parseInt(value, 10);
      return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function render(appid: number, app: SteamApp, spy: SteamSpyCache | undefined, fetchedAt: number | undefined, canonicalBody: string, koName: string | undefined): string {
  const platforms = Object.entries(app.platforms ?? {}).filter(([, enabled]) => enabled).map(([name]) => name).sort();
  const tags = spy?.raw?.tags ?? {};
  const titleKo = selectTitleKo(app.name, koName);
  const frontmatter = [
    `appid: ${appid}`,
    `title: ${yaml(app.name ?? '')}`,
    ...(titleKo === undefined ? [] : [`title_ko: ${yaml(titleKo)}`]),
    `developers: ${yaml(app.developers ?? [])}`,
    `publishers: ${yaml(app.publishers ?? [])}`,
    `genres: ${yaml((app.genres ?? []).map((genre) => ({ id: genre.id ?? '', name: genre.description ?? '' })) )}`,
    `platforms: ${yaml(platforms)}`,
    `release_date: ${yaml(isoDate(app.release_date?.date))}`,
    `tags: ${yaml(Object.keys(tags).sort())}`,
    `votes: ${yaml(tags)}`,
    `dlc: ${yaml(app.dlc ?? [])}`,
    `source_url: ${yaml(`https://store.steampowered.com/app/${appid}/`)}`,
    `fetched_at: ${yaml(fetchedAt ? new Date(fetchedAt).toISOString() : null)}`,
    `source_html_sha256: ${yaml(sha256(app.about_the_game ?? ''))}`,
    `source_html_characters: ${(app.about_the_game ?? '').length}`,
    `canonical_body_sha256: ${yaml(sha256(canonicalBody))}`,
    `canonical_body_characters: ${canonicalBody.length}`,
  ];
  return `---\n${frontmatter.join('\n')}\n---\n\n${canonicalBody}\n`;
}

async function collectCache(cacheRoot: string) {
  const locations = [
    { name: 'appdetails', appdetails: join(cacheRoot, 'appdetails'), steamspy: join(cacheRoot, 'steamspy') },
    { name: 'graph-corpus', appdetails: join(cacheRoot, 'graph-corpus/appdetails'), steamspy: join(cacheRoot, 'graph-corpus/steamspy') },
  ];
  const entries = new Map<number, { cache: AppDetailsCache; source: string; spyPath: string }>();
  const fingerprintParts: string[] = [];
  for (const location of locations) {
    for (const file of await files(location.appdetails)) {
      const path = join(location.appdetails, file);
      let cache: AppDetailsCache;
      try { cache = await readJson<AppDetailsCache>(path); } catch { continue; }
      const appid = Number(cache.appId ?? basename(file, '.json'));
      const app = cache.raw?.en;
      // v1/legacy caches have no raw.en and are not part of the v2 corpus input.
      if (!app || app.type !== 'game') continue;
      // graph-corpus의 보강분이 기존 캐시와 중복되면 기본 캐시를 우선합니다.
      if (!entries.has(appid)) entries.set(appid, { cache, source: path, spyPath: join(location.steamspy, file) });
      fingerprintParts.push(await readFile(path, 'utf8'));
    }
  }
  return { entries, fingerprintParts };
}

function fiveNumberSummary(values: readonly number[]): FiveNumberSummary {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return { min: 0, q1: 0, median: 0, q3: 0, max: 0 };
  const at = (fraction: number) => sorted[Math.floor((sorted.length - 1) * fraction)]!;
  return { min: at(0), q1: at(0.25), median: at(0.5), q3: at(0.75), max: at(1) };
}

export interface DemoGoldEntry {
  readonly id?: string;
  readonly type: string;
  readonly source: number | string;
  readonly target: number | string | null;
  readonly evidenceDocument: number;
  readonly sentence: string;
  readonly expression: string;
  readonly verdict: boolean;
  readonly grounds?: string;
  readonly noRelationReason?: string;
}

export interface DemoGoldFile {
  readonly version?: number;
  readonly canonicalTypes?: readonly string[];
  readonly entries: readonly DemoGoldEntry[];
}

/** The retired generic claim. It must not appear in any demo body nor in gold. */
export const RETIRED_AURORA_BOILERPLATE =
  'This chapter continues the fictional Aurora Cycle series, following the events of its earlier companion game.';

/**
 * Checks every gold entry against its evidence document body: the sentence
 * must be an exact substring of the body and the expression an exact
 * substring of the sentence. False entries additionally require an explicit
 * noRelationReason. Returns violation messages (empty when valid).
 */
export function validateDemoGoldEntries(
  gold: DemoGoldFile,
  bodies: ReadonlyMap<number, string>,
): string[] {
  const violations: string[] = [];
  const canonical = new Set(gold.canonicalTypes ?? ['IN_SERIES', 'SEQUEL_OF', 'SAME_UNIVERSE']);
  const seen = new Set<string>();
  let trueCount = 0;
  let falseCount = 0;
  for (const entry of gold.entries ?? []) {
    const label = entry.id ?? `${String(entry.type)}:${String(entry.source)}`;
    if (seen.has(label)) violations.push(`duplicate entry id: ${label}`);
    seen.add(label);
    if (!canonical.has(entry.type)) violations.push(`${label}: non-canonical type ${entry.type}`);
    if (entry.verdict === true) trueCount += 1;
    else if (entry.verdict === false) falseCount += 1;
    else violations.push(`${label}: verdict must be boolean`);
    const body = bodies.get(entry.evidenceDocument);
    if (body === undefined) {
      violations.push(`${label}: evidenceDocument ${entry.evidenceDocument} not found`);
      continue;
    }
    if (!entry.sentence || !body.includes(entry.sentence)) {
      violations.push(`${label}: sentence is not a substring of document ${entry.evidenceDocument}`);
    } else if (!entry.expression || !entry.sentence.includes(entry.expression)) {
      violations.push(`${label}: expression is not a substring of sentence`);
    }
    if (entry.verdict === false && !entry.noRelationReason) {
      violations.push(`${label}: false entry lacks noRelationReason`);
    }
    if (!entry.grounds) violations.push(`${label}: missing grounds`);
  }
  if (trueCount !== 12) violations.push(`expected 12 true entries, found ${trueCount}`);
  if (falseCount < 8) violations.push(`expected at least 8 false entries, found ${falseCount}`);
  return violations;
}

export async function validateDemoGold(): Promise<{ entries: number; trueEntries: number; falseEntries: number }> {
  const demoRoot = resolve(APP_ROOT, 'demo-corpus');
  const gold = await readJson<DemoGoldFile>(join(demoRoot, 'relations.gold.json'));
  const bodies = new Map<number, string>();
  for (const file of (await readdir(demoRoot)).filter((entry) => entry.endsWith('.md')).sort()) {
    const text = await readFile(join(demoRoot, file), 'utf8');
    bodies.set(Number(basename(file, '.md')), text.split('---').slice(2).join('---').trim());
  }
  if (bodies.size !== 50) throw new Error(`공개 demo corpus는 50개 문서여야 합니다. 현재 ${bodies.size}개.`);
  const retired = [...bodies.entries()]
    .filter(([, body]) => body.includes(RETIRED_AURORA_BOILERPLATE))
    .map(([appid]) => appid);
  if (retired.length > 0) {
    throw new Error(`중립화된 Aurora Cycle boilerplate가 남아 있습니다: ${retired.join(', ')}`);
  }
  const violations = validateDemoGoldEntries(gold, bodies);
  if (violations.length > 0) throw new Error(`demo gold 검증 실패:\n${violations.join('\n')}`);
  const entries = gold.entries ?? [];
  return {
    entries: entries.length,
    trueEntries: entries.filter((entry) => entry.verdict === true).length,
    falseEntries: entries.filter((entry) => entry.verdict === false).length,
  };
}

async function prepareReal(cacheRoot: string, outputRoot: string): Promise<CorpusManifest> {
  const { entries, fingerprintParts } = await collectCache(cacheRoot);
  if (entries.size === 0) throw new Error('v2 appdetails 캐시를 찾지 못했습니다. gather/recache 하거나 --demo 를 사용하세요.');
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  const documents: CorpusDocument[] = [];
  const extractionExcluded: ExtractionExclusion[] = [];
  const bodyLengths: number[] = [];
  for (const [appid, entry] of [...entries.entries()].sort(([a], [b]) => a - b)) {
    const spy = await readJson<SteamSpyCache>(entry.spyPath).catch(() => undefined);
    if (spy) fingerprintParts.push(JSON.stringify(spy));
    const app = entry.cache.raw!.en!;
    const filename = `${appid}.md`;
    const sourceHtml = app.about_the_game ?? '';
    const canonicalBody = canonicalBodyText(sourceHtml);
    bodyLengths.push(canonicalBody.length);
    if (canonicalBody.length < MINIMUM_ABOUT_CHARACTERS) {
      extractionExcluded.push({
        appid,
        reason: canonicalBody.length === 0 ? 'no_visible_text' : 'below_minimum_visible_text',
        canonicalBodyCharacters: canonicalBody.length,
      });
    }
    await writeFile(join(outputRoot, filename), render(appid, app, spy, entry.cache.fetchedAt, canonicalBody, entry.cache.raw?.ko?.name));
    documents.push({
      appid, filename, title: app.name ?? '', sourceUrl: `https://store.steampowered.com/app/${appid}/`,
      sourceHtml: { sha256: sha256(sourceHtml), characters: sourceHtml.length, origin: 'raw.en.about_the_game' },
      canonicalBody: { sha256: sha256(canonicalBody), characters: canonicalBody.length },
    });
  }
  const manifest: CorpusManifest = {
    version: 1, createdAt: new Date().toISOString(),
    sourceFingerprint: createHash('sha256').update(fingerprintParts.sort().join('\n')).digest('hex'),
    documentCount: documents.length, documents,
    extractionEligible: documents.length - extractionExcluded.length,
    extractionExcluded,
    canonicalBodyCharacters: fiveNumberSummary(bodyLengths),
  };
  await writeFile(join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function prepareDemo(outputRoot: string): Promise<CorpusManifest> {
  const demoRoot = resolve(APP_ROOT, 'demo-corpus');
  const docs = (await readdir(demoRoot)).filter((file) => file.endsWith('.md'));
  if (docs.length < 50) throw new Error('공개 demo corpus는 최소 50개 문서가 필요합니다.');
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(dirname(outputRoot), { recursive: true });
  await cp(demoRoot, outputRoot, { recursive: true });
  return readJson<CorpusManifest>(join(outputRoot, 'manifest.json'));
}

export async function prepareCorpus(args = process.argv.slice(2)): Promise<CorpusManifest> {
  // pnpm은 script 인자 앞의 `--`를 tsx에 전달한다. 직접 tsx 실행도 지원합니다.
  const options = parseArgs(args[0] === '--' ? args.slice(1) : args);
  return options.demo
    ? prepareDemo(options.outputRoot)
    : prepareReal(resolve(options.cacheRoot ?? resolve(PROJECT_ROOT, '.cache')), options.outputRoot);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const cliArgs = process.argv.slice(2);
  const entry = cliArgs[0] === '--' ? cliArgs.slice(1) : cliArgs;
  if (entry.includes('--validate-gold')) {
    validateDemoGold()
      .then((result) => console.log(`demo gold valid: ${result.entries} entries (true ${result.trueEntries}, false ${result.falseEntries})`))
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  } else {
    prepareCorpus().then((manifest) => console.log(`prepared ${manifest.documentCount} documents`)).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
