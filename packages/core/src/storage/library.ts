/**
 * library.md — 객관 데이터의 정본 (D1).
 *
 * LibraryIndex 타입(types.ts)을 md 1개로 표현한다:
 * frontmatter에 generated_at/game_count, 본문에 전 게임 × 전 축 테이블.
 * 주관 필드(rating/note/dislikeReasons/status)는 절대 실리지 않는다.
 * 주관 데이터가 없으므로 gather 실행마다 통째로 다시 써도 안전하다.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LibraryIndex, NormalizedGame } from '../types.js';
import { splitFrontmatterDoc, formatFrontmatter } from './frontmatter.js';

export const LIBRARY_FILENAME = 'library.md';

/** 테이블 컬럼 순서 (전 축: 플레이타임·업적률·장르·플랫폼 + D5 승격 필드 + 커버 이미지). */
const COLUMNS = [
  'title',
  'game_id',
  'platform',
  'source',
  'playtime_minutes',
  'achievement_pct',
  'last_played',
  'genres',
  'developers',
  'publishers',
  'release_date',
  'wishlisted',
  'image',
] as const;

/** image 컬럼 추가 전 구 스키마(12열) 파일도 파싱한다 — 하위 호환. */
const LEGACY_COLUMN_COUNT = COLUMNS.length - 1;

function escapeCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function unescapeCell(value: string): string {
  return value.replace(/\\\|/g, '|').replace(/\\\\/g, '\\').trim();
}

function cellFor(game: NormalizedGame, col: (typeof COLUMNS)[number]): string {
  switch (col) {
    case 'title':
      return escapeCell(game.title);
    case 'game_id':
      return escapeCell(game.id);
    case 'platform':
      return game.platform;
    case 'source':
      return game.source;
    case 'playtime_minutes':
      return String(game.playtimeMinutes);
    case 'achievement_pct':
      return game.achievementPercent !== undefined ? String(game.achievementPercent) : '';
    case 'last_played':
      return game.lastPlayedAt !== undefined ? String(game.lastPlayedAt) : '';
    case 'genres':
      return game.genres?.length ? escapeCell(JSON.stringify(game.genres)) : '';
    case 'developers':
      return game.developers?.length ? escapeCell(JSON.stringify(game.developers)) : '';
    case 'publishers':
      return game.publishers?.length ? escapeCell(JSON.stringify(game.publishers)) : '';
    case 'release_date':
      return game.releaseDate ? escapeCell(game.releaseDate) : '';
    case 'wishlisted':
      return game.wishlisted !== undefined ? String(game.wishlisted) : '';
    case 'image':
      return game.imageUrl ? escapeCell(game.imageUrl) : '';
  }
}

function splitList(cell: string): string[] | undefined {
  const v = unescapeCell(cell);
  if (v === '') return undefined;
  // 새 JSON 형식 — `[`로 시작하면 JSON 배열로 파싱 (콤마 포함 값 보존용).
  if (v.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) {
        return parsed.length > 0 ? (parsed as string[]) : undefined;
      }
    } catch {
      // JSON 파싱 실패 시 아래 레거시 경로로 폴백한다.
    }
  }
  // 기존 파일 호환용 레거시 콤마 분리 — 언젠가 제거 가능.
  const items = v
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '');
  return items.length > 0 ? items : undefined;
}

function optNumber(cell: string): number | undefined {
  const v = cell.trim();
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * LibraryIndex를 library.md 문자열로 렌더링한다.
 */
export function renderLibraryMarkdown(index: LibraryIndex): string {
  const frontmatter = formatFrontmatter({
    generated_at: index.generatedAt,
    game_count: index.games.length,
  });

  const header = `| ${COLUMNS.join(' | ')} |`;
  const separator = `| ${COLUMNS.map(() => '---').join(' | ')} |`;
  const rows = index.games.map(g => `| ${COLUMNS.map(c => cellFor(g, c)).join(' | ')} |`);

  const body = ['# QuestTail Library', '', header, separator, ...rows, ''].join('\n');

  return `${frontmatter}\n${body}`;
}

/** 테이블 행을 `|` 기준으로 나누되 `\|` 이스케이프를 보존한다. */
function splitRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|')) return null;
  const inner = t.slice(1, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && i + 1 < inner.length && (inner[i + 1] === '|' || inner[i + 1] === '\\')) {
      cur += ch + inner[i + 1];
      i++;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * library.md 문자열을 LibraryIndex로 되돌린다 (검수·라운드트립용).
 * 테이블 외 본문(제목 등)은 무시한다.
 */
export function parseLibraryMarkdown(content: string): LibraryIndex {
  const { frontmatter, body } = splitFrontmatterDoc(content);
  const generatedAt = typeof frontmatter.generated_at === 'number' ? frontmatter.generated_at : 0;

  const games: NormalizedGame[] = [];
  const lines = body.split('\n');
  let headerSeen = false;

  for (const line of lines) {
    const cells = splitRow(line);
    if (!cells) continue;
    if (!headerSeen) {
      if (cells[0] === 'title') headerSeen = true;
      continue;
    }
    if (cells.every(c => /^-+$/.test(c))) continue;
    // 구 스키마(12열, image 없음) 파일도 읽는다 — image만 비워 둔다.
    if (cells.length !== COLUMNS.length && cells.length !== LEGACY_COLUMN_COUNT) continue;

    const [
      title,
      gameId,
      platform,
      source,
      playtimeMinutes,
      achievementPct,
      lastPlayed,
      genres,
      developers,
      publishers,
      releaseDate,
      wishlisted,
      image,
    ] = cells as string[];

    if (platform !== 'steam' && platform !== 'psn' && platform !== 'xbox' && platform !== 'manual') continue;
    if (source !== 'auto' && source !== 'manual') continue;

    const game: NormalizedGame = {
      id: unescapeCell(gameId ?? ''),
      platform,
      title: unescapeCell(title ?? ''),
      source,
      playtimeMinutes: optNumber(playtimeMinutes ?? '') ?? 0,
    };

    const ach = optNumber(achievementPct ?? '');
    if (ach !== undefined) game.achievementPercent = ach;
    const lp = optNumber(lastPlayed ?? '');
    if (lp !== undefined) game.lastPlayedAt = lp;
    const g = splitList(genres ?? '');
    if (g) game.genres = g;
    const d = splitList(developers ?? '');
    if (d) game.developers = d;
    const p = splitList(publishers ?? '');
    if (p) game.publishers = p;
    const rd = unescapeCell(releaseDate ?? '');
    if (rd !== '') game.releaseDate = rd;
    const w = (wishlisted ?? '').trim();
    if (w === 'true') game.wishlisted = true;
    else if (w === 'false') game.wishlisted = false;
    const img = unescapeCell(image ?? '');
    if (img !== '') game.imageUrl = img;

    games.push(game);
  }

  return { generatedAt, games };
}

/**
 * outputDir/library.md를 최신 NormalizedGame[]로 다시 쓴다 (통째 재생성 안전).
 * @returns 생성된 파일 경로
 */
export async function writeLibraryIndex(
  outputDir: string,
  games: NormalizedGame[],
  generatedAt: number = Date.now(),
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const filepath = join(outputDir, LIBRARY_FILENAME);
  await writeFile(filepath, renderLibraryMarkdown({ generatedAt, games }), 'utf-8');
  return filepath;
}
