// Settings → API + MCP parity: the web /api/v1 surface must hold the
// desktop's api_server.rs contract so ONE shared store yields ONE behavior on
// the desktop and the web:
//   - /api/v1/health is public and reachable even when the API is disabled,
//     and reports the full desktop envelope (version, enabled, mcpEnabled,
//     allowUnauthenticated, allowLanAccess, agent {chat, streaming}).
//   - apiConfig.enabled=false is a kill-switch: every non-/health endpoint
//     503s with the desktop's exact string, BEFORE auth (a disabled API beats
//     a valid token), and before 405.
//   - apiConfig.mcpEnabled defaults to false exactly like api_mcp_enabled
//     (unwrap_or(false)) — the MCP stdio process self-disables on
//     health.mcpEnabled === false.
//   - agent chat (POST .../chat + .../chat/:sid/cancel) always requires a real
//     token (is_agent_chat_request + is_token_authorized), even when
//     allowUnauthenticated opens the rest of the API.
//   - methods outside GET/POST/PATCH 405 with the desktop's string.
//   - mcp_server_entry_path resolves the bundled MCP entry like lib.rs
//     (real path, or the exact build-hint error).
// Env vars are set BEFORE importing the app (config is read at module load).

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import http from "node:http"
import request from "supertest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-v1contract-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const { app } = await import("../src/index-v2.js")
const { resolveMcpEntryPath, mcpServerEntryPathFromBases } = await import("../src/commands/misc.js")

const STORE = path.join(DATA_DIR, "stores", "app-state.json")
const PROJECT_DIR = path.join(DATA_DIR, "proj")
const PROJECT_ID = "contract-proj"
const TOKEN = "contract-secret-token"

function writeStore(apiConfig, extra = {}) {
  mkdirSync(path.dirname(STORE), { recursive: true })
  writeFileSync(STORE, JSON.stringify({ ...extra, apiConfig }))
}

// ── mock OpenAI-compatible LLM (fast, local, deterministic) ───────────────
const mock = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let raw = ""
    req.on("data", (d) => { raw += d })
    req.on("end", () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* ignore */ }
      const text = "Contract test answer."
      if (body.stream === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream" })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`)
        res.write("data: [DONE]\n\n")
        res.end()
      } else {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }))
      }
    })
    return
  }
  res.writeHead(404)
  res.end("{}")
})

let mockPort = 0

beforeAll(async () => {
  mkdirSync(path.join(PROJECT_DIR, "wiki"), { recursive: true })
  writeFileSync(path.join(PROJECT_DIR, "wiki", "index.md"), "# Home\n")
  await new Promise((r) => mock.listen(0, "127.0.0.1", r))
  mockPort = mock.address().port
})

afterAll(() => {
  mock.close()
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

describe("/api/v1 Settings → API + MCP contract (api_server.rs parity)", () => {
  it("GET /api/v1/health is public and reports the desktop envelope", async () => {
    writeStore({ token: TOKEN })
    const res = await request(app).get("/api/v1/health")
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.status).toBe("ok")
    expect(typeof res.body.version).toBe("string")
    expect(res.body.enabled).toBe(true)
    // Desktop api_mcp_enabled: store boolean unwrap_or(false).
    expect(res.body.mcpEnabled).toBe(false)
    expect(res.body.allowLanAccess).toBe(false)
    expect(res.body.allowUnauthenticated).toBe(false)
    expect(res.body.authRequired).toBe(true)
    expect(res.body.authConfigured).toBe(true)
    expect(res.body.tokenSource).toBe("store")
    expect(res.body.agent).toEqual({ chat: true, streaming: false })
  })

  it("health reflects mcpEnabled + allowLanAccess from the shared store", async () => {
    writeStore({ token: TOKEN, mcpEnabled: true, allowLanAccess: true })
    const res = await request(app).get("/api/v1/health")
    expect(res.status).toBe(200)
    expect(res.body.mcpEnabled).toBe(true)
    expect(res.body.allowLanAccess).toBe(true)
  })

  it("disabled API: /health stays reachable, every other endpoint 503s before auth", async () => {
    writeStore({ token: TOKEN, enabled: false })
    const health = await request(app).get("/api/v1/health")
    expect(health.status).toBe(200)
    expect(health.body.enabled).toBe(false)

    const withToken = await request(app).get("/api/v1/projects").set("x-llm-wiki-token", TOKEN)
    expect(withToken.status).toBe(503)
    expect(withToken.body).toEqual({ ok: false, error: "API server is disabled in Settings → API Server" })

    // Kill-switch beats auth (desktop order): a disabled API 503s even
    // without a valid token, never leaking a 401/200.
    const noToken = await request(app).get("/api/v1/projects")
    expect(noToken.status).toBe(503)

    const unauthOpen = await request(app).get("/api/v1/projects")
    expect(unauthOpen.status).toBe(503)
  })

  it("methods outside GET/POST/PATCH are rejected with 405 (desktop string)", async () => {
    writeStore({ token: TOKEN })
    const res = await request(app).delete("/api/v1/projects").set("x-llm-wiki-token", TOKEN)
    expect(res.status).toBe(405)
    expect(res.body).toEqual({ ok: false, error: "Method not allowed" })
  })

  it("agent chat requires a real token even in unauthenticated mode", async () => {
    writeStore(
      { token: TOKEN, allowUnauthenticated: true },
      { projectRegistry: { [PROJECT_ID]: { id: PROJECT_ID, name: "Contract", path: PROJECT_DIR } } },
    )
    // allowUnauthenticated is honored for normal endpoints…
    const open = await request(app).get("/api/v1/projects")
    expect(open.status).toBe(200)

    // …but chat + chat/cancel still 401 without a token (is_agent_chat_request).
    const noTokenChat = await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/chat`)
      .send({ message: "hi" })
    expect(noTokenChat.status).toBe(401)
    expect(noTokenChat.body).toEqual({ ok: false, error: "Unauthorized" })

    const noTokenCancel = await request(app).post(`/api/v1/projects/${PROJECT_ID}/chat/s1/cancel`)
    expect(noTokenCancel.status).toBe(401)

    // With the token the gate passes: cancel is a fast no-op proof, and a
    // real chat runs the agent against the local mock LLM.
    const withTokenCancel = await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/chat/s1/cancel`)
      .set("x-llm-wiki-token", TOKEN)
    expect(withTokenCancel.status).toBe(200)
    expect(withTokenCancel.body).toMatchObject({ sessionId: "s1", cancelled: false })

    writeStore(
      { token: TOKEN, allowUnauthenticated: true, mcpEnabled: true },
      {
        projectRegistry: { [PROJECT_ID]: { id: PROJECT_ID, name: "Contract", path: PROJECT_DIR } },
        llmConfig: {
          provider: "custom", apiKey: "mock-key", model: "mock-model",
          customEndpoint: `http://127.0.0.1:${mockPort}/v1`, maxContextSize: 64000,
        },
      },
    )
    const withTokenChat = await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/chat`)
      .set("x-llm-wiki-token", TOKEN)
      .send({ message: "hello", tools: { wiki: true, web: false, anytxt: false } })
    expect(withTokenChat.status).toBe(200)
    expect(withTokenChat.body.ok).toBe(true)
    expect(typeof withTokenChat.body.message?.content).toBe("string")
    expect(String(withTokenChat.body.message?.content ?? "")).not.toMatch(/^Error:/)
  })

  it("mcp_server_entry_path resolves the bundled MCP entry like lib.rs", async () => {
    writeStore({ token: TOKEN })
    const res = await request(app).post("/api/invoke/mcp_server_entry_path").send({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const p = res.body.result
    expect(typeof p).toBe("string")
    expect(path.isAbsolute(p)).toBe(true)
    expect(p.endsWith(path.join("mcp-server", "dist", "src", "index.js"))).toBe(true)
    expect(existsSync(p)).toBe(true)
  })

  it("mcp entry resolution: null for a missing build, exact desktop error from the command", async () => {
    const missing = mkdtempSync(path.join(tmpdir(), "llmwiki-nomcp-"))
    try {
      expect(resolveMcpEntryPath([missing])).toBeNull()
      expect(() => mcpServerEntryPathFromBases([missing])).toThrow(
        "MCP server entry was not found. Run `npm run mcp:build` from the LLM Wiki repository, then reopen Settings.",
      )
    } finally {
      rmSync(missing, { recursive: true, force: true })
    }
  })
})
