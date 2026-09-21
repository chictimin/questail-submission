/**
 * tools/eval/score.ts — 채점 규칙 (W-B 소유).
 *
 * collie `src/evaluate.ts` 의 `toolScoreFor` 와 같은 판정이다. 규칙을 두 벌로
 * 두지 않기 위해 원본 본문을 그대로 옮겼다. 원본이 바뀌면 여기도 함께 바꾼다.
 */
import type { ToolName } from '../../packages/core/src/agent/types.js';

/** 순서 무시 집합 비교. 정확히 일치만 1점, 부분 점수 없음. */
export function toolScoreFor(actual: ToolName[], expected: ToolName[]): 0 | 1 {
  if (actual.length !== expected.length) return 0;
  const set = new Set(actual);
  return expected.every((t) => set.has(t)) ? 1 : 0;
}
