/**
 * P3-6b CLI 배선 테스트.
 *
 * 실행 (둘 다 같은 결과):
 *   `tsc -p packages/cli` 후 `node --test packages/cli/dist/collie-build.test.js`
 *   `pnpm --filter @questail/cli exec tsx --test src/collie-build.test.ts`
 * (package.json 변경 없이 dist 경유·tsx 직행 모두 지원 — collie config/retrieve
 * 테스트의 tsx 관례와 build/extract 테스트의 dist 관례를 둘 다 만족한다.
 * 프로세스 수준 테스트는 dist 산출물을 요구하며, 없으면 skip한다.)
 *
 * canonical output에는 손대지 않는다. 실제 prepare→build 시퀀싱은
 * os.tmpdir() 하위 임시 경로에서만 실행하고, 전후로 canonical
 * graph 파일의 상태가 그대로인지 확인한다.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COLLIE_USAGE,
  parseCollieBuildArgs,
  planCollieBuild,
  runCollieBuild,
} from './collie-build.js';

/**
 * CLI 진입점은 dist 산출물을 명시 지향한다. 이 파일이 src에서
 * (tsx --test) 돌든 dist에서 (node --test) 돌든 같은 dist/cli.js를
 * 본다. 산출물이 없으면 조용히 통과하지 않는다: 프로세스 수준
 * 테스트는 명확한 메시지와 함께 skip하고, runCli 직접 호출은
 * throw한다.
 */
const CLI_JS = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
const HAS_DIST = existsSync(CLI_JS);
const DIST_SKIP_MESSAGE = `dist 산출물 없음 (${CLI_JS}): tsc -p packages/cli 먼저 실행`;

function runCli(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  assert.ok(HAS_DIST, DIST_SKIP_MESSAGE);
  const result = spawnSync(process.execPath, [CLI_JS, ...args], { encoding: 'utf-8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('parseCollieBuildArgs', () => {
  it('빈 인자는 전부 기본값 (collie 기본값 위임)', () => {
    assert.deepEqual(parseCollieBuildArgs([]), {
      demo: false,
      cacheRoot: undefined,
      corpusRoot: undefined,
      outputRoot: undefined,
      help: false,
    });
  });

  it('--demo·--cache-root·--corpus-root·--output-root 파싱', () => {
    const options = parseCollieBuildArgs([
      '--demo',
      '--cache-root',
      '.cache',
      '--corpus-root',
      '/tmp/questail-corpus',
      '--output-root',
      '/tmp/questail-graph',
    ]);
    assert.equal(options.demo, true);
    assert.equal(options.cacheRoot, resolve('.cache'));
    assert.equal(options.corpusRoot, '/tmp/questail-corpus');
    assert.equal(options.outputRoot, '/tmp/questail-graph');
  });

  it('선행 `--` 분리자를 걷어낸다 (pnpm passthrough 관례)', () => {
    assert.equal(parseCollieBuildArgs(['--', '--demo']).demo, true);
  });

  it('-h·--help는 help 플래그', () => {
    assert.equal(parseCollieBuildArgs(['-h']).help, true);
    assert.equal(parseCollieBuildArgs(['--help']).help, true);
  });

  it('알 수 없는 옵션은 collie prepare와 같은 메시지로 throw', () => {
    assert.throws(() => parseCollieBuildArgs(['--nope']), /알 수 없는 옵션: --nope/);
  });

  it('값 없는 경로 옵션은 throw', () => {
    assert.throws(() => parseCollieBuildArgs(['--output-root']), /값이 필요합니다/);
  });
});

describe('planCollieBuild', () => {
  it('--corpus-root 하나로 prepare 출력·build 입력을 묶는다', () => {
    const plan = planCollieBuild(parseCollieBuildArgs(['--demo', '--corpus-root', '/tmp/c']));
    assert.deepEqual([...plan.prepareArgs], ['--demo', '--output-root', '/tmp/c']);
    assert.equal(plan.corpusRoot, '/tmp/c');
    assert.equal(plan.outputRoot, undefined);
  });

  it('생략된 경로는 undefined로 두어 collie 기본값을 쓴다', () => {
    const plan = planCollieBuild(parseCollieBuildArgs([]));
    assert.deepEqual([...plan.prepareArgs], []);
    assert.equal(plan.corpusRoot, undefined);
    assert.equal(plan.outputRoot, undefined);
  });
});

describe('questail collie CLI (프로세스 수준, dist 필요)', { skip: HAS_DIST ? false : DIST_SKIP_MESSAGE }, () => {
  it('collie --help는 exit 0, usage를 stderr에', () => {
    const result = runCli('collie', '--help');
    assert.equal(result.status, 0);
    assert.match(result.stderr, /questail collie build/);
    assert.equal(result.stdout, '');
  });

  it('인자 없는 collie도 usage exit 0 (기존 무인자 help 관례)', () => {
    const result = runCli('collie');
    assert.equal(result.status, 0);
    assert.match(result.stderr, /questail collie build/);
  });

  it('collie build --help는 exit 0', () => {
    const result = runCli('collie', 'build', '--help');
    assert.equal(result.status, 0);
    assert.match(result.stderr, /--output-root/);
  });

  it('알 수 없는 서브커맨드는 stderr + exit 1', () => {
    const result = runCli('collie', 'frobnicate');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /알 수 없는 명령어입니다: collie frobnicate/);
  });

  it('알 수 없는 옵션은 stderr + exit 1, stdout 오염 없음', () => {
    const result = runCli('collie', 'build', '--nope');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /알 수 없는 옵션: --nope/);
    assert.equal(result.stdout, '');
  });

  it('build 실행 성공 시 exit 0, stdout에 prepared·graph.v1 한 줄씩', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'questail-collie-cli-'));
    try {
      const result = runCli(
        'collie',
        'build',
        '--demo',
        '--corpus-root',
        join(tmp, 'corpus'),
        '--output-root',
        join(tmp, 'graph'),
      );
      assert.equal(result.status, 0);
      assert.match(result.stdout, /prepared \d+ documents/);
      assert.match(result.stdout, /graph\.v1: games=\d+ edges=\d+/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('기존 최상위 --help는 그대로 core에 위임된다', () => {
    const result = runCli('--help');
    assert.equal(result.status, 0);
    assert.match(result.stderr, /questail gather steam/);
  });

  it('COLLIE_USAGE는 스캐폴드 범위를 벗어나지 않는다', () => {
    assert.match(COLLIE_USAGE, /questail collie build/);
  });
});

describe('prepare→build 시퀀싱 (tmp 전용, canonical 미접촉)', () => {
  it('tmp corpus→tmp graph에 graph.v1을 만들고 canonical은 그대로 둔다', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'questail-collie-seq-'));
    const corpusRoot = join(tmp, 'corpus');
    const outputRoot = join(tmp, 'graph');
    // canonical output 스냅샷: 존재 여부와 mtime을 기록한다.
    const canonicalGraph = resolve('packages/collie/output/graph/graph.v1.json');
    const canonicalBefore = existsSync(canonicalGraph)
      ? String(statSync(canonicalGraph).mtimeMs)
      : 'absent';
    try {
      const result = await runCollieBuild({
        demo: true,
        cacheRoot: undefined,
        corpusRoot,
        outputRoot,
        help: false,
      });
      assert.ok(result.documentCount > 0);
      assert.equal(result.graphPath, join(outputRoot, 'graph.v1.json'));
      // prepare와 build가 같은 corpusRoot를 썼다: manifest 지문이 graph에 그대로 남는다.
      const manifest = JSON.parse(readFileSync(join(corpusRoot, 'manifest.json'), 'utf8')) as {
        sourceFingerprint: string;
        documentCount: number;
      };
      const graph = JSON.parse(readFileSync(result.graphPath, 'utf8')) as {
        version: string;
        corpus: { manifestFingerprint: string; documentCount: number };
        metrics: { gameNodes: number; deterministicEdges: number };
      };
      assert.equal(graph.version, 'graph.v1');
      assert.equal(graph.corpus.manifestFingerprint, manifest.sourceFingerprint);
      assert.equal(graph.corpus.documentCount, manifest.documentCount);
      assert.equal(result.documentCount, manifest.documentCount);
      assert.equal(result.games, graph.metrics.gameNodes);
      assert.equal(result.deterministicEdges, graph.metrics.deterministicEdges);
      const canonicalAfter = existsSync(canonicalGraph)
        ? String(statSync(canonicalGraph).mtimeMs)
        : 'absent';
      assert.equal(canonicalAfter, canonicalBefore);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
