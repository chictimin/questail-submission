/**
 * P2-C build 전용 결정적 unit tests.
 *
 * 기준 mufa 실측과 빌더 구현은 별도 워커·별도 구현이며, 동등 지표 재현은
 * 독립 검증이다 (REPORT 근거용 기록). 이 파일은 합성 fixture로만 검증하고
 * 실측 수치(92.1/115/5728)를 하드코딩하지 않는다.
 *
 * 실행: `tsc -p packages/collie` 후 `node --test packages/collie/dist/build.test.js`
 * (package.json 변경 없이 dist 경유 — collie 테스트 실행 규칙).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraph,
  computeHubs,
  computeMetrics,
  connectedComponents,
  enumerateGoldPaths,
  gameNeighbors,
  invertAliasTerms,
  loadCollieConfig,
  parseFrontmatterDoc,
  rankTags,
  type ParsedDoc,
} from './build.js';
import { createNormalizer, makeGameNodeId, makeNodeId, normalizeLabel } from './normalization.js';
import { GRAPH_VERSION } from './graph-data.js';

// ─── fixture: 5 게임, 손계산 기대값 ──────────────────────────
// g1: A B / D1 / P1 | g2: A C / D1 / P2 | g3: B / D2 / P1
// g4: Z / D9 / P9 (고립) | g5: A B C / D2 / P2
// df: A=3 B=3 C=2(−) Z=1(−) | D1=2 D2=2 D9=1(−) | P1=2 P2=2 P9=1(−)
// 노드 11 (game5 tag2 dev2 pub2), edge 14, LCC 4, bridged 4.
// gold(dev, hub 없음): total 24, starts [1,2,3,5]. 허브 {g1,g5}면 (0, []).

function fixtureDoc(
  appid: number,
  tags: Record<string, number>,
  developers: string[],
  publishers: string[],
): ParsedDoc {
  return {
    appid,
    filename: `${appid}.md`,
    title: `Game ${appid}`,
    developers,
    publishers,
    tags: Object.keys(tags),
    votes: { ...tags },
  };
}

const FIXTURE: ParsedDoc[] = [
  fixtureDoc(1, { A: 10, B: 5 }, ['D1'], ['P1']),
  fixtureDoc(2, { A: 8, C: 3 }, ['D1'], ['P2']),
  fixtureDoc(3, { B: 7 }, ['D2'], ['P1']),
  fixtureDoc(4, { Z: 1 }, ['D9'], ['P9']),
  fixtureDoc(5, { A: 9, B: 6, C: 4 }, ['D2'], ['P2']),
];

const FIXTURE_MANIFEST = {
  sourceFingerprint: 'test-fp',
  documentCount: 5,
  documents: [1, 2, 3, 4, 5].map((appid) => ({
    appid,
    filename: `${appid}.md`,
    title: `Game ${appid}`,
    canonicalBody: { characters: 100 },
  })),
  extractionEligible: 4,
  extractionExcluded: [{ appid: 4 }],
};

describe('normalization', () => {
  it('trim·casefold·공백 정규화 (멱등)', () => {
    assert.equal(normalizeLabel('  KRAFTON,   Inc. '), 'krafton, inc.');
    assert.equal(normalizeLabel('CAPCOM Co., Ltd.'), 'capcom co., ltd.');
    const once = normalizeLabel('  A  B ');
    assert.equal(normalizeLabel(once), once);
  });

  it('node ID는 namespace + normalized label', () => {
    assert.equal(makeNodeId('tag', 'の引き金'), 'tag:の引き金');
    assert.equal(makeNodeId('developer', 'capcom co., ltd.'), 'developer:capcom co., ltd.');
    assert.equal(makeGameNodeId(105600), 'game:105600');
  });

  it('alias 적용 건만 changelog에 남는다', () => {
    const n = createNormalizer({ capcom: 'capcom co., ltd.' });
    assert.equal(n.normalize('Capcom'), 'capcom co., ltd.');
    assert.equal(n.normalize('SEGA'), 'sega');
    assert.deepEqual([...n.changelog], [{ from: 'capcom', to: 'capcom co., ltd.' }]);
  });

  it('alias 없으면 changelog은 비고 결정적', () => {
    const n = createNormalizer({});
    assert.equal(n.normalize('  SEGA '), 'sega');
    assert.deepEqual([...n.changelog], []);
  });
});

describe('parseFrontmatterDoc', () => {
  it('key: JSON 한 줄씩만 읽고 본문은 무시', () => {
    const doc = parseFrontmatterDoc(
      '---\nappid: 7\ntitle: "X"\ndevelopers: ["D"]\npublishers: []\ntags: ["T"]\nvotes: {"T": 3}\n---\n\n본문: 무시된다\n',
      '7.md',
    );
    assert.equal(doc.appid, 7);
    assert.deepEqual(doc.developers, ['D']);
    assert.deepEqual(doc.votes, { T: 3 });
  });

  it('appid 누락·frontmatter 파손은 throw', () => {
    assert.throws(() => parseFrontmatterDoc('no frontmatter', 'x.md'));
    assert.throws(() => parseFrontmatterDoc('---\ntitle: "X"\n---\n', 'x.md'));
  });
});

describe('rankTags', () => {
  it('votes 내림차순, 동률은 정규화 label 오름차순, rank 1-based', () => {
    const doc = fixtureDoc(9, { b: 5, A: 5, c: 9 }, [], []);
    const ranked = rankTags(doc, (r) => normalizeLabel(r));
    assert.deepEqual(
      ranked.map((t) => [t.normalized, t.votes, t.rank]),
      [
        ['c', 9, 1],
        ['a', 5, 2],
        ['b', 5, 3],
      ],
    );
  });
});

describe('buildGraph fixture', () => {
  const graph = buildGraph(FIXTURE, FIXTURE_MANIFEST, { aliases: {} });

  it('126/113 분리: 5개 전부 GAME 노드, eligible 플래그만 분리', () => {
    const games = graph.nodes.filter((n) => n.kind === 'game');
    assert.equal(games.length, 5);
    const flags = new Map(games.map((g) => [g.game?.appid, g.game?.extractionEligible]));
    assert.deepEqual([...flags], [
      [1, true],
      [2, true],
      [3, true],
      [4, false],
      [5, true],
    ]);
  });

  it('df bounds·denylist·topK 적용 후 노드 11·edge 14', () => {
    const byKind = (k: string): number => graph.nodes.filter((n) => n.kind === k).length;
    assert.equal(byKind('tag'), 2); // A B (C df2 탈락, Z df1 탈락)
    assert.equal(byKind('developer'), 2); // D1 D2
    assert.equal(byKind('publisher'), 2); // P1 P2
    assert.equal(graph.edges.length, 14);
  });

  it('edge provenance에 votes·rank·df 보존', () => {
    const edge = graph.edges.find((e) => e.id === 'HAS_TAG:game:1:tag:a');
    assert.deepEqual(edge?.provenance, {
      appId: 1,
      document: '1.md',
      df: 3,
      rank: 1,
      votes: 10,
    });
    const dev = graph.edges.find((e) => e.id === 'DEVELOPED_BY:game:2:developer:d1');
    assert.equal(dev?.provenance.df, 2);
    assert.equal(dev?.provenance.rank, undefined);
  });

  it('LCC 4·bridged 4 (g4 고립)', () => {
    const neighbors = gameNeighbors(graph);
    const comps = connectedComponents(neighbors);
    assert.deepEqual(comps.map((c) => c.length), [4, 1]);
    assert.deepEqual(comps[1], ['game:4']);
  });

  it('허브 규칙: 내림차순 상위 10% 경계 (g1·g5)', () => {
    assert.deepEqual([...computeHubs(gameNeighbors(graph))].sort(), ['game:1', 'game:5']);
  });

  it('gold(dev, hub 없음): total 24·starts [1,2,3,5]', () => {
    const gold = enumerateGoldPaths(graph, new Set(), 'develops', 2);
    assert.equal(gold.total, 24);
    assert.deepEqual(gold.starts, [1, 2, 3, 5]);
  });

  it('gold(non-tag, hub 없음): total 40·starts [1,2,3,5]', () => {
    const gold = enumerateGoldPaths(graph, new Set(), 'non-tag', 2);
    assert.equal(gold.total, 40);
    assert.deepEqual(gold.starts, [1, 2, 3, 5]);
  });

  it('gold(dev, 허브 {g1,g5}): 브릿지 소멸 → (0, [])', () => {
    const gold = enumerateGoldPaths(graph, new Set(['game:1', 'game:5']), 'develops', 2);
    assert.equal(gold.total, 0);
    assert.deepEqual(gold.starts, []);
  });

  it('gold(non-tag, 허브 {g1,g5}): 동일 → (0, [])', () => {
    const gold = enumerateGoldPaths(graph, new Set(['game:1', 'game:5']), 'non-tag', 2);
    assert.equal(gold.total, 0);
    assert.deepEqual(gold.starts, []);
  });

  it('metrics envelope 값 일치 (실측 허브 {g1,g5}가 전 경로 소멸)', () => {
    const m = computeMetrics(graph, 'develops');
    assert.equal(m.gameNodes, 5);
    assert.equal(m.largestComponentGames, 4);
    assert.equal(m.bridgedGames, 4);
    assert.equal(m.gold.requirement, 'develops');
    assert.equal(m.gold.startGames, 0);
    assert.equal(m.gold.pathsLength2, 0);
    assert.equal(m.goldDevelops.requirement, 'develops');
  });

  it('metrics 기본값은 non-tag 정본', () => {
    const m = computeMetrics(graph);
    assert.equal(m.gold.requirement, 'non-tag');
    assert.equal(m.goldDevelops.requirement, 'develops');
  });
});

describe('alias·exclusion changelog', () => {
  it('별칭 병합: B→A 병합 시 df·edge·로그 반영', () => {
    const graph = buildGraph(FIXTURE, FIXTURE_MANIFEST, { aliases: { b: 'a' } });
    assert.equal(graph.nodes.filter((n) => n.kind === 'tag').length, 1);
    assert.deepEqual(graph.aliases, [{ label: 'b', canonical: 'a', appids: [1, 3, 5] }]);
    const edge = graph.edges.find((e) => e.id === 'HAS_TAG:game:3:tag:a');
    assert.equal(edge?.provenance.df, 4);
  });

  it('제외어: df 집계 전 제거 + 로그', () => {
    const graph = buildGraph(FIXTURE, FIXTURE_MANIFEST, { aliases: {}, excludedTerms: ['a'] });
    assert.equal(graph.nodes.filter((n) => n.kind === 'tag').length, 1);
    assert.deepEqual(graph.exclusions, [{ label: 'a', appids: [1, 2, 5] }]);
  });

  it('기준선: 빈 별칭·빈 제외어는 로그 없음', () => {
    const graph = buildGraph(FIXTURE, FIXTURE_MANIFEST, { aliases: {}, excludedTerms: [] });
    assert.deepEqual(graph.aliases, []);
    assert.deepEqual(graph.exclusions, []);
  });

  it('역변환 경계: 빈 canonical map은 빈 별칭표', () => {
    assert.deepEqual(invertAliasTerms({}), {});
    assert.deepEqual(invertAliasTerms({ 'a': [] }), {});
  });
});

describe('config 정본 바인딩', () => {
  it('canonical→aliases[] 역변환 (정렬 결정적·자기사상 제외·충돌 선승)', () => {
    assert.deepEqual(invertAliasTerms({ 'capcom co., ltd.': ['capcom'] }), {
      capcom: 'capcom co., ltd.',
    });
    assert.deepEqual(invertAliasTerms({ 'a': ['a', ' A '] }), {});
    assert.deepEqual(invertAliasTerms({ 'b': ['x'], 'a': ['x'] }), { x: 'a' });
  });

  it('default config 로드: 별칭 3건·stopTerms 빈 배열', async () => {
    const config = await loadCollieConfig();
    assert.deepEqual(
      { ...config.aliasToCanonical },
      {
        capcom: 'capcom co., ltd.',
        telltale: 'telltale games',
        'the fun pimps': 'the fun pimps entertainment llc',
      },
    );
    assert.deepEqual([...config.stopTerms], []);
  });

  it('역변환 표를 그래프에 적용하면 명시 별칭과 동일', () => {
    const viaInverted = buildGraph(FIXTURE, FIXTURE_MANIFEST, {
      aliases: invertAliasTerms({ a: ['b'] }),
    });
    const direct = buildGraph(FIXTURE, FIXTURE_MANIFEST, { aliases: { b: 'a' } });
    assert.deepEqual(viaInverted.aliases, direct.aliases);
    assert.equal(viaInverted.edges.length, direct.edges.length);
  });
});

describe('envelope', () => {
  it('graph.data 계약 상수 확인', () => {
    assert.equal(GRAPH_VERSION, 'graph.v1');
  });
});
