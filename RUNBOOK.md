# LLM Wiki — Web Client + Server Runbook

This runbook documents the **browser client + backend server** deployment of
LLM Wiki. The original project is a Tauri desktop app; this runbook covers the
converted architecture where the UI runs in any modern browser and all native
work is done by a standalone Node.js backend.

> The desktop app is **unchanged** and still buildable (`npm run tauri dev` /
> `npm run build:desktop`, requires a Rust toolchain). The web build is an
> additional target that reuses the exact same React frontend.

---

## Architecture

```
┌──────────────────────────────┐   HTTP / SSE   ┌─────────────────────────────┐
│  Browser (React SPA)         │ ◄────────────► │  llm-wiki-server (Node.js)  │
│  - same React code as desktop│                │  - serves the built SPA     │
│  - Tauri APIs swapped for    │   /api/invoke  │  - 76 backend commands      │
│    web shims (Vite aliases)  │   /api/events  │  - persistent KV store      │
│                              │   /api/store   │  - raw file streaming       │
│                              │   /api/proxy   │  - outbound LLM proxy       │
└──────────────────────────────┘                │  - source-folder watcher    │
                                                └──────────────┬──────────────┘
                                                               │
                                          server filesystem (projects, wiki)
                                          + outbound HTTPS to LLM providers
```

The browser never touches the filesystem or LLM providers directly:

- **`invoke(command, args)`** → `POST /api/invoke/:command` (the same command
  names the desktop app uses, so the unmodified frontend works against either
  backend).
- **Tauri events** (file-sync, agent) → a single Server-Sent Events stream at
  `/api/events`.
- **plugin-store** (settings) → `/api/store/:name`, persisted as JSON files on
  the server.
- **Local file previews / images** → `/api/raw?path=…` streams the file.
- **Cross-origin LLM / embedding calls** → `/api/proxy` (a streaming proxy that
  replaces the desktop app's Rust HTTP plugin, so providers without CORS
  headers still work).
- **Folder / file dialogs** → an in-app picker modal that browses the *server's*
  filesystem (the browser has no access to it otherwise).

---

## One backend, shared user data (desktop + web)

LLM Wiki is designed so one user can run the **desktop app and the web app
against the same data**: anything you add or edit in one client is usable in
the other. You do **not** change or rebuild the desktop app — the web server
reads and writes the *same* on-disk state the desktop uses. The supported
topology is **same host** (or a shared mount): run the web server on the
machine where your projects live, as the same OS user.

What is shared, and how fresh it is:

| User data | Where it lives | Cross-client freshness |
|---|---|---|
| Wiki pages, sources, schema | `<project>/wiki`, `<project>/raw/sources` | **Live.** Same files on disk. The web UI auto-refreshes its file tree — and reloads an open page you are *not* currently editing — when the desktop changes a file (server filesystem watch + SSE). |
| Per-project state (chat history, review/lint items, ingest queue, file history) | chat / review / file history: `<project>/.llm-wiki/*.json`; **ingest queue: the shared server SQLite `ingest_queue`** (both clients enqueue + observe the SAME rows — the desktop's standalone `.llm-wiki/ingest-queue.json` client driver was retired with the server-driven-ingest cutover, issue #14 P0 stage 9, where desktop ingest requires the reachable server too) | **Live.** Read from disk on every access by both clients (no in-memory cache), so a chat/review/queue item added on one client shows on the other at next view. **Review items live-reload too**: the project watcher allowlists `.llm-wiki/review.json` on `project://files-changed`, so a review item added/resolved on the desktop appears in the open web Review view without a manual Refresh (issue #13 item 3; the server's own writes stay suppressed via app-write-ignore). The source-watch state (`file-snapshot.json` / `file-change-queue.json`) is written by the web server in the desktop's exact on-disk format, so both watchers share one consistent snapshot/queue (see the "Source-folder auto-watch" row in the matrix). |
| Chat context + Agent sessions (model history for UI, `/api/v1/chat`, MCP, and `agent_get_session`/`agent_list_sessions`) | `<project>/.llm-wiki/agent-sessions/<sessionId>.json` | **Live / shared format.** The web server reads and writes the desktop's exact `AgentSession` serde files (`agent-sessions.js` port of `session.rs`): UI turns keep the client-held `conversations.json` history round-trip on BOTH builds (continuing a desktop-created conversation on the web keeps its full context), history-less callers hydrate the last 12 messages from the shared files, and successful turns append there when `persistSession !== false` (the desktop default) — so an API/MCP chat started on either client resumes with the same context on the other. |
| App settings, provider keys, recents, last project | the desktop plugin-store file (`app-state.json`) | **Shared on disk.** The web server uses the desktop's own store file. Web reads see desktop edits immediately (mtime-aware); web writes are key-level, so they never clobber an unrelated key the desktop changed. The Settings view's full section list renders from the shared store in the headless browser e2e (gate 9). |

How the web server locates the desktop store file:

- **Automatic (same host):** on start it scans the OS app-data dirs for the
  bundle id `com.llmwiki.app` (Linux `~/.local/share/com.llmwiki.app/`,
  macOS `~/Library/Application Support/com.llmwiki.app/`, Windows
  `%APPDATA%\com.llmwiki.app\`) and, if it finds an `app-state.json` with
  LLM Wiki keys, adopts it. `/api/health` then reports `store.shared: true`,
  `store.source: "auto"`.
- **Explicit:** `LLM_WIKI_STORE_FILE=/abs/path/app-state.json` points at any
  store file (`store.source: "explicit"`).
- **Web-only:** `LLM_WIKI_NO_SHARE=1` keeps web settings isolated in
  `LLM_WIKI_DATA_DIR/stores` (the original behavior).

All three branches are pinned by the standing shared-data gate
(`scripts/verify/verify-filesync-shared.mjs`, both server entries): the
explicit branch via `LLM_WIKI_STORE_FILE`, the auto branch by booting with a
marker `app-state.json` planted in the desktop bundle app-data dir
(`XDG_DATA_HOME`/`HOME`/`APPDATA`) and asserting live reads, key-level
non-clobber writes and no-restart out-of-band edits, and the `NO_SHARE` branch
by asserting the desktop marker stays byte-identical while web writes land
only in `LLM_WIKI_DATA_DIR/stores`.

One honest caveat (inherent to two clients sharing one file): the **desktop**
holds settings in memory and rewrites the whole file on autosave, so a setting
changed on the **web** reaches a *running* desktop only after a desktop
restart — whereas the web picks up desktop edits with no restart. Project
content and per-project state have **no** such caveat: they sync live both
ways because they are read from disk on access. If you edit the *same* setting
on both clients simultaneously, last writer wins — configure settings from one
client to avoid this.

Vector index note: the index bytes are per-client **derived data** — neither
client reads the other's index. The desktop keeps LanceDB under
`.llm-wiki/lancedb`; the web server keeps a sqlite-vec cosine index
(`vec_chunks` / `vec_pages` vec0 tables, `score = 1/(1+distance)`) in the
server database (`LLM_WIKI_DATA_DIR/server.db`, keyed by the stable project
UUID). Both are rebuilt from the same wiki content (ingest upserts / Rebuild
wiki index), so keyword + vector + graph (RRF) rankings stay consistent across
clients even though the bytes differ; on hosts where the sqlite-vec extension
cannot load, vector writes no-op and search falls back to keyword+graph (the
desktop build is unaffected).


## Prerequisites

- **Node.js ≥ 20** (tested on v24). No Rust toolchain is needed for the web
  build or server.
- `npm` (ships with Node).

---

## Quick start (serve the built client from the server)

```bash
# 1. Install dependencies (root project; the server itself is dependency-free)
npm install

# 2. Build the browser client into ./dist-web
npm run build:web

# 3. Start the backend (serves the SPA + the API on the same origin)
npm run server

# 4. Open the client
#    http://127.0.0.1:19828
```

On first launch the server prints the URL, the number of registered commands,
and whether it found the web build. Open the URL, click **New Project** or
**Open Project**, and pick a folder on the *server* using the picker that
appears.

`npm run start:web` runs steps 2 + 3 in one command.

---

## Development workflow (hot reload)

Run the backend and the Vite dev server in two terminals. The dev server
proxies `/api` to the backend so the shims work unchanged.

```bash
# Terminal 1 — backend
npm run server                 # http://127.0.0.1:19828

# Terminal 2 — web dev server (proxies /api → 19828)
npm run dev:web                # http://localhost:1421
```

Edit `src/**` and the browser reloads. Edit `packages/server/src/**` and restart the
server (or `node --watch packages/server/src/index.js` via `npm --prefix packages/server run dev`).

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `LLM_WIKI_PORT` | `19828` | HTTP port for the server (and the served SPA). |
| `LLM_WIKI_HOST` | `127.0.0.1` | Bind host. Set `0.0.0.0` to expose on the LAN. |
| `LLM_WIKI_AUTH_MODE` | unset (auto) | Auth mode: `none` = open; `token` = token required on non-public routes; unset = auto (open until a token is configured). `open` = synonym of `none`. Legacy `AUTH_MODE` works as a deprecated alias; the primary wins when both are set. |
| `LLM_WIKI_API_TOKEN` | unset | API token for non-public routes (Bearer / `x-llm-wiki-token` / `?token=`). Required in `token` mode, or in auto mode once set. |
| `LLM_WIKI_DATA_DIR` | `~/.llm-wiki-server` | Server-side persistent state (the plugin-store JSON files). |
| `LLM_WIKI_MAX_UPLOAD_MB` | `50` | Maximum size in MB for a single file upload — the multipart route and each chunked-upload session's declared `fileSize` alike (clamped 1–4096, issue #14 P2). |
| `LLM_WIKI_WEB_DIST` | `<repo>/dist-web` | Directory of the built web client to serve. |
| `LLM_WIKI_BACKEND` | `http://127.0.0.1:19828` | Backend the *dev* server proxies `/api` to (`dev:web` only). |
| `LLM_WIKI_ALLOW_SHELL` | unset | Escape hatch: set to `1` to let the agent’s `shell.exec` tool run ANY command without the per-command approval prompt (off by default). When unset, the desktop’s per-command approval policy applies — workspace-scoped commands run, everything else needs the user’s Approve (see the `Agent shell.exec` matrix row). |
| `LLM_WIKI_CLIP_PORT` | `19827` | Port for the Chrome Web Clipper companion listener (the desktop's fixed port; the extension's settings accept a custom origin). If another process (e.g. the desktop app) owns it, the server reports `port_conflict` via `clip_server_status` and defers to it. |
| `LLM_WIKI_STORE_FILE` | unset | Absolute path to the plugin-store file to share. Overrides auto-detection; use to point the web server at the desktop's `app-state.json` (or a synced copy). |
| `LLM_WIKI_INGEST_HEARTBEAT_MS` | `15000` | Ingest liveness-heartbeat period while a task is processing (issue #32); the row's `heartbeat_at`/`updated_at` advance on this cadence so pollers can tell a healthy long LLM call from a hung run. Test hook only (clamped 100 ms–60 s; the cron line never sets it). |
| `LLM_WIKI_INGEST_CONCURRENCY` | `2` | Ingest orchestrator concurrency cap (clamped 1–16). Only the v2 entry (`npm run server` → `packages/server/src/index-v2.js`) runs the orchestrator. |
| `LLM_WIKI_NO_SHARE` | unset | Set to `1` to disable sharing and keep web settings isolated in `LLM_WIKI_DATA_DIR/stores`. |

Example — expose to your LAN on port 8080 with a custom data dir:

```bash
LLM_WIKI_HOST=0.0.0.0 LLM_WIKI_PORT=8080 LLM_WIKI_DATA_DIR=/var/lib/llm-wiki \
  npm run start:web
```

> When binding to `0.0.0.0`, the server and the proxy are reachable on the
> network. Treat the host as trusted; the server exposes the filesystem the
> process can see (projects, file picker, raw streaming), matching the desktop
> app's local trust model.

---

## How the conversion works (for maintainers)

The web build is produced by `vite.web.config.ts`, which adds `resolve.alias`
entries that redirect every `@tauri-apps/*` import to a browser shim under
`src/web/`:

| Import | Web shim | Backed by |
|---|---|---|
| `@tauri-apps/api/core` (`invoke`, `convertFileSrc`) | `src/web/core.ts` | `/api/invoke`, `/api/raw` |
| `@tauri-apps/api/event` (`listen`, `once`) | `src/web/event.ts` | `/api/events` (SSE) |
| `@tauri-apps/api/window` | `src/web/window.ts` | CSS theming / `document.title` |
| `@tauri-apps/plugin-dialog` | `src/web/dialog.ts` | server-backed picker modal |
| `@tauri-apps/plugin-store` | `src/web/store.ts` | `/api/store/:name` |
| `@tauri-apps/plugin-opener` | `src/web/opener.ts` | server-side OS open/reveal (`web_open_path` / `web_reveal_path`), `window.open` / `/api/raw` fallback |
| `@tauri-apps/plugin-autostart` | `src/web/autostart.ts` | no-op |
| `@tauri-apps/plugin-http` | `src/web/http.ts` | `/api/proxy` (cross-origin; **binary bodies byte-exact** — Blob/ArrayBuffer/TypedArray travel as `bodyBase64`, FormData as `formEntries`, the server rebuilds the raw bytes/multipart like the desktop's reqwest plugin) |

The shims are **only** pulled in by the web build. The desktop build keeps
using `vite.config.ts` with the real Tauri APIs, so `npm run tauri dev` and
`npm run build:desktop` are unaffected.

The backend command handlers live in `packages/server/src/commands/` and are faithful
Node ports of the Rust commands (filesystem, project scaffolding, keyword +
vector + graph search, page links, file history, source-folder watch,
server-side embeddings, the full web-search provider set (Firecrawl,
SearXNG, Tavily, Ollama, Brave, Bocha, SerpApi — a faithful Node port of
`run_web_search` + the per-provider clients in `src-tauri/src/agent/tools.rs`, so a provider/key configured in the shared settings works from
either client), embedded-image
extraction, the chat-agent runtime, and the claude-code/codex-cli transports).
Every command the frontend invokes is implemented — nothing throws a
"not available in web-server mode" error anymore. What remains in
`commands/misc.js` is only safe no-ops / status strings for OS-level shell
concepts that have no browser meaning (`set_close_behavior` still validates +
echoes the value with the desktop's exact error semantics, but a browser tab
cannot hook its own close). `clip_server_status` is REAL: the server hosts the
Chrome-clipper companion listener on :19827 (see the matrix row below), and
`api_server_status` reports "running" because the web server IS the API server. Note: `set_proxy_env` is NOT a no-op in the web
— it is a real, verified parity feature: the server applies `proxyConfig` from
the shared store at boot (`packages/server/src/proxy-env.js`,
`applyProxyFromStore`) and `set_proxy_env` enables/disables a working outbound
proxy for the server's fetches (agent web-search etc.) with the desktop's
exact summary strings (`enabled (<url>, bypass_local=true)` / `disabled` /
`disabled (unsupported scheme: <scheme>)` / `disabled (empty url)`);
`bypass_local` funnels localhost back to direct connections. The standing gate
for this row (`scripts/verify/verify-proxy-env.mjs`, formerly
`/tmp/verify-proxy.mjs`) is now RUNNING and green (68/68 per server entry): the
harness pins the full proxy.rs contract — `normalizeProxyConfig` /
`readProxyConfigFromStore` / `shouldBypass` exports, the exact boot log
(`[proxy] reading from <file>` + `[proxy] <summary>`), live set_proxy_env
toggles with byte-counted traffic through a real mock forward proxy (absolute-
form for plain-http targets on undici 8.x, CONNECT for https), NO_PROXY
bypass, `/api/proxy` and `web_search` proxying, and the desktop's error
semantics (`Invalid proxy config: …` / `Invalid close behavior: …`).

---

## Feature matrix: web mode vs desktop

Legend: ✅ works in the browser build · ⚠️ partial / opt-in · ❌ desktop-only (documented).

| Feature | Web mode | Notes |
|---|---|---|
| Create / open / switch projects | ✅ | server-backed folder picker; **creating** a project from the web (dialog → `schema.md`/`purpose.md` scaffolded on disk → opens in the UI), **switching** back to the welcome screen, and **opening** an existing (desktop-created) project through the picker are all covered by the headless e2e (gate 7/7) |
| File tree, wiki editing, preview | ✅ | Knowledge tree + Files tree + a wiki page render, plus an **edit → save → on-disk → re-render** round-trip through the raw Markdown editor, are proven end-to-end by the headless browser e2e (gate 34/34) — the web edit lands in `<project>/wiki/*.md` in the exact on-disk format the desktop reads, with zero page/console errors |
| Ingest — Markdown / text / HTML / code | ✅ | |
| Ingest — PDF / DOCX / PPTX / XLSX / ODF / EPUB / Org | ✅ | parsed server-side (pdfjs-dist + zip/xml); legacy `.xls` (SheetJS) and legacy `.doc` (word-extractor, verified against real Word 97–2003 fixtures) are covered by the rows below — only HUFF/CDIC `.mobi` must be converted first |
| Multimodal embedded-image extraction + vision captions | ✅ | server-side extraction for **PDF + DOCX + PPTX** (`packages/server/src/commands/extractImages.js`: pdfjs + a pure-Node PNG encoder re-encodes decoded PDF raster; OOXML embedded media are read straight from the zip) writes images to `wiki/media/<slug>/` with the exact camelCase `SavedImage`/`ExtractedImage` shapes, so vision captions run client-side over `/api/proxy`. Verified 18/18 isolated + e2e via `/api/invoke` (JPEG2000/JPX PDF images skipped gracefully) |
| Legacy spreadsheet `.xls` (BIFF/OLE2) | ✅ | parsed server-side via SheetJS (`xlsx`); verified by a BIFF8 write→extract round-trip (the desktop uses calamine). |
| Legacy Word `.doc` (OLE2) | ✅ | `word-extractor` (the exact npm dependency the desktop-class server ships) proves out against **real Word 97–2003 binaries vendored from the MIT-licensed word-extractor test corpus** (`packages/server/test/fixtures/word-doc/`): exact bodies for minimal/revisions+Unicode/table/complex docs, graceful convert-first error for invalid files, and the desktop `.cache` contract end-to-end — `preprocess_file` extracts and writes `<dir>/.cache/<name>.txt`, `read_file` short-circuits on the fresh cache (stale cache re-extracts) and returns the exact Rust image/media/legacy-doc placeholders, and the agent `source.search` tool matches `.doc` binaries only through a fresh cache. Verified 17/17 in the committed `legacy-doc.test.js` (full server suite green). Failures still degrade to the convert-first error and never crash ingest (desktop uses OLE2/antiword). |
| HUFF/CDIC `.mobi` | ⚠️ | not decoded (clear convert-to-EPUB error; desktop uses the `mobi` crate). PalmDOC/uncompressed `.mobi` is supported. |
| Keyword search | ✅ | Search panel (query → result count over server-side `search_project`) proven in the headless browser e2e (gate 9). The shared api-types `SearchResultSchema` SSOT now describes the live item shape exactly — `title`/`titleMatch`/`images`/`vectorScore` round-tripped through real `search_project` output (issue #38). |
| Vector / semantic search | ✅ | server-side sqlite-vec cosine store (`vec_chunks` vec0 table in the shared server DB, `score = 1/(1+distance)`); embeddings computed server-side (CORS-free); **blended into search ranking via RRF** (`keyword + vector + graph`, mirroring `apply_rrf_scores` + `search_by_embedding`), with vector-only hits materialized; graceful degradation when the sqlite-vec extension cannot load (writes no-op, searches return empty, callers fall back to keyword). The legacy v1 page-level commands (`vector_upsert` / `vector_search` / `vector_delete` / `vector_count` — the desktop's pre-0.3.11 `wiki_vectors` LanceDB contract) are also served (`vec_pages` table), accepting both the Rust snake_case and the web camelCase arg names. Page-id validation is a 1:1 port of `vectorstore.rs`'s `validate_page_id_common` (a 256-char boundary counting code points, not UTF-16 units, with every disallowed family — C0/C1 controls, `"/\` separators, soft hyphen, Arabic letter mark, zero-width/bidi/separator ranges, word-joiner/invisible operators, BOM, interlinear annotations, tags — rejected with the Rust `{:?}` char in the message, while `#`, CJK and emoji stems pass), and chunk-upsert error strings match Rust exactly (`Chunk #0 has empty embedding`, `Chunk #N has embedding dim X but batch dim is Y`). Verified 32/32 in the committed `vectorstore-sqlite.test.js` (the desktop's own `tests_v2` fixtures ported verbatim: unicode stems, 15 footguns, 256/257 boundary incl. CJK + astral, idempotent deletes, empty-upsert no-op, dim mismatch) plus the standing `scripts/verify/verify-vectorstore.mjs` gate (113 checks on both server entrypoints — v1 command round-trips, v2 chunk store, the full embedding-fetch contract, hybrid RRF search and restart persistence; it subsumes the old `/tmp/verify-v1-http.mjs` assertions). The index bytes are per-client derived data (desktop: LanceDB under `.llm-wiki/lancedb`; web server: sqlite-vec in `LLM_WIKI_DATA_DIR/server.db`) but rankings match because both rebuild from the same wiki content |
| Graph view (4-signal relevance, communities) | ✅ | computed client-side over the wiki files; the Graph panel is proven in the headless browser e2e (gate 9) |
| Graph-boosted search ranking / agent `graph.search` | ✅ | server-side wikilink neighbor-expansion (`packages/server/src/graph.js`), matching the desktop: search returns `mode: "hybrid"` with `graphHits` and synthesized "Graph neighbor of …" results; the agent `graph.search` tool returns `matched entity` + `direct neighbor` refs (verified against the desktop's own unit-test fixture, ported verbatim into `packages/server/test/graph-search.test.js`). The **wiring** is verified too: `packages/server/test/agent-graph-tool.test.js` drives real agent turns with a scripted mock LLM issuing `graph.search` (streaming + non-stream: exact toolStart → referenceAdded ×2 → toolEnd → messageDelta → done sequence, desktop `AgentReference`/camelCase `knowledgeContext` shapes, observation round-trip into the follow-up request) plus a keyword+graph `search_project` blend (`graphHits` + "Graph neighbor of Alpha"), and the standing `verify-agent.mjs` gate now drives a `graph.search` tool turn too (35/35) |
| Page links / backlinks / missing links | ✅ | |
| Review items (cross-client live sync) | ✅ | `.llm-wiki/review.json` is read from disk on access; an external (desktop / other-tab) write now live-reloads the open web Review view through the allowlisted `project://files-changed` path, and the server's own resolve/dismiss writes stay suppressed (app-write-ignore). |
| Lint items | ✅ | computed client-side over the wiki files (worker), persisted to `.llm-wiki/lint.json` and read from disk on access; the Lint panel is proven in the headless browser e2e (gate 9) |
| Web search (Firecrawl / SearXNG / Tavily / Ollama / Brave / Bocha / SerpApi) | ✅ | the desktop's full provider set, ported 1:1 from `src-tauri/src/agent/tools.rs` (`WebSearchConfig.resolved()` per-provider overrides, `web_search_result_limit` 1–20 / Bocha's documented 1–50, exact wire shapes incl. Brave's `X-Subscription-Token`, Bocha's `{freshness:"noLimit",summary:true}` envelope + `code` payload errors, Firecrawl's `success:false` + blocked-IP hint, `normalize_web_result` field fallbacks). Key-free Firecrawl works out of the box; unknown providers report a clear error. Verified 39/39 in the committed `packages/server/test/websearch.test.js` against local mock HTTP for the configurable-URL providers and an exact request-shape stub for the public-endpoint ones, plus end-to-end over LIVE servers by the standing `verify-websearch` gate (36/36 × both entries: command + agent surfaces, shared-store config, live provider overrides, no-restart store edits) |
| Local file search (AnyTXT) | ✅ | the desktop's full AnyTXT integration, ported 1:1 from `src-tauri/src/agent/tools.rs` (`run_anytxt_search` / `extract_anytxt_items` / `extract_anytxt_fragment_text` / `normalize_anytxt_endpoint` / `trim_text`) + `external_search.rs` (`file_url_for_path`): JSON-RPC `ATRpcServer.Searcher.V1.GetResult` (exact input contract: `pattern` / `filterExt` default `*` / `lastModifyBegin` / `lastModifyEnd` 2147483647 / string `limit` / `offset` / `order`, `filterDir` only when non-empty) with per-hit `ATRpcServer.Searcher.V1.GetFragment` snippet enrichment, the desktop's reference shape (`kind:"anytxt"`, encoded `file://` paths, `anytxt://<fid>` for fid-only hits), exact error strings (`AnyTXT search failed. Check that ATGUI.exe or the AnyTXT service is running at <endpoint>:`, `AnyTXT HTTP <status>: …`, `AnyTXT returned invalid JSON: …`, `AnyTXT error: …`), and a graceful agent-tool degradation when the local service is unreachable (failed tool step, turn survives). Config comes from the SHARED store's `searchApiConfig.anyTxt` (the desktop key, camelCase `AnyTxtConfig`), so a desktop-configured AnyTXT engine serves the web client unchanged. Verified 47/47 by the standing `scripts/verify/verify-anytxt.mjs` gate (mock JSON-RPC service + mock LLM across the command and agent surfaces) + 16 committed unit tests |
| Settings → Network (outbound proxy) | ✅ | faithful port of `src-tauri/src/proxy.rs`: `proxyConfig` from the shared plugin-store is applied at boot (exact `[proxy] reading from <file>` / `[proxy] <summary>` log lines) and `set_proxy_env` toggles it live with the desktop's exact summary strings; a global undici dispatcher routes the server's fetches (agent LLM, web_search, `/api/proxy`) through the proxy honoring NO_PROXY (CIDR / `*.local` / `.suffix` / `*`), while child processes (cli transports) inherit the env vars. Wrong-typed config fails the invoke like the desktop's command-arg deserialization (`Invalid proxy config: …`). Verified 68/68 per entry by the standing `scripts/verify/verify-proxy-env.mjs` gate (mock forward proxy + live traffic, both server entrypoints) + 47 committed unit tests |
| Binary request bodies through `/api/proxy` (MinerU PDF cloud PUT + local multipart) | ✅ | the shim (`src/web/http.ts`) sends Blob/ArrayBuffer/TypedArray bodies as `bodyBase64` (byte-exact, chunked `btoa`) and FormData as `formEntries` ({name,value} text fields + {name,fileName,contentType,base64} file parts); the server (`packages/server/src/proxy.js`) rebuilds the exact bytes / a real multipart body with its own boundary (the browser's boundary is meaningless — a caller-sent Content-Type is dropped for formEntries), streams binary responses back byte-exact, applies `bodyContentType` only when the caller sent none, and rejects ambiguity with the desktop's exact 400 strings (`Ambiguous body: send exactly one of body, bodyBase64, formEntries` / `formEntries must be an array` / `Invalid formEntries entry` / `Invalid formEntries file part` / `bodyBase64 must be a string`). This carries e.g. the MinerU cloud PDF PUT and the local MinerU multipart submit end-to-end uncorrupted — the desktop hands raw bytes to reqwest; the web now does the same via the envelope. Verified 23/23 per entry by the standing `scripts/verify/verify-proxy-binary.mjs` gate (RUNNING in gates.sh, both server entrypoints) + the committed `packages/server/test/proxy-binary.test.js` (8/8) and `src/web/http.test.ts` (9/9) |
| Source-folder auto-watch + change queue | ✅ | server `fs.watch` + SSE events. The scan state is **shared on disk with the desktop**: `packages/server/src/commands/fileSync.js` reads and writes `.llm-wiki/file-snapshot.json` in the desktop's exact wrapped shape (`{version,updatedAt,files:{<rel>:{hash,size,mtimeMs}}}`, the Rust `FileSnapshot` serde struct, camelCase) and `.llm-wiki/file-change-queue.json` as `{version,tasks}` with the desktop's camelCase `FileChangeTask` fields — so a watcher on either client interprets the same snapshot identically (no spurious mass create/delete when both run against one project). Diff semantics mirror `enqueue_paths`: a file is "modified" by `(hash,size)`, not mtime (a bare touch is not re-ingested), and sources >32 MiB get `hash:null` (`MAX_HASH_BYTES`) and diff by size. Reading also tolerates the legacy flat map an older web server wrote. Task paths are **project-root-relative** (`raw/sources/x.md`) with the desktop's `change_<ms>_<md5x12>` task ids, `sourceWatchConfig` rules (include extensions / excluded dirs / excluded globs / max size) are honored by both the startup rescan and the live watcher, the snapshot also covers `wiki/**/*.md`, `purpose.md` and `schema.md` (the desktop's `STARTUP_PREFIXES`), `process_queue` runs queued work through read → snapshot-update → done-remove with `file-sync://changed` + `file-sync://queue-updated` events, `retry_file_change_task` resets and re-processes, and `ignore_file_change_task` REMOVES the task like the Rust `.retain()` (the old "superseded" marker is retired). The standing gate (`scripts/verify/verify-filesync-shared.mjs`; `/tmp/verify-filesync-shared.mjs` is a symlink, both server entrypoints) passes 61/61 per entry (desktop-snapshot read, wrapped write, no wrapper-key garbage tasks, `(hash,size)` diff, >32 MiB hash skip, legacy-flat tolerance, config-filtered startup, live-sync emit + suppress + raw/sources exclusion, health `store.shared`, retry/ignore queue semantics, the three store-discovery branches — explicit `LLM_WIKI_STORE_FILE`, **auto-detect** (marker `app-state.json` under the desktop bundle app-data dir via `XDG_DATA_HOME`/`HOME`/`APPDATA` → `source=auto`, live reads, key-level non-clobber writes, no-restart out-of-band edits), and **`LLM_WIKI_NO_SHARE=1` isolation** (desktop marker byte-identical, writes land in `LLM_WIKI_DATA_DIR/stores` only) — plus the copy/delete app-write checks: a server `copy_file` into `raw/sources` enqueues NO shared-queue task, an out-of-band copy does, an app-owned `delete_file` leaves no deleted task — app-write-ignore is also honored by `rescan_project_files` so a rescan never re-enqueues the server's own writes). The server's own `copy_file` / `copy_directory` / `delete_file` mark app writes exactly like `file_sync::mark_app_write_path` in Rust, so the web's source-import / scheduled-import / folder-import copies never double-enqueue into the shared queue (the desktop suppresses them; the web now does too). |
| Scheduled import (outside-folder scan + ingest) | ✅ | shared frontend `src/lib/scheduled-import.ts` drives the desktop's exact primitives over the server bridge (`copy_file`/`copy_directory`/`delete_file` mark app writes, so no double-enqueue; the `scheduled-import-db.json` is written in the desktop's exact shape (md5s + lastScan; dotfiles/config-extension skipped), a reload re-runs the scan with zero new LLM calls by md5 dedup, and scanned copies land in `raw/sources/scheduled-import/` and flow through the SHARED server SQLite ingest queue). Proven end-to-end in the real browser UI by the standing `verify-scheduled-import` gate (39/39, RUNNING in gates.sh) against a mock LLM.
| MinerU PDF ingestion | ✅ | the server pipeline (`packages/server/src/ingest/mineru.js`) submits to the configured MinerU API over the byte-safe `/api/proxy` envelope (real multipart body, byte-exact file part), stores the MinerU markdown in the shared `.cache`, rewrites image refs to `wiki/media/<slug>/`, extracts embedded images byte-exact, and feeds the MinerU text (not the pdfjs fallback) into the mock-LLM generation. Proven end-to-end in the real browser UI with a mock MinerU API + mock LLM by the standing `verify-browser-mineru` gate (22/22, RUNNING in gates.sh): watcher auto-enqueue of a desktop-dropped PDF → byte-exact multipart submit → cached markdown → media image → summary page → completed server-queue task → live tree update.
| Live cross-client content sync | ✅ | server watches the whole project; web auto-refreshes the tree and reloads an open (non-editing) page when the desktop edits a file |
| File history / restore | ✅ | |
| Settings & recents persistence | ✅ | **shared with the desktop** via its plugin-store file (see "One backend, shared user data") |
| Chat — direct (streaming) | ✅ | routed via `/api/proxy` so providers without CORS headers still work. Web build **auto-opens the most recent shared session** after reload (issue #26), mirroring the desktop's `hydrateProjectChatStore` so a reload with a stale/missing `conversations.json` file copy never strands the pane on the empty state |
| Chat — agent mode (tool loop + streaming) | ✅ | server-side runtime; tools: wiki/source/web search, read/write pages, workspace files; **mid-turn structured forms** (`user.ask` → `userInputRequired` event / `userInputRequest` response field) with the desktop's exact sanitize → reject-retry → stateless-resume contract, skills-gated like the desktop; verified against a mock LLM in both stream and non-stream modes, and **end-to-end in the real browser** (standing gate `scripts/verify/verify-browser-chat.mjs`, RUNNING in gates.sh: mock LLM, skill-selected chat turn, streamed assistant answer, shell-approval handshake, zero page/console errors). **Cross-client context:** the web build sends the client-held `conversations.json` history exactly like the desktop build (`historyExplicit`), and the server honors it verbatim — a conversation started on the desktop keeps its full context when continued on the web (and vice versa); history-less callers hydrate from the shared `.llm-wiki/agent-sessions/` files and successful turns append there (desktop `append_turn` semantics, `persistSession !== false`). **Cancellation** is session-scoped via the composite `projectId::sessionId::runId` registry (desktop `AgentCancellationRegistry`); loop checkpoints (iteration start, per stream event, post-LLM-call, pre-tool-execution) stop a cancelled run promptly — no further LLM call, no tool side effect — with the desktop's "Agent run cancelled" error. **Offline degradation** (runtime.rs no-usable-config branch): when the resolved chat config is not usable for backend HTTP (missing key/model, CLI-only provider), the turn never calls an LLM and never errors — it answers with the deterministic router + retrieval summary (`agent-legacy.js`, `is_usable_for_backend_http`), so a fresh store with no provider key configured still gives retrieval-only answers |
| Local HTTP API + MCP server + agent skill | ✅ | the web server speaks the desktop's exact `/api/v1/*` REST contract (`packages/server/src/api-v1.js`: `/projects`, `/projects/:id/files`, `/files/content` with the public-path guard, `/reviews`, `/search`, `/graph`, `/chat`, `/chat/:sid/cancel`, `/sources/rescan`, `/health`) with the same auth (shared `apiConfig.token` / `LLM_WIKI_API_TOKEN`; `Bearer` / `?token=` / `x-llm-wiki-token`) and response envelopes, so the bundled MCP server (`mcp-server/`) and the external agent skill work against the web backend unchanged via `LLM_WIKI_API_BASE_URL`. The surface is mounted on BOTH server entries — the legacy `index.js` and the shipped `index-v2.js` (`start:web`) — including `/api/raw`, `/api/health`, and `/api/commands`. The **reviews** surface is a faithful port of api_server.rs: **stable FNV-1a `review-<hash>` ids** (`review_id_for_parts` over `type::normalizedTitle`, prefix-stripping + whitespace-collapse + lowercase normalization, including the CJK prefixes) so the same item gets the same id on the desktop and the web; **sanitize + duplicate merge** (unknown fields like `internalSecret` never leak, min `createdAt`, union `affectedPages`/`searchQueries`/`options`, fill-empty `description`), `status=pending`→unresolved normalization and the exact `Invalid review status '…'` error, `type` filter, `limit` clamp (200 default, 1..1000); **PATCH `/reviews/:id`** (empty body resolves, `resolved`/`action` validation, `Review item '…' not found` 404, raw-array write-back that PRESERVES unknown fields and stamps the stable id, reopen removes `resolvedAction`); **POST `/reviews/resolve`** bulk partial success (`{resolved,notFound,count}` in input order, `ids must be a non-empty array`, missing review file → all notFound). Search returns the desktop's hybrid-engine `note` and the exact `Invalid JSON:` / `query is required` / `queryEmbedding must not be empty` / `queryEmbedding must contain only finite numbers` 400s; chat maps `message is required`→400 / cancelled→499 / provider failure→502 with the desktop's `Unknown project: <id>` and `Not found` wordings. Verified by the committed `legacy-surface.test.js` + `api-v1-contract.test.js` + **`api-v1-reviews.test.js`** + `agent-session-shared.test.js` (health envelope incl. `version`/`allowLanAccess`/`agent{chat,streaming}`, the **kill-switch** — `enabled:false` 503s every non-/health endpoint BEFORE auth with the desktop string while `/health` stays reachable — the agent-chat real-token gate even in unauthenticated mode, the 405 method gate, and `mcpEnabled` defaulting to false like `api_mcp_enabled`), 17/17 with the real compiled MCP client (its stdio tool surface), the standing **`verify-api-v1` gate** (70/70, RUNNING in gates.sh — review merge/PATCH/bulk on the legacy `index.js` entry; the v2 entry is pinned by `api-v1-reviews.test.js`), and the standing **`verify-mcp-interop`** gate (32/32 per entry, RUNNING in gates.sh on BOTH entries): the UNMODIFIED bundled MCP server (`mcp-server/dist`, `mcp_server_entry_path` lib.rs resolution) is spawned over stdio through the official MCP SDK client and driven end-to-end — stdio handshake, the 10-tool surface, shared-store projects + desktop `lastProject` as current, set-project pin (by path) + cross-project rejection, files/read_file + the public-path 403 guard, reviews exposing the same stable shared `review-<hash>` ids from the same `review.json`, search/graph/sources-rescan, chat against a mock LLM with the turn persisted to the SHARED desktop-format `.llm-wiki/agent-sessions/<sid>.json`, the `mcpEnabled` kill-switch with a live store flip (no restart), and the token contract (status stays public, 401 without token, out-of-band `allowUnauthenticated` flips honored with no restart). `?token=` / `x-llm-wiki-token` / `Bearer` acceptance itself stays pinned by `verify-api-v1`; `mcp_server_entry_path` by `api-v1-contract.test.js`. |
| Chat — Claude Code CLI / Codex CLI backends | ✅ | the server runs on the host, so it spawns the same `claude` / `codex` binaries the desktop does (`packages/server/src/cli.js`, a faithful port of `claude_cli.rs` / `codex_cli.rs`): `*_detect` reports `{installed,version,path,error}` (incl. the macOS quarantine hint); `*_spawn` validates the project working directory, pipes the reconstructed history/prompt over stdin, and streams each stdout line back as `claude-cli:{streamId}` / `codex-cli:{streamId}` SSE events with a terminal `:done {code,stderr[,stdout]}`; `*_kill` SIGKILLs the child. Login-shell PATH is resolved so node-shim CLIs work under a GUI/daemon. Verified by committed tests (`packages/server/test/cli.test.js`): the desktop's Rust fixtures (timeout clamps, arg builders, PATH parsing, content shaping, UTF-8-safe byte-capped stdout) plus real spawns against mock executables on a temp PATH (detect shapes, stream-json/prompt stdin, SSE events + `:done`, non-zero exits, SIGKILL → code:null, all working-directory guards) and the premature-exit EPIPE mapping as a deterministic unit pin (write to a dead child's closed stdin → the desktop's exact `Failed to write to <label> stdin: ...` rejection; the original end-to-end variant raced the mock's exit under load in both directions and was replaced) |
| Agent skills (`SKILL.md` scan, `/skill`) | ✅ | server scans the same roots as the desktop (project `.llm-wiki/skills` + `~/.claude|~/.codex|~/.agents/skills`); the Skills panel (scan + scanned-folder list) is proven in the headless browser e2e (gate 9), `agent_list_skills` lists them, selected skills are injected into the agent prompt in the desktop's exact `<skill>`/`<available_skills>` format, and `skill.read_file` resolves references strictly inside the active skill directory with the desktop's error strings and `{skill,path,content}` result / `read {skill}:{path}\n{content}` summary (committed suite `packages/server/test/skills.test.js` — the desktop's skill-loader + planner-context fixtures ported verbatim, 27 tests, plus e2e injection) |
| Agent `shell.exec` | ✅ | **per-command approval, faithful to the desktop** (`packages/server/src/shell-policy.js`, a 1:1 port of `runtime.rs`): a skill-gated `shell.exec` runs immediately only if it is in the turn’s `approvedShellCommands` or scoped to the agent workspace (no network/curl/wget/scp/ssh, no `$HOME`/`~`/`..`/external absolute paths); anything else stops the turn with the desktop’s exact “The Agent needs approval…” message plus an `available`→skipped `shell_exec` step, and the Approve button resumes a new turn with `approvedShellCommands` (the desktop’s stateless resume contract — no parked run). `LLM_WIKI_ALLOW_SHELL=1` is an opt-in escape hatch that bypasses the prompt. Verified by 36 committed unit tests (`packages/server/test/shell-policy.test.js` — the desktop's own Rust fixtures, ported verbatim) plus the standing mock-LLM gate `scripts/verify/verify-agent.mjs` (stream approval boundary, resume-with-`approvedShellCommands` runs, workspace auto-allow, skills-gate rejection, preference-probe skip, cancel, unknown project); the browser UI handshake (boundary message → Approve button → resumed turn, plus the issue-#26 reload auto-open) is proven end-to-end by the standing `verify-browser-chat` gate (33 checks, `scripts/verify/verify-browser-chat.mjs`, RUNNING in gates.sh). The boundary exchange is persisted to both the shared `.llm-wiki/agent-sessions/` file and the web's SQLite session store (desktop lib.rs `append_turn` semantics — a reload restores the full transcript including the approval summary, and `packages/server/test/agent-shell-parity.test.js` pins the rows), and an approved run executes `/bin/sh -c <cmd>` inside `<project>/agent-workspace` with a sanitized env (`timeoutSeconds` 1–30, default 30) feeding the model the desktop's exact `shell.exec \`cmd\` exit=Some(0) timedOut=false…` summary (tools.rs `run_shell_exec` port). |
| Deep Research (UI feature: multi-query web search + auto-ingest) | ✅ | frontend-orchestrated over `web_search` + the ingest queue; proven end-to-end in the REAL browser UI by the standing `verify-browser-research` gate (mock SearXNG + mock LLM: sources inline, synthesis streaming, `Saved` + Open, the page lands in `wiki/queries/` on disk). The card that auto-opens while a task runs now stays expanded through completion, so the streamed answer remains visible after the task finishes (issue #13 item 4) |
| Deep Research (agent `deep_research.run` tool) | ✅ | runtime-orchestrated exactly like the desktop: the tool is never offered to the model; in deep mode the agent brackets retrieval with `deep_research.run` start/end events (`"<N> reference(s)"`), and model-issued calls are rejected by the loop executor |
| Project archive export / import (zip) | ✅ | server-side (jszip), faithful port of `project_maintenance.rs` — the importer validates the RAW central directory like the `zip` crate (entry cap 100 000, `Component::Normal` path check rejecting `..`/`.`/absolute/symlink entries, 4 GB expanded cap, exact desktop error strings; JSZip alone would silently rename hostile names instead of rejecting). Verified by 22 committed tests (`packages/server/test/maintenance.test.js` — the Rust unit fixtures ported verbatim, round-trip preserving hidden `.llm-wiki` state, empty dirs, symlink skip on export, every error boundary incl. a real 100 001-entry archive) + 5 v2 route tests in `api-v2.test.js` (export/import over the API, exact error envelope) |
| Rebuild wiki index | ✅ | regenerates `wiki/index.md` from page frontmatter exactly like the Rust rebuild (BTreeMap-sorted groups, lowercased-title page sort, atomic tmp+rename, skips `index`/`overview`/`log`, `Failed to enumerate wiki pages:` error when `wiki/` is missing). Verified by the committed `maintenance.test.js` rebuild suites + `file-events.test.js` (ONE `file:modified` + ONE `graph:updated` with the rebuild's page/wikilink counts) |
| Chrome Web Clipper (extension) | ✅ | the server hosts the desktop's exact **:19827 companion protocol** (`packages/server/src/clip-server.js`, a faithful port of `clip_server.rs`), so the **unmodified** Chrome extension (`extension/`) works against the web backend: it lists projects, clips pages to `<project>/raw/sources/<slug>-<date>.md` (byte-identical frontmatter, `-2/-3` dedup, `pending` hand-off), and the web UI polls `/clips/pending` + enqueues ingest exactly like the desktop (status-gated so a listener-less server stays quiet). Loopback bypass, LAN token auth (Bearer / `x-llm-wiki-token`, no `?token=`), and the narrow CORS allow-list are all parity; when the desktop app owns the port the server reports `port_conflict` and the web client registers with the desktop's listener instead — clips reach the same shared project files either way. Verified by `scripts/verify/verify-clip-server.mjs`: protocol bytes, slug/dedup, CORS, port_conflict, LAN auth, and a headless-browser clip → enqueue round-trip against the shared server queue |
| Autostart on login | ❌ | desktop companion; a browser cannot register an OS login item |
| Open in OS file manager / reveal | ✅ | the server runs on the host, so it spawns the OS handler exactly like the desktop (`packages/server/src/opener.js`, a faithful port of `tauri-plugin-opener`: `xdg-open` / FileManager1 D-Bus reveal on Linux, `open`/`open -R` on macOS, `explorer` on Windows). `open_project_folder` + `open_path_in_project` keep the desktop's exact validation, path-containment guard, and open→reveal fallback errors; the opener shim's `openPath` falls back to a browser tab via `/api/raw` when the host has no handler (headless). Verified 23/23 against mock `xdg-open`/`dbus-send` |

## Unattended / overnight runs (22:00–08:00 Beijing)

`scripts/overnight-schedule.sh` drives the parity work unattended during the
22:00–08:00 Beijing window by firing a headless `codex exec` continuation at
the top of each in-window hour. Each run re-derives state from the worktree
(“work from evidence”), closes one gap, verifies it, and leaves a green tree.

```bash
scripts/overnight-schedule.sh install     # add the crontab entry (idempotent)
scripts/overnight-schedule.sh status      # Beijing time, in-window?, lock?, last run, log tail
scripts/overnight-schedule.sh uninstall   # remove the crontab entry
scripts/overnight-schedule.sh run         # the cron target (time-guarded + locked)
```

How it behaves:

- **Window:** Beijing hours 22,23,0,1,2,3,4,5,6,7 (i.e. 22:00–08:00). A run
  started outside the window no-ops (the guard also protects manual runs).
- **No stacking:** a `flock` on `.overnight/overnight.lock` makes an hourly
  tick skip if the previous session is still running.
- **Prompt-free:** `codex exec` runs with `-s danger-full-access` (the same
  trusted-unattended posture this repo uses for manual full-access sessions,
  and it avoids the `bwrap` sandbox-init failure seen under `workspace-write`).
- **Cron PATH + trust:** the script `cd`s into the repo and auto-discovers the
  nvm-managed `node`/`codex` bin dir (plus `/usr/local/bin`, homebrew, snap,
  `~/.local/bin`, `~/.cargo/bin`) at runtime, and invokes codex with
  `-C <repo> --skip-git-repo-check --ephemeral` so the hourly tick passes both
  cron's minimal `PATH` *and* the "trusted directory" gate. Verified by running
  the real codex code path under `env -i PATH=/usr/bin:/bin` (model replied,
  `rc=0`). Override the sandbox with `NIGHT_SANDBOX=...`; `NIGHT_PROMPT=...`
  feeds a custom prompt for cheap testing of the unattended path.
- **Auditable:** all output goes to `.overnight/overnight.log` (gitignored);
  `.overnight/last-run.txt` records the latest start/end.
- **Self-scoping:** the continuation prompt greps the server for the remaining
  stubs (`notSupported(`, `noop`, `"not available in web-server mode"`) and the
  RUNBOOK matrix, implements the highest-value gap, then verifies against the
  **standing acceptance gates** (`bash scripts/verify/gates.sh`, wrapped by
  `/tmp/gates.sh`; `/tmp` shims are symlinks — the durable copies live in the
  repo now, so nothing is lost when `/tmp` is wiped). The green set today:
  `node --check` on every server file, server tests, `tsc --build`, frontend
  mock tests, `build:web`, `verify-surface-parity` (the static parity-surface
  invariants — no throwing stubs in packages/server/src, Rust
  generate_handler! ↔ Node-registry coverage, shipped-frontend invoke
  coverage, and `@tauri-apps` web-shim alias coverage — i.e. the
  continuation's own greps, mechanized), `verify-filesync-shared` on both
  server entrypoints (desktop-contract source-snapshot/change-queue interop),
  `verify-agent`
  (mock LLM, exact event sequence + shapes + cancel + unknown-project),
  `verify-agent-sessions` (shared sessions file, desktop shape, cross-client
  append), `verify-shell-approval` (stateless approval boundary + resume),
  `verify-user-ask` (structured forms over stream + non-stream),
  `verify-agent-offline` (runtime.rs offline degradation: fresh store / missing
  key / CLI-provider configs answer with the deterministic router + retrieval
  summary, ZERO LLM calls), `verify-
  vectorstore` (v1/v2 vector commands, faithful embedding-fetch contract,
  hybrid RRF search, restart persistence), `verify-opener`, `verify-cli-
  transports` (Claude-Code / Codex-CLI detect/spawn/kill over live servers
  with mock binaries), `verify-proxy-binary` on both server entrypoints
  (byte-exact binary/multipart request bodies through `/api/proxy` — the
  MinerU cloud PDF PUT + local multipart envelope), and the headless
  browser gates `verify-browser-boot`
  (welcome screen, ZERO console/page errors), `verify-browser-e2e`
  (create/open project, file tree, wiki page, edit → save → on-disk,
  cross-tab via shared disk, Files workbench, Sources/Review/Search/
  Graph/Lint/Deep-Research/Skills/Settings walks), `verify-browser-ingest`
  (the core ingest loop through the real Sources UI against a mock LLM:
  auto-enqueue of a desktop-dropped source, the server-owned two-stage
  pipeline, the on-disk wiki page + deterministic index/log updates, the
  completed queue row, and the zero-LLM-call cache replay on manual
  re-ingest), `verify-browser-mineru` (MinerU multipart submit + byte-exact
  media + summary through the real UI), `verify-scheduled-import`
  (copy/delete app-write-ignore contract + the full scan→enqueue→ingest→
  reload-dedup loop), and `verify-v2-server` (the v2 entry's complete
  legacy-surface contract in token mode).
  Gates whose features are not yet re-implemented in this tree are **SKIPped
  with a one-line reason** (see the "Standing acceptance gates" section and
  the delta list) — the suite must always end `GATES_OK`, and `gates.sh`
  treats modifying the green set as a regression unless the harness passes.
  The run updates the RUNBOOK and **does not commit or push**.
- **Prereqs:** a running cron daemon (present on this host) and a valid
  `codex` login for the user the cron runs as. If auth expires, the run logs an
  auth error — re-run `codex login` to fix.

Test hooks (manual verification only; never set by the cron line):
`NIGHT_HOUR_OVERRIDE=<0-23>` to exercise the time guard, `NIGHT_RUN_CMD="..."`
to run a stand-in command instead of `codex`, `NIGHT_DRY=1` to print the exact
`codex exec` invocation without running it, and `NIGHT_FORCE=1` to bypass the
window guard.

## Standing acceptance gates (durable suites)

The gate harnesses live in the repo (`scripts/verify/*.mjs`, run by
`scripts/verify/gates.sh`) — they used to live only in `/tmp`, which is
volatile and wiped between boots. `/tmp/gates.sh` is a thin wrapper that execs
the repo suite; the old `/tmp/verify-*` / `/tmp/llmwiki-harness/*` names are
symlinks to the repo copies. Run everything with `bash scripts/verify/gates.sh`;
it must end `GATES_OK`. The harnesses spawn their own servers/browsers against
throwaway data dirs and never touch the real store.

Currently **running** (all must pass; counts as of 2026-08-22):

| gate | what it pins |
|---|---|
| `verify-surface-parity` | the static parity-surface invariants, mechanically pinning the “unmodified frontend works against the web backend” contract: the continuation greps (`notSupported(` / `: noop` / `“not available in web-server mode”`) match NOTHING in `packages/server/src`; every command in the desktop’s `tauri::generate_handler![...]` (src-tauri/src/lib.rs) is registered in the Node invoke registry (73/73); every command name the shipped frontend passes to `invoke()`/`invokeHttp()` resolves (65/65); every `@tauri-apps/*` import (static + dynamic) is covered by a `vite.web.config.ts` alias whose target exists — so a future change that drops a command, reintroduces a throwing stub, or forgets a web shim fails the suite before any server/browser gate runs; 14/14 |
| `verify-filesync-shared` (× both entries) | shared snapshot/queue desktop contract (see matrix row); 61/61 per entry incl. store-discovery branches (explicit / auto-detect / `NO_SHARE` isolation) |
| `verify-source-text` (× both entries) | `read_file`/`preprocess_file` desktop fs.rs contract: per-page PDF markdown (`## Page N`, the pdfium shape), Office/Org extraction, image/media/legacy-doc placeholders, the exact missing-file error, `.cache` short-circuit (fresh wins, stale re-extracts), real Word 97–2003 `.doc` bodies via the vendored MIT corpus, the `preprocess_file` `"no preprocessing needed"` sentinel (text + unknown binary), zero `files-changed` for cache writes, the exported `searchSources` + agent `source.search` matching binaries only through a fresh cache (hidden paths, top_k clamp, empty-query error), and a mock-LLM turn carrying the binary source reference; 38/38 per entry |
| `verify-agent` | mock OpenAI-compatible LLM; `toolStart → referenceAdded → toolEnd → messageDelta → done` exactly once, non-stream `BackendAgentResponse` shape, cancel, `Unknown project:` error |
| `verify-agent-sessions` | shared `agent-sessions` file (camelCase desktop shape), isolation, 40-msg cap, traversal rejection, cross-client append with no restart/no clobber |
| `verify-shell-approval` | per-command `shell.exec` approval boundary (messageDelta + no `userInputRequired` on the stream — runtime.rs's real contract), resume with `approvedShellCommands` runs the command, workspace auto-allow, skills gate, pref probe skip |
| `verify-user-ask` | `user.ask` sanitize/errors, stream `userInputRequired` + non-stream `userInputRequest`, rejection round-trip, alias, resume; no assistant scaffold row persisted at the boundary |
| `verify-agent-offline` | runtime.rs offline degradation (provider.rs `is_usable_for_backend_http`): fresh store / missing key / CLI-provider configs answer with the deterministic router + retrieval summary (`build_retrieval_answer`), ZERO LLM calls, exact fallback strings, `skills.load` gating, `shell.exec` via `request.shellCommand` (unapproved/approved desktop contracts), faithful-mode hint suppression, deep-mode brackets, `/api/v1` chat offline envelope; 44/44 |
| `verify-vectorstore` (× both entries) | v1 `vector_*` commands, v2 chunk store, full embedding-fetch contract (unsafe-header skip, exact error strings, oversize auto-halving, Google body, batch bounds/order), hybrid RRF search, restart persistence; 113/113 |
| `verify-opener` | `open_path`/`reveal_in_file_manager` browser no-op contract |
| `verify-cli-transports` | Claude-Code / Codex-CLI backends over live servers with mock `claude`/`codex` on a scrubbed PATH: detect shape, exact arg vectors, stream-json/prompt stdin, SSE `{:done}` envelopes, non-zero exits, SIGKILL, working-dir guards, and the 1 MiB codex stdout cap; 86/86 |
| `verify-anytxt` | AnyTXT Search Engine connector over a mock JSON-RPC service + mock LLM: `file_url_for_path` fixtures, `extract_anytxt_items`/fragment variants, exact GetResult/GetFragment bodies, limit clamping, short-circuits, desktop error strings, and the agent `anytxt.search` turn incl. graceful degradation; 47/47 |
| `verify-websearch` (× both entries) | the web-search provider contract over LIVE servers: command e2e via `/api/invoke/web_search` against local mocks for the configurable-URL providers (SearXNG `q`/`format`/`categories` wire shape + `Accept: application/json`, Ollama `POST /api/web_search` + Bearer + `{query,max_results}`, key-free Firecrawl `POST {base}/v2/search` `{query,limit}` + `success:false`/blocked-IP hint), `WebSearchConfig.resolved()` per-provider overrides (providerConfigs beats top-level), `web_search_result_limit` clamp (1–20), `normalize_web_result` metadata fallbacks + hostname source, empty-query short-circuit with zero traffic, and the exact error strings (missing key, `SearXNG search failed (500): …`, `SearXNG returned invalid JSON: …`, not-configured, unknown provider); plus the agent `web.search` turn reading config from the SHARED store's `searchApiConfig` (desktop key), `request.tools.web` spec gating, and an out-of-band store edit (searxng → ollama) honored on the next turn with NO restart; 36/36 per entry |
| `verify-proxy-env` (× both entries) | proxy.rs parity: store-file `readProxyConfigFromStore`/`normalizeProxyConfig`/`shouldBypass`, boot-time apply with the exact `[proxy]` log lines, live set_proxy_env toggles with byte-counted traffic through a mock forward proxy (absolute-form for plain http, CONNECT for https), NO_PROXY bypass, `/api/proxy` + `web_search` proxying, and the desktop's `Invalid proxy config:`/`Invalid close behavior:` error semantics; 68/68 per entry |
| `verify-proxy-binary` (× both entries) | binary-safe `/api/proxy` envelope (the desktop reqwest contract): `bodyBase64` PUT delivers the exact bytes with custom headers kept + hop-by-hop dropped, `formEntries` becomes a real multipart body the upstream parses (text fields + byte-exact file part, server-generated boundary, stale browser boundary dropped), binary responses byte-exact, `bodyContentType` fills a missing Content-Type while an explicit one wins, text body unchanged, and the exact 400s (`Ambiguous body: …` / `formEntries must be an array` / `Invalid formEntries entry` / `bodyBase64 must be a string`); 23/23 per entry |
| `verify-api-v1` | the desktop's exact `api_server.rs` REST contract on the legacy `index.js` entry: auth (chat-only token gate under `allowUnauthenticated`), health, projects/files (+ public-path guard), **reviews GET with stable FNV `review-<hash>` ids** (sanitize, duplicate merge, `status=pending` normalization, exact invalid-status error, type filter, limit), **PATCH `/reviews/:id`** (empty body resolves, raw-array write-back preserving unknown fields + stamping the stable id, reopen removes `resolvedAction`, exact 404/400 strings), **POST `/reviews/resolve`** (bulk partial success `{resolved,notFound,count}` in input order, missing review file → all notFound), search (serde-style `Invalid JSON:` / `query is required` / exact `queryEmbedding` errors + the desktop hybrid-engine `note`), chat (mock LLM; `api_` sessions, non-stream events vector sinks `messageDelta` per runtime.rs, error mapping `message is required`→400 / cancelled→499 / provider failure→502), cancel (real bool), 405 + `Not found` 404; 70/70 |
| `verify-port-conflict` (× both entries) | main-listener bind-failure contract on both entries: when the port is taken (the desktop app owns :19828 while running), the server exits fast (code 1, within 8 s) with one actionable diagnosis naming the address, `EADDRINUSE`, a concrete `LLM_WIKI_PORT=` fix, the `LLM_WIKI_API_BASE_URL` follow hint for MCP/agent tools, and the DESKTOP-app cause — ZERO success banner, ZERO raw `Unhandled 'error'` trace (Express 5 delivers bind errors to the listen callback, which previously left index-v2 as a silent zombie); pure `listen-guard.js` diagnostics for EACCES / EADDRNOTAVAIL / unknown errors, idempotent single-print exit; positive control (free port boots, SIGTERM stops cleanly); 26/26 |
| `verify-browser-boot` | headless Chromium boot: welcome screen, ZERO pageerror/console error/failed request |
| `verify-browser-e2e` | create project from web (dialog → scaffold on disk → opens → Switch Project → Recent Projects), picker open, file tree + wiki page render, edit → save → on-disk round-trip, cross-tab via shared disk, Files workbench, Sources drop-zone, Review live-sync (out-of-band review.json), Search result count, Graph panel, Lint run, Deep Research panel, Skills scan (project + user roots), Settings section list; ZERO console/page errors and ZERO non-optional failed requests; 34/34 |
| `verify-browser-ingest` | headless browser ingest e2e on the **shipped v2 entry** (the only entry that runs the server-owned orchestrator): a source the "desktop" dropped into `raw/sources` is auto-enqueued with ZERO clicks (client file-sync → enqueue-by-path → the shared SQLite `ingest_queue`), the server pipeline streams BOTH stages (analysis + generation) from a mock LLM, the source-summary page lands on disk (desktop-readable) with the deterministic `log.md`/`index.md` updates, the task reaches `completed` (progress 100), the activity panel reports Done, the page appears LIVE in the Knowledge tree, a manual Ingest re-run replays from the ingest cache with ZERO new LLM calls, and app-write-ignore keeps the shared `file-change-queue.json` empty; ZERO page/console errors and ZERO non-optional failed requests; 28/28 |
| `verify-browser-chat` | headless browser agent-chat e2e against a mock OpenAI-compatible LLM in the real React chat UI: skill-selected turn with a `wiki.search` round-trip, the desktop-faithful `shell.exec` approval boundary (exact “The Agent needs approval…” message + Approve button showing the command), resume with `approvedShellCommands` that really executes the command (the model re-issues it and sees the exact desktop summary), boundary + resumed exchanges persisted to the shared `.llm-wiki/agent-sessions/` file and SQLite, and the issue-#26 reload auto-open restoring the full transcript incl. the approval summary; ZERO page/console errors and ZERO non-optional failed requests; 33/33 |
| `verify-browser-research` | headless browser **Deep Research e2e on the shipped v2 entry** — the last primary view the earlier e2e only opened, now exercised end-to-end against a mock SearXNG provider + mock OpenAI-compatible LLM (no real keys): picker open, panel run of a topic through the server-side `web_search` command (exact SearXNG `q`/`format=json`/`categories` wire), the 3 collected sources shown inline (`Sources (3)`), the synthesis STREAMING into the card, the task reaching `Saved` with the Open button, and the synthesized page landing on disk at `<project>/wiki/queries/research-*.md` in the desktop format (`type: query` / `origin: deep-research` / `tags: [research]` / title frontmatter / References citing every searched URL) — the desktop-visible shared file. Also pins the issue-#13-4 fix: a card that auto-opened while running stays expanded through completion, so the answer the user was watching stream stays visible inline (the old mount-time default collapsed the card the instant the task finished). Asserts EXACTLY ONE LLM synthesis completion carrying the sources + cross-referencing system prompt; ZERO page/console errors, ZERO dialogs (no “not configured” alert), ZERO non-optional failed requests; 29/29 |
| `verify-clip-server` | the Chrome-clipper companion (`clip_server.rs` port) on :19827: exact routes/bodies/status codes, byte-identical clip frontmatter + `-2` dedup, pending hand-off, slug rules, exact-match URL routing, CORS allow-list, occupied-port → `port_conflict` (3 bind retries), LAN token auth (loopback bypass, headers-only — no `?token=`), plus a headless-browser e2e on the shipped v2 entry: the UI registers with the companion (POST /project + /projects), the clip watcher polls `/clips/pending`, an extension-style clip lands in `raw/sources` and is enqueued into the SHARED server ingest queue and processed against a mock LLM — all with ZERO page/console errors and ZERO non-optional failed requests |
| `verify-browser-mineru` | headless browser MinerU-PDF e2e on the **shipped v2 entry**: a PDF the "desktop" dropped into `raw/sources` is auto-enqueued (client file-sync → enqueue-by-path → the shared SQLite `ingest_queue`) with ZERO clicks, the ingest pipeline submits it to the MinerU API as a real multipart body (text fields + byte-exact file part), stores the MinerU markdown in the shared `.cache`, rewrites the cached image refs to the wiki media path, writes the extracted image byte-exact to `wiki/media/sample/mineru/images/image-1.png`, generates the source-summary page with the mock LLM carrying the **MinerU text** (not the pdfjs fallback), the server-queue task reaches `completed`, the ingested page appears LIVE in the Knowledge tree, and app-write-ignore keeps the shared `file-change-queue.json` empty — ZERO page/console errors and ZERO non-optional failed requests; 22/22 |
| `verify-scheduled-import` | the copy/delete app-write-ignore contract (`copy_file`/`copy_directory`/`delete_file` mark app writes exactly like `file_sync::mark_app_write_path`; no change tasks; the snapshot silently syncs in/out) PLUS a headless browser scheduled-import e2e on the shipped v2 entry: the desktop-configured `scheduledImportConfig:<project>` hydrates in the Settings UI, `scanAndImport` copies `note.md` + `nested/sunspots.txt` into `raw/sources/scheduled-import/` (dotfiles + config-extension files skipped), the desktop-shaped `scheduled-import-db.json` records both md5s + lastScan, BOTH copies enqueue into the SHARED server SQLite queue and complete against a mock LLM (exactly 2 analysis + 2 generation calls), the summary pages land on disk, and a reload re-opens the project and re-runs the scan (fresh lastScan) with ZERO new LLM calls on unchanged files (md5 dedup) — ZERO page/console errors and ZERO non-optional failed requests; 39/39 |
| `verify-v2-server` | the shipped v2 entry's complete legacy-surface sanity contract in TOKEN mode: `/api/health` + `/api/home` + `/api/commands` (gated in token mode — health discloses the store path), `/api/invoke` with the `{ ok, result }` envelope + `Deprecation` header + 404 `Unknown command: …` + 400 `Invalid JSON body` (body-parser parse failures now map to the legacy 400 instead of a scrubbed 500), `/api/store` key-level round-trip, `/api/raw` streaming + 404/400, `/api/v2/events` (token via `?token=`) delivering `project://files-changed` for an out-of-band wiki edit AND `file:modified` for the server's own write (app-write-ignore — no self-echo; cross-tab live sync), `/api/proxy` verbatim pass-through with the exact 400, token semantics (`/api/v1/*` gated by api_server.rs's own auth with `/api/v1/health` public; every other `/api/*` incl. `/api/invoke` gated by `authMiddleware`; `/api/v2/*` Bearer-gated), the clipper companion on its own port, SPA fallback, and unknown `/api/*` 401; 39/39 |
| `verify-ingest-heartbeat` | the issue-#32 liveness heartbeat over the LIVE v2 server: boot with the 200 ms test hook + a SLOW mock LLM (2.5 s per analysis/generation call) and concurrency 1; a second task enqueued behind the first stays `pending` with `heartbeat_at` null while several intervals elapse; the processing task's `heartbeat_at` appears at claim and ADVANCES while progress itself is frozen inside the in-flight call (liveness, not a progress lie) with `updated_at` following the heartbeat; on `completed` the heartbeat stops advancing (two intervals of silence) — a stale counter would mask exactly the hung runs the heartbeat exists to expose; the resolved absolute file path is stored; exactly 4 pipeline LLM calls for 2 sources (2 per source); 14/14 |
| `verify-mcp-interop` (× both entries) | the UNMODIFIED bundled MCP server over stdio via the official MCP SDK client: stdio handshake + 10-tool surface, shared-store projects + desktop `lastProject` as current, set-project pin + cross-project rejection, files/read_file + public-path 403 guard, stable shared `review-<hash>` ids, search/graph/sources-rescan, mock-LLM chat persisted to the SHARED desktop-format `agent-sessions` file, `mcpEnabled` kill-switch + token-auth flips honored live with NO restart; 32/32 per entry |

Every harness in `scripts/verify/` is now RUNNING — nothing is SKIPped in
`gates.sh`. The `/api/v1` interop (`verify-api-v1`) and MCP-client
(`verify-mcp-interop`) harnesses that earlier lived only in `/tmp` are now
standing gates in the repo (the MCP gate runs on BOTH server entries); the
web-search provider (`verify-websearch`, 36/36 × both entries) and
ingest-heartbeat (`verify-ingest-heartbeat`, 14/14, shipped v2 entry)
harnesses were recreated as standing gates below.

## Remaining parity delta (the overnight queue)

These are the desktop features not yet mirrored in the web build. They are the
explicit punch list the overnight runs work through; the goal is only “done”
when each row is either implemented or confirmed genuinely impossible in a
browser (and kept as a documented no-op, as the OS/autostart rows already are):

- ~~**`/api/v1` review-item contract (stable ids, merge, PATCH, bulk resolve)**~~ —
  **done** (`packages/server/src/api-v1.js`): the reviews surface now ports
  `api_server.rs` exactly — `review_id_for_parts` FNV-1a ids over
  `type::normalizedTitle` (stable `review-<hash>` ids shared by desktop, web
  and MCP clients on the SAME `.llm-wiki/review.json`), sanitize + duplicate
  merge (min `createdAt`, union `affectedPages`/`searchQueries`/`options`,
  fill-empty `description`, unknown fields never exposed), `status=pending`
  normalization + exact `Invalid review status` error, `type`/`limit` query
  handling (200 default, 1..1000), **PATCH `/reviews/:id`** with raw-array
  write-back (unknown fields like `internalSecret` survive, stable id
  stamped, reopen removes `resolvedAction`, exact 404/400 strings), and
  **POST `/reviews/resolve`** bulk partial success in input order. The search
  endpoint now enforces the serde-style `Invalid JSON:` / `query is required`
  / `queryEmbedding` 400s and returns the desktop's hybrid-engine `note`;
  chat maps `message is required`→400, cancelled→499, provider failure→502;
  unknown project reads `Unknown project: <id>` and unknown routes read
  `Not found`. The non-stream `/chat` `events` vector keeps `messageDelta`
  sink-only (runtime.rs gates every final-answer MessageDelta on
  `event_sink.is_some()`; `handle_chat` passes none) — the stream SSE path
  carries the deltas. Verified by the standing `verify-api-v1` gate (70/70,
  RUNNING in gates.sh, legacy `index.js` entry) + committed
  `api-v1-reviews.test.js` (shipped `index-v2.js` entry) — both entries
  speak the contract.
- ~~**AnyTXT local file search**~~ — **done**: the web server now speaks the
  desktop's AnyTXT JSON-RPC protocol instead of the old non-desktop `/api/search`
  proxy — `packages/server/src/anytxt.js` is a 1:1 port of
  `run_anytxt_search` (GetResult + per-hit GetFragment, exact input contract
  and error strings) and the `anytxt_search` command + agent `anytxt.search`
  tool both consume it, with the config sourced from the SHARED store's
  `searchApiConfig.anyTxt` (desktop `AnyTxtConfig` key) so a desktop-configured
  AnyTXT engine serves the web client unchanged and an out-of-band store edit
  is picked up on the next turn with no restart. The agent tool degrades
  gracefully when the local service is unreachable (failed tool step, turn
  survives), exactly like the desktop. The old web-only endpoint proxy
  (`POST {endpoint}/api/search`) is retired. Verified by the standing
  `scripts/verify/verify-anytxt.mjs` gate (47/47, now RUNNING in `gates.sh`)
  + 16 committed unit tests (`packages/server/test/anytxt.test.js`).
- ~~**Shared agent sessions + cross-client chat context**~~ — **done** (`packages/server/src/agent-sessions.js`,
  a faithful port of the desktop's `AgentSessionStore` (`session.rs`): same
  `.llm-wiki/agent-sessions/<sessionId>.json` serde files, same
  take-40/timestamps/sort/sanitize semantics). The web runtime now sources
  model context exactly like the desktop: explicit client-held history
  (`historyExplicit`) wins verbatim — the web build sends the
  `conversations.json` round-trip like the desktop instead of relying on its
  own SQLite — and history-less callers hydrate the last 12 messages from the
  shared session files, falling back to SQLite only for legacy web sessions.
  Successful turns append to the shared files when `persistSession !== false`
  (the desktop's default), `/api/v1/chat` and `/chat/:sid/cancel` mirror
  `handle_chat`/`handle_cancel_chat` (api_/run_ id defaults, 12-message
  hydrate, session-scoped cancel), and `agent_get_session` /
  `agent_list_sessions` read the shared store with the desktop's arg names and
  return shapes. Cancellation uses the desktop's composite registry key
  (`projectId::sessionId::runId`, `AgentCancellationRegistry` port): a cancel
  by runId, or by the whole session prefix (`/chat/:sid/cancel`), marks the
  run's token, and the loop's checkpoints — iteration start, per stream
  event, right after the LLM call, and immediately before each tool
  execution (mirroring `generate*_with_cancellation` /
  `execute_tool_with_cancellation`'s biased select) — stop the turn promptly
  and never execute a tool (shell command, file write) after a cancel, even
  when the provider ignores the abort signal. Verified 13/13 unit/
  integration (incl. the `agent-cancel-checkpoint` suite) + the standing
  `/tmp/llmwiki-harness/verify-agent.mjs` gate (session-scoped cancel over
  HTTP: run errors with "Agent run cancelled" and issues no further LLM
  request).

- ~~**Multimodal embedded-image extraction + vision captions**~~ — **done** for PDF + DOCX + PPTX (`packages/server/src/commands/extractImages.js`): pdfjs + a pure-Node PNG encoder re-encodes decoded PDF raster; OOXML embedded media are read straight from the zip (no re-encode). Images are written to `wiki/media/<slug>/` with the exact camelCase wire shapes the frontend hard-filters on, so vision captions (client-side, over `/api/proxy`) work too. Verified 18/18 in isolation + end-to-end via `/api/invoke`. (Exotic PDF image codecs such as JPEG2000 are skipped gracefully.)

- ~~**Claude Code CLI / Codex CLI chat backends**~~ — **done**
  (`packages/server/src/cli.js`): faithful Node port of the desktop's Rust subprocess
  transports (`claude_cli.rs`, `codex_cli.rs`, `cli_resolver.rs`). The server
  runs on the host, so it spawns the locally-installed `claude` / `codex`
  binaries and treats them as completion engines — reusing an existing Claude
  Code subscription or Codex login with no separate API key. `*_detect`
  returns the desktop's `{installed,version,path,error}` shape (incl. the
  macOS quarantine hint); `*_spawn` validates the project working directory
  (must contain `wiki/index.md`), folds system messages into the first user
  turn, writes the stream-json turns / prompt over stdin, and streams each
  stdout line back as `claude-cli:{streamId}` / `codex-cli:{streamId}` SSE
  events with a terminal `:done {code,stderr[,stdout]}` (codex honors the
  clamped `timeoutMinutes`, 1–240, default 10); `*_kill` SIGKILLs the child.
  Login-shell PATH is resolved (cached) so node-shim CLIs work even under a
  GUI/daemon launch with a minimal PATH. Verified by committed tests
  (`packages/server/test/cli.test.js`), which keep the earlier 38/38
  verification standing: pure-function fixtures mirroring the Rust unit tests
  (arg builders for base + isolated modes, timeout clamping 1–240/default 10,
  shell-PATH banner/marker parsing, Anthropic content shaping, the codex
  stdout/stderr byte cap) plus real spawns against mock `claude`/`codex`
  executables on a temp PATH (detect `{installed,version,path,error}` shapes
  incl. stderr relay on non-zero `--version`, stream-json stdin serialization
  fidelity incl. system-preamble fold + image-block reshape, exact arg vectors
  as observed by the mock, per-line SSE events + terminal `:done {code,stderr[,stdout]}`,
  non-zero exit + stderr relay, SIGKILL → `done {code:null}`, all four
  working-directory guards, empty-conversation/prompt errors, and a
  prematurely-exiting child mapping to the desktop's
  "Failed to write to <label> stdin: ..." instead of an unhandled EPIPE crash).
  Two faithful-port divergences the fixtures caught were fixed: the codex
  stdout/stderr cap now appends whole UTF-8 chars only (exact-fit gets no
  newline, matching `append_capped_line`), and stdin writes attach a
  lifetime `error` listener so a closing pipe can never crash the server.
  The cap's byte length is tracked incrementally (`state.bytes`) instead of
  re-encoding the whole accumulated string per char — the naive loop was
  O(n²) and froze the server's event loop for minutes on a single large
  codex line (the standing `verify-cli-transports` gate's 1 MiB fixture
  hung waiting for `:done`); the gate is now part of the green set (86/86)
  with extra unit pins for cross-call byte accounting and the huge-line cap.
- ~~**Vector ranking blended into search results (RRF)**~~ — **done**
  (`packages/server/src/commands/search.js`): `search_project` now resolves the query
  embedding server-side, runs the per-page chunk blend (`search_by_embedding`),
  materializes vector-only hits, and fuses `keyword + vector + graph` with RRF
  (`apply_rrf_scores`), so web search ranking matches the desktop hybrid
  engine. Verified 18/18 (RRF fusion, vector-only snippets, graceful
  embedding-failure fallback). Falls back to keyword+graph if embeddings are
  disabled or the endpoint is unreachable. (The 4-signal relevance model in
  `graph-relevance.ts` stays client-only — it powers the Graph view.)
- ~~**Agent `graph.search` + graph-boosted search (end-to-end wiring)**~~ —
  **done** (`packages/server/test/agent-graph-tool.test.js`, 4 tests, plus a
  `graph.search` scenario in the standing `verify-agent.mjs` gate). The
  graph.js primitives were already unit-tested against the desktop's own
  Rust fixtures (`graph-search.test.js`); this suite proves the real
  surfaces: a scripted mock LLM issues a `graph.search` tool call during a
  live `agentStartTurnStream` turn and the runtime emits the desktop's exact
  sequence (`toolStart → referenceAdded ×2 → toolEnd → messageDelta → done`)
  with references in the desktop `AgentReference` serde shape (kind
  `"graph"`, camelCase `knowledgeContext` with
  relatedTo/tags/outgoingLinks/backlinks/linkCount), the tool observation
  round-trips into the follow-up LLM request, the non-stream
  `agentStartTurn` returns the matching `BackendAgentResponse`
  (message/references/toolEvents, no messageDelta), and
  `searchCommands.search_project` on a wiki with linked pages returns
  `mode: "hybrid"`, `graphHits > 0` and a synthesized `Graph neighbor of
  Alpha` result — the exact path the search UI, v1/v2 routes and the agent
  `wiki.search` tool share.

- ~~**Agent skills scanning**~~ — **done** (`packages/server/src/skills.js`): same scan
  roots as the desktop, prompt injection in the desktop format, reference reads.
  Verified by committed tests (`packages/server/test/skills.test.js` — all 13 of
  the desktop's own `skills.rs` loader fixtures ported verbatim: frontmatter +
  CRLF parsing, traversal/reserved-name/symlink rejection, oversize ignoring,
  `.md` + `SKILL.md`-folder discovery, case-insensitive names, nested folders,
  missing-description ignoring, dedup, only-`SKILL.md`-is-injected, slug-id-vs-
  name), user-level roots (~/.claude|.codex|.agents with project shadowing), and
  the planner-context fixtures (auto index vs explicit expansion + XML
  escaping). `skill.read_file` is now a faithful port of
  `read_active_skill_file`/`resolve_skill_read_target`: an active skill is
  required, targets resolve strictly inside the skill base (safe-relative check,
  canonical containment — symlinks escaping the base are blocked), errors carry
  the desktop strings ("requires an active skill", "requires path", "must be a
  safe relative path inside the skill directory", "cannot read outside the
  active skill directory", "target is not a regular file", "target is too large
  (max 262144 bytes)"), and the tool advertises the desktop's optional `skill`
  + `path` params, returning `{skill,path,content}` summarized as
  `read {skill}:{path}\n{content}`. One loader divergence the fixtures caught
  was fixed: candidate ids come from the case-agnostic file stem
  (`Reviewer.MD` → `Reviewer`), mirroring Rust `file_stem()`.
- ~~**Deep Research agent tool**~~ — **done**
  (`packages/server/src/agent.js` + `packages/server/src/agent-tools.js`): faithful port of the
  desktop's runtime-orchestrated contract (`src-tauri/src/agent/runtime.rs` +
  `tools.rs`). `deep_research.run` is **not** offered to the model
  (`toolsForRequest` omits it); when `request.mode === "deep"` and at least one
  retrieval channel is active (`request.tools.web || request.tools.anytxt ||
  wiki/source search offered`), the runtime brackets the retrieval phase with a
  `deep_research.run` `toolStart` (input = the user message) before the loop and
  a `toolEnd` (`"<N> reference(s)"`, N = accumulated deduped references) after
  it — emitted over SSE *and* pushed into the non-stream `toolEvents` array
  with `detail`, mirroring the desktop's `AgentToolEvent`s. Deep mode does
  **not** force web search on (`web.search` stays gated by `request.tools.web`).
  The registry-level executor returns the desktop marker
  `{query, status:"orchestrated_by_agent_runtime"}` (requiring a non-empty
  `query`), while a model-issued call is refused by the loop executor with the
  desktop's exact error ("deep_research.run is not available in the loop
  executor; use web.search, anytxt.search, source.search, and wiki.search
  directly") — surfaced as a `rejected: …` tool observation back to the model
  and a `failed` tool event, exactly like `record_loop_tool_rejection`.
  Verified 47/47 with a mock OpenAI-compatible LLM: exact SSE sequence
  (`toolStart → referenceAdded → toolEnd → messageDelta [→ done]`) and
  non-stream `BackendAgentResponse` shape; deep-mode start/end events over SSE
  + `toolEvents` (stream and non-stream); non-deep silence; the tool absent
  from the offered tool specs in every recorded LLM request; the exact
  rejection round-trip; plus cancel + unknown-project errors.

- ~~**Legacy web surface on the shipped v2 entry**~~ — **done**
  (`packages/server/src/index-v2.js` + `packages/server/src/raw.js` +
  `packages/server/test/legacy-surface.test.js`): `start:web` runs
  index-v2.js, which previously lacked the non-command endpoints the web
  shims and agents rely on (they existed only on the legacy `index.js`).
  index-v2 now mounts them all with identical semantics: `/api/raw`
  (convertFileSrc image/preview streaming — same MIME table, 400/404
  behavior, CORS + private cache headers), `/api/health` + `/api/commands`
  (diagnostics incl. the shared-store probe), and `/api/v1/*` (mounted
  BEFORE `express.json` and the v2 auth middleware, because it enforces its
  OWN desktop auth contract). Client-side companions: `rawFileUrl` appends
  `?token=` in token mode (`<img>` tags cannot send headers), and an agent
  run cancelled mid-fetch now reports the desktop's "Agent run cancelled"
  instead of a bare AbortError. Verified by the legacy-surface integration
  tests plus the standing gates (agent-cancel assertion in
  `/tmp/llmwiki-harness/verify-agent.mjs`, MCP interop in
  `verify-mcp-interop.mjs`).

- ~~**Open in OS file manager / reveal**~~ — **done**
  (`packages/server/src/opener.js` + `packages/server/src/commands/project.js` +
  `packages/server/src/commands/openerWeb.js`): the web server runs on the user's
  host, so the desktop's OS-open actions are real there too. `opener.js`
  faithfully ports `tauri-plugin-opener` v2 semantics — `open_path`
  (existence check + detached platform spawn: `xdg-open` / `open` /
  `cmd /c start`, exit status deliberately unobserved, like
  `open::that_detached`) and `reveal_item_in_dir` (canonicalize, then
  macOS `open -R`, Windows `explorer /select,`, Linux freedesktop
  `FileManager1.ShowItems` over `dbus-send` → xdg-desktop-portal
  `OpenURI.OpenDirectory` → `xdg-open <parent>` fallback chain).
  `open_project_folder` / `open_path_in_project` are exact ports of the
  Rust commands (project-root validation, canonicalization, the
  component-wise path-containment guard, and the
  `Failed to open …; reveal fallback also failed: …` compound errors),
  and two web-only commands (`web_open_path` / `web_reveal_path`) back
  the browser's `@tauri-apps/plugin-opener` shim — `openPath` keeps a
  browser-tab (`/api/raw`) fallback for headless hosts. Login-shell PATH
  resolution (shared with the CLI transports) finds `xdg-open`/`dbus-send`
  even under a GUI/daemon's minimal PATH. Verified 23/23 against mock
  `xdg-open`/`dbus-send` binaries (spawn args + canonicalization, relative
  and absolute targets, symlink and `..` escape refusal, exact validation
  and compound error strings, the open→reveal fallback, and the full Linux
  reveal failover chain).

- ~~**Agent `user.ask` structured forms (`userInputRequired`)**~~ — **done**
  (`packages/server/src/user-input.js` + `packages/server/src/agent.js` +
  `packages/server/src/agent-tools.js`): faithful 1:1 port of the desktop's
  mid-turn structured-question contract (`runtime.rs` + `types.rs`). The
  model pauses a turn with `user.ask` (aliases `user_input.ask` /
  `askUserQuestion` / `AskUserQuestion` / `ask_user_question` are
  normalized); the runtime sanitizes the schema — 12-field/8-option caps,
  field-type normalization (`singleChoice`/`radio`/… → `single` etc.),
  `<`/`>`/control-char cleaning with a 400-char cap, id charset filtering,
  field-id/option-value dedup (`choice` → `choice_2`), choice-default
  validation — into the camelCase `AgentUserInputRequest` wire shape
  (`{requestId, title, description?, fields[]}` with serde key omission),
  then emits `userInputRequired` + `done` and ends the turn with the form
  description as the message text (no assistant row persisted — the resume
  turn carries the answers). An invalid schema is rejected back to the model
  with the desktop's exact error (`user.ask requires … Return a corrected
  user.ask schema or answer without asking.`, `record_loop_tool_rejection`)
  so it can retry. The unmodified frontend's existing `UserInputRequestPanel`
  renders the form (streaming and non-stream paths) and resumes by sending
  the answers as a plain follow-up message — the desktop's stateless resume
  contract, no parked run. The tool is offered to the model only when a skill
  is active for the turn (the desktop's available-tools block). The
  non-stream response and the `/api/v1` `/chat` envelope now also carry the
  turn's events vector exactly like `AgentChatResponse.events`, redacted per
  `redact_for_external_api` (`fileChanged.previousContent` dropped;
  `messageDelta` is sink-only in the non-stream vector). Verified by 29 unit
  tests (the desktop's own Rust fixtures, ported verbatim) + the standing
  mock-LLM gate `/tmp/llmwiki-harness/verify-agent.mjs` (23 checks, of which
  these cover user-input: stream/non-stream shapes, rejection round-trip,
  alias, skills gate, stateless resume, events-vector redaction).

- ~~**Per-command `shell.exec` approval**~~ — **done** (`packages/server/src/shell-policy.js` + `packages/server/src/agent.js`): the web agent now mirrors the desktop’s exact per-command approval contract instead of the old all-or-nothing `LLM_WIKI_ALLOW_SHELL` gate. Faithful 1:1 port of `runtime.rs`: `is_shell_command_allowed_without_prompt` (exact `approvedShellCommands` match OR workspace-scoped auto-allow), the skills-active gate, the skill-preference-probe skip, and the exact “The Agent needs approval before it can run this command…” boundary message. The turn stops at the boundary; the frontend’s existing Approve button (driven by the `available`→skipped `shell_exec` step with detail `approval required: <cmd>`) resumes a new turn with `approvedShellCommands`. Verified by 36 committed unit tests (`packages/server/test/shell-policy.test.js` — the desktop’s own Rust fixtures ported verbatim) plus a mock OpenAI-compatible LLM over both `agent_start_turn_stream` (SSE) and `agent_start_turn` in the standing gate `/tmp/llmwiki-harness/verify-agent.mjs` (boundary text, resume-runs, workspace auto-allow, skills gate, probe skip).

- ~~**Agent offline degradation (runtime.rs no-usable-config branch)**~~ — **done** (`packages/server/src/agent-legacy.js` + `isUsableForBackendHttp` in `packages/server/src/llm-resolve.js`): when the resolved chat config is NOT usable for backend HTTP — missing API key or model, or a CLI-only provider such as claude-code/codex-cli — the web agent now degrades exactly like the desktop (`run_once_with_cancel_and_events`, `provider.rs is_usable_for_backend_http`): it never calls an LLM and never surfaces a provider/network error; it runs the deterministic router + retrieval pipeline (`routeQuery` / `should_plan_tools_with_model` / `should_fallback_wiki_search` in `router.rs`) and answers with the `build_retrieval_answer` summary (ok:true). On a fresh install (no provider key configured yet) the Chat pane works out of the box with retrieval-only answers. The port covers the exact desktop strings and shapes: the `"I searched the current LLM Wiki project for \"…\" and found … relevant page(s):"` answer, `wiki.search` started/completed toolEvents with `mode/tokenHits/vectorHits/graphHits` detail, the SSE sequence `toolStart → referenceAdded → toolEnd → done` (no `messageDelta` — deltas only come from LLM streaming), the no-tools fallback string, the `Router intent=…` gate, `skills.load` toolEnd (no toolStart), `shell.exec` via `request.shellCommand` (unapproved → `approval required:` + the exact not-run sentence; approved via `approvedShellCommands` → runs in `agent-workspace` and reports the desktop summary `shell.exec \`…\` exit=Some(0) timedOut=false\nstdout:\n…`), faithful-mode hint suppression, deep-mode `deep_research.run` brackets + wiki excerpts + `source.search`, and the `/api/v1/chat` offline envelope (200 `ok:true`, `usage.referenceCount`/`toolEventCount`). Verified 44/44 in the standing gate `scripts/verify/verify-agent-offline.mjs` (now RUNNING in gates.sh) + 16 committed unit tests (`packages/server/test/agent-offline.test.js`: router/answer helpers, `isUsableForBackendHttp` matrix, non-stream + stream paths, CLI-provider configs, router gating, shell unapproved/approved, and the usable-config regression guard that the online loop still runs).

- ~~**Headless browser end-to-end UX proof**~~ — **done** (`/tmp/llmwiki-harness/verify-browser-e2e.mjs`, standing gate): a Playwright (Chromium) run that serves the built SPA from the server with an empty isolated store, creates a fake "desktop" project on disk (one the web client did *not* create — the shared-data scenario), then drives the real UI: it opens the project through the server-backed folder picker (`list_directory` navigation + Select), asserts the Knowledge tree lists the wiki pages, a clicked wiki page renders its Markdown body in the reader, an **edit → save round-trip in the raw Markdown editor** (the web client's `write_file` lands the change in `<project>/wiki/quantum.md` on disk — the desktop-visible shared-data promise for wiki pages — and the reader re-renders the saved body), the Files tab renders the raw project tree (`schema.md` / `wiki` / `raw`), the Sources view renders the upload drop-zone, and the Review view live-shows an out-of-band `.llm-wiki/review.json` write (the desktop scenario, issue #13 item 3) without a Refresh. It then walks the remaining primary views and asserts each renders: the **Search** panel runs a keyword query and shows its result count (server-side `search_project` over `/api/invoke`), the **Knowledge Graph** panel, the **Wiki Lint** panel, the **Deep Research** panel, the **Skills** panel (which lists the scanned project + user skill folders from the server-side skill scan), and the **Settings** view's full section list (General / LLM Models / Embeddings / Image Captioning / External Information Sources / Network / Source Watch / Scheduled Import / MinerU PDF / API + MCP / Output / Interface / Maintenance) — all with ZERO page errors, ZERO genuine app console errors, and ZERO failed requests. The Sources visit pins the shared-SSE single-connection behavior (`src/api/events.ts`): the DropZone used to open its OWN `EventSource` to `/api/v2/events` and close it on unmount, which made the browser abort the in-flight request (`GET /api/v2/events net::ERR_ABORTED`) — a failed network request on every Sources visit plus a duplicate stream; `connectEvents` now ref-counts ONE module-level connection (opens with the first subscriber, closes only with the last), so the Sources visit + unmount produces no failed request at all. The only tolerated HTTP ≥400 traffic is the documented graceful read of optional per-project state (`.llm-wiki/review.json`, `lint.json`, `conversations.json`, …) that a fresh project lacks (the desktop errors on these too and falls back to empty defaults); the harness asserts every ≥400 is exactly such a read, so any other failing request fails the gate. Verified 34/34, deterministic across repeated runs. The create-project checks (dialog opens, scaffold lands on disk, project opens, Switch Project returns to welcome) and the edit flow's four checks (editor opens, Save returns to the reader, on-disk file updated, reader re-renders the saved body) sit inside the same zero-error harness, so any console/page error or untolerated HTTP ≥400 introduced by the create or edit/save paths fails the gate (the Search/Graph/Lint/Deep-Research/Skills/Settings visits are pinned the same way — zero page/console errors and no untolerated HTTP ≥400 across the whole session). (This supersedes the boot-only smoke, which only checked the welcome screen.)

- ~~**Web Files tree did not render after opening a project (race)**~~ — **fixed** (`src/App.tsx`): opening a project left the Files tree permanently empty in the browser. `handleProjectOpened` cleared the outgoing view state (`setSelectedFile(null)` + `setFileTree([])`) *after* `setProject`, racing `AppLayout`'s asynchronous `refreshProjectFileTree`: on the web backend the HTTP store reads (`loadProjectLlmOverride` / `loadOutputLanguage`) between `setProject` and the clear delayed it until *after* the fresh tree had landed, wiping it with no re-trigger. On desktop the in-memory plugin-store reads made the clear win the race, which is why it only surfaced on the web. The two clears now run *before* `setProject`, making the ordering deterministic on both backends; `resetProjectState()` still clears every per-project store first, so the cross-project-contamination invariant is preserved (and the stale-tree flash is shortened). Proven by gate 7/7 (Files tree renders) and the full 1734-test frontend suite.

- ~~**Legacy v1 page-level vector commands**~~ — **done** (`packages/server/src/commands/vectorstore.js`): the four desktop commands that had no Node equivalent — `vector_upsert` / `vector_search` / `vector_delete` / `vector_count` (`src-tauri/src/commands/vectorstore.rs`'s pre-0.3.11 `wiki_vectors` table) — are now served as a faithful port over a project-scoped `vec_pages` vec0 table in the shared server DB: delete-then-add upsert, cosine `score = 1/(1+distance)`, `[]` / no-op / `0` when the table does not exist, validation of page_id (empty/too-long + disallowed chars) and embeddings, dimension-change guard, and snake_case + camelCase arg names, with the page-id contract a 1:1 port of `validate_page_id_common` (code-point char count ≤ 256; every format/invisible family rejected). Registered in the invoke bridge — the Node registry now covers **every one of the 73 Rust handlers** (76 total with `vector_delete_project` + the 2 web-only opener commands). Verified 32/32 in the committed sqlite-vec suite (incl. the desktop's own `tests_v2` fixtures: unicode stem, 15 footguns, 256/257 boundary, empty-upsert no-op, dim/mismatch messages) + 15 `/api/invoke` assertions in the standing `verify-v1-http.mjs` gate + the full server suite.

- ~~**api-types `SearchResultSchema` under-described the live search payload (issue #38)**~~ — **done** (`packages/api-types/src/schemas/search.ts`): the SSOT used to declare only `{ path, score, snippet?, content? }`, so zod's default object parse silently stripped `title`, `titleMatch`, `images` and `vectorScore` from real search responses (and `z.infer<SearchResult>` omitted them at the type level). The schema now mirrors the exact `search_project` item contract: `title`, `titleMatch`, `images` always present, `vectorScore` on vector-ranked rows, `content` only with `includeContent` — with a new `SearchResultImageSchema` (`{url, alt}` objects, matching the server's `extractImages`). Verified by the committed `packages/server/test/search-result-ssot.test.js` (4/4): the issue's repro parses with zero field loss, plus real `search_project` round-trips — keyword leg (title/titleMatch/images survive; body-only hits keep `titleMatch:false`) and the vector-blended leg (RRF `vectorScore` preserved). `docs/API_REFERENCE.md`'s search row now documents the full payload.

- ~~**Headless browser agent-chat e2e (chat + shell approval in the real UI)**~~ — **done** (`scripts/verify/verify-browser-chat.mjs`, standing gate, RUNNING in gates.sh): a Playwright (Chromium) run that boots the real server against a **desktop-format shared plugin-store** (`LLM_WIKI_STORE_FILE` — the app adopts it, `/api/health` reports `store.shared=true` / `source=explicit`, and the desktop `lastProject` auto-opens in the web client), then drives the unmodified React chat UI end-to-end against a mock OpenAI-compatible LLM: it opens the Chat view, selects the desktop-created project skill, sends a message, watches the agent stop at the desktop-faithful `shell.exec` approval boundary ("The Agent needs approval…" + Approve command button showing the exact command), clicks Approve, and asserts the resumed turn executes the approved command and renders the answer — with ZERO page errors, ZERO console errors, ZERO failed requests, exactly 3 mock-LLM calls (boundary + approved-run + answer), `approvedShellCommands` in the resume, and the turn persisted to the shared `.llm-wiki/agent-sessions/` desktop-format file. Verified 33/33, deterministic across repeated runs (the reload phase now also asserts the issue-#26 web parity fix: with the client-held `conversations.json`/`chats/*.json` file copy removed — the crash-before-auto-save-flush window — the page reloads and the most recent shared server session auto-opens with its full transcript restored, with zero page/console errors and only the tolerated `.llm-wiki` optional-state 404s). Two parity gaps the durable 33-check run pinned and this cycle fixed: (a) the shell-approval boundary exchange is now persisted like the desktop's unconditional `AgentSessionStore::append_turn` (lib.rs) — SQLite `chat_messages` gets the approval-text assistant row (so the issue-#26 reload restores the approval summary even with the client-held file copies wiped) and the shared `.llm-wiki/agent-sessions/` file gets the full boundary exchange (previously nothing was persisted at the boundary, so a reload lost the summary); pinned by `packages/server/test/agent-shell-parity.test.js` (3/3); (b) an APPROVED `shell.exec` now runs the tools.rs `run_shell_exec` port — `/bin/sh -c <cmd>` inside `<project>/agent-workspace`, sanitized env, `timeoutSeconds` 1–30 default 30, bounded streams — and feeds the model the desktop's exact `shell.exec \`cmd\` exit=Some(0) timedOut=false\nstdout:\n…\nstderr:\n…` observation (the online loop previously returned a bare `exit N` line). It surfaced one real web-only product bug, fixed here: the web client PATCHes the sidebar auto-title for a locally-created conversation *before* the server lazily creates the session row, so every first chat 404'd (browser console error each time) and the title never survived a reload — `PATCH /api/v2/projects/:id/chat/sessions/:sessionId` is now **rename-or-create** (missing session is created for the same project; cross-project ids still 404, never adopted; `packages/server/src/api/chat.js` + regression test `packages/server/test/v2-chat-sessions.test.js`, documented in `docs/API_REFERENCE.md`).
- ~~**Headless browser ingest e2e (server-driven ingest through the real
  Sources UI)**~~ — **done** (`scripts/verify/verify-browser-ingest.mjs`,
  standing gate, RUNNING in gates.sh): the harness is rewritten for the
  server-driven-ingest architecture (issue #14 P0 stage 9) — the earlier
  pinned version drove the DELETED client-side queue driver
  (`.llm-wiki/ingest-queue.json`), which no longer exists. The gate now boots
  the shipped v2 entry (the only one that runs the server-owned orchestrator)
  against a desktop-format project whose `raw/sources/` already holds a file
  the "desktop" dropped in, opens it through the server-backed picker, and
  proves the core loop with ZERO clicks: the client file-sync layer issues
  enqueue-by-path, the SERVER's SQLite `ingest_queue` row goes
  pending → processing → completed (observed over
  `GET /api/v2/projects/:uuid/ingest/queue` — the v2 `IngestTask` shape,
  `file_path` resolved to the source), the two-stage analysis→generation
  pipeline streams through a mock LLM with exactly ONE call per stage, the
  source-summary page lands on disk (marker + frontmatter + `sources` cite +
  deterministic `wiki/log.md` entry + `wiki/index.md` link), the activity
  panel reports Done, the page appears LIVE in the Knowledge tree, a manual
  Ingest re-run replays from `<project>/.llm-wiki/ingest-cache.json` with
  ZERO new LLM calls, and app-write-ignore keeps the shared
  `file-change-queue.json` empty (no re-ingest loop) — all with ZERO
  page/console errors and ZERO non-optional failed requests. Verified 28/28,
  deterministic across repeated runs. The desktop's per-project queue FILE
  is deliberately gone: both clients share the one server-owned queue (desktop
  ingest requires the reachable server — the accepted `plans/server-ingest.md`
  degradation), so the RUNBOOK shared-data row now says so.
- ~~**Web search providers beyond SearXNG/Tavily/SerpApi**~~ — **done**
  (`packages/server/src/commands/websearch.js`): the server now covers the
  desktop's FULL provider set — **Firecrawl, SearXNG, Tavily, Ollama, Brave,
  Bocha, SerpApi** — with a faithful port of `run_web_search` +
  `WebSearchConfig.resolved()` + every per-provider client in
  `src-tauri/src/agent/tools.rs` (Brave's `X-Subscription-Token` + `count`
  cap, Bocha's `{query,freshness:"noLimit",summary:true,count}` envelope with
  the `code`/`msg` payload-error mapping, Firecrawl's key-free
  `{base}/v2/search` + `success:false` + blocked-IP hint, Ollama's
  `{ollamaUrl}/api/web_search` Bearer call, SerpApi's
  `/search?engine=&q=&api_key=&num=` URL with the section-order fallback,
  `normalize_web_result` field fallbacks, `web_search_result_limit`
  1–20 / Bocha 1–50, empty-URL filtering, and the desktop's missing-key /
  HTTP-status / invalid-JSON error strings). The shared Settings UI already
  offered the provider cards ("Test" button) and the frontend's
  `webSearch()` already passed `provider: "brave" | "bocha" | "firecrawl" |
  "ollama"` — on the web build those previously threw
  "not yet supported in web-server mode"; now a provider + key saved in the
  shared plugin-store works identically from the desktop and the web client.
  Verified 39/39 in the committed `packages/server/test/websearch.test.js`
  (local mock HTTP servers for the configurable-URL providers, exact
  request-shape stubs for the public-endpoint ones).

- ~~**Ingest liveness heartbeat (#32)**~~ — **done**
  (`packages/server/src/store/ingest-queue.js` +
  `packages/server/src/ingest/orchestrator.js` + migration
  `014_ingest_heartbeat` + `packages/api-types` `IngestTaskSchema`): long LLM
  calls inside a stage (`generation`, `analysis`, `caption`, `embed`) used to
  leave the `ingest_queue` row frozen at the stage boundary for the whole
  call — a healthy run was indistinguishable from a hung one (owner
  acceptance 2026-08-05, issue #32). The orchestrator now starts a 15 s
  per-claim heartbeat (`heartbeat_at` + a fresh `updated_at`) that runs while
  the row is `processing` and is cleared on every exit path (success, retry,
  usage-limit defer, cancel); the store tick is a no-op once the row leaves
  `processing`, so it can never resurrect or mask a terminal state. The field
  flows through the queue API (`GET /ingest/queue` / `/queue/:taskId`) and the
  SSOT `IngestTaskSchema`. Verified 6/6 new assertions in the committed
  `ingest-queue-store.test.js` (null-until-claim, tick semantics, no-op on
  completed/failed/pending/missing, progress untouched) + the committed
  orchestrator liveness test (`orchestrator.test.js`: heartbeat advances over
  a held-open pipeline mock and stops after completion, 100 ms test cadence)
  + an API exposure test (`api-ingest-routes.test.js`; full server suite green).
  The contract is now ALSO pinned over a LIVE server by the standing
  `verify-ingest-heartbeat` gate (14/14, RUNNING in gates.sh on the shipped v2
  entry): 200 ms test hook + slow mock LLM (2.5 s per call) + concurrency 1, a
  second task held `pending` with `heartbeat_at` null behind the first, the
  processing task's heartbeat advancing while progress stays frozen inside the
  in-flight call, and the heartbeat stopping cleanly after completion.
- ~~**Web chat reload auto-opens the most recent session (issue #26 item 1)**~~ — **done** (`src/components/chat/chat-panel.tsx`): the web session-sync effect now mirrors the desktop's `hydrateProjectChatStore` auto-open — after `listChatSessions` (most-recent-first) populates the sidebar, when no conversation is active yet and shared server sessions exist it selects `sessions[0]` and loads its transcript, so a reload in the issue-#26 window (before the 2 s `conversations.json` auto-save flush, or with a stale/missing file copy) never leaves the chat pane stranded on the empty “Start a new conversation” state even though the shared sessions are visible in the sidebar. An active conversation set meanwhile (user click, file hydration) is always respected — same “don’t steal focus mid-load” semantics as `hydrateProjectChatStore`’s `activeChangedDuringLoad` guard. Verified by the extended headless browser agent e2e (`scripts/verify/verify-browser-chat.mjs`, 33/33): after the approved shell turn persists, the harness wipes the whole file-based chat copy, reloads the real page, and asserts the most recent session auto-opens (transcript restored with no sidebar click) with zero page/console errors; a pre-fix run fails exactly there (the answer never appears).
- ~~**Settings → API + MCP contract (api_server.rs parity)**~~ — **done**
  (`packages/server/src/api-v1.js` + `packages/server/src/commands/misc.js`):
  the web `/api/v1` surface now enforces the desktop's exact request
  pipeline from `src-tauri/src/api_server.rs::handle_request` — (1) the
  **kill-switch**: `apiConfig.enabled=false` makes every non-/health
  endpoint 503 `"API server is disabled in Settings → API Server"` BEFORE
  auth (a disabled API beats a valid token, never leaks 401/200), while
  `/health` stays reachable with `enabled:false`; (2) **agent chat** (`POST
  .../chat` + `.../chat/:sid/cancel`) always requires a REAL token
  (`is_agent_chat_request` + `is_token_authorized`), even when
  `allowUnauthenticated` opens the rest of the API; (3) the **method gate**
  (only GET/POST/PATCH) 405s with the desktop string; (4) `/health` reports
  the full desktop envelope — `version` (server package, like
  `CARGO_PKG_VERSION`), `allowLanAccess`, `agent:{chat:true,streaming:false}`
  — and `mcpEnabled` now defaults to **false** exactly like
  `api_mcp_enabled`'s `unwrap_or(false)` (the MCP stdio process
  self-disables on `health.mcpEnabled === false`, so one shared store now
  yields one MCP availability on both clients); (5) `mcp_server_entry_path`
  (Settings → API + MCP "Copy config") resolves the real bundled
  `mcp-server/dist/src/index.js` like `lib.rs` (repo-chain + cwd
  candidates, canonicalized first hit) or throws the desktop's exact
  `npm run mcp:build` hint instead of returning an empty string — the
  desktop-faithful status string `running` is also returned by
  `api_server_status` (the web server IS the API server) so the unmodified
  frontend's status-line vocabulary works. Verified 7/7 in the committed
  `packages/server/test/api-v1-contract.test.js` (health envelope incl.
  mcpEnabled/allowLanAccess defaults, kill-switch 503 before auth with the
  exact string, 405 gate, agent-chat token gate incl. a mock-LLM
  with-token turn, mcp entry path/error branches; the pre-existing
  `/api/v1/chat` tests now send the token like the desktop MCP client) and
  the standing gate `scripts/verify/verify-mcp-interop.mjs` (since recreated
  in the repo and extended to 32/32 per entry on both server entries: tokenless
  chat 401 in unauthenticated mode, disable→503→re-enable live from the shared
  store, `/health` reachability, mcp entry path).

- ~~**Externally-written review items did not appear until manual Refresh**~~ — **done** (issue #13 item 3): the project watcher now allowlists `.llm-wiki/review.json` on `project://files-changed` (`packages/server/src/commands/fileSync.js` — every other `.llm-wiki` state file stays ignored; chat/queue/history are read from disk on access), and the shared cross-client event handler (`src/lib/external-project-changes.ts`) reloads the review store when the payload carries that path. A review item added or resolved on the desktop now shows up in the open web Review view without a Refresh; the server's own writes stay suppressed (app-write-ignore), so resolving on the web never echoes. Verified by committed tests (`packages/server/test/project-watch-state.test.js` 4/4 — out-of-band emit, self-write suppression, non-allowlisted `.llm-wiki` ignored, wiki-edit regression + raw/sources exclusion — and `src/lib/external-project-changes.test.ts` 4/4 — reload on the review path, no-touch otherwise, project-scoping, tree-refresh preserved) and the standing shared-data gate extended to 20/20 (`/tmp/verify-filesync-shared.mjs`: out-of-band `review.json` write emits the event with the path; the server's own `write_file` to `review.json` is suppressed).
- ~~**Web fs copy/delete commands were not faithful Rust ports**~~ — **done**: `copy_file` / `copy_directory` / `delete_file` in `packages/server/src/commands/fs.js` now mirror `src-tauri/src/commands/fs.rs` 1:1 — every operation marks the touched path an app write BEFORE and AFTER (`file_sync::mark_app_write_path` semantics), so the source watcher no longer enqueues a second, spurious task into the SHARED `.llm-wiki/file-change-queue.json` when the web client copies a source into `raw/sources` (the source-import / scheduled-import / folder-import flows — the desktop suppresses these; the web did not, duplicating ingestion on either client through the shared queue) and no `project://files-changed` echo for copies into `wiki/`. Error strings and shapes match the desktop: `Failed to create parent dirs: …` / `Failed to copy '{source}' to '{destination}': …` / `'{source}' is not a directory` / `Failed to create dir …` / `Failed to copy '{file}': …` / `Failed to delete file|directory '{path}': …`, dot-entries skipped by `copy_directory` (files AND dirs, like the Rust `starts_with('.')` guard), its return list is the copied FILES only (the Rust `Vec<String>`), and a missing delete target is a hard error (Rust `fs::remove_file` errors) instead of a silent no-op — the shared frontend already tolerates the delete error on the desktop; the Windows-transient delete retry (`remove_path_with_retry`, 250/500/1000 ms backoff) is ported too. Verified by the committed `packages/server/test/fs-copy-delete-contract.test.js` (10/10: error strings, files-only return + dot-skip, app-write marking, and watcher-level proofs that an app-owned copy/delete into `raw/sources` creates no change-queue task while an out-of-band one still does) + updated `fs-writer-events.test.js` (23/23), and the standing shared-data gate extended to 20/20 over the live server (`/tmp/verify-filesync-shared.mjs`).
- ~~**Binary request bodies through `/api/proxy` were text-only (corrupted MinerU uploads)**~~ — **done**: the proxy envelope now mirrors the desktop's raw-bytes-to-reqwest contract — `packages/server/src/proxy.js` accepts `bodyBase64` (byte-exact binary body; optional `bodyContentType` fills a missing Content-Type only) and `formEntries` (multipart/form-data rebuilt server-side with its own boundary; the caller's stale browser boundary is dropped), and `src/web/http.ts` emits them for Blob/ArrayBuffer/TypedArray and FormData bodies respectively (previously every non-string body was UTF-8-decoded, corrupting the MinerU cloud PDF PUT and the local MinerU multipart submit). Hop-by-hop headers stay dropped, custom headers forward, binary responses stream back byte-exact, the text/JSON contract is unchanged, and ambiguity/invalid entries are rejected with the desktop's exact 400 strings (`Ambiguous body: send exactly one of body, bodyBase64, formEntries`, `formEntries must be an array`, `Invalid formEntries entry`, `Invalid formEntries file part`, `bodyBase64 must be a string`). Verified by the standing `scripts/verify/verify-proxy-binary.mjs` gate (now RUNNING in gates.sh on BOTH server entrypoints, 23/23 per entry) + committed `packages/server/test/proxy-binary.test.js` (8/8) and `src/web/http.test.ts` (9/9).
- ~~**Scheduled-import e2e gate (was SKIPped)**~~ — **done**: the harness was
  stale against the shipped boot contract (its default entry was the legacy
  `index.js`, which serves the minimal "Connect to your wiki server" client,
  not the SPA — so `button:has-text('Open Project')` never rendered, and its
  queue-drain check read the deleted client-side `.llm-wiki/ingest-queue.json`
  that the server-owned SQLite `ingest_queue` replaced). `verify-scheduled-import.mjs`
  now defaults to `packages/server/src/index-v2.js` with `LLM_WIKI_AUTH_MODE=none`
  (the other browser gates' boot contract), unwraps the v2 `{ok,result}` invoke
  envelope (featuring the copy_directory files-only return + exact not-a-directory
  error — what indexes.js serves as a raw result, v2 wraps), uses `/api/v2/events`
  for SSE, and observes the queue over `GET /api/v2/projects/:uuid/ingest/queue`.
  The e2e proves the whole feature through the real UI against a mock LLM:
  Settings hydration of the desktop-written `scheduledImportConfig`, the
  scanAndImport copies landing in `raw/sources/scheduled-import/` with the
  desktop-shaped `scheduled-import-db.json`, both sources ingested through the
  SHARED server queue, and a reload re-running the scan with zero new LLM calls
  (md5 dedup). RUNNING in gates.sh, 39/39.
- ~~**MinerU-PDF e2e gate (was SKIPped)**~~ — **done**: same boot-contract
  staleness as scheduled-import (legacy default entry; the queue-drain check
  read the deleted client-side queue file). `verify-browser-mineru.mjs` now
  boots the shipped `index-v2.js` and observes the server SQLite queue over the
  v2 REST API. It proves the entire MinerU path end-to-end in the browser with a
  mock MinerU API + mock LLM: watcher auto-enqueue of a desktop-dropped PDF,
  real multipart submit (byte-exact PDF), shared `.cache` MinerU markdown,
  image ref rewrites, byte-exact `wiki/media/sample/mineru/images/image-1.png`,
  mock-LLM generation carrying the MINERU text, completed server-queue task,
  live Knowledge-tree update — ZERO page/console errors and ZERO failed
  requests. RUNNING in gates.sh, 22/22.
- ~~**v2-server surface harness (was SKIPped)**~~ — **done**: the harness pinned
  a pre-cutover contract (unauthenticated `/api/health` with a token
  configured, RAW invoke results, SSE on `/api/events`, and "the server's own
  write is broadcast as `project://files-changed`"). It now pins the shipped
  contract: token-gated `/api/*` (bearer/header/`?token=`), the `{ok,result}`
  invoke envelope with the deprecation header, `/api/v2/events` SSE where an
  out-of-band edit emits `project://files-changed` while the server's OWN write
  emits `file:modified` (app-write-ignore — no self-echo, cross-tab live sync),
  and one real fix surfaced by the rewrite: malformed JSON bodies to the v2
  Express surface now return the legacy `400 {"error":{code:"VALIDATION_ERROR",
  message:"Invalid JSON body"}}` instead of a scrubbed 500
  (`packages/server/src/middleware/error.js` maps body-parser
  `entity.parse.failed`). RUNNING in gates.sh, 39/39.
- ~~**Deep Research card collapsed the moment the task completed**~~ — **fixed**
  (`src/components/layout/research-panel.tsx`, issue #13 item 4): the three
  status-group `.map()`s re-mounted a card when its status left `running`, and
  the card's `expanded` state initialized from the mount-time status — so the
  synthesis the user was watching stream vanished the instant the task hit
  `done`/`Saved` (the pane showed only the topic + Saved badge; the answer was
  hidden until an extra click). Cards are now rendered as ONE keyed list
  (running → queued → done, insertion order), so React preserves the card
  instance across status changes, and the auto-open starter is a latched
  effect that fires when a task STARTS running (never auto-collapses; a manual
  collapse mid-run stays honored). The finished answer now stays visible
  inline with the Open affordance. Pinned by the new standing gate
  `scripts/verify/verify-browser-research.mjs` (29/29, RUNNING in gates.sh).
- **HUFF/CDIC `.mobi`** — the only remaining binary-ingest gap: the web
  server decodes PalmDOC/uncompressed `.mobi` but not HUFF/CDIC (the desktop
  uses the `mobi` crate); a from-scratch JS HUFF/CDIC decoder is not
  shippable-quality, so this stays a documented convert-to-EPUB limitation.
  Legacy `.xls` is now supported (SheetJS, verified) and legacy `.doc` is
  now supported and verified against real Word 97–2003 fixtures
  (`packages/server/test/legacy-doc.test.js` + vendored MIT corpus, 17/17).
  Overnight runs must NOT replace the HUFF/CDIC limitation with an untested
  decoder (no HUFF fixture exists on this host to verify it); keep the
  documented limitation unless a verifiable fixture+test can be produced.
- ~~**Sources view opened a duplicate SSE stream and logged a failed request**~~ — **fixed**
  (`src/api/events.ts`): every mounted `DropZone` (Sources view) used to call
  `connectEvents`, opening its OWN `EventSource` to `/api/v2/events` alongside the
  global `sse-sync` stream, and `close()` it on unmount — the browser aborts the
  in-flight request, so every Sources visit logged `GET /api/v2/events
  net::ERR_ABORTED` in the console/network (a failed request the standing
  zero-failed-requests gates forbid) plus a duplicate SSE connection. `connectEvents`
  now ref-counts ONE module-level connection: the stream opens with the first
  subscriber (sse-sync or a DropZone), dispatches every envelope to all
  subscribers, reconnects with backoff while any subscriber remains, and closes
  only when the LAST subscriber disconnects — so the Sources view rides the
  global stream and its mount/unmount never touches the EventSource. Per-listener
  `onOpen`/`onError` and error isolation are preserved; double-disconnect is a
  no-op. Same fix applies to the desktop build (its DropZone rides the same
  transport). Verified 8/8 in the committed `src/api/events.test.ts` (single
  connection across subscribers, per-subscriber disconnect, last-man-closes,
  `onOpen` per listener, backoff reconnect, reconnect cancellation, double-
  disconnect no-op, listener exception isolation), full mock suite green, and
  the headless browser e2e now visits the Sources view between the Files and
  Review checks and still asserts ZERO failed requests (`verify-browser-e2e.mjs`,
  34/34) — pre-fix the Sources visit alone failed that assertion.

- ~~**Web binary-source read path was a plain UTF-8 read**~~ — **fixed**: `read_file` now
  mirrors `src-tauri/src/commands/fs.rs` exactly — fresh `.cache` short-circuit,
  PDF/Org/Office/EPUB/MOBI extraction, image/media/legacy-doc placeholders, the
  exact `File does not exist: '…'` / `Failed to read file '…' as text: …` errors.
  PDF reads produce the desktop's `extract_pdf_markdown` **per-page markdown**
  (`## Page N\n\n<text>\n`, blocks joined by `\n\n`; `read_file` on a file under
  `raw/sources` with `extractImages` additionally writes the extracted rasters to
  `wiki/media/<stem>/` — `preprocess.js`'s `extractPdf` calls the same
  `extractPdfMarkdown` port with no media destination so the shared `.cache`
  matches across clients).
  `preprocess_file` now also writes the extraction cache (Rust `write_cache`) and
  returns the Rust `"no preprocessing needed"` sentinel for **every** format
  outside pdf/org/office/ebook — including plain text (fs.rs's exact match arms),
  and the agent `source.search` tool is a 1:1 port of `tools.rs
  search_sources` (text read directly, binaries only through a fresh cache,
  empty-query error, top_k clamp 1..10, 500-char snippets, 10k file cap); the
  walk is exported as `searchSources(projectPath, query, topK)` for science use.
  All pinned by the standing gate `scripts/verify/verify-source-text.mjs`
  (38/38 on both server entries — `read_file` per-page PDF markdown, the real
  Word 97–2003 fixture bodies incl. a 1:1 `extract_pdf_markdown`-shape check,
  cache staleness, sentinels, app-write-ignore for cache writes, `source.search`
  coverage, and a mock-LLM turn that carries the binary source reference).


- ~~**Chrome Web Clipper companion listener**~~ — **done** (`packages/server/src/clip-server.js`, a faithful port of `src-tauri/src/clip_server.rs` + `cors.rs` + the clip auth path of `api_server.rs`): the server now hosts the desktop's exact **:19827 companion protocol**, so the **unmodified** Chrome extension (`extension/`) works against the web backend exactly like it works against the desktop app. Exact route set and bodies (`GET /status` `{"ok":true,"version":"0.1.0"}`, `GET|POST /project`, `GET|POST /projects` with the `current` flag, `POST /clip` → `raw/sources/<slug>-<YYYYMMDD>.md` with byte-identical frontmatter (`type: clip` / `origin: web-clip` / `tags: [web-clip]`) and `-2/-3` dedup, `GET /clips/pending` hand-off that clears on read, `{"ok":false,"error":"Not found"}` unknown-route/wrong-method 404s, exact 400/500 validation messages), the desktop's bind lifecycle (3 retries → `port_conflict` status, no further retries; crash restarts with backoff; `starting|running|port_conflict|error` status machine surfaced verbatim by the `clip_server_status` command — the old `"disabled (web-server mode)"` stub is gone), the narrow CORS allow-list from `cors.rs` (only `chrome-extension://` / `moz-extension://` / http localhost/127.0.0.1/[::1] / tauri origins echo `Access-Control-Allow-Origin`), and the LAN auth contract (loopback bypasses; any other caller needs the API token via `Authorization: Bearer` or `x-llm-wiki-token` — NO `?token=`, the desktop passes an empty query). `clip_server_status` is wired into both server entry points (`index.js` + `index-v2.js`), the web client's clip watcher arms itself on the reported status (`running`/`port_conflict`) before polling (so a listener-less server produces no connection-refused noise), and project open registers the current + recent projects with the companion for the extension's picker. Verified by `scripts/verify/verify-clip-server.mjs` (now RUNNING in gates.sh): protocol bytes, slug/dedup, CORS, port_conflict, LAN auth when a non-loopback interface exists, and a headless-browser e2e on the shipped v2 entry proving extension → server → UI → **server-owned ingest queue** (issue #14 P0 stage 9 SSOT in `LLM_WIKI_DATA_DIR/server.db`) → mock-LLM processing, with ZERO page/console errors and ZERO non-optional failed requests.



- ~~**Same-host port-conflict diagnostics (web server vs. the desktop's own `:19828`)**~~ —
  **done** (`packages/server/src/listen-guard.js`, wired into BOTH server entries): when the
  main port is already bound — the expected same-host topology, since the desktop app's built-in
  REST API (`src-tauri/src/api_server.rs`) owns `:19828` while it runs, which is also the web
  server's default — the server now exits fast (code 1, milliseconds) with ONE actionable
  diagnosis naming the address + `EADDRINUSE`, a concrete free-port suggestion
  (`LLM_WIKI_PORT=<port+1>`), the `LLM_WIKI_API_BASE_URL` follow hint for MCP/agent tools, and
  the DESKTOP-app cause. No success banner and no raw `Unhandled 'error'` crash trace: `index.js`
  (legacy http) got an `error` listener where it previously threw, and `index-v2.js` (Express 5
  delivers bind errors to the listen **callback**, which the old anonymous callback silently
  swallowed) now checks the callback arg + an idempotent server `error` guard, so the previous
  silent zombie is gone. `bindFailureMessage` also maps EACCES → port guidance, EADDRNOTAVAIL →
  `LLM_WIKI_HOST`, and preserves unknown error text; `exitOnBindFailure` prints exactly once
  (Express double-delivery safe) via `fs.writeSync` so the message survives `process.exit`.
  Positive control: both entries still boot + serve on a free port and stop cleanly on SIGTERM.
  Pinned by the standing `scripts/verify/verify-port-conflict.mjs` gate (26/26, now RUNNING in
  gates.sh on both entries; the old skip claimed v2 passed — the harness in fact pinned the v2
  zombie, now fixed).

- ~~**Drop vestigial SQLite tables (issue #39)**~~ — **done**
  (`packages/server/src/store/db.js` migration `015_drop_vestigial_tables`):
  the server never wrote the `reviews` table (reviews are file-backed,
  `.llm-wiki/review.json`) nor the `graph_nodes`/`graph_edges` tables (the
  graph is rebuilt on demand from `wiki/*.md` — PUSH1 G13); all three were
  schema-only with zero rows in every observed database and no code touching
  them outside their CREATE statements. Keeping schema whose truth lives
  elsewhere invites split-truth writes, so 015 drops them idempotently
  (`DROP TABLE IF EXISTS`, `graph_edges` first — it FK-references
  `graph_nodes`), runs last on fresh installs (006/008 create the tables,
  then 015 removes them) and as a one-shot on existing 001–014 databases.
  Pinned by two committed suites (`drop-vestigial-tables.test.js` fresh-
  install path incl. no dangling FK references; `drop-vestigial-upgrade.test.js`
  pre-015 upgrade path incl. the dropped 008 indexes and sqlite_sequence
  rows), the G13 ledger row in `docs/PUSH1_ACTUAL_ARCHITECTURE.md` carries a
  closing note, and the migration byte-checks in the standing
  `node --check` + server-test gates.

## Notes & troubleshooting

- **Expected 404/500 in the browser console for a fresh project.** On open the
  app reads optional state files (`review.json`, `lint.json`,
  `conversations.json`, …) that don't exist yet; the code catches the "not
  found" and uses empty defaults — exactly as the desktop app does (the Rust
  `read_file` also errors on missing files). The browser logs the HTTP status;
  it is harmless.
- **"Web client build not found"** when opening the server URL → run
  `npm run build:web` (the server serves `dist-web`, which is empty until you
  build).
- **Port already in use** → the server exits fast with an actionable diagnosis (the most common
  cause is the DESKTOP app running and owning its built-in REST API on `:19828`, the web
  server's default). Set `LLM_WIKI_PORT` to a free port (the message suggests one) and
  open that URL; MCP/agent tools should follow via `LLM_WIKI_API_BASE_URL`.
- **LLM provider CORS errors** → should not happen: LLM and embedding traffic
  goes through `/api/proxy`. If you see a direct browser CORS error, the
  request is same-origin or the provider blocked the server's outbound IP.
- **`npm run typecheck`** validates both the shims and the app together
  (`src/web/**` is part of the normal TypeScript project).

---

## Still want the desktop app?

The Tauri desktop build is intact:

```bash
# requires Rust: https://www.rust-lang.org/tools/install
npm run build:desktop          # builds mcp-server + web assets
npm run tauri build            # native installer
# or for development:
npm run tauri dev
```

The web and desktop builds share `src/`; only the build config and the
`@tauri-apps/*` resolution differ.
