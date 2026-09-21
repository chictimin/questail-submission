/**
 * LLM 어댑터 — questail-postie `src/llmLocal.ts` 승격.
 *
 * D3: 단일 엔드포인트 + 무LLM 폴백. 폴백은 "빈 리포트"가 아니라
 * "해석 없는 정량 리포트" — 호출부(analyze)가 이 경계를 지킨다.
 *
 * postie는 OpenAI SDK로 호출했지만 core에는 openai 의존성이 없으므로
 * Node 내장 fetch로 OpenAI 호환 /chat/completions 엔드포인트를 직접 호출한다
 * (동작 동일: 타임아웃 180s, 재시도 1회, thinking 태그 제거, JSON 추출).
 */

import type { LlmOptions } from '../types.js';

/**
 * LLM 호출 상한: 타임아웃 180초 × 시도 2회(최초 1 + 재시도 1) = 호출당 최악 6분.
 * (postie 주석 그대로 — translate 바깥 재시도까지 겹치면 항목당 최악 12분)
 */
export const LLM_TIMEOUT_MS = 180_000;
export const LLM_MAX_RETRIES = 1;

/** postie sniff 기본값 그대로 (OpenAI 원격 / 로컬 추론 서버). */
export const LLM_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const LLM_DEFAULT_MODEL = 'gpt-4o-mini';
export const LLM_DEFAULT_LOCAL_BASE_URL = 'http://localhost:11434/v1';
export const LLM_DEFAULT_LOCAL_MODEL = 'llama3.1';

/** 로컬호스트 baseURL 판정 (Ollama·LM Studio 등 로컬 추론 서버). */
export function isLocalhostUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.');
  } catch {
    return false;
  }
}

/**
 * 호출 가능한 엔드포인트가 있는가 (키 유무가 아니라 baseUrl 유무로 판정 — 로컬호스트는 키 불필요).
 * 키가 있으면 원격·로컬 모두 호출, 키가 없어도 로컬 엔드포인트면 호출한다.
 * 원격 baseURL + 키 없음은 폴백한다.
 */
export function canCallLlm(options: LlmOptions): boolean {
  if (options.apiKey && options.apiKey.trim()) return true;
  return !!options.baseUrl && isLocalhostUrl(options.baseUrl);
}

/** fetch는 빈 키에 throw하지 않지만, 헤더 존재를 요구하는 로컬 서버용으로 더미 키를 채운다 (인증용이 아님). */
export function effectiveApiKey(apiKey?: string): string {
  return apiKey && apiKey.trim() ? apiKey : 'local';
}

/** thinking 모델의 <think> 블록과 코드펜스를 제거한다. */
export function stripLlmNoise(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?(\/think>|$)/gi, '')
    .replace(/```(?:\w+)?\n?/g, '');
}

/** 응답에서 JSON 페이로드를 꺼낸다. 없으면 노이즈 제거된 원문을 돌려준다. */
export function extractJsonPayload(raw: string): string {
  const cleaned = stripLlmNoise(raw);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) return cleaned.slice(start, end + 1);
  return cleaned;
}

/** 폴백으로 내려갈 때 이유를 stderr에 한 줄 남긴다 (무음 catch 방지). 타임아웃은 구분 표기. */
export function warnFallback(stage: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  const kind = /timeout|timed out|abort/i.test(reason) ? '타임아웃' : '실패';
  console.error(`[${stage}] LLM 호출 ${kind}(${LLM_TIMEOUT_MS}ms), 폴백 사용: ${reason}`);
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * OpenAI 호환 엔드포인트에 prompt를 보내고 응답 텍스트를 돌린다.
 * <think> 제거 + JSON 추출까지 적용한다 (JSON이 없으면 정제된 원문 그대로).
 * 엔드포인트가 없거나 원격 호출에 키가 없으면 throw — 호출부는 먼저
 * canCallLlm()으로 폴백 여부를 가른다.
 */
export async function callLlm(options: LlmOptions, prompt: string): Promise<string> {
  const baseUrl = options.baseUrl?.trim();
  if (!baseUrl) {
    throw new Error('LLM baseUrl이 설정되지 않았습니다 (QUESTAIL_LLM_BASE_URL).');
  }
  if (!canCallLlm(options)) {
    throw new Error('LLM 호출 불가: 원격 엔드포인트에 API 키가 없습니다.');
  }
  const model = options.model?.trim() || LLM_DEFAULT_MODEL;
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const timeoutMs = options.timeoutMs ?? LLM_TIMEOUT_MS;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // 기본 헤더 + options.headers 병합. authorization·content-type은
      // 대소문자 무관하게 보호한다 (호출자가 실수로 덮어쓰는 것 방지).
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${effectiveApiKey(options.apiKey)}`,
      };
      for (const [key, value] of Object.entries(options.headers ?? {})) {
        const lower = key.toLowerCase();
        if (lower === 'authorization' || lower === 'content-type') continue;
        headers[key] = value;
      }
      const body: Record<string, unknown> = {
        model,
        messages: [{ role: 'user', content: prompt }],
      };
      if (options.temperature !== undefined) body.temperature = options.temperature;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const data = (await res.json()) as ChatCompletionResponse;
      const raw = data.choices?.[0]?.message?.content ?? '';
      return extractJsonPayload(raw);
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
