/**
 * tools/rebuild-library.ts — 실데이터 파생 재생성 (P3, 워커 C 소유).
 *
 * 마이그레이션된 games 노트를 입력으로 `writeLibraryIndex`만 호출한다.
 * `gather`를 호출하지 않는다 — gather는 노트까지 전부 덮어써 마이그레이션을 무효로 만든다.
 * history append도 하지 않는다.
 *
 * - 120건 조립 순서는 기존 games/library.md의 id 순서를 유지한다.
 * - title_ko는 library에 넣지 않는다. 주관 필드도 넣지 않는다.
 * - generated_at은 --apply 시 현재 시각으로 갱신한다(dry-run에서는 기존값 기준 비교).
 * - 기존 library id 집합과 노트 id 집합이 다르면 쓰기 전에 중단한다(exit 1).
 *
 * 기본은 dry-run이다. 쓰기는 명시적 --apply에서만 일어난다.
 *
 * 실행(이번 요청은 --apply 없이 dry-run만):
 *   pnpm tsx tools/rebuild-library.ts
 *   pnpm tsx tools/rebuild-library.ts --apply   # 오케스트레이터 승인 후
 *
 * 이 파일을 직접 실행했을 때만 돈다. import만으로는 돌지 않는다.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGameNote } from '../packages/core/src/storage/gameNote.js';
import { parseLibraryMarkdown, writeLibraryIndex, renderLibraryMarkdown } from '../packages/core/src/storage/library.js';
import type { NormalizedGame, Platform, GameSource } from '../packages/core/src/types.js';

const REPO_ROOT = resolve(join(new URL('.', import.meta.url).pathname, '..'));
const GAMES_DIR = join(REPO_ROOT, 'games');
const LIBRARY_PATH = join(GAMES_DIR, 'library.md');

const PLATFORMS: readonly string[] = ['steam', 'psn', 'xbox', 'manual'];
const SOURCES: readonly string[] = ['auto', 'manual'];

function usage(): string {
  return [
    '사용법: pnpm tsx tools/rebuild-library.ts [--apply]',
    '',
    '  --apply  명시해야 쓴다. 없으면 dry-run(읽기만, exit 코드로 판정)',
  ].join('\n');
}

/** 노트 1건을 NormalizedGame으로 조립한다. 불가하면 예외 메시지를 돌려준다. */
function assembleNote(fm: Record<string, unknown>, filepath: string): { game?: NormalizedGame; error?: string } {
  // title_ko·주관 키(rating/note/dislike_reasons/status)는 읽지 않는다 — library에 내려가지 않는다.
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length > 0 ? (v as string[]) : undefined;

  const rawId = fm.game_id;
  const id = typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : '';
  const title = str(fm.title);
  const platform = str(fm.platform);
  const source = str(fm.source);
  const playtime = num(fm.playtime_minutes);
  if (id === '') return { error: `${filepath}: game_id 결측` };
  if (!title) return { error: `${filepath}: title 결측` };
  if (!platform || !PLATFORMS.includes(platform)) return { error: `${filepath}: platform 비정상(${String(fm.platform)})` };
  if (!source || !SOURCES.includes(source)) return { error: `${filepath}: source 비정상(${String(fm.source)})` };
  if (playtime === undefined) return { error: `${filepath}: playtime_minutes 결측` };

  const game: NormalizedGame = {
    id,
    platform: platform as Platform,
    title,
    source: source as GameSource,
    playtimeMinutes: playtime,
  };
  const ach = num(fm.achievement_pct);
  if (ach !== undefined) game.achievementPercent = ach;
  const lp = num(fm.last_played);
  if (lp !== undefined) game.lastPlayedAt = lp;
  // image는 노트 frontmatter.image를 그대로 조립한다 — library 스키마에 image 열이 있어 재생성에서 보존된다.
  const img = str(fm.image);
  if (img !== undefined) game.imageUrl = img;
  const genres = strArr(fm.genres);
  if (genres) game.genres = [...genres];
  const devs = strArr(fm.developers);
  if (devs) game.developers = [...devs];
  const pubs = strArr(fm.publishers);
  if (pubs) game.publishers = [...pubs];
  const rd = str(fm.release_date);
  if (rd !== undefined) game.releaseDate = rd;
  if (fm.wishlisted === true) game.wishlisted = true;
  else if (fm.wishlisted === false) game.wishlisted = false;
  else if (fm.wishlisted !== undefined) return { error: `${filepath}: wishlisted 비정상(${String(fm.wishlisted)})` };
  for (const k of ['genres', 'developers', 'publishers']) {
    if (fm[k] !== undefined && !Array.isArray(fm[k])) return { error: `${filepath}: ${k}가 배열이 아니다` };
  }
  return { game };
}

async function main(): Promise<void> {
  let apply = false;
  for (const a of process.argv.slice(2)) {
    if (a === '--apply') apply = true;
    else if (a === '--help' || a === '-h') {
      console.error(usage());
      process.exit(0);
    } else throw new Error(`[rebuild-library] 알 수 없는 인자 "${a}"\n${usage()}`);
  }

  const libText = await readFile(LIBRARY_PATH, 'utf-8');
  const existing = parseLibraryMarkdown(libText);
  const libOrder = existing.games.map((g) => g.id);

  const files = (await readdir(GAMES_DIR)).filter((f) => f.endsWith('.md') && f !== 'library.md').sort();
  const byId = new Map<string, NormalizedGame>();
  const exceptions: string[] = [];
  for (const f of files) {
    const filepath = join(GAMES_DIR, f);
    let fm: Record<string, unknown>;
    try {
      fm = parseGameNote(await readFile(filepath, 'utf-8')).frontmatter;
    } catch (err) {
      exceptions.push(`${filepath}: 파싱 실패(${String(err)})`);
      continue;
    }
    const { game, error } = assembleNote(fm, filepath);
    if (error) {
      exceptions.push(error);
      continue;
    }
    if (byId.has(game!.id)) exceptions.push(`${filepath}: game_id 중복(${game!.id})`);
    byId.set(game!.id, game!);
  }

  // id 집합 대조 — 다르면 쓰기 전에 중단한다.
  const libSet = new Set(libOrder);
  const noteSet = new Set(byId.keys());
  const onlyLib = libOrder.filter((id) => !noteSet.has(id));
  const onlyNote = [...noteSet].filter((id) => !libSet.has(id));
  const fatals: string[] = [];
  if (onlyLib.length > 0) fatals.push(`library에만 있음: ${onlyLib.join(',')}`);
  if (onlyNote.length > 0) fatals.push(`노트에만 있음: ${onlyNote.join(',')}`);
  for (const e of exceptions) fatals.push(e);

  const ordered = libOrder.map((id) => byId.get(id)).filter((g): g is NormalizedGame => g !== undefined);

  // 행 단위 변경 수 — 기존 generated_at 기준 렌더와 비교한다.
  let changedRows = 0;
  const changedIds: string[] = [];
  if (fatals.length === 0) {
    const prev = new Map(existing.games.map((g) => [g.id, g]));
    for (const g of ordered) {
      if (JSON.stringify(prev.get(g.id)) !== JSON.stringify(g)) {
        changedRows++;
        changedIds.push(g.id);
      }
    }
  }
  const rendered = renderLibraryMarkdown({ generatedAt: existing.generatedAt, games: ordered });
  if (fatals.length === 0 && changedRows === 0 && rendered !== libText) {
    fatals.push('조립 결과 동일 판정인데 렌더가 기존 파일과 다름(파서/렌더 불일치) — 보고 필요');
  }

  console.log(`[rebuild-library] mode=${apply ? 'APPLY' : 'dry-run'}`);
  console.log(`[rebuild-library] 대상 노트 ${files.length}건, library 행 ${existing.games.length}건`);
  console.log(`[rebuild-library] 변경 행 ${changedRows}건`);
  for (const id of changedIds) console.log(`[rebuild-library]   CHG game_id=${id}`);
  console.log(`[rebuild-library] 기존 generated_at=${existing.generatedAt}${apply ? ' → 적용 시 현재 시각으로 갱신' : ''}`);
  if (exceptions.length > 0) {
    console.log(`[rebuild-library] 결측·예외 ${exceptions.length}건:`);
    for (const e of exceptions) console.log(`[rebuild-library]   EXC ${e}`);
  }

  if (fatals.length > 0) {
    console.log(`[rebuild-library] 치명 ${fatals.length}건 — 쓰기 전 중단한다:`);
    for (const f of fatals) console.log(`[rebuild-library]   FATAL ${f}`);
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log('[rebuild-library] dry-run — 파일을 쓰지 않았다');
    return;
  }
  const written = await writeLibraryIndex(GAMES_DIR, ordered);
  console.log(`[rebuild-library] APPLY 완료 — ${written} 기록(${ordered.length}건)`);
}

const IS_ENTRY = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_ENTRY) {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
