/**
 * P3-E extract 전용 pure tests (LLM 호출 없음).
 *
 * 실행: `tsc -p packages/collie` 후 `node --test packages/collie/dist/extract.test.js`
 * 결정적이며 외부 상태를 건드리지 않는다 (env 로더 테스트만 OS 임시 디렉터리 사용).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applySeriesGate,
  buildPrompt,
  buildTitleIndex,
  computeDemoMetrics,
  extractConfigHash,
  flagExtendedFPs,
  loadEnvFile,
  loadExtractionPolicy,
  orderSample,
  parseArgs,
  parseResponseText,
  promptHashOf,
  PROMPT_VERSION,
  resolveExtractCredentials,
  resolveTitleTarget,
  safeBaseUrl,
  SAMPLE_SEED,
  stableSampleKey,
  validateTriple,
  type CanonicalTriple,
  type SampleCandidate,
} from './extract.js';

const BODY = 'Lumen Reach 2 continues the story of Lumen Reach 1, resuming the first expedition.';
const TITLES = buildTitleIndex([
  { appid: 900001, title: 'Lumen Reach 1' },
  { appid: 900002, title: 'Lumen Reach 2' },
]);

function triple(partial: Partial<CanonicalTriple> = {}): CanonicalTriple {
  return {
    type: 'SEQUEL_OF',
    source: 900002,
    target: 900001,
    sentence: BODY,
    expression: 'continues the story of Lumen Reach 1',
    ...partial,
  };
}

describe('env·credentials (값 출력 없음)', () => {
  it('KEY=VALUE·주석·빈줄·무효줄 파싱', () => {
    const dir = mkdtempSync(join(tmpdir(), 'questail-extract-test-'));
    const file = join(dir, '.env');
    writeFileSync(file, '# comment\n\nQUESTAIL_LLM_MODEL=m\nEMPTY=\nNOEQUALS\nA=B=C\n');
    assert.deepEqual(loadEnvFile(file), { QUESTAIL_LLM_MODEL: 'm', EMPTY: '', A: 'B=C' });
    assert.deepEqual(loadEnvFile(join(dir, 'missing')), {});
  });

  it('QUESTAIL_LLM_* 세 키만 주입 대상으로 고른다', () => {
    assert.deepEqual(
      resolveExtractCredentials({ QUESTAIL_LLM_API_KEY: 'k', QUESTAIL_LLM_BASE_URL: 'b', QUESTAIL_LLM_MODEL: 'm', OTHER: 'x' }),
      { apiKey: 'k', baseUrl: 'b', model: 'm' },
    );
    assert.deepEqual(resolveExtractCredentials({}), { apiKey: undefined, baseUrl: undefined, model: undefined });
  });

  it('safeBaseUrl은 userinfo를 제거·무효 URL은 마커', () => {
    assert.equal(safeBaseUrl('https://user:pass@host:8080/v1/'), 'https://host:8080/v1');
    assert.equal(safeBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
    assert.equal(safeBaseUrl(':::/'), '[invalid-url]');
  });

  it('configHash 서명에 키 자리가 없음 (baseUrl·model·허용 relation만)', () => {
    const base = { baseUrl: 'b', model: 'm', allowed: ['SEQUEL_OF', 'SAME_UNIVERSE'] as const };
    const a = extractConfigHash({ ...base, allowed: [...base.allowed] });
    const b = extractConfigHash({ ...base, allowed: [...base.allowed] });
    const c = extractConfigHash({ baseUrl: 'b', model: 'other', allowed: [...base.allowed] });
    const d = extractConfigHash({ baseUrl: 'b', model: 'm', allowed: ['SEQUEL_OF'] as const });
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.notEqual(a, d);
    assert.equal(a.length, 64);
  });
});

describe('prompt (본문+당 문서 제목, appid 숫자 없음)', () => {
  it('frontmatter 값·appid 유출 없음·제목·본문 포함', () => {
    const prompt = buildPrompt('Lumen Reach 1', BODY);
    assert.ok(prompt.includes(BODY));
    assert.ok(prompt.includes('Lumen Reach 1'));
    for (const leak of ['900001', '900002', 'GAME APPID', 'Northstar Studio 1', 'Story Rich', 'developers', 'votes']) {
      assert.ok(!prompt.includes(leak), `leak: ${leak}`);
    }
  });

  it('promptHash는 버전+본문에 종속', () => {
    assert.equal(promptHashOf(buildPrompt('T', BODY)), promptHashOf(buildPrompt('T', BODY)));
    assert.notEqual(promptHashOf(buildPrompt('T', BODY)), promptHashOf(buildPrompt('T', BODY + ' ')));
    assert.notEqual(promptHashOf(buildPrompt('T', BODY)), promptHashOf(buildPrompt('U', BODY)));
    assert.notEqual(
      promptHashOf(buildPrompt('T', BODY)),
      promptHashOf(buildPrompt('T', BODY, ['SEQUEL_OF'])),
    );
    assert.ok(PROMPT_VERSION.length > 0);
  });

  it('허용 집합에 따라 IN_SERIES bullet 포함/제거', () => {
    const full = buildPrompt('T', BODY);
    const noSeries = buildPrompt('T', BODY, ['SEQUEL_OF', 'SAME_UNIVERSE']);
    assert.ok(full.includes('"type":"IN_SERIES"'));
    assert.ok(!noSeries.includes('IN_SERIES'));
    assert.ok(noSeries.includes('"type":"SEQUEL_OF"'));
    assert.ok(noSeries.includes('"type":"SAME_UNIVERSE"'));
  });
});

describe('loadExtractionPolicy', () => {
  const writeConfig = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'questail-policy-test-'));
    const file = join(dir, 'default.json');
    writeFileSync(file, content);
    return file;
  };

  it('config corpus 플래그 읽기·정본 순서 고정', async () => {
    const file = writeConfig(
      '{"graph":{"extraction":{"real":{"relations":["SAME_UNIVERSE","SEQUEL_OF"]},"demo":{"relations":["IN_SERIES","SEQUEL_OF","SAME_UNIVERSE"]}}}}',
    );
    assert.deepEqual(await loadExtractionPolicy('real', file), ['SEQUEL_OF', 'SAME_UNIVERSE']);
    assert.deepEqual(await loadExtractionPolicy('demo', file), ['IN_SERIES', 'SEQUEL_OF', 'SAME_UNIVERSE']);
  });

  it('섹션·파일 누락 시 전종 허용, 미지정 타입은 throw', async () => {
    const file = writeConfig('{"graph":{}}');
    assert.deepEqual(await loadExtractionPolicy('real', file), ['IN_SERIES', 'SEQUEL_OF', 'SAME_UNIVERSE']);
    assert.deepEqual(await loadExtractionPolicy('demo', join(tmpdir(), 'questail-no-such-dir', 'x.json')), [
      'IN_SERIES',
      'SEQUEL_OF',
      'SAME_UNIVERSE',
    ]);
    const bad = writeConfig('{"graph":{"extraction":{"real":{"relations":["PREQUEL_OF"]}}}}');
    await assert.rejects(() => loadExtractionPolicy('real', bad), /미지정 타입/);
  });
});

describe('buildTitleIndex·resolveTitleTarget', () => {
  it('exact 우선·정규화 단일 매치', () => {
    const index = buildTitleIndex([
      { appid: 1, title: 'Alpha' },
      { appid: 3, title: 'Beta' },
    ]);
    assert.deepEqual(resolveTitleTarget(index, 'Alpha'), { ok: true, appid: 1 });
    assert.deepEqual(resolveTitleTarget(index, 'alpha'), { ok: true, appid: 1 });
    assert.deepEqual(resolveTitleTarget(index, 'Beta'), { ok: true, appid: 3 });
  });

  it('미매치·다중매치·동명중복은 target_title_unresolved (99·Far Meridian 자동 폐기)', () => {
    const index = buildTitleIndex([
      { appid: 1, title: 'Hi' },
      { appid: 2, title: 'HI ' },
      { appid: 3, title: 'Dup' },
      { appid: 4, title: 'Dup' },
    ]);
    assert.deepEqual(resolveTitleTarget(index, 'Lumen Reach 99'), {
      ok: false,
      reason: 'target_title_unresolved',
    });
    assert.deepEqual(resolveTitleTarget(index, 'Far Meridian'), {
      ok: false,
      reason: 'target_title_unresolved',
    });
    assert.deepEqual(resolveTitleTarget(index, 'hi'), {
      ok: false,
      reason: 'target_title_unresolved',
    });
    assert.deepEqual(resolveTitleTarget(index, 'Dup'), {
      ok: false,
      reason: 'target_title_unresolved',
    });
  });
});

describe('validateTriple (title 대상)', () => {
  const ctx = { sourceAppid: 900002, body: BODY, titles: TITLES };

  it('정상 SEQUEL_OF (제목→appid 매핑)', () => {
    const verdict = validateTriple(
      { type: 'SEQUEL_OF', target: 'Lumen Reach 1', sentence: BODY, expression: 'continues the story of Lumen Reach 1' },
      ctx,
    );
    assert.deepEqual(verdict, {
      ok: true,
      triple: {
        type: 'SEQUEL_OF',
        source: 900002,
        target: 900001,
        sentence: BODY,
        expression: 'continues the story of Lumen Reach 1',
      },
    });
  });

  it('숫자 appid 출력은 bad-target (출력에 숫자 금지)', () => {
    assert.deepEqual(
      validateTriple({ type: 'SEQUEL_OF', target: 900001, sentence: BODY, expression: 'Lumen Reach' }, ctx),
      { ok: false, reason: 'bad-target' },
    );
  });

  it('미매치 제목은 target_title_unresolved', () => {
    assert.deepEqual(
      validateTriple({ type: 'SEQUEL_OF', target: 'Lumen Reach 99', sentence: BODY, expression: 'Lumen Reach' }, ctx),
      { ok: false, reason: 'target_title_unresolved' },
    );
  });

  it('자기 자신 제목은 bad-target', () => {
    assert.deepEqual(
      validateTriple({ type: 'SEQUEL_OF', target: 'Lumen Reach 2', sentence: BODY, expression: 'Lumen Reach' }, ctx),
      { ok: false, reason: 'bad-target' },
    );
  });

  it('unknown-type 폐기', () => {
    assert.deepEqual(validateTriple({ type: 'PREQUEL_OF', target: 'Lumen Reach 1', sentence: BODY, expression: 'x' }, ctx), {
      ok: false,
      reason: 'unknown-type',
    });
  });

  it('sentence는 본문 exact substring (대소문자 엄격)', () => {
    assert.deepEqual(
      validateTriple({ type: 'SEQUEL_OF', target: 'Lumen Reach 1', sentence: BODY.toLowerCase(), expression: 'x' }, ctx),
      { ok: false, reason: 'sentence-not-in-body' },
    );
  });

  it('expression은 문장 substring', () => {
    assert.deepEqual(
      validateTriple({ type: 'SEQUEL_OF', target: 'Lumen Reach 1', sentence: BODY, expression: 'not in sentence' }, ctx),
      { ok: false, reason: 'expression-not-in-sentence' },
    );
  });

  it('IN_SERIES target 형식 + corpus GAME 검증 미적용', () => {
    const good = validateTriple(
      { type: 'IN_SERIES', target: 'SERIES:Aurora Cycle', sentence: BODY, expression: 'Lumen Reach' },
      ctx,
    );
    assert.equal(good.ok, true);
    for (const bad of ['Aurora Cycle', 'SERIES:', 'SERIES:  ', 900001, undefined]) {
      const verdict = validateTriple(
        { type: 'IN_SERIES', target: bad as never, sentence: BODY, expression: 'Lumen Reach' },
        ctx,
      );
      assert.deepEqual(verdict, { ok: false, reason: 'bad-series-target' });
    }
  });

  it('SAME_UNIVERSE는 매핑 뒤 appid 오름차순 재정렬', () => {
    const verdict = validateTriple(
      { type: 'SAME_UNIVERSE', target: 'Lumen Reach 1', sentence: BODY, expression: 'Lumen Reach' },
      ctx,
    );
    assert.deepEqual(verdict, {
      ok: true,
      triple: {
        type: 'SAME_UNIVERSE',
        source: 900001,
        target: 900002,
        sentence: BODY,
        expression: 'Lumen Reach',
      },
    });
  });

  it('SAME_UNIVERSE 미매치·자기자신 폐기', () => {
    assert.deepEqual(
      validateTriple({ type: 'SAME_UNIVERSE', target: 'Far Meridian', sentence: BODY, expression: 'Lumen Reach' }, ctx),
      { ok: false, reason: 'target_title_unresolved' },
    );
    assert.deepEqual(
      validateTriple({ type: 'SAME_UNIVERSE', target: 'Lumen Reach 2', sentence: BODY, expression: 'Lumen Reach' }, ctx),
      { ok: false, reason: 'bad-target' },
    );
  });

  it('corpus policy 미허용 타입은 type-not-allowed로 폐기', () => {
    const verdict = validateTriple(
      { type: 'IN_SERIES', target: 'SERIES:X', sentence: BODY, expression: 'Lumen Reach' },
      ctx,
      ['SEQUEL_OF', 'SAME_UNIVERSE'],
    );
    assert.deepEqual(verdict, { ok: false, reason: 'type-not-allowed' });
    const allowed = validateTriple(
      { type: 'SEQUEL_OF', target: 'Lumen Reach 1', sentence: BODY, expression: 'continues the story of Lumen Reach 1' },
      ctx,
      ['SEQUEL_OF', 'SAME_UNIVERSE'],
    );
    assert.equal(allowed.ok, true);
  });
});

describe('flagExtendedFPs (채점 결함 수정)', () => {
  const gold = [
    { id: 'T1', type: 'SEQUEL_OF', source: 2, target: 1, verdict: true },
    { id: 'F1', type: 'IN_SERIES', source: 4, target: 'SERIES:X', verdict: false, evidenceDocument: 4, sentence: 'trap sentence here', expression: 'trap' },
    { id: 'F7', type: 'SAME_UNIVERSE', source: 35, target: 34, verdict: false, evidenceDocument: 35, sentence: 'shared harbor charts', expression: 'harbor charts' },
  ];

  it('negative 근거 문장·span emit은 type 무관 FP (F7형 포함)', () => {
    const accepted: CanonicalTriple[] = [
      { type: 'SEQUEL_OF', source: 35, target: 34, sentence: 'shared harbor charts', expression: 'harbor charts' },
    ];
    const flags = flagExtendedFPs(accepted, gold);
    assert.equal(flags.negGrounded.length, 1);
    assert.equal(flags.negGrounded[0]?.goldId, 'F7');
    assert.deepEqual(flags.flipped, []);
  });

  it('positive 뒤집힘은 recall miss + precision FP 플래그', () => {
    const accepted: CanonicalTriple[] = [
      { type: 'SEQUEL_OF', source: 1, target: 2, sentence: 's', expression: 'e' },
    ];
    const flags = flagExtendedFPs(accepted, gold);
    assert.equal(flags.flipped.length, 1);
    assert.equal(flags.flipped[0]?.goldId, 'T1');
    assert.deepEqual(flags.negGrounded, []);
  });

  it('정방향 exact match는 플래그 없음', () => {
    const accepted: CanonicalTriple[] = [
      { type: 'SEQUEL_OF', source: 2, target: 1, sentence: 's', expression: 'e' },
    ];
    assert.deepEqual(flagExtendedFPs(accepted, gold), { negGrounded: [], flipped: [] });
  });
});

describe('parseArgs --model', () => {
  it('--model 덮어쓰기·빈값 거부·미지정 없음', () => {
    assert.deepEqual(parseArgs(['--corpus', 'demo', '--model', 'gpt-4o']), {
      corpus: 'demo',
      limit: undefined,
      seed: SAMPLE_SEED,
      model: 'gpt-4o',
    });
    assert.deepEqual(parseArgs(['--corpus', 'real']).model, undefined);
    assert.throws(() => parseArgs(['--corpus', 'demo', '--model', '  ']), /비어 있을 수 없음/);
  });
});

describe('parseResponseText', () => {
  it('배열·fence·단일 객체 거부·깨진 JSON', () => {
    assert.deepEqual(parseResponseText('[{"type":"SEQUEL_OF"}]'), [{ type: 'SEQUEL_OF' }]);
    assert.deepEqual(parseResponseText('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
    assert.throws(() => parseResponseText('{"a":1}'), /배열/);
    assert.throws(() => parseResponseText('not json'));
  });
});

describe('applySeriesGate', () => {
  const series = (source: number, name = 'Aurora Cycle'): CanonicalTriple => ({
    type: 'IN_SERIES',
    source,
    target: `SERIES:${name}`,
    sentence: `s${source}`,
    expression: `e${source}`,
  });

  it('T8~T11형: 4 members accept', () => {
    const result = applySeriesGate([series(8), series(9), series(10), series(11)]);
    assert.equal(result.accepted.length, 4);
    assert.deepEqual(result.rejected, []);
  });

  it('2 members 경계 accept·대소문자 정규화 병합', () => {
    const result = applySeriesGate([
      { ...series(1, 'Aurora Cycle') },
      { ...series(2, 'aurora  cycle') },
    ]);
    assert.equal(result.accepted.length, 2);
  });

  it('0/1 member는 reason+count와 함께 rejected (F3·F8형)', () => {
    const result = applySeriesGate([series(16, 'Obsidian Tide')]);
    assert.deepEqual(result.accepted, []);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]?.reason, 'series_member_count_lt_2');
    assert.equal(result.rejected[0]?.memberCount, 1);
  });

  it('혼합: 2-member series만 승격, 나머지는 개별 count', () => {
    const result = applySeriesGate([series(1, 'A'), series(2, 'A'), series(3, 'B')]);
    assert.equal(result.accepted.length, 2);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]?.memberCount, 1);
  });
});

describe('orderSample (RNG 없음)', () => {
  const pool: SampleCandidate[] = [1, 2, 3, 4, 5].map((appid) => ({
    appid,
    index: 0,
    triple: triple({ source: appid }),
  }));

  it('동일 입력은 항상 동일 순서·상한 적용', () => {
    const first = orderSample(pool, SAMPLE_SEED, 3).map((c) => c.appid);
    const second = orderSample(pool, SAMPLE_SEED, 3).map((c) => c.appid);
    assert.deepEqual(first, second);
    assert.equal(first.length, 3);
    assert.deepEqual(orderSample(pool, SAMPLE_SEED, 99).length, 5);
  });

  it('seed가 다르면 순서가 달라질 수 있고 키는 64hex', () => {
    assert.equal(stableSampleKey(SAMPLE_SEED, 1, 0).length, 64);
    assert.equal(typeof SAMPLE_SEED, 'number');
  });
});

describe('computeDemoMetrics', () => {
  const gold = [
    { id: 'T1', type: 'SEQUEL_OF', source: 2, target: 1, verdict: true },
    { id: 'T2', type: 'SEQUEL_OF', source: 3, target: 1, verdict: true },
    { id: 'F1', type: 'IN_SERIES', source: 4, target: 'SERIES:X', verdict: false },
  ];

  it('recall·FPR 기계 산출', () => {
    const accepted: CanonicalTriple[] = [
      triple({ type: 'SEQUEL_OF', source: 2, target: 1 }),
      triple({ type: 'IN_SERIES', source: 4, target: 'SERIES:Y' }),
    ];
    const metrics = computeDemoMetrics(accepted, gold);
    assert.equal(metrics.positiveSetSize, 2);
    assert.equal(metrics.truePositives, 1);
    assert.deepEqual(metrics.matchedIds, ['T1']);
    assert.deepEqual(metrics.missedIds, ['T2']);
    assert.equal(metrics.recall, 0.5);
    assert.equal(metrics.falsePositives, 1);
    assert.deepEqual(metrics.falsePositiveIds, ['F1']);
    assert.equal(metrics.falsePositiveRate, 1);
  });

  it('type 불일치는 recall·FP 모두 미인정', () => {
    const accepted: CanonicalTriple[] = [triple({ type: 'SAME_UNIVERSE', source: 2, target: 3 })];
    const metrics = computeDemoMetrics(accepted, gold);
    assert.equal(metrics.truePositives, 0);
    assert.equal(metrics.falsePositives, 0);
  });
});
