/**
 * 취향 리포트 렌더링 (md) — cli.ts에서 분리.
 *
 * 구성: 표 + ASCII 막대가 기본(항상 출력, 모든 환경에서 보임),
 * mermaid는 그 위에 얹는 선택적 계층이다. 선언적 섹션 프레임워크는
 * 두지 않는다 — 섹션별 작은 함수를 나열해 이어붙이는 수준이면 충분하다.
 *
 * 차트 종류를 설정으로 둔 이유 (실측 기록):
 * 캡틴 Obsidian의 `beautiful-mermaid-renderer` 플러그인은 mermaid 블록을
 * 가로채 자체 엔진으로 그리는데, 그 엔진은 `graph`·`flowchart`·
 * `stateDiagram-v2`·`xychart` 넷만 지원해서 `pie`가 "Invalid mermaid
 * header" 오류로 깨진다. 반면 플러그인 없는 일반 환경(Obsidian 기본·
 * GitHub)에서는 오히려 `pie`가 가장 널리 지원되고 `xychart`가 불확실하다.
 * 어느 한쪽에 고정하면 다른 쪽이 깨지므로, 표+ASCII를 기본으로 깔고
 * mermaid 종류는 설정(QUESTAIL_REPORT_CHART)으로 고르게 한다.
 */

import {
  MIN_GENRE_GAMES_FOR_AVG,
  type QuantitativeStats,
  type TrendStats,
} from './index.js';
import type { VerifyResult } from '../agent/types.js';

/** 리포트 문구 언어 선택자 — cli.ts의 llmText를 그대로 넘겨받는다 */
export type ReportText = (ko: string, en: string) => string;

/** mermaid 계층 종류: none(표+ASCII만) · pie(기본) · xychart */
export type ReportChart = 'none' | 'pie' | 'xychart';

export const DEFAULT_REPORT_CHART: ReportChart = 'pie';

/** 설정값을 ReportChart로 — 이상한 값은 조용히 기본값으로 떨어뜨린다 */
export function parseReportChart(raw: string | undefined): ReportChart {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'none' || v === 'pie' || v === 'xychart') return v;
  return DEFAULT_REPORT_CHART;
}

// ─── 동아시아 폭 ─────────────────────────────────────────────
// 한글·CJK를 문자 개수로 패딩하면 정렬이 깨지므로(표시 폭 2칸)
// Wide/Fullwidth 범위를 2칸으로 세는 헬퍼를 직접 둔다 (의존성 금지).

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x3000 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** 문자열의 터미널 표시 폭 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return w;
}

/** 표시 폭 기준 우측 패딩 */
export function padWidth(s: string, width: number): string {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

/** 0~1 비율을 블록 막대로 (frac > 0이면 최소 1칸) */
export function asciiBar(frac: number, width = 20): string {
  if (!(frac > 0)) return '';
  return '█'.repeat(Math.max(1, Math.round(frac * width)));
}

export function escapeMdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** mermaid 라벨용 — 쌍따옴표만 홑따옴표로 (쉼표·개행은 호출자가 피한다) */
function escapeXy(label: string): string {
  return label.replace(/"/g, "'").replace(/\r?\n/g, ' ').trim();
}

function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) {
    if (v <= m * mag) return m * mag;
  }
  return 10 * mag;
}

/** pie — stock Obsidian·GitHub에서 가장 널리 지원되는 문법 */
function pieBlock(title: string, entries: { label: string; value: number }[]): string[] {
  const lines = ['```mermaid', `pie title ${escapeXy(title)}`];
  for (const e of entries) {
    lines.push(`    "${escapeXy(e.label)}" : ${e.value}`);
  }
  lines.push('```');
  return lines;
}

/** xychart 막대 — 일부 플러그인·최신 렌더러에서 동작 */
function xyBarBlock(yTitle: string, labels: string[], values: number[]): string[] {
  const quoted = labels.map((l) => `"${escapeXy(l)}"`).join(', ');
  return [
    '```mermaid',
    'xychart',
    `    x-axis [${quoted}]`,
    `    y-axis "${escapeXy(yTitle)}" 0 --> ${niceCeil(Math.max(...values, 0))}`,
    `    bar [${values.join(', ')}]`,
    '```',
  ];
}

/** xychart 꺾은선 — pie로는 표현 불가라 xychart 모드에서만 쓴다 */
function xyLineBlock(yTitle: string, labels: string[], values: number[]): string[] {
  const quoted = labels.map((l) => `"${escapeXy(l)}"`).join(', ');
  return [
    '```mermaid',
    'xychart',
    `    x-axis [${quoted}]`,
    `    y-axis "${escapeXy(yTitle)}" 0 --> ${niceCeil(Math.max(...values, 0))}`,
    `    line [${values.join(', ')}]`,
    '```',
  ];
}

// ─── 섹션 ────────────────────────────────────────────────────

function renderHeadline(stats: QuantitativeStats, t: ReportText): string[] {
  const days = Math.round(stats.totalPlaytimeHours / 24);
  const top = stats.topGames[0];
  const lines = [
    `- ${t(`총 플레이타임 ${stats.totalPlaytimeHours}시간 (약 ${days}일) · ${stats.gameCount}개 게임`, `Total playtime ${stats.totalPlaytimeHours}h (about ${days} days) · ${stats.gameCount} games`)}`,
  ];
  if (top) {
    lines.push(`- ${t(`가장 오래 붙잡은 게임: ${top.title} (${top.playtimeHours}시간)`, `Most played: ${top.title} (${top.playtimeHours}h)`)}`);
  }
  lines.push(`- ${t(`상위 20개가 전체 플레이타임의 ${stats.concentration.top20SharePercent}%`, `Top 20 games take ${stats.concentration.top20SharePercent}% of total playtime`)}`);
  lines.push(`- ${t(`쌓아둔 게임(미플레이) ${stats.recency.neverPlayed}개 (${stats.recency.neverPlayedPercent}%)`, `Backlog (unplayed): ${stats.recency.neverPlayed} games (${stats.recency.neverPlayedPercent}%)`)}`);
  return lines;
}

function renderTopGames(stats: QuantitativeStats, t: ReportText): string[] {
  const lines = [`## ${t('플레이타임 상위 10', 'Top 10 by playtime')}`, ''];
  lines.push(`| ${t('순위', 'Rank')} | ${t('제목', 'Title')} | ${t('시간', 'Hours')} | ${t('비중', 'Share')} |`);
  lines.push('| --- | --- | --- | --- |');
  stats.topGames.forEach((g, i) => {
    lines.push(`| ${i + 1} | ${escapeMdCell(g.title)} | ${g.playtimeHours}h | ${g.sharePercent}% |`);
  });
  lines.push('');
  return lines;
}

function renderGenreDist(stats: QuantitativeStats, t: ReportText, chart: ReportChart): string[] {
  const title = t('장르 분포 (플레이타임 가중)', 'Genre distribution (playtime-weighted)');
  const lines = [`## ${title}`, ''];
  const dist = stats.genreDistribution;
  if (dist.length === 0) {
    lines.push(t('(장르 정보 없음)', '(no genre info)'), '');
    return lines;
  }
  const max = Math.max(...dist.map((g) => g.percent));
  if (chart === 'pie') {
    lines.push(...pieBlock(title, dist.map((g) => ({ label: g.genre, value: g.percent }))), '');
  } else if (chart === 'xychart') {
    lines.push(...xyBarBlock(t('비중 (%)', 'Share (%)'), dist.map((g) => g.genre), dist.map((g) => g.percent)), '');
  }
  const labelW = Math.max(...dist.map((g) => displayWidth(g.genre)));
  lines.push(`| ${t('장르', 'Genre')} | ${t('그래프', 'Bar')} | ${t('비중', 'Share')} |`);
  lines.push('| --- | --- | --- |');
  for (const g of dist) {
    lines.push(`| ${padWidth(g.genre, labelW)} | ${asciiBar(max > 0 ? g.percent / max : 0)} | ${g.percent}% |`);
  }
  lines.push('');
  return lines;
}

function renderGenreDepth(stats: QuantitativeStats, t: ReportText): string[] {
  const lines = [`## ${t('장르 심화 — 보유 vs 플레이', 'Genre depth — owned vs played')}`, ''];
  const genres = stats.genreDepth.genres;
  if (genres.length === 0) {
    lines.push(t('(장르 정보 없음)', '(no genre info)'), '');
    return lines;
  }
  lines.push(`| ${t('장르', 'Genre')} | ${t('보유', 'Owned')} | ${t('총 시간', 'Total h')} | ${t('평균', 'Avg h')} |`);
  lines.push('| --- | --- | --- | --- |');
  for (const g of genres) {
    const mark = g.gameCount < MIN_GENRE_GAMES_FOR_AVG ? '*' : '';
    lines.push(`| ${escapeMdCell(g.genre)}${mark} | ${g.gameCount} | ${g.totalHours}h | ${g.avgHours}h |`);
  }
  lines.push('');
  lines.push(t(`* 표본 ${MIN_GENRE_GAMES_FOR_AVG}개 미만 장르의 평균은 참고용`, `* Average of genres with fewer than ${MIN_GENRE_GAMES_FOR_AVG} games is indicative only`), '');
  return lines;
}

function renderPlaytimeDist(stats: QuantitativeStats, t: ReportText): string[] {
  const h = stats.playtimeDistributionHours;
  return [
    `## ${t('플레이타임 분포 (시간, 5수 요약)', 'Playtime distribution (hours, five-number summary)')}`,
    '',
    `| ${t('최소', 'Min')} | Q1 | ${t('중앙값', 'Median')} | Q3 | ${t('최대', 'Max')} |`,
    '| --- | --- | --- | --- | --- |',
    `| ${h.min} | ${h.q1} | ${h.median} | ${h.q3} | ${h.max} |`,
    '',
  ];
}

function renderConcentration(stats: QuantitativeStats, t: ReportText): string[] {
  const c = stats.concentration;
  return [
    `## ${t('편중도 (상위 게임이 총 플레이타임에서 차지하는 비중)', 'Concentration (share of total playtime by top games)')}`,
    '',
    `| ${t('상위 10개', 'Top 10')} | ${t('상위 20개', 'Top 20')} | ${t('상위 40개', 'Top 40')} |`,
    '| --- | --- | --- |',
    `| ${c.top10SharePercent}% | ${c.top20SharePercent}% | ${c.top40SharePercent}% |`,
    '',
  ];
}

function renderBuckets(stats: QuantitativeStats, t: ReportText, chart: ReportChart): string[] {
  const title = t('플레이 구간별 게임 수', 'Games by playtime bucket');
  const b = stats.playtimeBuckets;
  const rows: { label: string; count: number }[] = [
    { label: t('미플레이', 'Unplayed'), count: b.unplayed },
    { label: t('1시간 미만', 'Under 1h'), count: b.under1h },
    { label: t('1~10시간', '1-10h'), count: b.h1to10 },
    { label: t('10~100시간', '10-100h'), count: b.h10to100 },
    { label: t('100시간 이상', 'Over 100h'), count: b.over100h },
  ];
  const lines = [`## ${title}`, ''];
  const max = Math.max(...rows.map((r) => r.count), 0);
  if (chart === 'pie') {
    lines.push(...pieBlock(title, rows.map((r) => ({ label: r.label, value: r.count }))), '');
  } else if (chart === 'xychart') {
    lines.push(...xyBarBlock(t('게임 수', 'Games'), rows.map((r) => r.label), rows.map((r) => r.count)), '');
  }
  const labelW = Math.max(...rows.map((r) => displayWidth(r.label)));
  lines.push(`| ${t('구간', 'Bucket')} | ${t('그래프', 'Bar')} | ${t('게임 수', 'Games')} |`);
  lines.push('| --- | --- | --- |');
  for (const r of rows) {
    lines.push(`| ${padWidth(r.label, labelW)} | ${asciiBar(max > 0 ? r.count / max : 0)} | ${r.count} |`);
  }
  lines.push('');
  return lines;
}

function renderRecency(stats: QuantitativeStats, t: ReportText): string[] {
  const r = stats.recency;
  const lines = [`## ${t('최근성 · 백로그', 'Recency · Backlog')}`, ''];
  lines.push(`| ${t('지표', 'Metric')} | ${t('게임 수', 'Games')} |`);
  lines.push('| --- | --- |');
  lines.push(`| ${t('최근 30일 플레이', 'Played in last 30d')} | ${r.playedLast30d} |`);
  lines.push(`| ${t('최근 90일 플레이', 'Played in last 90d')} | ${r.playedLast90d} |`);
  lines.push(`| ${t('최근 1년 플레이', 'Played in last 1y')} | ${r.playedLast365d} |`);
  lines.push(`| ${t('1년 이상 휴면', 'Dormant 1y+')} | ${r.dormantOver1y} |`);
  lines.push(`| ${t('쌓아둔 게임 (미플레이)', 'Backlog (unplayed)')} | ${r.neverPlayed} (${r.neverPlayedPercent}%) |`);
  if (r.unknownLastPlayed > 0) {
    lines.push(`| ${t('최종 플레이 기록 없음', 'No last-played record')} | ${r.unknownLastPlayed} |`);
  }
  lines.push('');
  return lines;
}

function makerTable(
  title: string,
  headers: [string, string],
  rows: string[][],
  emptyNote: string,
): string[] {
  const lines = [`### ${title}`, ''];
  if (rows.length === 0) {
    lines.push(emptyNote, '');
    return lines;
  }
  lines.push(`| ${headers[0]} | ${headers[1]} |`);
  lines.push('| --- | --- |');
  for (const r of rows) lines.push(`| ${r[0]} | ${r[1]} |`);
  lines.push('');
  return lines;
}

function renderMakers(stats: QuantitativeStats, t: ReportText, chart: ReportChart): string[] {
  const m = stats.makers;
  const lines = [`## ${t('제작사 · 출시연도', 'Makers · Release years')}`, ''];
  const emptyNote = t('(정보 없음)', '(no info)');
  const nameH = t('이름', 'Name');
  lines.push(...makerTable(
    t('개발사 (보유 수)', 'Developers (owned)'),
    [nameH, t('게임 수', 'Games')],
    m.topDevelopersByCount.map((d) => [escapeMdCell(d.name), String(d.gameCount)]),
    emptyNote,
  ));
  lines.push(...makerTable(
    t('개발사 (플레이타임)', 'Developers (playtime)'),
    [nameH, t('시간', 'Hours')],
    m.topDevelopersByPlaytime.map((d) => [escapeMdCell(d.name), `${d.playtimeHours}h`]),
    emptyNote,
  ));
  lines.push(...makerTable(
    t('퍼블리셔 (보유 수)', 'Publishers (owned)'),
    [nameH, t('게임 수', 'Games')],
    m.topPublishersByCount.map((d) => [escapeMdCell(d.name), String(d.gameCount)]),
    emptyNote,
  ));
  lines.push(...makerTable(
    t('퍼블리셔 (플레이타임)', 'Publishers (playtime)'),
    [nameH, t('시간', 'Hours')],
    m.topPublishersByPlaytime.map((d) => [escapeMdCell(d.name), `${d.playtimeHours}h`]),
    emptyNote,
  ));

  const years = m.releaseYears;
  const yearTitle = t('출시연도 분포 (보유 게임 수)', 'Release year distribution (owned games)');
  lines.push(`### ${yearTitle}`, '');
  if (years.length === 0) {
    lines.push(emptyNote, '');
  } else {
    if (chart === 'xychart') {
      // 꺾은선은 pie로 표현 불가 — xychart 모드에서만 차트를 얹는다
      lines.push(...xyLineBlock(t('게임 수', 'Games'), years.map((y) => String(y.year)), years.map((y) => y.gameCount)), '');
    }
    lines.push(`| ${t('연도', 'Year')} | ${t('게임 수', 'Games')} |`);
    lines.push('| --- | --- |');
    for (const y of years) lines.push(`| ${y.year} | ${y.gameCount} |`);
    lines.push('');
    if (m.unparsedYearCount > 0) {
      lines.push(t(`* 연도 추출 실패·누락 ${m.unparsedYearCount}개는 분포에서 제외`, `* ${m.unparsedYearCount} games with missing/unparseable year excluded`), '');
    }
  }
  return lines;
}

function renderAchievement(stats: QuantitativeStats, t: ReportText): string[] {
  if (!stats.achievement) return [];
  const a = stats.achievement;
  return [
    `## ${t('업적 달성률', 'Achievement completion')}`,
    '',
    `- ${t(`보유 게임: ${a.count}개, 평균 ${a.avgPercent}%, 중앙값 ${a.medianPercent}% (최소 ${a.minPercent}% / 최대 ${a.maxPercent}%)`, `Games with data: ${a.count}, avg ${a.avgPercent}%, median ${a.medianPercent}% (min ${a.minPercent}% / max ${a.maxPercent}%)`)}`,
    '',
  ];
}

function renderWishlist(stats: QuantitativeStats, t: ReportText): string[] {
  const lines = [`## ${t(`위시리스트: ${stats.wishlist.count}개`, `Wishlist: ${stats.wishlist.count}`)}`, ''];
  for (const title of stats.wishlist.titles) lines.push(`- ${escapeMdCell(title)}`);
  if (stats.wishlist.titles.length > 0) lines.push('');
  return lines;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function renderTrend(trend: TrendStats, t: ReportText): string[] {
  const lines = [`## ${t('지난 리포트 대비 변화', 'Changes since last report')}`, ''];
  lines.push(t(`* 비교 기준: ${trend.prevGeneratedAt}`, `* Compared against: ${trend.prevGeneratedAt}`), '');
  lines.push(`| ${t('지표', 'Metric')} | ${t('변화', 'Change')} |`);
  lines.push('| --- | --- |');
  lines.push(`| ${t('총 플레이타임 (시간)', 'Total playtime (h)')} | ${signed(trend.totalPlaytimeDeltaHours)} |`);
  lines.push(`| ${t('게임 수', 'Games')} | ${signed(trend.gameCountDelta)} |`);
  lines.push('');
  if (trend.newGames.length > 0) {
    lines.push(`### ${t('신규 게임', 'New games')}`, '');
    for (const title of trend.newGames) lines.push(`- ${escapeMdCell(title)}`);
    lines.push('');
  }
  if (trend.topRisers.length > 0) {
    lines.push(`### ${t('플레이타임 증가 상위', 'Top playtime gains')}`, '');
    lines.push(`| ${t('제목', 'Title')} | ${t('증가', 'Gain')} |`);
    lines.push('| --- | --- |');
    for (const r of trend.topRisers) lines.push(`| ${escapeMdCell(r.title)} | +${r.deltaHours}h |`);
    lines.push('');
  }
  return lines;
}

function renderSummary(summary: string | undefined, llmAttempted: boolean, t: ReportText): string[] {
  const lines = [`## ${t('AI 해석', 'AI analysis')}`, ''];
  if (summary) {
    lines.push(summary.trim(), '');
  } else if (llmAttempted) {
    lines.push(t('(LLM 호출 실패 — 해석 없는 정량 리포트)', '(LLM call failed — quantitative-only report)'), '');
  } else {
    lines.push(t('(LLM 미설정 — 해석 없는 정량 리포트)', '(LLM not configured — quantitative-only report)'), '');
  }
  return lines;
}

// ─── 조립 ────────────────────────────────────────────────────

/**
 * 근거 이탈 검사 결과 한 줄 — 위반이 있을 때만 출력, 없으면 아무것도 내지 않는다.
 * analyzeLibrary가 UNKNOWN_GAME 위반만 남기므로, 이 줄이 있으면
 * 라이브러리에 없는 게임명을 summary가 인용한 것이다.
 */
export function renderVerifyNote(verify: VerifyResult | undefined, t: ReportText): string[] {
  const violations = verify?.violations ?? [];
  if (violations.length === 0) return [];
  const details = violations.map((v) => v.detail).join('; ');
  return [
    `- ${t(`근거 검사: ${details}`, `Evidence check: ${details}`)}`,
    '',
  ];
}

export function renderReportMarkdown(
  stats: QuantitativeStats,
  summary: string | undefined,
  generatedAt: Date = new Date(),
  llmAttempted = false,
  t: ReportText = (ko) => ko,
  chart: ReportChart = DEFAULT_REPORT_CHART,
  verify?: VerifyResult,
): string {
  const lines: string[] = [];
  lines.push(`# ${t('QuestTail 취향 리포트', 'QuestTail taste report')}`, '');
  lines.push(`- ${t('생성', 'Generated')}: ${generatedAt.toISOString()}`, '');
  lines.push(...renderHeadline(stats, t), '');

  lines.push(...renderTopGames(stats, t));
  lines.push(...renderGenreDist(stats, t, chart));
  lines.push(...renderGenreDepth(stats, t));
  lines.push(...renderPlaytimeDist(stats, t));
  lines.push(...renderConcentration(stats, t));
  lines.push(...renderBuckets(stats, t, chart));
  lines.push(...renderRecency(stats, t));
  lines.push(...renderMakers(stats, t, chart));
  lines.push(...renderAchievement(stats, t));
  lines.push(...renderWishlist(stats, t));
  if (stats.trend) lines.push(...renderTrend(stats.trend, t));
  lines.push(...renderSummary(summary, llmAttempted, t));
  lines.push(...renderVerifyNote(verify, t));

  return lines.join('\n');
}
