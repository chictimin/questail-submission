/**
 * 전역 LLM 설정 — questail-postie `src/globalConfig.ts` 승격 (원위치).
 *
 * 원래 questail `cli.ts`에서 postie가 복제해간 코드이므로 core로 되돌린다.
 * 전역 설정 파일(~/.config/questail/.env)은 cli.ts가 관리한다
 * (CONFIG_DIR/CONFIG_FILE, loadEnvFile/saveConfig).
 * 이 모듈은 환경변수 읽기 전용으로, 호출 전 cli.ts initEnv()가
 * 전역 파일 → 로컬 .env 순으로 process.env에 로드해 둔다.
 *
 * 범용 OPENAI_* 대신 QUESTAIL_LLM_* 네임스페이스를 쓴다 — 전역 설정 파일을
 * 다른 로컬 도구와 공유하므로 이름 충돌을 피한다 (확정 설계 결정).
 */

import type { LlmOptions } from '../types.js';

export const QUESTAIL_LLM_BASE_URL = 'QUESTAIL_LLM_BASE_URL';
export const QUESTAIL_LLM_API_KEY = 'QUESTAIL_LLM_API_KEY';
export const QUESTAIL_LLM_MODEL = 'QUESTAIL_LLM_MODEL';

/** 빈 문자열은 미설정 취급하고 undefined로 돌린다. */
function readEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

/**
 * 전역 .env의 LLM 3개 키를 읽어 LlmOptions(baseUrl/apiKey/model)로 반환.
 * 설정 로드(cli.ts initEnv)가 선행되어야 한다.
 */
export function getLlmOptions(): LlmOptions {
  return {
    baseUrl: readEnv(QUESTAIL_LLM_BASE_URL),
    apiKey: readEnv(QUESTAIL_LLM_API_KEY),
    model: readEnv(QUESTAIL_LLM_MODEL),
  };
}
