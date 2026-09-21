// 평가셋 모달: GET /eval/questions 조회로 표를 그린다. 인라인 문항 없음.
export interface EvalItem {
  readonly id: string;
  readonly question: string;
  readonly status: string;
  readonly expect?: { readonly kind: string; readonly level?: number };
  readonly gold?: string;
}

export const EVAL_MAP: Record<string, { id: string; expected: string | null }> = {};

function evalExpected(item: EvalItem): string | null {
  const ex = item.expect;
  if (!ex) return null;
  if (ex.kind === 'answer' && typeof ex.level === 'number') return 'L' + ex.level;
  if (ex.kind === 'abstain') return '보류';
  return null;
}

export function evalLine(q: string, t: { abstained?: boolean; retrievalLevel?: number }): string {
  const e = EVAL_MAP[q];
  if (!e || !e.expected) return '';
  const act = t.abstained === true ? '보류' : t.retrievalLevel != null ? 'L' + t.retrievalLevel : '?';
  const mark = e.expected === act ? '일치' : '다름';
  const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
  return '<div class="eval-line">' + esc(`${e.id} 기대 ${e.expected} · 실제 ${act} — ${mark}`) + '</div>';
}

export function initEvalModal(opts: {
  backdrop: HTMLElement;
  rows: HTMLElement;
  err: HTMLElement;
  modeNote: HTMLElement;
  getMode: () => string;
  submitQuestion: (q: string) => void;
}): void {
  const { backdrop, rows, err, modeNote, getMode, submitQuestion } = opts;

  const close = (): void => {
    backdrop.hidden = true;
  };

  const renderRows = (items: EvalItem[]): void => {
    for (const k of Object.keys(EVAL_MAP)) delete EVAL_MAP[k];
    rows.innerHTML = '';
    items.forEach((item) => {
      const pending = item.status === 'pending' || !item.question;
      const exp = evalExpected(item);
      if (!pending && item.question) EVAL_MAP[item.question] = { id: item.id, expected: exp };
      const tr = document.createElement('tr');
      tr.className = pending ? 'pending' : 'live';
      const num = document.createElement('td');
      num.className = 'num';
      num.textContent = item.id;
      tr.appendChild(num);
      const qc = document.createElement('td');
      if (!pending) {
        const qb = document.createElement('button');
        qb.className = 'eval-q';
        qb.type = 'button';
        qb.textContent = item.question;
        qb.addEventListener('click', () => submitQuestion(item.question));
        qc.appendChild(qb);
      }
      tr.appendChild(qc);
      const xc = document.createElement('td');
      xc.textContent = pending ? '미확정' : exp || '?';
      tr.appendChild(xc);
      rows.appendChild(tr);
      if (!pending && item.gold) {
        const xb = document.createElement('button');
        xb.className = 'eval-x';
        xb.type = 'button';
        xb.textContent = '▸';
        xb.setAttribute('aria-label', 'gold 경로 펼치기');
        qc.appendChild(xb);
        const gr = document.createElement('tr');
        gr.className = 'eval-gold';
        gr.hidden = true;
        const gd = document.createElement('td');
        gd.setAttribute('colspan', '3');
        gd.textContent = item.gold;
        gr.appendChild(gd);
        rows.appendChild(gr);
        xb.addEventListener('click', () => {
          gr.hidden = !gr.hidden;
          xb.textContent = gr.hidden ? '▸' : '▾';
        });
      }
    });
  };

  const open = (): void => {
    modeNote.hidden = getMode() !== 'demo';
    err.hidden = true;
    err.textContent = '';
    rows.innerHTML = '';
    backdrop.hidden = false;
    fetch('eval/questions')
      .then((res) => {
        if (!res.ok) throw new Error('eval-unavailable-' + res.status);
        return res.json() as Promise<EvalItem[]>;
      })
      .then((items) => {
        if (!Array.isArray(items)) throw new Error('eval-bad-body');
        renderRows(items);
      })
      .catch(() => {
        err.textContent = '평가셋을 불러오지 못했습니다. serve 실행 후 다시 여세요.';
        err.hidden = false;
      });
  };

  document.getElementById('eval-open')?.addEventListener('click', open);
  document.getElementById('eval-close')?.addEventListener('click', close);
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) close();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !backdrop.hidden) close();
  });
}
