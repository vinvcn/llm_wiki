# API Reference

The LLM Wiki server exposes a REST API under `/api/v2/*` (Express + Zod).

> **Machine-readable spec:** `GET /api/v2/openapi.json` — an
> [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0) document generated from
> the Zod schemas in `@llm-wiki/api-types` (the API's source of truth). Load
> it into Swagger UI, Postman, or `openapi-generator` for typed clients. The
> document currently registers the projects CRUD, the chat-session endpoints,
> and the chunked-upload protocol only; the remaining endpoints are indexed
> on this page. For the routes it covers, the OpenAPI document is
> authoritative for request and response shapes. The endpoint itself is
> auth-gated like any other non-public route.

Base URL: same origin as the web client, or `VITE_API_URL` for remote
deployments (see [CLIENT_CONFIG.md](./CLIENT_CONFIG.md)).

---

## Authentication

Whether a token is required depends on the auth mode (`LLM_WIKI_AUTH_MODE`;
see [DEPLOYMENT.md — Auth precedence](./DEPLOYMENT.md#auth-precedence)):

- **`token` mode** — every non-public endpoint requires the token. With no
  token configured the server is effectively **closed**: every non-public
  route answers `401`.
- **`none` mode** (`open` is accepted as a synonym) — the server is always
  open; no token is checked.
- **auto** (the default when the variable is unset) — open while no token is
  configured (zero-friction local mode); required as soon as one exists (env
  `LLM_WIKI_API_TOKEN` or shared-store `apiConfig.token`). Setting
  `apiConfig.allowUnauthenticated = true` re-opens the server in this mode
  only — `token` mode ignores it.

Three equivalent ways to present the token:

| Method | Example |
|---|---|
| Bearer header (preferred) | `Authorization: Bearer <token>` |
| Custom header | `x-llm-wiki-token: <token>` |
| Query parameter | `GET /api/v2/projects?token=<token>` |

**Public endpoints** (never require a token): `GET /api/v2/health`,
`GET /api/v2/version`, `GET /api/v2/auth/status`, `POST /api/v2/auth/login`.

Unauthorized requests fail with `401`:

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required", "details": null } }
```

---

## Error envelope

All errors are normalized to a single envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable description",
    "details": null
  }
}
```

`details` carries structured info when useful (e.g. Zod validation issues,
upstream provider info). Stable error codes and their HTTP statuses:

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Request failed Zod validation (see `details` for field issues). |
| `UNAUTHORIZED` | 401 | Missing or invalid API token. |
| `FORBIDDEN` | 403 | Authenticated but not allowed (e.g. shell tools disabled). |
| `NOT_FOUND` | 404 | Resource (project, file, task…) does not exist. |
| `PROJECT_NOT_FOUND` | 404 | The `:id` segment does not resolve to a known project (numeric id, UUID, and plugin-store registry all missed). Returned by project-scoped routes such as `POST /api/v2/projects/:bogus/chat`. |
| `CONFLICT` | 409 | State conflict (e.g. duplicate project). |
| `FILE_TOO_LARGE` | 413 | Upload exceeds the maximum upload size (`LLM_WIKI_MAX_UPLOAD_MB`, default 50 MB) — multipart oversize and oversize chunked-upload `init` alike. |
| `RATE_LIMITED` | 429 | Too many requests. |
| `INTERNAL_ERROR` | 500 | Unexpected server error (internals are never leaked). |
| `UPSTREAM_ERROR` | 502 | An upstream provider (LLM, search API) failed. |
| `WORKER_BUSY` | 503 | Worker pool saturated; retry later. |

---

## Endpoints by domain

`:id` accepts **either** the numeric projects-table id **or** the project
UUID (resolution order: numeric id → UUID → plugin-store registry, with the
projects row materialized on demand for registry-known projects).
Project-scoped routes are mounted under `/api/v2/projects/:id/...`.

### Meta

| Method | Path | Description |
|---|---|---|
| GET | `/api/v2/health` | Public. Liveness + version + registered command count. |
| GET | `/api/v2/version` | Public. Server version, Node version, platform. |
| GET | `/api/v2/openapi.json` | OpenAPI 3.1 document for the registered routes (see the spec note above). **Not public** — auth-gated like any other non-public endpoint. |

### Auth

| Method | Path | Description |
|---|---|---|
| GET | `/api/v2/auth/status` | Public. `{ authRequired, authConfigured, allowUnauthenticated }` — used by the client to decide whether to show the login screen. |
| POST | `/api/v2/auth/login` | Public. Body `{ "token": "..." }` → `{ "success": true }` or `401 UNAUTHORIZED`. Any token succeeds only while the server is open (no token configured, or `allowUnauthenticated` set); otherwise the body token is validated against the configured one. |

### Projects

| Method | Path | Description |
|---|---|---|
| GET | `/api/v2/projects` | List all projects → `{ projects: [...] }`. |
| GET | `/api/v2/projects/:id` | Get one project → `{ project }`. `404` if unknown. |
| POST | `/api/v2/projects` | Create. Body `{ "name", "path" }` (server-side folder path) → `201 { project }`. |
| PATCH | `/api/v2/projects/:id` | Update fields (e.g. name) → `{ project }`. |
| DELETE | `/api/v2/projects/:id` | Delete → `204 No Content`. |

### Files (`/api/v2/projects/:id/files`)

| Method | Path | Description |
|---|---|---|
| GET | `/files/tree` | Directory tree. Query: `path`, `includeHidden`, `maxDepth`. |
| GET | `/files/content` | Read a file's text content. Query: `path`. |
| POST | `/files/upload` | Write a file. JSON body with path + base64 content. |
| POST | `/files/upload/init` | Open a chunked-upload session (files >10MB). Body `{ "fileName", "fileSize", "destPath" }` → `201 { "uploadId" }`. `fileSize` over the upload cap → `413 FILE_TOO_LARGE`. |
| PUT | `/files/upload/:uploadId/chunk` | Append one octet-stream chunk. Query: `offset` (must equal the server's byte count) → `{ "received" }`. Offset mismatch → `400` with `details.received` — resume by resending from that byte count. |
| POST | `/files/upload/:uploadId/complete` | Finalize a fully-received upload: staging → `destPath` (atomic write), emits `file:created`/`file:modified` → `{ "path", "size" }`. Does NOT auto-enqueue; the client enqueues via `POST /ingest` afterwards. |
| GET | `/files/download` | Download a file as an attachment. Query: `path`. |
| GET | `/files/raw` | Stream a file with its native content type (for `<img>`/`<a>`). Query: `path`. |

### Search

| Method | Path | Description |
|---|---|---|
| POST | `/api/v2/projects/:id/search` | Hybrid search. Body `{ "query", "topK"? (1–100, default 20), "includeContent"? }` → `{ results: [{ path, title, score, titleMatch, images: [{ url, alt }], snippet?, content?, vectorScore? }], mode, tokenHits, vectorHits, graphHits, vectorUnavailableReason? }` — `title`/`titleMatch`/`images` are always present; `snippet` is always present at runtime (optional in the schema for tolerance); `vectorScore` appears on vector-ranked rows when the vector leg ran; `content` only with `includeContent`; `vectorUnavailableReason` is present when the vector leg degraded and the search fell back (see PUSH1 §4). |

### Graph

| Method | Path | Description |
|---|---|---|
| GET | `/api/v2/projects/:id/graph` | Knowledge graph. Query: `q` (filter), `nodeType`, `limit` → `{ nodes: [{ id, label, nodeType, path, linkCount, weight }], edges: [{ source, target, weight }] }`. |

### Chat

| Method | Path | Description |
|---|---|---|
| POST | `/api/v2/projects/:id/chat` | Start a chat turn. Body `{ "message", "sessionId"?, "mode"?, "tools"?, "topK"?, "includeContent"?, "skills"?, "history"?, "historyExplicit"?, "resume"?, "regenerate"?, "historyLimit"? }` → immediate `{ runId, sessionId }` (the response is NOT streamed — the answer arrives over SSE `agent-event` + `chat:*` frames; `sessionId` is echoed, server-generated when omitted as `ui_<uuid>`). `history` / `historyExplicit` carry the client-held conversations.json round-trip and win verbatim (the desktop contract, both builds); when omitted (or empty + not explicit) the server hydrates the last 12 messages from the shared `.llm-wiki/agent-sessions/<sessionId>.json` files (desktop `AgentSession` shape). `regenerate: true` drops the session's last user/assistant exchange before re-running. |
| POST | `/api/v2/projects/:id/chat/writes` | Chat "Write to Wiki" — generates and writes wiki pages from the conversation. Body `{ "sessionId", "userGuidance"?, "sourcePath"?, "runId"? }` (`runId`: optional client-generated run id so the owning tab can tombstone it before the response lands; server generates one when absent) → `{ runId, sessionId, writePrompt }`; streams `agent-event` frames (`messageDelta` / `wikiWrites` / `error` / `done`). |
| POST | `/api/v2/projects/:id/chat/:runId/cancel` | Cancel a running turn. |
| GET | `/api/v2/projects/:id/chat/sessions` | List sessions → `{ sessions }`, most recent first. |
| POST | `/api/v2/projects/:id/chat/sessions` | Create an empty session. Body `{ "title"? }` → `201 { session }`. |
| GET | `/api/v2/projects/:id/chat/sessions/:sessionId` | Get session state/history → `{ session, messages }`. |
| PATCH | `/api/v2/projects/:id/chat/sessions/:sessionId` | Rename a session — **rename-or-create**: a missing session is created for this project first (the web client syncs a locally-created conversation's auto-title before the first turn lazily creates the row). Body `{ "title" }` → `{ session }`; cross-project ids still 404. |
| DELETE | `/api/v2/projects/:id/chat/sessions/:sessionId` | Delete a session → `204 No Content` (its messages cascade). |

### Ingest (`/api/v2/projects/:id/ingest`)

| Method | Path | Description |
|---|---|---|
| POST | `/ingest/upload` | Upload a document for ingestion — multipart form, field name `file`. |
| POST | `/ingest` | Enqueue an existing project file for (re-)ingest. Body `{ "filePath", "folderContext"? }`; deduped against live tasks (`deduplicated: true` on hit). |
| GET | `/ingest/queue` | List the ingest queue. Query: `status`, `limit`. |
| POST | `/ingest/queue/clear` | Clear queue entries. Body `{ "status"? }`. |
| GET | `/ingest/queue/:taskId` | Get one queued task. |
| POST | `/ingest/queue/:taskId/retry` | Re-arm a `failed` task (409 otherwise). |
| DELETE | `/ingest/queue/:taskId` | Cancel a task (aborts the run, cleans up written files + embeddings) or remove a queued one. |

> Queue rows returned by `GET /ingest/queue` and `GET /ingest/queue/:taskId`
> carry the raw `ingest_queue` row: the lifecycle fields (`attempt_count`,
> `started_at`, `updated_at`, `not_before`, `folder_context`) plus
> `heartbeat_at` — the orchestrator touches the latter (and `updated_at`) every
> ~15 s while a task is `processing` (issue #32), so pollers can distinguish a
> healthy slow run (long LLM call) from a hung/crashed one. `heartbeat_at` is
> null until the task is claimed and never updated after the row leaves
> `processing`.

### Reviews

| Method | Path | Description |
|---|---|---|
| GET | `/api/v2/projects/:id/reviews` | Review items. Query: `status` (`unresolved` default / `resolved`), `type`, `limit` → `{ projectId, status, count, reviews }`. |

### Maintenance (`/api/v2/projects/:id/maintenance`)

| Method | Path | Description |
|---|---|---|
| POST | `/maintenance/rebuild-index` | Rebuild the wiki index from existing pages. |
| POST | `/maintenance/export` | Export a project archive. Body `{ "destination" }`. |
| POST | `/maintenance/import` | Import an archive. Body `{ "archivePath", "destination" }`. |
| GET | `/maintenance/file-history` | File edit history. Query: `path`. |
| POST | `/maintenance/file-history/restore` | Restore a historical version. Body `{ "path", "entryId" }`. |

> **Export/import error contract:** command failures return `400 VALIDATION_ERROR`
> with the exact desktop (`project_maintenance.rs`) message — e.g.
> `Export destination must be outside the project directory`, `Import destination
> must be empty`, `Archive is not an LLM Wiki project (wiki/index.md is missing)`,
> `Project archive contains too many entries` (100 000-entry cap), `Unsafe archive
> path: …`, `Archive contains an unsupported symbolic link: …`. Import validates
> the raw zip central directory (entry count, paths, symlink modes, expanded size)
> before any extraction.

### Settings

| Method | Path | Description |
|---|---|---|
| GET | `/api/v2/settings` | Read all settings. |
| POST | `/api/v2/settings` | Write many settings at once (merge). |
| GET | `/api/v2/settings/:key` | Read one setting key. |
| PUT | `/api/v2/settings/:key` | Write one setting key. |
| DELETE | `/api/v2/settings/:key` | Delete one setting key. |

Settings keys mirror the shared store keys (`llmConfig`, `providerConfigs`,
`apiConfig`, `recentProjects`, `lastProject`, …). Writing `apiConfig.token`
sets the auth token; `apiConfig.allowUnauthenticated = true` re-opens the
server in **auto** mode only — under `LLM_WIKI_AUTH_MODE=token` the token is
required regardless of `allowUnauthenticated`.

### Events (SSE)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v2/events` | Global server-sent-events stream. Each `message` carries a JSON envelope `{ event, payload }`. A `: ping` comment heartbeat is sent every 25 s to survive proxies. |
| GET | `/api/v2/events/count` | Diagnostic: number of connected SSE clients → `{ clients }`. |

`GET /api/v2/events` and the legacy `GET /api/events` broadcast the same
frames (one bus, both transports). Fire-and-forget: the server buffers
nothing; on reconnect the client checks `/api/v2/health` and does a full
refresh when the version changed. The wire envelope is exactly
`{ event, payload }`; project attribution rides in `payload.projectId`
(host-global events omit the field entirely rather than carrying `null`).

The `ingest:*` frames (`ingest:queued` / `ingest:progress` /
`ingest:complete` / `ingest:error`) are documented with the queue semantics
in [PUSH1_ACTUAL_ARCHITECTURE.md §3](./PUSH1_ACTUAL_ARCHITECTURE.md). The
rest of the emitted taxonomy:

| Event | Payload | Emitted when |
|---|---|---|
| `file:created` | `{ projectId, path, size? }` | A file was written: files upload, ingest upload (the raw source), chunked-upload completion, chat Write-to-Wiki FILE blocks plus newly created post-write media images, legacy invoke writers. A pre-write existence check decides created vs modified. |
| `file:modified` | `{ projectId, path, size? }` | An existing file was rewritten: same sites (same existence check), plus maintenance rebuild-index (`wiki/index.md`), file-history restore, and rewritten post-write media images. |
| `file:deleted` | `{ projectId, path }` | A file was removed: ingest cancel cleanup (per actually-unlinked page) and the legacy delete writer. |
| `graph:updated` | `{ projectId, nodesChanged, edgesChanged }` | Wiki pages changed ⇒ client graph caches are stale. ONE aggregate per mutation batch: ingest success/cancel, rebuild-index, chat Write-to-Wiki completion. `edgesChanged` is best-effort (`0` when unknown). |
| `settings:changed` | `{ keys }` | Settings written: `/api/v2/settings` writes and shared-store (`app-state.json`) writes via `/api/store` + the legacy server. Host-global (the payload carries only `keys`, no `projectId`); `keys` is informational — clients refetch settings. |
| `chat:delta` | `{ sessionId, runId, projectId, text }` | Streaming token chunk of a chat turn (dual-emitted next to `agent-event`). |
| `chat:toolStart` | `{ sessionId, runId, projectId, tool, input }` | Agent tool call started. |
| `chat:toolEnd` | `{ sessionId, runId, projectId, tool, output }` | Agent tool call finished. |
| `chat:done` | `{ sessionId, runId, projectId, content, references }` | Turn finished. `content` is the run's full accumulated text so a tab that missed the deltas can finalize. Also dual-emitted as a TERMINAL frame when a run fails (`content` = the owning tab's error-finalize text: `Error: <message>` for agent turns, `Error generating wiki files: <message>` for a failed Write-to-Wiki run) or is cancelled (`content` empty ⇒ non-owning tabs reset their stream without adding a message), so previewing tabs never stay stuck in streaming state. |
| `agent-event` | `{ sessionId, runId, event }` | Pre-taxonomy chat stream consumed by the active tab's chat panel (turns and Write-to-Wiki). `error` / `wikiWrites` / `referenceAdded` / `fileChanged` exist only here — they have no charter equivalent. |

The stream additionally carries the pre-taxonomy **legacy watcher frames**
`file-sync://changed`, `file-sync://queue-updated`, and
`project://files-changed`, emitted by the server-side file watcher
(`commands/fileSync.js`, started on demand by the client — default-enabled in
the web build). The web client maps `project://files-changed` and
`file-sync://changed` onto the `file:modified` handling path. On
`project://files-changed`, `.llm-wiki/` paths are otherwise filtered out EXCEPT
the allowlisted state file `.llm-wiki/review.json`, so a review item added or
resolved externally (e.g. by the desktop app) reaches the open web Review view
live (issue #13 item 3); the server's own writes to it are suppressed via
app-write-ignore.

Notes: `path` is project-relative when the emitting site knows the project
and absolute otherwise (legacy invoke writers resolve their project by
longest-prefix match against the registered projects; `projectId` is `null`
when unresolved). Chat taxonomy frames are scoped client-side by `sessionId`
and skipped for runs the receiving tab started itself.

---

### Clip (browser clipper — issue #40, thin-client)

| Method | Path | Description |
|---|---|---|
| POST | `/api/v2/projects/:id/clip` | Clip a web page (browser extension). Body `{ "title", "url", "content" }` (all strings, content is the extracted markdown) → `201 { "path": "raw/sources/<slug>-<date>.md", "size": 1234, "taskId": 1 }`. Writes `raw/sources/<slug>-<date>.md` (frontmatter `type: clip`, `origin: web-clip`) and enqueues ingest (`ingest:queued` + `file:created`); the file is project-relative. `projectId` accepts the numeric projects-table id, the WikiProject UUID, or the project path. Auth-gated like any other project route. |

### Sources

| Method | Path | Description |
|---|---|---|
| POST | `/api/v2/projects/:id/sources/rescan` | Rescan the project's source folders (MCP `rescan`). Triggers the file-sync watcher to diff the project against its snapshot and enqueue changed sources. → `{ "changed": 0, "queueVersion": 1 }`. |

### Files — MCP listing (issue #40)

| Method | Path | Description |
|---|---|---|
| GET | `/api/v2/projects/:id/files?root=&recursive=&maxFiles=` | MCP-friendly file listing (thin-client). Query `root` (`wiki` / `sources` / `all`, default `wiki`), `recursive` (bool, default `true`), `maxFiles` (1–50000, default 5000) → `{ "files": [{ "name", "path", "isDir", "children"? }], "truncated": false }`. Paths are project-relative (`wiki/...`, `raw/sources/...`). Replaces the legacy `GET /api/v1/projects/:id/files` surface. |

### Chat — synchronous (MCP — issue #40)

| Method | Path | Description |
|---|---|---|
| POST | `/api/v2/projects/:id/chat/sync` | **Synchronous** chat turn for automation (MCP). Body is the same `ChatRequest` as `POST /chat` (`message`, `sessionId`?, `mode`?, `tools`?, `topK`?, `skills`?…) → immediate `{ "projectId", "sessionId", "mode", "message": { "role", "content" }, "references": [...], "toolEvents": [...], "events": [...], "usage": {...} }`. No SSE; the answer is in the response body. `sessionId` defaults to `ui_<uuid>` like the streaming route. |
| POST | `/api/v2/projects/:id/chat/session/:sessionId/cancel` | Cancel a running chat turn by session (MCP). The web UI's run-scoped cancel is `POST /api/v2/projects/:id/chat/:runId/cancel`; this session-scoped variant mirrors the legacy `POST /api/v1/projects/:id/chat/:sid/cancel` (all active runs for the session). → `{ "sessionId", "cancelled": true }`. |

## Legacy compat (still served by the sole entry `index-v2.js`)

The sole server entry (`packages/server/src/index-v2.js`, `npm start`) additionally
serves the endpoints the web client still depends on during the v2 migration:

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Legacy health (command count, SSE clients, store diagnostics). |
| GET | `/api/commands` | Names of all registered commands. |
| GET | `/api/home` | Server home dir / cwd / platform (for the folder picker). |
| GET | `/api/events` | Legacy SSE stream (same bus as `/api/v2/events`). |
| GET | `/api/raw?path=` | Stream a server-side file by absolute path. |
| POST | `/api/invoke/:command` | Command dispatch (JSON args body). **Deprecated** (RFC 8594): responses carry `Deprecation: true` and a `Link` to `/api/v2/openapi.json`. New integrations should use `/api/v2/*`. |
| GET/PUT/DELETE | `/api/store/:name[/:key]` | Read/write/delete plugin-store JSON. |
| POST | `/api/proxy` | Outbound HTTP proxy for provider calls. |

> **Retired in issue #40 (2026-08-27):** the legacy raw-`node:http` entry
> (`packages/server/src/index.js`, `npm run server`) and the entire
> `/api/v1/*` surface (desktop `api_server.rs` parity — `handleApiV1` in
> `api-v1.js`) were deleted. The MCP server and browser clipper now speak
> `/api/v2` directly (single origin, remote/Docker-capable); no v1 shim remains.

---

## Examples

```bash
TOKEN="your-token"
BASE="http://127.0.0.1:19828"

# Health (no auth)
curl -s $BASE/api/v2/health

# List projects
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/v2/projects

# Create a project (path is on the SERVER filesystem)
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Wiki","path":"/wikis/my-wiki"}' \
  $BASE/api/v2/projects

# Search
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"knowledge graph","topK":10}' \
  $BASE/api/v2/projects/1/search

# Token via query param (e.g. for EventSource, which cannot set headers)
curl -s "$BASE/api/v2/projects?token=$TOKEN"
```

SSE from the browser (query-param auth, since `EventSource` cannot set headers):

```js
const es = new EventSource(`/api/v2/events?token=${encodeURIComponent(token)}`)
es.onmessage = (e) => {
  const { event, payload } = JSON.parse(e.data)
  // handle broadcast event
}
```
