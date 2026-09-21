/**
 * tools/eval/dryrun.ts — 오프라인 드라이런 하네스 (W-B 소유).
 *
 * collie `src/dryrun.ts` 와 같은 채점을 한다. LLM 을 한 번도 부르지 않는다:
 * - `data/classify_cache.json` 에서 ClassifyResult 를 복원해 core 의
 *   `routeQuestion(question, classify, deps)` 에 넘긴다. 라우터만 잰다.
 * - 캐시에 없는 질문은 에러로 중단한다 (collie 와 같다).
 * - 채점은 `./score.ts` 의 `toolScoreFor` 로 한다 (collie `evaluate.ts` 와 같은 규칙).
 * - `--refresh-classify` 는 없다. 캐시 재생성이 필요하면 보고한다.
 *   (분류기 LLM 호출은 collie 앱 계층의 일이며 core·questail 에 없다.)
 *
 * 실행: 이 파일을 직접 실행했을 때만 돈다. import 만으로는 돌지 않는다.
 *
 * W-A 대기: `packages/core/src/agent/router.ts` 가 아직 없으면 이 파일의
 * import 가 풀리지 않는다. 그 경우 하네스는 돌릴 수 없고 로더까지만 확인한다.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAgentDeps } from './loader.js';
import { toolScoreFor } from './score.js';
import { routeQuestion } from '../../packages/core/src/agent/router.js';
import {
  CATEGORIES,
  type QueryCategory,
  type ToolCall,
  type ToolName,
} from '../../packages/core/src/agent/types.js';

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(EVAL_DIR, 'data', 'classify_cache.json');
const EVAL_SET_PATH = join(EVAL_DIR, 'data', 'eval_set.csv');

/** collie `src/types.ts` 의 ClassifyResult 와 같은 모양 (앱 계층 타입이라 core 에 없다). */
export interface ClassifyResult {
  category: QueryCategory;
  /** 0~1 */
  confidence: number;
  reason: string;
  /** 질문에 등장하는 게임의 라이브러리 정식 표기 후보. 없으면 빈 배열이다. */
  gameTitles: string[];
}

/** 계약 ToolName union (9 + escalate). */
const CONTRACT_TOOLS: readonly string[] = [
  'lookup_library',
  'get_game_note',
  'get_taste_profile',
  'search_docs',
  'get_achievement_stats',
  'get_wishlist',
  'find_rating_playtime_gaps',
  'get_field_coverage',
  'describe_schema',
  'escalate',
];

function isToolName(value: string): value is ToolName {
  return CONTRACT_TOOLS.includes(value);
}

function assertTool(value: string, qaId: string): ToolName {
  if (!isToolName(value)) throw new Error(`[dryrun] ${qaId}: 알 수 없는 도구명 "${value}"`);
  return value;
}

/** JSON 배열 셀 우선, 아니면 '|' (또는 ';') 구분 폴백 (collie evaluate.ts 와 같은 순서). */
function parseTools(cell: string, qaId: string): ToolName[] {
  const t = cell.trim();
  if (t === '') return [];
  try {
    const v: unknown = JSON.parse(t);
    if (Array.isArray(v)) return v.map((s) => assertTool(String(s), qaId));
  } catch {
    /* 폴백으로 내려간다 */
  }
  return t
    .split(/[|;]/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => assertTool(s, qaId));
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      continue;
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

function isCategory(v: unknown): v is QueryCategory {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);
}

interface DryItem {
  qaId: string;
  category: QueryCategory;
  split: string;
  question: string;
  expected: ToolName[];
}

async function loadItems(path: string): Promise<DryItem[]> {
  const text = await readFile(path, 'utf-8');
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error(`[dryrun] 평가셋에 데이터 행이 없다: ${path}`);
  const header = rows[0].map((h) => h.trim());
  const idx = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`[dryrun] 컬럼 누락 "${name}"`);
    return i;
  };
  const c = {
    qaId: idx('qaId'),
    category: idx('category'),
    split: idx('split'),
    question: idx('question'),
    expectedTools: idx('expectedTools'),
  };
  return rows.slice(1).map((r, n) => {
    // 질문에 따옴표 없는 쉼표가 있으면 필드가 밀린다. 앞 3개와 뒤 2개는
    // 쉼표를 포함할 수 없으니 앵커로 고정하고 가운데를 질문으로 합친다.
    let f = r;
    if (r.length > 6) {
      f = [r[0], r[1], r[2], r.slice(3, r.length - 2).join(','), r[r.length - 2], r[r.length - 1]];
    }
    if (f.length < 6) throw new Error(`[dryrun] 컬럼 부족 (row${n + 2})`);
    const qaId = (f[c.qaId] ?? '').trim() || `row${n + 2}`;
    const category = (f[c.category] ?? '').trim();
    if (!isCategory(category)) throw new Error(`[dryrun] ${qaId}: category 오류 "${category}"`);
    return {
      qaId,
      category,
      split: (f[c.split] ?? '').trim(),
      question: f[c.question] ?? '',
      expected: parseTools(f[c.expectedTools] ?? '', qaId),
    };
  });
}

// ── classify 캐시 ───────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toCachedClassify(qaId: string, value: unknown): ClassifyResult {
  if (!isRecord(value)) {
    throw new Error(`[dryrun] 캐시 손상: ${qaId} 항목이 객체가 아니다`);
  }
  const rec = value;
  if (!isCategory(rec.category)) throw new Error(`[dryrun] 캐시 손상: ${qaId} category 오류`);
  if (typeof rec.confidence !== 'number' || !Number.isFinite(rec.confidence)) {
    throw new Error(`[dryrun] 캐시 손상: ${qaId} confidence 오류`);
  }
  if (typeof rec.reason !== 'string') throw new Error(`[dryrun] 캐시 손상: ${qaId} reason 오류`);
  if (!Array.isArray(rec.gameTitles) || !rec.gameTitles.every((t) => typeof t === 'string')) {
    throw new Error(`[dryrun] 캐시 손상: ${qaId} gameTitles 오류`);
  }
  return {
    category: rec.category,
    confidence: rec.confidence,
    reason: rec.reason,
    gameTitles: rec.gameTitles,
  };
}

async function loadCache(path: string): Promise<Map<string, ClassifyResult>> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    throw new Error(`[dryrun] 캐시가 없다: ${path}`);
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('[dryrun] 캐시 손상: JSON 객체 아님');
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.entries !== 'object' || rec.entries === null) throw new Error('[dryrun] 캐시 손상: entries 없음');
  const out = new Map<string, ClassifyResult>();
  for (const [question, value] of Object.entries(rec.entries)) {
    out.set(question, toCachedClassify(`질문 "${question.slice(0, 20)}…"`, value));
  }
  return out;
}

// ── 실행 ────────────────────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main(): Promise<void> {
  const items = await loadItems(EVAL_SET_PATH);
  const cache = await loadCache(CACHE_PATH);
  // fewshot은 라우터 측정 대상이 아니다 (collie runEval도 제외한다).
  const targets = items.filter((i) => i.split !== 'fewshot');
  if (targets.length === 0) throw new Error('[dryrun] 대상 문항이 0건이다');
  const deps = await loadAgentDeps();

  let correct = 0;
  const byCat = new Map<string, { n: number; ok: number }>();
  const wrong: string[] = [];
  for (const t of [...targets].sort((a, b) => (a.qaId < b.qaId ? -1 : 1))) {
    // 분류기 성능을 섞지 않는다 — 캐시에서 ClassifyResult를 복원해 넘긴다.
    // eval_set.csv의 category 컬럼은 여기서 쓰지 않는다.
    const classify = cache.get(t.question);
    if (!classify) {
      throw new Error(`[dryrun] 캐시에 없음: ${t.qaId} — 질문이 바뀌었으면 캐시를 확인해라`);
    }
    const calls: ToolCall[] = await routeQuestion(t.question, classify, deps);
    // collie graph.ts의 toolsUsed와 같은 집합화 (중복 제거, 순서 무관).
    const actual: ToolName[] = [];
    for (const c of calls) {
      const name = String(c.tool);
      if (isToolName(name) && !actual.includes(name)) actual.push(name);
    }
    const score = toolScoreFor(actual, t.expected);
    correct += score;
    const agg = byCat.get(classify.category) ?? { n: 0, ok: 0 };
    agg.n++;
    agg.ok += score;
    byCat.set(classify.category, agg);
    if (score === 0) {
      wrong.push(
        `- ${t.qaId} [${classify.category}] 기대 ${t.expected.join('+') || '(없음)'} vs 실제 ${actual.join('+') || '(없음)'}`,
      );
    }
  }

  console.log(`[dryrun] 총점 ${correct}/${targets.length} (tool)`);
  for (const [cat, agg] of [...byCat.entries()].sort()) {
    console.log(`[dryrun] ${pad(cat, 12)}${agg.ok}/${agg.n}`);
  }
  if (wrong.length === 0) {
    console.log('[dryrun] 틀린 문항 없음');
  } else {
    console.log('[dryrun] 틀린 문항:');
    for (const line of wrong) console.log(line);
  }
  process.exitCode = wrong.length === 0 ? 0 : 1;
}

const IS_ENTRY =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_ENTRY) {
  try {
    await main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
