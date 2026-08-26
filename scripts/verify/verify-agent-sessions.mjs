// Agent session persistence + command-contract acceptance harness.
//
// Part A mirrors the desktop's Rust unit tests (src-tauri/src/agent/session.rs)
// against the Node port (packages/server/src/agent-sessions.js): append/recent,
// missing->empty, disk persistence across a fresh store, project isolation,
// path-traversal rejection, newest-first listing, the 40-message cap, and the
// bounded in-memory cache.
//
// Part B stands up the server + a mock OpenAI-compatible LLM (LLM_WIKI_NO_SHARE=1)
// and drives the real commands over HTTP, asserting the desktop contract:
//   - a completed agent turn persists <project>/.llm-wiki/agent-sessions/<id>.json
//   - agent_get_session(projectId,sessionId,limit) -> recent messages (clamped)
//   - agent_list_sessions(projectId) -> sessions newest-first
//   - an out-of-band (desktop-written) session file is read with NO restart
//   - empty history + !historyExplicit hydrates the LLM prompt from the session
//   - historyExplicit:true suppresses that hydration
//   - persistSession:false writes nothing
//   - a missing sessionId auto-generates "ui_<uuid>"
//   - unknown-project -> "Unknown project: <id>"
//
//   node scripts/verify/verify-agent-sessions.mjs

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http from "node:http"
import { appendTurn, recentMessages, listSessions, sanitizeSessionId, sessionFilePath } from "../../packages/server/src/agent-sessions.js"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log("  ok  -", m) } else { fail++; console.log("  FAIL-", m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Part A: pure module unit tests (mirror session.rs) ────────────────────
console.log("== Part A: agent-sessions module unit (mirrors session.rs) ==")
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "ags-unit-"))
  appendTurn({ projectPath: proj, projectId: "p1", sessionId: "s1", user: "hello", assistant: "hi" })
  appendTurn({ projectPath: proj, projectId: "p1", sessionId: "s1", user: "question", assistant: "answer" })
  const m = recentMessages({ projectPath: proj, sessionId: "s1", limit: 3 })
  ok(m.length === 3 && m[0].content === "hi" && m[1].role === "user" && m[2].content === "answer", "append_turn_tracks_recent_messages (limit=3 window)")
  ok(typeof m[0].timestamp === "number" && m[0].timestamp > 0, "messages carry epoch-ms timestamps")
  ok(recentMessages({ projectPath: proj, sessionId: "missing", limit: 10 }).length === 0, "recent_messages_returns_empty_for_missing_session")

  // Fresh store reads the same on-disk file: disk is authoritative (the
  // module reads straight from disk, so cross-client appends are always seen).
  const m2 = recentMessages({ projectPath: proj, sessionId: "s1", limit: 10 })
  ok(m2.length === 4 && m2[0].content === "hello", "append_turn_persists_session_to_project_state_dir (fresh store reads disk)")
  ok(fs.existsSync(path.join(proj, ".llm-wiki", "agent-sessions", "s1.json")), "session file written under .llm-wiki/agent-sessions/")
  const onDisk = JSON.parse(fs.readFileSync(path.join(proj, ".llm-wiki", "agent-sessions", "s1.json"), "utf8"))
  ok(onDisk.sessionId === "s1" && onDisk.projectId === "p1" && Array.isArray(onDisk.messages) && typeof onDisk.updatedAt === "number", "on-disk AgentSession has camelCase shape {sessionId,projectId,messages,updatedAt}")

  const pa = fs.mkdtempSync(path.join(os.tmpdir(), "ags-isoA-"))
  const pb = fs.mkdtempSync(path.join(os.tmpdir(), "ags-isoB-"))
  appendTurn({ projectPath: pa, projectId: "p1", sessionId: "same", user: "hello a", assistant: "answer a" })
  appendTurn({ projectPath: pb, projectId: "p2", sessionId: "same", user: "hello b", assistant: "answer b" })
  ok(recentMessages({ projectPath: pa, sessionId: "same", limit: 10 })[0].content === "hello a" && recentMessages({ projectPath: pb, sessionId: "same", limit: 10 })[0].content === "hello b", "same_session_id_is_isolated_by_project")

  ok(sessionFilePath("/tmp/project", "../secret") === null && sessionFilePath("/tmp/project", "a/b") === null, "session_ids_reject_path_traversal")
  ok(sessionFilePath("/tmp/project", "safe-id") !== null, "safe id accepted")
  ok(sanitizeSessionId("weird id!") === "weird_id_", "sanitize maps invalid chars to _")
  ok(sanitizeSessionId("x".repeat(129)) === null, "sanitize rejects >128 chars")

  const pl = fs.mkdtempSync(path.join(os.tmpdir(), "ags-list-"))
  appendTurn({ projectPath: pl, projectId: "p1", sessionId: "s1", user: "one", assistant: "a" })
  appendTurn({ projectPath: pl, projectId: "p1", sessionId: "s2", user: "two", assistant: "b" })
  const ls = listSessions(pl)
  ok(ls.length === 2 && ls[0].sessionId === "s2" && ls[1].sessionId === "s1", "list_sessions_returns_persisted_sessions_newest_first")
  ok(listSessions(path.join(pl, "nope")).length === 0, "list_sessions empty for missing dir")

  const pc = fs.mkdtempSync(path.join(os.tmpdir(), "ags-cap-"))
  for (let i = 0; i < 25; i++) appendTurn({ projectPath: pc, projectId: "p1", sessionId: "big", user: "u" + i, assistant: "a" + i })
  const capped = recentMessages({ projectPath: pc, sessionId: "big", limit: 1000 })
  ok(capped.length === 40 && capped[0].content === "u5", "messages capped at 40 (oldest dropped)")

  // Cross-client append: the module reads/writes the desktop-format file
  // directly (no in-process cache), so a desktop-written message is seen with
  // no restart and a web append builds ON it (no clobber) — the shared-data
  // guarantee for chat sessions.
  const phot = fs.mkdtempSync(path.join(os.tmpdir(), "ags-hot-"))
  appendTurn({ projectPath: phot, projectId: "p1", sessionId: "hot", user: "web-user", assistant: "web-answer" })
  ok(recentMessages({ projectPath: phot, sessionId: "hot", limit: 10 }).length === 2, "hot session readable (2 msgs)")
  const hotFile = sessionFilePath(phot, "hot")
  const desktopHot = JSON.parse(fs.readFileSync(hotFile, "utf8"))
  desktopHot.messages.push({ role: "user", content: "desktop-user", timestamp: Date.now() })
  desktopHot.messages.push({ role: "assistant", content: "desktop-answer", timestamp: Date.now() })
  desktopHot.updatedAt = Date.now()
  fs.writeFileSync(hotFile, JSON.stringify(desktopHot, null, 2))
  const hotFresh = recentMessages({ projectPath: phot, sessionId: "hot", limit: 10 })
  ok(hotFresh.length === 4 && hotFresh.some((m) => m.content === "desktop-answer"), "desktop append seen with NO restart (disk-authoritative read)")
  appendTurn({ projectPath: phot, projectId: "p1", sessionId: "hot", user: "web-user-2", assistant: "web-answer-2" })
  const hotDisk = JSON.parse(fs.readFileSync(hotFile, "utf8"))
  ok(hotDisk.messages.length === 6 && hotDisk.messages.some((m) => m.content === "desktop-answer") && hotDisk.messages.some((m) => m.content === "web-answer-2"), "web append builds on desktop messages (no clobber)")
}

// ── Part B helpers: mock LLM + server ─────────────────────────────────────
function freePort() {
  return new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
}
async function waitFor(fn, t, what) {
  const start = Date.now()
  while (Date.now() - start < t) { try { if (await fn()) return true } catch {} await sleep(80) }
  throw new Error(`timeout waiting for ${what}`)
}
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body)
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c))
      res.on("end", () => { try { resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }) } catch { resolve({ status: res.statusCode, raw: buf }) } })
    })
    r.on("error", reject); if (data) r.write(data); r.end()
  })
}

const TOOL_CALL_ID = "call_mock_1"
const llmRequests = [] // each: { messages }
const wantsTool = (messages) => !messages.some((m) => m.role === "tool")
function mockHandler(reqBody, res) {
  const messages = reqBody.messages ?? []
  llmRequests.push({ messages: JSON.parse(JSON.stringify(messages)) })
  const stream = !!reqBody.stream
  if (wantsTool(messages)) {
    if (stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const chunk = (delta, finish) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`
      res.write(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: TOOL_CALL_ID, type: "function", function: { name: "wiki.search", arguments: "" } }] }))
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ query: "quantum" }) } }] }))
      res.write(chunk({}, "tool_calls"))
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: TOOL_CALL_ID, type: "function", function: { name: "wiki.search", arguments: JSON.stringify({ query: "quantum" }) } }] } }] }))
    }
  } else {
    const answer = "The quantum page describes quantum mechanics."
    if (stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const chunk = (delta, finish) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`
      for (const word of answer.split(" ")) res.write(chunk({ role: "assistant", content: word + " " }))
      res.write(chunk({}, "stop"))
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer } }] }))
    }
  }
}

console.log("== Part B: HTTP command contract + shared-data freshness ==")
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-agentsess-"))
const dataDir = path.join(tmp, "data")
fs.mkdirSync(path.join(dataDir, "stores"), { recursive: true })
const projectPath = path.join(tmp, "project")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n")
fs.writeFileSync(path.join(projectPath, "wiki", "quantum.md"), "---\ntype: entity\ntitle: Quantum\n---\n# Quantum\nQuantum mechanics is the study of matter at atomic scales.\n")
const storeData = {
  llmConfig: { provider: "custom", apiKey: "test-key", model: "mock-model", customEndpoint: `http://127.0.0.1:${mockPort}/v1`, apiMode: "chat_completions" },
  projectRegistry: { "proj-1": { id: "proj-1", path: projectPath, name: "project" } },
  lastProject: { id: "proj-1", path: projectPath },
}
fs.writeFileSync(path.join(dataDir, "stores", "app-state.json"), JSON.stringify(storeData, null, 2))

const port = await freePort()
const child = spawn(process.execPath, ["packages/server/src/index.js"], {
  cwd: REPO,
  env: { ...process.env, LLM_WIKI_PORT: String(port), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""; child.stdout.on("data", (d) => (serverLog += d)); child.stderr.on("data", (d) => (serverLog += d))
const sessDir = path.join(projectPath, ".llm-wiki", "agent-sessions")

try {
  await waitFor(async () => (await req(port, "GET", "/api/health")).status === 200, 8000, "server health")
  console.log("server up on", port, "| mock LLM on", mockPort)

  // 1. A completed non-stream turn persists the session to disk.
  const r1 = await req(port, "POST", "/api/invoke/agent_start_turn", {
    projectId: "proj-1",
    request: { sessionId: "s-persist", runId: "run-1", message: "What does the quantum page say?", history: [], mode: "standard", tools: {} },
  })
  ok(r1.status === 200 && r1.json?.sessionId === "s-persist", "agent_start_turn 200 + echoes sessionId")
  const f1 = path.join(sessDir, "s-persist.json")
  ok(fs.existsSync(f1), "turn persisted .llm-wiki/agent-sessions/s-persist.json")
  const sess1 = fs.existsSync(f1) ? JSON.parse(fs.readFileSync(f1, "utf8")) : null
  ok(sess1 && sess1.sessionId === "s-persist" && sess1.projectId === "proj-1", "persisted session has sessionId + projectId")
  ok(sess1 && sess1.messages.length === 2 && sess1.messages[0].role === "user" && sess1.messages[0].content === "What does the quantum page say?" && sess1.messages[1].role === "assistant" && /quantum/i.test(sess1.messages[1].content), "persisted [user, assistant] turn pair")

  // 2. agent_get_session returns the recent messages (desktop contract).
  const g1 = await req(port, "POST", "/api/invoke/agent_get_session", { projectId: "proj-1", sessionId: "s-persist", limit: 10 })
  ok(g1.status === 200 && Array.isArray(g1.json) && g1.json.length === 2 && g1.json[0].role === "user" && g1.json[1].role === "assistant", "agent_get_session -> Vec<AgentSessionMessage>")
  ok(g1.json?.[0]?.content === "What does the quantum page say?" && typeof g1.json?.[0]?.timestamp === "number", "agent_get_session message shape {role,content,timestamp}")
  const g2 = await req(port, "POST", "/api/invoke/agent_get_session", { projectId: "proj-1", sessionId: "s-persist", limit: 1 })
  ok(g2.status === 200 && g2.json.length === 1 && g2.json[0].role === "assistant", "agent_get_session honors limit (last 1)")

  // 3. agent_list_sessions returns sessions newest-first.
  const l1 = await req(port, "POST", "/api/invoke/agent_list_sessions", { projectId: "proj-1" })
  ok(l1.status === 200 && Array.isArray(l1.json) && l1.json.some((s) => s.sessionId === "s-persist"), "agent_list_sessions includes s-persist")

  // 4. Shared-data freshness: an out-of-band (desktop-written) session is read
  //    with NO server restart.
  const desktopSession = { sessionId: "desktop-1", projectId: "proj-1", messages: [{ role: "user", content: "from desktop", timestamp: Date.now() }, { role: "assistant", content: "desktop answer", timestamp: Date.now() }], updatedAt: Date.now() + 100000 }
  fs.mkdirSync(sessDir, { recursive: true })
  fs.writeFileSync(path.join(sessDir, "desktop-1.json"), JSON.stringify(desktopSession, null, 2))
  const g3 = await req(port, "POST", "/api/invoke/agent_get_session", { projectId: "proj-1", sessionId: "desktop-1", limit: 10 })
  ok(g3.status === 200 && g3.json.length === 2 && g3.json[0].content === "from desktop", "out-of-band desktop session read live (no restart)")
  const l2 = await req(port, "POST", "/api/invoke/agent_list_sessions", { projectId: "proj-1" })
  ok(l2.status === 200 && l2.json[0].sessionId === "desktop-1", "list_sessions sees desktop session newest-first (higher updatedAt)")

  // 5. History seeding: a 2nd turn on the same session with empty history
  //    hydrates the LLM prompt from the persisted session.
  const before = llmRequests.length
  const r2 = await req(port, "POST", "/api/invoke/agent_start_turn", {
    projectId: "proj-1",
    request: { sessionId: "s-persist", runId: "run-2", message: "And what else?", history: [], mode: "standard", tools: {} },
  })
  ok(r2.status === 200, "2nd turn (same session) 200")
  const firstCallOfTurn2 = llmRequests[before]
  const seeded = firstCallOfTurn2?.messages.some((m) => m.role === "user" && m.content === "What does the quantum page say?")
  ok(!!seeded, "empty history + !historyExplicit hydrates prompt from persisted session")
  const sess2 = JSON.parse(fs.readFileSync(f1, "utf8"))
  ok(sess2.messages.length === 4, "session grew to 4 messages after 2nd turn")

  // 6. historyExplicit:true suppresses hydration (even with empty history).
  const before3 = llmRequests.length
  await req(port, "POST", "/api/invoke/agent_start_turn", {
    projectId: "proj-1",
    request: { sessionId: "s-persist", runId: "run-3", message: "Explicit empty", history: [], historyExplicit: true, mode: "standard", tools: {} },
  })
  const firstCallOfTurn3 = llmRequests[before3]
  const notSeeded = !firstCallOfTurn3?.messages.some((m) => m.role === "user" && m.content === "What does the quantum page say?")
  ok(!!notSeeded, "historyExplicit:true suppresses session hydration")

  // 7. persistSession:false writes nothing.
  const r4 = await req(port, "POST", "/api/invoke/agent_start_turn", {
    projectId: "proj-1",
    request: { sessionId: "no-persist", runId: "run-4", message: "ephemeral", history: [], historyExplicit: true, persistSession: false, mode: "standard", tools: {} },
  })
  ok(r4.status === 200 && !fs.existsSync(path.join(sessDir, "no-persist.json")), "persistSession:false writes no session file")

  // 8. Missing sessionId auto-generates "ui_<uuid>" and persists under it.
  const r5 = await req(port, "POST", "/api/invoke/agent_start_turn", {
    projectId: "proj-1",
    request: { runId: "run-5", message: "auto id", history: [], historyExplicit: true, mode: "standard", tools: {} },
  })
  ok(r5.status === 200 && typeof r5.json?.sessionId === "string" && r5.json.sessionId.startsWith("ui_"), `missing sessionId auto-generates ui_* (got ${r5.json?.sessionId})`)
  ok(r5.json && fs.existsSync(path.join(sessDir, `${r5.json.sessionId}.json`)), "auto-generated session persisted under ui_*.json")

  // 9. Unknown-project error matches the desktop contract.
  const e1 = await req(port, "POST", "/api/invoke/agent_get_session", { projectId: "nope", sessionId: "x", limit: 5 })
  ok(e1.status === 500 && /Unknown project: nope/.test(e1.raw || JSON.stringify(e1.json)), `agent_get_session unknown-project error (got ${e1.status})`)
  const e2 = await req(port, "POST", "/api/invoke/agent_list_sessions", { projectId: "nope" })
  ok(e2.status === 500 && /Unknown project: nope/.test(e2.raw || JSON.stringify(e2.json)), "agent_list_sessions unknown-project error")
} catch (err) {
  fail++; console.log("  FAIL- harness error:", err.message)
  console.log("--- server log tail ---\n" + serverLog.split("\n").slice(-20).join("\n"))
} finally {
  try { child.kill("SIGKILL") } catch {}
  try { mock.close() } catch {}
}

console.log(`\nagent-sessions: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
