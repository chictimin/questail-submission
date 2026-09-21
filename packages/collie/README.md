# @questail/collie

QuestTail 라이브러리를 **지식 그래프**로 만들고, 여러 게임을 건너뛰며 답하는 질의응답 에이전트.

> 이 앱은 **보유한 게임 안에서만** 답한다. Steam 전체 DB가 아니다.
> "발더스게이트 만든 데서 낸 다른 게임"의 답은 Larian 전 작품이 아니라 **내가 가진 Larian 작품**이다.

## 무엇을 하나

```
문서 여러 건 → 추출 → 정제·병합 → 지식 그래프
질문 → 시작 개체 → n홉 확장 → 근거만으로 답변 + 경로 제시
      끊기면 넓히고, 그래도 없으면 모른다고 말하기
```

답만 주지 않는다. **어떻게 도달했는지**와 **못 찾았으면 무엇을 시도했는지**를 같이 보여준다.

## 그래프

| | 무엇에서 | LLM |
|---|---|---|
| `HAS_TAG`(votes·rank) · `DEVELOPED_BY` · `PUBLISHED_BY` | frontmatter — Steam·SteamSpy 응답 | 쓰지 않음 |
| `IN_SERIES` · `SEQUEL_OF` · `SAME_UNIVERSE` | `about_the_game` 본문, 원문 span 검증 | 사용 |

장르·플랫폼·`categories`는 **속성**이지 확장 간선이 아니다. `가족 공유`가 94%라 다리로 쓰면 아무 데나 연결된다.

**frontmatter를 LLM 프롬프트에 넣지 않는다.** 넣으면 "본문에서 추출했다"가 거짓이 된다.

## 실행

### 처음 한 번 — 저장소 루트에서

pnpm 워크스페이스 명령이라 **저장소 루트에서 실행해야 한다.**

```bash
cd /path/to/questail
pnpm install
pnpm -r build            # core → collie → cli 순서로 빌드된다
```

빌드 전에 `pnpm typecheck` 를 먼저 돌리면 깨진다. `cli` 가 `core` 의 dist 타입을 필요로 하기 때문이다. `pnpm release:check` 가 올바른 순서(build → typecheck → pack → eval)를 담고 있다.

### 이후 — 어디서든

`questail` 은 전역 명령이고, **입력 경로를 현재 디렉터리가 아니라 패키지 위치 기준으로 찾는다.** 그래서 어느 디렉터리에서 실행해도 같은 결과가 나온다.

```bash
# 공개 데모: 합성 50건을 임시 생성해 개인 데이터 없이 실행
questail collie serve --demo
questail collie ask "Lumen Reach 1과 같은 탐험 게임이 있어?" --mode demo
```

출력은 저장소의 `packages/collie/output/` 아래에 쌓인다(gitignore 대상). 어디서 실행하든 그곳에 쓴다. `--output-root` 로 바꿀 수 있다.

> **전역 설치(`npm i -g`)로 쓸 때는 다르다.** 패키지가 저장소 밖에 놓이면 `.cache` 를 찾지 못하므로 `--cache-root` 를 직접 줘야 한다. 워크스페이스에서 링크해 쓰는 지금은 필요 없다.

### 언어 — 지금은 한국어 질의 기준이다

**질의는 한국어를 전제로 만들어져 있다.** 다국어 지원은 예정돼 있지만 아직이다.

| | 지금 | |
|---|---|---|
| 질문 | **한국어** | 질의 분류와 도구 선택이 한국어 문자열 매칭에 묶여 있다 |
| 답변·화면 | **한국어** | |
| 코퍼스 본문 | **영어** | Steam `about_the_game` 원문. 관계 추출도 이 원문에서 한다 |
| 노드 정본 | **영어** | 장르·개발사·태그를 영문으로 저장하고 표시 계층에서 한국어를 입힌다 |

데이터를 영어로 두고 표시에서 번역하는 것은 상위 프로젝트의 결정이다(PRD `D9`). Steam 은 영어가 원본이고 각 로케일은 파생 번역이라, 한국어를 정본에 박으면 영어 리포트에 한국어 장르가 나가고 되돌릴 수 없다.

**영어 질의는 실패하지 않고 조용히 나빠진다.** 예외를 던지지 않고 엉뚱한 도구를 고르기 때문에 겉으로는 답이 나온다. 그래서 지금은 한국어로 물어야 한다. 영어 질의 지원은 별도 마일스톤(M2.5c)으로 잡혀 있고, 평가셋 12문항도 전부 한국어다.

## 데이터 없이 돌려보기

공개 데모는 합성 코퍼스 50건만 사용한다. `serve --demo`가 임시 corpus와 graph를 만들므로 **캐시·Steam 계정·개인 라이브러리가 필요 없고 읽히지도 않는다.** 서버는 요청 mode와 자신이 연 코퍼스가 다르면 거부한다.

```bash
questail collie serve --demo
```

데모는 선택 경로와 원문 근거를 표시하는 결정적 검색 데모다. LLM 생성 답변은 데모에서 의도적으로 끈다. 개인 real 코퍼스·core agent 도구·생성 답변 검증은 이 공개 데모 릴리즈 범위가 아니다.

### LLM 설정

`questail sniff` 로 저장한다(`QUESTAIL_LLM_BASE_URL`·`QUESTAIL_LLM_MODEL`·`QUESTAIL_LLM_API_KEY`). 현재 웹 UI의 provider 입력은 비활성이다. 공개 demo는 LLM 생성 답변을 사용하지 않는다.

관계 추출(`build`)에만 LLM 이 필요하다. `prepare` 와 결정적 그래프는 LLM 없이 돈다.

## 데이터

**저장소에 개인 코퍼스를 커밋하지 않는다.** 수집 스크립트와 manifest, 합성 demo 코퍼스, 평가셋만 들어 있다. 그래프 출력·추출 캐시·실행 추적은 `output/` 아래이고 gitignore 대상이다.

## 문서

| | |
|---|---|
| `REPORT.md` | 주제·코퍼스·스키마·측정·회고 |
| `config/default.json` | 노드·관계·허브 컷오프·L0~L4 사다리. 코드에 박지 않는다 |
| `demo-corpus/relations.gold.json` | 관계 골든셋 21건 (정답 12 · 함정 9) |
| `eval/questions.draft.md` | 평가셋 12문항 |

## 라이선스

MIT
