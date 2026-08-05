# Promise vs. Actual — Architecture Review (2026-08-05, v0.6.6)

An independent review of the gap between the **chartered architecture**
([`V1_CHARTERED_ARCHITECTURE.md`](../../V1_CHARTERED_ARCHITECTURE.md) — "the
promise") and the **system as built and observed** (code at `v0.6.6`, runtime
probes of 2026-08-05, and the existing ledgers: issue #14's decision log and
[`PUSH1_ACTUAL_ARCHITECTURE.md`](../PUSH1_ACTUAL_ARCHITECTURE.md) §7 — "the
reality"). Companion artifacts: the
[LikeC4 as-built model](./README.md) and its `flags` view.

**Method.** Three layers, in descending authority:

1. **Code + runtime** (file:line citations; live probes of the dev server,
   the Docker container, and both `server.db` copies; see
   [README §Evidence methodology](./README.md#evidence-methodology)).
2. **The existing ledgers** — issue #14 (CLOSED 2026-08-04) and PUSH1 §7's
   accepted deviations G1–G17. This review spot-checked every ledger entry
   against code before relying on it.
3. **Prose docs** — used only where 1 and 2 agree with them.

Where this document says *verified*, the claim was re-derived from code or
runtime during this review, not copied from an earlier doc.

---

## 1. Executive summary

**Verdict: the promise was kept — inside a premise that turned out to be
false.**

- **13 of 17 charter decisions are REALIZED** as built and verified
  (four of them realized-with-extension or realized-with-inversion, noted
  individually). **1 is an accepted, ledgered deviation** (D9 graph index,
  G13). **1 is PARTIAL** (D11 worker pool). **1 is PARTIAL on a sub-claim**
  (D8 "auto OpenAPI / zero drift"). **1 is SUPERSEDED BY REALITY** (D6,
  desktop "deferred" — see below).
- **The existing ledgers are honest.** Every G1–G17 entry and every
  structural deviation in PUSH1 §7 was spot-checked against code and
  confirmed accurate. Issue #14's checklist is genuinely closed (PRs
  #22, #23, #25, #27, #28, #29, #30, #31, all merged and verified present).
- **The charter's governing premise was inverted.** The Vision is "one
  server, N thin clients; desktop deferred to a v2 thin shell." In reality
  the desktop app is the *original, fat* product carrying a full parallel
  Rust backend (agent loop, LanceDB, ~80 IPC commands, its own `/api/v1`
  HTTP server), and the chartered web stack was built *beside* it, not
  above it. The two stacks share only disk state. Nothing in the charter
  addresses this, and nothing in the ledgers adjudicates it — it is a
  product fact, not a tracked deviation.
- **Eight new findings (NF-1 … NF-8)** that no existing ledger covers.
  None breaks user-visible behavior today. They are ledger hygiene (five),
  one dead-schema cleanup, one product decision (MCP/v1 topology), and one
  wording fix.
- **Residual risk is concentrated in two places:** the dual-backend
  duplication (every capability exists twice; a fix on one side never
  reaches the other) and the untyped surfaces outside the api-types SSOT
  (invoke bridge's 72 commands, the MCP server's hand-rolled client, the
  Rust desktop world).

---

## 2. Decision-by-decision ledger

Statuses: **REALIZED** (verified as promised) · **EXTENDED** (promise kept,
plus more) · **INVERTED** (kept, by the opposite mechanism) · **DEVIATED —
ACCEPTED** (in the G-ledger, re-verified) · **PARTIAL** · **SUPERSEDED**
(the decision's premise no longer describes reality).

| # | Charter decision | Status | As-built reality (verified) |
|---|---|---|---|
| 1 | Deployment: self-hosted only | **REALIZED** | Docker single container (`phase3-integration-llm-wiki-1`, `0.0.0.0:3000`, healthy) or desktop-local; no SaaS surface exists. v1 scope exclusions reaffirmed (PUSH1 §7). |
| 2 | Repo: monorepo + workspaces | **REALIZED** (struct. deviation accepted) | `packages/server`, `packages/api-types` workspaces; client stays at root `src/` (accepted structural deviation, issue #14 P3). |
| 3 | HTTP: Express | **REALIZED** | Express 5 in `index-v2.js`. Caveat: a second, non-Express legacy entry persists — see NF-7. |
| 4 | Connection: local + remote, simple login | **REALIZED · EXTENDED** | Auth modes `none \| token` with same-origin auto-detect, plus `auto` token bootstrap and `open` synonym; `LLM_WIKI_AUTH_MODE` honored, `AUTH_MODE` deprecated (`auth/config.js:9-33`; PR #22). Extension beyond charter, ledgered via issue #19. |
| 5 | Storage: files + SQLite hybrid | **REALIZED** | Wiki pages = files (`wiki/*.md`, Obsidian-compatible); metadata/vectors/queue/sessions = SQLite (`store/db.js`, migrations 001–013). Note: *graph* data is **not** in SQLite despite the charter line — see D9. |
| 6 | Desktop client v1: deferred | **SUPERSEDED** | The charter assumed a web-first world where desktop would return as a thin shell in v2. Reality: the desktop app is the original product and ships a full parallel Rust backend (`src-tauri/src`: agent runtime, LanceDB, ~80 IPC commands, `:19828` `/api/v1`, `:19827` clip server). The decision was never false so much as *premised on a history that didn't happen*. See NF-2/NF-7 and §5. |
| 7 | Ingest: server-driven | **REALIZED** | Full cutover (PR #28): orchestrator consumes `ingest_queue` (concurrency 2, FIFO, per-project serialization, 3-attempt retry cap = G6); the browser pipeline in `src/lib/ingest.ts` was deleted. LLM calls server-side. Verified in the live ingest trace (task id 3, 4m56s). |
| 8 | Contract: Zod-first, auto OpenAPI, zero drift | **REALIZED · INVERTED, PARTIAL on OpenAPI** | Inversion (accepted, #20/#23/PR #23): the SSOT is a shared `@llm-wiki/api-types` package consumed by server + client, not server-inferred types. Partial: OpenAPI is a **hand-maintained subset** (`openapi.js:33-41`), not auto-generated over the whole surface — see NF-5. Live drift exists in one unregistered schema (#38). |
| 9 | Graph: incremental index + rebuild | **DEVIATED — ACCEPTED** | G13, re-verified: `graph_nodes`/`graph_edges` are created (migration 008, `db.js:171`) but never written (0 rows in both observed DBs); the served graph is rebuilt on demand from `[[wikilinks]]` in `wiki/*.md` (`graph.js`). The tables are dead schema — cleanup filed (§6, R1). |
| 10 | Vector store: sqlite-vec | **REALIZED** | `vec0` virtual table live (PR #27); ingest writes chunks; search queries via `MATCH`. Degradation ledgered: no migration from `vectorstore.json` (G4), keyword fallback with `vectorUnavailableReason` (G5) — both re-verified (`commands/search.js:243-248`). |
| 11 | Process model: worker threads | **PARTIAL** | The pool exists and is genuinely used for preprocess (first real consumer per #14 P0 decision, `workers/tasks.js`, header cites charter §4.4). But the charter's three roles — *parsing, embedding, graph-rebuild* — narrowed to one: no embedding worker (network I/O on the main process), no graph worker (G13), and the registered `extractImages` handler is bypassed by the pipeline (main-thread call). Not on any ledger → NF-4. |
| 12 | Migration strategy: reorganize first | **REALIZED** | Workspace layout landed; migration completed; issue #14 closed the remaining gaps. Nothing double-moved. |
| 13 | SSE: global stream + fire-and-forget | **REALIZED, contract evolved** | Global stream live at `GET /api/v2/events` (25s ping); chat streams via global SSE with `runId` demux; fire-and-forget emission verified. Ledgered adjacent deviations: G12 (watcher on-demand), G14 (dead `SSEManager`), G15/G16 (tool-step/tombstone). The **envelope/path contract itself changed** (`{type,projectId,payload}` → `{event,payload}`; `/api/v1/events` → `/api/v2/events`, `events.js:48`) — documented in PUSH1 §5 but never adjudicated in §7 → NF-3. |
| 14 | Auth: none by default, optional token | **REALIZED · EXTENDED** | Per D4. The `auto` mode (auto-generated token) is an extension beyond "optional token"; documented in RUNBOOK/DEPLOYMENT, ledgered via #19. |
| 15 | Upload: multipart ≤10MB + chunked >10MB | **REALIZED** | Both paths live (multipart at `api/ingest.js:42-47`, chunked sessions PR #30; base64 remains only for in-editor content writes, `files.js:82-102`). Deviations G1–G3 (in-memory sessions, no cancel, per-chunk buffering) re-verified and ledgered. |
| 16 | Client state: Zustand + convention | **REALIZED, with nuance** | Stores follow the server-store/UI-store split; `sse-sync.ts` invalidates on the taxonomy events (PR #29). Nuance: the client retains substantial first-party pipelines that talk to LLM/proxy directly (NF-6), which is in mild tension with the "clients send intents" convention. |
| 17 | Errors: ~10 codes + rich details | **REALIZED · EXTENDED** | All ten chartered codes present with the `{error:{code,message,details}}` envelope (`packages/api-types/src/errors.ts:13-23`), plus one addition: `PROJECT_NOT_FOUND`. |

**Score: 13 REALIZED (4 with extensions/inversion noted) · 1 DEVIATED-ACCEPTED
· 1 PARTIAL (D11) · 1 PARTIAL-sub-claim (D8 OpenAPI) · 1 SUPERSEDED (D6).**

---

## 3. Ledger verification — issue #14 and PUSH1 §7

The review treated the existing ledgers as claims to verify, not sources to
trust. Result: **all confirmed accurate.** Spot checks performed:

- **G1–G3 (chunked upload):** in-memory session map, no cancel route,
  per-chunk buffering — confirmed against the upload implementation; client
  chunk size 5MB as documented.
- **G4/G5 (sqlite-vec):** no migration path; degradation emits
  `vectorUnavailableReason` and never fails the request
  (`commands/search.js:243-248`).
- **G6–G11 (ingest):** retry cap 3 → terminal `failed`; in-flight turns lost
  on restart (runs map in `agent.js`); desktop-CLI providers fail fast at
  claim; JS image extraction; MinerU fallback — all consistent with
  `ingest/orchestrator.js` + `ingest/pipeline.js`.
- **G12:** file watcher starts only on client request — confirmed.
- **G13:** graph tables 0 rows in both observed DBs; no writer in the code.
- **G14:** `events/sse.js` has **zero importers** (verified via import
  graph); the live transport is `addSseClient` (`api/events.js:12,30`).
  *Discrepancy within the ledger's own neighborhood:* comments at
  `events.js:11,44` still claim the opposite of the import graph — stale
  comments that misdirect editors (already flagged as model flag
  `obsSseDormant`).
- **G15/G16:** cross-tab tool-step rendering and `ownedRunIds` tombstones —
  confirmed in the client.
- **G17:** Dockerfile and CI build `api-types` before server/client —
  confirmed.
- **Structural deviations (5):** plain-JS server, `commands/` layout, root
  `src/` client, absolute-path projects, no `packages/desktop/` placeholder —
  all confirmed as-built.
- **Issue #14 checklist:** every checkbox corresponds to a merged PR
  (#22 auth env, #23 api-types SSOT, #25 chat persistence + session UI,
  #27 sqlite-vec + retrieval mode, #28 ingest cutover, #29 SSE taxonomy,
  #30 chunked upload, #31 doc pass). Each PR's content verified present in
  the tree. Closure was legitimate, not administrative.

**Conclusion:** the housekeeping discipline ("charter pristine; ledger is
the reality") held for everything the ledger *contains*. The findings below
are about what it *doesn't* contain.

---

## 4. New findings (not covered by any existing ledger)

Severity guide: **[cleanup]** delete/rename work · **[ledger]** needs a §7
entry or charter annotation · **[decision]** needs a product call.

### NF-1 · Vestigial `reviews` table **[cleanup]**
`store/db.js:142` creates a `reviews` table; nothing writes or reads it
(0 rows in both observed databases). Reviews are actually served from
`.llm-wiki/review.json` (`api/reviews.js`; v1 route `api-v1.js:170`). This
is the exact sibling of the G13 graph tables — dead schema kept alive only
by its CREATE statement — but unlike the graph tables it never got a ledger
entry. → Folded into the cleanup issue filed with this review (R1).

### NF-2 · Charter §7's MCP topology is unrealizable against the deployed web server **[decision]**
Charter §7 promised MCP → the server's HTTP API via `LLM_WIKI_API_BASE_URL`.
Actual: the MCP server honors the env var but defaults to
`http://127.0.0.1:19828` (`mcp-server/src/api-client.ts:1,141,166`,
`index.ts:509`) — which is the **desktop's Rust** `/api/v1` server. The Node
entry that Docker runs (`index-v2.js`) **never mounts `/api/v1`**; only the
legacy `index.js` does (`index.js:124-201`). Consequence: pointing
`LLM_WIKI_API_BASE_URL` at the Docker deployment cannot work — the endpoint
family is absent, not just the URL. MCP and the browser clipper are, de
facto, desktop-only integrations. Model flag: `obsV1Legacy`. → R3.

### NF-3 · SSE envelope/path rename was never adjudicated **[ledger]**
Charter §4.7 specified envelope `{type, projectId, payload}` on
`/api/v1/events`. Actual: `{event, payload}` on `/api/v2/events`
(`events.js:48`). The change is *described* in PUSH1 §5 but has no acceptance
entry in §7, even though adjacent SSE deviations (G12, G14–G16) all got one.
A consumer built from the charter would fail on first parse. → R2.

### NF-4 · Worker pool silently narrower than Decision 11 **[ledger]**
Decision 11 and charter §4.4 name three worker roles: parsing, embedding,
graph-rebuild. `workers/tasks.js` registers only `preprocess` and
`extractImages`; embedding runs on the main process (network I/O) and graph
work is on-demand rebuild (G13). Additionally, the pipeline calls image
extraction on the main thread instead of dispatching to the registered
`extractImages` handler (`ingest/pipeline.js` — model flag `obsOrphans` #6).
The narrowing may well be correct, but it is unledgered scope reduction of a
charter decision. → R2.

### NF-5 · "Auto OpenAPI, zero drift" holds only for a subset **[ledger]**
Decision 8 promised auto-generated OpenAPI with zero drift. Actual:
`openapi.js:33-41` registers a deliberate subset (Project, CreateProject,
UpdateProject, Error, ChatSession, ChatMessage, ChunkedUpload*); the search,
ingest, and invoke surfaces are not described. Combined with issue #38
(`SearchResultSchema` under-describes the live payload), "zero drift" is true
only within the registered subset. → R2 (rename the claim to "documented
subset" or grow coverage; the former is the honest, cheap option).

### NF-6 · The client is not the thin shell the Vision describes **[decision]**
Vision §1: "Clients are thin UI shells that render state and send intents."
Actual: `src/lib/` carries first-party pipelines — deep research
(`deep-research.ts`), dedup (`dedup*.ts`), lint (`lint*.ts`), image
captioning, embedding helpers — with direct LLM calls via `/api/proxy`
(`llm-client.ts`; proxy callers `src/App.tsx`, `src/web/http.ts`). PUSH1 §5's
"all LLM work is server-side" is true for ingest and chat, **not** for these
auxiliary pipelines (keys stay server-side via the proxy, but the driving
logic is client-side). This is the pre-cutover world surviving in the
auxiliaries. → R5: either correct the prose or plan a server-side move;
low urgency, no user-visible harm.

### NF-7 · Two live server entries where one was chartered **[ledger]**
Decision 3 + charter §3 assume a single Express entry. Actual: `index-v2.js`
(Docker CMD, `/api/v2`) **plus** the legacy raw-`node:http` `index.js`
(`npm run server`), which is the sole mount of `/api/v1` and therefore the
only entry the MCP server/clipper can talk to (NF-2). PUSH1 documents both
entries but no ledger entry says the legacy one is retained *intentionally,
until X*. → R2/R3: give it a sunset condition or promote it.

### NF-8 · Chat streaming shape evolved without a ledger entry **[ledger]**
Charter §4.2 sketched POST-to-chat returning the stream in the response.
Actual (verified in the 2026-08-05 live trace and the `chatFlow` dynamic
view): POST returns `{runId, sessionId}` immediately; tokens stream over the
global SSE; messages persist at turn boundaries (PR #25). The new shape is
arguably *more* consistent with Decision 13's global stream — but the change
itself is unledgered. → R2, one line.

---

## 5. Structural assessment

Two risks dominate the forward-looking picture; neither is a charter
violation, and neither is currently ledgered.

**S1 · Dual backends.** Every server capability exists twice — JS
(`packages/server`, `/api/v2` + 72-command invoke bridge, sqlite-vec) and
Rust (`src-tauri`, `/api/v1` + ~80 IPC commands, LanceDB). The stacks share
only project directories and `app-state.json`. A fix, schema change, or
prompt improvement lands on one side and silently never reaches the other.
The LikeC4 model's `dualBackends` view makes the mirror visible. Unification
is a product decision; until it is made, the cost should at least be named.

**S2 · Typed surface is a subset of the real surface.** The api-types SSOT
covers the v2 REST minority; the invoke bridge (which carries most web
traffic), the MCP client (hand-rolled interfaces, no api-types dependency),
and the desktop IPC world are all untyped. Zero-drift protection therefore
applies to the surface least used. Issue #38 is the first observed symptom.

Both were captured as model flags (`obsInvokeBridge`, `obsSearchSchema`) in
the LikeC4 model; this review records them as architectural risks rather
than bugs.

---

## 6. Recommendations

| # | Action | Effort | Finding |
|---|---|---|---|
| R1 | File a cleanup issue for dead SQLite schema: `graph_nodes`/`graph_edges` (migration 008) **and** `reviews` (`db.js:142`) — drop in a new migration once their 0-row/no-reference status is re-confirmed on the owner's live data. | S | NF-1, D9 |
| R2 | Append ledger entries (G18-style) to PUSH1 §7 for: SSE envelope/path rename (NF-3), worker-pool scope narrowing (NF-4), OpenAPI "documented subset" re-scoping (NF-5), legacy-entry retention with sunset condition (NF-7), chat stream shape (NF-8). | S | NF-3/4/5/7/8 |
| R3 | Decide the MCP/v1 topology: either mount a v1-compatible surface on `index-v2.js` (makes charter §7 realizable against Docker) or annotate charter §7 + MCP docs to say desktop-only. | M (mount) / S (annotate) | NF-2, NF-7 |
| R4 | Keep `V1_CHARTERED_ARCHITECTURE.md` pristine per house convention, but add one pointer line in its header blockquote to this review, so readers of the promise meet the premise-inversion (D6/S1) immediately. | XS | D6, S1 |
| R5 | NF-6: accept client-side auxiliary pipelines as-is and fix PUSH1 §5 wording ("all *ingest and chat* LLM work is server-side"), or queue a server-side migration for deep-research/dedup/lint. Recommend: fix wording now, migrate opportunistically. | S | NF-6 |
| R6 | Keep the LikeC4 model's flags in sync as R1–R3 land: delete each `flag` element + edges and strike its README entry in the resolving PR (per the model's maintenance rules). | XS each | — |

**Done as part of this review:** R1's issue filed (link in PR), the
`obsGraphTables` model flag extended to cover the `reviews` table, and R4's
pointer added to the charter header (same commit as this document).

---

## 7. Appendix — evidence index

| Claim | Evidence |
|---|---|
| Error codes (10 + PROJECT_NOT_FOUND) | `packages/api-types/src/errors.ts:13-23` |
| Auth modes + deprecation | `packages/server/src/auth/config.js:9-33` |
| SSE envelope `{event, payload}` | `packages/server/src/events.js:48`; clients via `api/events.js:12,30` |
| `events/sse.js` dormant | zero importers (import-graph grep); stale comments `events.js:11,44` |
| OpenAPI subset | `packages/server/src/api/openapi.js:33-41` |
| Vestigial tables | `store/db.js:142` (reviews), `store/db.js:171` (migration 008); 0 rows in both runtime DB dumps; reviews served from `.llm-wiki/review.json` (`api/reviews.js`, `api-v1.js:170`) |
| Worker pool scope | `packages/server/src/workers/tasks.js` (only `preprocess` + `extractImages`; header cites charter §4.4); bypass in `ingest/pipeline.js` |
| MCP default target | `mcp-server/src/api-client.ts:1,141,166`; `mcp-server/src/index.ts:509` |
| `/api/v1` mount only on legacy entry | `index.js:124-201` route table; absent from `index-v2.js` |
| Search payload vs schema drift | `commands/search.js:338-342` (keyword leg), `:213-221` (vector leg) vs `packages/api-types/src/schemas/search.ts` (issue #38) |
| Upload mechanisms | multipart `api/ingest.js:42-47`; base64 editor writes `api/files.js:82-102`; chunked PR #30 |
| Client pipelines / proxy | `src/lib/deep-research.ts`, `src/lib/dedup*.ts`, `src/lib/lint*.ts`, `src/lib/llm-client.ts`; proxy callers `src/App.tsx`, `src/web/http.ts` |
| Runtime shapes | dev run `127.0.0.1:19828` health `{ok, version 0.6.6, commands 72}`; Docker `0.0.0.0:3000` healthy, banner commands 75; live chat turn + ingest task id 3 traces (2026-08-05) |

Cross-references: [LikeC4 model + observations](./README.md) ·
[PUSH1_ACTUAL_ARCHITECTURE.md](../PUSH1_ACTUAL_ARCHITECTURE.md) ·
[V1_CHARTERED_ARCHITECTURE.md](../../V1_CHARTERED_ARCHITECTURE.md) ·
issues #14 (closed), #19, #20, #21, #32, #38.
