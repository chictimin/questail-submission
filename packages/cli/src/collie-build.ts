/**
 * `questail collie build` — 얇은 배선 (P3-6b).
 *
 * collie 공개 index export (`prepareCorpus`, `buildAndWriteGraph`,
 * `GraphV1`)만 사용한다. 그 외 collie 내부 경로 import는 두지 않는다.
 * 데이터 수집/LLM/extract/retrieval/UI는 호출하지 않는다 — prepare가
 * 출력한 canonical corpus를 결정적 graph build가 읽는 순서만 배선한다.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAndWriteGraph, prepareCorpus, type GraphV1 } from '@questail/collie';

export interface CollieBuildOptions {
  readonly demo: boolean;
  readonly cacheRoot: string | undefined;
  readonly corpusRoot: string | undefined;
  readonly outputRoot: string | undefined;
  readonly help: boolean;
}

export const COLLIE_USAGE = [
  '사용법:',
  '  questail collie build [--demo] [--cache-root <dir>] [--corpus-root <dir>] [--output-root <dir>]',
  '  questail collie --help',
  '',
  '  --demo               공개 demo corpus로 준비 (네트워크 없음)',
  '  --cache-root <dir>   Steam 캐시 디렉터리 (생략 시 collie 기본값)',
  '  --corpus-root <dir>  중간 corpus 출력 (생략 시 collie 기본값)',
  '  --output-root <dir>  최종 graph 출력 graph.v1.json (생략 시 collie 기본값)',
  '  -h, --help           이 도움말을 보여준다',
].join('\n');

/**
 * `collie build` 뒤의 인자만 받는다. 관례는 collie prepare와 같다:
 * pnpm이 넘기는 선행 `--` 분리자를 걷어내고, 알 수 없는 옵션은
 * `알 수 없는 옵션: <arg>` 메시지로 throw한다 (호출자가 stderr+usage+exit 1).
 */
export function parseCollieBuildArgs(args: readonly string[]): CollieBuildOptions {
  const rest = args[0] === '--' ? args.slice(1) : [...args];
  let demo = false;
  let help = false;
  let cacheRoot: string | undefined;
  let corpusRoot: string | undefined;
  let outputRoot: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (arg === '--demo') {
      demo = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--cache-root' || arg === '--corpus-root' || arg === '--output-root') {
      const value = rest[index + 1];
      if (value === undefined) throw new Error(`값이 필요합니다: ${arg} <dir>`);
      index += 1;
      // 기존 CLI -o/--output과 같이 cwd 기준 resolve라 clone 어디서든 안정적이다.
      const resolved = resolve(value);
      if (arg === '--cache-root') cacheRoot = resolved;
      else if (arg === '--corpus-root') corpusRoot = resolved;
      else outputRoot = resolved;
    } else {
      throw new Error(`알 수 없는 옵션: ${arg}`);
    }
  }
  return { demo, cacheRoot, corpusRoot, outputRoot, help };
}

export interface CollieBuildPlan {
  /** prepareCorpus()에 그대로 넘길 인자. */
  readonly prepareArgs: readonly string[];
  /**
   * buildAndWriteGraph(corpusRoot, outputRoot)에 넘길 값.
   * undefined는 collie 기본값(모듈 위치 기반 repo 경로)을 그대로 쓴다는 뜻이다.
   */
  readonly corpusRoot: string | undefined;
  readonly outputRoot: string | undefined;
}

/**
 * CLI 옵션 → collie 호출 계획. prepare의 `--output-root`가 곧
 * build의 corpus 입력이므로 `--corpus-root` 하나로 묶는다.
 */
export function planCollieBuild(options: CollieBuildOptions): CollieBuildPlan {
  const prepareArgs: string[] = [];
  if (options.demo) prepareArgs.push('--demo');
  if (options.cacheRoot !== undefined) prepareArgs.push('--cache-root', options.cacheRoot);
  if (options.corpusRoot !== undefined) prepareArgs.push('--output-root', options.corpusRoot);
  return { prepareArgs, corpusRoot: options.corpusRoot, outputRoot: options.outputRoot };
}

export interface CollieBuildResult {
  readonly documentCount: number;
  readonly graphPath: string;
  readonly games: number;
  readonly deterministicEdges: number;
}

/**
 * outputRoot 생략 시 collie 기본값과 같은 위치를 가리킨다. 결과 경로
 * 보고용이며, 실제 쓰기는 buildAndWriteGraph의 기본값이 담당한다.
 */
function defaultGraphPath(): string {
  const packagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return join(packagesDir, 'collie', 'output', 'graph', 'graph.v1.json');
}

/**
 * prepare→build를 올바른 순서로 호출한다. prepare와 build는 같은
 * corpusRoot를 공유한다: prepare의 출력이 곧 build의 입력이다.
 * 진행·결과는 stdout 한 줄씩 (collie 직접 실행과 같은 형식),
 * 실패는 throw하고 호출자가 stderr + exit 1로 처리한다.
 */
export async function runCollieBuild(options: CollieBuildOptions): Promise<CollieBuildResult> {
  const plan = planCollieBuild(options);
  const manifest = await prepareCorpus([...plan.prepareArgs]);
  const graph: GraphV1 = await buildAndWriteGraph(plan.corpusRoot, plan.outputRoot);
  const graphPath = plan.outputRoot !== undefined ? join(plan.outputRoot, 'graph.v1.json') : defaultGraphPath();
  console.log(`prepared ${manifest.documentCount} documents`);
  console.log(
    `graph.v1: games=${graph.metrics.gameNodes} edges=${graph.metrics.deterministicEdges} ` +
      `lcc=${graph.metrics.largestComponentGames} bridged=${graph.metrics.bridgedGames} ` +
      `goldStarts=${graph.metrics.gold.startGames} goldL2=${graph.metrics.gold.pathsLength2}`,
  );
  return {
    documentCount: manifest.documentCount,
    graphPath,
    games: graph.metrics.gameNodes,
    deterministicEdges: graph.metrics.deterministicEdges,
  };
}
