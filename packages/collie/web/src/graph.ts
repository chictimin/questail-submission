import cytoscape from 'cytoscape';
import { esc, nodeText, type Labels, type SelectedPath } from './types.js';
import type { CorpusEdge, CorpusNode } from './corpus.js';

// ── 진열장 테마: 색 값을 전부 이 한곳에 둔다 ──
// 그래프 캔버스는 깊은 잉크색, 페이지는 차가운 회색 종이. 어색하면 이 표만
// 고치면 전체가 따라온다. style.css의 #corpus-cy 배경과 라벨 후광색은
// THEME.ink와 같은 값으로 맞춘다(주석에 명시).
const THEME = {
  // 순수 검정 금지. 남색 섞인 깊은 검정.
  ink: '#14171c',
  // 잉크 위 라벨 글자와 후광.
  label: '#edeff4',
  // 간선 타입 색. 노드를 앞으로 내세우려고 채도를 낮춘다.
  typeColors: {
    DEVELOPED_BY: '#6b8f9e',
    PUBLISHED_BY: '#a8894f',
    HAS_TAG: '#6e9e78',
  } as Record<string, string>,
  // 노드 종류 채움색. 위계를 만드는 가장 큰 요소다.
  // game 황동, developer 청록, publisher 보라, tag 세이지.
  kindFill: {
    game: '#d9a441',
    developer: '#5fb3c4',
    publisher: '#9a8cc8',
    tag: '#8fb98a',
  } as Record<string, string>,
  // 경로·선택 강조 테두리. 밝은 황동으로 ink 위에서 튄다.
  pathBorder: '#f5d78e',
};

// 주 시각 채널은 간선 타입이다. verified는 전수 false일 수 있으므로
// 부차 채널(굵기)로만 표시하고, true가 0건이면 화면에 관련 문구를 내지 않는다.
export function colorForType(type: string): string {
  const fixed = THEME.typeColors[String(type)];
  if (fixed) return fixed;
  // 계약에 없는 타입이 와도 깨지지 않게 해시로 색을 정한다.
  // ink 배경용으로 채도를 낮추고 명도를 올린다.
  let h = 5381;
  for (const ch of String(type)) h = ((h << 5) + h + ch.codePointAt(0)! ) >>> 0;
  return 'hsl(' + (h % 360) + ', 45%, 62%)';
}

export interface TypeCount {
  readonly type: string;
  readonly count: number;
}

const KIND_FILL: Record<string, string> = THEME.kindFill;

export function countEdgeTypes(edges: readonly { readonly type: string }[]): TypeCount[] {
  const map = new Map<string, number>();
  for (const e of edges) map.set(String(e.type), (map.get(String(e.type)) ?? 0) + 1);
  return [...map.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1));
}

export interface CorpusGraph {
  setHighlight(path: SelectedPath | null): void;
  selectNode(id: string): boolean;
  readonly size: { nodes: number; edges: number };
}

function edgeKey(from: string, type: string, to: string): string {
  return String(from) + '|' + String(type) + '|' + String(to);
}

export function renderCorpusGraph(
  container: HTMLElement,
  nodes: readonly CorpusNode[],
  edges: readonly CorpusEdge[],
  labels: Labels,
): CorpusGraph {
  // 연결 수(degree)를 노드 크기에 반영한다. 간선 양 끝점을 모두 센다.
  // 고아 간선 보정으로 뒤에 추가되는 노드도 같은 표에 들어간다.
  const degreeOf = new Map<string, number>();
  for (const n of nodes) degreeOf.set(String(n.id), 0);
  for (const e of edges) {
    for (const end of [e.from, e.to]) {
      const k = String(end);
      degreeOf.set(k, (degreeOf.get(k) ?? 0) + 1);
    }
  }
  let degMin = Infinity;
  let degMax = -Infinity;
  for (const d of degreeOf.values()) {
    if (d < degMin) degMin = d;
    if (d > degMax) degMax = d;
  }
  if (!isFinite(degMin)) {
    degMin = 0;
    degMax = 0;
  }
  // mapData 인자는 리터럴 숫자 문자열이어야 하므로 여기서 조립한다.
  // degree가 전부 같으면 매핑이 깨지므로 고정 크기로 둔다.
  // 범위는 극단값이 화면을 망치지 않게 14~32로 묶는다.
  const nodeSize =
    degMax > degMin
      ? 'mapData(degree, ' + degMin + ', ' + degMax + ', 14, 32)'
      : '22';

  const known = new Set(nodes.map((n) => String(n.id)));
  const elements: cytoscape.ElementDefinition[] = [
    ...nodes.map((n) => ({
      data: {
        id: String(n.id),
        label: String(n.label || n.id),
        kind: String(n.kind || 'game'),
        degree: degreeOf.get(String(n.id)) ?? 0,
      },
    })),
    ...edges.map((e, i) => ({
      data: {
        id: `e${i}`,
        source: String(e.from),
        target: String(e.to),
        label: String(e.type),
        etype: String(e.type),
        verified: e.verified === true,
      },
    })),
  ];
  // 간선이 가리키는 노드가 목록에 없으면 고아 간선이 되므로 보정한다.
  for (const e of edges) {
    for (const end of [e.from, e.to]) {
      if (!known.has(String(end))) {
        known.add(String(end));
        elements.push({
          data: {
            id: String(end),
            label: nodeText(String(end), labels),
            kind: 'game',
            degree: degreeOf.get(String(end)) ?? 0,
          },
        });
      }
    }
  }

  // 타입별 색. 응답에 실제로 들어있는 타입에 대해서만 선택자를 만든다.
  // 데이터에 없는 타입을 범례·스타일에 미리 박아두지 않는다.
  // 타입 구분은 간선 색 + 범례가 맡고, 라벨은 호버·선택·경로 강조 시에만 보인다.
  const edgeTypeStyles: cytoscape.Stylesheet[] = countEdgeTypes(edges).map(({ type }) => ({
    selector: `edge[etype = "${String(type).replace(/"/g, '')}"]`,
    style: {
      'line-color': colorForType(type),
      'target-arrow-color': colorForType(type),
    },
  }));

  const cy = cytoscape({
    container,
    elements,
    // 50건 규모 코퍼스라 힘 기반 레이아웃(cose, 내장)을 쓴다.
    // 72노드·122간선이 가운데 뭉치지 않게 반발력과 이상적 간선 길이를
    // 기본값보다 키우고, 고립 컴포넌트 간격도 벌린다.
    layout: {
      name: 'cose',
      animate: false,
      fit: true,
      padding: 24,
      idealEdgeLength: 110,
      nodeOverlap: 24,
      nodeRepulsion: 12000,
      edgeElasticity: 120,
      gravity: 0.25,
      numIter: 2500,
      componentSpacing: 80,
      randomize: true,
    } as cytoscape.LayoutOptions,
    minZoom: 0.3,
    maxZoom: 2.5,
    style: [
      {
        selector: 'node',
        style: {
          // 기본 상태 라벨 없음. 라벨은 show-label(줌인 시 게임 노드) /
          // hovered / :selected / path / selected 규칙에서만 붙는다.
          // 노드 크기는 연결 수에 비례한다(mapData, degree 필드).
          // 채움색이 종류를 말한다(아래 kind 규칙). 테두리는 점을
          // 또렷하게 하는 얇은 어두운 림이다.
          'text-valign': 'bottom',
          'text-halign': 'center',
          'font-size': 9,
          color: THEME.label,
          'text-background-color': THEME.ink,
          'text-background-opacity': 1,
          'text-background-padding': '2px',
          'background-color': KIND_FILL['game'],
          'border-width': 1,
          'border-color': '#0d0f13',
          width: nodeSize,
          height: nodeSize,
          'text-margin-y': 5,
          'text-max-width': '140px',
          'text-wrap': 'ellipsis',
        },
      },
      {
        // 라벨 표시 조건: 줌인 시 게임 노드, 호버, 탭 선택, 경로 강조, 리스트 선택.
        selector: 'node.show-label, node.hovered, node:selected, node.path, node.selected',
        style: { label: 'data(label)' },
      },
      {
        selector: 'node[kind = "developer"]',
        style: { 'background-color': KIND_FILL['developer'] },
      },
      {
        selector: 'node[kind = "publisher"]',
        style: { 'background-color': KIND_FILL['publisher'] },
      },
      {
        selector: 'node[kind = "tag"]',
        style: { 'background-color': KIND_FILL['tag'] },
      },
      {
        // 기본 상태 간선 라벨 없음(옵시디언 그래프 뷰와 같은 방향).
        // 라벨은 호버 / 탭 선택 / 경로 강조 / 이웃 선택 시에만 보인다.
        // 타입 구분은 간선 색 + 범례가 맡는다.
        // 간선은 배경이다: 굵기 1, 투명도 0.32로 뒤에 둔다.
        // 강조 클래스에서만 또렷해진다.
        selector: 'edge',
        style: {
          'font-size': 9,
          color: THEME.label,
          'text-background-color': THEME.ink,
          'text-background-opacity': 1,
          'text-background-padding': '2px',
          width: 1,
          'line-opacity': 0.32,
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.7,
          'curve-style': 'bezier',
        },
      },
      {
        selector: 'edge.hovered, edge:selected, edge.selected',
        // 간선을 따라 기울여 노드 라벨·이웃 라벨과의 겹침을 줄인다.
        style: { label: 'data(label)', 'text-rotation': 'autorotate', width: 2.2, 'line-opacity': 1 },
      },
      {
        // verified=false: 목록에 없는 간선. 아무 표시도 주지 않는다.
        // 전수 false인 데이터에서 미검증 딱지를 붙이면 정본 전체가 의심스러워 보인다.
        selector: 'edge[verified = "0"], edge[verified = false]',
        style: { width: 2 },
      },
      {
        // verified=true: 관계 검증 목록에 포함된 간선 = 굵은 선.
        // true가 0건이면 이 선택자에 걸리는 간선이 없어 화면에 구분이 나타나지 않는다(정상).
        // 기본 간선보다 한 단계 또렷하게 두되 배경 역할은 유지한다.
        selector: 'edge[verified = "1"], edge[verified = true]',
        style: { width: 2.2, 'line-opacity': 0.85 },
      },
      // 경로 강조: 경로 위 요소는 굵게, 나머지는 흐리게. 전체를 지우지 않는다.
      // dim 노드는 라벨도 숨겨 강조 경로만 읽히게 한다(hovered는 예외).
      ...edgeTypeStyles,
      { selector: 'node.dim', style: { opacity: 0.35, label: '' } },
      { selector: 'node.dim.hovered, node.dim:selected', style: { label: 'data(label)' } },
      // 기본 간선이 이미 옅으므로(0.32) dim은 opacity 곱으로만 흐리게 한다.
      // 0.2까지 내리면 ink 위에서 윤곽이 사라지므로 0.45로 둔다.
      { selector: 'edge.dim', style: { opacity: 0.45 } },
      {
        // 전체 윤곽을 유지한 채로도 경로가 눈에 띄도록 노드를 키우고
        // 라벨 글자를 한 단계 크게 한다. degree 매핑 상한(32)보다 크게
        // 두어 허브 노드가 경로에서 오히려 작아지지 않게 한다.
        selector: 'node.path',
        style: {
          'border-width': 4,
          'border-color': THEME.pathBorder,
          opacity: 1,
          width: 36,
          height: 36,
          'font-size': 12,
        },
      },
      {
        selector: 'edge.path',
        style: {
          label: 'data(label)',
          'text-rotation': 'autorotate',
          width: 5,
          opacity: 1,
          'line-opacity': 1,
          'arrow-scale': 1,
          'font-size': 12,
        },
      },
      {
        selector: 'node.selected',
        style: { 'border-width': 4, 'border-color': THEME.pathBorder, opacity: 1 },
      },
    ],
  });
  cy.fit(undefined, 16);

  // 라벨 글꼴 줌 비례 상한: cytoscape 라벨은 모델 좌표계라 줌인하면 화면
  // 글자도 함께 커진다. 화면 기준 13px을 넘지 않도록 줌이 바뀔 때마다
  // font-size 우회를 걸고, 줌아웃하면 우회를 걷어낸다(path 라벨 기준 12).
  const MAX_LABEL_SCREEN = 13;
  const applyFontCap = (): void => {
    const z = cy.zoom() || 1;
    const cap = MAX_LABEL_SCREEN / z;
    cy.nodes().forEach((n) => {
      const base = n.hasClass('path') ? 12 : 9;
      if (cap < base) n.style({ 'font-size': cap });
      else n.removeStyle('font-size');
    });
    cy.edges().forEach((e) => {
      const base = e.hasClass('path') ? 12 : 9;
      if (cap < base) e.style({ 'font-size': cap });
      else e.removeStyle('font-size');
    });
  };

  // 호버 시에만 노드·간선 라벨을 보여준다. cytoscape에 :hover 선택자가
  // 없어 mouseover/mouseout으로 hovered 클래스를 토글한다.
  cy.on('mouseover', 'node', (e) => e.target.addClass('hovered'));
  cy.on('mouseout', 'node', (e) => e.target.removeClass('hovered'));
  cy.on('mouseover', 'edge', (e) => e.target.addClass('hovered'));
  cy.on('mouseout', 'edge', (e) => e.target.removeClass('hovered'));

  // 노드 라벨은 줌인 상태에서만: 기본 줌(fit)에서는 겹쳐서 못 읽으므로
  // 임계 줌 이상일 때 게임 노드에만 show-label을 붙인다.
  // hovered/:selected/path/selected는 줌과 무관하게 항상 보인다.
  const LABEL_ZOOM = 0.9;
  const applyZoomLabels = (): void => {
    const show = cy.zoom() >= LABEL_ZOOM;
    cy.nodes('node[kind = "game"]').forEach((n) => {
      if (show) n.addClass('show-label');
      else n.removeClass('show-label');
    });
  };
  cy.on('zoom', () => {
    applyZoomLabels();
    applyFontCap();
  });
  applyZoomLabels();
  applyFontCap();

  // 화면이 좁아지거나 탭 전환으로 크기가 바뀌면 캔버스를 다시 맞춘다.
  const resize = (): void => {
    try {
      cy.resize();
      cy.fit(undefined, 16);
    } catch {
      /* 무시 */
    }
  };
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resize).observe(container);
  }

  const pathKeys = new Set(
    edges.map((e) => edgeKey(e.from, e.type, e.to)),
  );

  const api: CorpusGraph = {
    size: { nodes: known.size, edges: edges.length },
    setHighlight(path: SelectedPath | null): void {
      cy.elements().removeClass('dim path selected');
      if (!path || !path.nodes || !path.nodes.length) {
        applyFontCap();
        return;
      }
      const nodeSet = new Set((path.nodes || []).map(String));
      const want = new Set(
        (path.edges || []).map((e) => edgeKey(e.from, e.type, e.to)),
      );
      cy.nodes().forEach((n) => {
        n.addClass(nodeSet.has(n.id()) ? 'path' : 'dim');
      });
      cy.edges().forEach((e) => {
        const k = edgeKey(e.data('source'), e.data('label'), e.data('target'));
        e.addClass(want.has(k) && pathKeys.has(k) ? 'path' : 'dim');
      });
      // 질의 후에도 전체 그래프 윤곽을 유지한다. 경로로의 확대(fit)는
      // 하지 않는다. 강조는 색·굵기·dim 대비로 전달된다. 질의 전 사용자가
      // 줌/팬을 건드렸더라도 경로가 화면 안에 들어오도록 전체를 여유
      // 패딩으로만 다시 맞춘다. 패딩 36은 경로 노드 라벨이 패널 경계에
      // 잘리지 않을 여백도 겸한다.
      try {
        cy.fit(undefined, 36);
      } catch {
        /* 무시 */
      }
      applyFontCap();
    },
    selectNode(id: string): boolean {
      const n = cy.getElementById(String(id));
      if (!n || !n.length) return false;
      cy.elements().removeClass('dim path selected');
      n.addClass('selected');
      n.neighborhood().addClass('selected');
      applyFontCap();
      try {
        cy.center(n);
      } catch {
        /* 무시 */
      }
      return true;
    },
  };

  return api;
}

export function pathTextHtml(path: SelectedPath, labels: Labels): string {
  if (!path.nodes || !path.nodes.length) return '';
  let html = esc(nodeText(String(path.nodes[0]), labels));
  for (let i = 0; i < (path.edges ?? []).length; i++) {
    const next = path.nodes[i + 1] != null ? String(path.nodes[i + 1]) : '';
    const e = path.edges[i];
    const title = e.verified === true ? `${e.type} · 검증 목록 포함` : String(e.type);
    html +=
      '<span class="patharrow">→</span>' +
      '<span title="' +
      esc(title) +
      '">' +
      esc(`[${e.type}]`) +
      '</span> ' +
      esc(nodeText(next, labels));
  }
  return '<div class="pathline">' + html + '</div>';
}

// 노드 종류 범례. 간선 범례(graphLegendHtml)와 같은 자리에 붙인다.
// 채움색이 종류를 말하므로 점 sw로 표시한다.
export function graphKindLegendHtml(): string {
  const kinds: readonly (readonly [string, string])[] = [
    ['게임', THEME.kindFill['game']],
    ['개발사', THEME.kindFill['developer']],
    ['유통사', THEME.kindFill['publisher']],
    ['태그', THEME.kindFill['tag']],
  ];
  const rows = kinds
    .map(
      ([name, color]) =>
        '<span><span class="dot" style="background-color:' +
        esc(color) +
        '"></span>' +
        esc(name) +
        '</span>',
    )
    .join('');
  return '<div class="cy-legend" aria-label="노드 범례">' + rows + '<span>점 크기 = 연결 수 · 점 색 = 종류</span></div>';
}

// 범례는 응답에 실제로 들어있는 타입으로만 만든다. verified=true가
// 0건이면 검증 관련 문구를 내지 않는다(딱지 없음이 정상 상태다).
export function graphLegendHtml(types: readonly TypeCount[], verifiedCount: number): string {
  const rows = types
    .map(
      ({ type, count }) =>
        '<span><span class="sw" style="border-top-color:' +
        esc(colorForType(type)) +
        '"></span>' +
        esc(type) +
        ' ' +
        count +
        '건</span>',
    )
    .join('');
  const verified =
    verifiedCount > 0
      ? '<span><span class="sw thick"></span>굵은 선 = 검증 목록에 포함 ' + verifiedCount + '건</span>'
      : '';
  return (
    '<div class="cy-legend" aria-label="간선 범례">' +
    rows +
    verified +
    '<span>색 = 관계 타입 · 간선 호버/경로 강조 시 타입 표시</span>' +
    '</div>'
  );
}
