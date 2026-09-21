#!/usr/bin/env node

/**
 * `questail` bin — thin wrapper. All behavior lives in
 * `@questail/core/cli-runtime` (`runQuestailCli`); this file only
 * forwards `process.argv`. 예외는 `collie` 한 가지뿐이며, collie
 * 공개 export만 호출하는 얇은 배선이다 (6b build, P4-G serve·ask).
 */

import { runQuestailCli } from '@questail/core/cli-runtime';
import {
  COLLIE_USAGE,
  parseCollieBuildArgs,
  runCollieBuild,
} from './collie-build.js';
import { ASK_USAGE, parseAskArgs, runAskCommand } from './collie-ask.js';
import { SERVE_USAGE, parseServeArgs, runServeCommand } from './collie-serve.js';

const COLLIE_HELP = [COLLIE_USAGE, SERVE_USAGE, ASK_USAGE].join('\n\n');

/**
 * `questail collie ...` 분기. 기존 CLI 관례를 따른다: help는 usage를
 * stderr에 찍고 exit 0, 알 수 없는 서브커맨드·옵션과 실행 실패는
 * stderr + exit 1이며 stdout은 오염시키지 않는다 (ask의 2 보류 제외).
 */
async function runCollie(argv: readonly string[]): Promise<void> {
  const sub = argv[3];
  if (sub === undefined || sub === '--help' || sub === '-h') {
    console.error(COLLIE_HELP);
    return;
  }
  switch (sub) {
    case 'build': {
      const options = parseOrExit(parseCollieBuildArgs, argv.slice(4));
      if (options.help) {
        console.error(COLLIE_USAGE);
        return;
      }
      try {
        await runCollieBuild(options);
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
      return;
    }
    case 'serve': {
      const options = parseOrExit(parseServeArgs, argv.slice(4));
      if (options.help) {
        console.error(SERVE_USAGE);
        return;
      }
      try {
        await runServeCommand(options);
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
      return;
    }
    case 'ask': {
      const options = parseOrExit(parseAskArgs, argv.slice(4));
      if (options.help) {
        console.error(ASK_USAGE);
        return;
      }
      try {
        process.exitCode = await runAskCommand(options);
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
      return;
    }
    default:
      console.error(`알 수 없는 명령어입니다: collie ${sub}`);
      console.error(COLLIE_HELP);
      process.exit(1);
  }
}

function parseOrExit<T>(parse: (args: readonly string[]) => T, args: readonly string[]): T {
  try {
    return parse(args);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(COLLIE_HELP);
    process.exit(1);
  }
}

if (process.argv[2] === 'collie') {
  void runCollie(process.argv).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
} else {
  runQuestailCli();
}
