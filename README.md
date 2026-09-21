<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
    <img src="assets/logo-light.png" alt="QuestTail logo — black Yorkshire Terrier-like dog face silhouette" width="180">
  </picture>
</p>

# QuestTail — 제출 스냅샷

> 리뷰어는 [SUBMISSION.md](./SUBMISSION.md)부터 보십시오. 이 비공개 스냅샷의 데모 실행 경로, 범위, 한계를 정의합니다.

이 스냅샷의 유일한 검토 대상은 **50건 합성 코퍼스** 위의 `packages/collie` 그래프 검색 데모입니다. 저장소의 다른 것은 검토 대상이 아닙니다.

## 재현 (3분)

```bash
pnpm install --frozen-lockfile
pnpm -r build
node packages/cli/dist/cli.js collie serve --demo --port 4173
```

다른 터미널에서:

```bash
# 긍정 — 합성 코퍼스에 대한 결정적 검색
node packages/cli/dist/cli.js collie ask "Lumen Reach 1과 같은 탐험 게임이 있어?" --mode demo --port 4173
```

브라우저는 `http://127.0.0.1:4173`에서 엽니다. 페이지와 CLI 모두 실제 `POST /ask` SSE 경로(`step{node,level}*` → `result{mode, trace}`)를 사용합니다.

재현 가능한 나머지 두 결과:

```bash
# 보류(응답 거부) — 합성 코퍼스에 근거가 없는 질문은 종료 코드 2로 끝납니다
node packages/cli/dist/cli.js collie ask "엘든 링 만든 데서 낸 다른 게임 있어?" --mode demo --port 4173

# 모드 불일치 — --demo 서버에 --mode real로 물으면 HTTP 409로 거부됩니다
node packages/cli/dist/cli.js collie ask "Lumen Reach 1과 같은 탐험 게임이 있어?" --mode real --port 4173
```

## 데모 내용

- `serve --demo`는 합성 문서 50건으로 임시 코퍼스와 그래프를 만들어 루프백(`127.0.0.1`, 기본 포트 `4173`)에서 서빙합니다. 캐시, Steam 계정, 개인 라이브러리를 읽지 않습니다.
- 화면은 왼쪽 채팅·오른쪽 사이드 패널의 2열 구조입니다. 사이드 패널의 `그래프 뷰` 탭은 코퍼스 전체 그래프를 상시 보여주고 질의의 선택 경로를 그 위에 강조합니다. 간선은 관계 타입별 색에 타입 문자열이 붙고, 범례는 응답에 실제로 있는 타입만 표시합니다. `합성 게임 리스트` 탭 항목을 누르면 그래프 뷰로 전환되며 해당 노드가 선택됩니다. 화면에 평가셋 모달은 없습니다(서버 `GET /eval/questions`는 그대로 있습니다).
- 서버는 `GET /corpus`로 문서 목록(`id`·`title`·`developers`·`publishers`·`tags`)과 그래프 전체(`nodes`·`edges`)를 JSON으로 돌려줍니다(`mode`는 `real`·`demo`·`unspecified`). demo 실측 기준 문서 50건·노드 72개(game 50·developer 14·publisher 5·tag 3)·간선 122개(DEVELOPED_BY 50·HAS_TAG 38·PUBLISHED_BY 34)입니다.
- 주의: `GET /corpus`는 인증 없이 코퍼스 메타데이터 전체를 내보냅니다. 서버가 루프백 바인드라 외부 접근은 안 되고, real 코퍼스는 이 저장소에 없어 리뷰어 환경에 애초에 없습니다.
- 웹 빌드 산출물은 다중 파일입니다(`packages/collie/public` 아래 `index.html` + `assets/` JS·CSS). 서버가 이 디렉터리를 정적으로 서빙합니다.
- 데모는 결정적 검색입니다. 선택 경로와 원문 근거 span을 항상 보여줍니다. 생성 답변 문장은 서버에 LLM 키가 있을 때만 나오고(LLM 키 항목 참조), 키가 없으면 생성 답변이 나오지 않습니다.
- `--demo` 서버는 `--mode real` 요청을 HTTP 409로 거부합니다.

## LLM 키

- 서버는 실행한 디렉터리의 `.env`에서 `QUESTAIL_LLM_BASE_URL` / `QUESTAIL_LLM_MODEL` / `QUESTAIL_LLM_API_KEY`를 읽습니다(없으면 `~/.config/questail/.env`로 폴백). 우선순위는 요청 키 > `process.env` > `.env` > `~/.config/questail/.env`이므로, 컨테이너와 CI에서는 파일 대신 같은 세 변수를 환경변수로 주입할 수 있습니다. 데모가 `.env`를 만들지 않습니다.
- 브라우저는 키를 보내지 않습니다. `POST /ask` 본문은 `{question, mode}`뿐입니다. 키는 서버의 `.env`에만 있고 브라우저에 두지 않습니다. 제공자 호출이 있다면 서버 측에서만 일어납니다.

생성 답변을 켜려면:

```bash
cp .env.example .env
# .env에서 제공자 세트 하나를 골라(로컬 Ollama 또는 외부) 채웁니다
node packages/cli/dist/cli.js collie serve --demo --port 4173
```

키가 없어도 검색과 그래프 선택 경로는 그대로 동작합니다. 생성 답변 문장만 빠집니다(경로와 원문 근거만 반환). 키, 베이스 URL, 모델은 같은 제공자의 것이어야 합니다. 어긋난 조합이면 생성 답변이 나오지 않고 검색 결과만 나옵니다.

## 검증

```bash
pnpm test
pnpm release:check
```

`pnpm test`는 전체 테스트를 돌립니다(`packages/*/src` 하위 `*.test.ts`를 `node --test --import tsx`로 실행).
`pnpm release:check`는 빌드 → 타입체크 → 세 패키지 tarball dry-run → 고정 회귀 베이스라인(`pnpm eval`: 26/27, C2-05 한 건)을 확인합니다.

`pnpm eval`이 exit 1로 끝나는 것은 의도된 동작입니다. 기대 베이스라인은 26/27이며 C2-05 한 건만 틀립니다. C2-05는 알려진 의도적 미해결 케이스입니다(기대 `find_rating_playtime_gaps+search_docs` 대비 실제 `get_game_note+lookup_library+get_wishlist+search_docs`). 회귀가 아니며, `pnpm eval:baseline`이 정확히 이 상태를 검증합니다.

## 범위 밖 (이번 스냅샷에서 검토하지 않음)

- 개인 Steam 라이브러리, 실제 Steam 데이터 수집(`sniff` / `gather` / `analyze` 흐름), 구 제품 문서.
- `core` 에이전트 도구 실행, 실제 코퍼스 질의, 생성 답변 검증.
- Pages 배포, npm 배포, 모든 `core verify` 주장.
- `packages/collie/REPORT.md` 4~6절은 중단된 실제 코퍼스 실험의 기록이며, 현재 데모 명세가 아닙니다.

## 문서

- [`SUBMISSION.md`](./SUBMISSION.md): 재현 절차, 범위, 안전 경계.
- [`packages/collie/README.md`](./packages/collie/README.md): 데모 실행과 패키지 범위.
- [`packages/collie/REPORT.md`](./packages/collie/REPORT.md): 설계·실험 기록(읽기 전용 참조).

## 라이선스

MIT
