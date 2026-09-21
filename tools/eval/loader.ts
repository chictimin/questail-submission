/**
 * tools/eval/loader.ts — 회귀 픽스처 로더 (W-B 소유).
 *
 * questail-collie `src/context.ts` + `src/nodes/tools.ts` 의 노트 조립을
 * tools/eval/ 픽스처 기준으로 재현한다. md 파서는 새로 짜지 않고 core 의
 * `parseGameNote` · `extractSubjectiveFields` · `parseLibraryMarkdown` 을 쓴다.
 *
 * collie 와의 차이 두 가지 (T3 계약서 2절):
 * 1. `callLlm` 을 조립하지 않는다 — 로더는 LLM 을 모른다.
 * 2. 게임 노트를 모듈 전역 캐시 뒤에 숨기지 않고 `AgentDeps.notes` 로 조립해
 *    돌려준다. collie `tools.ts` 의 `loadNoteEntries` 본문을 그대로 옮겼다.
 *
 * 단독 실행: library 게임 수·notes 건수·chunks 수를 찍는다.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGameNote, extractSubjectiveFields } from '../../packages/core/src/storage/gameNote.js';
import { parseLibraryMarkdown } from '../../packages/core/src/storage/library.js';
import type {
  AgentDeps,
  EvidenceChunk,
  NoteEntry,
  QueryCategory,
} from '../../packages/core/src/agent/types.js';
import type { LibraryIndex, TasteProfile } from '../../packages/core/src/types.js';

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(EVAL_DIR, 'docs');
const MOCK_DIR = join(EVAL_DIR, 'data', 'mock');
const GAMES_DIR = join(MOCK_DIR, 'games');
/** D9 ko 장르 매핑표 단일 정본 (id → {en, ko}) */
const GENRE_KO_PATH = join(EVAL_DIR, '..', 'genre-ko.json');

const POLICY_FILE: Record<string, string> = {
  'D-D': 'policy-collection.md',
  'D-E': 'policy-rating.md',
  'D-F': 'glossary-genre.md',
};

const KNOWN_CATEGORIES: readonly string[] = [
  'HISTORY',
  'TASTE',
  'SUBJECTIVE',
  'DATA_OPS',
  'OUT_OF_SCOPE',
];

interface MappingEntry {
  id: string;
  docId: string;
  heading: string;
  categories: QueryCategory[];
}

/** 매핑표 제목("policy-collection 1. 데이터 계층")에서 ##見出し 부분만 떼낸다. */
function mappingTitleToHeading(title: string): string {
  const dot = title.indexOf('. ');
  const raw = dot >= 0 ? title.slice(dot + 2) : title;
  return raw.trim();
}

/** 문서 ##見出し("1. 데이터 계층")에서 앞 번호를 떼어 매칭 키로 만든다. */
function headingKey(heading: string): string {
  return heading.replace(/^\d+\.\s*/, '').trim();
}

/** docs/_mapping.md의 청크 매핑표를 파싱한다. */
export async function loadMapping(): Promise<MappingEntry[]> {
  const md = await readFile(join(DOCS_DIR, '_mapping.md'), 'utf-8');
  const entries: MappingEntry[] = [];
  for (const line of md.split('\n')) {
    const m = /^\|\s*(D-[DEF]#[^\s|]+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(line);
    if (!m) continue;
    const id = m[1] as string;
    const title = m[2] as string;
    const cats = m[3] as string;
    const categories: QueryCategory[] = [];
    for (const tok of cats
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      if ((KNOWN_CATEGORIES as readonly string[]).includes(tok)) {
        categories.push(tok as QueryCategory);
      } else {
        console.warn(`[eval-loader] _mapping.md: 알 수 없는 카테고리 '${tok}' (청크 ${id}) — 무시합니다.`);
      }
    }
    entries.push({ id, docId: id.slice(0, 3), heading: mappingTitleToHeading(title), categories });
  }
  return entries;
}

interface DocSection {
  heading: string;
  text: string;
}

/** md를 ## 단위 섹션으로 쪼갠다. 첫 ## 이전 서문은 청크가 아니므로 버린다. */
function splitSections(md: string): DocSection[] {
  const sections: DocSection[] = [];
  let heading: string | null = null;
  let buf: string[] = [];
  for (const line of md.split('\n')) {
    const h = /^##\s+(.*\S)\s*$/.exec(line);
    if (h) {
      if (heading !== null) sections.push({ heading, text: buf.join('\n').trim() });
      heading = h[1] as string;
      buf = [];
    } else if (heading !== null) {
      buf.push(line);
    }
  }
  if (heading !== null) sections.push({ heading, text: buf.join('\n').trim() });
  return sections;
}

/** 매핑표 기준으로 정책 산문 3종을 EvidenceChunk[]로 만든다. */
export async function loadChunks(): Promise<EvidenceChunk[]> {
  const mapping = await loadMapping();
  const byDoc = new Map<string, MappingEntry[]>();
  for (const e of mapping) {
    const arr = byDoc.get(e.docId) ?? [];
    arr.push(e);
    byDoc.set(e.docId, arr);
  }
  const chunks: EvidenceChunk[] = [];
  for (const [docId, file] of Object.entries(POLICY_FILE)) {
    const md = await readFile(join(DOCS_DIR, file), 'utf-8');
    const sections = splitSections(md);
    const byKey = new Map(sections.map((s) => [headingKey(s.heading), s]));
    const wanted = byDoc.get(docId) ?? [];
    for (const e of wanted) {
      const sec = byKey.get(e.heading);
      if (!sec) {
        console.warn(
          `[eval-loader] _mapping.md의 '${e.id}'에 대응하는 ## 섹션이 ${file}에 없습니다 — 제외합니다.`,
        );
        continue;
      }
      chunks.push({
        id: e.id,
        docId,
        heading: sec.heading,
        text: sec.text,
        categories: e.categories,
      });
    }
    for (const s of sections) {
      if (!wanted.some((e) => e.heading === headingKey(s.heading))) {
        console.warn(`[eval-loader] ${file}의 ## '${s.heading}'이 _mapping.md에 없습니다 — 제외합니다.`);
      }
    }
  }
  return chunks;
}

/**
 * data/mock/games/*.md 를 NoteEntry[] 로 조립한다.
 * collie `tools.ts` 의 `loadNoteEntries` 와 같은 본문이다. 전역 캐시는 두지 않는다.
 */
export async function loadNotes(gamesDir: string = GAMES_DIR): Promise<NoteEntry[]> {
  let files: string[];
  try {
    files = (await readdir(gamesDir)).filter((f) => f.endsWith('.md'));
  } catch {
    throw new Error(`[eval-loader] 게임 노트 디렉터리가 없다: ${gamesDir}`);
  }
  const entries: NoteEntry[] = [];
  for (const f of files) {
    try {
      const parsed = parseGameNote(await readFile(join(gamesDir, f), 'utf-8'));
      const fm = parsed.frontmatter;
      const sub = extractSubjectiveFields(parsed);
      // game_id는 md에서 따옴표 없이 적혀 YAML 숫자로 파싱된다 — 문자열로 강제한다.
      const rawId = fm.game_id;
      const gameId = typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : '';
      entries.push({
        title: typeof fm.title === 'string' ? fm.title : '',
        gameId,
        rating: sub.rating,
        status: sub.status,
        note: sub.note,
        dislikeReasons: sub.dislikeReasons,
      });
    } catch (err) {
      console.warn(`[eval-loader] 게임 노트 파싱 실패: ${f} — ${String(err)}`);
    }
  }
  return entries;
}

export async function loadLibraryAndProfile(): Promise<{ library: LibraryIndex; profile: TasteProfile }> {
  const library = parseLibraryMarkdown(await readFile(join(MOCK_DIR, 'library.md'), 'utf-8'));
  const profile = JSON.parse(await readFile(join(MOCK_DIR, 'taste-profile.json'), 'utf-8')) as TasteProfile;
  return { library, profile };
}

/**
 * tools/genre-ko.json(id → {en, ko})을 canonical 영문명 → 별칭 배열로 뒤집는다.
 * core는 JSON·파일시스템을 직접 읽지 않으므로 여기서 조립해 AgentDeps에 주입한다.
 * en과 ko가 같은 항목(RPG)은 별칭이 직접 매칭과 겹치므로 제외한다.
 */
export async function loadGenreAliases(): Promise<Record<string, string[]>> {
  let text: string;
  try {
    text = await readFile(GENRE_KO_PATH, 'utf-8');
  } catch {
    throw new Error(`[eval-loader] 장르 매핑표가 없다: ${GENRE_KO_PATH}`);
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('[eval-loader] genre-ko.json: 최상위가 객체가 아니다');
  }
  const out: Record<string, string[]> = {};
  for (const [id, v] of Object.entries(parsed)) {
    if (typeof v !== 'object' || v === null) {
      throw new Error(`[eval-loader] genre-ko.json: id ${id} 항목이 {en, ko}가 아니다`);
    }
    const rec = v as Record<string, unknown>;
    if (typeof rec.en !== 'string' || rec.en === '' || typeof rec.ko !== 'string' || rec.ko === '') {
      throw new Error(`[eval-loader] genre-ko.json: id ${id} 항목의 en/ko가 비어 있다`);
    }
    if (rec.ko !== rec.en) {
      const arr = out[rec.en] ?? [];
      arr.push(rec.ko);
      out[rec.en] = arr;
    }
  }
  return out;
}

/** 픽스처만으로 AgentDeps 를 조립한다. LLM·네트워크를 쓰지 않는다. */
export async function loadAgentDeps(): Promise<AgentDeps> {
  const [chunks, notes, { library, profile }, genreAliases] = await Promise.all([
    loadChunks(),
    loadNotes(),
    loadLibraryAndProfile(),
    loadGenreAliases(),
  ]);
  return { library, profile, chunks, notes, genreAliases };
}

const IS_ENTRY =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_ENTRY) {
  try {
    const deps = await loadAgentDeps();
    console.log(`[eval-loader] library 게임 수: ${deps.library.games.length}`);
    console.log(`[eval-loader] notes 건수: ${deps.notes.length}`);
    console.log(`[eval-loader] chunks 수: ${deps.chunks.length}`);
    console.log(`[eval-loader] genreAliases: ${Object.keys(deps.genreAliases ?? {}).length}건`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
