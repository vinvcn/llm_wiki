// MCP-client interop acceptance harness (the durable home of the old
// /tmp/llmwiki-harness/verify-mcp-interop.mjs).
//
// Boots a real server (the desktop api_server.rs /api/v1 contract) against an
// isolated shared store + a real project on disk, spawns the REAL bundled MCP
// server (`mcp-server/dist`, lib.rs `mcp_server_entry_path` semantics) over
// stdio through the official @modelcontextprotocol/sdk client, and drives the
// whole llm_wiki_* tool surface end to end:
//   - stdio handshake + the 10-tool surface
//   - status / projects / set-project pin + cross-project rejection
//   - files / read_file (+ the public-path 403 guard)
//   - reviews (stable shared review-<hash> ids from the SAME
//     .llm-wiki/review.json the desktop + web write)
//   - search / graph / sources/rescan
//   - chat against a mock OpenAI-compatible LLM, and the turn persisted to
//     the SHARED desktop-format .llm-wiki/agent-sessions/<sid>.json (the
//     one-backend-one-user-data promise, cross-client)
//   - the mcpEnabled kill-switch (live store flip, no restart)
//   - the token-auth contract (401 without token, status stays public,
//     live allowUnauthenticated flip honored with no restart)
//
//   node scripts/verify/verify-mcp-interop.mjs
//   SERVER_ENTRY=packages/server/src/index-v2.js node scripts/verify/verify-mcp-interop.mjs

import { spawn, execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http from "node:http"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log("  ok  -", m) } else { fail++; console.log("  FAIL-", m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
}
async function waitFor(fn, t, what) {
  const start = Date.now()
  while (Date.now() - start < t) { try { if (await fn()) return true } catch {} await sleep(80) }
  throw new Error(`timeout waiting for ${what}`)
}
function req(port, method, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c))
      res.on("end", () => { try { resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }) } catch { resolve({ status: res.statusCode, raw: buf }) } })
    })
    r.on("error", reject); r.end()
  })
}

// Independent FNV-1a/32 over UTF-16 code units — mirrors the desktop's
// review_id_for_parts so the harness can predict the stable shared review id.
function expectedReviewId(type, normalizedTitle) {
  const key = `${type}::${normalizedTitle}`
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return `review-${(h >>> 0).toString(16).padStart(8, "0")}`
}

// ── SDK client (from the bundled mcp-server dependency tree) ───────────────
const { Client } = await import(new URL("../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js", import.meta.url).href)
const { StdioClientTransport } = await import(new URL("../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js", import.meta.url).href)

// ── Mock OpenAI-compatible LLM (tool round-trip, then answer) ─────────────
const TOOL_CALL_ID = "call_mcp_1"
const ANSWER = "The quantum page describes quantum mechanics."
function wantsTool(messages) { return !messages.some((m) => m.role === "tool") }
function mockHandler(reqBody, res) {
  const messages = reqBody.messages ?? []
  if (wantsTool(messages)) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: TOOL_CALL_ID, type: "function", function: { name: "wiki.search", arguments: JSON.stringify({ query: "quantum" }) } }] } }] }))
  } else {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: ANSWER } }] }))
  }
}
const mockPort = await freePort()
const mock = http.createServer((rq, rs) => {
  let buf = ""; rq.on("data", (c) => (buf += c))
  rq.on("end", () => {
    if (rq.method === "POST" && rq.url.includes("/chat/completions")) {
      try { mockHandler(JSON.parse(buf), rs) } catch (e) { rs.writeHead(500); rs.end(String(e)) }
    } else { rs.writeHead(404); rs.end("nope") }
  })
})
await new Promise((r) => mock.listen(mockPort, r))

// ── Fake projects + isolated shared store ─────────────────────────────────
const TOKEN = "mcp-interop-token"
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-mcpinterop-"))
const dataDir = path.join(tmp, "data")
const storesDir = path.join(dataDir, "stores")
fs.mkdirSync(storesDir, { recursive: true })
const projectPath = path.join(tmp, "project")
const bareProjectPath = path.join(tmp, "bare-project")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.mkdirSync(path.join(bareProjectPath, "wiki"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n\nSee [[Quantum]] for details.\n")
fs.writeFileSync(path.join(projectPath, "wiki", "quantum.md"), "---\ntype: entity\ntitle: Quantum\n---\n# Quantum\nQuantum mechanics is the study of matter at atomic scales.\n")
fs.writeFileSync(path.join(bareProjectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n")

// One unresolved review item -> one stable shared id, plus a resolved one.
const REVIEW_STABLE = expectedReviewId("missing_page", "foo bar")
fs.mkdirSync(path.join(projectPath, ".llm-wiki"), { recursive: true })
fs.writeFileSync(path.join(projectPath, ".llm-wiki", "review.json"), JSON.stringify([
  { type: "missing_page", title: "Missing page: Foo Bar", description: "d1", createdAt: 200 },
  { type: "quality", title: "Check Q", resolved: true, resolvedAction: "Skip", createdAt: 50 },
], null, 2))

const storeFile = path.join(storesDir, "app-state.json")
const storeBase = {
  apiConfig: { token: TOKEN, mcpEnabled: true, allowUnauthenticated: false },
  llmConfig: { provider: "custom", apiKey: "test-key", model: "mock-model", customEndpoint: `http://127.0.0.1:${mockPort}/v1`, apiMode: "chat_completions" },
  projectRegistry: {
    "proj-1": { id: "proj-1", path: projectPath, name: "project" },
    "proj-2": { id: "proj-2", path: bareProjectPath, name: "bare" },
  },
  lastProject: { id: "proj-1", path: projectPath },
}
const writeStore = (patch) => {
  const cur = JSON.parse(fs.readFileSync(storeFile, "utf-8"))
  fs.writeFileSync(storeFile, JSON.stringify({ ...cur, ...patch }, null, 2))
}
fs.writeFileSync(storeFile, JSON.stringify(storeBase, null, 2))

// ── Build the mcp-server if dist is missing/stale (dist is gitignored) ────
// mcp-server has its own dependency tree (not part of the root npm
// workspaces); on a fresh checkout, install it first so the gate is durable.
const sdkPkg = path.join(REPO, "mcp-server", "node_modules", "@modelcontextprotocol", "sdk", "package.json")
if (!fs.existsSync(sdkPkg)) {
  console.log("  · installing mcp-server deps (node_modules missing)")
  execFileSync("npm", ["--prefix", "mcp-server", "ci"], { cwd: REPO, stdio: ["ignore", "inherit", "inherit"] })
}
const mcpEntry = path.join(REPO, "mcp-server", "dist", "src", "index.js")
const srcTimes = ["index.ts", "api-client.ts", "project-binding.ts"].map((f) =>
  fs.existsSync(path.join(REPO, "mcp-server", "src", f)) ? fs.statSync(path.join(REPO, "mcp-server", "src", f)).mtimeMs : 0)
const needBuild = !fs.existsSync(mcpEntry) || Math.max(...srcTimes) > fs.statSync(mcpEntry).mtimeMs
if (needBuild) {
  console.log("  · rebuilding mcp-server (dist stale/missing)")
  execFileSync("npm", ["--prefix", "mcp-server", "run", "build"], { cwd: REPO, stdio: ["ignore", "pipe", "inherit"] })
}
if (!fs.existsSync(mcpEntry)) { console.log("  FAIL- mcp-server/dist missing and build failed"); process.exit(1) }

// ── Boot the server ───────────────────────────────────────────────────────
const SERVER_ENTRY = process.env.SERVER_ENTRY || "packages/server/src/index.js"
const port = await freePort()
const child = spawn(process.execPath, [SERVER_ENTRY], {
  cwd: REPO,
  env: { ...process.env, LLM_WIKI_PORT: String(port), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", (d) => (serverLog += d)); child.stderr.on("data", (d) => (serverLog += d))
const base = `http://127.0.0.1:${port}`

// ── MCP process helper ────────────────────────────────────────────────────
function spawnMcpChild(token) {
  const env = { ...process.env, LLM_WIKI_API_BASE_URL: base }
  if (token) env.LLM_WIKI_API_TOKEN = token
  else delete env.LLM_WIKI_API_TOKEN
  return new StdioClientTransport({
    command: process.execPath,
    args: ["mcp-server/dist/src/index.js"],
    cwd: REPO,
    env,
    stderr: "pipe",
  })
}

async function newMcpClient(token) {
  const transport = spawnMcpChild(token)
  let mcpErr = ""
  transport.stderr.on("data", (d) => (mcpErr += d))
  const client = new Client({ name: "verify-mcp-interop", version: "1.0.0" })
  await client.connect(transport)
  return { client, transport, err: () => mcpErr }
}

async function callTool(client, name, args = {}) {
  try {
    const res = await client.callTool({ name, arguments: args })
    const text = res?.content?.[0]?.text ?? ""
    return { text }
  } catch (err) {
    return { error: String(err?.message ?? err) }
  }
}

const toolText = (r) => r.text ?? ""
const jsonOf = (r) => { try { return JSON.parse(r.text.replace(/^\[activeProject: [^\]]*\]\s*/s, "")) } catch { return null } }

let mainClient = null
try {
  await waitFor(async () => (await req(port, "GET", "/api/v1/health")).status === 200, 15000, "server up")

  // ── stdio handshake + 10-tool surface ───────────────────────────────────
  mainClient = await newMcpClient(TOKEN)
  const tools = await mainClient.client.listTools()
  const names = tools.tools.map((t) => t.name)
  const EXPECTED = ["llm_wiki_status", "llm_wiki_projects", "llm_wiki_set_project", "llm_wiki_files", "llm_wiki_read_file", "llm_wiki_reviews", "llm_wiki_search", "llm_wiki_chat", "llm_wiki_graph", "llm_wiki_rescan_sources"]
  ok(names.length === EXPECTED.length && EXPECTED.every((n) => names.includes(n)), `stdio handshake + ${EXPECTED.length}-tool surface (got ${names.join(",")})`)

  // ── status / projects (shared store registry) ───────────────────────────
  const status = await callTool(mainClient.client, "llm_wiki_status")
  const statusJson = jsonOf(status)
  ok(statusJson && statusJson.ok === true && statusJson.status === "ok", "llm_wiki_status reports ok from /api/v1 health")
  ok(statusJson && statusJson.currentProject?.id === "proj-1" && statusJson.sessionProject === null, "status carries shared currentProject (desktop lastProject) and no pin")
  const projects = await callTool(mainClient.client, "llm_wiki_projects")
  const projectsJson = jsonOf(projects)
  ok(projectsJson && projectsJson.projects.some((p) => p.id === "proj-1") && projectsJson.projects.some((p) => p.id === "proj-2"), "llm_wiki_projects lists both shared-registry projects")
  ok(projectsJson && projectsJson.currentProject?.id === "proj-1", "llm_wiki_projects currentProject is the desktop lastProject")

  // ── set-project pin (by filesystem path) + cross-project rejection ──────
  const pin = await callTool(mainClient.client, "llm_wiki_set_project", { project_id: projectPath })
  const pinJson = jsonOf(pin)
  ok(pinJson && pinJson.pinned === true && pinJson.activeProject?.id === "proj-1", "set_project pins by filesystem path")
  const status2 = jsonOf(await callTool(mainClient.client, "llm_wiki_status"))
  ok(status2 && status2.sessionProject?.id === "proj-1", "status reflects the pinned session project")
  const cross = await callTool(mainClient.client, "llm_wiki_files", { project_id: "proj-2" })
  ok(cross.error && cross.error.includes("is pinned to") && cross.error.includes("project override proj-2 was rejected"), "cross-project override rejected while pinned (exact binding contract)")
  const pinnedTo = await callTool(mainClient.client, "llm_wiki_files", { project_id: "current" })
  ok(pinnedTo.text.startsWith("[activeProject: project (proj-1)]"), "pinned project broadcast in every tool result (lib.rs activeProject header)")

  // ── files / read_file + public-path guard ───────────────────────────────
  ok(pinnedTo.text.includes("📁 wiki"), "llm_wiki_files renders the wiki tree")
  const readIndex = await callTool(mainClient.client, "llm_wiki_read_file", { path: "wiki/index.md" })
  ok(readIndex.text.includes("# wiki/index.md") && readIndex.text.includes("# Index"), "llm_wiki_read_file reads a public wiki page")
  const guarded = await callTool(mainClient.client, "llm_wiki_read_file", { path: ".llm-wiki/review.json" })
  ok(guarded.error && guarded.error.includes("Path is not public"), `read_file public-path guard (got ${guarded.error ? "error" : "no error"})`)

  // ── reviews: stable shared ids from the SAME review.json ────────────────
  const reviews = await callTool(mainClient.client, "llm_wiki_reviews")
  ok(reviews.text.includes(`ID: ${REVIEW_STABLE}`) && reviews.text.includes("missing_page"), "reviews expose the stable shared review-<hash> id (desktop FNV-1a over the same review.json)")
  ok(reviews.text.includes("Status: unresolved") && reviews.text.includes("Missing page: Foo Bar"), "reviews default to unresolved and carry the sanitized title")

  // ── search / graph / rescan ─────────────────────────────────────────────
  const search = await callTool(mainClient.client, "llm_wiki_search", { query: "quantum" })
  ok(search.text.includes("# Search results for \"quantum\"") && search.text.includes("wiki/quantum.md"), "llm_wiki_search finds the quantum page through the shared backend")
  ok(search.text.includes("Mode: "), "search response carries the hybrid mode note")
  const graph = await callTool(mainClient.client, "llm_wiki_graph")
  const nodesMatch = graph.text.match(/Nodes: (\d+)/)
  ok(graph.text.includes("# Knowledge graph") && nodesMatch && Number(nodesMatch[1]) >= 1, `llm_wiki_graph returns the wiki graph (${nodesMatch ? nodesMatch[1] : "?"} nodes)`)
  const rescan = await callTool(mainClient.client, "llm_wiki_rescan_sources")
  const rescanJson = jsonOf(rescan)
  ok(rescanJson && rescanJson.result && typeof rescanJson.result.queueVersion === "number", `llm_wiki_rescan_sources triggers a source rescan (queueVersion envelope) — got ${rescan.text.slice(0,160).replace(/\n/g," ")}`)

  // ── chat: mock LLM round-trip + SHARED session file (cross-client) ──────
  const sid = "mcp-verify-1"
  const chat = await callTool(mainClient.client, "llm_wiki_chat", { message: "What does the quantum page say?", session_id: sid })
  ok(chat.text.includes("# LLM Wiki Agent response") && chat.text.includes(`Session: ${sid}`), "chat returns the agent envelope with the caller session id")
  ok(chat.text.includes(ANSWER), "chat answer comes from the mock LLM (full provider round-trip)")
  ok(chat.text.includes("## References") && chat.text.includes("Quantum"), "chat carries the wiki.search references")
  ok(chat.text.includes("## Tool events") && chat.text.includes("wiki.search"), "chat carries toolEvents for the wiki.search round-trip")
  const sessionFile = path.join(projectPath, ".llm-wiki", "agent-sessions", `${sid}.json`)
  ok(fs.existsSync(sessionFile), `chat persisted the SHARED desktop-format session file (${path.relative(projectPath, sessionFile)})`)
  const session = JSON.parse(fs.readFileSync(sessionFile, "utf-8"))
  ok(session.sessionId === sid && session.projectId === "proj-1" && Array.isArray(session.messages), "session file has the desktop AgentSession shape (sessionId/projectId/messages)")
  ok(session.messages.some((m) => m.role === "user") && session.messages.some((m) => m.role === "assistant" && String(m.content).includes(ANSWER)), "session messages carry the user turn + the assistant answer (desktop append_turn)")

  // ── mcpEnabled kill-switch (live store flip, no restart) ────────────────
  writeStore({ apiConfig: { token: TOKEN, mcpEnabled: false, allowUnauthenticated: false } })
  await sleep(120)
  const disabled = await callTool(mainClient.client, "llm_wiki_projects")
  ok(disabled.error && disabled.error.includes("LLM Wiki MCP access is disabled"), `mcpEnabled=false gates the tools (got ${disabled.error ? "error" : "no error"})`)
  const statusWhileDisabled = jsonOf(await callTool(mainClient.client, "llm_wiki_status"))
  ok(statusWhileDisabled && statusWhileDisabled.ok === true, "llm_wiki_status stays reachable while MCP is disabled (diagnosis contract)")
  writeStore({ apiConfig: { token: TOKEN, mcpEnabled: true, allowUnauthenticated: false } })
  await sleep(120)
  const reEnabled = jsonOf(await callTool(mainClient.client, "llm_wiki_projects"))
  ok(reEnabled && Array.isArray(reEnabled.projects), "out-of-band mcpEnabled=true flip is honored with NO restart")
  await mainClient.client.close(); mainClient = null

  // ── token-auth contract: 401 without token, status public ───────────────
  const anon = await newMcpClient(null)
  const anonStatus = jsonOf(await callTool(anon.client, "llm_wiki_status"))
  ok(anonStatus && anonStatus.ok === true, "auth: health/status is public (api_server.rs health is unauthenticated)")
  const anonProjects = await callTool(anon.client, "llm_wiki_projects")
  ok(anonProjects.error && anonProjects.error.includes("401") && anonProjects.error.includes("Unauthorized"), `auth: projects without token -> 401 Unauthorized (got ${anonProjects.error ? "error" : "no error"})`)

  // ── live allowUnauthenticated flip (no restart) ─────────────────────────
  writeStore({ apiConfig: { token: TOKEN, mcpEnabled: true, allowUnauthenticated: true } })
  await sleep(120)
  const openProjects = jsonOf(await callTool(anon.client, "llm_wiki_projects"))
  ok(openProjects && openProjects.projects.some((p) => p.id === "proj-1"), "auth: out-of-band allowUnauthenticated=true is honored with NO restart")
  writeStore({ apiConfig: { token: TOKEN, mcpEnabled: true, allowUnauthenticated: false } })
  await sleep(120)
  const closedAgain = await callTool(anon.client, "llm_wiki_projects")
  ok(closedAgain.error && closedAgain.error.includes("401"), "auth: token requirement returns after the live flip back (no restart)")
  await anon.client.close()
} catch (e) {
  fail++
  console.log("  FAIL- harness error:", e.message)
  console.log(serverLog.split("\n").slice(-20).join("\n"))
} finally {
  if (mainClient) { try { await mainClient.client.close() } catch {} }
  child.kill("SIGKILL")
  mock.close()
}

console.log(`\nmcp-interop: ${pass} passed, ${fail} failed (entry: ${SERVER_ENTRY})`)
process.exit(fail ? 1 : 0)
