// 서버 계약 타입. result.trace.selectedPath + result.labels가 그래프 입력이다.
export interface PathEdge {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly verified: boolean;
}

export interface SelectedPath {
  readonly nodes: readonly string[];
  readonly edges: readonly PathEdge[];
}

export interface EvidenceSpan {
  readonly document: string;
  readonly sentence: string;
  readonly expression: string;
}

export interface AttemptTrace {
  readonly level: number;
  readonly radius: number;
  readonly outcome: string;
  readonly stopReason: string;
  readonly pathsFound: number;
  readonly evidenceSpans: number;
  readonly blockedHubs: readonly string[];
}

export interface RunTrace {
  readonly abstained?: boolean;
  readonly selectedPath?: SelectedPath | null;
  readonly evidenceSpans?: readonly EvidenceSpan[];
  readonly attempts?: readonly AttemptTrace[];
  readonly retrievalLevel?: number;
  readonly relaxationReason?: string;
  readonly runId?: string;
  readonly corpusFingerprint?: string;
  readonly configSnapshot?: {
    readonly answerEvidenceMin?: number;
    readonly levels?: readonly unknown[];
  };
  readonly evidenceIds?: readonly string[];
  readonly category?: string;
  readonly confidence?: number;
  readonly toolsUsed?: readonly string[];
  readonly verify?: { readonly violations?: readonly { rule: string; detail: string }[] };
  readonly evidence?: readonly { id?: string; heading?: string; text?: string }[];
  readonly escalated?: boolean;
  readonly answer?: string | null;
  readonly mode?: string;
  readonly level?: number;
  readonly attemptsLegacy?: never;
}

export interface AskResultPayload {
  readonly mode?: string;
  readonly trace?: RunTrace;
  readonly labels?: Readonly<Record<string, string>>;
  readonly answer?: string;
}

export type Labels = Readonly<Record<string, string>> | undefined;

export function shortNode(n: string): string {
  const s = String(n);
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

export function labelOf(labels: Labels, id: string): string | null {
  if (labels && typeof labels[id] === 'string' && labels[id]) return labels[id] as string;
  return null;
}

export function nodeText(n: string, labels: Labels): string {
  const id = String(n);
  if (!labels) return shortNode(n);
  return labelOf(labels, id) ?? id;
}

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (ch) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch;
  });
}
