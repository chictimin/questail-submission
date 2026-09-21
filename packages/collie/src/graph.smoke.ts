/** graph shell smoke: abstain 경로·escalation 위상·조건부 라우팅·verify 재생성 규칙. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { END } from '@langchain/langgraph';
import {
  abstainNode,
  answerNode,
  createShellGraph,
  escalateNode,
  initialShellState,
  policyNode,
  routeAfterRetrieve,
  routeAfterVerify,
  runShell,
  verifyNode,
  type ShellState,
} from './graph.js';

describe('shell graph', () => {
  it('스텁 검색은 paths 없이 즉시 abstain으로 끝난다', async () => {
    const result = await runShell('Lumen Reach 1은 어느 시리즈인가?');
    assert.equal(result.abstained, true);
    assert.equal(result.regenerated, false);
    assert.equal(result.escalationCount, 0);
    assert.deepEqual(result.attempts, [{ level: 0, outcome: 'no_paths' }]);
    assert.equal(result.answer, '');
  });

  it('retrieve 조건부: respond·escalate·abstain 3갈래를 가른다', () => {
    const base = initialShellState('q');
    assert.equal(routeAfterRetrieve({ ...base, paths: ['p1'] }), 'respond');
    assert.equal(
      routeAfterRetrieve({ ...base, paths: [], escalationBudget: 1, escalations: [] }),
      'escalate',
    );
    assert.equal(routeAfterRetrieve({ ...base, paths: [] }), 'abstain');
    assert.equal(
      routeAfterRetrieve({ ...base, paths: [], escalationBudget: 1, escalations: [0] }),
      'abstain',
    );
  });

  it('escalation 위상: escalate 기록 후 policy back-edge로 돌아와 abstain한다', () => {
    const graph = createShellGraph();
    const staticEdges = new Set(
      [...graph.builder.edges].map(([source, target]) => `${String(source)}->${String(target)}`),
    );
    assert.ok(staticEdges.has('escalate->policy'));
    assert.ok(staticEdges.has('policy->retrieve'));

    // 실제 노드·라우터로 back-edge 경로를 걷는다. 셸 정책이 예산을
    // 0으로 되돌리므로 두 번째 retrieve는 abstain으로 귀결된다.
    const start: ShellState = { ...initialShellState('q'), escalationBudget: 1 };
    assert.equal(routeAfterRetrieve(start), 'escalate');
    assert.deepEqual(escalateNode(start).escalations, [0]);
    const afterEscalate: ShellState = { ...start, escalations: [start.level] };
    const policyOut = policyNode(afterEscalate);
    const afterPolicy: ShellState = {
      ...afterEscalate,
      level: policyOut.level ?? afterEscalate.level,
      escalationBudget: policyOut.escalationBudget ?? afterEscalate.escalationBudget,
    };
    assert.equal(afterPolicy.escalationBudget, 0);
    assert.equal(routeAfterRetrieve(afterPolicy), 'abstain');
  });

  it('verify 조건부: 통과→END, 1회 실패→respond, 재생성 후 실패→END', () => {
    const base = initialShellState('q');
    assert.equal(routeAfterVerify({ ...base, verify: { passed: true, reason: 'ok' } }), END);
    assert.equal(
      routeAfterVerify({ ...base, verify: { passed: false, reason: 'empty_answer' }, regenerated: false }),
      'respond',
    );
    assert.equal(
      routeAfterVerify({ ...base, verify: { passed: false, reason: 'empty_answer' }, regenerated: true }),
      END,
    );
  });

  it('answer 두 번째 진입은 regenerated를 올리고 verify 스텁이 판정한다', () => {
    const base = initialShellState('q');
    const first = answerNode(base);
    assert.equal(first.regenerated, false);
    const afterFirst: ShellState = {
      ...base,
      answer: first.answer ?? '',
      regenerated: first.regenerated ?? false,
    };
    const verified = verifyNode(afterFirst);
    assert.equal(verified.verify?.passed, true);
    const afterVerify: ShellState = {
      ...afterFirst,
      verify: { passed: verified.verify?.passed ?? false, reason: verified.verify?.reason ?? '' },
    };
    const second = answerNode(afterVerify);
    assert.equal(second.regenerated, true);
    assert.equal(abstainNode(base).abstained, true);
  });
});
