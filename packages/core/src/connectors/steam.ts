/**
 * Steam 커넥터 — Steam Web API로 보유 게임, 플레이타임, 업적을 임포트
 *
 * 이전 세션 검증 완료 (browser fetch로 성공 확인).
 * M1 목표: SteamID → 보유 게임 목록 + 플레이타임을 표준 스키마로 변환.
 */

export interface SteamConfig {
  apiKey: string;
  steamId: string;
}

export interface SteamApiGame {
  appid: number;
  name: string;
  playtime_forever: number;
  playtime_windows_forever?: number;
  playtime_mac_forever?: number;
  playtime_linux_forever?: number;
  rtime_last_played: number;
  has_community_visible_stats?: boolean;
  img_icon_url?: string;
  img_logo_url?: string;
}

export interface OwnedGamesResponse {
  response: {
    game_count: number;
    games: SteamApiGame[];
  };
}

export interface PlayerAchievementsResponse {
  playerstats: {
    steamID: string;
    gameName: string;
    achievements: Array<{
      apiname: string;
      achieved: number;
      unlocktime: number;
      name: string;
      description: string;
    }>;
    success: boolean;
  };
}

const STEAM_API_BASE = 'https://api.steampowered.com';

export class SteamApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = 'SteamApiError';
  }
}

/**
 * Steam Web API 호출 — 공통 fetch 래퍼
 */
async function steamFetch<T>(url: string, endpoint: string): Promise<T> {
  const res = await fetch(url);

  if (res.status === 401 || res.status === 403) {
    throw new SteamApiError(
      'Steam API 인증 실패. STEAM_API_KEY가 유효한지 확인하세요.',
      res.status,
      endpoint,
    );
  }
  if (res.status === 429) {
    throw new SteamApiError(
      'Steam API rate limit 초과. 잠시 후 다시 시도하세요.',
      res.status,
      endpoint,
    );
  }
  if (!res.ok) {
    throw new SteamApiError(
      `Steam API 오류: ${res.status} ${res.statusText}`,
      res.status,
      endpoint,
    );
  }

  return res.json() as Promise<T>;
}

/**
 * 보유 게임 목록 조회
 */
export async function fetchOwnedGames(config: SteamConfig): Promise<OwnedGamesResponse> {
  const url = `${STEAM_API_BASE}/IPlayerService/GetOwnedGames/v0001/`
    + `?key=${config.apiKey}&steamid=${config.steamId}`
    + `&format=json&include_appinfo=true&include_played_free_games=true`;

  return steamFetch<OwnedGamesResponse>(url, 'GetOwnedGames');
}

/**
 * 특정 게임의 업적 조회
 */
export async function fetchPlayerAchievements(
  config: SteamConfig,
  appId: number,
): Promise<PlayerAchievementsResponse> {
  const url = `${STEAM_API_BASE}/ISteamUserStats/GetPlayerAchievements/v0001/`
    + `?key=${config.apiKey}&steamid=${config.steamId}&appid=${appId}&format=json`;

  return steamFetch<PlayerAchievementsResponse>(url, 'GetPlayerAchievements');
}

/** normalizeSteamGame의 achievements 인자와 호환되는 최소 입력 */
export interface AchievementInput {
  achieved: number;
  unlocktime: number;
}

/**
 * GetPlayerAchievements 응답 → normalizeSteamGame 입력으로 변환.
 * cli 배선(W-conf)용 한 줄 헬퍼:
 *   normalizeSteamGame(g, toAchievementInputs(await fetchPlayerAchievements(config, appid)))
 * 비공개 프로필·미지원 게임은 steamFetch가 SteamApiError를 던지므로
 * 호출 측에서 게임별 try/catch 후 achievements 없이 호출하면 된다.
 */
export function toAchievementInputs(res: PlayerAchievementsResponse): AchievementInput[] {
  return (res.playerstats.achievements ?? [])
    .map(a => ({ achieved: a.achieved, unlocktime: a.unlocktime }));
}

// ─── 위시리스트·보유게임 상세 (postie src/steamid.ts 승격) ──
// resolveToSteamId는 이미 이 파일에 있으므로 승격 대상에서 제외.

export interface OwnedGameDetail {
  appid: number;
  rtimeLastPlayed: number;
}

interface OwnedDetailResponse {
  response: {
    game_count?: number;
    games?: Array<{ appid?: number; rtime_last_played?: number }>;
  };
}

/**
 * 보유 게임 상세(appId + 마지막 플레이 시각) 조회.
 * postie fetchOwnedGamesDetail 승격. include_appinfo=false 경량 변형.
 */
export async function fetchOwnedGamesDetail(
  apiKey: string,
  steamId: string,
): Promise<OwnedGameDetail[]> {
  const url = `${STEAM_API_BASE}/IPlayerService/GetOwnedGames/v0001/`
    + `?key=${apiKey}&steamid=${steamId}`
    + `&format=json&include_appinfo=false&include_played_free_games=true`;

  const data = await steamFetch<OwnedDetailResponse>(url, 'GetOwnedGames');
  return (data.response.games ?? [])
    .filter(g => Number.isInteger(g.appid))
    .map(g => ({
      appid: g.appid as number,
      rtimeLastPlayed: Number(g.rtime_last_played ?? 0),
    }));
}

interface WishlistResponse {
  response?: {
    items?: Array<{ appid?: number }>;
  };
}

/**
 * 위시리스트 appId 전수 조회.
 * postie fetchWishlistAppIds 승격 (IWishlistService/GetWishlist/v1, 실측 51건).
 * HTTP 실패는 steamFetch가 SteamApiError로 던진다 — 호출 측에서 폴백 결정.
 * 반환된 목록은 normalize 단계에서 wishlisted 매칭용 (W-store 소유).
 */
export async function fetchWishlistAppIds(
  apiKey: string,
  steamId: string,
): Promise<number[]> {
  const url = `${STEAM_API_BASE}/IWishlistService/GetWishlist/v1/`
    + `?key=${apiKey}&steamid=${steamId}&format=json`;

  const data = await steamFetch<WishlistResponse>(url, 'GetWishlist');
  return (data.response?.items ?? [])
    .map(item => item.appid)
    .filter((n): n is number => Number.isInteger(n));
}

// ─── SteamID 변환 유틸리티 ──────────────────────────────────

export interface ResolveVanityUrlResponse {
  response: {
    steamid?: string;
    success: number;
    message?: string;
  };
}

/** Steam 커스텀 URL을 SteamID64로 변환 */
export async function resolveVanityUrl(apiKey: string, vanityName: string): Promise<string> {
  const url = `${STEAM_API_BASE}/ISteamUser/ResolveVanityURL/v0001/`
    + `?key=${apiKey}&vanityurl=${encodeURIComponent(vanityName)}&format=json`;
  const data = await steamFetch<ResolveVanityUrlResponse>(url, 'ResolveVanityURL');
  if (data.response.success !== 1) {
    throw new Error(`SteamID 변환 실패: ${data.response.message ?? '알 수 없는 오류'}`);
  }
  return data.response.steamid!;
}

const STEAM_PROFILE_REGEX = /steamcommunity\.com\/(?:profiles\/(\d+)|id\/([^/\s?#]+))/i;

/**
 * 사용자 입력(URL, 숫자ID, 커스텀URL명)을 SteamID64로 변환
 *
 * - URL: https://steamcommunity.com/profiles/7656119... → 숫자 추출
 * - URL: https://steamcommunity.com/id/vanity → ResolveVanityURL API 호출
 * - 숫자: 76561197960287930 → 그대로 사용
 * - 문자열: vanity → ResolveVanityURL API 호출
 */
export async function resolveToSteamId(input: string, apiKey: string): Promise<string> {
  // 1) 전체 URL인 경우
  const match = input.match(STEAM_PROFILE_REGEX);
  if (match) {
    if (match[1]) return match[1];                       // profiles/숫자
    return resolveVanityUrl(apiKey, match[2]);            // id/vanity
  }

  // 2) 순수 숫자 (17자리 SteamID64)
  if (/^\d{17}$/.test(input)) return input;

  // 3) 숫자가 아닌 문자열 → vanity name으로 간주
  if (!/^\d+$/.test(input)) {
    return resolveVanityUrl(apiKey, input);
  }

  throw new Error(`SteamID를 인식할 수 없습니다: ${input}`);
}
