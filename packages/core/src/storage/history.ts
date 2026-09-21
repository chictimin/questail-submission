/**
 * history.jsonl — gather 실행마다 남기는 시계열 로그 (D1-a).
 *
 * 정본(md 원칙)의 예외로 확정된 순수 append-only 로그 계층이다.
 * 파싱·중복 방지가 지저분해지지 않게 파일을 읽어 고치지 않으며,
 * 같은 호출 안에서 들어온 중복 레코드(ts·platform·gameId 동일)만 제거한다.
 * 한 줄 = HistoryRecord 한 개 (타입 정본: types.ts).
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HistoryRecord, NormalizedGame } from '../types.js';

export const HISTORY_FILENAME = 'history.jsonl';

/**
 * gather 1회 실행분을 HistoryRecord 배열로 만든다.
 * @param games  이번 실행에서 수집된 정규화 게임 목록
 * @param ts     실행 시각 (Unix ms, 기본 Date.now() — 테스트는 고정값 주입)
 */
export function buildHistoryRecords(games: NormalizedGame[], ts: number = Date.now()): HistoryRecord[] {
  return games.map(g => ({
    ts,
    gameId: g.id,
    platform: g.platform,
    playtimeMinutes: g.playtimeMinutes,
  }));
}

function recordKey(r: HistoryRecord): string {
  return `${r.ts}|${r.platform}|${r.gameId}`;
}

function isValidRecord(r: HistoryRecord): boolean {
  return (
    typeof r.ts === 'number' &&
    Number.isFinite(r.ts) &&
    typeof r.gameId === 'string' &&
    r.gameId !== '' &&
    typeof r.platform === 'string' &&
    typeof r.playtimeMinutes === 'number' &&
    Number.isFinite(r.playtimeMinutes)
  );
}

/**
 * HistoryRecord들을 파일에 append한다. 파일을 읽지 않으므로 기존 로그는 손대지 않는다.
 * 같은 호출 내 중복 키는 첫 건만 남긴다.
 */
export async function appendHistoryLog(filePath: string, records: HistoryRecord[]): Promise<void> {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const r of records) {
    if (!isValidRecord(r)) continue;
    const key = recordKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(JSON.stringify(r));
  }

  if (lines.length === 0) return;

  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, lines.join('\n') + '\n', 'utf-8');
}
