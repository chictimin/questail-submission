<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
    <img src="assets/logo-light.png" alt="QuestTail logo — black Yorkshire Terrier-like dog face silhouette" width="180">
  </picture>
</p>

# QuestTail — submission snapshot

> Reviewers: start with [SUBMISSION.md](./SUBMISSION.md). It defines the demo's run path, scope, and limits for this private snapshot.

This snapshot's only review target is the `packages/collie` graph-retrieval demo over a **synthetic corpus of 50 documents**. Nothing else in this repo is under review.

## Reproduce (3 minutes)

```bash
pnpm install --frozen-lockfile
pnpm -r build
node packages/cli/dist/cli.js collie serve --demo --port 4173
```

In another terminal:

```bash
# Positive case — deterministic retrieval over the synthetic corpus
node packages/cli/dist/cli.js collie ask "Lumen Reach 1과 같은 탐험 게임이 있어?" --mode demo --port 4173
```

Browser: open `http://127.0.0.1:4173`. The page and the CLI both use the real `POST /ask` SSE path (`step{node,level}*` → `result{mode, trace}`).

The other two reproducible outcomes:

```bash
# Hold (abstain) — a question with no grounding in the synthetic corpus exits 2
node packages/cli/dist/cli.js collie ask "엘든 링 만든 데서 낸 다른 게임 있어?" --mode demo --port 4173

# Mode mismatch — asking --mode real against a --demo server is rejected with HTTP 409
node packages/cli/dist/cli.js collie ask "Lumen Reach 1과 같은 탐험 게임이 있어?" --mode real --port 4173
```

## What the demo is

- `serve --demo` builds a temporary corpus + graph from the 50 synthetic docs and serves it on loopback (`127.0.0.1`, default port `4173`). No cache, no Steam account, no personal library is read.
- The demo is deterministic retrieval: it always shows the selection path and verbatim evidence spans. The generated answer sentence appears only when the server has an LLM key (see LLM keys below); without a key there is no generated answer.
- A `--demo` server rejects `--mode real` requests with HTTP 409.

## LLM keys

- The server reads `QUESTAIL_LLM_BASE_URL` / `QUESTAIL_LLM_MODEL` / `QUESTAIL_LLM_API_KEY` from the `.env` in the directory it was started from (plus `~/.config/questail/.env` as fallback). No `.env` is created by the demo.
- The browser never sends a key: `POST /ask` carries `{question, mode}` only. Keys live in the server's `.env`, never in the browser. Provider calls, if any, happen server-side only.

To enable generated answers:

```bash
cp .env.example .env
# fill in QUESTAIL_LLM_API_KEY (plus model/base URL unless local)
node packages/cli/dist/cli.js collie serve --demo --port 4173
```

Without a key, search and the graph selection path still work; only the generated answer sentence is omitted (the result carries path and verbatim evidence only).

## Verify

```bash
pnpm test
pnpm release:check
```

`pnpm test` runs the full suite (`node --test --import tsx` over all `*.test.ts` under `packages/*/src`).
`pnpm release:check` runs build → typecheck → tarball dry-run for the three packages → the pinned regression baseline (`pnpm eval`: 26/27, single C2-05 case).

`pnpm eval` exits 1 by design. The expected baseline is 26/27 with C2-05 as the only miss; C2-05 is a known-intentional unresolved case (expected `find_rating_playtime_gaps+search_docs`, router returns `get_game_note+lookup_library+get_wishlist+search_docs`), not a regression. `pnpm eval:baseline` asserts exactly this state.

## Out of scope (not reviewed in this snapshot)

- Personal Steam libraries, real Steam data collection (`sniff` / `gather` / `analyze` flows), and the legacy product docs (`README.ko.md` describes the pre-snapshot product and is not submission scope).
- `core` agent tool execution, real-corpus queries, and generated-answer verification.
- Pages deployment, npm publishing, and any `core verify` claims.
- `packages/collie/REPORT.md` sections 4–6 are records of a discontinued real-corpus experiment, not the current demo spec.

## Docs

- [`SUBMISSION.md`](./SUBMISSION.md): reproduction, scope, safety boundaries.
- [`packages/collie/README.md`](./packages/collie/README.md): demo run and package scope.
- [`packages/collie/REPORT.md`](./packages/collie/REPORT.md): design and experiment log (read-only reference).

## License

MIT
