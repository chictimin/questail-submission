/**
 * 취향 프로필 — export 지점 스텁 (Phase 0).
 * 실제 구현(postie personalize.ts 일반화)은 Phase 2 W-prof 담당.
 * Phase 1의 메타(W-steam)·인덱스(W-store) 산출물에 의존하므로 병렬 불가.
 *
 * analyze(M2 리포트)와 postie(뉴스레터)가 이 프로필을 공유 입력으로 쓴다.
 */

import type { LibraryIndex, TasteProfile } from '../types.js';

/** topGenres에 담는 최대 장르 수 */
const TOP_GENRE_LIMIT = 10;

/** 오름차순 정렬된 배열에서 분위수 (선형 보간, numpy 'linear'와 동일) */
function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lower = sortedAsc[base] ?? 0;
  const upper = sortedAsc[base + 1] ?? lower;
  return lower + rest * (upper - lower);
}

export function buildTasteProfile(library: LibraryIndex): TasteProfile {
  const games = library.games ?? [];

  // ── topGenres: 플레이타임 가중 집계 ──────────────────────────
  // 참고: postie src/personalize.ts를 전수 확인했으나 장르 가중 로직은 없고
  // 뉴스 매칭용 타이틀 인덱스만 있다. 그래서 뉴스레터 전용 부분은 가져올 게 없고,
  // 일반적인 방식(플레이타임이 길수록 그 게임의 장르에 가중치를 더 준다)만 구현한다.
  // 멀티 장르 게임이 장르 수만큼 중복 가산되는 걸 막기 위해 한 게임의 플레이타임을
  // 그 게임의 장르 수로 나눠 분배한 뒤 합산하고, 장르 귀속 총합으로 나눠 정규화한다
  // (가중치 합 = 1). 내림차순 정렬, 동점은 장르명 오름차순으로 결정적 순서 보장.
  const genrePlaytime = new Map<string, number>();
  let attributedTotal = 0;
  for (const game of games) {
    const genres = (game.genres ?? []).map((g) => g.trim()).filter((g) => g.length > 0);
    if (genres.length === 0) continue;
    const share = game.playtimeMinutes / genres.length;
    attributedTotal += game.playtimeMinutes;
    for (const genre of genres) {
      genrePlaytime.set(genre, (genrePlaytime.get(genre) ?? 0) + share);
    }
  }
  const topGenres = [...genrePlaytime.entries()]
    .map(([genre, minutes]) => ({
      genre,
      weight: attributedTotal > 0 ? minutes / attributedTotal : 0,
    }))
    .sort((a, b) => b.weight - a.weight || (a.genre < b.genre ? -1 : a.genre > b.genre ? 1 : 0))
    .slice(0, TOP_GENRE_LIMIT);

  // ── playtimeDistribution: 전체 playtimeMinutes 분포의 5수 요약 ──
  const playtimes = games.map((g) => g.playtimeMinutes).sort((a, b) => a - b);
  const playtimeDistribution = {
    min: playtimes.length > 0 ? (playtimes[0] as number) : 0,
    q1: quantile(playtimes, 0.25),
    median: quantile(playtimes, 0.5),
    q3: quantile(playtimes, 0.75),
    max: playtimes.length > 0 ? (playtimes[playtimes.length - 1] as number) : 0,
  };

  // ── dislikedGenres: 지금은 판단 불가 → 빈 배열 + 계획만 ───────
  // PLAN: 주관 데이터가 games/*.md에 채워지면 아래 신호로 계산한다.
  //   (1) rating 낮음(≤2)인데 playtimeMinutes는 긴 게임들의 장르 집계
  //   (2) dislikeReasons[] 키워드 → 장르 매핑
  //   (3) status 'dropped' 게임들의 장르 집계
  // 현재 library.md 120개 전수에 rating이 없고(객관 정본이라 주관 필드가 없음)
  // games/*.md 주관 필드도 대부분 비어 있어, 억지 추론 대신 빈 배열을 반환한다.
  const dislikedGenres: string[] = [];

  // ── wishlistAppIds: wishlisted === true인 게임의 id 목록 ──────
  const wishlistAppIds = games.filter((g) => g.wishlisted === true).map((g) => g.id);

  // ── ratingPlaytimeGaps: 직접 신호(rating)와 간접 신호(플레이타임)의 갭 ──
  // 설계 의도: gap = playtimeNorm - ratingNorm
  //   (playtimeNorm = playtimeMinutes / 전체 최대값, ratingNorm = rating / 5).
  //   gap > 0: 오래 붙잡았는데 별점은 낮음(습관·그라인드형).
  //   gap < 0: 별점은 높은데 짧게 즐김(짧고 강렬형).
  //   |gap| 내림차순 정렬이라 가장 어긋난 게임이 먼저 보인다.
  // LibraryIndex(NormalizedGame) 계약에는 rating이 없고(주관 필드는 games/*.md
  // 전용 — types.ts 수정 없이), 런타임에 rating을 들고 있는 게임만 계산에
  // 포함한다. 지금 실측 라이브러리에는 rating이 없어 빈 배열을 반환한다.
  const maxPlaytime = playtimes.length > 0 ? (playtimes[playtimes.length - 1] as number) : 0;
  const ratingPlaytimeGaps = games
    .filter((g) => typeof (g as { rating?: unknown }).rating === 'number')
    .map((g) => {
      const rating = (g as { rating?: unknown }).rating as number;
      return {
        gameId: g.id,
        gap: maxPlaytime > 0 ? g.playtimeMinutes / maxPlaytime - rating / 5 : 0,
      };
    })
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

  return {
    topGenres,
    dislikedGenres,
    playtimeDistribution,
    wishlistAppIds,
    ratingPlaytimeGaps,
  };
}
