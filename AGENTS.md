# Agent Guide

Instructions for agents working in this repository.

## Owner acceptance records

The owner performs live acceptance checks of the app (manual testing of real
flows). **Every acceptance-check session is recorded in
[`docs/owner-acceptance/`](docs/owner-acceptance/OWNER_ACCEPTANCE.md)** — one
report file per session, named `YYYY-MM-DD_<kebab-slug>.md` (the slug is the
kebab-case of the report title, which names what is being tested), plus one row
added to the chronological index table in
[`docs/owner-acceptance/OWNER_ACCEPTANCE.md`](docs/owner-acceptance/OWNER_ACCEPTANCE.md).
Follow the outline and writing rules defined in that index:

- state the context the test ran against (commit, deployment, configuration),
- list concrete scenarios, each with description / testing done / verdict,
- include facts, observations, and reproducible details, professionally,
- record problems found, linking the corresponding issue/PR/commit when one
  exists (and filing one when it doesn't),
- never rewrite merged reports; add dated correction notes.

Acceptance findings must not live only in chat threads or PR comments — the
index and report files are the durable, traceable record.

## Repository facts (short version)

- npm-workspaces monorepo; server = plain-JS ESM (`packages/server`, entry
  `packages/server/src/index-v2.js`), client = React/TS (`src/`),
  `packages/api-types` = Zod API-contract SSOT (rebuild its dist after edits:
  `npm run build -w @llm-wiki/api-types`).
- Gates from the repo root: `npm test -w @llm-wiki/server`,
  `npm run typecheck`, `npm run test:mocks`, `npm run build:web`. CI runs
  typecheck + server tests.
- Docs live in `docs/` (see `docs/PUSH1_ACTUAL_ARCHITECTURE.md` for the actual
  architecture and accepted deviations, `docs/API_REFERENCE.md`,
  `docs/DEPLOYMENT.md`); the LikeC4 as-built architecture model lives in
  `docs/architecture/likec4/` (guide + evidence record:
  `docs/architecture/README.md`); the promise-vs-actual architecture review is
  `docs/architecture/PROMISE_VS_ACTUAL_REVIEW_2026-08-05.md`; design plans in
  `plans/`.
