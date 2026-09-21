/**
 * tools/migrate-d9.ts — D9 정본 마이그레이션 (P3, 워커 C 소유).
 *
 * games 노트 120건(real) 또는 eval 픽스처(fixture)의 장르·날짜를 영어 정본으로 옮긴다.
 * `gather`를 호출하지 않는다 — 노트를 통째로 재생성하면 주관 필드와 P3 입력이 깨진다.
 * 전면 라인 단위 수술 방식이다: frontmatter 재직렬화를 하지 않으므로
 * 코스메틱 rewrite가 없고, 손대지 않은 키·순서·주관 필드·본문은 바이트 동일하게 남는다.
 *
 * 기본은 dry-run이다. 쓰기는 명시적 --apply에서만 일어난다.
 * 중단 조건(하나라도 해당하면 쓰기 전 전체 중단, exit 1):
 * - real: v2 캐시 missing, 파생 releaseDate가 없는데 기존 값이 비어 있지 않은 비ISO 값,
 *   genre-ko 표에 없는 기존 장르값(unmapped) 1건이라도 존재
 * - fixture: genre-ko 표에 없는 장르값(unmapped) 1건이라도 존재
 * - 주관 필드(rating/note/dislike_reasons/status) 또는 body가 적용 전후로 다름
 * - 위 두 가지 외 다른 frontmatter 키·값이 전후로 다름
 * - fixture 파생 3파일에서 장르명 외 값이 바뀜
 * (경고 후 원값 유지는 하지 않는다 — 표 외 값은 전부 fatal이다.)
 *
 * 실행(이번 요청은 --apply 없이 dry-run만):
 *   pnpm tsx tools/migrate-d9.ts --target real
 *   pnpm tsx tools/migrate-d9.ts --target fixture
 *   pnpm tsx tools/migrate-d9.ts --target real --apply   # 오케스트레이터 승인 후
 *
 * 이 파일을 직접 실행했을 때만 돈다. import만으로는 돌지 않는다.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveGameMeta, type AppDetailsData } from '../packages/core/src/metadata/index.js';
import { parseGameNote, extractSubjectiveFields } from '../packages/core/src/storage/gameNote.js';
import { splitFrontmatterDoc, formatScalar } from '../packages/core/src/storage/frontmatter.js';
import { parseLibraryMarkdown } from '../packages/core/src/storage/library.js';

const REPO_ROOT = resolve(join(new URL('.', import.meta.url).pathname, '..'));
const GAMES_DIR = join(REPO_ROOT, 'games');
const MOCK_DIR = join(REPO_ROOT, 'tools', 'eval', 'data', 'mock');
const MOCK_GAMES_DIR = join(MOCK_DIR, 'games');
const GENRE_KO_PATH = join(REPO_ROOT, 'tools', 'genre-ko.json');
const CACHE_DIR = join(REPO_ROOT, '.cache', 'appdetails');

const MIGRATED_KEYS = new Set(['genres', 'release_date', 'title_ko']);
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

type Target = 'real' | 'fixture';

interface FilePlan {
  path: string;
  kinds: string[];
  before: string;
  after: string;
}

function usage(): string {
  return [
    '사용법: pnpm tsx tools/migrate-d9.ts --target <real|fixture> [--apply]',
    '',
    '  --target real|fixture  필수. real=games/*.md 120건, fixture=tools/eval/data/mock 171건+파생 3파일',
    '  --apply                명시해야 쓴다. 없으면 dry-run(읽기만, exit 코드로 판정)',
  ].join('\n');
}

function parseArgs(argv: string[]): { target: Target; apply: boolean } {
  let target: Target | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') {
      const v = argv[++i];
      if (v !== 'real' && v !== 'fixture') throw new Error(`[migrate-d9] --target은 real|fixture이다\n${usage()}`);
      target = v;
    } else if (a === '--apply') {
      apply = true;
    } else if (a === '--help' || a === '-h') {
      console.error(usage());
      process.exit(0);
    } else {
      throw new Error(`[migrate-d9] 알 수 없는 인자 "${a}"\n${usage()}`);
    }
  }
  if (!target) throw new Error(`[migrate-d9] --target이 필수다\n${usage()}`);
  return { target, apply };
}

/** tools/genre-ko.json(id → {en, ko})을 ko → en 단일 표로 뒤집는다. */
async function loadKoToEn(): Promise<Map<string, string>> {
  const parsed: unknown = JSON.parse(await readFile(GENRE_KO_PATH, 'utf-8'));
  if (typeof parsed !== 'object' || parsed === null) throw new Error('[migrate-d9] genre-ko.json: 최상위가 객체가 아니다');
  const out = new Map<string, string>();
  for (const [id, v] of Object.entries(parsed)) {
    const rec = v as Record<string, unknown>;
    if (typeof rec.en !== 'string' || rec.en === '' || typeof rec.ko !== 'string' || rec.ko === '') {
      throw new Error(`[migrate-d9] genre-ko.json: id ${id} 항목의 en/ko가 비어 있다`);
    }
    out.set(rec.ko, rec.en);
  }
  return out;
}

/** frontmatter를 여는 펜스 다음 줄~닫는 펜스 이전 줄로 나눈다. */
function splitDoc(before: string, filepath: string, fatals: string[]): { fm: string[]; tail: string[] } | null {
  const lines = before.split('\n');
  if (lines[0]?.trim() !== '---') {
    fatals.push(`${filepath}: frontmatter 펜스가 없다`);
    return null;
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    fatals.push(`${filepath}: 닫는 펜스가 없다`);
    return null;
  }
  return { fm: lines.slice(1, end), tail: lines.slice(end) };
}

function fmLineIndex(fm: string[], key: string): number {
  return fm.findIndex((l) => new RegExp(`^${key}:\\s*(.*)$`).exec(l) !== null);
}

function fmLineValue(fm: string[], idx: number, key: string): string {
  const m = new RegExp(`^${key}:\\s*(.*)$`).exec(fm[idx] ?? '');
  return (m?.[1] ?? '').trim();
}

/** genres: 블록(키 줄 + `  - item` 줄들)의 범위. 없으면 null. */
function genresBlock(fm: string[]): { start: number; end: number; items: string[] } | null {
  const start = fm.findIndex((l) => /^genres:\s*$/.test(l));
  if (start === -1) return null;
  const items: string[] = [];
  let end = start;
  for (let i = start + 1; i < fm.length; i++) {
    const m = /^\s*-\s(.*)$/.exec(fm[i]);
    if (!m) break;
    items.push(m[1].trim());
    end = i;
  }
  return { start, end, items };
}

function isEmptyScalar(v: string): boolean {
  return v === '' || v === '""' || v === "''";
}

/**
 * 적용 전후 동일성 검사 — 주관 필드·body·그 외 키가 하나라도 다르면 위반 메시지를 돌려준다.
 * migratedKeys(genres/release_date/title_ko)는 비교에서 제외한다.
 */
function verifyUntouched(before: string, after: string): string | null {
  const b = parseGameNote(before);
  const a = parseGameNote(after);
  if (JSON.stringify(extractSubjectiveFields(b)) !== JSON.stringify(extractSubjectiveFields(a))) {
    return '주관 필드 변경됨';
  }
  if (b.body !== a.body) return '본문 변경됨';
  const bf: Record<string, unknown> = { ...b.frontmatter };
  const af: Record<string, unknown> = { ...a.frontmatter };
  for (const k of MIGRATED_KEYS) {
    delete bf[k];
    delete af[k];
  }
  if (JSON.stringify(bf) !== JSON.stringify(af)) return '마이그레이션 외 키 변경됨';
  return null;
}

function rebuildDoc(fm: string[], tail: string[]): string {
  return ['---', ...fm, ...tail].join('\n');
}

// ─── real: games/*.md 120건 ──────────────────────────────────────────

interface CacheV2 {
  v: number;
  appId: string;
  notFound: boolean;
  raw: { en: unknown; ko: unknown };
}

async function planRealNote(
  filepath: string,
  koToEn: Map<string, string>,
  unmapped: string[],
  fatals: string[],
): Promise<FilePlan | null> {
  const before = await readFile(filepath, 'utf-8');
  const doc = splitDoc(before, filepath, fatals);
  if (!doc) return null;
  const { fm, tail } = doc;

  const gIdx = fmLineIndex(fm, 'game_id');
  const gameId = gIdx >= 0 ? fmLineValue(fm, gIdx, 'game_id') : '';
  if (gameId === '') {
    fatals.push(`${filepath}: game_id가 없다`);
    return null;
  }

  let cache: CacheV2;
  try {
    cache = JSON.parse(await readFile(join(CACHE_DIR, `${gameId}.json`), 'utf-8')) as CacheV2;
  } catch {
    fatals.push(`${filepath}: v2 캐시 없음(appId=${gameId}) — 쓰기 전 중단`);
    return null;
  }
  if (cache.v !== 2 || cache.appId !== gameId) {
    fatals.push(`${filepath}: v2 캐시 아님(appId=${gameId}) — 쓰기 전 중단`);
    return null;
  }
  const meta = deriveGameMeta(
    {
      en: cache.notFound ? null : (cache.raw.en as AppDetailsData | null),
      ko: cache.notFound ? null : (cache.raw.ko as AppDetailsData | null),
    },
    gameId,
  );

  const kinds: string[] = [];

  // genres — 파생 영문 정본으로 교체. 파생이 비면 기존 값을 ko 표로 변환, 기존도 없으면 미지정 유지.
  const block = genresBlock(fm);
  const derived = (meta.genres ?? []).map((g) => g.name).filter((s) => s.length > 0);
  if (derived.length > 0) {
    const items = derived.map((n) => `  - ${formatScalar(n)}`);
    if (block) {
      fm.splice(block.start, block.end - block.start + 1, 'genres:', ...items);
      kinds.push('genres=교체');
    } else {
      fm.push('genres:', ...items);
      kinds.push('genres=추가');
    }
  } else if (block && block.items.length > 0) {
    const mapped = block.items.map((ko) => {
      const en = koToEn.get(ko);
      if (!en) unmapped.push(`${filepath}: genre-ko 표에 없는 기존 값 "${ko}"`);
      return `  - ${formatScalar(en ?? ko)}`;
    });
    fm.splice(block.start, block.end - block.start + 1, 'genres:', ...mapped);
    kinds.push('genres=ko표변환');
  }

  // release_date — 파생 ISO가 있으면 교체(없으면 추가). 파생이 없으면 빈 문자열 키 제거,
  // 비어 있지 않은 비ISO 값은 삭제하지 말고 전체 중단.
  const rIdx = fmLineIndex(fm, 'release_date');
  if (meta.releaseDate !== undefined) {
    if (!ISO_RE.test(meta.releaseDate)) {
      fatals.push(`${filepath}: 파생 releaseDate가 ISO가 아니다(${meta.releaseDate})`);
      return null;
    }
    if (rIdx >= 0) {
      if (fmLineValue(fm, rIdx, 'release_date') !== meta.releaseDate) {
        fm[rIdx] = `release_date: ${meta.releaseDate}`;
        kinds.push('release_date=교체');
      }
    } else {
      fm.push(`release_date: ${meta.releaseDate}`);
      kinds.push('release_date=추가');
    }
  } else if (rIdx >= 0) {
    const cur = fmLineValue(fm, rIdx, 'release_date');
    if (isEmptyScalar(cur)) {
      fm.splice(rIdx, 1);
      kinds.push('release_date=제거(빈값)');
    } else if (!ISO_RE.test(cur)) {
      fatals.push(`${filepath}: 파생 날짜 없음 + 기존 비ISO 값 "${cur}" — 삭제 없이 중단`);
      return null;
    }
  }

  // title_ko — nameKo가 있을 때만 title 바로 다음에 추가(이미 있으면 교체).
  if (meta.nameKo !== undefined) {
    const tIdx = fmLineIndex(fm, 'title');
    if (tIdx === -1) {
      fatals.push(`${filepath}: title 키가 없다`);
      return null;
    }
    const line = `title_ko: ${formatScalar(meta.nameKo)}`;
    const kIdx = fmLineIndex(fm, 'title_ko');
    if (kIdx >= 0) {
      if (fm[kIdx] !== line) {
        fm[kIdx] = line;
        kinds.push('title_ko=교체');
      }
    } else {
      fm.splice(tIdx + 1, 0, line);
      kinds.push('title_ko=추가');
    }
  }

  const after = rebuildDoc(fm, tail);
  if (after === before) return null;
  const violation = verifyUntouched(before, after);
  if (violation) {
    fatals.push(`${filepath}: ${violation} — 쓰기 전 중단`);
    return null;
  }
  return { path: filepath, kinds, before, after };
}

// ─── fixture: mock 171건 + 파생 3파일 ────────────────────────────────

async function planFixtureNote(
  filepath: string,
  koToEn: Map<string, string>,
  unmapped: string[],
  fatals: string[],
): Promise<FilePlan | null> {
  const before = await readFile(filepath, 'utf-8');
  const doc = splitDoc(before, filepath, fatals);
  if (!doc) return null;
  const { fm, tail } = doc;
  const block = genresBlock(fm);
  if (!block) return null; // 의도적 함정(장르 누락 4건) — 없으면 그대로 둔다
  const mapped = block.items.map((ko) => {
    const en = koToEn.get(ko);
    if (!en) unmapped.push(`${filepath}: genre-ko 표에 없는 값 "${ko}"`);
    return `  - ${formatScalar(en ?? ko)}`;
  });
  fm.splice(block.start, block.end - block.start + 1, 'genres:', ...mapped);
  const after = rebuildDoc(fm, tail);
  if (after === before) return null;
  const violation = verifyUntouched(before, after);
  if (violation) {
    fatals.push(`${filepath}: ${violation} — 쓰기 전 중단`);
    return null;
  }
  return { path: filepath, kinds: ['genres=ko→en'], before, after };
}

/** `|` 기준 분할 — `\|` 이스케이프를 보존하고 각 셀의 원문 구간도 돌려준다. */
function splitRowRaw(line: string): { cells: string[]; spans: Array<[number, number]> } | null {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|')) return null;
  const start = line.indexOf('|');
  const end = line.lastIndexOf('|');
  const inner = line.slice(start + 1, end);
  const cells: string[] = [];
  const spans: Array<[number, number]> = [];
  let cur = '';
  let curStart = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '\\' && i + 1 < inner.length && (inner[i + 1] === '|' || inner[i + 1] === '\\')) {
      cur += ch + inner[i + 1];
      i++;
    } else if (ch === '|') {
      cells.push(cur.trim());
      spans.push([start + 1 + curStart, start + 1 + i]);
      cur = '';
      curStart = i + 1;
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  spans.push([start + 1 + curStart, start + 1 + inner.length]);
  return { cells, spans };
}

/** mock/library.md — genres 셀(JSON 배열)만 ko→en. 나머지 바이트는 손대지 않는다. */
async function planFixtureLibrary(
  koToEn: Map<string, string>,
  unmapped: string[],
  fatals: string[],
): Promise<FilePlan | null> {
  const path = join(MOCK_DIR, 'library.md');
  const before = await readFile(path, 'utf-8');
  const lines = before.split('\n');
  let changed = 0;
  const out = lines.map((line) => {
    const row = splitRowRaw(line);
    if (!row || row.cells.length < 12) return line;
    if (row.cells[0] === 'title' || /^-+$/.test(row.cells[0] ?? '')) return line;
    const [s, e] = row.spans[7];
    const rawCell = line.slice(s, e);
    // 셀의 선행·후행 공백은 그대로 보존하고 장르 JSON 문자열 구간만 교체한다.
    const leadWs = (rawCell.match(/^\s*/) ?? [''])[0];
    const trailWs = (rawCell.match(/\s*$/) ?? [''])[0];
    const middle = rawCell.slice(leadWs.length, rawCell.length - trailWs.length);
    const v = middle.replace(/\\\|/g, '|').replace(/\\\\/g, '\\');
    if (v === '') return line;
    if (middle !== v) {
      // 이스케이프 포함 셀 — 바이트 안전 치환이 불가하므로 중단한다.
      fatals.push(`${path}: genres 셀에 이스케이프 포함(${v.slice(0, 60)}) — 쓰기 전 중단`);
      return line;
    }
    let arr: unknown;
    try {
      arr = JSON.parse(v);
    } catch {
      fatals.push(`${path}: genres 셀 JSON 파싱 실패(${v.slice(0, 60)})`);
      return line;
    }
    if (!Array.isArray(arr) || !arr.every((x) => typeof x === 'string')) {
      fatals.push(`${path}: genres 셀이 문자열 배열이 아니다`);
      return line;
    }
    const mapped = (arr as string[]).map((ko) => {
      const en = koToEn.get(ko);
      if (!en) unmapped.push(`${path}: genre-ko 표에 없는 값 "${ko}"`);
      return en ?? ko;
    });
    const next = JSON.stringify(mapped);
    if (next === v) return line;
    changed++;
    return `${line.slice(0, s)}${leadWs}${next}${trailWs}${line.slice(e)}`;
  });
  const after = out.join('\n');
  if (after === before) return null;
  if (fatals.length > 0) return null;
  // 재계산 금지 검증 — 장르 외 모든 행·값이 동일해야 한다.
  const b = parseLibraryMarkdown(before);
  const a = parseLibraryMarkdown(after);
  const strip = (g: { genres?: string[] }): string =>
    JSON.stringify({ ...g, genres: '@GENRES@' });
  if (
    b.games.length !== a.games.length ||
    b.games.some((g, i) => g.id !== a.games[i].id || strip(g) !== strip(a.games[i])) ||
    JSON.stringify(splitFrontmatterDoc(before).frontmatter) !==
      JSON.stringify({ ...splitFrontmatterDoc(after).frontmatter })
  ) {
    fatals.push(`${path}: 장르 셀 외 값이 바뀌었다 — 쓰기 전 중단`);
    return null;
  }
  return { path, kinds: [`genres셀=${changed}행`], before, after };
}

/** mock/taste-profile.json — topGenres/dislikedGenres의 장르명만 ko→en. 숫자·배열 나머지 불변 검증. */
async function planFixtureProfile(
  koToEn: Map<string, string>,
  unmapped: string[],
  fatals: string[],
): Promise<FilePlan | null> {
  const path = join(MOCK_DIR, 'taste-profile.json');
  const before = await readFile(path, 'utf-8');
  let parsed: { topGenres: { genre: string; weight: number }[]; dislikedGenres?: string[] };
  try {
    parsed = JSON.parse(before);
  } catch {
    fatals.push(`${path}: JSON 파싱 실패`);
    return null;
  }
  let changed = 0;
  let after = before;
  const swap = (ko: string): string => {
    const en = koToEn.get(ko);
    if (!en) {
      unmapped.push(`${path}: genre-ko 표에 없는 값 "${ko}"`);
      return ko;
    }
    return en;
  };
  for (const g of parsed.topGenres ?? []) {
    const next = swap(g.genre);
    if (next !== g.genre) {
      after = after.replace(`"genre": ${JSON.stringify(g.genre)}`, `"genre": ${JSON.stringify(next)}`);
      changed++;
    }
  }
  const m = /"dislikedGenres":\s*\[([\s\S]*?)\]/.exec(after);
  if (m) {
    let blockText = m[1];
    for (const ko of parsed.dislikedGenres ?? []) {
      const next = swap(ko);
      if (next !== ko) {
        blockText = blockText.replace(JSON.stringify(ko), JSON.stringify(next));
        changed++;
      }
    }
    after = after.replace(m[1], blockText);
  }
  if (after === before) return null;
  // 재계산 금지 검증 — 장르명 슬롯만 가리고 나머지 구조·값이 동일한지 대조한다.
  const mask = (text: string): string => {
    const o = JSON.parse(text) as {
      topGenres: { genre: string }[];
      dislikedGenres?: string[];
    };
    return JSON.stringify({
      ...o,
      topGenres: o.topGenres.map((g) => ({ ...g, genre: '@GENRE@' })),
      dislikedGenres: (o.dislikedGenres ?? []).map(() => '@GENRE@'),
    });
  };
  if (mask(before) !== mask(after)) {
    fatals.push(`${path}: 장르명 외 값이 바뀌었다 — 쓰기 전 중단`);
    return null;
  }
  return { path, kinds: [`장르명=${changed}건`], before, after };
}

/** mock/META.md — 장르 가중치 표 첫 열 + 고몰입군 인라인 표기만 ko→en. */
async function planFixtureMeta(koToEn: Map<string, string>, fatals: string[]): Promise<FilePlan | null> {
  const path = join(MOCK_DIR, 'META.md');
  const before = await readFile(path, 'utf-8');
  const lines = before.split('\n');
  let changed = 0;
  const out = lines.map((line) => {
    const cell = /^\|\s*(.+?)\s*\|\s*[\d.]+\s*\|/.exec(line);
    if (cell) {
      const ko = cell[1].trim();
      const en = koToEn.get(ko);
      if (en && en !== ko) {
        changed++;
        return line.replace(ko, en);
      }
      return line;
    }
    if (line.includes('고몰입군(')) {
      let next = line;
      for (const [ko, en] of koToEn) {
        if (en !== ko && next.includes(ko)) next = next.split(ko).join(en);
      }
      if (next !== line) changed++;
      return next;
    }
    return line;
  });
  const after = out.join('\n');
  if (after === before) return null;
  // 장르명 잔류 검사 — RPG를 제외한 ko 표기가 남아 있으면 중단한다.
  const leaked = [...koToEn.keys()].filter((ko) => ko !== 'RPG' && after.includes(ko));
  if (leaked.length > 0) {
    fatals.push(`${path}: 변환 후에도 ko 장르명 잔류(${leaked.join(',')}) — 쓰기 전 중단`);
    return null;
  }
  if (fatals.length > 0) return null;
  return { path, kinds: [`장르표기=${changed}곳`], before, after };
}

// ─── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { target, apply } = parseArgs(process.argv.slice(2));
  const koToEn = await loadKoToEn();
  const unmapped: string[] = [];
  const fatals: string[] = [];
  const notePlans: FilePlan[] = [];
  const extraPlans: FilePlan[] = [];
  let scanned = 0;

  if (target === 'real') {
    const files = (await readdir(GAMES_DIR)).filter((f) => f.endsWith('.md') && f !== 'library.md').sort();
    scanned = files.length;
    for (const f of files) {
      const plan = await planRealNote(join(GAMES_DIR, f), koToEn, unmapped, fatals);
      if (plan) notePlans.push(plan);
    }
  } else {
    const files = (await readdir(MOCK_GAMES_DIR)).filter((f) => f.endsWith('.md')).sort();
    scanned = files.length;
    for (const f of files) {
      const plan = await planFixtureNote(join(MOCK_GAMES_DIR, f), koToEn, unmapped, fatals);
      if (plan) notePlans.push(plan);
    }
    for (const p of [
      await planFixtureLibrary(koToEn, unmapped, fatals),
      await planFixtureProfile(koToEn, unmapped, fatals),
      await planFixtureMeta(koToEn, fatals),
    ]) {
      if (p) extraPlans.push(p);
    }
  }

  const all = [...notePlans, ...extraPlans];
  const kindCount = new Map<string, number>();
  for (const p of all) for (const k of p.kinds) kindCount.set(k, (kindCount.get(k) ?? 0) + 1);

  console.log(`[migrate-d9] target=${target} mode=${apply ? 'APPLY' : 'dry-run'}`);
  console.log(`[migrate-d9] 대상 노트 ${scanned}건 + 파생 ${extraPlans.length}건, 변경 ${all.length}건(노트 ${notePlans.length})`);
  for (const [k, n] of [...kindCount.entries()].sort()) console.log(`[migrate-d9]   ${k}: ${n}건`);
  console.log(`[migrate-d9] 미변경 노트 ${scanned - notePlans.length}건`);
  for (const p of all) console.log(`[migrate-d9]   CHG ${p.path} [${p.kinds.join(', ')}]`);
  if (unmapped.length > 0) {
    // 표 외 값은 경고 후 유지가 아니라 전체 중단이다.
    for (const u of unmapped) fatals.push(`${u} — genre-ko 표 외 값, 쓰기 전 중단`);
  }

  if (fatals.length > 0) {
    console.log(`[migrate-d9] 치명 ${fatals.length}건 — 쓰기 전 중단한다:`);
    for (const f of fatals) console.log(`[migrate-d9]   FATAL ${f}`);
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log('[migrate-d9] dry-run — 파일을 쓰지 않았다');
    return;
  }
  for (const p of all) await writeFile(p.path, p.after, 'utf-8');
  console.log(`[migrate-d9] APPLY 완료 — ${all.length}건 기록`);
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
