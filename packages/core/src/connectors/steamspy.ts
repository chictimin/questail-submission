/**
 * SteamSpy 커넥터 — 유저 태그 수집 (M2.5b P1b, 계약서 §5).
 *
 * 엔드포인트: https://steamspy.com/api.php?request=appdetails&appid=<id>
 * 응답의 tags 객체({태그명: 투표수})를 투표 수 내림차순 상위 10개로 잘라 반환한다.
 * 태그는 보조 신호이므로 모든 실패 경로는 throw 없이 빈 배열을 반환한다.
 *
 * 레이트리밋: 1req/sec, SteamSpy 전용 모듈 스코프 상태로 강제.
 * metadata/index.ts의 스로틀을 참고만 했고 복사하지 않았다 — 두 API의 상한이
 * 다르다(steam appdetails 1.5s vs SteamSpy 1s).
 *
 * 디스크 캐시: <프로젝트 루트>/.cache/steamspy/<appid>.json,
 * 스키마 {v, appId, fetchedAt, raw}. raw는 가공 없이 그대로 보존한다.
 * QUESTAIL_CACHE_DIR 환경변수로 루트 변경 가능.
 * SteamSpy 응답을 픽스처로 커밋하지 않는다 (D10 라이선스 위험 회피) —
 * 테스트는 deriveSteamSpyUserTags에 합성 데이터를 넣어 한다.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const STEAMSPY_BASE = 'https://steamspy.com/api.php';
const FETCH_TIMEOUT_MS = 15_000;

/** SteamSpy 상한 — 1req/sec */
const REQUEST_INTERVAL_MS = 1_000;

/** 캐시 스키마 버전. raw 보존 형식이 바뀌면 올린다 */
const STEAMSPY_CACHE_VERSION = 1;

/** 응답 tags에서 상위 몇 개를 취하는가 */
const TOP_TAG_COUNT = 10;

// ─── 스로틀 상태 (모듈 스코프 — SteamSpy 전용) ───

let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 타입 ───

export interface SteamSpyUserTag {
  tag: string;
  votes: number;
}

export interface SteamSpyCacheEntry {
  v: number;
  appId: string;
  fetchedAt: number;
  raw: unknown;
}

// ─── 디스크 캐시 ───

/**
 * 캐시 루트 결정. QUESTAIL_CACHE_DIR이 있으면 그 아래 steamspy,
 * 없으면 실행 시점 cwd 아래 .cache/steamspy.
 * (metadata의 resolveAppMetaCacheDir과 같은 방식)
 */
export function resolveSteamSpyCacheDir(): string {
  const override = process.env.QUESTAIL_CACHE_DIR?.trim();
  if (override) return join(resolve(override), 'steamspy');
  return join(resolve('.cache'), 'steamspy');
}

function cachePath(appId: string): string {
  return join(resolveSteamSpyCacheDir(), `${appId}.json`);
}

async function readCache(appId: string): Promise<unknown | undefined> {
  try {
    const text = await readFile(cachePath(appId), 'utf-8');
    const parsed = JSON.parse(text) as SteamSpyCacheEntry;
    if (parsed?.appId !== appId) return undefined;
    if (parsed.v !== STEAMSPY_CACHE_VERSION) return undefined; // 구버전 → 다시 받는다
    return parsed.raw;
  } catch {
    return undefined;
  }
}

async function writeCache(appId: string, raw: unknown): Promise<void> {
  try {
    await mkdir(resolveSteamSpyCacheDir(), { recursive: true });
    const entry: SteamSpyCacheEntry = {
      v: STEAMSPY_CACHE_VERSION,
      appId,
      fetchedAt: Date.now(),
      raw,
    };
    await writeFile(cachePath(appId), JSON.stringify(entry), 'utf-8');
  } catch {
    // 캐시 기록 실패는 치명적이지 않음 — 파생 결과는 그대로 반환
  }
}

// ─── 파생 (순수 함수 — 합성 데이터로 테스트한다, 실응답 커밋 금지) ───

/**
 * SteamSpy appdetails 응답 raw에서 유저 태그 상위 10개를 뽑는다.
 * 투표 수 내림차순, 동점이면 태그명 오름차순(코드포인트 순서, 재현성)으로 안정 정렬.
 * tags가 없거나 깨졌으면 빈 배열 — throw하지 않는다.
 */
export function deriveSteamSpyUserTags(raw: unknown): SteamSpyUserTag[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const tags = (raw as { tags?: unknown }).tags;
  if (typeof tags !== 'object' || tags === null || Array.isArray(tags)) return [];
  const entries: SteamSpyUserTag[] = [];
  for (const [tag, votes] of Object.entries(tags)) {
    if (tag.length === 0) continue;
    if (typeof votes !== 'number' || !Number.isFinite(votes)) continue;
    entries.push({ tag, votes });
  }
  entries.sort(
    (a, b) => b.votes - a.votes || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0),
  );
  return entries.slice(0, TOP_TAG_COUNT);
}

// ─── 공개 API ───

/**
 * 게임 1건의 SteamSpy 유저 태그 조회. 캐시 히트면 API 호출 없이 파생만 반환한다.
 * 호출 전 1초 간격을 강제한다. 네트워크·타임아웃·비정상 응답·파싱 실패 등
 * 모든 실패 경로는 빈 배열을 반환하고 throw하지 않는다 (태그는 보조 신호).
 */
export async function fetchSteamSpyUserTags(appId: string): Promise<SteamSpyUserTag[]> {
  try {
    if (!/^\d+$/.test(appId)) return [];

    const cached = await readCache(appId);
    if (cached !== undefined) return deriveSteamSpyUserTags(cached);

    const now = Date.now();
    const elapsed = now - lastRequestAt;
    if (elapsed < REQUEST_INTERVAL_MS) {
      await sleep(REQUEST_INTERVAL_MS - elapsed);
    }
    lastRequestAt = Date.now();

    const res = await fetch(`${STEAMSPY_BASE}?request=appdetails&appid=${appId}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return []; // 일시 오류는 캐시하지 않고 빈 배열
    const raw: unknown = await res.json();
    await writeCache(appId, raw);
    return deriveSteamSpyUserTags(raw);
  } catch {
    return []; // 네트워크·타임아웃·파싱 실패 전부 빈 배열 — throw 금지
  }
}
