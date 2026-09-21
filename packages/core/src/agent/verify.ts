/**
 * 순수 문자열 검사. LLM이 아니라 코드로 검사한다.
 *
 * questail-collie `src/nodes/verify.ts`(동결 `20eb941`)에서 이식했다.
 * 이식하며 바뀐 점: 인용 패턴을 `VerifyOptions.citationPattern` 으로 받는다.
 * 기본값이 기존 `/D-[A-F]\b/` 라 동작은 동일하다. docId 는 열린 string 이라
 * collie 의 `as DocId` 캐스팅은 없다.
 */

import type {
  EvidenceChunk,
  QueryCategory,
  VerifyOptions,
  VerifyResult,
  Violation,
} from './types.js';
import type { LibraryIndex } from '../types.js';

const NUMBER_RE = /\d+(?:[.,]\d+)*/g;
const QUOTED_RE = /["'「」『』“”‘’]([^"'「」『』“”‘’]{1,60})["'「」『』“”‘’]/g;
const DEFAULT_CITATION_PATTERN = /D-[A-F]\b/;

function normalizeNumber(token: string): string {
  return token.replace(/,/g, '');
}

/** 답변 속 숫자 토큰이 조립된 근거 텍스트에 문자열로 존재하는지 대조한다. */
function checkUngroundedNumbers(answer: string, evidenceText: string): Violation | null {
  const normalized = evidenceText.replace(/,/g, '');
  const tokens = new Set<string>();
  for (const m of answer.matchAll(NUMBER_RE)) tokens.add(normalizeNumber(m[0]));
  const missing = [...tokens].filter((t) => !normalized.includes(t));
  if (missing.length === 0) return null;
  return { rule: 'UNGROUNDED_NUMBER', detail: `근거에 없는 숫자: ${missing.join(', ')}` };
}

/**
 * 인용부호로 묶인 게임명 후보가 library 제목 집합에 있는지 대조한다.
 * 근거 텍스트 안에 그대로 있는 인용(질문 되묻기 등)은 게임명 주장으로 보지 않는다.
 */
function checkUnknownGames(
  answer: string,
  library: LibraryIndex,
  evidenceText: string,
): Violation | null {
  const titles = library.games.map((g) => g.title.trim().toLowerCase()).filter(Boolean);
  const unknown: string[] = [];
  for (const m of answer.matchAll(QUOTED_RE)) {
    const candidate = m[1].trim();
    if (!candidate) continue;
    const norm = candidate.toLowerCase();
    const inLibrary = titles.some((t) => t.includes(norm) || norm.includes(t));
    if (!inLibrary && !evidenceText.includes(candidate)) unknown.push(candidate);
  }
  if (unknown.length === 0) return null;
  return { rule: 'UNKNOWN_GAME', detail: `라이브러리에 없는 게임명 인용: ${unknown.join(', ')}` };
}

/** OUT_OF_SCOPE 분류인데 근거 인용(인용 표기·청크 id·청크 heading)이 있으면 위반이다. */
function checkCitedWhileOutOfScope(
  answer: string,
  category: QueryCategory,
  evidence: EvidenceChunk[],
  citationPattern: RegExp,
): Violation | null {
  if (category !== 'OUT_OF_SCOPE') return null;
  const cited =
    citationPattern.test(answer) ||
    evidence.some(
      (e) => answer.includes(e.id) || (e.heading !== '' && answer.includes(e.heading)),
    );
  if (!cited) return null;
  return { rule: 'CITED_WHILE_OUT_OF_SCOPE', detail: '범위 밖 분류인데 근거를 인용함' };
}

/**
 * LLM이 아니라 코드로 검사한다. 세 규칙을 전부 적용하고
 * 위반이 하나도 없으면 passed다.
 */
export function verifyAnswer(
  answer: string,
  category: QueryCategory,
  evidence: EvidenceChunk[],
  library: LibraryIndex,
  options?: VerifyOptions,
): VerifyResult {
  const citationPattern = options?.citationPattern ?? DEFAULT_CITATION_PATTERN;
  const evidenceText = evidence.map((e) => `${e.heading}\n${e.text}`).join('\n');
  const violations: Violation[] = [];
  const checks = [
    checkUngroundedNumbers(answer, evidenceText),
    checkUnknownGames(answer, library, evidenceText),
    checkCitedWhileOutOfScope(answer, category, evidence, citationPattern),
  ];
  for (const v of checks) if (v) violations.push(v);
  return { passed: violations.length === 0, violations };
}
