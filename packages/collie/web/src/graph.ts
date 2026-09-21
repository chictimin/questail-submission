import cytoscape from 'cytoscape';
import { esc, nodeText, type Labels, type SelectedPath } from './types.js';

// 경로 그래프. 입력: result.trace.selectedPath(nodes/edges) + result.labels.
// 간선 라벨=type, verified true=실선, false=점선. 이 구분이 핵심이다.
export function renderPathGraph(
  container: HTMLElement,
  path: SelectedPath,
  labels: Labels,
): void {
  const nodes = [...path.nodes];
  const edges = [...(path.edges ?? [])];
  const elements: cytoscape.ElementDefinition[] = [
    ...nodes.map((id, i) => ({
      data: { id: String(id), label: nodeText(String(id), labels) },
      position: { x: 40 + i * 160, y: 90 },
    })),
    ...edges.map((e, i) => ({
      data: {
        id: `e${i}`,
        source: String(e.from),
        target: String(e.to),
        label: String(e.type),
        verified: e.verified === true,
      },
    })),
  ];

  // 간선이 가리키는 노드가 nodes에 없으면 고아 간선이 되므로 보정한다.
  const known = new Set(nodes.map(String));
  for (const e of edges) {
    for (const end of [e.from, e.to]) {
      if (!known.has(String(end))) {
        known.add(String(end));
        elements.push({
          data: { id: String(end), label: nodeText(String(end), labels) },
          position: { x: 40 + known.size * 160, y: 90 },
        });
      }
    }
  }

  const cy = cytoscape({
    container,
    elements,
    layout: { name: 'preset' },
    minZoom: 0.4,
    maxZoom: 2,
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          'text-valign': 'bottom',
          'text-halign': 'center',
          'font-size': 11,
          color: '#1a1a1a',
          'background-color': '#ffffff',
          'border-width': 2,
          'border-color': '#333333',
          width: 26,
          height: 26,
          'text-margin-y': 6,
          'text-max-width': '140px',
          'text-wrap': 'ellipsis',
        },
      },
      {
        selector: 'edge',
        style: {
          label: 'data(label)',
          'font-size': 10,
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
        // verified=true: 결정적 간선 = 실선(녹색).
        selector: 'edge[verified = "1"], edge[verified = true]',
        style: {
          'line-style': 'solid',
          'line-color': '#0a6b1a',
          'target-arrow-color': '#0a6b1a',
        },
      },
      {
        // verified=false: LLM 간선 = 점선(보라).
        selector: 'edge[verified = "0"], edge[verified = false]',
        style: {
          'line-style': 'dashed',
          'line-color': '#5b21b6',
          'target-arrow-color': '#5b21b6',
        },
      },
    ],
  });
  cy.fit(undefined, 16);
}

export function pathTextHtml(path: SelectedPath, labels: Labels): string {
  if (!path.nodes || !path.nodes.length) return '';
  let html = esc(nodeText(String(path.nodes[0]), labels));
  for (let i = 0; i < (path.edges ?? []).length; i++) {
    const next = path.nodes[i + 1] != null ? String(path.nodes[i + 1]) : '';
    const e = path.edges[i];
    const mark = e.verified === true ? '실선' : '점선';
    html +=
      '<span class="patharrow">→</span>' +
      '<span title="' +
      esc(`${e.type} · ${mark}`) +
      '">' +
      esc(`[${e.type}]`) +
      '</span> ' +
      esc(nodeText(next, labels));
  }
  return '<div class="pathline">' + html + '</div>';
}

export function graphLegendHtml(): string {
  return (
    '<div class="cy-legend" aria-label="간선 범례">' +
    '<span><span class="sw"></span>실선 = verified(결정적)</span>' +
    '<span><span class="sw llm"></span>점선 = unverified(LLM)</span>' +
    '<span>간선 위 글자 = type</span>' +
    '</div>'
  );
}
