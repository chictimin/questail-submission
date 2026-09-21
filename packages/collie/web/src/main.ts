import './style.css';
import { askServer } from './sse.js';
import { renderAnswerHtml } from './markdown.js';
import { graphLegendHtml, pathTextHtml, renderPathGraph } from './graph.js';
import { evalLine, initEvalModal } from './eval.js';
import {
  esc,
  shortNode,
  type AskResultPayload,
  type Labels,
  type RunTrace,
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
// 그래프·원문 근거는 녹색 박스에 둔다.
function answerSectionHtml(answerText: string | null, hasGenerated: boolean): string {
  const kicker = hasGenerated ? '생성 답변 — LLM이 만든 문장 (근거 아님)' : '답변 — 근거 문장 그대로 (생성 없음)';
  const body =
    answerText != null
      ? '<div class="bubble agent">' + renderAnswerHtml(answerText) + '</div>'
      : '<p class="muted">수신된 답변 없음</p>';
  const warn = hasGenerated
    ? '<p class="gen-warn">위 문장은 LLM이 생성한 것으로, 그래프에 없는 표현일 수 있습니다. 아래 그래프 근거와 대조하세요.</p>'
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
        '</td>' +
        '<td class="num">' +
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

function rejectWhy(t: RunTrace): string {
  const atts = t.attempts || [];
  if (!atts.length) return '시도 기록이 없습니다.';
  const cands = atts.reduce((s, a) => s + (a.pathsFound || 0), 0);
  const ev = atts.reduce((s, a) => s + (a.evidenceSpans || 0), 0);
  if (cands === 0 && ev === 0) return '시작 개체를 찾지 못했습니다.';
  if (cands === 0) return '시작 개체에서 이어지는 경로를 찾지 못했습니다.';
  return '후보 경로는 있었으나 허브 바깥의 근거가 부족했습니다.';
}

function rejectionHtml(t: RunTrace, serverMode: string | undefined, labels: Labels): string {
  return (
    '<div class="rejection"><h4>답을 찾지 못했습니다</h4>' +
    '<p class="rreason">' +
    esc(rejectWhy(t)) +
    '</p></div>' +
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
  q: string,
  generated: boolean,
): void {
  const refused = t.abstained === true || !t.selectedPath;
  const evl = q ? evalLine(q, t) : '';
  if (refused) {
    el.insertAdjacentHTML('beforeend', rejectionHtml(t, serverMode, labels) + evl);
    scrollBottom();
    return;
  }
  const path = t.selectedPath!;
  el.insertAdjacentHTML('beforeend', answerSectionHtml(a ?? '(빈 답변)', generated) + evl);
  // 그래프 근거 섹션: Cytoscape 캔버스 + 범례 + 텍스트 경로 + 완화 고지 + 접힌 상세.
  const ground = document.createElement('div');
  ground.innerHTML =
    groundSectionOpenHtml() +
    '<div class="cy" role="img" aria-label="선택 경로 그래프"></div>' +
    graphLegendHtml() +
    pathTextHtml(path, labels) +
    relaxNote(t) +
    traceDetailHtml(t, serverMode, labels) +
    '</section>';
  el.appendChild(ground);
  const cyBox = ground.querySelector('.cy') as HTMLElement | null;
  if (cyBox) {
    try {
      renderPathGraph(cyBox, path, labels);
    } catch {
      cyBox.innerHTML = '<p class="muted">그래프를 그리지 못했습니다. 아래 텍스트 경로를 확인하세요.</p>';
    }
  }
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

interface StubResult {
  abstained?: boolean;
  answer?: string;
  level?: number;
  mode?: string;
  verifyReason?: string;
  attempts?: { level: number; outcome: string }[];
}

function stubAttemptsLine(r: StubResult): string {
  const atts = r.attempts || [];
  if (!atts.length) return '시도 기록 없음';
  return '시도: ' + atts.map((a) => 'L' + a.level + ' ' + a.outcome).join(' → ');
}

function stubMetaHtml(r: StubResult): string {
  const line = '모드 ' + mode + ' · 서버 ' + (r.mode || '?') + (r.verifyReason ? ' · 검증: ' + r.verifyReason : '');
  const prog = lastProgressText ? '<p class="cfg">' + esc(lastProgressText) + '</p>' : '';
  return '<p class="cfg">' + esc(line) + '</p>' + prog;
}

function serverWhy(r: StubResult): string {
  const atts = r.attempts || [];
  if (!atts.length) return '시도 기록이 없습니다.';
  const found = atts.some((a) => a.outcome === 'paths_found');
  if (!found) return '시작 개체에서 이어지는 경로를 찾지 못했습니다.';
  return '후보 경로는 있었으나 허브 바깥의 근거가 부족했습니다.';
}

function stubDetailHtml(r: StubResult): string {
  const n = (r.attempts || []).length;
  return (
    '<details class="detail"><summary>▸ 시도 ' +
    n +
    '건 · 상세 기록</summary>' +
    '<h5>시도 기록</h5><p class="cfg">' +
    esc(stubAttemptsLine(r)) +
    '</p><h5>근거</h5><p class="muted">수신된 근거 없음</p><h5>기록</h5>' +
    stubMetaHtml(r) +
    '</details>'
  );
}

function renderStubInto(el: HTMLElement, r: StubResult): void {
  if (r.abstained === true) {
    el.insertAdjacentHTML(
      'beforeend',
      '<div class="rejection"><h4>답을 찾지 못했습니다</h4>' +
        '<p class="rreason">' +
        esc(serverWhy(r)) +
        '</p></div>' +
        stubDetailHtml(r),
    );
  } else {
    el.insertAdjacentHTML('beforeend', answerSectionHtml(r.answer ?? '(빈 답변)', true));
    const t = { retrievalLevel: r.level } as RunTrace;
    el.insertAdjacentHTML('beforeend', relaxNote(t) + stubDetailHtml(r));
  }
  scrollBottom();
}

function renderServerInto(agentEl: HTMLElement, q: string, r: AskResultPayload | null): void {
  if (r && typeof r === 'object' && r.trace && typeof r.trace === 'object') {
    collapseProgress();
    const ans =
      typeof r.answer === 'string' && r.answer ? r.answer : traceAnswerText(r.trace as RunTrace);
    const generated = typeof r.answer === 'string' && r.answer.length > 0;
    renderTraceInto(agentEl, ans, r.trace as RunTrace, r.mode, r.labels, q, generated);
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
    renderTraceInto(agentEl, ans, t, undefined, undefined, q, raw['answer'] != null);
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
  renderStubInto(agentEl, (r || {}) as StubResult);
}

function settleInFlight(): void {
  inFlight = false;
  sendBtn.disabled = false;
}

// ── 배선 ──
(document.getElementById('mode-demo') as HTMLButtonElement).addEventListener('click', (ev) => {
  mode = 'demo';
  (ev.target as HTMLButtonElement).setAttribute('aria-pressed', 'true');
  endpointBox.textContent = 'demo 모드 · same-origin POST /ask (SSE)';
});

initEvalModal({
  backdrop: document.getElementById('eval-backdrop') as HTMLElement,
  rows: document.getElementById('eval-rows') as HTMLElement,
  err: document.getElementById('eval-err') as HTMLElement,
  modeNote: document.getElementById('eval-mode-note') as HTMLElement,
  getMode: () => mode,
  submitQuestion: (q) => {
    input.value = q;
    (document.getElementById('eval-backdrop') as HTMLElement).hidden = true;
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { cancelable: true }));
  },
});

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
