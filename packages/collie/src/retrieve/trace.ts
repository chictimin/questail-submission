/**
 * P3-F RunTrace 조립 헬퍼.
 *
 * AttemptTrace에는 reason 자유문 필드가 없으므로(types.ts 동결),
 * 레벨별 후보/거절 사유는 relaxationReason 체인에 `L{n} ...` 접두로 남긴다.
 * full abstain trace에서도 매 레벨이 attempted level·blocked hubs·
 * candidate/rejection reason을 구조화 필드로 갖도록 강제한다.
 */
import type { AttemptTrace, RunTrace } from '../types.js';

export type LevelStop = Pick<AttemptTrace, 'stopReason' | 'outcome'>;

export interface LevelReport {
  readonly level: number;
  readonly radius: number;
  readonly outcome: AttemptTrace['outcome'];
  readonly stopReason: AttemptTrace['stopReason'];
  /** 해당 레벨의 raw 후보 수. */
  readonly candidates: number;
  /** 해당 레벨에서 수집된 근거 수(실패 시에도 best를 기록). */
  readonly evidence: number;
  readonly blockedHubs: readonly string[];
  /** 'nodeId: reason' — hub handling 사유 trace. */
  readonly blockReasons: readonly string[];
  /** select 단 사유 ('ok' | 'no-non-tag-edge' | 'evidence-shortfall…'). */
  readonly selectReason: string;
}

const MAX_HUBS_IN_CHAIN = 6;

/** 단일 레벨 사유를 relaxationReason 체인 한 토막으로 만든다. */
export function levelChainEntry(report: LevelReport): string {
  const parts = [`L${report.level} ${report.stopReason}`, `후보 ${report.candidates}`];
  if (report.selectReason !== 'ok') parts.push(report.selectReason);
  if (report.blockedHubs.length > 0) {
    const shown = report.blockReasons.slice(0, MAX_HUBS_IN_CHAIN).join('; ');
    const more = report.blockReasons.length > MAX_HUBS_IN_CHAIN ? ` (+${report.blockReasons.length - MAX_HUBS_IN_CHAIN}건)` : '';
    parts.push(`차단: ${shown}${more}`);
  }
  return parts.join(' ');
}

export function buildAttemptTrace(report: LevelReport): AttemptTrace {
  return {
    level: report.level,
    radius: report.radius,
    outcome: report.outcome,
    pathsFound: report.candidates,
    evidenceSpans: report.evidence,
    blockedHubs: [...report.blockedHubs],
    stopReason: report.stopReason,
  };
}

export interface RunTraceArgs {
  readonly runId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly configHash: string;
  readonly configSnapshot: RunTrace['configSnapshot'];
  readonly corpusFingerprint: string;
  readonly promptFingerprint: string;
  readonly modelId: string;
  readonly retrievalLevel?: number;
  readonly relaxationReason?: string;
  readonly attempts: readonly AttemptTrace[];
  readonly selectedPath: RunTrace['selectedPath'];
  readonly evidenceSpans: RunTrace['evidenceSpans'];
  readonly abstained: boolean;
}

export function buildRunTrace(args: RunTraceArgs): RunTrace {
  return {
    runId: args.runId,
    startedAt: args.startedAt,
    completedAt: args.completedAt,
    configHash: args.configHash,
    configSnapshot: args.configSnapshot,
    corpusFingerprint: args.corpusFingerprint,
    promptFingerprint: args.promptFingerprint,
    modelId: args.modelId,
    ...(args.retrievalLevel === undefined ? {} : { retrievalLevel: args.retrievalLevel }),
    ...(args.relaxationReason === undefined ? {} : { relaxationReason: args.relaxationReason }),
    attempts: [...args.attempts],
    selectedPath: args.selectedPath ?? null,
    evidenceSpans: [...args.evidenceSpans],
    abstained: args.abstained,
  };
}
