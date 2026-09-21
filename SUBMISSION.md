# QuestTail collie — 제출 안내

이 저장소는 QuestTail의 공개 main을 건드리지 않고 만든 **비공개 제출 스냅샷**입니다. 검토 대상은 `packages/collie`의 합성 코퍼스 기반 그래프 검색 demo입니다.

## 3분 재현

```bash
pnpm install --frozen-lockfile
pnpm -r build
node packages/cli/dist/cli.js collie serve --demo --port 4173
```

다른 터미널에서 다음을 실행합니다.

```bash
node packages/cli/dist/cli.js collie ask "Lumen Reach 1과 같은 탐험 게임이 있어?" --mode demo --port 4173
```

브라우저는 `http://127.0.0.1:4173`에서 엽니다. 기본 화면과 CLI는 모두 실제 `POST /ask` SSE 경로를 사용합니다.

## 범위와 안전 경계

- `--demo`는 저장소의 합성 문서 50건만 임시 corpus·graph로 만들어 사용합니다.
- demo 서버는 `--mode real` 요청을 HTTP 409으로 거부합니다.
- demo는 LLM 생성 답변을 내지 않습니다. 선택 경로와 원문 근거만 표시합니다.
- 개인 `games/`, `.cache/`, `packages/collie/output/`은 이 저장소에 포함되지 않습니다.
- core agent 도구 실행, 개인 real 코퍼스 질의, 생성 답변 검증은 이 제출 demo의 범위 밖입니다.

## 검증

```bash
pnpm release:check
```

이 명령은 build, typecheck, 세 패키지 tarball dry-run과 고정 회귀 기준선(`pnpm eval`: 26/27, C2-05 한 건)을 확인합니다.

## 읽을 문서

- [`packages/collie/README.md`](./packages/collie/README.md): demo 실행과 패키지 범위
- [`packages/collie/REPORT.md`](./packages/collie/REPORT.md): 설계·실험 기록. 4~6절은 중단된 real-corpus 실험 기록이며 현재 demo 명세가 아닙니다.
