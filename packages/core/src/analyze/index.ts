/**
 * 취향 분석 리포트 (Phase 3 W-anal).
 *
 * D3 — 정량 리포트가 먼저 서고, LLM 정성 해석을 그 위에 얹는다.
 * stats는 LLM 없이 순수 계산으로 항상 채워진다. summary는
 * canCallLlm(options)이 true일 때만 호출을 시도하고, 설정이 없거나
 * 호출이 실패하면 summary 없이(warnFallback 1줄 + 정량 리포트만) 반환한다.
 * 어떤 경우에도 전체를 throw하지 않는다.
 *
 * 시그니처 근거: library를 첫 번째 필수 인자로 받는다.
 * TasteProfile만으로는 총 게임 수·상위 타이틀·편중도를 계산할 수 없어서
 * LibraryIndex가 필수 입력이다 (호출 흐름상 호출자는 항상 둘 다 들고 있다).
 */

import type { LibraryIndex, LlmOptions, TasteProfile } from '../types.js';
import type { EvidenceChunk, VerifyResult } from '../agent/types.js';
import { verifyAnswer } from '../agent/verify.js';
import { callLlm, canCallLlm, warnFallback } from '../llm/index.js';

export * from './report.js';

export interface AnalysisReport {
  /** LLM 정성 해석 — 무LLM 폴백 시 undefined (빈 문자열 아님) */
  summary?: string;
  /** 정량 지표 — LLM 유무와 무관하게 항상 채워짐 */
  stats: QuantitativeStats;
  /**
   * summary에 대한 근거 이탈 검사 결과.
   * 무LLM 폴백(summary 없음) 시 키 자체를 생략한다.
   */
  verify?: VerifyResult;
}

/** 플레이타임 상위 게임 1개 */
export interface TopGameStat {
  title: string;
  playtimeMinutes: number;
  playtimeHours: number;
  /** 총 플레이타임 대비 비중 (%) */
  sharePercent: number;
}

/** computeStats가 채우는 정량 지표 본체 (AnalysisReport.stats에 그대로 담긴다) */
export interface QuantitativeStats {
  gameCount: number;
  totalPlaytimeMinutes: number;
  totalPlaytimeHours: number;
  topGames: TopGameStat[];
  genreDistribution: { genre: string; weight: number; percent: number }[];
  /** 분 단위 5수 요약 (profile.playtimeDistribution 그대로) */
  playtimeDistribution: { min: number; q1: number; median: number; q3: number; max: number };
  /** 시간 단위 5수 요약 (사람이 읽기용) */
  playtimeDistributionHours: { min: number; q1: number; median: number; q3: number; max: number };
  /** 상위 N개가 총 플레이타임에서 차지하는 비중 (%) */
  concentration: {
    top10SharePercent: number;
    top20SharePercent: number;
    top40SharePercent: number;
  };
  /** 플레이타임 구간별 게임 수 */
  playtimeBuckets: {
    unplayed: number;
    under1h: number;
    h1to10: number;
    h10to100: number;
    over100h: number;
  };
  /** 업적 달성률이 있는 게임이 있을 때만 존재 (없으면 키 자체를 생략) */
  achievement?: {
    count: number;
    avgPercent: number;
    medianPercent: number;
    minPercent: number;
    maxPercent: number;
  };
  wishlist: { count: number; titles: string[] };
  /** 최근성·백로그 (last_played 기반) */
  recency: {
    playedLast30d: number;
    playedLast90d: number;
    playedLast365d: number;
    /** last_played가 있고 1년 이상 경과 (휴면) */
    dormantOver1y: number;
    /** playtimeMinutes === 0 — 한 번도 실행 안 한 "쌓아둔 게임" */
    neverPlayed: number;
    neverPlayedPercent: number;
    /** playtime > 0인데 last_played가 없음 — 미플레이로 보지 않고 분리 집계 */
    unknownLastPlayed: number;
  };
  /** 장르별 게임 수·총·평균 플레이타임 (총 플레이타임 내림차순) */
  genreDepth: {
    genres: { genre: string; gameCount: number; totalMinutes: number; totalHours: number; avgHours: number }[];
  };
  /** 제작사·출시연도 */
  makers: {
    topDevelopersByCount: { name: string; gameCount: number }[];
    topDevelopersByPlaytime: { name: string; playtimeHours: number }[];
    topPublishersByCount: { name: string; gameCount: number }[];
    topPublishersByPlaytime: { name: string; playtimeHours: number }[];
    /** 연도 오름차순 */
    releaseYears: { year: number; gameCount: number }[];
    /** 연도 추출 실패·누락으로 분포에서 제외된 게임 수 */
    unparsedYearCount: number;
  };
  /** 시계열 변화 — 비교 가능한 이전 리포트가 있을 때만 존재 (없으면 키 생략) */
  trend?: TrendStats;
}

export const TOP_GAMES_LIMIT = 10;
/** 장르 평균이 의미를 가지기 위한 최소 게임 수 — 미만 장르는 렌더·프롬프트에서 "표본 적음" 취급 */
export const MIN_GENRE_GAMES_FOR_AVG = 3;
/** 제작사·장르 top 목록 길이 */
export const MAKER_TOP_LIMIT = 5;
/** 플레이타임 증가 상위 게임 표시 수 */
export const TREND_RISER_LIMIT = 5;

/** 리포트 문구·프롬프트 언어 */
export type ReportLang = 'ko' | 'en';

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function medianOf(sortedAsc: number[]): number {
  if (sortedAsc.length === 0) return 0;
  const mid = Math.floor(sortedAsc.length / 2);
  if (sortedAsc.length % 2 === 1) return sortedAsc[mid] as number;
  return ((sortedAsc[mid - 1] as number) + (sortedAsc[mid] as number)) / 2;
}

/** 상위 n개의 플레이타임 합이 전체에서 차지하는 비중 (%) */
function topSharePercent(sortedDescMinutes: number[], total: number, n: number): number {
  if (total <= 0) return 0;
  const part = sortedDescMinutes.slice(0, n).reduce((a, b) => a + b, 0);
  return round1((part / total) * 100);
}

/**
 * release_date에서 4자리 연도만 추출.
 * Steam이 로케일에 따라 형식을 제각각으로 주므로(`2019년 10월 1일` /
 * `1 Oct, 2019` 등) 날짜 전체 파싱은 시도하지 않는다. 범위 밖·매칭
 * 실패면 undefined — 호출자는 그 게임을 연도 분포에서 제외한다.
 */
function extractYear(releaseDate?: string): number | undefined {
  if (!releaseDate) return undefined;
  const m = releaseDate.match(/(19|20)\d{2}/);
  if (!m) return undefined;
  const year = Number(m[0]);
  const maxYear = new Date().getFullYear() + 2;
  return year >= 1970 && year <= maxYear ? year : undefined;
}

/** 한 게임의 제작사 목록을 tally에 반영 (공동개발 중복 집계 — 주석 참조) */
function tallyMakers(
  tally: Map<string, { count: number; minutes: number }>,
  names: string[] | undefined,
  minutes: number,
): void {
  const unique = [...new Set((names ?? []).map((s) => s.trim()).filter((s) => s.length > 0))];
  for (const name of unique) {
    const e = tally.get(name) ?? { count: 0, minutes: 0 };
    e.count += 1;
    e.minutes += minutes;
    tally.set(name, e);
  }
}

/**
 * 정량 지표 계산 — 순수 함수, LLM·I/O 없음.
 * library에서 게임 단위 지표(총합·상위·편중·구간·업적·위시)를,
 * profile에서 취향 집계(topGenres·5수요약)를 가져온다.
 */
export function computeStats(library: LibraryIndex, profile: TasteProfile): QuantitativeStats {
  const games = library.games ?? [];
  const playtimesDesc = games.map((g) => g.playtimeMinutes).sort((a, b) => b - a);
  const total = playtimesDesc.reduce((a, b) => a + b, 0);

  const byId = new Map(games.map((g) => [g.id, g]));
  const topGames: TopGameStat[] = [...games]
    .sort((a, b) => b.playtimeMinutes - a.playtimeMinutes)
    .slice(0, TOP_GAMES_LIMIT)
    .map((g) => ({
      title: g.title,
      playtimeMinutes: g.playtimeMinutes,
      playtimeHours: round1(g.playtimeMinutes / 60),
      sharePercent: total > 0 ? round1((g.playtimeMinutes / total) * 100) : 0,
    }));

  const buckets = { unplayed: 0, under1h: 0, h1to10: 0, h10to100: 0, over100h: 0 };
  for (const g of games) {
    const m = g.playtimeMinutes;
    if (m <= 0) buckets.unplayed++;
    else if (m < 60) buckets.under1h++;
    else if (m < 600) buckets.h1to10++;
    else if (m < 6000) buckets.h10to100++;
    else buckets.over100h++;
  }

  const achRates = games
    .map((g) => g.achievementPercent)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b);
  const achievement =
    achRates.length > 0
      ? {
          count: achRates.length,
          avgPercent: round1(achRates.reduce((a, b) => a + b, 0) / achRates.length),
          medianPercent: round1(medianOf(achRates)),
          minPercent: achRates[0] as number,
          maxPercent: achRates[achRates.length - 1] as number,
        }
      : undefined;

  const wishlistIds = profile.wishlistAppIds ?? [];
  const wishlistTitles = wishlistIds
    .map((id) => byId.get(id)?.title)
    .filter((t): t is string => typeof t === 'string');

  // ── recency: last_played 기반 ──────────────────────────────
  // 실측(library.md 120개): last_played 누락 15개가 playtime 0인 게임과
  // 정확히 일치. 정책: playtime 0 → neverPlayed(쌓아둔 게임),
  // playtime > 0인데 last_played 없음 → unknown(미플레이로 보지 않음).
  const nowSec = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  let playedLast30d = 0;
  let playedLast90d = 0;
  let playedLast365d = 0;
  let dormantOver1y = 0;
  let neverPlayed = 0;
  let unknownLastPlayed = 0;
  for (const g of games) {
    if (g.playtimeMinutes <= 0) {
      neverPlayed++;
      continue;
    }
    const lp = g.lastPlayedAt;
    if (typeof lp !== 'number' || !(lp > 0)) {
      unknownLastPlayed++;
      continue;
    }
    const age = nowSec - lp;
    if (age < 30 * DAY) playedLast30d++;
    if (age < 90 * DAY) playedLast90d++;
    if (age < 365 * DAY) playedLast365d++;
    else dormantOver1y++;
  }

  // ── genreDepth: 장르별 보유 수·총·평균 ─────────────────────
  // 멀티 장르 게임의 플레이타임은 장르 수로 나눠 분배 (topGenres와 동일 규칙).
  const genreTally = new Map<string, { count: number; minutes: number }>();
  for (const g of games) {
    const genres = [...new Set((g.genres ?? []).map((s) => s.trim()).filter((s) => s.length > 0))];
    if (genres.length === 0) continue;
    const share = g.playtimeMinutes / genres.length;
    for (const genre of genres) {
      const e = genreTally.get(genre) ?? { count: 0, minutes: 0 };
      e.count += 1;
      e.minutes += share;
      genreTally.set(genre, e);
    }
  }
  const genreDepthGenres = [...genreTally.entries()]
    .map(([genre, e]) => ({
      genre,
      gameCount: e.count,
      totalMinutes: Math.round(e.minutes),
      totalHours: round1(e.minutes / 60),
      avgHours: e.count > 0 ? round1(e.minutes / 60 / e.count) : 0,
    }))
    .sort((a, b) => b.totalMinutes - a.totalMinutes || (a.genre < b.genre ? -1 : 1));

  // ── makers: 공동개발 게임은 포함된 제작사마다 게임 수 +1·플레이타임
  // 전액 가산(중복 집계). 기여도 분할은 데이터가 없어 하지 않는다.
  const devTally = new Map<string, { count: number; minutes: number }>();
  const pubTally = new Map<string, { count: number; minutes: number }>();
  const yearCount = new Map<number, number>();
  let unparsedYearCount = 0;
  for (const g of games) {
    tallyMakers(devTally, g.developers, g.playtimeMinutes);
    tallyMakers(pubTally, g.publishers, g.playtimeMinutes);
    const year = extractYear(g.releaseDate);
    if (year === undefined) unparsedYearCount++;
    else yearCount.set(year, (yearCount.get(year) ?? 0) + 1);
  }
  const byCountThenName = (a: [string, { count: number }], b: [string, { count: number }]) =>
    b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1);
  const byMinutesThenName = (a: [string, { minutes: number }], b: [string, { minutes: number }]) =>
    b[1].minutes - a[1].minutes || (a[0] < b[0] ? -1 : 1);
  const topNamesByCount = (tally: Map<string, { count: number; minutes: number }>) =>
    [...tally.entries()].sort(byCountThenName).slice(0, MAKER_TOP_LIMIT)
      .map(([name, e]) => ({ name, gameCount: e.count }));
  const topNamesByPlaytime = (tally: Map<string, { count: number; minutes: number }>) =>
    [...tally.entries()].sort(byMinutesThenName).slice(0, MAKER_TOP_LIMIT)
      .map(([name, e]) => ({ name, playtimeHours: round1(e.minutes / 60) }));

  const dist = profile.playtimeDistribution;
  const toHours = (v: number) => round1(v / 60);

  const stats: QuantitativeStats = {
    gameCount: games.length,
    totalPlaytimeMinutes: total,
    totalPlaytimeHours: round1(total / 60),
    topGames,
    genreDistribution: (profile.topGenres ?? []).map((g) => ({
      genre: g.genre,
      weight: g.weight,
      percent: round1(g.weight * 100),
    })),
    playtimeDistribution: { ...dist },
    playtimeDistributionHours: {
      min: toHours(dist.min),
      q1: toHours(dist.q1),
      median: toHours(dist.median),
      q3: toHours(dist.q3),
      max: toHours(dist.max),
    },
    concentration: {
      top10SharePercent: topSharePercent(playtimesDesc, total, 10),
      top20SharePercent: topSharePercent(playtimesDesc, total, 20),
      top40SharePercent: topSharePercent(playtimesDesc, total, 40),
    },
    playtimeBuckets: buckets,
    wishlist: { count: wishlistIds.length, titles: wishlistTitles },
    recency: {
      playedLast30d,
      playedLast90d,
      playedLast365d,
      dormantOver1y,
      neverPlayed,
      neverPlayedPercent: games.length > 0 ? round1((neverPlayed / games.length) * 100) : 0,
      unknownLastPlayed,
    },
    genreDepth: { genres: genreDepthGenres },
    makers: {
      topDevelopersByCount: topNamesByCount(devTally),
      topDevelopersByPlaytime: topNamesByPlaytime(devTally),
      topPublishersByCount: topNamesByCount(pubTally),
      topPublishersByPlaytime: topNamesByPlaytime(pubTally),
      releaseYears: [...yearCount.entries()]
        .map(([year, gameCount]) => ({ year, gameCount }))
        .sort((a, b) => a.year - b.year),
      unparsedYearCount,
    },
  };
  if (achievement) stats.achievement = achievement;
  return stats;
}

/** 정량 지표를 LLM 프롬프트에 담는다. 출력 언어는 lang을 따른다. */
export function buildPrompt(stats: QuantitativeStats, lang: ReportLang): string {
  const topLines = stats.topGames
    .map((g, i) => `${i + 1}. ${g.title} — ${g.playtimeHours}시간 (${g.sharePercent}%)`)
    .join('\n');
  const genreLines = stats.genreDistribution
    .map((g) => `- ${g.genre}: ${g.percent}%`)
    .join('\n');
  const b = stats.playtimeBuckets;
  const ach = stats.achievement
    ? `업적 달성률 보유 게임 ${stats.achievement.count}개, 평균 ${stats.achievement.avgPercent}% (중앙값 ${stats.achievement.medianPercent}%)`
    : '업적 달성률 데이터 없음';
  const r = stats.recency;
  const ownTop = [...stats.genreDepth.genres]
    .sort((a, b2) => b2.gameCount - a.gameCount || b2.totalMinutes - a.totalMinutes)
    .slice(0, 3)
    .map((g) => `${g.genre}(${g.gameCount}개)`)
    .join(', ');
  const playTop = stats.genreDepth.genres
    .slice(0, 3)
    .map((g) => `${g.genre}(${g.totalHours}시간)`)
    .join(', ');
  const devTop = stats.makers.topDevelopersByPlaytime
    .slice(0, 3)
    .map((d) => `${d.name}(${d.playtimeHours}시간)`)
    .join(', ');
  const years = stats.makers.releaseYears;
  const yearLine = years.length > 0
    ? `출시연도 ${years[0]?.year}~${years[years.length - 1]?.year}년, 최다 ${[...years].sort((a, b2) => b2.gameCount - a.gameCount)[0]?.year}년`
    : '출시연도 정보 없음';
  const ko = [
    '당신은 Steam 게임 라이브러리 데이터를 읽고 한 사람의 게임 취향을 분석하는 전문가입니다.',
    '아래는 실제 플레이 기록에서 계산한 정량 지표입니다. 이 숫자들을 근거로 이 사람의 게임 취향을 한국어로 분석해 주세요.',
    '',
    `총 게임 수: ${stats.gameCount}개, 총 플레이타임: ${stats.totalPlaytimeHours}시간`,
    '',
    '플레이타임 상위 게임:',
    topLines,
    '',
    '장르 분포 (플레이타임 가중):',
    genreLines || '(장르 정보 없음)',
    `보유 수 상위 장르: ${ownTop || '(없음)'} / 플레이타임 상위 장르: ${playTop || '(없음)'}`,
    '',
    `플레이타임 5수 요약 (시간): 최소 ${stats.playtimeDistributionHours.min}, Q1 ${stats.playtimeDistributionHours.q1}, 중앙값 ${stats.playtimeDistributionHours.median}, Q3 ${stats.playtimeDistributionHours.q3}, 최대 ${stats.playtimeDistributionHours.max}`,
    `편중도: 상위 10개 ${stats.concentration.top10SharePercent}%, 상위 20개 ${stats.concentration.top20SharePercent}%, 상위 40개 ${stats.concentration.top40SharePercent}%`,
    `플레이 구간: 미플레이 ${b.unplayed}개, 1시간 미만 ${b.under1h}개, 1~10시간 ${b.h1to10}개, 10~100시간 ${b.h10to100}개, 100시간 이상 ${b.over100h}개`,
    `최근성: 최근 30일 ${r.playedLast30d}개, 90일 ${r.playedLast90d}개, 1년 이상 휴면 ${r.dormantOver1y}개, 쌓아둔 게임(미플레이) ${r.neverPlayed}개(${r.neverPlayedPercent}%)`,
    `개발사 플레이타임 상위: ${devTop || '(없음)'} / ${yearLine}`,
    ach,
    stats.wishlist.count > 0 ? `위시리스트 ${stats.wishlist.count}개: ${stats.wishlist.titles.join(', ')}` : '위시리스트 없음',
    '',
    '요청: 좋아하는 장르·플레이 성향(몰입형 vs 탐색형, 장시간 정착 vs 짧게 다양하게)을 5~10문장 한국어 문단으로 서술하세요. 숫자를 그대로 나열하지 말고 해석을 곁들이세요. 게임 제목을 언급할 때는 큰따옴표로 감싸세요(예: "몬스터 헌터 와일즈").',
  ];
  const en = [
    'You are an expert who reads Steam library data and analyzes a person\'s gaming taste.',
    'Below are quantitative metrics computed from actual play records. Analyze this person\'s gaming taste in English based on these numbers.',
    '',
    `Total games: ${stats.gameCount}, total playtime: ${stats.totalPlaytimeHours}h`,
    '',
    'Top games by playtime:',
    topLines,
    '',
    'Genre distribution (playtime-weighted):',
    genreLines || '(no genre info)',
    `Top genres by ownership: ${ownTop || '(none)'} / by playtime: ${playTop || '(none)'}`,
    '',
    `Playtime five-number summary (hours): min ${stats.playtimeDistributionHours.min}, Q1 ${stats.playtimeDistributionHours.q1}, median ${stats.playtimeDistributionHours.median}, Q3 ${stats.playtimeDistributionHours.q3}, max ${stats.playtimeDistributionHours.max}`,
    `Concentration: top 10 ${stats.concentration.top10SharePercent}%, top 20 ${stats.concentration.top20SharePercent}%, top 40 ${stats.concentration.top40SharePercent}%`,
    `Playtime buckets: unplayed ${b.unplayed}, under 1h ${b.under1h}, 1-10h ${b.h1to10}, 10-100h ${b.h10to100}, over 100h ${b.over100h}`,
    `Recency: played in last 30d ${r.playedLast30d}, 90d ${r.playedLast90d}, dormant 1y+ ${r.dormantOver1y}, backlog (unplayed) ${r.neverPlayed} (${r.neverPlayedPercent}%)`,
    `Top developers by playtime: ${devTop || '(none)'} / ${yearLine}`,
    ach,
    stats.wishlist.count > 0 ? `Wishlist ${stats.wishlist.count}: ${stats.wishlist.titles.join(', ')}` : 'No wishlist',
    '',
    'Request: describe their favorite genres and play style (immersive vs exploratory, long-term settling vs short varied sessions) in 5-10 English sentences. Interpret the numbers instead of just listing them. Wrap game titles in double quotes (e.g. "Monster Hunter Wilds").',
  ];
  return (lang === 'en' ? en : ko).join('\n');
}

export async function analyzeLibrary(
  library: LibraryIndex,
  profile: TasteProfile,
  options?: LlmOptions,
  lang: ReportLang = 'ko',
  prevReport?: AnalysisReportJson | null,
): Promise<AnalysisReport> {
  const stats = computeStats(library, profile);
  // 시계열: 비교 가능한 이전 리포트가 있을 때만 trend를 붙인다 (없으면 키 생략)
  const trend = computeTrend(library, prevReport);
  if (trend) stats.trend = trend;

  // D3 폴백 경계: 호출 가능 판정(canCallLlm)부터. 불가하면 시도조차 하지 않는다.
  if (!options || !canCallLlm(options)) {
    return { summary: undefined, stats };
  }
  try {
    // 근거는 LLM이 본 것과 동일한 문자열이어야 한다 — buildPrompt를 다시
    // 만들지 말고 위 prompt를 재사용한다 (복제하면 둘이 어긋난다).
    const prompt = buildPrompt(stats, lang);
    const summary = await callLlm(options, prompt);
    const evidence: EvidenceChunk[] = [
      { id: 'analyze-prompt', docId: 'analyze-prompt', categories: ['TASTE'], heading: '정량 지표', text: prompt },
    ];
    const raw = verifyAnswer(summary, 'TASTE', evidence, library);
    // UNKNOWN_GAME 위반만 남긴다. UNGROUNDED_NUMBER는 파생 수치(반올림·합산 등)
    // 오탐이 실측 확인됐고, 그 소음이 게임명 환각이라는 진짜 신호를 덮는다.
    // CITED_WHILE_OUT_OF_SCOPE는 카테고리 'TASTE'에서 발동할 수 없어 버린다.
    const violations = raw.violations.filter((v) => v.rule === 'UNKNOWN_GAME');
    // 검증 실패해도 summary를 버리거나 재생성하지 않는다 — 리포트는 그대로
    // 반환하고 verify 필드만 채운다.
    return { summary, stats, verify: { passed: violations.length === 0, violations } };
  } catch (err) {
    warnFallback('analyze', err);
    return { summary: undefined, stats };
  }
}

// ─── JSON 사이드카 ─────────────────────────────────────────────
// 설계 의도: 곧 들어올 시계열 변화 지표가 "지난 리포트 대비"를 계산해야
// 하는데, md를 파싱하는 것보다 JSON을 읽는 게 훨씬 견고하다. M3 웹 UI도
// 같은 파일을 그대로 소비한다. 구조가 계약이 되므로 schemaVersion으로
// 버전을 박아 둔다 — 형식이 바뀌면 읽는 쪽이 구분할 수 있어야 한다.

/** 리포트 JSON 사이드카 스키마 버전. 구조가 바뀌면 올린다. */
export const REPORT_SCHEMA_VERSION = 1;

/** 시계열 변화 — "지난 리포트 대비". 비교 가능한 이전 리포트가 없으면 키 자체를 생략 */
export interface TrendStats {
  prevGeneratedAt: string;
  totalPlaytimeDeltaHours: number;
  gameCountDelta: number;
  /** 이전 스냅샷에 없던 게임 제목 (신규 구매 감지) */
  newGames: string[];
  /** 플레이타임이 늘어난 게임 상위 (제목+증가 시간) */
  topRisers: { title: string; deltaHours: number }[];
}

/** 다음 실행의 시계열 비교용 게임 단위 스냅샷 */
export interface GameSnapshot {
  id: string;
  title: string;
  playtimeMinutes: number;
}

export interface AnalysisReportJson {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  /** 리포트 생성 시각 (md 헤더의 생성 시각과 동일) */
  generatedAt: string;
  stats: QuantitativeStats;
  /** 무LLM 폴백 시 키 자체를 생략 (null이 아님) */
  summary?: string;
  /** 다음 실행의 trend 계산용 */
  librarySnapshot: GameSnapshot[];
}

/**
 * 이전 리포트 JSON과 비교해 변화 지표를 계산한다. 순수 함수.
 * 이전 리포트가 없거나 버전이 다르면 undefined (정상 흐름 — 섹션 생략).
 * 스냅샷이 없는 구버전 JSON이면 총합·게임 수 델타만 계산하고
 * 신규·증가 게임 목록은 비워 둔다 (스냅샷 없이 전 게임이 신규로 보이는 걸 방지).
 */
export function computeTrend(
  library: LibraryIndex,
  prev: AnalysisReportJson | null | undefined,
): TrendStats | undefined {
  if (!prev || prev.schemaVersion !== REPORT_SCHEMA_VERSION) return undefined;
  const curGames = library.games ?? [];
  const curTotal = curGames.reduce((a, g) => a + g.playtimeMinutes, 0);
  const snapshot = prev.librarySnapshot ?? [];
  const prevById = new Map(snapshot.map((g) => [g.id, g]));
  const hasSnapshot = snapshot.length > 0;

  const risers: { title: string; deltaMinutes: number }[] = [];
  const newGames: string[] = [];
  if (hasSnapshot) {
    for (const g of curGames) {
      const old = prevById.get(g.id);
      if (!old) {
        newGames.push(g.title);
      } else if (g.playtimeMinutes > old.playtimeMinutes) {
        risers.push({ title: g.title, deltaMinutes: g.playtimeMinutes - old.playtimeMinutes });
      }
    }
    risers.sort((a, b) => b.deltaMinutes - a.deltaMinutes);
  }

  return {
    prevGeneratedAt: prev.generatedAt,
    totalPlaytimeDeltaHours: round1((curTotal - prev.stats.totalPlaytimeMinutes) / 60),
    gameCountDelta: curGames.length - prev.stats.gameCount,
    newGames,
    topRisers: risers.slice(0, TREND_RISER_LIMIT).map((r) => ({
      title: r.title,
      deltaHours: round1(r.deltaMinutes / 60),
    })),
  };
}

export function toReportJson(
  report: AnalysisReport,
  generatedAt: Date,
  library: LibraryIndex,
): AnalysisReportJson {
  const json: AnalysisReportJson = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: generatedAt.toISOString(),
    stats: report.stats,
    librarySnapshot: (library.games ?? []).map((g) => ({
      id: g.id,
      title: g.title,
      playtimeMinutes: g.playtimeMinutes,
    })),
  };
  if (report.summary !== undefined) json.summary = report.summary;
  return json;
}
