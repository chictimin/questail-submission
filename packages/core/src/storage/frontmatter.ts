/**
 * Frontmatter 파싱/직렬화 헬퍼.
 *
 * games/*.md와 library.md가 공유하는 최소 YAML 서브셋만 다룬다:
 *   - 최상위 `key: scalar` 한 줄 항목
 *   - 최상위 `key:` + `  - item` 배열 항목
 * 스칼라는 number / boolean / "(더블쿼트) 문자열" / 일반 문자열을 판별한다.
 * 전체 YAML 파서 의존성을 끌고 오지 않기 위한 의도적 선택이다.
 */

/** `---` 펜스로 감싼 frontmatter 문서 하나를 나눈다. */
export function splitFrontmatterDoc(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: content };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }
  const frontmatter = parseFrontmatterLines(lines.slice(1, end));
  const body = lines.slice(end + 1).join('\n').replace(/^\n/, '');
  return { frontmatter, body };
}

function parseFrontmatterLines(lines: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const itemMatch = /^(\s*)-\s(.*)$/.exec(raw);
    if (itemMatch && currentArrayKey !== null) {
      (out[currentArrayKey] as unknown[]).push(parseScalar(itemMatch[2].trim()));
      continue;
    }

    const kvMatch = /^([A-Za-z0-9_.-]+):(.*)$/.exec(line.trim());
    if (!kvMatch) {
      currentArrayKey = null;
      continue;
    }
    const key = kvMatch[1];
    const rest = kvMatch[2].trim();
    if (rest === '') {
      out[key] = [];
      currentArrayKey = key;
    } else {
      out[key] = parseScalar(rest);
      currentArrayKey = null;
    }
  }

  return out;
}

/** 스칼라 한 값을 number/boolean/문자열로 판별한다. */
export function parseScalar(text: string): unknown {
  const t = text.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null' || t === '~') return null;
  if (/^[+-]?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

/** 스칼라 한 값을 frontmatter 한 줄로 직렬화한다. */
export function formatScalar(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value !== 'string') {
    return String(value);
  }
  return needsQuoting(value) ? JSON.stringify(value) : value;
}

function needsQuoting(s: string): boolean {
  if (s === '') return true;
  if (/^\s|\s$/.test(s)) return true;
  // 행 기반 파서(첫 `:` 뒤 나머지 전체를 값으로 읽음)와 구 writer(formatNote 무인용)에 맞춤.
  // `:`, `#`, `|`는 인용하지 않는다 — 기존 118개 파일이 이미 그 형태로 존재한다.
  if (/[\n\r]/.test(s)) return true;
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return true;
  if (s === 'true' || s === 'false' || s === 'null' || s === '~') return true;
  if (/^['"]/.test(s)) return true;
  return false;
}

/** frontmatter 객체를 `key: value` / 배열 블록 형태로 직렬화한다. */
export function formatFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${formatScalar(item)}`);
      }
    } else {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
  }
  return `---\n${lines.join('\n')}\n---\n`;
}
