/**
 * tools/recache.ts — appdetails 재수집 전용 진입점 (P2, 워커 A 소유).
 *
 * `games/library.md`에서 appId를 읽어 `fetchAppMetaBatch`로 순회하며
 * `.cache/appdetails/`만 갱신한다. `games/` 아래 어떤 파일도 쓰지 않고,
 * `tools/eval/data/`도 건드리지 않는다. `gather`를 호출하지 않는다.
 *
 * 재개 정책은 신규가 아니라 기존 정책을 재사용한다:
 * - 스로틀·쿨다운·`AppMetaRateLimitedError`는 `metadata/index.ts` 내부 정책 그대로.
 * - 기본 `onRateLimit: 'wait'` — 429 시 쿨다운만큼 대기 후 같은 appId부터 재개.
 * - 캐시 히트는 API 호출 없이 스킵되므로 중단 후 재실행이 곧 재개다.
 *   (v2 전환으로 구버전 캐시는 자동 스테일 처리되어 다시 받는다.)
 *
 * 실행(오케스트레이터가 수행, 약 6분 · 429 시 +5분):
 *   pnpm tsx tools/recache.ts
 *   pnpm tsx tools/recache.ts --library games/library.md
 *   pnpm tsx tools/recache.ts --stop-on-ratelimit   # 지연 회피 우선 시
 *
 * 이 파일을 직접 실행했을 때만 돈다. import만으로는 돌지 않는다.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAppMetaBatch } from '../packages/core/src/metadata/index.js';
import { parseLibraryMarkdown } from '../packages/core/src/storage/library.js';

const DEFAULT_LIBRARY_PATH = resolve('games/library.md');

function usage(): string {
  return [
    '사용법: pnpm tsx tools/recache.ts [--library <path>] [--stop-on-ratelimit]',
    '',
    '  --library <path>     library.md 경로 (기본: games/library.md)',
    '  --stop-on-ratelimit  레이트리밋 시 대기 대신 중단 (기본: 대기 후 재개)',
  ].join('\n');
}

function parseArgs(argv: string[]): { libraryPath: string; onRateLimit: 'wait' | 'stop' } {
  let libraryPath = DEFAULT_LIBRARY_PATH;
  let onRateLimit: 'wait' | 'stop' = 'wait';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--library') {
      const v = argv[++i];
      if (!v) throw new Error('[recache] --library 뒤에 경로가 필요하다');
      libraryPath = resolve(v);
    } else if (a === '--stop-on-ratelimit') {
      onRateLimit = 'stop';
    } else if (a === '--help' || a === '-h') {
      console.error(usage());
      process.exit(0);
    } else {
      throw new Error(`[recache] 알 수 없는 인자 "${a}"\n${usage()}`);
    }
  }
  return { libraryPath, onRateLimit };
}

/** library.md에서 steam 숫자 appId만 순서대로 뽑는다. 쓰기는 하지 않는다. */
async function loadAppIds(libraryPath: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(libraryPath, 'utf-8');
  } catch {
    throw new Error(`[recache] library.md를 읽을 수 없다: ${libraryPath}`);
  }
  const index = parseLibraryMarkdown(text);
  const ids = index.games
    .filter(g => g.platform === 'steam' && /^\d+$/.test(g.id))
    .map(g => g.id);
  const seen = new Set<string>();
  return ids.filter(id => (seen.has(id) ? false : (seen.add(id), true)));
}

async function main(): Promise<void> {
  const { libraryPath, onRateLimit } = parseArgs(process.argv.slice(2));
  const appIds = await loadAppIds(libraryPath);
  if (appIds.length === 0) throw new Error(`[recache] appId가 0건이다: ${libraryPath}`);
  console.error(`[recache] 대상 ${appIds.length}건 ← ${libraryPath} (캐시만 갱신, onRateLimit=${onRateLimit})`);

  const startedAt = Date.now();
  const metas = await fetchAppMetaBatch(appIds, {
    onRateLimit,
    onProgress: (done, total, appId) => {
      console.error(`[recache] ${done}/${total} (app ${appId})`);
    },
  });
  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.error(`[recache] 완료 ${metas.length}/${appIds.length}건, ${elapsedMin}분 — .cache/appdetails/만 갱신됨`);
  if (metas.length < appIds.length) {
    console.error('[recache] 중단됨(--stop-on-ratelimit): 다시 실행하면 캐시 히트부터 이어진다');
    process.exitCode = 2;
  }
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
