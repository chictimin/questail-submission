<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
    <img src="assets/logo-light.png" alt="QuestTail logo — black Yorkshire Terrier-like dog face silhouette" width="180">
  </picture>
</p>

# QuestTail

> 제출 검토자는 먼저 [SUBMISSION.md](./SUBMISSION.md)를 읽어 주세요. 이 비공개 스냅샷에서 검토할 collie demo의 실행 경로·범위·한계가 정리돼 있습니다.

> English · [한국어](./README.ko.md)

> A personal-first tool that gathers game history scattered across platforms (Steam/PSN/Xbox) into Markdown archives and provides personal taste analysis via LLM.

**Current phase: M2 (v0.3.0)** — CLI that exports your Steam library to Markdown files and generates a taste analysis report.

## Quick Start

```bash
git clone https://github.com/chictimin/questail.git
cd questail
pnpm install
pnpm build

# Global install (optional)
pnpm link --global
```

## Consuming `@questail/core` as a library

`@questail/core` is not on the npm registry yet. Pinned builds are attached to GitHub Releases — install by URL:

```bash
pnpm add https://github.com/chictimin/questail/releases/download/v0.3.0/questail-core-0.3.0.tgz
```

The tarball contains the built `dist/`, so no build step is needed on the consumer side. To upgrade, replace the version in the URL and run `pnpm install`. Until an npm publish happens, the git tag is the source of truth for versions.

> Note: the agent layer (`packages/core/src/agent`, deterministic tool router) is Korean-only — English questions don't error but silently route worse (no ranking, schema fallback, or direct escalate). See [tools/eval/README.md](./tools/eval/README.md).

## Usage

```bash
# 1. Register API key & SteamID (first time only)
questail sniff

# 2. Gather your Steam library
questail gather steam

# 3. Analyze your taste
questail analyze

# 4. Manage configuration
questail config set language en
questail config get steam-api-key
```

### Detailed Walkthrough

**`questail sniff`** — Interactive setup. Registers your Steam Web API key and SteamID in one go.

- SteamID accepts profile URLs (`https://steamcommunity.com/id/xxx`), vanity names, or numeric SteamID64 (auto-resolved via ResolveVanityURL API)
- Saved to `~/.config/questail/.env` — skipped on subsequent runs
- After the Steam setup, an LLM setup step follows: `1. OpenAI / 2. Local OpenAI-compatible (Ollama·LM Studio) / 3. Skip`. Your choice is stored as `QUESTAIL_LLM_BASE_URL` / `QUESTAIL_LLM_API_KEY` / `QUESTAIL_LLM_MODEL` in the same file (questail-namespaced so they don't collide with other tools sharing the global env file). Skipping means quantitative-only reports with no AI analysis.
- Prompts whether to proceed with `gather steam` right after setup

**`questail gather steam [<id>] [-o <dir>]`** — Fetches your Steam library and enriches it.

- Omitting `<id>` uses the steam-id stored in config
- `-o <dir>` output directory (default: `./games/`)
- Game metadata (genres, developers, publishers, release date, cover image) is auto-enriched via Steam appdetails
- Achievement completion rate is fetched per game — requires your Steam profile's "Game details" to be set to Public; otherwise it's silently skipped. Every game coming back achievement-less? Enable Steam → Settings → Privacy → Game details — that's an account setting, not a questail issue.
- Writes `library.md` (the canonical index of objective data) and appends a playtime snapshot to `history.jsonl` in the output directory
- Re-running is non-destructive: objective fields in `games/*.md` are refreshed while subjective fields (ratings and notes, once added) are preserved

**`questail analyze [-o <dir>]`** — Builds a taste profile from `<outputDir>/library.md` and saves the report to `<outputDir>/reports/<YYYY-MM-DD-HHmm>.md`.

- If `library.md` is missing, it tells you to run `gather` first and exits
- Works without LLM setup: the quantitative report is always generated in full — only the AI interpretation section is left out. With LLM configured, an AI analysis is layered on top.

**`questail config`** — Configuration management:

| Command | Description |
|---------|-------------|
| `questail config set <key> <value>` | Save a key-value pair |
| `questail config get <key>` | Retrieve a value (secrets masked) |
| `questail config delete <key>` | Delete a value |

### Configuration Keys

| Key | Description | Example |
|-----|-------------|---------|
| `steam-api-key` | Steam Web API key | `ABCDEF1234567890` |
| `steam-id` | SteamID64 (numeric) | `76561197960287930` |
| `language` | Output language (`ko` / `en`) | `en` |
| `QUESTAIL_LLM_BASE_URL` | LLM endpoint (set via `sniff`) | `https://api.openai.com/v1` |
| `QUESTAIL_LLM_API_KEY` | LLM API key (optional for localhost) | `sk-...` |
| `QUESTAIL_LLM_MODEL` | LLM model name (set via `sniff`) | `gpt-4o-mini` |

## Output Example

`gather` + `analyze` produce four kinds of files under the output directory (default `./games/`):

- `*.md` — per-game notes; re-running refreshes objective fields while subjective fields (`rating`, `note`) are preserved
- `library.md` — every game × every axis in one index, the canonical source of objective data
- `history.jsonl` — playtime snapshot log, appended on every run
- `reports/<YYYY-MM-DD-HHmm>.md` — `analyze` output (report headings are in Korean regardless of locale)

Each game is written as a Markdown file in `./games/`:

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

> Auto-imported from Steam.
```

File naming: `{appId}-{title-slug}.md` (e.g. `1245620-elden-ring.md`)

Enrichment fields (`achievement_pct`, `genres`, `developers`, `publishers`, `release_date`, `image`) appear only when the data is available. Re-running `gather` refreshes these objective fields; subjective fields (`rating`, `note`) are preserved once added.

A report always carries the full quantitative section — total playtime, top 10 games by playtime, playtime-weighted genre distribution, playtime 5-number summary (hours), concentration (top 10/20/40 share), games per playtime bucket, achievement summary (when data exists), wishlist — plus an AI interpretation when LLM is configured. Excerpt below uses fictional data (illustrative example):

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

(...fictional interpretation omitted...)
```

## Project Structure

```
questail/
├── packages/
│   ├── core/                  # @questail/core — library, framework-neutral
│   │   └── src/
│   │       ├── config/        # Global LLM settings (QUESTAIL_LLM_*)
│   │       ├── llm/           # LLM adapter (single endpoint + no-LLM fallback)
│   │       ├── connectors/    # Platform adapters (Steam)
│   │       ├── metadata/      # appdetails enrichment (cached)
│   │       ├── normalize/     # Standard schema transformation
│   │       ├── storage/       # Markdown serialization
│   │       ├── profile/       # Taste profile aggregation
│   │       ├── analyze/       # Quantitative stats + LLM interpretation
│   │       ├── agent/         # Query router, 9 tools, grounding checks (no LLM calls)
│   │       └── cli-runtime.ts # CLI runtime, no side effects on import
│   ├── cli/                   # @questail/cli — the `questail` command
│   └── collie/                # @questail/collie — GraphRAG app layer
│       ├── src/               # Corpus prepare, graph builder, LangGraph shell
│       ├── config/            # Traversal policy (hub cutoffs, L0–L4 ladder)
│       └── demo-corpus/       # 50 synthetic docs + relation golden set
├── pnpm-workspace.yaml
└── package.json
```

`core` stays framework-neutral — no `@langchain/*` in its dependency tree. LangGraph lives in
`collie`, and `cli` is a thin launcher that dispatches to both. See
[`packages/collie/README.md`](./packages/collie/README.md).

## Roadmap

| Phase | Goal |
|-------|------|
| **M1** ✅ | Steam library → Markdown CLI |
| **M2** ✅ | AI taste analysis report CLI (v0.2.0) |
| **M2.5** 🚧 | Agent app layer — GraphRAG over your library (`packages/collie`) |
| M3 | Web UI + ratings |
| M4+ | PSN/Xbox connectors, manual entries, advanced analytics |

## License

MIT
