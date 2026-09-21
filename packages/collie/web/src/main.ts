import './style.css';
import { askServer } from './sse.js';
import { renderAnswerHtml } from './markdown.js';
import {
  countEdgeTypes,
  graphKindLegendHtml,
  graphLegendHtml,
  pathTextHtml,
  renderCorpusGraph,
  type CorpusGraph,
} from './graph.js';
import {
  corpusErrorText,
  fetchCorpus,
  type CorpusDocument,
  type CorpusNode,
} from './corpus.js';
import {
  esc,
  shortNode,
  type AskResultPayload,
  type Labels,
  type RunTrace,
  type SelectedPath,
} from './types.js';

const STEP_LABELS: Record<string, string> = {
  classify: '카테고리 판정',
  policy: '정책 판정',
  retrieve: '근거 검색',
  assemble: '도구 선택과 근거 조립',
  answer: '근거로 답변 생성',
  verify: '근거 이탈 검사',
  regenerate: '검증 실패 — 답변 재생성',
  escalate: '범위 밖으로 판단 — 이관 처리',
};

const RELAX_NOTICE: Record<number, string> = {
  1: '가까운 연결로는 답이 없어 조금 더 멀리 찾았습니다',
  2: '드물게 쓰인 태그와 본문 관계까지 넓혀 찾았습니다',
  3: '흔한 태그까지 허용해 찾았습니다',
  4: '질문에 나온 태그를 직접 확인했습니다',
};

// 모드는 demo 고정이다. 계약에 /meta가 없어 서버 표시는 정적 문구로 둔다.
let mode = 'demo';
let inFlight = false;

const form = document.getElementById('ask-form') as HTMLFormElement;
const input = document.getElementById('question') as HTMLInputElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const chatBox = document.getElementById('chat') as HTMLElement;
let emptyNote = document.getElementById('empty-note');
const endpointBox = document.getElementById('endpoint') as HTMLElement;

// ── 사이드 패널 ──
const tabGraph = document.getElementById('tab-graph') as HTMLButtonElement;
const tabGames = document.getElementById('tab-games') as HTMLButtonElement;
const panelGraph = document.getElementById('panel-graph') as HTMLElement;
const panelGames = document.getElementById('panel-games') as HTMLElement;
const corpusStatus = document.getElementById('corpus-status') as HTMLElement;
const corpusCyBox = document.getElementById('corpus-cy') as HTMLElement;
const corpusLegend = document.getElementById('corpus-legend') as HTMLElement;
const corpusPathline = document.getElementById('corpus-pathline') as HTMLElement;
const gamesStatus = document.getElementById('games-status') as HTMLElement;
const gamesList = document.getElementById('games-list') as HTMLElement;

let sideGraph: CorpusGraph | null = null;
// /corpus 노드의 id→label. 질의 응답의 pathText 라벨 보강용이다.
let corpusLabels: Record<string, string> = {};

function showTab(which: 'graph' | 'games'): void {
  const graph = which === 'graph';
  tabGraph.setAttribute('aria-selected', String(graph));
  tabGames.setAttribute('aria-selected', String(!graph));
  panelGraph.hidden = !graph;
  panelGames.hidden = graph;
}

tabGraph.addEventListener('click', () => showTab('graph'));
tabGames.addEventListener('click', () => showTab('games'));

function docNodeId(doc: CorpusDocument, nodes: readonly CorpusNode[]): string | null {
  const id = String(doc.id);
  if (nodes.some((n) => String(n.id) === id)) return id;
  // 주의: 라벨이 겹치는 게임이 생기면 엉뚱한 노드가 잡힐 수 있다. 계약에
  // 문서-노드 매핑이 없어 추론으로 연결한 것이니, 겹침이 생기면 계약부터 고쳐야 한다.
  const byLabel = nodes.find((n) => String(n.label) === String(doc.title));
  if (byLabel) return String(byLabel.id);
  const fuzzy = nodes.find((n) => String(n.id).includes(id) || id.includes(String(n.id)));
  return fuzzy ? String(fuzzy.id) : null;
}

function gamesMeta(doc: CorpusDocument): string {
  const parts: string[] = [];
  if (doc.developers && doc.developers.length) parts.push('개발 ' + doc.developers.join(', '));
  if (doc.publishers && doc.publishers.length) parts.push('유통 ' + doc.publishers.join(', '));
  if (doc.tags && doc.tags.length) parts.push('태그 ' + doc.tags.slice(0, 5).join(', '));
  return parts.join(' · ');
}

function renderGamesList(
  docs: readonly CorpusDocument[],
  nodes: readonly CorpusNode[],
): void {
  gamesList.innerHTML = '';
  if (!docs.length) {
    gamesStatus.textContent = '코퍼스에 문서가 없습니다 (0건).';
    return;
  }
  gamesStatus.textContent = '실존 게임 ' + docs.length + '건. 항목을 누르면 그래프 뷰에서 해당 노드로 이동합니다.';
  docs.forEach((doc) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'game-item';
    const title = document.createElement('span');
    title.className = 'game-title';
    title.textContent = String(doc.title || doc.id);
    btn.appendChild(title);
    const meta = gamesMeta(doc);
    if (meta) {
      const sub = document.createElement('span');
      sub.className = 'game-meta';
      sub.textContent = meta;
      btn.appendChild(sub);
    }
    btn.addEventListener('click', () => {
      showTab('graph');
      const nodeId = docNodeId(doc, nodes);
      if (nodeId && sideGraph) {
        if (!sideGraph.selectNode(nodeId)) {
          corpusStatus.textContent = '‘' + String(doc.title || doc.id) + '’ 노드를 그래프에서 찾지 못했습니다.';
        }
      } else {
        corpusStatus.textContent = '‘' + String(doc.title || doc.id) + '’에 대응하는 그래프 노드를 찾지 못했습니다.';
      }
    });
    li.appendChild(btn);
    gamesList.appendChild(li);
  });
}

// 질의 응답의 selectedPath를 전체 그래프 위에 강조한다.
function highlightSidePath(path: SelectedPath | null, labels: Labels): void {
  if (sideGraph) sideGraph.setHighlight(path);
  corpusPathline.innerHTML = path ? pathTextHtml(path, labels) : '';
}

function mergedLabels(askLabels: Labels): Labels {
  if (!Object.keys(corpusLabels).length) return askLabels;
  return { ...corpusLabels, ...(askLabels || {}) };
}

function initCorpusPanel(): void {
  fetchCorpus()
    .then((corpus) => {
      const nodes = corpus.graph.nodes || [];
      const edges = corpus.graph.edges || [];
      const docs = corpus.documents || [];
      corpusLabels = {};
      nodes.forEach((n) => {
        corpusLabels[String(n.id)] = String(n.label || n.id);
      });
      try {
        sideGraph = renderCorpusGraph(corpusCyBox, nodes, edges, corpusLabels);
        corpusStatus.textContent =
          '코퍼스 ' + docs.length + '건 · 노드 ' + sideGraph.size.nodes + ' · 간선 ' + sideGraph.size.edges + ' (mode ' + String(corpus.mode) + ')';
      } catch {
        sideGraph = null;
        corpusStatus.textContent = '그래프를 그리지 못했습니다. 노드 ' + nodes.length + ' · 간선 ' + edges.length + '.';
      }
      corpusLegend.innerHTML =
        graphKindLegendHtml() +
        graphLegendHtml(
          countEdgeTypes(edges),
          edges.filter((e) => e.verified === true).length,
        );
      renderGamesList(docs, nodes);
    })
    .catch((err: unknown) => {
      const msg = corpusErrorText(err);
      corpusStatus.textContent = msg;
      gamesStatus.textContent = msg;
    });
}

// ── 진행 표시 ──
interface StepEntry {
  label: string;
  start: number;
  end: number | null;
}
let stepLog: StepEntry[] = [];
let progWrapEl: Element | null = null;
let progListEl: Element | null = null;
let progElapsedEl: Element | null = null;
let runStart = 0;
let ticker: number | null = null;
let lastProgressText = '';

function stopTicker(): void {
  if (ticker !== null) {
    window.clearInterval(ticker);
    ticker = null;
  }
}

function renderProgress(): void {
  if (!progListEl) return;
  progListEl.innerHTML = stepLog
    .map((s, i) => {
      const current = i === stepLog.length - 1 && s.end == null;
      if (current) {
        return '<li class="doing"><span class="spin" aria-hidden="true"></span>' + esc(s.label) + '</li>';
      }
      const secs = s.end == null ? '' : ' <span class="stime">' + esc(((s.end - s.start) / 1000).toFixed(1) + '초') + '</span>';
      return '<li><span class="done-mark" aria-hidden="true">✓</span> ' + esc(s.label) + secs + '</li>';
    })
    .join('');
}

function recordStep(step: string): void {
  const now = Date.now();
  if (stepLog.length) stepLog[stepLog.length - 1].end = now;
  stepLog.push({ label: STEP_LABELS[step] || String(step), start: now, end: null });
  renderProgress();
}

function scrollBottom(): void {
  // 데스크톱은 main 열이 스크롤 컨테이너, 좁은 화면은 페이지 스크롤이므로 둘 다 내린다.
  const mainEl = document.querySelector('.layout main');
  if (mainEl) mainEl.scrollTo(0, mainEl.scrollHeight);
  window.scrollTo(0, document.body.scrollHeight);
}

function startRun(q: string): HTMLElement {
  if (emptyNote) {
    emptyNote.remove();
    emptyNote = null;
  }
  const u = document.createElement('div');
  u.className = 'msg user';
  const ub = document.createElement('div');
  ub.className = 'bubble user';
  ub.textContent = q;
  u.appendChild(ub);
  chatBox.appendChild(u);
  const a = document.createElement('div');
  a.className = 'msg agent';
  a.innerHTML =
    '<div class="progress"><p class="pelapsed">경과 0초</p>' +
    '<ul class="plist"></ul><p class="hint">보통 20~40초 걸립니다.</p></div>';
  chatBox.appendChild(a);
  stepLog = [];
  progWrapEl = a.querySelector('.progress');
  progListEl = a.querySelector('.plist');
  progElapsedEl = a.querySelector('.pelapsed');
  runStart = Date.now();
  stopTicker();
  ticker = window.setInterval(() => {
    if (progElapsedEl) progElapsedEl.textContent = '경과 ' + Math.floor((Date.now() - runStart) / 1000) + '초';
  }, 500);
  scrollBottom();
  return a;
}

function collapseProgress(): void {
  const now = Date.now();
  if (stepLog.length && stepLog[stepLog.length - 1].end == null) {
    stepLog[stepLog.length - 1].end = now;
  }
  stopTicker();
  const total = ((now - runStart) / 1000).toFixed(1);
  if (!stepLog.length) {
    lastProgressText = '';
  } else {
    const parts = stepLog.map((s) => {
      const t = s.end == null ? '' : ' ' + ((s.end - s.start) / 1000).toFixed(1) + '초';
      return s.label + t;
    });
    lastProgressText = '경로: ' + parts.join(' → ') + ' · 총 ' + total + '초';
  }
  if (progWrapEl) progWrapEl.innerHTML = '';
  progWrapEl = null;
  progListEl = null;
  progElapsedEl = null;
}

function failMessage(agentEl: HTMLElement, msg: string): void {
  collapseProgress();
  const d = document.createElement('div');
  d.className = 'bubble agent error';
  d.textContent = msg;
  agentEl.appendChild(d);
  scrollBottom();
}

// ── 생성 답변 vs 그래프 근거 분리 ──
// 생성 문장이 근거처럼 읽히면 안 되므로, 답변은 노란 경고 박스에,
// 그래프·원문 근거는 녹색 박스에 둔다. 그래프 캔버스는 사이드 패널에
// 상주하므로 채팅에는 텍스트 근거와 상세만 둔다.
function answerSectionHtml(answerText: string | null, hasGenerated: boolean): string {
  const kicker = hasGenerated ? '생성 답변 — LLM이 만든 문장 (근거 아님)' : '답변 — 근거 문장 그대로 (생성 없음)';
  const body =
    answerText != null
      ? '<div class="bubble agent">' + renderAnswerHtml(answerText) + '</div>'
      : '<p class="muted">수신된 답변 없음</p>';
  const warn = hasGenerated
    ? '<p class="gen-warn">위 문장은 LLM이 생성한 것으로, 그래프에 없는 표현일 수 있습니다. 오른쪽 그래프 뷰의 강조 경로와 대조하세요.</p>'
    : '';
  return '<section class="gen-answer" aria-label="생성 답변"><p class="gen-kicker">' + esc(kicker) + '</p>' + body + warn + '</section>';
}

function groundSectionOpenHtml(): string {
  return '<section class="ground" aria-label="그래프 근거"><p class="ground-kicker">그래프 근거 — 탐색 경로와 원문</p>';
}

// ── trace 렌더 ──
function traceAnswerText(t: RunTrace): string | null {
  const spans = t.evidenceSpans || [];
  const lines: string[] = [];
  spans.forEach((s) => {
    if (s.sentence) lines.push(s.sentence);
  });
  if (lines.length) return lines.join('\n\n');
  const nodes = (t.selectedPath && t.selectedPath.nodes) || [];
  if (nodes.length) return shortNode(String(nodes[nodes.length - 1]));
  return null;
}

function relaxNote(t: RunTrace): string {
  if (t.retrievalLevel == null) return '';
  const msg = RELAX_NOTICE[t.retrievalLevel];
  if (!msg) return '';
  return '<div class="relax-note">' + esc(msg) + '</div>';
}

// 태그 폴백 안내는 relaxNote와 같은 시각 체계(회색 한 줄)로 둔다. 새 색·새 박스를
// 만들지 않는다. 판정은 trace.relaxationReason의 'tag-fallback' 포함 여부다.
function fallbackNote(t: RunTrace): string {
  const chain = typeof t.relaxationReason === 'string' ? t.relaxationReason : '';
  if (chain.indexOf('tag-fallback') < 0) return '';
  return (
    '<div class="relax-note">' +
    esc('태그를 공유하는 게임끼리 이은 답변입니다. 같은 개발사·유통사로 이어진 경로는 아닙니다.') +
    '</div>'
  );
}

function docTitle(d: string): string {
  return String(d).replace(/^games\//, '').replace(/\.md$/, '');
}

function docText(d: string, labels: Labels): string {
  const doc = String(d);
  if (!labels) return docTitle(doc);
  const stem = doc.slice(-3) === '.md' ? doc.slice(0, -3) : undefined;
  const title = stem !== undefined ? ((labels['game:' + stem] as string) || doc) : doc;
  return title;
}

interface EvidenceGroup {
  document: string;
  sentence: string;
  expressions: string[];
}

function groupedEvidence(t: RunTrace): EvidenceGroup[] {
  const groups: EvidenceGroup[] = [];
  const seen: Record<string, EvidenceGroup & { exprSeen: Record<string, number> }> = {};
  ((t.evidenceSpans || []) as { document: string; sentence: string; expression?: unknown }[]).forEach((s) => {
    const key = String(s.document) + '|' + String(s.sentence);
    let g = seen[key];
    if (!g) {
      g = { document: String(s.document), sentence: String(s.sentence), expressions: [], exprSeen: {} };
      seen[key] = g;
      groups.push(g);
    }
    const ex = s.expression == null ? '' : String(s.expression);
    if (ex && !g.exprSeen[ex]) {
      g.exprSeen[ex] = 1;
      g.expressions.push(ex);
    }
  });
  return groups;
}

function traceEvidenceInner(t: RunTrace, labels: Labels): string {
  const groups = groupedEvidence(t);
  if (!groups.length) return '<p class="muted">수신된 근거 없음</p>';
  return groups
    .map(
      (g) =>
        '<article><div class="eid">' +
        esc(docText(g.document, labels)) +
        '</div>' +
        '<p class="evrow"><span class="k">표현</span> ' +
        esc(g.expressions.join(', ')) +
        '</p>' +
        '<p class="evrow etext"><span class="k">원문</span> ' +
        esc(g.sentence) +
        '</p></article>',
    )
    .join('');
}

function attemptsInner(t: RunTrace): string {
  const atts = t.attempts || [];
  if (!atts.length) return '<p class="muted">시도 기록 없음</p>';
  const rows = atts
    .map(
      (a) =>
        '<tr><td class="num">L' +
        a.level +
        '</td><td class="num">' +
        a.radius +
        '</td>' +
        '<td>' +
        esc(a.outcome) +
        '</td><td>' +
        esc(a.stopReason) +
        '</td><td class="num">' +
        a.pathsFound +
        '</td><td class="num">' +
        a.evidenceSpans +
        '</td>' +
        '<td>' +
        esc((a.blockedHubs && a.blockedHubs.length ? a.blockedHubs.join(', ') : '—')) +
        '</td></tr>',
    )
    .join('');
  return (
    '<table class="att"><tr><th>level</th><th>radius</th><th>outcome</th><th>stopReason</th>' +
    '<th>후보</th><th>근거</th><th>blocked hubs</th></tr>' +
    rows +
    '</table>'
  );
}

function traceConfigInner(t: RunTrace, serverMode?: string): string {
  const snap = t.configSnapshot || {};
  const lvMax = snap.levels && snap.levels.length ? snap.levels.length - 1 : '?';
  const line =
    '모드 ' +
    mode +
    (serverMode && serverMode !== mode ? ' · 서버 ' + serverMode : '') +
    ' · 실행 ' +
    (t.runId || '?') +
    ' · corpus ' +
    (t.corpusFingerprint || '?') +
    ' · 근거 최소 ' +
    (snap.answerEvidenceMin != null ? snap.answerEvidenceMin : '?') +
    '건 · 레벨 L0–L' +
    lvMax;
  const rel = t.relaxationReason ? '<p class="cfg">완화 기록: ' + esc(t.relaxationReason) + '</p>' : '';
  return '<p class="cfg">' + esc(line) + '</p>' + rel;
}

function traceDetailHtml(t: RunTrace, serverMode: string | undefined, labels: Labels): string {
  const n = groupedEvidence(t).length;
  return (
    '<details class="detail"><summary>▸ 근거 ' +
    n +
    '건 · 시도 기록</summary>' +
    '<h5>근거</h5>' +
    traceEvidenceInner(t, labels) +
    '<h5>시도 기록</h5>' +
    attemptsInner(t) +
    '<h5>설정</h5>' +
    traceConfigInner(t, serverMode) +
    '</details>'
  );
}

// 보류 사유는 추측하지 않고 trace.relaxationReason 체인의 마지막 레벨
// 토막(`L{n} {stopReason} 후보 {N} {selectReason}`)에서 읽는다.
// selectReason 코드 실물(서버 retrieve/select.ts·engine.ts):
// 'ok' | 'no-non-tag-edge' | 'evidence-shortfall(best X<min Y)' | 'entity-unresolved'.
interface RejectChainEnd {
  readonly stop: string;
  readonly candidates: number;
  readonly reason: string;
}

function lastChainEnd(t: RunTrace): RejectChainEnd | null {
  const chain = typeof t.relaxationReason === 'string' ? t.relaxationReason : '';
  if (!chain) return null;
  const segs = chain
    .split('→')
    .map((s) => s.trim())
    .filter((s) => /^L\d+\s/.test(s));
  if (!segs.length) return null;
  const m = segs[segs.length - 1].match(/^L\d+\s+(\S+)\s+후보\s+(\d+)\s+(\S+)/);
  if (!m) return null;
  return { stop: m[1], candidates: Number(m[2]), reason: m[3] };
}

function rejectWhy(t: RunTrace): string {
  const atts = t.attempts || [];
  if (!atts.length) return '시도 기록이 없습니다.';
  const end = lastChainEnd(t);
  if (!end) return '보류된 이유를 trace에서 특정하지 못했습니다. 아래 시도 기록을 참고해 주세요.';
  if (end.reason === 'entity-unresolved') {
    return '질문에 나온 이름과 일치하는 게임을 코퍼스에서 찾지 못했습니다. 게임 리스트 탭의 표기 그대로 질문해 보세요.';
  }
  if (end.candidates === 0) {
    return '질문한 게임에서 이어지는 경로를 찾지 못했습니다 (마지막 레벨 후보 0건).';
  }
  if (end.reason === 'no-non-tag-edge') {
    return '찾은 연결이 태그뿐이라 근거 경로를 만들지 못했습니다. 이 데모는 개발사·유통사 같은 태그 바깥 연결이 최소 하나 있어야 답합니다.';
  }
  if (end.reason.indexOf('evidence-shortfall') === 0) {
    const n = end.reason.match(/best\s+(\d+)\s*<\s*min\s+(\d+)/);
    if (n) {
      return '후보 길은 있었으나 모은 근거가 ' + n[1] + '건으로 기준 ' + n[2] + '건에 못 미쳐 보류됐습니다.';
    }
    return '후보 길은 있었으나 모은 근거가 기준에 못 미쳐 보류됐습니다.';
  }
  if (end.stop === 'all_hubs_blocked') {
    return '후보 경로가 공용 허브를 지나 제외됐습니다. 아래 시도 기록의 차단 허브를 참고해 주세요.';
  }
  return '보류된 이유를 trace에서 특정하지 못했습니다. 아래 시도 기록을 참고해 주세요.';
}

// 보류 화면 제안 질문. 전부 데모 서버에 직접 던져 답이 나오는 것만 둔다
// (2026-09-21 실측 ANSWER 7건). 전수 조사(250문항)에서도 확인됐듯 검색은
// 질문 표현이 아니라 시작 게임만 보므로, 회사명을 함께 적는 표현은 쓰지 않고
// 기준 게임 하나만 묻는 형태로 둔다. 제목은 코퍼스 정식 표기 그대로 쓴다.
const ABSTAIN_SUGGESTIONS: readonly string[] = [
  'Portal 2랑 비슷한 게임 있어',
  'ELDEN RING이랑 비슷한 게임 있어',
  'Cyberpunk 2077이랑 비슷한 게임 있어',
  'Stellaris랑 비슷한 게임 있어',
  'Fallout 4랑 비슷한 게임 있어',
  'Grand Theft Auto V Legacy랑 비슷한 게임 있어',
  "Baldur's Gate 3랑 비슷한 게임 있어",
];

function suggestHtml(): string {
  return (
    '<div class="suggest"><p class="suggest-kicker">' +
    esc('개발사·유통사가 같은 게임끼리 묶는 질문에는 답할 수 있습니다. 눌러서 바로 질문해 보세요.') +
    '</p><div class="suggest-list">' +
    ABSTAIN_SUGGESTIONS.map(
      (q) => '<button type="button" class="suggest-q" data-q="' + esc(q) + '">' + esc(q) + '</button>',
    ).join('') +
    '</div></div>'
  );
}

function rejectionHtml(t: RunTrace, serverMode: string | undefined, labels: Labels): string {
  return (
    '<div class="rejection"><h4>답을 찾지 못했습니다</h4>' +
    '<p class="rreason">' +
    esc(rejectWhy(t)) +
    '</p>' +
    suggestHtml() +
    '</div>' +
    '<details class="detail"><summary>▸ 시도한 레벨 · 차단 허브 · 후보와 탈락 이유</summary>' +
    '<h5>시도 기록</h5>' +
    attemptsInner(t) +
    '<h5>근거</h5>' +
    traceEvidenceInner(t, labels) +
    '<h5>설정</h5>' +
    traceConfigInner(t, serverMode) +
    '</details>'
  );
}

function renderTraceInto(
  el: HTMLElement,
  a: string | null,
  t: RunTrace,
  serverMode: string | undefined,
  labels: Labels,
  generated: boolean,
): void {
  const refused = t.abstained === true || !t.selectedPath;
  const merged = mergedLabels(labels);
  if (refused) {
    el.insertAdjacentHTML('beforeend', rejectionHtml(t, serverMode, merged));
    highlightSidePath(null, merged);
    scrollBottom();
    return;
  }
  const path = t.selectedPath!;
  el.insertAdjacentHTML('beforeend', answerSectionHtml(a ?? '(빈 답변)', generated));
  // 그래프 근거 섹션: 사이드 패널에 경로 강조 + 텍스트 경로, 채팅에는 완화 고지와 접힌 상세.
  const ground = document.createElement('div');
  ground.innerHTML =
    groundSectionOpenHtml() +
    pathTextHtml(path, merged) +
    relaxNote(t) +
    fallbackNote(t) +
    traceDetailHtml(t, serverMode, merged) +
    '</section>';
  el.appendChild(ground);
  highlightSidePath(path, merged);
  scrollBottom();
}

// ── 레거시 shape 렌더 (기존 동작 유지) ──
function alertHtml(r: RunTrace): string {
  let out = '';
  if (r.escalated) out += '<div class="notfound-line">답을 찾지 못했습니다</div>';
  const vs = (r.verify && r.verify.violations) || [];
  if (vs.length) out += '<p class="vcount">검증 위반 ' + vs.length + '건</p>';
  return out;
}

function metaDetailHtml(r: RunTrace): string {
  const tools = r.toolsUsed && r.toolsUsed.length ? r.toolsUsed.join(', ') : '없음';
  const line = '분류: ' + r.category + ' · conf ' + r.confidence + ' · 도구: ' + tools;
  const prog = lastProgressText ? '<p class="cfg">' + esc(lastProgressText) + '</p>' : '';
  return '<p class="cfg">' + esc(line) + '</p>' + prog;
}

function violationsDetailHtml(r: RunTrace): string {
  const vs = (r.verify && r.verify.violations) || [];
  if (!vs.length) return '';
  return (
    '<h5>검증 결과</h5><ul class="violations">' +
    vs.map((x) => '<li><code>' + esc(x.rule) + '</code> — ' + esc(x.detail) + '</li>').join('') +
    '</ul>'
  );
}

function evidenceDetailInner(r: RunTrace): string {
  const evList = r.evidence && r.evidence.length ? r.evidence : null;
  if (evList) {
    return evList
      .map(
        (e) =>
          '<article><div class="eid">' +
          esc(docTitle(String(e.heading || e.id))) +
          '</div><p class="etext">' +
          esc(e.text || '') +
          '</p></article>',
      )
      .join('');
  }
  const n = r.evidenceIds && r.evidenceIds.length ? r.evidenceIds.length : 0;
  return '<p class="muted">수신된 근거 텍스트 없음 (' + n + '건)</p>';
}

function evidenceCount(r: RunTrace): number {
  if (r.evidence && r.evidence.length) return r.evidence.length;
  if (r.evidenceIds && r.evidenceIds.length) return r.evidenceIds.length;
  return 0;
}

function fillMessage(agentEl: HTMLElement, r: RunTrace): void {
  collapseProgress();
  agentEl.insertAdjacentHTML('beforeend', answerSectionHtml(r.answer ?? '(빈 답변)', false));
  const inner =
    '<h5>근거</h5>' + evidenceDetailInner(r) + violationsDetailHtml(r) + '<h5>기록</h5>' + metaDetailHtml(r);
  agentEl.insertAdjacentHTML(
    'beforeend',
    alertHtml(r) +
      '<details class="detail"><summary>▸ 근거 ' +
      evidenceCount(r) +
      '건 · 상세 기록</summary>' +
      inner +
      '</details>',
  );
  scrollBottom();
}

// 구형 stub 렌더(StubResult·serverWhy·stub*·renderStubInto)는 제거했다.
// 현 서버는 항상 result{mode,trace}를 보내므로 trace 없는 분기는 도달하지 않고,
// serverWhy에 rejectWhy와 어긋나는 두 번째 설명(허브 이야기)이 남아 있었다.
// trace 없는 응답이 오면 renderServerInto 말미에서 모른다고만 말한다.
function renderServerInto(agentEl: HTMLElement, q: string, r: AskResultPayload | null): void {
  void q;
  if (r && typeof r === 'object' && r.trace && typeof r.trace === 'object') {
    collapseProgress();
    const ans =
      typeof r.answer === 'string' && r.answer ? r.answer : traceAnswerText(r.trace as RunTrace);
    const generated = typeof r.answer === 'string' && r.answer.length > 0;
    renderTraceInto(agentEl, ans, r.trace as RunTrace, r.mode, r.labels, generated);
    return;
  }
  const raw = r as unknown as Record<string, unknown>;
  if (
    r &&
    typeof r === 'object' &&
    (raw['selectedPath'] !== undefined || raw['evidenceSpans'] !== undefined || raw['retrievalLevel'] !== undefined)
  ) {
    collapseProgress();
    const t = r as unknown as RunTrace;
    const ans = (raw['answer'] as string | null) ?? traceAnswerText(t);
    renderTraceInto(agentEl, ans, t, undefined, undefined, raw['answer'] != null);
    return;
  }
  if (
    r &&
    typeof r === 'object' &&
    (raw['category'] !== undefined ||
      raw['toolsUsed'] !== undefined ||
      raw['verify'] !== undefined ||
      raw['evidenceIds'] !== undefined ||
      raw['evidence'] !== undefined)
  ) {
    fillMessage(agentEl, r as unknown as RunTrace);
    return;
  }
  collapseProgress();
  agentEl.insertAdjacentHTML(
    'beforeend',
    '<div class="rejection"><h4>답을 찾지 못했습니다</h4>' +
      '<p class="rreason">서버 응답에 trace가 없어 보류 이유를 특정하지 못했습니다.</p></div>',
  );
  scrollBottom();
}

function settleInFlight(): void {
  inFlight = false;
  sendBtn.disabled = false;
}

// ── 배선 ──
(document.getElementById('mode-demo') as HTMLButtonElement).addEventListener('click', (ev) => {
  mode = 'demo';
  (ev.target as HTMLButtonElement).setAttribute('aria-pressed', 'true');
  endpointBox.textContent = '데모 모드로 동작합니다. 질문은 이 서버의 /ask로 전달됩니다.';
});

// 예시 질문 클릭 → 입력창에 넣고 바로 실행한다.
if (emptyNote) {
  emptyNote.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('.example-q') as HTMLElement | null;
    if (!btn || inFlight) return;
    input.value = btn.dataset['q'] || btn.textContent || '';
    form.requestSubmit();
  });
}

// 보류 화면 제안 질문 클릭 → 입력창에 넣고 바로 실행한다.
// 제안 버튼은 채팅 안에 동적으로 생기므로 위임으로 받는다.
document.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest('.suggest-q') as HTMLElement | null;
  if (!btn || inFlight) return;
  input.value = btn.dataset['q'] || btn.textContent || '';
  form.requestSubmit();
});

initCorpusPanel();

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  if (inFlight) return;
  const q = input.value.trim();
  if (!q) return;
  inFlight = true;
  sendBtn.disabled = true;
  const agentEl = startRun(q);
  input.value = '';

  askServer(q, mode, recordStep)
    .then((got) => {
      settleInFlight();
      if (got.kind === 'sse') {
        if (got.out.errMsg) {
          failMessage(agentEl, got.out.errMsg);
          return;
        }
        renderServerInto(agentEl, q, got.out.result as AskResultPayload);
        return;
      }
      if (got.status !== 200) {
        const data = got.data as { error?: string };
        failMessage(agentEl, data && data.error ? data.error : '요청 실패 (HTTP ' + got.status + ')');
        return;
      }
      renderServerInto(agentEl, q, got.data as AskResultPayload);
    })
    .catch((err: unknown) => {
      settleInFlight();
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'stream-cut') {
        failMessage(agentEl, '서버 응답이 중간에 끊겼습니다. 다시 질문하세요.');
      } else if (msg.indexOf('bad-body-') === 0) {
        failMessage(agentEl, '서버 응답을 읽지 못했습니다 (HTTP ' + msg.slice(9) + ').');
      } else {
        failMessage(agentEl, '서버에 연결할 수 없습니다. collie serve가 켜져 있는지 확인하세요.');
      }
    });
});
