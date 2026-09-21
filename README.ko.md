<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
    <img src="assets/logo-light.png" alt="QuestTail 로고 — 검은색 요크셔테리어풍 강아지 얼굴 실루엣" width="180">
  </picture>
</p>

# QuestTail (퀘스테일)

> [English](./README.md) · 한국어

> 여러 플랫폼(Steam/PSN/Xbox)에 흩어진 게임 이력을 모아 Markdown으로 아카이빙하고, LLM으로 개인 취향 분석을 받는 personal-first 도구.

**현재 단계: M2 (v0.3.0)** — Steam 라이브러리를 Markdown 파일로 추출하고 취향 분석 리포트를 만드는 CLI.

## 설치

```bash
git clone https://github.com/chictimin/questail.git
cd questail
pnpm install
pnpm build

# 전역 실행 (선택)
pnpm link --global
```

## `@questail/core` 라이브러리 사용

`@questail/core`는 아직 npm 레지스트리에 없습니다. GitHub Release에 첨부된 빌드 tarball을 URL로 설치합니다:

```bash
pnpm add https://github.com/chictimin/questail/releases/download/v0.3.0/questail-core-0.3.0.tgz
```

tarball에 빌드된 `dist/`가 들어 있어 소비자 측 빌드가 필요 없습니다. 업그레이드는 URL의 버전만 바꾸고 `pnpm install` 합니다. npm 배포 전까지는 git 태그가 버전의 정본입니다.

> 참고: 에이전트 계층(`packages/core/src/agent`, 결정적 도구 라우터)은 한국어 질의 전용입니다 — 영어 질문은 에러 없이 조용히 라우팅 품질이 떨어집니다(순위 탈락·스키마 폴백·escalate 직행). [tools/eval/README.md](./tools/eval/README.md)를 보세요.

## 사용법

```bash
# 1. API 키 + SteamID 등록 (최초 1회)
questail sniff

# 2. Steam 라이브러리 수집
questail gather steam

# 3. 취향 분석
questail analyze

# 4. 설정 관리
questail config set language en
questail config get steam-api-key
```

### 자세한 흐름

**`questail sniff`** — 대화형 설정입니다. Steam Web API 키와 SteamID를 한 번에 등록합니다.

- SteamID는 프로필 URL(`https://steamcommunity.com/id/xxx`), vanity name, 또는 숫자 SteamID64 모두 지원 (자동 변환)
- `~/.config/questail/.env`에 저장되어 다음부터는 생략 가능
- Steam 등록 뒤에 LLM 설정 단계가 이어집니다: `1. OpenAI / 2. 로컬 호환(Ollama·LM Studio) / 3. 건너뛰기`. 선택 결과는 같은 파일에 `QUESTAIL_LLM_BASE_URL` / `QUESTAIL_LLM_API_KEY` / `QUESTAIL_LLM_MODEL`로 저장됩니다 (전역 설정 파일을 다른 도구와 공유하므로 충돌 방지를 위해 questail 전용 네임스페이스 사용). 건너뛰면 AI 해석 없는 정량 리포트로 동작합니다.
- 등록 후 바로 `gather steam`을 실행할지 묻습니다

**`questail gather steam [<id>] [-o <dir>]`** — Steam 라이브러리를 가져오고 보강합니다.

- `<id>` 생략 시 config에 저장된 steam-id 사용
- `-o <dir>` 출력 디렉토리 (기본: `./games/`)
- Steam appdetails로 게임 메타(장르·개발사·퍼블리셔·출시일·커버 이미지)를 자동 보강합니다
- 게임별 업적 달성률을 조회합니다 — Steam 프로필의 "게임 세부정보"가 공개 상태여야 동작하며, 비공개면 조용히 스킵됩니다. 전 게임이 비어 있으면 Steam → 설정 → 개인정보 → 게임 세부정보를 켜세요 — 계정 설정 문제이지 questail 버그가 아닙니다.
- 출력 디렉토리에 `library.md`(객관 데이터 정본 인덱스)를 생성하고 `history.jsonl`(플레이타임 스냅샷 로그)에 누적합니다
- 재실행은 비파괴 방식입니다: `games/*.md`의 객관 필드는 최신화되고, 주관 필드(별점·한줄평 등, 추가되는 대로)는 보존됩니다

**`questail analyze [-o <dir>]`** — `<outputDir>/library.md`에서 취향 프로필을 만들어 `<outputDir>/reports/<YYYY-MM-DD-HHmm>.md`로 저장합니다.

- `library.md`가 없으면 먼저 `gather`를 실행하라고 안내하고 종료합니다
- LLM 미설정이어도 정량 리포트는 온전히 생성됩니다(빈 리포트가 아닙니다) — AI 해석 섹션만 빠집니다. LLM이 설정돼 있으면 그 위에 AI 해석이 얹힙니다.

**`questail config`** — 설정 관리:

| 명령어 | 설명 |
|--------|------|
| `questail config set <key> <value>` | 키-값 저장 |
| `questail config get <key>` | 값 조회 (민감 정보 마스킹) |
| `questail config delete <key>` | 값 삭제 |

### 설정 키

| 키 | 설명 | 예시 |
|---|------|------|
| `steam-api-key` | Steam Web API 키 | `ABCDEF1234567890` |
| `steam-id` | SteamID64 (숫자) | `76561197960287930` |
| `language` | 출력 언어 (`ko` / `en`) | `en` |
| `QUESTAIL_LLM_BASE_URL` | LLM 엔드포인트 (`sniff`로 설정) | `https://api.openai.com/v1` |
| `QUESTAIL_LLM_API_KEY` | LLM API 키 (로컬호스트는 생략 가능) | `sk-...` |
| `QUESTAIL_LLM_MODEL` | LLM 모델명 (`sniff`로 설정) | `gpt-4o-mini` |

## 출력 예시

`gather` + `analyze`는 출력 디렉토리(기본 `./games/`)에 네 종류의 파일을 만듭니다:

- `*.md` — 게임별 노트. 재실행 시 객관 필드는 최신화되고 주관 필드(`rating`, `note`)는 보존됩니다
- `library.md` — 전 게임 × 전 축을 담은 인덱스, 객관 데이터의 정본
- `history.jsonl` — 실행마다 누적되는 플레이타임 스냅샷 로그
- `reports/<YYYY-MM-DD-HHmm>.md` — `analyze` 산출물

`./games/` 디렉토리에 게임별 md 파일이 생성됩니다:

```markdown
---
title: ELDEN RING
game_id: 1245620
platform: steam
source: auto
playtime_minutes: 9840
achievement_pct: 62
last_played: 1712345678
image: https://cdn.cloudflare.steamstatic.com/steam/apps/1245620/header.jpg
genres: [RPG, Souls-like]
developers: [FromSoftware Inc.]
publishers: [FromSoftware Inc., Bandai Namco Entertainment]
release_date: 24 Feb, 2022
---

> Steam에서 자동 가져온 게임 데이터입니다.
```

파일명: `{appId}-{title-slug}.md` (예: `1245620-elden-ring.md`)

보강 필드(`achievement_pct`, `genres`, `developers`, `publishers`, `release_date`, `image`)는 데이터가 있을 때만 기록됩니다. `gather`를 다시 실행하면 객관 필드가 최신화되고, 주관 필드(`rating`, `note`)는 추가된 이후부터 보존됩니다.

리포트에는 정량 섹션이 항상 온전히 담깁니다 — 총 플레이타임, 플레이타임 상위 10 게임, 플레이타임 가중 장르 분포, 플레이타임 5수 요약(시간), 편중도(상위 10/20/40 비중), 플레이 구간별 게임 수, 업적 달성률 요약(데이터가 있을 때), 위시리스트 — LLM이 설정돼 있으면 AI 해석이 얹힙니다. 아래 발췌는 가공 데이터 예시입니다:

```markdown
# QuestTail 취향 리포트

- 생성: 2026-09-16T09:00:00.000Z
- 게임 수: 42개, 총 플레이타임: 1180시간

## 플레이타임 상위 10

| 순위 | 제목 | 시간 | 비중 |
| --- | --- | --- | --- |
| 1 | Monster Hunter Wilds | 214.5h | 18.2% |
| 2 | Terraria | 96.0h | 8.1% |
| 3 | Stardew Valley | 88.5h | 7.5% |
| ... | ... | ... | ... |

## AI 해석

(...가공 해석 생략...)
```

## 구조

```
questail/
├── packages/
│   ├── core/                  # @questail/core — 라이브러리, 프레임워크 중립
│   │   └── src/
│   │       ├── config/        # 전역 LLM 설정 (QUESTAIL_LLM_*)
│   │       ├── llm/           # LLM 어댑터 (단일 엔드포인트 + 무LLM 폴백)
│   │       ├── connectors/    # 플랫폼 어댑터 (Steam)
│   │       ├── metadata/      # appdetails 보강 (캐시)
│   │       ├── normalize/     # 표준 스키마 변환
│   │       ├── storage/       # 마크다운 직렬화
│   │       ├── profile/       # 취향 프로필 집계
│   │       ├── analyze/       # 정량 통계 + LLM 해석
│   │       ├── agent/         # 질의 라우터·도구 9종·근거 검증 (LLM 호출 없음)
│   │       └── cli-runtime.ts # CLI 런타임, import 시 부작용 없음
│   ├── cli/                   # @questail/cli — `questail` 명령
│   └── collie/                # @questail/collie — GraphRAG 앱 계층
│       ├── src/               # 코퍼스 준비·그래프 빌더·LangGraph 셸
│       ├── config/            # 탐색 정책 (허브 컷오프, L0~L4 사다리)
│       └── demo-corpus/       # 합성 문서 50건 + 관계 골든셋
├── pnpm-workspace.yaml
└── package.json
```

`core` 는 프레임워크 중립을 유지한다 — 의존 트리에 `@langchain/*` 이 없다. LangGraph 는
`collie` 에 있고 `cli` 는 둘로 위임하는 얇은 런처다. 상세는
[`packages/collie/README.md`](./packages/collie/README.md).

## 앞으로

| 단계 | 목표 |
|------|------|
| **M1** ✅ | Steam 라이브러리 → Markdown CLI |
| **M2** ✅ | AI 취향 분석 리포트 CLI (v0.2.0) |
| **M2.5** 🚧 | 에이전트 앱 계층 — 내 라이브러리 위의 GraphRAG (`packages/collie`) |
| M3 | 웹 UI + 별점 |
| M4+ | PSN/Xbox, 수기 추가, 분석 심화 |

## 라이선스

MIT
