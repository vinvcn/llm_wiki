# Owner Acceptance Report — 2026-08-05 · Issue #14 production completeness

*Phase-1 acceptance session. Consolidated report: supersedes the seed version
merged with PR #34; rewritten to the strengthened rules (scenario description /
testing done / verdict; facts, observations, reproducible details) per owner
instruction. Indexed by [OWNER_ACCEPTANCE.md](OWNER_ACCEPTANCE.md).*

**Context (what was tested):**
- Tested commit: [`a42d103`](https://github.com/vinvcn/llm_wiki/commit/a42d103) (= `origin/main` at session start, merge of PR #31), served from the `doc-pass` worktree via `node packages/server/src/index-v2.js` at `http://127.0.0.1:19828`.
- Auth mode `open` (no token configured); data dir `~/.llm-wiki-server` with pre-existing owner data (migrations 010–013 applied).
- LLM: custom OpenAI-compatible endpoint (NVIDIA integrate), `apiMode=chat_completions`; embedding endpoint configured (dim 2048); retrieval mode `hybrid` (`wikiSearchMode` in `app-state.json`).
- Scope: live acceptance of the eight merged #14 gap closures — PRs [#22](https://github.com/vinvcn/llm_wiki/pull/22), [#23](https://github.com/vinvcn/llm_wiki/pull/23), [#25](https://github.com/vinvcn/llm_wiki/pull/25), [#27](https://github.com/vinvcn/llm_wiki/pull/27), [#28](https://github.com/vinvcn/llm_wiki/pull/28), [#29](https://github.com/vinvcn/llm_wiki/pull/29), [#30](https://github.com/vinvcn/llm_wiki/pull/30), [#31](https://github.com/vinvcn/llm_wiki/pull/31). Session was interactive: the owner operated the app; the assistant traced each flow server-side (SQLite rows, logs, code paths).

**Scenarios tested:**

1. **Retrieval-mode configuration discovery**
   - *Description:* owner asked where hybrid search (keyword + vector) is configured; expected a settings control persisted and honored server-side.
   - *Testing done:* traced the control to Settings → Embeddings → "Retrieval mode" (`src/components/settings/sections/embedding-section.tsx`), persisted as `wikiSearchMode` in `app-state.json` (`src/lib/project-store.ts`), read by the server search API (`packages/server/src/api/search.js`); observed live store value `hybrid` with an embedding endpoint configured.
   - *Verdict:* **PASS.**

2. **Chat Q&A end-to-end**
   - *Description:* owner asked "hi, what is 声音选择" in the chat panel; expected a streamed answer, persisted on both sides, grounded in wiki content, with open auth.
   - *Testing done:* `POST /api/v2/projects/:id/chat` validated by `ChatRequestSchema` (#23) and returned `{runId, sessionId}` immediately; user message persisted before streaming (`chat_messages` id 1, session 1, #25); agent loop ran `wiki.search`; answer streamed via `agent-event` + dual `chat:delta`, finalized by terminal `chat:done` (#29); assistant message persisted (id 2) with 5 references (`tts音色系统.md`, `声音克隆受控机制.md`, `音色预设库.md`, `index.md`, `overview.md`); request carried no auth token (#22, mode `open`).
   - *Verdict:* **PASS.**

3. **Hybrid degrade with empty vector index**
   - *Description:* with `wikiSearchMode=hybrid`, verify whether both retrieval legs actually contribute for this project.
   - *Testing done:* queried `vec_meta` before the upload — 0 rows, so scenario 2's references came from the keyword leg only; degrade behavior matches the #27 vector-index health probe by design; after scenario 5, `vec_meta` shows a dim-2048 index.
   - *Verdict:* **PARTIAL** (informational; degrade by design, index populated later in session).

4. **Ingest liveness observability**
   - *Description:* determine whether a healthy ingest can be distinguished from a hung one while a long LLM call is in flight.
   - *Testing done:* polled `SELECT status, progress, updated_at FROM ingest_queue WHERE id = 3` every 5–10 s during the run (12:07:49–12:11:15 local); observed `progress=75` with frozen `updated_at=1785902823448` for the entire generation leg (entered 12:07:03, ~3 min); code inspection: `reportIngestProgress` (ingest/progress.js) is the only row writer during a run and fires once per stage, and the LLM call timeout backstop is 30 min (`packages/server/src/ingest/llm.js`). Repro: upload any source against a slow endpoint and poll the row — it reads as stuck for the call's duration. Observation initially misattributed to a second process; that hypothesis was disproved (scenario 6) and the true gap filed.
   - *Verdict:* **FAIL** (observability) → issue [#32](https://github.com/vinvcn/llm_wiki/issues/32), which carries the full facts/repro record.

5. **PDF upload → ingest end-to-end**
   - *Description:* owner uploaded "Harness engineering for coding agent users.pdf" (1.1 MB) via the UI; expected upload → queue → pipeline → wiki pages + embeddings with no manual intervention.
   - *Testing done:* file byte-complete on disk (`raw/sources/`, 1,090,489 B); multipart path taken (<10 MB chunked threshold, #30); task id 3, attempt 1; stage timeline from row timestamps — created 12:06:07, `generation` 12:07:03, `vec_meta` written 12:10:49, completed 12:11:03 (4 min 56 s), stages 5→100 per `INGEST_STAGES`; wiki concept/entity pages plus `index.md`/`log.md` written with valid YAML frontmatter (spot-check: `sources: ["Harness engineering for coding agent users.pdf"]` renders as a proper list — the #28 glue bug absent).
   - *Verdict:* **PASS.**

6. **Multi-instance environment probe**
   - *Description:* during scenario 4's investigation, two `index-v2` processes were visible; determine whether a second server could claim tasks from the test app's queue.
   - *Testing done:* identified the extra PIDs (4811, later 2435484) as the container process `phase3-integration-llm-wiki-1` (parent `containerd-shim`, `RestartPolicy: unless-stopped`, port 3000, own volume `/data`); confirmed isolation from the app under test (separate port and data dir — no shared `ingest_queue`); kill → immediate respawn explained by the restart policy; container left running as harmless.
   - *Verdict:* **PASS** (environmental; no code defect; no impact on the app under test).

7. **Session-closeout operations** (not an app scenario; recorded for traceability)
   - *Description:* phase-1 closeout per owner direction: screen every uncommitted change in the root checkout, confirm supersession, clean, and sync to `origin/main`.
   - *Testing done:* per-file screening — dirty-added lines of each modified tracked file checked for presence in `origin/main`; each untracked path checked for a main counterpart; results recorded in `SCREENING.md`; backup taken at `/home/pc/llm-wiki-root-dirt-20260805/` (~9.3 MB plus runtime dirs); `git checkout -- .` + targeted `git clean` + `git pull --ff-only` left the root clean at `a42d103`. Unmerged experiments preserved in backup: web↔desktop parity CI suite, `packages/server/src/clip-server.js`, `abortedLocally` chat-panel logic, overnight scheduler, `release.yml`.
   - *Verdict:* **PASS** (operational).

**Problems found:**
1. **Ingest heartbeat gap** — severity medium (observability). Facts: `ingest_queue.progress`/`updated_at` freeze at `75` / `1785902823448` for the full generation leg (~3 min); `reportIngestProgress` is the only in-run row writer and fires once per stage; LLM timeout backstop 30 min. Observation: a healthy run is indistinguishable from a hung one, which misdirected a live investigation before the true cause was established. Reproducible: poll the row during any ingest against a slow endpoint (scenario 4). → [#32](https://github.com/vinvcn/llm_wiki/issues/32) (open).
2. **Empty vector index at session start** — informational. Facts: `vec_meta` 0 rows before the upload, so hybrid served keyword-only results in scenario 2. Observation: degrade behaves exactly as the #27 health probe specifies; the index was populated by scenario 5. No action required.
3. **Respawnable root container** — environmental. Facts: `phase3-integration-llm-wiki-1` (`unless-stopped`) respawns after `kill`, port 3000, own volume. Observation: produced noise during problem 1's investigation; shares no port or data with the app under test. No code change.
4. **Clean otherwise** — no product defects found in the app itself this session.

**Corresponding issues / PRs:**
- Filed from session: [#32](https://github.com/vinvcn/llm_wiki/issues/32) (ingest heartbeat).
- Process artifacts of this session: [#33](https://github.com/vinvcn/llm_wiki/issues/33) → PR [#34](https://github.com/vinvcn/llm_wiki/pull/34) (this record's format, `AGENTS.md`, `CLAUDE.md`).
- Verified features: PRs #22, #23, #25, #27, #28, #29, #30, #31 (all merged; per-PR validation summaries on the PRs). Scope anchor: [#14](https://github.com/vinvcn/llm_wiki/issues/14).

**Commits:**
- tested: [`a42d103`](https://github.com/vinvcn/llm_wiki/commit/a42d103) · produced this session: [`288657f`](https://github.com/vinvcn/llm_wiki/commit/288657fc3f001a343bac3b3fdbce9d5dbf396048) (#34) · fixes: none (issue #32 open).

---

## Correction note (2026-08-13, unattended run)

**Problem 1 (ingest heartbeat gap, [#32](https://github.com/vinvcn/llm_wiki/issues/32)) is fixed.** Dated note per the index rules; the merged record above is otherwise untouched. The web server's ingest orchestrator now runs a 15 s per-claim liveness heartbeat while a task is `processing`: `packages/server/src/store/db.js` migration `014_ingest_heartbeat`, `heartbeatIngestTask()` in `packages/server/src/store/ingest-queue.js` (writes `heartbeat_at` + a fresh `updated_at`, no-op once the row leaves `processing`), and a per-claim interval in `packages/server/src/ingest/orchestrator.js` cleared on every exit path (success, retry, usage-limit defer, cancel). The field is exposed through `GET /api/v2/projects/:id/ingest/queue[/:taskId]` and the `IngestTaskSchema` SSOT. Verified by committed tests: heartbeat store semantics (6 assertions), an orchestrator liveness test (heartbeat advances over a held-open pipeline mock and stops after completion, 100 ms test cadence), and an API-exposure test; full server suite + all `/tmp/gates.sh` gates green. Re-running this session's repro (poll the row every 5 s during a slow provider ingest) now shows `updated_at` advancing every ~15 s during the `generation` leg.
