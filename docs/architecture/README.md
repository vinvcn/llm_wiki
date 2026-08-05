# LLM Wiki — LikeC4 architecture model

A machine-checkable, as-built architecture model of this repository in
[LikeC4](https://likec4.dev/) notation, living in
[`likec4/`](likec4/). It is a projection of concrete evidence — code with
file/line citations plus runtime artifacts observed on **2026-08-05** — not a
restatement of the design docs. The narrative as-built record remains
[`docs/PUSH1_ACTUAL_ARCHITECTURE.md`](../PUSH1_ACTUAL_ARCHITECTURE.md); this
model complements it with diagrams that fail validation when they drift
syntactically, and with per-element evidence metadata so drift can be audited.

Current model: **56 elements · 90 relationships · 9 views (7 static + 2
dynamic)**, authored against LikeC4 `1.59.2` and `v0.6.6` of this repo.

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

Evidence gathered for the model surfaced these as-built facts. They are
recorded here for traceability; each is also embedded in the relevant
element description.

1. **Two parallel backends.** The Tauri desktop shell embeds its own backend
   (Rust agent runtime, LanceDB, RRF search, `tiny_http` API/clip servers)
   parallel to the Node server's (JS agent runtime, sqlite-vec, RRF+graph
   search, Express). The MCP server and browser clipper target the desktop
   servers (`:19828`/`:19827`, `/api/v1`), not the Node `/api/v2` stack.
2. **Invoke bridge carries the traffic.** Most web-client commands still flow
   through legacy `invoke()` shims → `POST /api/invoke/:command` (72-command
   registry); several typed v2 client functions (e.g. `startChat`,
   `search`) have no production caller today.
3. **Dormant SSE manager.** `events/sse.js` (`SSEManager`) has zero importers;
   the live SSE transport is the legacy `addSseClient` path in `events.js`.
4. **Vestigial graph tables.** `graph_nodes`/`graph_edges` (migration 008)
   have no writer or reader in code; runtime rows: 0. The served graph is
   built on the fly from `[[wikilinks]]` in `wiki/*.md`.
5. **Port 19828 is intentionally shared.** The Node dev default and the
   desktop API server both use it so the web client's default
   `BACKEND=http://127.0.0.1:19828` works against either; running both on one
   host collides (EADDRINUSE) by construction.
6. **`/api/v1` only on the legacy entry.** `index-v2.js` does not mount v1;
   only `index.js` (`npm run server`) does, for desktop-parity clients.
7. **Dead/orphaned code spotted while tracing:** Milkdown is in
   `package.json` but never imported (editor is a textarea);
   `sweepResolvedReviews` has no production caller; client `mineru.ts` is
   used only by the Settings connection test; `retrievalMode` is a dead
   request field (search mode resolves from app-state `wikiSearchMode`);
   `deep_research.run` is registered as an agent tool but rejected by the
   loop (the client orchestrates deep research); worker-pool image
   extraction is currently invoked on the main thread instead of the pool.
8. **Contract nit:** `SearchResultSchema` in `packages/api-types` does not
   line up field-for-field with the payload `commands/search.js` actually
   returns (clients import the package type-only, so nothing fails at
   runtime). Candidate for a follow-up issue.
9. **Ingest progress persists only at stage boundaries**, so a healthy long
   LLM call reads as a stuck queue row — tracked in issue #32 and noted in
   the `ingestFlow` view description.

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
