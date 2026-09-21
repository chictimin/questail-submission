// GET /corpus 계약. 서버가 코퍼스의 문서 목록과 그래프 전체를 돌려준다.
// 이 파일은 조회 + 최소 검증만 한다. 형태는 서버와 맞춰져 있으므로
// 한쪽만 바꾸지 마라.
export interface CorpusDocument {
  /** 서버는 appid 를 숫자로 보낸다. 표시·매칭 양쪽에서 쓰여 두 형태를 받는다. */
  readonly id: string | number;
  readonly title: string;
  readonly developers: readonly string[];
  readonly publishers: readonly string[];
  readonly tags: readonly string[];
}

export interface CorpusNode {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
}

export interface CorpusEdge {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly verified: boolean;
}

export interface CorpusResponse {
  readonly mode: string;
  readonly documents: readonly CorpusDocument[];
  readonly graph: {
    readonly nodes: readonly CorpusNode[];
    readonly edges: readonly CorpusEdge[];
  };
}

export async function fetchCorpus(): Promise<CorpusResponse> {
  const res = await fetch('/corpus', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('corpus-http-' + res.status);
  const data: unknown = await res.json().catch(() => {
    throw new Error('corpus-bad-body');
  });
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray((data as { documents?: unknown }).documents) ||
    (data as { graph?: unknown }).graph == null ||
    typeof (data as { graph?: unknown }).graph !== 'object' ||
    !Array.isArray((data as { graph: { nodes?: unknown } }).graph.nodes) ||
    !Array.isArray((data as { graph: { edges?: unknown } }).graph.edges)
  ) {
    throw new Error('corpus-bad-body');
  }
  return data as CorpusResponse;
}

// 빈 화면 금지: 실패 이유를 사람이 읽을 수 있는 문장으로 돌려준다.
export function corpusErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : '';
  const m = msg.match(/^corpus-http-(\d+)$/);
  if (m) {
    if (m[1] === '404') {
      return '코퍼스 API(/corpus)가 아직 없습니다 (HTTP 404). 서버에 corpus 엔드포인트가 들어오면 자동으로 표시됩니다.';
    }
    return '코퍼스 API를 불러오지 못했습니다 (HTTP ' + m[1] + ').';
  }
  if (msg === 'corpus-bad-body') return '코퍼스 API 응답을 읽지 못했습니다. 서버 응답 형태를 확인하세요.';
  return '코퍼스 API에 연결할 수 없습니다. serve가 켜져 있는지 확인하세요.';
}
