/**
 * games/*.md 게임 노트 — 필드 단위 병합 (D1 규칙).
 *
 * - 객관 필드(title/game_id/platform/source/playtime_minutes/achievement_pct/
 *   last_played/image/genres/developers/publishers/release_date/wishlisted)는
 *   NormalizedGame이 정본이므로 재동기화 때마다 덮어쓴다.
 * - 주관 필드(rating/note/dislike_reasons/status)는 노트가 정본이므로
 *   파일이 이미 있으면 반드시 읽어서 보존한다. (타입 정본: types.ts SubjectiveGameFields)
 * - 본문(body)도 기존 파일이 있으면 그대로 둔다 — 사용자 편집 보호.
 * - 파일명 변경(제목 변경)으로 기존 파일 탐색이 실패하지 않게
 *   `${gameId}-*.md` 폴백 탐색을 한다. 기존 경로를 재사용하므로
 *   고아 파일이 남지 않고, 삭제도 발생하지 않는다.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { NormalizedGame, SubjectiveGameFields } from '../types.js';
import { splitFrontmatterDoc, formatFrontmatter } from './frontmatter.js';

export interface GameNote {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** 객관 필드 키 — 이 키들은 재동기화 때 항상 최신값으로 교체된다. */
export const OBJECTIVE_KEYS = [
  'title',
  'title_ko',
  'game_id',
  'platform',
  'source',
  'playtime_minutes',
  'achievement_pct',
  'last_played',
  'image',
  'genres',
  'developers',
  'publishers',
  'release_date',
  'wishlisted',
] as const;

/** 주관 필드 키 (snake_case, 파일 표기). 파싱 때는 camelCase도 허용한다. */
export const SUBJECTIVE_KEYS = ['rating', 'note', 'dislike_reasons', 'status'] as const;

/**
 * 게임 제목을 파일명용 slug로 변환
 * 예: "The Witcher 3: Wild Hunt" → "the-witcher-3-wild-hunt"
 */
export function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export function gameNoteFilename(game: NormalizedGame): string {
  return `${game.id}-${toSlug(game.title)}.md`;
}

/**
 * 게임 1개를 md 노트로 직렬화 (객관 필드만 — 주관 필드는 mergeGameNote가 채운다).
 * @param prevSubjective  기존 파일에서 보존한 주관 필드 (없으면 생략)
 * @param prevTitleKo     기존 파일의 title_ko. game.titleKo가 undefined일 때만 보존한다.
 *   둘 다 없으면 키를 만들지 않는다 — 없는 게임에 키를 지어내지 않는다.
 */
export function serializeGameNote(game: NormalizedGame, prevSubjective?: SubjectiveGameFields, prevTitleKo?: string): GameNote {
  const frontmatter: Record<string, unknown> = {
    title: game.title,
    ...(game.titleKo !== undefined
      ? { title_ko: game.titleKo }
      : prevTitleKo !== undefined
        ? { title_ko: prevTitleKo }
        : {}),
    // 기존 118개 파일이 game_id를 bare number로 저장하므로 숫자형 id는 숫자로 쓴다
    // (문자열로 쓰면 전 파일에 따옴표 diff가 생긴다). 비숫자 id는 문자열 유지.
    game_id: /^\d+$/.test(game.id) && Number.isSafeInteger(Number(game.id)) ? Number(game.id) : game.id,
    platform: game.platform,
    source: game.source,
    playtime_minutes: game.playtimeMinutes,
  };

  if (game.achievementPercent !== undefined) {
    frontmatter.achievement_pct = game.achievementPercent;
  }
  if (game.lastPlayedAt !== undefined) {
    frontmatter.last_played = game.lastPlayedAt;
  }
  if (game.imageUrl !== undefined) {
    frontmatter.image = game.imageUrl;
  }
  if (game.genres !== undefined && game.genres.length > 0) {
    frontmatter.genres = game.genres;
  }
  if (game.developers !== undefined && game.developers.length > 0) {
    frontmatter.developers = game.developers;
  }
  if (game.publishers !== undefined && game.publishers.length > 0) {
    frontmatter.publishers = game.publishers;
  }
  if (game.releaseDate !== undefined) {
    frontmatter.release_date = game.releaseDate;
  }
  if (game.wishlisted !== undefined) {
    frontmatter.wishlisted = game.wishlisted;
  }

  if (prevSubjective) {
    if (prevSubjective.rating !== undefined) frontmatter.rating = prevSubjective.rating;
    if (prevSubjective.note !== undefined) frontmatter.note = prevSubjective.note;
    if (prevSubjective.dislikeReasons !== undefined && prevSubjective.dislikeReasons.length > 0) {
      frontmatter.dislike_reasons = prevSubjective.dislikeReasons;
    }
    if (prevSubjective.status !== undefined) frontmatter.status = prevSubjective.status;
  }

  const body =
    game.source === 'auto'
      ? `> Steam에서 자동 가져온 게임 데이터입니다.\n`
      : `> 수동으로 추가된 게임입니다.\n`;

  return { frontmatter, body };
}

/** md 문자열을 GameNote로 파싱한다. 펜스가 없으면 전체를 body로 취급한다. */
export function parseGameNote(content: string): GameNote {
  const { frontmatter, body } = splitFrontmatterDoc(content);
  return { frontmatter, body };
}

/** 노트 frontmatter에서 주관 필드만 추출한다. camelCase 표기도 허용한다. */
export function extractSubjectiveFields(note: GameNote): SubjectiveGameFields {
  const fm = note.frontmatter;
  const out: SubjectiveGameFields = {};

  if (typeof fm.rating === 'number') out.rating = fm.rating;

  if (typeof fm.note === 'string') out.note = fm.note;

  const dislike = fm.dislike_reasons ?? fm.dislikeReasons;
  if (Array.isArray(dislike)) {
    const reasons = dislike.filter((v): v is string => typeof v === 'string');
    if (reasons.length > 0) out.dislikeReasons = reasons;
  } else if (typeof dislike === 'string' && dislike !== '') {
    out.dislikeReasons = [dislike];
  }

  if (fm.status === 'playing' || fm.status === 'completed' || fm.status === 'dropped' || fm.status === 'wishlist') {
    out.status = fm.status;
  }

  return out;
}

/**
 * 기존 노트와 최신 객관 데이터를 병합한다.
 * - 객관 필드: game 값으로 교체 (game에 없는 선택 필드는 키 자체를 제거 — 낡은 사본 잔류 방지)
 * - 예외: title_ko는 incoming titleKo가 undefined인데 기존 값이 있으면 보존한다.
 *   ko 일시 실패·미번역이 기존 한글 표기를 지우면 안 되기 때문이다.
 * - 주관 필드: 기존 값 보존 (없으면 생략)
 * - 본문: 기존 본문이 있으면 유지, 없으면(새 파일) 기본 본문 사용
 */
export function mergeGameNote(existing: GameNote | null, game: NormalizedGame): GameNote {
  const prevSubjective = existing ? extractSubjectiveFields(existing) : undefined;
  const prevTitleKo =
    existing && typeof existing.frontmatter.title_ko === 'string' ? existing.frontmatter.title_ko : undefined;
  const fresh = serializeGameNote(game, prevSubjective, prevTitleKo);

  if (existing && existing.body.trim() !== '') {
    fresh.body = existing.body.endsWith('\n') ? existing.body : existing.body + '\n';
  }

  return fresh;
}

/**
 * GameNote를 실제 md 문자열로 변환
 */
export function formatNote(note: GameNote): string {
  return `${formatFrontmatter(note.frontmatter)}\n${note.body}`;
}

/**
 * 게임 노트의 기존 파일 경로를 찾는다.
 * 계산된 파일명이 있으면 그것을, 없으면 같은 gameId의 `id-*.md`를 재사용한다
 * (제목 변경으로 slug가 바뀌어도 기존 파일을 덮어써 고아 파일 방지).
 */
export async function resolveGameNotePath(
  outputDir: string,
  game: NormalizedGame,
): Promise<{ filepath: string; existed: boolean }> {
  const computed = join(outputDir, gameNoteFilename(game));
  try {
    await readFile(computed, 'utf-8');
    return { filepath: computed, existed: true };
  } catch {
    // miss → id 폴백 탐색
  }

  try {
    const entries = await readdir(outputDir);
    const prefix = `${game.id}-`;
    const match = entries.filter(e => e.startsWith(prefix) && e.endsWith('.md')).sort()[0];
    if (match) {
      return { filepath: join(outputDir, match), existed: true };
    }
  } catch {
    // 디렉토리 자체가 없으면 신규扱い
  }

  return { filepath: computed, existed: false };
}

/**
 * 게임 노트를 디스크에 쓴다. 파일이 이미 있으면 주관 필드·본문을 보존하고
 * 객관 필드만 최신값으로 교체한다 (필드 단위 병합). 없으면 새로 생성한다.
 *
 * @param outputDir  출력 디렉토리 경로
 * @param game       정규화된 게임 데이터
 * @param note       명시적 노트 (주면 병합 없이 그대로 쓴다 — 하위 호환용)
 * @returns 생성/갱신된 파일 경로
 */
export async function writeGameNote(
  outputDir: string,
  game: NormalizedGame,
  note?: GameNote,
): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  if (note !== undefined) {
    const filepath = join(outputDir, gameNoteFilename(game));
    await writeFile(filepath, formatNote(note), 'utf-8');
    return filepath;
  }

  const { filepath, existed } = await resolveGameNotePath(outputDir, game);

  let existing: GameNote | null = null;
  if (existed) {
    existing = parseGameNote(await readFile(filepath, 'utf-8'));
  }

  const merged = mergeGameNote(existing, game);
  await writeFile(filepath, formatNote(merged), 'utf-8');

  return filepath;
}
