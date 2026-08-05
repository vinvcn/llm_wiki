# Owner Acceptance Checks

## Purpose

This file is the **traceable record of owner acceptance checks** for this project.
Whenever the owner runs a live acceptance session against the app (manual testing
of real flows — upload, chat, search, settings, deployment behavior), the
session is written up here as a report so that what was tested, what broke, and
what fixed it stays auditable after the chat thread is gone.

It is append-only and chronological: newest reports are appended at the bottom
of the [Reports](#reports-chronological) section. Past reports are never edited;
corrections are added as a short note under the original report.

## Suggested report outline

Each report should follow this shape (adapt section names if needed, keep the
information):

```markdown
### YYYY-MM-DD — <phase or session title>

**Context (what was tested):**
- commit / version under test (link), worktree or deployment it ran from,
  URL/port, auth mode, data dir, provider configuration (no secrets),
  anything unusual about the environment.

**Scenarios tested:**
1. <scenario> — what was exercised, expected vs observed, verdict (PASS/FAIL/PARTIAL).
2. …

**Problems found:**
- <problem> — severity, how it was observed. (Omit or write "none" if clean.)

**Corresponding issues / PRs:**
- issue: <link> · PR: <link> (for every problem that produced one)

**Commits:**
- tested: <sha> · fixes: <sha(s)> (linked)
```

## Rules for writing reports

1. **Link to the issue, PR, or commit whenever one exists.** A problem, fix, or
   tested change is referenced by its GitHub issue/PR number or commit SHA —
   never paraphrased without a link. If none exists yet, say so explicitly
   (that itself is a signal to file one).
2. **Always state the context the test ran against**: commit under test, how
   the app was deployed/booted, and relevant configuration (auth mode,
   retrieval mode, provider shape). A report without context cannot be
   re-run or trusted later.
3. **Scenarios are concrete**: name the flow (e.g. "1.1 MB PDF upload →
   ingest → wiki pages"), the expected behavior, and the observed result.
   "It worked" is not a scenario; "upload → queue → complete in 4m56s,
   pages on disk, vec index populated" is.
4. **Problems get follow-up references**: if a finding produced an issue or
   fix, the report carries the link both ways (the issue should also mention
   the session).
5. **Append-only history**: do not rewrite earlier reports; add dated
   correction notes.
6. **Clean results are recorded too** — a session that found nothing is
   evidence, not noise.

## Reports (chronological)

### 2026-08-05 — Phase-1 acceptance (production-completeness, issue #14 closeout)

*Consolidated report: supersedes the seed version merged with PR #34, expanded
to the full session record per owner instruction.*

**Context (what was tested):**
- Tested commit: [`a42d103`](https://github.com/vinvcn/llm_wiki/commit/a42d103) (= `origin/main` at session start, merge of PR #31), served from the `doc-pass` worktree via `node packages/server/src/index-v2.js` at `http://127.0.0.1:19828`.
- Auth mode `open` (no token configured); data dir `~/.llm-wiki-server` with pre-existing owner data (migrations 010–013 applied).
- LLM: custom OpenAI-compatible endpoint (NVIDIA integrate), `apiMode=chat_completions`; embedding endpoint configured (dim 2048); retrieval mode `hybrid` (`wikiSearchMode` in `app-state.json`).
- Scope: live acceptance of the eight merged #14 gap closures — PRs [#22](https://github.com/vinvcn/llm_wiki/pull/22), [#23](https://github.com/vinvcn/llm_wiki/pull/23), [#25](https://github.com/vinvcn/llm_wiki/pull/25), [#27](https://github.com/vinvcn/llm_wiki/pull/27), [#28](https://github.com/vinvcn/llm_wiki/pull/28), [#29](https://github.com/vinvcn/llm_wiki/pull/29), [#30](https://github.com/vinvcn/llm_wiki/pull/30), [#31](https://github.com/vinvcn/llm_wiki/pull/31). Session was interactive: the owner operated the app; the assistant traced each flow server-side (SQLite rows, logs, code paths).

**Scenarios tested:**
1. Retrieval-mode configuration discovery (owner query) — located Settings → Embeddings → "Retrieval mode" (keyword/vector/hybrid); value persisted as `wikiSearchMode` and honored by the server search API; vector/hybrid require an embedding provider configured in the same section. PASS.
2. Chat Q&A end-to-end — owner asked "hi, what is 声音选择" (session 1): `POST /api/v2/projects/:id/chat` validated by `ChatRequestSchema` (#23); `{runId, sessionId}` returned immediately; agent loop persisted the user message **before** streaming (`chat_messages` id 1, #25); `wiki.search` retrieval returned 5 grounded references (`tts音色系统.md`, `声音克隆受控机制.md`, `音色预设库.md`, `index.md`, `overview.md`); tokens streamed via `agent-event` + dual `chat:delta`, finalized by terminal `chat:done` (#29); assistant message + refs persisted (id 2); unauthenticated request under open auth (#22). PASS.
3. Hybrid degrade behavior — at session start the project's vector index was empty (`vec_meta` 0 rows), so hybrid's vector leg contributed nothing and the answer's references came from the keyword leg only; correct degrade per the #27 health probe. Index populated later by scenario 5. PASS (noted).
4. Ingest liveness observability — during scenario 5's generation leg (~3 min) the `ingest_queue` row flatlined at `progress=75` with frozen `updated_at`; 5–10 s polling could not distinguish a healthy run from a hung one (initially misdiagnosed as a task-stealing zombie process). FAIL (observability) → issue #32.
5. PDF upload → ingest end-to-end — "Harness engineering for coding agent users.pdf" (1.1 MB): multipart path (<10 MB chunked threshold), file byte-complete in `raw/sources/`; task id 3, attempt 1; stages `preprocess 5 → mineru 15 → context 20 → cache-check 25 → images 30 → caption 40 → analysis 55 → generation 75 → write 85 → index-log 90 → reviews 92 → cache-save 95 → embed 98 → 100`; wiki concept/entity pages + `index.md`/`log.md` written with clean YAML frontmatter; `vec_meta` (dim 2048) written 12:10:49 local; row completed 12:11:03 (4 min 56 s). PASS.
6. Multi-instance environment probe — a root-owned Docker container (`phase3-integration-llm-wiki-1`, `RestartPolicy: unless-stopped`, port 3000, own volume `/data`) initially looked like a second server sharing the queue; verified isolated (separate port + data volume), kill-and-respawn behavior explained; left running. Environmental; no code change.
7. Session-closeout operations (not an app scenario; recorded for traceability) — root checkout screened and reset to `origin/main` (backup `/home/pc/llm-wiki-root-dirt-20260805/` with per-item `SCREENING.md`; preserved unmerged experiments: web↔desktop parity CI suite, `packages/server/src/clip-server.js`, `abortedLocally` chat-panel logic, overnight scheduler, `release.yml`); process docs produced (#33 → PR #34).

**Problems found:**
- Ingest heartbeat gap (scenario 4) — medium severity, issue #32.
- Empty vector index at session start (scenario 3) — informational; degrade by design; resolved when scenario 5 populated the index.
- Respawnable root container (scenario 6) — environmental confusion during the incident investigation, no code change.
- No product defects found in the app itself this session.

**Corresponding issues / PRs:**
- Filed from session: [#32](https://github.com/vinvcn/llm_wiki/issues/32) (ingest heartbeat).
- Process artifacts of this session: [#33](https://github.com/vinvcn/llm_wiki/issues/33) → PR [#34](https://github.com/vinvcn/llm_wiki/pull/34) (this document, `AGENTS.md`, `CLAUDE.md`).
- Verified features: PRs #22, #23, #25, #27, #28, #29, #30, #31 (all merged; per-PR validation summaries on the PRs). Scope anchor: [#14](https://github.com/vinvcn/llm_wiki/issues/14).

**Commits:**
- tested: [`a42d103`](https://github.com/vinvcn/llm_wiki/commit/a42d103) · produced this session: [`288657f`](https://github.com/vinvcn/llm_wiki/commit/288657fc3f001a343bac3b3fdbce9d5dbf396048) (#34) · fixes: none (issue #32 open).
