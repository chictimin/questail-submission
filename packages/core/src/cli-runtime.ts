/**
 * QuestTail CLI runtime (library, side-effect free)
 *
 *   sniff                      Register API key & SteamID
 *   gather steam [<id>] [-o <dir>]
 *   config set/get/delete <key> [value]
 *   analyze [-o <dir>]
 *
 * Importing this module runs nothing. The sole `questail` bin lives in
 * `@questail/cli` and calls {@link runQuestailCli}. Direct execution of
 * this file is not supported — use the wrapper.
 *
 * Config stored in: ~/.config/questail/.env
 * Local .env also loaded (higher priority)
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fetchOwnedGames, fetchPlayerAchievements, fetchWishlistAppIds, resolveToSteamId, toAchievementInputs, type SteamConfig } from './connectors/steam.js';
import { normalizeSteamGame } from './normalize/index.js';
import { appendHistoryLog, buildHistoryRecords, HISTORY_FILENAME, writeGameNote, writeLibraryIndex, parseLibraryMarkdown } from './storage/index.js';
import { buildTasteProfile } from './profile/index.js';
import { analyzeLibrary, REPORT_SCHEMA_VERSION, type AnalysisReportJson, type QuantitativeStats, toReportJson } from './analyze/index.js';
import { parseReportChart, renderReportMarkdown, type ReportChart } from './analyze/report.js';
import { fetchAppMetaBatch } from './metadata/index.js';
import { fetchSteamSpyUserTags } from './connectors/steamspy.js';
import { detectLocale, t, type Locale } from './i18n.js';
import type { GameMeta, NormalizedGame } from './types.js';
import {
  QUESTAIL_LLM_API_KEY,
  QUESTAIL_LLM_BASE_URL,
  QUESTAIL_LLM_MODEL,
  getLlmOptions,
} from './config/index.js';
import {
  LLM_DEFAULT_BASE_URL,
  LLM_DEFAULT_LOCAL_BASE_URL,
  LLM_DEFAULT_LOCAL_MODEL,
  LLM_DEFAULT_MODEL,
  canCallLlm,
  isLocalhostUrl,
} from './llm/index.js';

// ─── Config Paths ────────────────────────────────────────────

const CONFIG_DIR = resolve(homedir(), '.config', 'questail');
const CONFIG_FILE = join(CONFIG_DIR, '.env');

// ─── I18n ────────────────────────────────────────────────────

let locale: Locale = 'ko';

function detectLanguage(): void {
  const fromConfig = process.env.LANGUAGE as Locale | undefined;
  if (fromConfig === 'en' || fromConfig === 'ko') {
    locale = fromConfig;
    return;
  }
  locale = detectLocale();
}

function _(key: string, ...args: string[]): string {
  return t(locale, key, ...args);
}

// ─── Env Loader ──────────────────────────────────────────────

function loadEnvFile(filepath: string): void {
  if (!existsSync(filepath)) return;
  const content = readFileSync(filepath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    const envKey = ({ 'steam-api-key': 'STEAM_API_KEY', 'steam-id': 'STEAM_ID', 'language': 'LANGUAGE' } satisfies Record<string, string>)[key] ?? key;
    if (!process.env[envKey]) {
      process.env[envKey] = val;
    }
  }
}

function initEnv(): void {
  loadEnvFile(CONFIG_FILE);
  loadEnvFile(resolve('.env'));
  detectLanguage();
}

// ─── Config File Operations ──────────────────────────────────

async function saveConfig(key: string, value: string): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  let lines: string[] = [];
  if (existsSync(CONFIG_FILE)) {
    lines = (await readFile(CONFIG_FILE, 'utf-8')).split('\n');
  }
  const entry = `${key}=${value}`;
  const idx = lines.findIndex(l => l.trim().startsWith(`${key}=`));
  if (idx !== -1) {
    lines[idx] = entry;
  } else {
    // 새 키는 항상 새 행으로 추가한다. 파일 끝 개행으로 생긴 빈 조각이 있으면
    // 그 자리에 써서 빈 줄을 남기지 않고, 아니면 맨 뒤에 추가한다.
    // (기존 마지막 설정 행을 덮어쓰던 버그 수정 — 기존 키 갱신 분기는 그대로)
    const last = lines.at(-1)?.trim() ?? '';
    if (lines.length > 0 && last === '') {
      lines[lines.length - 1] = entry;
    } else {
      lines.push(entry);
    }
  }
  await writeFile(CONFIG_FILE, lines.join('\n').trimEnd() + '\n', 'utf-8');
  process.env[key.toUpperCase().replace(/-/g, '_')] = value;
}

async function deleteConfigFromFile(key: string): Promise<boolean> {
  if (!existsSync(CONFIG_FILE)) return false;
  const lines = (await readFile(CONFIG_FILE, 'utf-8')).split('\n');
  const filtered = lines.filter(l => !l.trim().startsWith(`${key}=`));
  if (filtered.length === lines.length) return false;
  await writeFile(CONFIG_FILE, filtered.join('\n').trimEnd() + '\n', 'utf-8');
  const envKey = key.toUpperCase().replace(/-/g, '_');
  delete process.env[envKey];
  return true;
}

// ─── Helpers ─────────────────────────────────────────────────

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function maskValue(value: string): string {
  if (value.length <= 4) return value.slice(0, 1) + '*'.repeat(value.length - 1);
  const keep = Math.min(4, Math.floor(value.length / 3));
  const masked = Math.max(0, value.length - keep * 2);
  return value.slice(0, keep) + '*'.repeat(masked) + value.slice(-keep);
}

/** Resolve SteamID input to numeric 17-digit ID */
async function resolveSteamId(input: string, apiKey: string): Promise<string> {
  if (/^\d{17}$/.test(input)) return input;
  const resolved = await resolveToSteamId(input, apiKey);
  console.error(_('import_steam_id_resolved', input, resolved));
  return resolved;
}

// ─── Login ───────────────────────────────────────────────────

async function cmdSniff(argv: readonly string[]): Promise<void> {
  console.log(_('login_title'));
  process.stdout.write('\n');
  console.log(_('login_api_key_needed'));
  console.log(_('login_api_key_url'));
  process.stdout.write('\n');

  let apiKey = process.env.STEAM_API_KEY;
  if (apiKey) {
    console.log(_('login_current_key', maskValue(apiKey)));
    const reuse = await ask(_('login_ask_reuse_key'));
    if (reuse.toLowerCase().startsWith('n')) apiKey = '';
  }
  if (!apiKey) {
    const input = await ask(_('login_ask_new_key'));
    if (!input) { console.error(_('login_key_required')); process.exit(1); }
    apiKey = input;
    await saveConfig('steam-api-key', apiKey);
  }

  process.stdout.write('\n');
  console.log(_('login_id_needed'));
  console.log(_('login_id_help1'));
  console.log(_('login_id_help2'));
  process.stdout.write('\n');

  let steamId = process.env.STEAM_ID;
  if (steamId) {
    console.log(_('login_current_key', maskValue(steamId)));
    const reuse = await ask(_('login_ask_reuse_id'));
    if (reuse.toLowerCase().startsWith('n')) steamId = '';
  }
  if (!steamId) {
    const apiKeyVal = process.env.STEAM_API_KEY!;
    const input = await ask(_('login_ask_new_id'));
    if (!input) { console.error(_('login_id_required')); process.exit(1); }
    console.error(_('login_resolving'));
    try { steamId = await resolveToSteamId(input, apiKeyVal); }
    catch (e: any) { console.error(_('login_resolve_fail', e.message)); process.exit(1); }
    await saveConfig('steam-id', steamId);
  }

  await setupLlmInSniff();

  console.error(_('login_done', CONFIG_FILE));
  const run = await ask(_('login_ask_import_now'));
  if (!run.toLowerCase().startsWith('n')) await cmdGatherSteam(argv);
}

// ─── LLM Setup (sniff 3지선다 — postie sniff.ts 승격) ────────
// 기존 Steam 설정 흐름 뒤에 이어 붙는다. i18n.ts는 타 영역이라
// 이 섹션 문구만 cli.ts 내 locale 분기로 처리한다.

function llmText(ko: string, en: string): string {
  return locale === 'ko' ? ko : en;
}

async function setupLlmInSniff(): Promise<void> {
  process.stdout.write('\n');
  console.log(llmText('LLM 설정 (AI 해석용, 선택 사항)', 'LLM setup (for AI analysis, optional)'));

  const current = getLlmOptions();
  if (current.baseUrl || current.model) {
    console.log(llmText(
      `현재 설정: ${current.baseUrl ?? '(baseUrl 미설정)'} / ${current.model ?? '(모델 미설정)'}${current.apiKey ? ` / 키 ${maskValue(current.apiKey)}` : ''}`,
      `Current: ${current.baseUrl ?? '(no baseUrl)'} / ${current.model ?? '(no model)'}${current.apiKey ? ` / key ${maskValue(current.apiKey)}` : ''}`,
    ));
  }

  console.log('  1. OpenAI');
  console.log(llmText('  2. 로컬 호환 (Ollama·LM Studio)', '  2. Local OpenAI-compatible (Ollama·LM Studio)'));
  console.log(llmText('  3. 건너뛰기 (해석 없는 정량 리포트)', '  3. Skip (quantitative report without analysis)'));
  const pick = (await ask(llmText('선택 (1-3) [3]: ', 'Choice (1-3) [3]: '))).trim() || '3';

  if (pick === '1') {
    let apiKey = current.apiKey ?? '';
    if (apiKey) {
      console.log(llmText(`현재 저장된 키: ${maskValue(apiKey)}`, `Current key: ${maskValue(apiKey)}`));
      const reuse = await ask(llmText('이 키를 사용할까요? (Y/n): ', 'Use this key? (Y/n): '));
      if (reuse.toLowerCase().startsWith('n')) apiKey = '';
    }
    if (!apiKey) {
      apiKey = (await ask(llmText('OpenAI API 키를 입력하세요 (Enter=건너뛰기): ', 'Enter OpenAI API key (Enter=skip): '))).trim();
    }
    const defModel = current.model || LLM_DEFAULT_MODEL;
    const model = (await ask(llmText(`모델명 [${defModel}]: `, `Model [${defModel}]: `))).trim() || defModel;
    await saveConfig(QUESTAIL_LLM_BASE_URL, LLM_DEFAULT_BASE_URL);
    if (apiKey) await saveConfig(QUESTAIL_LLM_API_KEY, apiKey);
    await saveConfig(QUESTAIL_LLM_MODEL, model);
    console.error(llmText(
      apiKey ? 'LLM 설정 저장 완료 (OpenAI).' : '키 없이 저장했습니다. 원격 호출은 키가 필요합니다.',
      apiKey ? 'LLM settings saved (OpenAI).' : 'Saved without a key. Remote calls need a key.',
    ));
  } else if (pick === '2') {
    const localDefault = current.baseUrl && isLocalhostUrl(current.baseUrl)
      ? current.baseUrl
      : LLM_DEFAULT_LOCAL_BASE_URL;
    const baseUrl = (await ask(`Base URL [${localDefault}]: `)).trim() || localDefault;
    const keyInput = (await ask(llmText('API 키 (없으면 Enter): ', 'API key (Enter if none): '))).trim();
    const defModel = current.model || LLM_DEFAULT_LOCAL_MODEL;
    const model = (await ask(llmText(`모델명 [${defModel}]: `, `Model [${defModel}]: `))).trim() || defModel;
    await saveConfig(QUESTAIL_LLM_BASE_URL, baseUrl);
    if (keyInput) await saveConfig(QUESTAIL_LLM_API_KEY, keyInput);
    await saveConfig(QUESTAIL_LLM_MODEL, model);
    console.error(llmText('LLM 설정 저장 완료 (로컬 호환).', 'LLM settings saved (local).'));
  } else {
    console.log(llmText(
      'LLM 설정을 건너뜁니다. 해석 없는 정량 리포트로 동작합니다.',
      'Skipping LLM setup. Will run quantitative-only reports.',
    ));
  }
}

async function promptSteamId(): Promise<string> {
  console.log(_('login_id_help1'));
  console.log(_('login_id_help2'));
  const input = await ask(`\n${_('login_ask_new_id')}`);
  if (!input) { console.error(_('login_id_required')); process.exit(1); }
  console.error(_('login_resolving'));
  let steamId: string;
  try { steamId = await resolveToSteamId(input, process.env.STEAM_API_KEY!); }
  catch (e: any) { console.error(_('login_resolve_fail', e.message)); process.exit(1); }
  const save = await ask(_('login_ask_save'));
  if (!save.toLowerCase().startsWith('n')) {
    await saveConfig('steam-id', steamId);
    console.error(_('login_saved', 'steam-id'));
  }
  return steamId;
}

// ─── Config Subcommand ───────────────────────────────────────

async function cmdConfig(argv: readonly string[]): Promise<void> {
  const sub = argv[3];
  const key = argv[4];
  const value = argv[5];

  switch (sub) {
    case 'get': {
      if (!key) { console.error(_('config_get_usage')); process.exit(1); }
      const envKey = key.toUpperCase().replace(/-/g, '_');
      const v = process.env[envKey];
      if (!v) { console.error(_('config_not_set', key)); process.exit(1); }
      console.log(`${key}=${maskValue(v)}`);
      break;
    }
    case 'set': {
      if (!key || !value) { console.error(_('config_set_usage')); process.exit(1); }
      const saveValue = (key === 'steam-id' && process.env.STEAM_API_KEY)
        ? await resolveSteamId(value, process.env.STEAM_API_KEY)
        : value;
      await saveConfig(key, saveValue);
      if (key === 'language') detectLanguage();
      console.error(_('config_saved', key, CONFIG_FILE));
      break;
    }
    case 'delete': {
      if (!key) { console.error(_('config_delete_usage')); process.exit(1); }
      const removed = await deleteConfigFromFile(key);
      console.error(removed ? _('config_deleted', key) : _('config_not_set', key));
      break;
    }
    default:
      console.error(_('config_get_usage'));
      console.error(_('config_set_usage'));
      console.error(_('config_delete_usage'));
      process.exit(1);
  }
}

// ─── Import Subcommand ───────────────────────────────────────

async function getSteamConfig(argv: readonly string[]): Promise<Required<SteamConfig>> {
  const apiKey = process.env.STEAM_API_KEY;
  if (!apiKey) { console.error(_('error_api_key_missing')); process.exit(1); }

  const argSteamId = argv[4];
  if (argSteamId && !argSteamId.startsWith('-')) {
    return { apiKey, steamId: await resolveSteamId(argSteamId, apiKey) };
  }
  if (process.env.STEAM_ID) {
    return { apiKey, steamId: await resolveSteamId(process.env.STEAM_ID, apiKey) };
  }
  return { apiKey, steamId: await promptSteamId() };
}

function parseOutputFlag(argv: readonly string[]): string {
  const idx = argv.indexOf('--output');
  const idxShort = argv.indexOf('-o');
  const targetIdx = idx !== -1 ? idx : idxShort;
  if (targetIdx !== -1 && argv[targetIdx + 1]) {
    return resolve(argv[targetIdx + 1]);
  }
  return resolve('./games');
}

async function cmdGatherSteam(argv: readonly string[]): Promise<void> {
  const config = await getSteamConfig(argv);
  const outputDir = parseOutputFlag(argv);

  console.error(_('import_fetching', config.steamId));
  const data = await fetchOwnedGames(config);

  // 메타: appdetails 배치 조회 후 appid로 매핑해 normalize 세 번째 인자로 전달.
  // 쿨다운(AppMetaRateLimitedError) 포함 배치 실패 시 메타 없이 계속 — gather 전체가 죽지 않는다.
  const metaByAppId = new Map<string, GameMeta>();
  try {
    const metas = await fetchAppMetaBatch(
      data.response.games.map(g => String(g.appid)),
      {
        // gather는 수동 아카이빙이라 전수 확보 우선 — 레이트리밋 시 대기 후 재개가 기본값
        onRateLimit: 'wait',
        onProgress: (done, total, appId) => console.error(llmText(
          `메타 수집 중 ${done}/${total} (app ${appId})`,
          `Fetching metadata ${done}/${total} (app ${appId})`,
        )),
      },
    );
    for (const m of metas) metaByAppId.set(m.appId, m);
  } catch (e) {
    console.error(_('error', e instanceof Error ? e.message : String(e)));
  }

  // 태그: SteamSpy 유저 태그를 호출 측에서 주입해 meta.userTags에 붙인다.
  // appdetails 배치의 wait/retry가 끝난 뒤이므로 appdetails 정책과 간섭 없다.
  // SteamSpy 1req/sec 모듈 스로틀을 깨뜨리지 않게 순차 for 순회 — Promise.all 금지.
  // 실패는 빈 배열이라 미설정으로 둔다(다음 실행이 캐시 미스로 재시도한다).
  // userTags는 캐시 전용이라 normalize에 전달하지 않는다 — library/노트로 내려가지 않는다.
  for (const [appId, meta] of metaByAppId) {
    const tags = await fetchSteamSpyUserTags(appId);
    if (tags.length > 0) meta.userTags = tags;
  }

  // 위시리스트: appid 목록 조회 후 Set으로 매칭. 위시 없는 계정 등
  // API 실패 시 빈 채로 계속 — gather 전체가 죽지 않는다.
  const wishlistSet = new Set<string>();
  try {
    const wishlistAppIds = await fetchWishlistAppIds(config.apiKey, config.steamId);
    for (const appId of wishlistAppIds) wishlistSet.add(String(appId));
  } catch (e) {
    console.error(_('error', e instanceof Error ? e.message : String(e)));
  }

  // 업적: 게임당 1호출, 순차 조회(자연 스로틀). 비공개 프로필·미지원 게임은
  // SteamApiError를 던지므로 게임별 try/catch 후 업적 없이 normalize 폴백.
  let withAchievements = 0;
  const games: NormalizedGame[] = [];
  for (const g of data.response.games) {
    const meta = metaByAppId.get(String(g.appid));
    try {
      const res = await fetchPlayerAchievements(config, g.appid);
      withAchievements++;
      games.push(normalizeSteamGame(g, toAchievementInputs(res), meta));
    } catch {
      games.push(normalizeSteamGame(g, undefined, meta));
    }
  }
  games.forEach(g => { if (wishlistSet.has(g.id)) g.wishlisted = true; });
  games.sort((a, b) => b.playtimeMinutes - a.playtimeMinutes);

  console.error(_('import_summary', String(games.length), outputDir));
  process.stdout.write('\n');

  let count = 0;
  for (const game of games) {
    const fp = await writeGameNote(outputDir, game);
    const h = (game.playtimeMinutes / 60).toFixed(1);
    console.error(_('import_item', game.title, h, fp));
    count++;
  }

  const libraryPath = await writeLibraryIndex(outputDir, games);
  await appendHistoryLog(join(outputDir, HISTORY_FILENAME), buildHistoryRecords(games));
  console.error(llmText(
    `업적 ${withAchievements}/${games.length}개 게임에 반영 · 정본: ${libraryPath}`,
    `Achievements applied to ${withAchievements}/${games.length} games · index: ${libraryPath}`,
  ));

  console.error(_('import_done', String(count), outputDir));
}

// ─── Progress helpers ────────────────────────────────────────
// Node 내장만 사용 (의존성 추가 금지 — core는 npm 배포 대상).
// 지금은 analyze에만 배선하고, 나중에 gather의 메타 수집 진행 표시도
// 같은 헬퍼로 바꿀 예정이다. gather는 이번에 건드리지 않는다.

function formatElapsed(ms: number): string {
  return `${Math.floor(ms / 1000)}s`;
}

interface Spinner {
  /** 스피너를 멈추고 결과 한 줄을 남긴다 (경과 시간 자동 첨부) */
  stop(finalLabel: string): void;
}

/**
 * TTY면 프레임 스피너 + 경과 시간, TTY가 아니면(파이프·리다이렉트·CI)
 * 커서 제어 문자 없이 평범한 시작 한 줄만 찍는다.
 * 종료 시 스피너 줄을 지우고 결과 한 줄을 stderr에 남긴다.
 */
function startSpinner(label: string): Spinner {
  if (!process.stderr.isTTY) {
    console.error(label);
    const startedAt = Date.now();
    return {
      stop: (finalLabel: string) => {
        console.error(`${finalLabel} (${formatElapsed(Date.now() - startedAt)})`);
      },
    };
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const startedAt = Date.now();
  let i = 0;
  const timer = setInterval(() => {
    process.stderr.write(`\r${frames[i++ % frames.length]} ${label} (${formatElapsed(Date.now() - startedAt)})`);
  }, 100);
  return {
    stop: (finalLabel: string) => {
      clearInterval(timer);
      process.stderr.write('\r\x1b[K');
      console.error(`${finalLabel} (${formatElapsed(Date.now() - startedAt)})`);
    },
  };
}

// ─── Analyze Subcommand ──────────────────────────────────────

function reportTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 리포트 mermaid 계층 종류. 전역 설정 QUESTAIL_REPORT_CHART로 고른다.
 * `questail config set report-chart <none|pie|xychart>`로 바꾸면 파일에는
 * `report-chart=`로 저장되고 프로세스에는 REPORT_CHART로 올라가므로
 * 세 키를 순서대로 본다. 이상한 값은 parseReportChart가 기본값(pie)으로.
 */
function resolveReportChart(): ReportChart {
  return parseReportChart(
    process.env.QUESTAIL_REPORT_CHART ?? process.env.REPORT_CHART ?? process.env['report-chart'],
  );
}

/**
 * reports/ 안의 가장 최근 JSON을 읽는다. 시계열 비교용.
 * 파일 없음·파싱 실패·버전 불일치면 조용히 undefined — 섹션 생략이 정상 흐름이다.
 */
async function readPreviousReport(reportsDir: string): Promise<AnalysisReportJson | undefined> {
  let files: string[];
  try {
    files = (await readdir(reportsDir)).filter((f) => f.endsWith('.json')).sort().reverse();
  } catch {
    return undefined;
  }
  for (const file of files) {
    try {
      const parsed = JSON.parse(await readFile(join(reportsDir, file), 'utf-8')) as AnalysisReportJson;
      if (parsed?.schemaVersion === REPORT_SCHEMA_VERSION && parsed.stats) return parsed;
    } catch {
      // 깨진 파일은 건너뛰고 다음 후보로
    }
  }
  return undefined;
}

async function cmdAnalyze(argv: readonly string[]): Promise<void> {
  const outputDir = parseOutputFlag(argv);
  const libraryPath = join(outputDir, 'library.md');
  if (!existsSync(libraryPath)) {
    console.error(llmText(
      `library.md가 없습니다 (${libraryPath}). 먼저 \`questail gather steam\`을 실행하세요.`,
      `library.md not found (${libraryPath}). Run \`questail gather steam\` first.`,
    ));
    process.exit(1);
  }

  const library = parseLibraryMarkdown(await readFile(libraryPath, 'utf-8'));
  console.error(llmText(
    `라이브러리 읽기 완료: ${library.games.length}개 게임`,
    `Library loaded: ${library.games.length} games`,
  ));
  console.error(llmText('취향 프로필 계산 중...', 'Computing taste profile...'));
  const profile = buildTasteProfile(library);
  const llmOptions = getLlmOptions();
  const llmAvailable = canCallLlm(llmOptions);
  const chart = resolveReportChart();

  // 시계열 비교용 이전 리포트 — 없거나 깨졌으면 조용히 생략 (trend 섹션 없음)
  const reportsDir = join(outputDir, 'reports');
  const prevReport = await readPreviousReport(reportsDir);
  if (prevReport) {
    console.error(llmText(
      `이전 리포트 발견 (${prevReport.generatedAt}) — 변화 지표를 계산합니다.`,
      `Previous report found (${prevReport.generatedAt}) — computing changes.`,
    ));
  }

  let spinner: Spinner | undefined;
  if (!llmAvailable) {
    console.error(llmText(
      'LLM 설정이 없습니다. 해석 없는 정량 리포트로 생성합니다.',
      'No LLM configured. Generating a quantitative-only report.',
    ));
  } else {
    // API 키는 절대 출력하지 않는다 — 엔드포인트·모델만 표시
    const target = `${llmOptions.baseUrl ?? llmText('(미설정)', '(unset)')} / ${llmOptions.model || LLM_DEFAULT_MODEL}`;
    spinner = startSpinner(llmText(`AI 해석 요청 중 (${target})`, `Requesting AI analysis (${target})`));
  }

  const report = await analyzeLibrary(library, profile, llmOptions, locale, prevReport);
  if (spinner) {
    spinner.stop(report.summary
      ? llmText('AI 해석 완료', 'AI analysis done')
      : llmText('AI 해석 실패 — 해석 없는 정량 리포트로 생성합니다', 'AI analysis failed — generating a quantitative-only report'));
  }
  const stats: QuantitativeStats = report.stats;

  const now = new Date();
  const stamp = reportTimestamp(now);
  await mkdir(reportsDir, { recursive: true });
  const filepath = join(reportsDir, `${stamp}.md`);
  await writeFile(filepath, renderReportMarkdown(stats, report.summary, now, llmAvailable, llmText, chart, report.verify), 'utf-8');
  console.error(llmText(`리포트 저장: ${filepath}`, `Report saved: ${filepath}`));
  // JSON 사이드카 — md와 같은 타임스탬프로 짝을 맞춘다
  const sidecar: AnalysisReportJson = toReportJson(report, now, library);
  const jsonpath = join(reportsDir, `${stamp}.json`);
  await writeFile(jsonpath, JSON.stringify(sidecar, null, 2) + '\n', 'utf-8');
  console.error(llmText(`JSON 저장: ${jsonpath}`, `JSON saved: ${jsonpath}`));
}

// ─── Main ────────────────────────────────────────────────────

function printUsage(): void {
  console.error(_('usage_header'));
  console.error(_('usage_login'));
  console.error(_('usage_import'));
  console.error(llmText('  questail analyze [-o <dir>]', '  questail analyze [-o <dir>]'));
  console.error(_('usage_config_set'));
  console.error(_('usage_config_get'));
  console.error(_('usage_config_delete'));
}

/**
 * CLI 진입점. import 시점에는 아무 일도 일어나지 않는다 — 이 함수를
 * 호출해야 동작한다 (`@questail/cli`의 `questail` bin이 호출자).
 */
export function runQuestailCli(argv: readonly string[] = process.argv): void {
  initEnv();
  const cmd = argv[2];

  switch (cmd) {
    case 'sniff':
      void cmdSniff(argv).catch(e => { console.error(_('error', e.message)); process.exit(1); });
      break;
    case 'gather':
      if (argv[3] === 'steam') {
        void cmdGatherSteam(argv).catch(e => { console.error(_('error', e.message)); process.exit(1); });
      } else {
        console.error(_('usage_import'));
        process.exit(1);
      }
      break;
    case 'config':
      void cmdConfig(argv).catch(e => { console.error(_('error', e.message)); process.exit(1); });
      break;
    case 'analyze':
      void cmdAnalyze(argv).catch(e => { console.error(_('error', e.message)); process.exit(1); });
      break;
    default:
      if (cmd === '--help' || cmd === '-h' || !cmd) {
        printUsage();
      } else {
        console.error(_('unknown_cmd'));
        printUsage();
        process.exit(1);
      }
  }
}
