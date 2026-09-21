/**
 * collie LLM 경계 (P2-D).
 *
 * 자격증명(apiKey/baseUrl/model)은 요청 단위 메모리 객체로만 흐른다. 전역
 * 저장·config·env·RunTrace·log·응답에 키를 싣지 않는다. provider HTTP 호출은
 * 이 단계에서 하지 않으며, 모든 호출은 이후 단계에서도 서버 측에서만 난다.
 * 브라우저가 provider에 직접 요청하지 않는다. 키가 없으면 결정적 스텁으로
 * 답하고, 키가 있어도 실제 추출은 P3-E 전까지 명시 오류로 막는다.
 */

export interface LlmCredentialsInput {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
}

export interface LlmCredentials {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly model: string;
}

/** 외부 호출 없는 로컬 기본값. 키 기본값은 두지 않는다. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
export const DEFAULT_MODEL = '';
export const REDACTED = '[redacted]';
/** HTTP 에러 본문 스니펫 상한(문자 수). 제공자의 원인 설명을 살리되 로그 폭주를 막는다. */
export const HTTP_ERROR_BODY_SNIPPET_LENGTH = 200;

export function resolveLlmCredentials(input: LlmCredentialsInput = {}): LlmCredentials {
  const apiKey = input.apiKey?.trim() ? input.apiKey.trim() : undefined;
  const baseUrl = input.baseUrl?.trim() ? input.baseUrl.trim() : DEFAULT_BASE_URL;
  const model = input.model?.trim() ? input.model.trim() : DEFAULT_MODEL;
  return apiKey === undefined ? { baseUrl, model } : { apiKey, baseUrl, model };
}

export function hasApiKey(credentials: LlmCredentials): boolean {
  return credentials.apiKey !== undefined && credentials.apiKey.length > 0;
}

const SECRET_KEY_PATTERN = /api[_-]?key|token|secret|password|authorization/i;

/** log/응답에 싣기 전 키류 값을 지운 깊은 복사본을 돌려준다. */
export function redactSecrets<T>(value: T): T {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry)) as T;
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(entry);
    }
    return copy as T;
  }
  return value;
}

/** 키 없이 내는 결정적 미리보기. LLM을 호출하지 않는다. */
export function stubAnswer(question: string): string {
  return `[collie-stub] 키 없이 결정적 미리보기만 냅니다: ${question.trim()}`;
}

export class CollieLlmError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CollieLlmError';
    this.code = code;
  }
}

export interface ChatMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

/** 자유 텍스트에 섞인 API 키 원문을 지운다. 에러 메시지·로그 적재 직전에 쓴다. */
export function maskApiKeyText(text: string, apiKey?: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join(REDACTED);
}

/**
 * HTTP 에러 본문 앞부분을 `: 본문` 형태로 돌려준다. 본문이 비었거나
 * 읽기에 실패하면 빈 문자열. 키가 본문에 섞여도 새지 않게 마스킹하고
 * 기존 redactSecrets 경로를 통과시킨다.
 */
async function readHttpErrorSnippet(response: Response, apiKey?: string): Promise<string> {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    return '';
  }
  const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, HTTP_ERROR_BODY_SNIPPET_LENGTH);
  if (snippet === '') return '';
  const masked = redactSecrets({ body: maskApiKeyText(snippet, apiKey) }).body;
  return `: ${masked}`;
}

/**
 * P3-E 서버 측 OpenAI 호환 chat 호출 1회. 키는 Authorization 헤더로만
 * 나가고, 에러·로그에 자격증명을 절대 싣지 않는다
 * (HTTP 에러 본문은 200자 스니펫만 마스킹 후 메시지에 싣는다).
 */
export async function completeChat(
  credentials: LlmCredentials,
  messages: readonly ChatMessage[],
  options: { readonly maxTokens?: number; readonly timeoutMs?: number } = {},
): Promise<string> {
  if (!hasApiKey(credentials)) {
    throw new CollieLlmError('LLM_API_KEY_MISSING', 'LLM 키가 없어 완성을 수행하지 않습니다.');
  }
  const url = `${credentials.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credentials.apiKey as string}`,
      },
      body: JSON.stringify({
        model: credentials.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: 0,
        max_tokens: options.maxTokens ?? 1024,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60000),
    });
  } catch (error: unknown) {
    throw new CollieLlmError(
      'LLM_REQUEST_FAILED',
      `LLM 요청 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new CollieLlmError(
      'LLM_HTTP_ERROR',
      `LLM HTTP 오류: ${response.status}${await readHttpErrorSnippet(response, credentials.apiKey)}`,
    );
  }
  let data: unknown;
  try {
    data = (await response.json()) as unknown;
  } catch {
    throw new CollieLlmError('LLM_BAD_RESPONSE', 'LLM 응답을 JSON으로 읽지 못했습니다.');
  }
  const content =
    typeof data === 'object' &&
    data !== null &&
    Array.isArray((data as { choices?: unknown }).choices) &&
    typeof (data as { choices: [{ message?: { content?: unknown } }] }).choices[0]?.message?.content ===
      'string'
      ? ((data as { choices: [{ message?: { content?: string } }] }).choices[0]?.message?.content as string)
      : undefined;
  if (content === undefined) {
    throw new CollieLlmError('LLM_BAD_RESPONSE', 'LLM 응답에 completion 텍스트가 없습니다.');
  }
  return content;
}

/**
 * P2-D에서는 실제 완성을 수행하지 않는다. 키가 없으면 키 누락 오류, 키가
 * 있으면 미구현 오류를 낸다. 실제 추출 호출은 P3-E가 서버 측에만 둔다.
 */
export async function completeWithLlm(
  credentials: LlmCredentials,
  _prompt: string,
): Promise<string> {
  if (!hasApiKey(credentials)) {
    throw new CollieLlmError('LLM_API_KEY_MISSING', 'LLM 키가 없어 완성을 수행하지 않습니다.');
  }
  throw new CollieLlmError(
    'LLM_EXTRACTION_NOT_IMPLEMENTED',
    'LLM 관계 추출은 P3-E 전까지 비활성화되어 있습니다.',
  );
}
