# tools/eval — 에이전트 회귀 하네스 + 픽스처

## 이 데이터가 무엇인지

`questail-collie`(아이펠 과제 제출용, 동결 `20eb941`)에서 가져온 평가 자산이다.
collie의 도구 9종·결정적 라우터·근거 검증을 `packages/core/src/agent/`으로 이식한 뒤,
이식이 동작을 바꾸지 않았음을 증명하는 회귀 증거다.

| 파일 | 내용 |
|---|---|
| `loader.ts` | 픽스처를 `AgentDeps`로 조립 (LLM·네트워크 없음) |
| `dryrun.ts` | 오프라인 드라이런. `classify_cache.json`에서 분류 결과를 복원해 `routeQuestion`만 잰다 |
| `score.ts` | 채점 규칙. 순서 무시 집합 비교, 정확히 일치만 1점 |
| `data/eval_set.csv` | 평가 문항 30건 (fewshot 제외 27건이 채점 대상) |
| `data/classify_cache.json` | 문항별 분류 결과 캐시 30건. 캐시 재생성 수단 없음 — 질문이 바뀌면 보고한다 |
| `data/mock/` | 게임 노트·`library.md`·`taste-profile.json` (합성 데이터, 출처는 `META.md`) |
| `docs/` | 정책 산문 3종 + 청크 매핑표 `_mapping.md` |

## 왜 저장소에 있는지

이 픽스처는 ko 전용 스펙의 실행 가능한 근거다. 에이전트 계층
(`packages/core/src/agent/`, 결정적 도구 라우터)은 **한국어 질의 전용**이다.
규칙 조건이 한국어 키워드 substring 매칭이라 영어 질문은 에러 없이 조용히
나빠진다 — 방향어 부재 시 순위 조회 탈락, 필드명 부재 시 `search_docs`
폴백, 가격 키워드 불일치 시 `escalate` 직행. 픽스처를 치우면 이 ko-only라는
사실이 테스트 공백 속에 숨는다. 남겨야 스펙으로 박힌다.

## 왜 한국어인지 (실측)

- 평가 문항 30건 중 비한글 질문 0건, 분류 캐시 30건 중 비한글 0건.
- `router.ts` 319줄 중 한글 포함 74줄. 분기 조건이 한국어 키워드다.
- 영어 지원 선언·구현이 먼저 오기 전에는 EN 픽스처가 의미를 가지지 않는다.
  EN 지원을 추가한다면 EN 픽스처 구축이 선행 조건이다.

## 재현 방법

```bash
pnpm eval
```

기대값: 총점 **26/27**, 틀린 문항 `C2-05` 하나. 이 숫자가 collie 동결
시점([questail-collie@20eb941](https://github.com/chictimin/questail-collie/tree/20eb941))의 정본과 같다. `C2-05`까지 맞추려 하지
마라 — 동결값과 같은 것이 통과 조건이다.
