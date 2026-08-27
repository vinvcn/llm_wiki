# LLM Wiki MCP Server

This package exposes the running LLM Wiki server as a Model Context Protocol server.

It does **not** scan project folders directly and does **not** copy the app's search or graph logic. Every tool calls the LLM Wiki v2 API at `http://127.0.0.1:19828/api/v2` (thin-client, issue #40) — the same API the web client uses — so MCP clients use the same project registry, file permissions, search backend, graph backend, and Source Watch rules as the server. Point `LLM_WIKI_API_BASE_URL` at a remote/Docker deployment (e.g. `https://wiki.example.com` or `http://192.168.1.10:3000`) to use the MCP against a remote backend; the legacy `http://127.0.0.1:19828/api/v1` (desktop `api_server.rs`) surface is retired with no shim.

## Requirements

- Node.js 20+
- LLM Wiki server running (`npm start` locally, or a Docker/remote deployment — see `docs/DEPLOYMENT.md`)
- Either:
  - `LLM_WIKI_AUTH_MODE=none` / `allowUnauthenticated` (open local mode), or
  - `LLM_WIKI_API_TOKEN` set to the configured API token (token mode / shared-store `apiConfig.token`)
- For the desktop app's `apiConfig.mcpEnabled` kill-switch, the MCP still checks `health.mcpEnabled`; when false, only `llm_wiki_status` works (other tools return a disabled error).

Optional:

- `LLM_WIKI_API_BASE_URL` to override the default API base URL (e.g. `https://remote:3000`). The MCP is now remote-capable — no longer bound to `127.0.0.1`.

## Build

```bash
cd mcp-server
npm install
npm run build
```

## Run

```bash
LLM_WIKI_API_TOKEN=your-token node dist/src/index.js
```

Example MCP client config:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/absolute/path/to/llm_wiki/mcp-server/dist/src/index.js"],
      "env": {
        "LLM_WIKI_API_TOKEN": "your-token"
      }
    }
  }
}
```

When API unauthenticated mode is enabled, omit `LLM_WIKI_API_TOKEN`. If MCP access is disabled in Settings, `llm_wiki_status` still works for diagnosis but other tools return an explicit disabled error.

## Tools

- `llm_wiki_status`: health and current project summary.
- `llm_wiki_projects`: known projects and active project.
- `llm_wiki_set_project`: pin the MCP process session to a project. Once pinned, other project tools reject attempts to access a different project.
- `llm_wiki_files`: list project files. `project_id` can be a project UUID, a project filesystem path, or `current`.
- `llm_wiki_read_file`: read an allowed text file such as `wiki/index.md`.
- `llm_wiki_reviews`: list Review tab items. Defaults to unresolved items and supports `status`, `type`, and `limit` filters.
- `llm_wiki_search`: search with the app's shared keyword/vector backend.
- `llm_wiki_chat`: ask the backend Agent chat endpoint and receive answer text, references, usage, and tool events. `mode: deep` broadens backend evidence collection; full Deep Research workflows still live in the desktop app.
- `llm_wiki_graph`: query the app's knowledge graph endpoint.
- `llm_wiki_rescan_sources`: trigger a Source Watch rescan using the user's configured rules.

## Security model

The MCP server inherits the v2 API's security model:

- It talks to `http://127.0.0.1:19828` by default, or to the origin in `LLM_WIKI_API_BASE_URL` (e.g. a remote `https://` deployment).
- It uses the same API token / `allowUnauthenticated` contract as `docs/DEPLOYMENT.md` (auth precedence).
- File reads go through the API path allow-list. Internal app state files are not exposed.
- Review data is exposed only through the dedicated Review endpoint/tool, which defaults to unresolved items rather than opening internal state files directly.
- Search and graph tools operate on projects known to the app; use `project_id: "current"` for the active project.
- For multi-project use, call `llm_wiki_set_project` once. The resolved project ID remains fixed for the lifetime of the MCP subprocess even if the desktop UI switches projects, and every project-tool response includes an `activeProject` marker.

Do not pass API tokens via command-line arguments. Prefer environment variables so they do not appear in shell history.
