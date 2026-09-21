# @questail/collie — 합성 50건 그래프 검색 데모

합성 코퍼스 50건 위에서 동작하는 **결정적 그래프 검색 데모**다. 선택 경로와 원문 근거 span만 표시하고, LLM 생성 답변은 의도적으로 내지 않는다.

> 이 패키지의 제출 범위는 공개 데모뿐이다. 개인 real 코퍼스·core agent 도구 실행·생성 답변 검증은 범위 밖이다.

## 실행

저장소 루트에서 빌드한다 (`cli`가 `core`의 dist 타입을 필요로 하므로 `typecheck`보다 `build`가 먼저다. `pnpm release:check`가 올바른 순서를 담고 있다):

```bash
pnpm install --frozen-lockfile
pnpm -r build
node packages/cli/dist/cli.js collie serve --demo --port 4173
```

서버는 `127.0.0.1`에만 바인드한다 (기본 포트 `4173`, `--port`·`COLLIE_PORT`로 변경 가능). `serve --demo`는 합성 50건을 임시 디렉터리에 준비·build해 서빙하므로 캐시·Steam 계정·개인 라이브러리가 필요 없고 읽히지도 않는다.

## 화면

브라우저 화면은 왼쪽 채팅·오른쪽 사이드 패널의 2열 구조다. 사이드 패널은 탭 두 개다. `그래프 뷰`와 `합성 게임 리스트`다.

- 그래프 뷰는 코퍼스 전체 그래프를 상시 보여준다. 질의를 하면 그 질의의 선택 경로가 전체 그래프 위에 강조되고 나머지는 흐리게 표시된다.
- 간선은 관계 타입별로 색이 다르며 간선 위에 타입 문자열이 표시된다. 범례는 응답에 실제로 존재하는 타입만 나열한다.
- 합성 게임 리스트 항목을 클릭하면 그래프 뷰 탭으로 전환되며 해당 게임 노드가 선택된다.
- 화면에 평가셋 모달은 없다. 서버의 `GET /eval/questions`는 그대로 남아 있지만, 화면에서 평가셋을 고르는 UI는 제공하지 않는다.
- demo 실측 기준 문서 50건·노드 72개(game 50·developer 14·publisher 5·tag 3)·간선 122개(DEVELOPED_BY 50·HAS_TAG 38·PUBLISHED_BY 34)다.

## 웹 UI 빌드 산출물

빌드 산출물은 일반적인 다중 파일 구성이다. `packages/collie/public` 아래에 `index.html`과 별도의 JS·CSS 자산(`assets/*.js`, `assets/*.css`)이 나온다. 서버는 이 디렉터리를 정적으로 서빙한다(`/`는 `index.html`, `/assets/*`는 빌드 자산).

`public/` 아래 생성물은 직접 편집하지 않는다. `web/` 소스(Vite + vanilla TypeScript + Cytoscape.js, CDN 없음)를 고친 뒤 아래 명령으로 다시 생성한다:

```bash
pnpm --filter @questail/collie web:build
```

빌드 없이 clone한 리뷰어가 `serve`를 바로 띄워도 동작하도록 생성물을 커밋한다. 빌드는 `assets/`만 지우고 다시 만든다(`public/fixtures/`는 지우지 않는다).

## 서버: GET /corpus와 정적 서빙

- `GET /corpus`는 코퍼스 문서 목록과 그래프 전체를 JSON으로 돌려준다. 문서 필드는 `id`·`title`·`developers`·`publishers`·`tags`다. 그래프는 `nodes`(노드 `id`·`kind`·`label`)와 `edges`(간선 `type`·`from`·`to`·`verified`)다. `mode` 값은 `real`·`demo`·`unspecified` 세 가지다(`--demo` 서버에서는 `demo`).
- 정적 자산 서빙이 들어 있다. `public/` 디렉터리를 그대로 서빙하며, 명시 라우트(`/`·`/fixtures/*`·`/eval/questions`·`/ask`·`/stream/ask`)가 우선한다. 경로 탈출(`..` 계열, 인코딩 변형 포함)은 404로 막는다.
- 주의: `GET /corpus`는 인증 없이 코퍼스 메타데이터 전체를 내보낸다. 다만 서버는 루프백(`127.0.0.1`)에만 바인드되어 외부에서 접근할 수 없고, real 코퍼스는 이 저장소에 포함되지 않는 개인 데이터라 리뷰어 환경에 애초에 없다.
- 간선의 `verified`는 관계 추출로 검증된 목록에 적중했는지를 뜻한다. demo에는 프론트매터 기반 결정적 간선만 있어 전부 `false`로 나간다(실측 122건 전부). 정본 메타데이터의 문제가 아니라 검증 목록에 해당 키가 없다는 뜻이며, 화면도 이 이유로 검증 관련 표기를 내지 않는다.

## 재현 3종 (브라우저·CLI)

브라우저는 `http://127.0.0.1:4173`에서 열고, CLI는 같은 `POST /ask` SSE 경로(`step{node,level}*` → `result{mode, trace}`)를 때린다.

```bash
# 1. 긍정 — 합성 코퍼스 안에서 경로+근거를 찾는다 (종료 코드 0)
node packages/cli/dist/cli.js collie ask "Lumen Reach 1과 같은 탐험 게임이 있어?" --mode demo --port 4173

# 2. 보류 — 합성 코퍼스에 없는 게임으로 물으면 근거 부족으로 보류한다 (종료 코드 2)
node packages/cli/dist/cli.js collie ask "엘든 링 만든 데서 낸 다른 게임 있어?" --mode demo --port 4173

# 3. mode mismatch — --demo 서버에 --mode real로 물으면 HTTP 409로 거부된다 (종료 코드 1)
node packages/cli/dist/cli.js collie ask "Lumen Reach 1과 같은 탐험 게임이 있어?" --mode real --port 4173
```

CLI 종료 코드: `0` 답변, `2` 보류(근거 부족), `1` 사용법·연결·서버 오류.

## LLM 설정과 키 경계

- 서버는 실행한 디렉터리의 `.env`에서 `QUESTAIL_LLM_BASE_URL`·`QUESTAIL_LLM_MODEL`·`QUESTAIL_LLM_API_KEY`를 읽는다 (없으면 `~/.config/questail/.env`로 폴백). 데모 실행이 `.env`를 만들지 않는다.
- 키는 브라우저로 전송되지 않는다. 브라우저의 `POST /ask` 본문은 `{question, mode}`뿐이고, 웹 UI의 provider 입력은 비활성이다. provider 호출은 서버 측에서만 난다.
- 공개 demo는 LLM 생성 답변을 사용하지 않는다. 관계 추출(`build`)에만 LLM이 필요하고, `prepare`와 결정적 그래프 검색은 LLM 없이 돈다.

## 검증

```bash
pnpm release:check
```

build → typecheck → 세 패키지 tarball dry-run → 고정 회귀 기준선(`pnpm eval`: 26/27, C2-05 한 건)을 확인한다.

## 데이터

저장소에 개인 코퍼스를 커밋하지 않는다. 합성 demo 코퍼스(`demo-corpus/` 50건 + `relations.gold.json` 관계 골든셋 21건)와 평가셋만 들어 있다. 그래프 출력·추출 캐시·실행 추적은 `output/` 아래이며 gitignore 대상이다.

## 범위 밖

- 개인 Steam 라이브러리(real 코퍼스) 질의와 실존 Steam 데이터 수집
- core agent 도구 실행과 생성 답변 검증
- Pages 배포·npm 배포·동작하지 않는 core verify 주장

## 문서

| | |
|---|---|
| `REPORT.md` | 설계·실험 기록. 4~6절은 중단된 real-corpus 실험 기록이며 현재 demo 명세가 아니다 |
| `config/default.json` | 노드·관계·허브 컷오프·L0~L4 사다리. 코드에 박지 않는다 |
| `demo-corpus/relations.gold.json` | 관계 골든셋 21건 (정답 12 · 함정 9) |
| `eval/questions.json` | 평가셋 12문항 |

## 라이선스

MIT
