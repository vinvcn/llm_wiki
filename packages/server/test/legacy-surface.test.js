// Integration tests for the legacy-compat surface mounted on the v2 server:
//   - GET /api/raw        (convertFileSrc: wiki images, file previews)
//   - GET /api/health     (v1 diagnostics incl. shared-store probe)
//   - GET /api/commands   (command registry listing)
//   - /api/v1/*           (desktop external REST API for the MCP server /
//                          external agent skill, own auth contract)
// These endpoints existed only on the legacy node:http server; the shipped
// entry point is index-v2.js, so the web client (images/previews) and the
// MCP interop need them here too. Env vars are set BEFORE importing the app
// (config is read at module load).

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import request from "supertest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-legacy-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const { app } = await import("../src/index-v2.js")

// 1x1 transparent PNG — proves binary streaming survives byte-for-byte.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
)

const PROJECT_DIR = path.join(DATA_DIR, "proj")
const ASSET_DIR = path.join(PROJECT_DIR, "assets")
const PNG_PATH = path.join(ASSET_DIR, "pixel.png")
const TXT_PATH = path.join(ASSET_DIR, "note.txt")

let projectId = "legacy-proj-id"

beforeAll(() => {
  mkdirSync(ASSET_DIR, { recursive: true })
  writeFileSync(PNG_PATH, PNG_BYTES)
  writeFileSync(TXT_PATH, "hello raw\n")
  // A desktop-shaped project (wiki + public-path files) for /api/v1 reads.
  mkdirSync(path.join(PROJECT_DIR, "wiki", "concepts"), { recursive: true })
  mkdirSync(path.join(PROJECT_DIR, "raw", "sources"), { recursive: true })
  writeFileSync(
    path.join(PROJECT_DIR, "wiki", "concepts", "attention.md"),
    "---\ntype: concept\ntitle: Attention\n---\n# Attention\nBody.\n",
  )
  writeFileSync(path.join(PROJECT_DIR, "secret-env.txt"), "TOP SECRET\n")
})

afterAll(() => {
  delete process.env.LLM_WIKI_API_TOKEN
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

// Register the project up front: /api/raw is confined to registered project
// roots (owner decision 2026-08-26 — no client-facing filesystem exposure),
// so the raw suite needs it before the /api/v1 registration test runs.
beforeAll(async () => {
  await request(app)
    .put("/api/store/app-state.json")
    .send({
      projectRegistry: { [projectId]: { id: projectId, name: "Legacy Proj", path: PROJECT_DIR } },
      lastProject: { id: projectId, path: PROJECT_DIR },
    })
})

// ── /api/raw ──────────────────────────────────────────────────────────────
describe("GET /api/raw (convertFileSrc target)", () => {
  it("streams a binary file with correct MIME + headers", async () => {
    const res = await request(app).get("/api/raw").query({ path: PNG_PATH })
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toBe("image/png")
    expect(res.headers["access-control-allow-origin"]).toBe("*")
    expect(res.headers["cache-control"]).toBe("private, max-age=3600")
    expect(Buffer.from(res.body).equals(PNG_BYTES)).toBe(true)
  })

  it("streams text with the utf-8 text MIME", async () => {
    const res = await request(app).get("/api/raw").query({ path: TXT_PATH })
    expect(res.status).toBe(200)
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8")
    expect(res.text).toBe("hello raw\n")
  })

  it("400 on missing/empty path", async () => {
    const res = await request(app).get("/api/raw")
    expect(res.status).toBe(400)
  })

  it("400 on NUL in path", async () => {
    const res = await request(app).get(`/api/raw?path=${encodeURIComponent("/tmp/x\0y")}`)
    expect(res.status).toBe(400)
  })

  it("400 on directory", async () => {
    const res = await request(app).get("/api/raw").query({ path: ASSET_DIR })
    expect(res.status).toBe(400)
  })

  it("404 on missing file", async () => {
    const res = await request(app).get("/api/raw").query({ path: path.join(ASSET_DIR, "nope.png") })
    expect(res.status).toBe(404)
  })
})

// ── /api/health + /api/commands ───────────────────────────────────────────
describe("GET /api/health + /api/commands (legacy diagnostics)", () => {
  it("/api/health mirrors the legacy payload incl. store diagnostics", async () => {
    const res = await request(app).get("/api/health")
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.name).toBe("llm-wiki-server")
    expect(res.body.commands).toBeGreaterThan(0)
    expect(typeof res.body.sseClients).toBe("number")
    expect(typeof res.body.webBuilt).toBe("boolean")
    expect(res.body.store).toMatchObject({ shared: false })
    expect(typeof res.body.store.path).toBe("string")
    expect(typeof res.body.store.source).toBe("string")
    expect(Array.isArray(res.body.store.candidates)).toBe(true)
  })

  it("/api/commands lists the registry", async () => {
    const res = await request(app).get("/api/commands")
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
    expect(res.body).toContain("read_file")
    expect(res.body).toContain("agent_start_turn_stream")
  })
})

// ── /api/v1 (desktop external API: MCP server / agent skill) ─────────────
describe("/api/v1 desktop external API", () => {
  it("registers a desktop-shaped project via the shared store", async () => {
    const res = await request(app)
      .put("/api/store/app-state.json")
      .send({
        projectRegistry: { [projectId]: { id: projectId, name: "Legacy Proj", path: PROJECT_DIR } },
        lastProject: { id: projectId, path: PROJECT_DIR },
      })
    expect(res.status).toBe(200)
  })

  it("GET /api/v1/health is public and reports the auth state", async () => {
    const res = await request(app).get("/api/v1/health")
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.status).toBe("ok")
    // Fresh store: no token, allowUnauthenticated unset → auth required.
    expect(res.body.authConfigured).toBe(false)
    expect(res.body.authRequired).toBe(true)
  })

  it("GET /api/v1/projects lists registry + marks current", async () => {
    // No token configured yet: api-v1 denies data reads (desktop contract).
    const denied = await request(app).get("/api/v1/projects")
    expect(denied.status).toBe(401)
    // Configure a token through the shared store (desktop Settings parity).
    await request(app).put("/api/store/app-state.json").send({ apiConfig: { token: "v1-secret" } })
    const res = await request(app).get("/api/v1/projects").query({ token: "v1-secret" })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.projects).toHaveLength(1)
    expect(res.body.projects[0]).toMatchObject({ id: projectId, current: true })
  })

  it("GET files + files/content honor the public-path guard", async () => {
    // Default (recursive) listing is a tree: {name, path, isDir, children}.
    const files = await request(app)
      .get(`/api/v1/projects/${projectId}/files`)
      .query({ token: "v1-secret" })
    expect(files.status).toBe(200)
    expect(files.body.ok).toBe(true)
    const flatten = (nodes) => nodes.flatMap((n) => [n, ...flatten(n.children || [])])
    expect(flatten(files.body.files).some((f) => f.path === "wiki/concepts/attention.md")).toBe(true)

    const okRead = await request(app)
      .get(`/api/v1/projects/${projectId}/files/content`)
      .query({ token: "v1-secret", path: "wiki/concepts/attention.md" })
    expect(okRead.status).toBe(200)
    expect(okRead.body.content).toContain("# Attention")

    const guarded = await request(app)
      .get(`/api/v1/projects/${projectId}/files/content`)
      .query({ token: "v1-secret", path: "../../secret-env.txt" })
    expect(guarded.status).toBe(403)

    const badTok = await request(app).get("/api/v1/projects").query({ token: "wrong" })
    expect(badTok.status).toBe(401)
  })

  it("env token (LLM_WIKI_API_TOKEN) is honored like the desktop", async () => {
    process.env.LLM_WIKI_API_TOKEN = "env-token"
    try {
      const res = await request(app)
        .get("/api/v1/projects")
        .set("Authorization", "Bearer env-token")
      expect(res.status).toBe(200)
      const health = await request(app).get("/api/v1/health")
      expect(health.body.tokenSource).toBe("env")
    } finally {
      delete process.env.LLM_WIKI_API_TOKEN
    }
  })

  it("unknown endpoint returns the desktop's 404 envelope ('Not found')", async () => {
    const res = await request(app)
      .get("/api/v1/nope")
      .query({ token: "v1-secret" })
    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ ok: false, error: "Not found" })
  })
})
