/**
 * 게임 메타 조회 — Steam appdetails 승격 (postie src/collect/steam.ts).
 *
 * 레이트리밋 정책 (hcom 리서치 실측 반영):
 * - appdetails는 비공식 API. 약 200req/5min 상한, 220번째 부근 429,
 *   계속 밀면 403으로 악화, 이후 5분 대기 필요.
 * - Promise.all 전량 병렬 호출 금지. fetchAppMeta 자체가 요청 간격
 *   1.5초를 강제하므로 호출 측은 단순 for 순회만 하면 된다
 *   (118건 ≈ 3분). fetchAppMetaBatch가 그 순회 본보기다.
 * - HTTP 429/403 또는 연속 success:false(기본 5회)가 뜨면 5분 쿨다운에
 *   들어가고 AppMetaRateLimitedError를 던진다. 배치 호출자는 대기 후
 *   같은 appId부터 재개하면 된다.
 *
 * 디스크 캐시: <프로젝트 루트>/.cache/appdetails/<appid>.json (스키마 v2).
 * v2는 appdetails 원문(raw en+ko)을 그대로 보존하고, 호출자에게는
 * deriveGameMeta로 파생한 GameMeta를 반환한다. 파생 규칙이 바뀌면
 * 재수집 없이 캐시 raw에서 다시 파생할 수 있다.
 * packages/core 안에 두지 않는다 — 캐시는 라이브러리 코드가 아니라
 * 실행 시점 프로젝트의 런타임 데이터이기 때문이다.
 * QUESTAIL_CACHE_DIR 환경변수로 루트 변경 가능 (기본값: process.cwd()).
 *
 * postie와의 차이:
 * - postie metaCache는 프로세스 메모리라 매 실행마다 소멸 → 디스크 캐시로 변경.
 * - postie는 모든 실패 경로를 캐시 → 여기서는 확정 실패(success:false,
 *   해당 appId가 스토어에 없음)만 캐시하고, 일시 오류(네트워크·5xx)는
 *   캐시하지 않고 폴백만 반환한다. 디스크 캐시는 실행을 넘어 살아남으므로
 *   일시 오류까지 굳히면 다음 실행도 오염되기 때문이다.
 * - postie가 버리던 developers·publishers·release_date·header_image 추가 파싱.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { GameMeta } from '../types.js';

const APPDETAILS_BASE = 'https://store.steampowered.com/api/appdetails';
const FETCH_TIMEOUT_MS = 15_000;

/** 요청 간격 1.5초 — 118건 전수 ≈ 3분, 200req/5min 상한 안쪽 */
const REQUEST_INTERVAL_MS = 1_500;
/** 429·403·연속 success:false 시 쿨다운 5분 */
const COOLDOWN_MS = 5 * 60 * 1_000;
/** success:false가 이 횟수 연속이면 레이트리밋으로 간주하고 쿨다운 */
const SOFT_FAIL_THRESHOLD = 5;

// ─── 레이트리밋 상태 (모듈 스코프 — 프로세스 내 전역으로 간격 보장) ──

let lastRequestAt = 0;
let cooldownUntil = 0;
let consecutiveSoftFail = 0;

/** 쿨다운 진입 중 — retryAfterMs 뒤 같은 appId부터 재개하면 된다 */
export class AppMetaRateLimitedError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Steam appdetails rate limit. ${Math.ceil(retryAfterMs / 1000)}초 후 재개하세요.`);
    this.name = 'AppMetaRateLimitedError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── 디스크 캐시 ─────────────────────────────────────────────

/**
 * 캐시 루트 결정. QUESTAIL_CACHE_DIR이 있으면 그 아래 appdetails,
 * 없으면 실행 시점 cwd(= questail 프로젝트 루트) 아래 .cache/appdetails.
 */
export function resolveAppMetaCacheDir(): string {
  const override = process.env.QUESTAIL_CACHE_DIR?.trim();
  if (override) return join(resolve(override), 'appdetails');
  return join(resolve('.cache'), 'appdetails');
}

function cachePath(appId: string): string {
  return join(resolveAppMetaCacheDir(), `${appId}.json`);
}

/**
 * 캐시 스키마 버전. v2부터 파싱된 GameMeta가 아니라 appdetails 원문
 * (raw en+ko)을 보존한다. 버전을 올리면 예전 포맷 캐시가 전부
 * 스테일로 처리되므로 파일을 지우는 코드를 따로 쓰지 않는다.
 * v·fetchedAt·notFound·raw는 디스크에만 있고 GameMeta 타입에는 속하지 않는다.
 */
const META_CACHE_VERSION = 2;

/** 디스크 캐시 1건 (v2). raw는 appdetails data 원문 그대로 — 가공 금지. */
interface AppMetaCacheV2 {
  v: number;
  appId: string;
  fetchedAt: number;
  /** success:false 확정 실패면 true, raw는 둘 다 null */
  notFound: boolean;
  raw: { en: unknown; ko: unknown };
}

async function readCache(appId: string): Promise<GameMeta | undefined> {
  try {
    const rawText = await readFile(cachePath(appId), 'utf-8');
    const parsed = JSON.parse(rawText) as Partial<AppMetaCacheV2>;
    if (parsed?.appId !== appId) return undefined;
    if (parsed.v !== META_CACHE_VERSION) return undefined; // 구버전 → 다시 받는다
    if (parsed.notFound) return fallbackMeta(appId);
    const r = parsed.raw as { en?: unknown; ko?: unknown } | undefined;
    const en = (r?.en ?? null) as AppDetailsData | null;
    const ko = (r?.ko ?? null) as AppDetailsData | null;
    return deriveGameMeta({ en, ko }, appId);
  } catch {
    return undefined;
  }
}

async function writeCache(entry: AppMetaCacheV2): Promise<void> {
  try {
    await mkdir(resolveAppMetaCacheDir(), { recursive: true });
    await writeFile(cachePath(entry.appId), JSON.stringify(entry), 'utf-8');
  } catch {
    // 캐시 기록 실패는 치명적이지 않음 — API 결과는 그대로 반환
  }
}

// ─── appdetails 파싱 ─────────────────────────────────────────

/** appdetails data 원문. 캐시 raw에 그대로 보존되는 대상이다. */
export interface AppDetailsData {
  name?: string;
  platforms?: { windows?: boolean; mac?: boolean; linux?: boolean };
  genres?: Array<{ id?: string | number; description?: string }>;
  categories?: Array<{ id?: string | number; description?: string }>;
  developers?: string[];
  publishers?: string[];
  release_date?: { coming_soon?: boolean; date?: string };
  header_image?: string;
}

interface AppDetailsRaw {
  success: boolean;
  data?: AppDetailsData;
}

type AppDetailsEnvelope = Record<string, AppDetailsRaw | undefined>;

/**
 * 장르가 아닌 Steam 분류 제외 목록 — 언어와 무관한 숫자 id 기준.
 * description 문자열로 거르면 로케일마다 달라지므로(en 정본 + ko 별도 호출)
 * 반드시 id로 판정한다. id가 없으면(구 API 응답 등) 걸러내지 않는다.
 *
 * 실측 기록 (appdetails raw 응답에서 직접 확인):
 *   70 = Early Access (앞서 해보기) — Project Zomboid 108600 등
 *   37 = Free to Play (무료 플레이) — Destiny 2 1085660, Unturned 304930
 *   57 = Utilities (유틸리티) — 3DMark 223850
 * 남긴 것: Massively Multiplayer(대규모 멀티플레이어)는 정당한 장르라 제외 안 함.
 *
 * 의도적으로 안 넣은 것:
 * - 콘텐츠 표시(Violent·Gore·Nudity 등)는 genres[]가 아니라 응답의
 *   content_descriptors에 들어 있어서 파서가 읽지 않는다. 걸러낼 게 없다.
 * - Demo·소프트웨어 카테고리 id는 라이브러리에 해당 게임이 없어 실측
 *   불가라 넣지 않았다. id 추측 금지 — 추가하려면 appdetails raw에서
 *   id를 확인한 뒤 여기에 한 줄씩 추가해라.
 */
const EXCLUDED_GENRE_IDS = new Set<string>([
  '70', // Early Access
  '37', // Free to Play
  '57', // Utilities
]);

function fallbackMeta(appId: string): GameMeta {
  return { appId, genres: [] };
}

/** 영어 월명(풀네임) → 월 번호. 미국식 "February 24, 2022"의 ISO 변환용. */
const EN_MONTH_NUMBERS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
};

/**
 * 영어 월 약어 → 월 번호. 영국식 "26 Feb, 2016"의 ISO 변환용.
 * P2 실측 116건에서 출현한 12종 표준 약어만 둔다. 실측 없는 표기는 넣지 않는다.
 */
const EN_MONTH_ABBR_NUMBERS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04',
  may: '05', jun: '06', jul: '07', aug: '08',
  sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * en 응답 날짜 문자열 → ISO(YYYY-MM-DD). 실측된 두 형식만 변환한다:
 * 미국식 "<월명> D, YYYY"와 영국식 "D <월 약어>, YYYY".
 * 빈 문자열·월만 있거나 "Coming soon" 같은 값은 undefined를 반환하고
 * 호출 측이 releaseDate를 비운 채 releaseDateRaw만 채운다.
 */
function toIsoDate(enDate?: string): string | undefined {
  if (!enDate) return undefined;
  const us = /^\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s*$/.exec(enDate);
  if (us) {
    // 풀네임 우선, 실측된 약어("Jul 7, 2017")도 받는다. 둘 다 실측 범위 안이다.
    const mon = EN_MONTH_NUMBERS[us[1].toLowerCase()] ?? EN_MONTH_ABBR_NUMBERS[us[1].toLowerCase()];
    if (!mon) return undefined;
    const day = Number(us[2]);
    if (day < 1 || day > 31) return undefined;
    return `${us[3]}-${mon}-${String(day).padStart(2, '0')}`;
  }
  const uk = /^\s*(\d{1,2})\s+([A-Za-z]+),\s*(\d{4})\s*$/.exec(enDate);
  if (uk) {
    const mon = EN_MONTH_ABBR_NUMBERS[uk[2].toLowerCase()];
    if (!mon) return undefined;
    const day = Number(uk[1]);
    if (day < 1 || day > 31) return undefined;
    return `${uk[3]}-${mon}-${String(day).padStart(2, '0')}`;
  }
  return undefined;
}

/**
 * categories 3축 사전 (D11, P2 실측 확정). 판정은 반드시 id 기준 —
 * description 문자열로 거르면 안 된다(55/56·57/58이 바이트 동일 description을 쓴다).
 * 축에 속하지 않는 관측 id는 파생에서 버리고 raw에만 남긴다.
 */
const PLAY_MODE_IDS = new Set<string>([
  '1', '2', '9', '20', '24', '27', '36', '37', '38', '39', '44', '47', '48', '49',
]);

const INPUT_IDS = new Set<string>([
  '18', '28', '31', '52', '53', '55', '56', '57', '58', '59', '60', '75', '76', '77',
]);

const DEVICE_IDS = new Set<string>(['23', '41', '42', '43', '61']);

/**
 * 축 id 집합에 속한 categories의 영어 description을 순서대로 모은다.
 * 동일 description이 한 게임에 함께 있으면(55/56, 57/58) 중복 제거한다.
 * description이 없는 항목은 파생할 문자열이 없으므로 버린다.
 */
function axisValues(
  categories: AppDetailsData['categories'],
  ids: Set<string>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of categories ?? []) {
    if (c.id === undefined || !ids.has(String(c.id))) continue;
    const name = c.description ?? '';
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * 캐시 raw(en+ko 원문) → GameMeta 파생. 재수집 없이 파생만 다시
 * 돌릴 수 있도록 fetchAppMeta와 분리되어 있다.
 * categoryAxes는 P2 축 사전으로 채운다. en이 없으면 폴백이라 축도 없다.
 */
export function deriveGameMeta(
  raw: { en: AppDetailsData | null; ko: AppDetailsData | null },
  appId: string,
): GameMeta {
  const en = raw.en;
  if (!en) return fallbackMeta(appId);

  const genres = (en.genres ?? [])
    .filter(g => g.id === undefined || !EXCLUDED_GENRE_IDS.has(String(g.id)))
    .map(g => ({
      id: g.id !== undefined ? String(g.id) : '',
      name: g.description ?? '',
    }))
    .filter(g => g.name.length > 0);

  // ko 응답 name에 한글이 실제로 있을 때만 nameKo를 채운다.
  // Steam이 번역을 빠뜨려 영어를 그대로 주는 경우가 많다.
  const koName = raw.ko?.name;
  const nameKo = koName && /[가-힣]/.test(koName) ? koName : undefined;

  const releaseDateRaw = en.release_date?.date;
  const releaseDate = toIsoDate(releaseDateRaw);

  const meta: GameMeta = {
    appId,
    name: en.name,
    platforms: (['windows', 'mac', 'linux'] as const).filter(p => en.platforms?.[p] === true),
    genres,
    developers: (en.developers ?? []).filter(s => s.length > 0),
    publishers: (en.publishers ?? []).filter(s => s.length > 0),
    headerImage: en.header_image,
    categoryAxes: {
      playMode: axisValues(en.categories, PLAY_MODE_IDS),
      input: axisValues(en.categories, INPUT_IDS),
      device: axisValues(en.categories, DEVICE_IDS),
    },
  };
  if (nameKo !== undefined) meta.nameKo = nameKo;
  if (releaseDate !== undefined) meta.releaseDate = releaseDate;
  if (releaseDateRaw !== undefined) meta.releaseDateRaw = releaseDateRaw;
  return meta;
}

// ─── 공개 API (시그니처 고정 — fetchAppMeta(appId: string)) ──

/**
 * 쿨다운 확인 → 1.5초 간격 강제 → fetch 1회.
 * 쿨다운 중이면 AppMetaRateLimitedError를 던진다.
 */
async function throttledFetch(url: string): Promise<Response> {
  const now = Date.now();
  if (now < cooldownUntil) {
    throw new AppMetaRateLimitedError(cooldownUntil - now);
  }

  const elapsed = now - lastRequestAt;
  if (elapsed < REQUEST_INTERVAL_MS) {
    await sleep(REQUEST_INTERVAL_MS - elapsed);
  }
  lastRequestAt = Date.now();

  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

function enterCooldown(): void {
  cooldownUntil = Date.now() + COOLDOWN_MS;
}

/**
 * 게임 1건의 메타 조회. 캐시 히트면 API 호출 없이 raw에서 파생해 반환한다.
 * en → ko 순으로 호출한다. en이 실패하면 ko를 호출하지 않는다.
 * ko 호출만 실패하면 정상 취급한다(raw.ko = null, nameKo 미설정).
 * 시그니처와 반환 타입(Promise<GameMeta>)은 바꾸지 않는다.
 */
export async function fetchAppMeta(appId: string): Promise<GameMeta> {
  if (!/^\d+$/.test(appId)) {
    throw new Error(`유효하지 않은 appId: ${appId}`);
  }

  const cached = await readCache(appId);
  if (cached) return cached;

  // ── en (정본) ──
  let enRes: Response;
  try {
    enRes = await throttledFetch(`${APPDETAILS_BASE}?appids=${appId}&l=english`);
  } catch (e) {
    if (e instanceof AppMetaRateLimitedError) throw e;
    return fallbackMeta(appId); // 네트워크·타임아웃: 캐시 없이 폴백
  }

  if (enRes.status === 429 || enRes.status === 403) {
    enterCooldown();
    throw new AppMetaRateLimitedError(COOLDOWN_MS);
  }
  if (!enRes.ok) {
    return fallbackMeta(appId); // 5xx 등 일시 오류: 캐시 없이 폴백
  }

  let envelope: AppDetailsEnvelope;
  try {
    envelope = (await enRes.json()) as AppDetailsEnvelope;
  } catch {
    return fallbackMeta(appId);
  }

  const entry = envelope[appId];
  if (!entry?.success || !entry.data) {
    consecutiveSoftFail += 1;
    // 확정 실패(미출시·삭제·비공개 app)는 캐시 — ko는 호출하지 않는다
    await writeCache({ v: META_CACHE_VERSION, appId, fetchedAt: Date.now(), notFound: true, raw: { en: null, ko: null } });
    if (consecutiveSoftFail >= SOFT_FAIL_THRESHOLD) {
      consecutiveSoftFail = 0;
      enterCooldown();
      // 다음 호출부터 AppMetaRateLimitedError — 배치는 대기 후 재개
    }
    return fallbackMeta(appId);
  }

  consecutiveSoftFail = 0;
  const rawEn: AppDetailsData = entry.data;

  // ── ko (nameKo 복원용 선택 정보) ──
  let rawKo: AppDetailsData | null = null;
  try {
    const koRes = await throttledFetch(`${APPDETAILS_BASE}?appids=${appId}&l=korean`);
    if (koRes.status === 429 || koRes.status === 403) {
      enterCooldown(); // 이번 호출은 정상 취급, 다음 호출부터 쿨다운 적용
    } else if (koRes.ok) {
      try {
        const koEnvelope = (await koRes.json()) as AppDetailsEnvelope;
        const koEntry = koEnvelope[appId];
        if (koEntry?.success && koEntry.data) rawKo = koEntry.data;
      } catch {
        // ko 파싱 실패 → null로 정상 취급
      }
    }
  } catch {
    // ko 네트워크 실패·쿨다운 → null로 정상 취급
  }

  await writeCache({ v: META_CACHE_VERSION, appId, fetchedAt: Date.now(), notFound: false, raw: { en: rawEn, ko: rawKo } });
  return deriveGameMeta({ en: rawEn, ko: rawKo }, appId);
}

/**
 * fetchAppMetaBatch 호출 옵션.
 */
export interface FetchAppMetaBatchOptions {
  onProgress?: (done: number, total: number, appId: string) => void;
  /**
   * 레이트리밋(429/403 또는 연속 소프트실패) 시 동작.
   * 'wait' — 쿨다운만큼 기다렸다 같은 appId부터 재개. 전수 확보 우선 (기본값)
   * 'stop' — 즉시 중단하고 그때까지 모은 결과만 반환. 지연 회피 우선
   */
  onRateLimit?: 'wait' | 'stop';
}

/**
 * 전수 조회용 순차 배치. Promise.all을 쓰지 않는다 — 1건씩 for 순회하며
 * fetchAppMeta 내부 스로틀이 간격을 보장한다. 쿨다운 에러가 나면
 * onRateLimit에 따라 대기 후 같은 appId부터 재개('wait', 기본값)하거나
 * 그때까지 모은 결과만 반환하고 끝낸다('stop' — throw하지 않는다).
 */
export async function fetchAppMetaBatch(
  appIds: string[],
  options?: FetchAppMetaBatchOptions,
): Promise<GameMeta[]> {
  const onRateLimit = options?.onRateLimit ?? 'wait';
  const out: GameMeta[] = [];
  for (let i = 0; i < appIds.length; i++) {
    const id = appIds[i];
    try {
      out.push(await fetchAppMeta(id));
    } catch (e) {
      if (e instanceof AppMetaRateLimitedError) {
        if (onRateLimit === 'stop') break;
        await sleep(e.retryAfterMs);
        out.push(await fetchAppMeta(id)); // 같은 appId부터 재개
      } else {
        throw e;
      }
    }
    options?.onProgress?.(i + 1, appIds.length, id);
  }
  return out;
}
