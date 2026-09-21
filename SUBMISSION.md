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
- 생성 답변을 보려면 `.env.example`을 `.env`로 복사해 키를 채운 뒤 serve를 띄우면 됩니다. 키가 없어도 검색과 그래프 경로는 그대로 동작하고 생성 답변 문장만 나오지 않습니다(경로와 원문 근거만 반환).
- 키는 브라우저로 전송되지 않습니다. 브라우저의 `POST /ask` 본문은 `{question, mode}`뿐이고, 키는 서버가 `.env`에서 읽습니다. provider 호출은 서버 측에서만 일어납니다.
- 개인 `games/`, `.cache/`, `packages/collie/output/`은 이 저장소에 포함되지 않습니다.
- core agent 도구 실행, 개인 real 코퍼스 질의, 생성 답변 검증은 이 제출 demo의 범위 밖입니다.
- 실존 Steam 데이터 수집(`sniff`/`gather`/`analyze`), 개인 라이브러리 주장, Pages 배포, npm 배포, 동작하지 않는 core verify 주장은 제출 범위 밖이며 본 문서에서 주장하지 않습니다.

## 검증

```bash
pnpm test
pnpm release:check
```

`pnpm test`는 전체 테스트(`packages/*/src` 하위 `*.test.ts`를 `node --test --import tsx`로 실행)를 돌립니다.
이 명령은 build, typecheck, 세 패키지 tarball dry-run과 고정 회귀 기준선(`pnpm eval`: 26/27, C2-05 한 건)을 확인합니다.

`pnpm eval`이 exit 1로 끝나는 것은 정상입니다. 기대 베이스라인은 26/27이며 C2-05 한 건만 틀립니다. C2-05는 의도적 미해결 케이스입니다(기대 `find_rating_playtime_gaps+search_docs` 대비 실제 `get_game_note+lookup_library+get_wishlist+search_docs`). 회귀가 아니며, `pnpm eval:baseline`이 정확히 이 상태를 검증합니다.

## 알려진 한계

- demo 모드에서 LLM이 그래프 간선 종류를 바꿔 말하는 결함이 실측으로 확인됐다. 검색 경로는 publisher(PUBLISHED_BY) 관계였는데 생성 답변이 developer 관계로 바꿔 말했다. 이번 변경은 생성 프롬프트에 간선 타입을 명시 주입하고 관계 날조를 금지하는 제약 문장을 넣었으며, 간선 타입 전달이 빠지면 실패하는 결정적 회귀 테스트로 고정했다. 그러나 체계적인 라이브 검증은 미실시입니다. 키는 투입됐으나 LLM 엔드포인트가 404를 반환해 생성 호출이 차단됐습니다. 키 투입 직후 단 1회 성공한 생성에서는 publisher 관계를 정확히 말했으나 재현되지 않아 표본 1건의 관찰일 뿐입니다. 고쳐졌다고 보지 않습니다.
- 리뷰어 확인법: 서버 실행 디렉터리의 `.env`에 `QUESTAIL_LLM_API_KEY` 등(`QUESTAIL_LLM_BASE_URL`·`QUESTAIL_LLM_MODEL`)을 넣고 demo 서버에 publisher 관계 질문을 ask해 `result.answer`가 published로 말하는지 보면 된다.

## 읽을 문서

- [`packages/collie/README.md`](./packages/collie/README.md): demo 실행과 패키지 범위
- [`packages/collie/REPORT.md`](./packages/collie/REPORT.md): 설계·실험 기록. 4~6절은 중단된 real-corpus 실험 기록이며 현재 demo 명세가 아닙니다.
