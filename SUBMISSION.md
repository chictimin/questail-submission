# QuestTail collie — 제출 안내

이 저장소는 QuestTail의 공개 main을 건드리지 않고 만든 **비공개 제출 스냅샷**입니다. 검토 대상은 `packages/collie`의 합성 코퍼스(50건) 기반 그래프 검색 demo 하나뿐입니다.

## 3분 재현

```bash
pnpm install --frozen-lockfile
pnpm -r build
node packages/cli/dist/cli.js collie serve --demo --port 4173
```

다른 터미널에서 다음을 실행합니다.

```bash
# 긍정 — 합성 코퍼스 안에서 경로+근거를 찾습니다 (종료 코드 0)
node packages/cli/dist/cli.js collie ask "Lumen Reach 1과 같은 탐험 게임이 있어?" --mode demo --port 4173
```

브라우저는 `http://127.0.0.1:4173`에서 엽니다. 기본 화면과 CLI는 모두 실제 `POST /ask` SSE 경로(`step{node,level}*` → `result{mode, trace}`)를 사용합니다.

나머지 두 가지 재현 결과:

```bash
# 보류 — 합성 코퍼스에 없는 게임으로 물으면 근거 부족으로 보류합니다 (종료 코드 2)
node packages/cli/dist/cli.js collie ask "엘든 링 만든 데서 낸 다른 게임 있어?" --mode demo --port 4173

# mode mismatch — --demo 서버에 --mode real로 물으면 HTTP 409로 거부됩니다 (종료 코드 1)
node packages/cli/dist/cli.js collie ask "Lumen Reach 1과 같은 탐험 게임이 있어?" --mode real --port 4173
```

## 범위와 안전 경계

- `--demo`는 저장소의 합성 문서 50건만 임시 corpus·graph로 만들어 사용합니다. 캐시·Steam 계정·개인 라이브러리가 필요 없고 읽히지도 않습니다.
- demo 서버는 `--mode real` 요청을 HTTP 409으로 거부합니다.
- demo는 선택 경로와 원문 근거를 항상 표시합니다. 생성 답변 문장은 서버에 LLM 키가 있을 때만 나오고, 키가 없으면 나오지 않습니다.
- 서버는 실행한 디렉터리의 `.env`에서 `QUESTAIL_LLM_BASE_URL`·`QUESTAIL_LLM_MODEL`·`QUESTAIL_LLM_API_KEY`를 읽습니다 (없으면 `~/.config/questail/.env`로 폴백). 데모 실행이 `.env`를 만들지 않습니다.
- 생성 답변을 보려면 `.env.example`을 `.env`로 복사해 키를 채운 뒤 serve를 띄우면 됩니다. 키·BASE_URL·모델명은 같은 제공자를 가리켜야 하며, 어긋나면 생성 답변이 나오지 않고 검색 결과만 나옵니다. 키가 없어도 검색과 그래프 경로는 그대로 동작하고 생성 답변 문장만 나오지 않습니다(경로와 원문 근거만 반환).
- 키는 브라우저로 전송되지 않습니다. 브라우저의 `POST /ask` 본문은 `{question, mode}`뿐이고, 키는 서버가 `.env`에서 읽습니다. provider 호출은 서버 측에서만 일어납니다.
- 개인 `games/`, `.cache/`, `packages/collie/output/`은 이 저장소에 포함되지 않습니다.
- core agent 도구 실행, 개인 real 코퍼스 질의, 생성 답변 검증은 이 제출 demo의 범위 밖입니다.
- 실존 Steam 데이터 수집(`sniff`/`gather`/`analyze`), 개인 라이브러리 주장, Pages 배포, npm 배포, 동작하지 않는 core verify 주장은 제출 범위 밖이며 본 문서에서 주장하지 않습니다.

## 화면과 API

- 화면은 왼쪽 채팅·오른쪽 사이드 패널의 2열 구조입니다. 사이드 패널은 `그래프 뷰`와 `합성 게임 리스트` 두 탭입니다.
- 그래프 뷰는 코퍼스 전체 그래프를 상시 보여주고, 질의를 하면 그 질의의 선택 경로를 전체 그래프 위에 강조합니다. 간선은 관계 타입별로 색이 다르며 간선 위에 타입 문자열이 붙습니다. 범례는 응답에 실제로 존재하는 타입만 표시합니다.
- 합성 게임 리스트 항목을 클릭하면 그래프 뷰 탭으로 전환되며 해당 노드가 선택됩니다.
- 화면에 평가셋 모달은 없습니다. 서버의 `GET /eval/questions` 엔드포인트는 그대로 남아 있지만, 화면에서 평가셋을 고르는 UI는 제공하지 않습니다.
- `GET /corpus`가 새로 생겼습니다. 코퍼스 문서 목록(`id`·`title`·`developers`·`publishers`·`tags`)과 그래프 전체(`nodes`·`edges`)를 JSON으로 돌려줍니다. `mode` 값은 `real`·`demo`·`unspecified` 세 가지입니다. demo 실측 기준 문서 50건·노드 72개(game 50·developer 14·publisher 5·tag 3)·간선 122개(DEVELOPED_BY 50·HAS_TAG 38·PUBLISHED_BY 34)입니다.
- 정적 자산 서빙이 새로 들어갔습니다. 서버는 `packages/collie/public` 디렉터리(`index.html` + `assets/` JS·CSS, 다중 파일 산출물)를 서빙하며 경로 탈출(`..` 계열)은 404로 막습니다.
- 주의: `GET /corpus`는 인증 없이 코퍼스 메타데이터 전체를 내보냅니다. 서버가 루프백(`127.0.0.1`)에만 바인드되어 외부에서는 접근할 수 없고, real 코퍼스는 이 저장소에 포함되지 않는 개인 데이터라 리뷰어 환경에는 애초에 없습니다.

## 검증

```bash
pnpm test
pnpm release:check
```

`pnpm test`는 전체 테스트(`packages/*/src` 하위 `*.test.ts`를 `node --test --import tsx`로 실행)를 돌립니다.
이 명령은 build, typecheck, 세 패키지 tarball dry-run과 고정 회귀 기준선(`pnpm eval`: 26/27, C2-05 한 건)을 확인합니다.

`pnpm eval`이 exit 1로 끝나는 것은 정상입니다. 기대 베이스라인은 26/27이며 C2-05 한 건만 틀립니다. C2-05는 의도적 미해결 케이스입니다(기대 `find_rating_playtime_gaps+search_docs` 대비 실제 `get_game_note+lookup_library+get_wishlist+search_docs`). 회귀가 아니며, `pnpm eval:baseline`이 정확히 이 상태를 검증합니다.

## 알려진 한계

- demo 모드에서 LLM이 그래프 간선 종류를 바꿔 말하는 결함이 실측으로 확인됐다. 검색 경로는 publisher(PUBLISHED_BY) 관계였는데 생성 답변이 developer 관계로 바꿔 말했다. 이번 변경은 생성 프롬프트에 간선 타입을 명시 주입하고 관계 날조를 금지하는 제약 문장을 넣었으며, 간선 타입 전달이 빠지면 실패하는 결정적 회귀 테스트로 고정했다. 오늘 실서버(.env를 OpenAI로 정합, 모델 gpt-4o)에서 publisher 경로 질의 2종을 각 3회씩 총 6회 던졌고, 답변 6건 전부 퍼블리싱 관계를 정확히 서술했으며 developer로 바꿔 말한 이탈은 0건이었다. 단, 원래 결함과 가장 가까운 문형인 같은 퍼블리셔를 묻는 2홉 질의에서는 검색이 publisher 경로가 아니라 developer 경로를 택해 답변이 알 수 없습니다로 거절됐고(4회 시도 모두), 날조 없이 거절한 것이므로 결함은 아니지만 원 결함 시나리오 자체를 재현해 통과한 것은 아니다. 또한 LLM 출력은 확률적이라 6회 통과가 영구 보장은 아니다. 프롬프트 제약과 회귀 테스트로 고정했으나, 근거 이탈이 해결됐다고 보지 않는다.
- 리뷰어 확인법: 서버 실행 디렉터리의 `.env`에 `QUESTAIL_LLM_API_KEY` 등(`QUESTAIL_LLM_BASE_URL`·`QUESTAIL_LLM_MODEL`)을 넣고 demo 서버에 publisher 관계 질문을 ask해 `result.answer`가 published로 말하는지 보면 된다.
- 브라우저 렌더 검증 공백(2026-09-21 현재): 초기 화면(2열 배치·전체 그래프·범례·게임 50건 리스트)은 헤드리스 Chrome 스크린샷과 DOM으로 확인했으나, 질의 후 경로 강조·게임 리스트 탭 전환·항목 클릭 시 노드 선택 같은 상호작용 상태는 조작 드라이버가 없어 코드 수준까지만 확인했다. cytoscape 초기화가 실패하면 화면 상태 영역에 이유가 표시되도록 되어 있다. 직접 화면 확인 후 이 항목은 지운다.

## 읽을 문서

- [`packages/collie/README.md`](./packages/collie/README.md): demo 실행과 패키지 범위
- [`packages/collie/REPORT.md`](./packages/collie/REPORT.md): 설계·실험 기록. 4~6절은 중단된 real-corpus 실험 기록이며 현재 demo 명세가 아닙니다.
