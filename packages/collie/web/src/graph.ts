import cytoscape from 'cytoscape';
import { esc, nodeText, type Labels, type SelectedPath } from './types.js';
import type { CorpusEdge, CorpusNode } from './corpus.js';

// 주 시각 채널은 간선 타입이다. verified는 전수 false일 수 있으므로
// 부차 채널(굵기)로만 표시하고, true가 0건이면 화면에 관련 문구를 내지 않는다.
const TYPE_COLORS: Record<string, string> = {
  DEVELOPED_BY: '#0a4a6b',
  PUBLISHED_BY: '#8a5a00',
  HAS_TAG: '#0a6b1a',
};

export function colorForType(type: string): string {
  const fixed = TYPE_COLORS[String(type)];
  if (fixed) return fixed;
  // 계약에 없는 타입이 와도 깨지지 않게 해시로 색을 정한다.
  let h = 5381;
  for (const ch of String(type)) h = ((h << 5) + h + ch.codePointAt(0)! ) >>> 0;
  return 'hsl(' + (h % 360) + ', 60%, 35%)';
}

export interface TypeCount {
  readonly type: string;
  readonly count: number;
}

const KIND_BORDER: Record<string, string> = {
  game: '#1a1a1a',
  tag: '#8a5a00',
  developer: '#0a4a6b',
  publisher: '#5b21b6',
};

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
  const known = new Set(nodes.map((n) => String(n.id)));
  const elements: cytoscape.ElementDefinition[] = [
    ...nodes.map((n) => ({
      data: { id: String(n.id), label: String(n.label || n.id), kind: String(n.kind || 'game') },
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
          data: { id: String(end), label: nodeText(String(end), labels), kind: 'game' },
        });
      }
    }
  }

  // 타입별 색. 응답에 실제로 들어있는 타입에 대해서만 선택자를 만든다.
  // 데이터에 없는 타입을 범례·스타일에 미리 박아두지 않는다.
  // 색각 대비용 중복 인코딩은 간선 라벨의 타입 문자열이 맡는다.
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
    layout: { name: 'cose', animate: false, fit: true, padding: 16 } as cytoscape.LayoutOptions,
    minZoom: 0.3,
    maxZoom: 2.5,
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          'text-valign': 'bottom',
          'text-halign': 'center',
          'font-size': 9,
          color: '#1a1a1a',
          'background-color': '#ffffff',
          'border-width': 2,
          'border-color': '#333333',
          width: 20,
          height: 20,
          'text-margin-y': 5,
          'text-max-width': '110px',
          'text-wrap': 'ellipsis',
        },
      },
      {
        selector: 'node[kind = "tag"]',
        style: { 'border-color': KIND_BORDER['tag'], 'border-style': 'double' },
      },
      {
        selector: 'node[kind = "developer"]',
        style: { 'border-color': KIND_BORDER['developer'] },
      },
      {
        selector: 'node[kind = "publisher"]',
        style: { 'border-color': KIND_BORDER['publisher'] },
      },
      {
        selector: 'edge',
        style: {
          label: 'data(label)',
          'font-size': 9,
          color: '#333333',
          'text-background-color': '#ffffff',
          'text-background-opacity': 1,
          'text-background-padding': '2px',
          width: 2,
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
        },
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
        selector: 'edge[verified = "1"], edge[verified = true]',
        style: { width: 4.5 },
      },
      // 경로 강조: 경로 위 요소는 굵게, 나머지는 흐리게. 전체를 지우지 않는다.
      ...edgeTypeStyles,
      { selector: 'node.dim', style: { opacity: 0.3 } },
      { selector: 'edge.dim', style: { opacity: 0.2 } },
      {
        selector: 'node.path',
        style: { 'border-width': 5, 'border-color': '#b77900', opacity: 1 },
      },
      {
        selector: 'edge.path',
        style: { width: 4, opacity: 1 },
      },
      {
        selector: 'node.selected',
        style: { 'border-width': 5, 'border-color': '#b77900', opacity: 1 },
      },
    ],
  });
  cy.fit(undefined, 16);

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

  return {
    size: { nodes: known.size, edges: edges.length },
    setHighlight(path: SelectedPath | null): void {
      cy.elements().removeClass('dim path selected');
      if (!path || !path.nodes || !path.nodes.length) return;
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
      const onPath = cy.elements('.path');
      if (onPath.length) {
        try {
          cy.fit(onPath, 48);
        } catch {
          /* 무시 */
        }
      }
    },
    selectNode(id: string): boolean {
      const n = cy.getElementById(String(id));
      if (!n || !n.length) return false;
      cy.elements().removeClass('dim path selected');
      n.addClass('selected');
      n.neighborhood().addClass('selected');
      try {
        cy.center(n);
      } catch {
        /* 무시 */
      }
      return true;
    },
  };
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
    '<span>간선 위 글자 = 관계 타입</span>' +
    '</div>'
  );
}
