/**
 * P3-F deterministic retrieval engine (LLM 없음).
 *
 * 파이프라인: start resolve → L0~L4 레벨 정책 → n-hop expansion →
 * 후보 선정 → RunTrace attempts. 성공한 레벨에서 멈추고 이후 레벨은
 * 실행하지 않는다. 답이 없으면 abstain 정상 trace로 L0~L4 전 시도를
 * 완전히 기록한다.
 *
 * mode는 입력에서 명시적으로 받는다. RunTrace에 mode 필드가 없어
 * (types.ts 동결) 결과로 그대로 돌려주므로 하류에서 추측하지 않는다.
 * RunTrace에 mode를 적재하려면 types.ts 필드 추가가 필요하다.
 */
import { createHash } from 'node:crypto';
import {
  configHash,
  snapshotConfig,
  type AttemptTrace,
  type Config,
  type GraphDeps,
  type RunTrace,
} from '../types.js';
import { expandPaths, type ExpansionResult } from './expand.js';
import { resolveStarts } from './resolve.js';
import { TAG_FALLBACK_REASON, selectPath, selectTagFallback, type Selection } from './select.js';
import { buildAttemptTrace, buildRunTrace, levelChainEntry, type LevelReport } from './trace.js';

export type RetrieveMode = 'real' | 'demo';

export interface RetrieveInput {
  readonly question: string;
  /** 호출자가 명시 — 엔진도 UI도 추측하지 않는다. */
  readonly mode: RetrieveMode;
  readonly config: Config;
  readonly deps: GraphDeps;
  readonly corpusFingerprint: string;
  /** LLM 호출이 없어도 기록한다. */
  readonly promptFingerprint: string;
  readonly modelId: string;
  /** 미지정 시 question+configHash sha256 파생(결정적). */
  readonly runId?: string;
  readonly startedAt?: string;
  /**
   * 있으면 그 표기로 시작 개체를 잡는다(정확 일치). 비어 있거나
   * 매칭 0건이면 question에서 resolve(기존 경로)한다.
   */
  readonly startTitles?: readonly string[];
}

export interface RetrieveResult {
  readonly trace: RunTrace;
  /** 입력 mode 그대로. */
  readonly mode: RetrieveMode;
}

export function deriveRunId(question: string, hash: string): string {
  return `ret-${createHash('sha256').update(`${question}\n${hash}`, 'utf8').digest('hex').slice(0, 16)}`;
}

export async function retrieve(input: RetrieveInput): Promise<RetrieveResult> {
  const startedAt = input.startedAt ?? new Date().toISOString();
  const hash = configHash(input.config);
  const runId = input.runId ?? deriveRunId(input.question, hash);
  const snapshot = snapshotConfig(input.config);
  const levels = input.config.graph.levels;

  const nodes = await input.deps.listNodes();
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const resolved = resolveStarts(input.question, input.config, nodes);
  // startTitles는 인덱스 검증된 정식 표기라 정확 일치로 잡는다.
  // resolve 규칙·정규화는 손대지 않는다.
  const titled =
    input.startTitles && input.startTitles.length > 0
      ? nodes.filter((node) => input.startTitles?.includes(node.label)).map((node) => node.id)
      : [];
  const starts = titled.length > 0 ? [...new Set(titled)].sort() : resolved.nodeIds;
  const mentionedDenylist = resolved.mentionedDenylist;
  const verifiedKeys = await input.deps.verifiedEdgeKeys();

  const attempts: AttemptTrace[] = [];
  const chain: string[] = [];
  let retrievalLevel: number | undefined;
  let selectedPath: RunTrace['selectedPath'] = null;
  let evidence: RunTrace['evidenceSpans'] = [];

  if (starts.length === 0) {
    for (const [index, policy] of levels.entries()) {
      const report: LevelReport = {
        level: policy.level,
        radius: policy.radius,
        outcome: 'entity_unresolved',
        stopReason: index === levels.length - 1 ? 'level_exhausted' : 'no_paths',
        candidates: 0,
        evidence: 0,
        blockedHubs: [],
        blockReasons: [],
        selectReason: 'entity-unresolved',
      };
      attempts.push(buildAttemptTrace(report));
      chain.push(levelChainEntry(report));
    }
  } else {
    // 1단계: 정상 선정만으로 L0~L4를 돈다. 성공하면 기존 동작 그대로
    // 반환하고 폴백에는 들어가지 않는다(배타성: 26게임 불변의 근거).
    const stored: { policy: (typeof levels)[number]; expansion: ExpansionResult; selection: Selection; fail: LevelReport }[] = [];
    for (const [index, policy] of levels.entries()) {
      const expansion = await expandPaths(input.deps, {
        policy,
        starts,
        mentionedDenylist,
        relationTypes: input.config.graph.canonicalEdgeTypes,
        verifiedKeys,
        maxCandidates: input.config.graph.maxCandidates,
        nodes: nodeById,
      });
      const selection = await selectPath(input.deps, expansion.candidates, {
        answerEvidenceMin: input.config.graph.answerEvidenceMin,
        maxPaths: input.config.graph.maxPaths,
        nodes: nodeById,
      });

      let report: LevelReport;
      if (selection.path !== null) {
        report = {
          level: policy.level,
          radius: policy.radius,
          outcome: 'paths_found',
          stopReason: 'paths_found',
          candidates: expansion.candidates.length,
          evidence: selection.evidence.length,
          blockedHubs: expansion.blockedHubs,
          blockReasons: expansion.blockReasons,
          selectReason: 'ok',
        };
        attempts.push(buildAttemptTrace(report));
        retrievalLevel = policy.level;
        selectedPath = selection.path;
        evidence = [...selection.evidence];
        break;
      }

      const isLast = index === levels.length - 1;
      if (expansion.candidates.length === 0) {
        report = {
          level: policy.level,
          radius: policy.radius,
          outcome: 'no_paths',
          stopReason: isLast
            ? 'level_exhausted'
            : expansion.blockedHubs.length > 0
              ? 'all_hubs_blocked'
              : 'no_paths',
          candidates: 0,
          evidence: selection.evidence.length,
          blockedHubs: expansion.blockedHubs,
          blockReasons: expansion.blockReasons,
          selectReason: selection.reason,
        };
      } else {
        const shortfall = selection.reason.startsWith('evidence');
        report = {
          level: policy.level,
          radius: policy.radius,
          outcome: shortfall ? 'no_source_chunks' : 'no_paths',
          stopReason: isLast ? 'level_exhausted' : expansion.capped ? 'budget_exhausted' : shortfall ? 'budget_exhausted' : 'no_paths',
          candidates: expansion.candidates.length,
          evidence: selection.evidence.length,
          blockedHubs: expansion.blockedHubs,
          blockReasons: expansion.blockReasons,
          selectReason: selection.reason,
        };
      }
      attempts.push(buildAttemptTrace(report));
      chain.push(levelChainEntry(report));
      stored.push({ policy, expansion, selection, fail: report });
    }

    // 2단계: 결과 기준 태그 폴백. 1단계에서 정상 경로가 하나라도
    // 선정됐으면 여기 오지 않는다. L0 후보가 존재하고 전부 태그 전용일
    // 때만 희소 태그 순으로 선정한다. L0에만 두는 이유: L0은 기본 정책
    // (tagDf 3~15·radius 2)의 직접 공유 태그 집합이라 완화 사다리의
    // 의미(rare-tag 완화·verified relation·cap 확장)를 건드리지 않고,
    // 경로 모양도 game-tag-game 2홉이라 화면 표시(HAS_TAG)가 가장
    // 해석 가능하다. L1+ 후보에는 손대지 않으므로 사다리 완화의
    // 기존 실패(best 근거·abstain)도 그대로 유지된다.
    if (selectedPath === null) {
      // 태그가 질문에 언급돼 resolveStarts가 태그를 시작점에 넣으면
      // 태그 출발 1홉 후보가 생긴다. 폴백은 시작 게임에서 출발하는
      // 경로만 본다.
      const gameStarts = new Set(starts.filter((id) => nodeById.get(id)?.kind === 'game'));
      for (const [index, entry] of stored.entries()) {
        if (entry.policy.level !== 0) continue;
        if (entry.expansion.candidates.length === 0) continue;
        if (entry.selection.eligibleCount !== 0) continue;
        const anchored = entry.expansion.candidates.filter((path) => gameStarts.has(path.nodes[0] as string));
        if (anchored.length === 0) continue;
        const fallback = await selectTagFallback(input.deps, anchored, {
          answerEvidenceMin: input.config.graph.answerEvidenceMin,
          maxPaths: input.config.graph.maxPaths,
          nodes: nodeById,
        });
        if (fallback.path === null) continue;
        const report: LevelReport = {
          level: entry.policy.level,
          radius: entry.policy.radius,
          outcome: 'paths_found',
          stopReason: 'paths_found',
          candidates: entry.expansion.candidates.length,
          evidence: fallback.evidence.length,
          blockedHubs: entry.expansion.blockedHubs,
          blockReasons: entry.expansion.blockReasons,
          selectReason: TAG_FALLBACK_REASON,
        };
        const headAttempts = attempts.slice(0, index);
        headAttempts.push(buildAttemptTrace(report));
        attempts.length = 0;
        attempts.push(...headAttempts);
        const headChain = chain.slice(0, index);
        headChain.push(levelChainEntry(report));
        chain.length = 0;
        chain.push(...headChain);
        retrievalLevel = entry.policy.level;
        selectedPath = fallback.path;
        evidence = [...fallback.evidence];
        break;
      }
    }
  }

  const abstained = selectedPath === null;
  const usedTagFallback = !abstained && chain.some((entry) => entry.includes(TAG_FALLBACK_REASON));
  let relaxationReason: string | undefined;
  if (abstained) {
    relaxationReason = `${chain.join(' → ')} → abstain`;
  } else if (usedTagFallback) {
    relaxationReason = `${chain.join(' → ')} → L${retrievalLevel} tag-fallback paths_found`;
  } else if (retrievalLevel !== undefined && retrievalLevel > 0) {
    relaxationReason = `${chain.join(' → ')} → L${retrievalLevel} paths_found`;
  }

  const trace = buildRunTrace({
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    configHash: hash,
    configSnapshot: snapshot,
    corpusFingerprint: input.corpusFingerprint,
    promptFingerprint: input.promptFingerprint,
    modelId: input.modelId,
    retrievalLevel,
    relaxationReason,
    attempts,
    selectedPath,
    evidenceSpans: evidence,
    abstained,
  });
  return { trace, mode: input.mode };
}
