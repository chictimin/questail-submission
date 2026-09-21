import { esc } from './types.js';

// 기존 인라인 렌더 포팅: esc → 마크다운 변환 → 분 병기 순서.
function mdInline(s: string): string {
  const parts = s.split(/(`[^`]*`)/g);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      parts[i] = '<code>' + parts[i].slice(1, -1) + '</code>';
    } else {
      parts[i] = parts[i].replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    }
  }
  return parts.join('');
}

export function renderMarkdown(src: string): string {
  const lines = esc(src).split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: string; items: string[] } | null = null;
  let quote: string[] = [];
  const flushPara = (): void => {
    if (para.length) {
      out.push('<p>' + para.join('<br>') + '</p>');
      para = [];
    }
  };
  const flushList = (): void => {
    if (list) {
      out.push('<' + list.tag + '>' + list.items.map((it) => '<li>' + it + '</li>').join('') + '</' + list.tag + '>');
      list = null;
    }
  };
  const flushQuote = (): void => {
    if (quote.length) {
      out.push('<blockquote>' + quote.join('<br>') + '</blockquote>');
      quote = [];
    }
  };
  const openList = (tag: string, item: string): void => {
    if (!list || list.tag !== tag) {
      flushList();
      list = { tag, items: [] };
    }
    list.items.push(item);
  };
  for (const line of lines) {
    const mHead = line.match(/^(#{1,4})\s+(.*)$/);
    const mQuote = line.match(/^&gt; ?(.*)$/);
    const mUl = line.match(/^[-*]\s+(.*)$/);
    const mOl = line.match(/^\d+\.\s+(.*)$/);
    if (/^\s*$/.test(line)) {
      flushPara();
      flushList();
      flushQuote();
      continue;
    }
    if (mHead) {
      flushPara();
      flushList();
      flushQuote();
      const lv = mHead[1].length + 2;
      out.push('<h' + lv + '>' + mdInline(mHead[2]) + '</h' + lv + '>');
      continue;
    }
    if (mQuote) {
      flushPara();
      flushList();
      quote.push(mdInline(mQuote[1]));
      continue;
    }
    if (mUl) {
      flushPara();
      flushQuote();
      openList('ul', mdInline(mUl[1]));
      continue;
    }
    if (mOl) {
      flushPara();
      flushQuote();
      openList('ol', mdInline(mOl[1]));
      continue;
    }
    flushList();
    flushQuote();
    para.push(mdInline(line));
  }
  flushPara();
  flushList();
  flushQuote();
  return out.join('');
}

function fmtMinutes(m: number): string {
  if (m < 60) return m + '분';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return m + '분(' + h + '시간' + (r ? ' ' + r + '분' : '') + ')';
}

export function annotateMinutes(html: string): string {
  return html
    .split(/(<[^>]*>)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(/(\d+)분(?!\()/g, (_m, num) => fmtMinutes(Number(num)));
    })
    .join('');
}

export function renderAnswerHtml(text: string): string {
  return annotateMinutes(renderMarkdown(text));
}
