# LLM Wiki — LikeC4 architecture model

A machine-checkable, as-built architecture model of this repository in
[LikeC4](https://likec4.dev/) notation, living in
[`likec4/`](likec4/). It is a projection of concrete evidence — code with
file/line citations plus runtime artifacts observed on **2026-08-05** — not a
restatement of the design docs. The narrative as-built record remains
[`docs/PUSH1_ACTUAL_ARCHITECTURE.md`](../PUSH1_ACTUAL_ARCHITECTURE.md); this
model complements it with diagrams that fail validation when they drift
syntactically, and with per-element evidence metadata so drift can be audited.

Current model: **64 elements · 120 relationships · 11 views (9 static + 2
dynamic)**, authored against LikeC4 `1.59.2` and `v0.6.6` of this repo.
Eight of the elements are amber **flag** nodes — audit findings anchored to
the elements they concern (see §Observations and the `flags` view).

## Viewing and tooling

```bash
# syntax + reference check (the gate; run after any edit)
npx -y likec4@1.59.2 validate docs/architecture/likec4

# live editor UI with all views, drill-down navigation and auto-layout
npx -y likec4@1.59.2 serve docs/architecture/likec4

# static exports (png | svg | drawio | json; --scale for resolution)
npx -y likec4@1.59.2 export png docs/architecture/likec4 -o out --scale 2

# codegen of the model as TS/JSON for downstream tooling
npx -y likec4@1.59.2 gen docs/architecture/likec4
```

The [LikeC4 VS Code extension](https://marketplace.visualstudio.com/items?itemName=likec4.likec4)
gives per-file live preview, autocomplete and go-to-definition over the same
model; its bundled MCP server also exposes the views to agent hosts. Pin the
CLI version (`likec4@1.59.2`) when reproducing exports — layout differs
between LikeC4 releases.

## Files

| File | Content |
|---|---|
| `likec4/specification.c4` | Element kinds (person/system/webapp/desktop/service/component/database/filestore/external/node) with explicit shapes, and the `async` relationship kind (dotted, for SSE/event flows). |
| `likec4/model.c4` | System context: owner, the LLM Wiki system boundary, external providers/services (LLM, embeddings, MinerU, web search, AnyTXT, CLI engines, MCP host) and the three shared data stores. |
| `likec4/model-server.c4` | Node server container (`index-v2.js`, Express 5): 19 components — HTTP surface, v2 API routers, SSE, invoke bridge, proxy, OpenAPI doc, agent runtime + tools, ingest orchestrator + 14-stage pipeline, search + graph engines, store layer, worker pool, CLI transports — plus the legacy `index.js` v1 server. |
| `likec4/model-client.c4` | Web client (React SPA, one codebase / two builds): app shell, chat panel, zustand state, v2 REST+SSE client, invoke transport + web shims, client LLM client, client-side pipelines. |
| `likec4/model-desktop.c4` | Desktop surface (Tauri + Rust shell with its *parallel* backend stack: ~80 IPC commands, Rust agent runtime, LanceDB, `:19828` API server, `:19827` clip server, tray), MCP server, browser clipper, and deployment nodes. |
| `likec4/model-flags.c4` | The 8 audit findings as amber `flag` elements, each wired to the element(s) it concerns — the diagrams' counterpart of §Observations below. |
| `likec4/views.c4` | The 9 views below. Scoped views (`view of X`) double as drill-down targets in the served UI. |

## View guide

| View | Shows |
|---|---|
| `index` | Full system context, every element. Start here. |
| `containers` | The two parallel backends (Node web stack vs Tauri/Rust desktop stack), the shared React client, MCP/clipper entry points, and who touches which store/provider. |
| `serverComponents` | Inside the Node server: request surface → routers → agent/ingest/search engines → stores, including the legacy invoke bridge that still carries most web-client traffic. |
| `clientComponents` | Inside the React client: which panel talks to which transport, and the split between backend-agent turns and client-side LLM calls. |
| `desktopSurface` | Tauri shell internals plus the MCP server and browser clipper, both of which target the **desktop** localhost servers, not the Node server. |
| `dataLayer` | Who reads/writes `server.db`, `app-state.json`, and the project directories — the cross-backend data-sharing story. |
| `dualBackends` | The two backend stacks side by side, functionally equivalent parts joined by dashed `parallel` edges (Express vs tiny_http, sqlite-vec vs LanceDB, ~72 vs ~80 commands). |
| `flags` | Audit map: every observation as an amber flag node wired to where it lives. The visual index into §Observations. |
| `chatFlow` (dynamic) | One grounded Q&A turn in web mode, steps 1–13, traced from the live 2026-08-05 session and cross-checked against `agent.js`/`events.js`. Includes the tool loop (`MAX_ITER 8`). |
| `ingestFlow` (dynamic) | Source drop → wiki pages + embeddings, steps 1–16, with the optional MinerU and cache-hit branches; stage percents match `ingest/progress.js`. |
| `deployment` | Observed runtime shapes: Docker container (`phase3-integration-llm-wiki-1`, healthy, `0.0.0.0:3000`), desktop host, and the dev worktree run. |

## Evidence methodology

Every element carries a `metadata { evidence '…' }` entry naming the files it
was derived from; descriptions embed measured constants (ports, caps, stage
percents, table names). Sources used, in order of weight:

1. **Code reading with file/line citations** across `packages/server/src`,
   `src/`, `src-tauri/src`, `mcp-server/src`, `extension/`, `Dockerfile`,
   `docker-compose.yml`, `packages/api-types/src`.
2. **Live runtime probes (2026-08-05):**
   - dev-run Node server (`node packages/server/src/index-v2.js` from a git
     worktree, pid observed on `127.0.0.1:19828`): `/api/v2/health` →
     `{ok, version 0.6.6, commands 72}`.
   - Docker container `phase3-integration-llm-wiki-1` on `0.0.0.0:3000`,
     `Up (healthy)`, banner `commands: 75`; `docker inspect` for env, volumes,
     image layout (`/app` + `/data`).
   - SQLite schema + row counts dumped from `server.db` (host
     `~/.llm-wiki-server` and container `/data`): migrations 001–013,
     `vec_chunks` populated, `graph_nodes`/`graph_edges` empty.
   - redacted `app-state.json` key inventory; project tree + wiki frontmatter
     sampled from a live project; `ingest-warnings.log` for guardrail
     behavior; the acceptance session trace (chat turn + PDF ingest task id 3,
     4m56s) behind the two dynamic views.
3. **Cross-checking**: where prose docs (`PUSH1_ACTUAL_ARCHITECTURE.md`,
   `API_REFERENCE.md`, `DEPLOYMENT.md`) disagree with code or runtime, the
   model follows code/runtime and the discrepancy is flagged below.

## Observations and flags

The 2026-08-05 audit produced **8 findings**. Each is a first-class amber
`flag` element in [`likec4/model-flags.c4`](likec4/model-flags.c4), wired to
the element(s) it concerns and rendered in the `flags` view — the diagrams
show *where* each observation lives. Below they are grouped by theme rather
than listed flat: **structural** (designed this way), **vestige**
(superseded code), **contract** (SSOT drift), **operational** (runtime UX).
Every entry carries where-it-lives pointers and a verdict/next-step.

### A. Structural — the dual-backend topology

**A1 · Two parallel backends** — see `dualBackends` view; container-level
`parallel` edge in `model.c4`.
The Tauri desktop shell does not call the Node server; it ships a Rust
implementation of the same jobs: agent loop (`src-tauri/src/agent/*` vs
`packages/server/src/agent.js`), vector index (LanceDB vs sqlite-vec), HTTP
API (`api_server.rs` `/api/v1` :19828 vs Express `/api/v2`), command
registry (~80 IPC commands vs ~72 invoke commands). The stacks share only
on-disk state (project dirs + `app-state.json`).
*Why:* the desktop app is the original product; web mode (PR #1) added a
parallel JS stack rather than reusing the Rust one. *Verdict:* product-level
design decision, not a bug; unification is an open product question. The
consequence to keep in mind: every server-side capability exists twice, and
a fix on one side never reaches the other.

**A2 · `/api/v1` only on the legacy entry** — `obsV1Legacy`.
`index-v2.js` (the Docker CMD) never mounts `/api/v1`; only `index.js`
(`npm run server`, route table `index.js:124-201`) does. The v1 consumers —
MCP server and browser clipper — therefore reach the desktop servers only,
never the deployed web server.
*Verdict:* intentional topology. If MCP-against-Docker is ever wanted, this
missing mount is the gap to close.

**A3 · Port 19828 shared by design** — `obsSharedPort`.
The desktop API server binds 19828 and the Node dev default `PORT` is also
19828 (`config.js`), so the web client's hard-coded default
`BACKEND=http://127.0.0.1:19828` works against either backend. Docker
publishes 3000 (`0.0.0.0:3000->3000` in compose).
*Verdict:* intentional convenience with a known price — running both on one
host fails EADDRINUSE unless `PORT` is overridden. Document, don't silently
"fix".

### B. Traffic reality vs the typed surface

**B1 · Invoke bridge is the live client path** — `obsInvokeBridge`.
The web UI sends most commands through the legacy `invoke()` shim →
`POST /api/invoke/:command` (72-command registry, `invoke.js`). The typed v2
surface is partially ornamental: `startChat` (`src/api/chat.ts:74`) and
`search` (`src/api/search.ts:52`) have zero production callers, while
session CRUD and ingest REST are live.
*Verdict:* migration debt; the v2 surface is the intended destination (#24).
Practical rule when reading client code: `invoke('x')` in the web build is
an HTTP call into the legacy registry.

**B2 · Search schema drift → issue #38** — `obsSearchSchema` (contract).
`SearchResultSchema` (`packages/api-types/src/schemas/search.ts`) declares
`{path, score, snippet?, content?}`, but the live payload carries
`{path, title, snippet, titleMatch, score, images, [vectorScore],
[content]}` (`commands/search.js:338-342` keyword leg, `:213-221` vector
leg). Zod parse strips unknown keys, so validating a real response silently
drops fields.
*Verdict:* filed as issue #38. Harmless today only because imports are
type-only and search is not in the OpenAPI subset.

### C. Vestiges — superseded, not deleted

**C1 · Dormant SSE manager + stale comments** — `obsSseDormant`.
`SSEManager` in `events/sse.js` has zero importers; `/api/v2/events`
registers clients via `addSseClient` (`api/events.js:12,30`). Trap: comments
at `events.js:11,44` still claim the opposite, so an editor picks the wrong
file.
*Verdict:* cleanup candidate — delete or wire the manager, and fix the
comments either way.

**C2 · Vestigial graph tables** — `obsGraphTables`.
Migration `008_graph_nodes_edges` (`store/db.js:171`) created
`graph_nodes`/`graph_edges`, but nothing writes or reads them (0 rows in
both observed DBs); the served graph is built on the fly from
`[[wikilinks]]` (`graph.js`).
*Verdict:* dead-schema cleanup candidate; the as-built markdown-as-truth
design is arguably the better one (keeps the vault Obsidian-compatible).

**C3 · Orphan sweep, six items** — `obsOrphans`.
1. `@milkdown/*` deps (`package.json:33-35`) never imported — the rich
   editor never shipped, the textarea is the editor.
2. `sweepResolvedReviews` (`src/lib/sweep-reviews.ts`) imported only by its
   tests — no production caller.
3. client `mineru.ts` used solely by the Settings connection test
   (`mineru-section.tsx`).
4. `retrievalMode` persisted in the chat store
   (`src/stores/chat-store.ts:63`) but never sent to any backend — server
   search mode resolves from app-state `wikiSearchMode`
   (`commands/search.js:243-248`).
5. `deep_research.run` registered with an executor
   (`agent-tools.js:51,212-222`) but loop-rejected via
   `LOOP_TOOL_REJECTIONS` (`agent.js:108`) — the client orchestrates deep
   research.
6. image extraction bypasses the worker pool built for it
   (`ingest/pipeline.js`).
*Verdict:* one tidy-up PR's worth; dangerous to copy from, harmless to run.

### D. Operational

**D1 · Ingest progress frozen mid-stage → issue #32** — `obsIngestProgress`.
Percent persists only at stage boundaries (`touchIngestTask` +
`ingest:progress` SSE); a healthy multi-minute analysis/generation call
leaves the queue row unchanged, indistinguishable from a stuck run.
*Verdict:* tracked in issue #32 (heartbeat). Operational takeaway: don't
kill or retry "stuck" tasks prematurely.

## Maintenance rules

- Update the model in the same PR as structural changes (new container,
  renamed route group, new store, port change). Cosmetic code moves do not
  require it.
- Keep `metadata.evidence` on every element; when an element changes, refresh
  its evidence string in the same edit.
- Run `npx -y likec4@1.59.2 validate docs/architecture/likec4` before merge;
  it is cheap and catches dangling references and syntax drift.
- When this model, `PUSH1_ACTUAL_ARCHITECTURE.md`, and the code disagree,
  **code wins**; fix the model (and the prose doc) rather than letting both
  rot quietly.
- Flags are elements: when a finding is resolved, delete its `flag` element
  and edges in `likec4/model-flags.c4` and strike its entry here in the same
  PR (link the resolving PR/issue in the commit message).
