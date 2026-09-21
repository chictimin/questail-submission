/**
 * 표준 스키마 — 모든 플랫폼의 게임 데이터를 이 구조로 정규화한다.
 *
 * 객관 데이터 (source: auto) — API가 긁어오는 사실
 * 주관 데이터 (source: manual) — 사용자 수기 입력, 별점 등
 *
 * 타입 정의는 ../types.ts가 정본이다 (Phase 0 계약 고정).
 */

export type { GameSource, Platform, NormalizedGame } from '../types.js';

import type { SteamApiGame } from '../connectors/steam.js';
import type { GameMeta, NormalizedGame } from '../types.js';

/**
 * Steam API 응답을 표준 스키마로 변환
 * @param meta  appdetails 등 메타 소스 보강분 (없으면 기본 필드만 — 하위 호환)
 */
export function normalizeSteamGame(game: SteamApiGame, achievements?: { achieved: number; unlocktime: number }[], meta?: GameMeta): NormalizedGame {
  const totalAchievements = achievements?.length ?? 0;
  const achievedCount = achievements?.filter(a => a.achieved === 1).length ?? 0;
  const achievementPercent = totalAchievements > 0 ? Math.round((achievedCount / totalAchievements) * 100) : undefined;

  const out: NormalizedGame = {
    id: String(game.appid),
    platform: 'steam',
    title: game.name,
    source: 'auto',
    playtimeMinutes: game.playtime_forever ?? 0,
    lastPlayedAt: game.rtime_last_played || undefined,
    achievementPercent,
  };

  if (meta?.genres && meta.genres.length > 0) out.genres = meta.genres.map(g => g.name);
  if (meta?.nameKo !== undefined) out.titleKo = meta.nameKo;
  if (meta?.developers && meta.developers.length > 0) out.developers = [...meta.developers];
  if (meta?.publishers && meta.publishers.length > 0) out.publishers = [...meta.publishers];
  if (meta?.releaseDate !== undefined) out.releaseDate = meta.releaseDate;
  if (meta?.headerImage !== undefined) out.imageUrl = meta.headerImage;

  return out;
}
