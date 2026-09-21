// SSE 파서. 계약: event: step{node,level,...} → event: result{mode,trace,labels?,answer?}
// 또는 event: error. 구형 done/type 필드도 관용적으로 받는다.
export interface SseFrame {
  event: string;
  data: string;
}

export type StepHandler = (node: string) => void;

export interface SseResult {
  result: unknown;
  errMsg: string;
}

function parseSSEBlock(block: string): SseFrame | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];
  block.split('\n').forEach((line) => {
    if (line.slice(0, 6) === 'event:') event = line.slice(6).trim();
    else if (line.slice(0, 5) === 'data:') dataLines.push(line.slice(5).trim());
  });
  if (event === undefined) return undefined;
  return { event, data: dataLines.join('\n') };
}

export async function readSSEStream(res: Response, onStep: StepHandler): Promise<SseResult> {
  if (!res.body || typeof (res.body as ReadableStream).getReader !== 'function') {
    throw new Error('no-stream');
  }
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let settled = false;
  let result: unknown = null;
  let errMsg = '';

  const onFrame = (frame: SseFrame): void => {
    if (frame.event === 'step') {
      try {
        const st = JSON.parse(frame.data) as { node?: string };
        onStep((st && st.node) || frame.data);
      } catch {
        onStep(frame.data);
      }
    } else if (frame.event === 'result') {
      try {
        settled = true;
        result = JSON.parse(frame.data) as unknown;
      } catch {
        settled = true;
        errMsg = '서버 응답을 읽지 못했습니다.';
      }
    } else if (frame.event === 'error') {
      settled = true;
      try {
        const ej = JSON.parse(frame.data) as { message?: string };
        errMsg = (ej && ej.message) || frame.data;
      } catch {
        errMsg = frame.data || '실행 실패';
      }
    } else {
      try {
        const ev = JSON.parse(frame.data) as { type?: string; step?: string; result?: unknown; message?: string };
        if (!ev || typeof ev.type !== 'string') return;
        if (ev.type === 'step') onStep(ev.step ?? '');
        else if (ev.type === 'done') {
          settled = true;
          result = ev.result;
        } else if (ev.type === 'error') {
          settled = true;
          errMsg = ev.message || '실행 실패';
        }
      } catch {
        /* 다음 청크에서 계속 */
      }
    }
  };

  const handleChunk = (chunk: string): void => {
    if (!chunk.trim()) return;
    const frame = parseSSEBlock(chunk);
    if (frame) {
      onFrame(frame);
      return;
    }
    const data: string[] = [];
    chunk.split('\n').forEach((line) => {
      if (line.slice(0, 5) === 'data:') data.push(line.slice(5).trim());
    });
    if (!data.length) return;
    try {
      const ev = JSON.parse(data.join('\n')) as { type?: string; step?: string; result?: unknown; message?: string };
      if (!ev || typeof ev.type !== 'string') return;
      if (ev.type === 'step') onStep(ev.step ?? '');
      else if (ev.type === 'done') {
        settled = true;
        result = ev.result;
      } else if (ev.type === 'error') {
        settled = true;
        errMsg = ev.message || '실행 실패';
      }
    } catch {
      /* 다음 청크에서 계속 */
    }
  };

  const pump = async (): Promise<SseResult> => {
    const rd = await reader.read();
    if (rd.done) {
      buf += decoder.decode();
      if (buf.trim()) handleChunk(buf);
      buf = '';
      if (!settled) throw new Error('stream-cut');
      return { result, errMsg };
    }
    buf += decoder.decode(rd.value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    parts.forEach(handleChunk);
    return pump();
  };
  return pump();
}

export async function askServer(
  q: string,
  mode: string,
  onStep: StepHandler,
): Promise<{ kind: 'sse'; out: SseResult } | { kind: 'json'; status: number; data: unknown }> {
  const res = await fetch('/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/json' },
    body: JSON.stringify({ question: q, mode }),
  });
  const ct = res.headers.get('content-type') || '';
  if (res.ok && ct.indexOf('text/event-stream') >= 0 && res.body) {
    const out = await readSSEStream(res, onStep);
    return { kind: 'sse', out };
  }
  const data = await res.json().catch(() => {
    throw new Error('bad-body-' + res.status);
  });
  return { kind: 'json', status: res.status, data };
}
