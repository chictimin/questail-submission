/**
 * Markdown 저장소 — 정규화된 게임 데이터를 md 파일로 직렬화
 *
 * 데이터 정본은 md 파일. DB 아님.
 * 볼트 호환 frontmatter 사용, 객관/주관 분리(source) 유지.
 *
 * - games/*.md  : 필드 단위 병합 (객관 덮어쓰기 + 주관 보존) — gameNote.ts
 * - library.md  : 객관 데이터 정본 1개 — library.ts
 * - history.jsonl: 시계열 append-only 로그 — history.ts
 */

export * from './frontmatter.js';
export * from './gameNote.js';
export * from './library.js';
export * from './history.js';
