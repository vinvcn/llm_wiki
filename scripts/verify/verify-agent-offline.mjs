// Agent OFFLINE-contract acceptance harness.
//
// The desktop agent (runtime.rs run_once_with_cancel_and_events) degrades to
// a deterministic router + retrieval pipeline when the resolved chat config
// is NOT usable for backend HTTP (missing API key/model, or a CLI-only
// provider such as claude-code/codex-cli): it answers with the retrieval
// summary (ok:true) and NEVER calls an LLM or surfaces a provider/network
// error. This harness pins the web server's faithful port (agent-legacy.js):
//
//   - fresh store (no llmConfig)          -> graceful retrieval answer
//   - openai provider, key missing        -> graceful (no outbound LLM call)
//   - claude-code CLI provider            -> graceful (no desktop-app error)
//   - routing preset resolving to CLI     -> graceful
//   - streaming path                      -> toolStart/referenceAdded/toolEnd
//                                            /done SSE sequence, no error event
//   - router gating (skills, tools off)   -> exact desktop fallback strings
//   - shell.exec via request.shellCommand -> unapproved/approved contracts
//   - faithful retrieval mode             -> no "available" hint tool events
//   - deep mode offline                   -> deep_research.run brackets +
//                                            wiki excerpts in the answer
//   - /api/v1 chat endpoint               -> same contract over REST
//   - mock LLM hit counter stays ZERO     -> offline never calls an LLM
//   - usable custom provider (no key)     -> still runs the LLM loop
//
// The non-stream cases (4/5) also pin the CLI-provider CHAT flow: for
// claude-code/codex-cli providers the frontend calls agent_start_turn as its
// server-side retrieval step and feeds the returned message into the CLI
// transport as context (chat-panel.tsx contextText) — before the port that
// call threw "requires the desktop app" and the whole CLI chat was broken.
//
//   node scripts/verify/verify-agent-offline.mjs

import { spawn } from "node:child_process"
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
function req(port, method, p, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body)
    const headers = { ...extraHeaders }
    if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data) }
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c))
      res.on("end", () => { try { resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }) } catch { resolve({ status: res.statusCode, raw: buf }) } })
    })
    r.on("error", reject); if (data) r.write(data); r.end()
  })
}

// ── Mock LLM that must NEVER be called by offline turns ───────────────────
let mockHits = 0
const mockPort = await freePort()
const mock = http.createServer((rq, rs) => {
  let buf = ""
  rq.on("data", (c) => (buf += c))
  rq.on("end", () => {
    if (rq.method === "POST" && rq.url.includes("/chat/completions")) {
      mockHits++
      rs.writeHead(200, { "Content-Type": "application/json" })
      rs.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "MOCK_LLM_ANSWER" } }] }))
    } else { rs.writeHead(404); rs.end("nope") }
  })
})
await new Promise((r) => mock.listen(mockPort, r))

// ── Fake project + isolated store ─────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-agent-offline-"))
const dataDir = path.join(tmp, "data")
const storesDir = path.join(dataDir, "stores")
fs.mkdirSync(storesDir, { recursive: true })
const projectPath = path.join(tmp, "project")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.mkdirSync(path.join(projectPath, "raw", "sources"), { recursive: true })
fs.mkdirSync(path.join(projectPath, ".llm-wiki", "skills", "greeter"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n")
fs.writeFileSync(path.join(projectPath, "wiki", "alpha.md"), "---\ntype: entity\ntitle: Alpha\n---\n# Alpha\nAlpha is the first concept of this wiki. It links to [[beta]].\n")
fs.writeFileSync(path.join(projectPath, "wiki", "beta.md"), "---\ntype: entity\ntitle: Beta\n---\n# Beta\nBeta follows alpha.\n")
fs.writeFileSync(path.join(projectPath, "raw", "sources", "notes.md"), "---\ntitle: Notes\n---\nAlpha appears in the raw source notes too.\n")
fs.writeFileSync(path.join(projectPath, ".llm-wiki", "skills", "greeter", "SKILL.md"), "---\nname: greeter\ndescription: A tiny test skill.\n---\nSay hello.\n")

const storePath = path.join(storesDir, "app-state.json")
function writeStore(extra) {
  fs.writeFileSync(storePath, JSON.stringify({
    projectRegistry: { "proj-1": { id: "proj-1", path: projectPath, name: "project" } },
    lastProject: { id: "proj-1", path: projectPath },
    ...extra,
  }, null, 2))
}
writeStore({}) // fresh: no llmConfig at all

const SERVER_ENTRY = process.env.SERVER_ENTRY || "packages/server/src/index.js"
const port = await freePort()
const child = spawn(process.execPath, [SERVER_ENTRY], {
  cwd: REPO,
  env: { ...process.env, LLM_WIKI_PORT: String(port), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", (d) => (serverLog += d)); child.stderr.on("data", (d) => (serverLog += d))
await waitFor(async () => (await req(port, "GET", "/api/health")).status === 200, 10000, "server health")

const turn = (request) => req(port, "POST", "/api/invoke/agent_start_turn", { projectId: "proj-1", request })
const baseReq = { sessionId: "s1", runId: "r1", persistSession: false, mode: "standard", tools: { wiki: true, web: false, anytxt: false } }

function sseCollect() {
  const events = []
  const rq = http.request({ host: "127.0.0.1", port, path: "/api/events", method: "GET" }, (res) => {
    let buf = ""
    res.on("data", (c) => {
      buf += c.toString()
      let idx
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2)
        const line = block.split("\n").find((l) => l.startsWith("data:"))
        if (!line) continue
        try { const d = JSON.parse(line.slice(5)); if (d.event === "agent-event") events.push(d.payload) } catch {}
      }
    })
  })
  rq.end()
  return { events, close: () => rq.destroy() }
}

try {
  // ── 1. Fresh store: no llmConfig at all ────────────────────────────────
  {
    const r = await turn({ ...baseReq, message: "What is alpha?" })
    ok(!r.json?.error, `fresh store: turn succeeds (no error; got ${JSON.stringify(r.json?.error)})`)
    const msg = r.json?.message ?? ""
    ok(msg.startsWith('I searched the current LLM Wiki project for "What is alpha?" and found'), "fresh store: answer is the desktop build_retrieval_answer text")
    ok((r.json?.references ?? []).some((x) => x.path === "wiki/alpha.md"), "fresh store: wiki reference attached")
    const te = r.json?.toolEvents ?? []
    ok(te.some((e) => e.tool === "wiki.search" && e.status === "started" && e.detail === "What is alpha?"), "fresh store: wiki.search started toolEvent")
    ok(te.some((e) => e.tool === "wiki.search" && e.status === "completed" && /result\(s\), mode=/.test(e.detail ?? "")), "fresh store: wiki.search completed toolEvent with mode/hits detail")
    const ev = r.json?.events ?? []
    ok(ev.some((e) => e.type === "toolStart" && e.tool === "wiki.search"), "fresh store: toolStart SSE event recorded")
    ok(ev.some((e) => e.type === "referenceAdded"), "fresh store: referenceAdded SSE event recorded")
    ok(mockHits === 0, `fresh store: NO LLM call attempted (mock hits=${mockHits})`)
  }

  // ── 2. Streaming path: exact SSE sequence + done carries the text ─────
  {
    const sse = sseCollect()
    await sleep(200)
    const runId = await req(port, "POST", "/api/invoke/agent_start_turn_stream", {
      projectId: "proj-1",
      request: { ...baseReq, sessionId: "s2", runId: "r2", stream: true, message: "What is alpha?" },
    })
    ok(typeof runId.json === "string" && runId.json === "r2", "stream: invoke returns the runId")
    await waitFor(async () => sse.events.some((p) => p.runId === "r2" && p.event?.type === "done"), 10000, "stream done event")
    const evs = sse.events.filter((p) => p.runId === "r2").map((p) => p.event)
    const types = evs.map((e) => e.type)
    ok(types[0] === "toolStart" && types[1] === "referenceAdded" && types.includes("toolEnd") && types[types.length - 1] === "done", `stream: sequence toolStart -> referenceAdded -> toolEnd -> done (got ${types.join(",")})`)
    ok(!types.includes("error"), "stream: no error event")
    ok(!types.includes("messageDelta"), "stream: no messageDelta offline (desktop emits deltas only from LLM streaming)")
    const done = evs.find((e) => e.type === "done")
    ok(typeof done.text === "string" && done.text.includes("relevant page(s)"), "stream: done.text carries the retrieval answer")
    ok(Array.isArray(done.references) && done.references.length > 0, "stream: done.references attached")
    sse.close()
  }

  // ── 3. Provider set but key missing (the fresh-install UI shape) ──────
  {
    writeStore({ llmConfig: { provider: "openai", apiKey: "", model: "gpt-4o", ollamaUrl: "", customEndpoint: "" } })
    const r = await turn({ ...baseReq, sessionId: "s3", runId: "r3", message: "What is alpha?" })
    ok(!r.json?.error && String(r.json?.message ?? "").includes("relevant page(s)"), "openai w/o key: graceful retrieval answer (no 401/fetch error)")
    ok(mockHits === 0, "openai w/o key: NO LLM call attempted")
  }

  // ── 4. CLI provider (claude-code) in the shared config ────────────────
  {
    writeStore({ llmConfig: { provider: "claude-code", apiKey: "", model: "claude-sonnet-4-6", ollamaUrl: "", customEndpoint: "" } })
    const r = await turn({ ...baseReq, sessionId: "s4", runId: "r4", message: "What is alpha?" })
    ok(!r.json?.error && String(r.json?.message ?? "").includes("relevant page(s)"), `claude-code provider: graceful retrieval answer (got error=${JSON.stringify(r.json?.error)})`)
    ok(!String(r.json?.message ?? r.json?.error ?? "").includes("requires the desktop app"), "claude-code provider: no desktop-app error string")
  }

  // ── 5. Routing preset resolving to the codex CLI preset ───────────────
  {
    writeStore({
      llmConfig: { provider: "openai", apiKey: "sk-real", model: "gpt-4o", ollamaUrl: "", customEndpoint: "" },
      taskModelRouting: { chatPresetId: "codex-cli", ingestPresetId: null },
    })
    const r = await turn({ ...baseReq, sessionId: "s5", runId: "r5", message: "What is alpha?" })
    ok(!r.json?.error && String(r.json?.message ?? "").includes("relevant page(s)"), `routing -> codex-cli preset: graceful retrieval answer (got error=${JSON.stringify(r.json?.error)})`)
    ok(mockHits === 0, "routing -> codex-cli preset: NO LLM call attempted")
  }

  // ── 6. Router gating: no tools enabled ────────────────────────────────
  {
    writeStore({})
    const r = await turn({ ...baseReq, sessionId: "s6", runId: "r6", message: "hello", tools: { wiki: false, web: false, anytxt: false } })
    ok(r.json?.message === "No Agent tools were enabled for this request. Enable wiki, web, or AnyTXT tools to let the backend Agent retrieve supporting context.", "no tools: exact desktop fallback string")
  }

  // ── 7. Router gating: skill active suppresses the wiki fallback ───────
  {
    const r = await turn({ ...baseReq, sessionId: "s7", runId: "r7", message: "hello", skills: ["greeter"], skillMode: "explicit" })
    ok(r.json?.message === "Router intent=conversation did not require immediate wiki.search for this turn.", `skill active: router-intent fallback string (got ${JSON.stringify(r.json?.message)})`)
    const te = r.json?.toolEvents ?? []
    ok(te.some((e) => e.tool === "skills.load" && e.status === "completed" && e.detail === "1 skill(s) selected"), "skill active: skills.load completed toolEvent with explicit detail")
    ok((r.json?.events ?? []).some((e) => e.type === "toolEnd" && e.tool === "skills.load"), "skill active: skills.load toolEnd SSE event (no toolStart, desktop shape)")
  }

  // ── 8. shell.exec via request.shellCommand (skill turns only) ─────────
  {
    const unapproved = await turn({ ...baseReq, sessionId: "s8", runId: "r8", message: "run it", skills: ["greeter"], shellCommand: "echo offline-hello" })
    ok(String(unapproved.json?.message ?? "").includes("shell.exec was requested by an active skill but was not run because the command has not been approved: `echo offline-hello`."), "shell unapproved: exact desktop not-run string")
    const approved = await turn({ ...baseReq, sessionId: "s8b", runId: "r8b", message: "run it", skills: ["greeter"], shellCommand: "echo offline-hello", approvedShellCommands: ["echo offline-hello"] })
    const msg = String(approved.json?.message ?? "")
    ok(msg.includes("shell.exec `echo offline-hello` exit=Some(0) timedOut=false\nstdout:\noffline-hello\n\nstderr:\n"), `shell approved: desktop summary format incl. command's own trailing newline (got ${JSON.stringify(msg.slice(0, 120))})`)
    ok(fs.existsSync(path.join(projectPath, "agent-workspace")), "shell approved: ran with the agent-workspace cwd (dir exists)")
    const te = approved.json?.toolEvents ?? []
    ok(te.some((e) => e.tool === "shell.exec" && e.status === "completed" && e.detail === "exit=Some(0)"), "shell approved: completed toolEvent with exit detail")
  }

  // ── 9. Faithful retrieval mode: no "available" hint tool events ───────
  {
    const faithful = await turn({ ...baseReq, sessionId: "s9", runId: "r9", message: "What is alpha?", retrievalMode: "faithful", tools: { wiki: true, web: true, anytxt: true } })
    ok(!(faithful.json?.toolEvents ?? []).some((e) => e.status === "available"), "faithful mode: no available-hint tool events")
    const standard = await turn({ ...baseReq, sessionId: "s9b", runId: "r9b", message: "What is alpha?", tools: { wiki: true, web: true, anytxt: true } })
    ok((standard.json?.toolEvents ?? []).some((e) => e.tool === "web.search" && e.status === "available"), "standard mode: web.search available hint present")
    ok((standard.json?.toolEvents ?? []).some((e) => e.tool === "anytxt.search" && e.status === "available"), "standard mode: anytxt.search available hint present")
  }

  // ── 10. Web search enabled but unconfigured: fails as a step, not turn ─
  {
    const r = await turn({ ...baseReq, sessionId: "s10", runId: "r10", message: "search the web for latest news", tools: { wiki: true, web: true, anytxt: false } })
    const te = r.json?.toolEvents ?? []
    ok(!r.json?.error, "web unconfigured: turn still succeeds")
    ok(te.some((e) => e.tool === "web.search" && e.status === "failed"), "web unconfigured: web.search failed step recorded")
    ok(String(r.json?.message ?? "").includes("relevant page(s)") || String(r.json?.message ?? "").includes("did not find matching wiki pages"), "web unconfigured: answer still built from the other retrieval parts")
  }

  // ── 11. Deep mode offline: brackets + wiki excerpts ────────────────────
  {
    const r = await turn({ ...baseReq, sessionId: "s11", runId: "r11", message: "alpha", mode: "deep" })
    const te = r.json?.toolEvents ?? []
    const drStart = te.findIndex((e) => e.tool === "deep_research.run" && e.status === "started")
    const drEnd = te.findIndex((e) => e.tool === "deep_research.run" && e.status === "completed")
    ok(drStart >= 0 && drEnd > drStart, "deep: deep_research.run started->completed bracket")
    ok(te[drEnd]?.detail === `${(r.json?.references ?? []).length} reference(s)`, "deep: completed detail is the reference count")
    const msg = String(r.json?.message ?? "")
    ok(msg.includes("Excerpt from wiki/alpha.md:"), "deep: wiki excerpt included in the answer")
    ok(te.some((e) => e.tool === "source.search" && (e.status === "completed" || e.status === "failed")), "deep: source.search ran (shouldIncludeSources in deep mode)")
  }

  // ── 12. /api/v1 chat endpoint carries the same offline contract ───────
  {
    writeStore({ apiConfig: { token: "offline-secret" } }) // chat endpoints always need a configured token (api_server.rs)
    const r = await req(port, "POST", "/api/v1/projects/proj-1/chat", { message: "What is alpha?" }, { Authorization: "Bearer offline-secret" })
    ok(r.status === 200 && r.json?.ok === true, `api/v1 chat offline: 200 ok:true (got ${r.status} ${JSON.stringify(r.json?.error ?? "")})`)
    ok(r.json?.message?.role === "assistant" && String(r.json?.message?.content ?? "").includes("relevant page(s)"), "api/v1 chat offline: assistant envelope carries the retrieval answer")
    ok(typeof r.json?.usage?.referenceCount === "number" && typeof r.json?.usage?.toolEventCount === "number", "api/v1 chat offline: usage counters present")
  }

  // ── 13. A USABLE config still runs the real loop (regression guard) ───
  {
    writeStore({ llmConfig: { provider: "custom", apiKey: "", model: "mock-model", customEndpoint: `http://127.0.0.1:${mockPort}/v1`, apiMode: "chat_completions" } })
    const r = await turn({ ...baseReq, sessionId: "s13", runId: "r13", message: "anything" })
    ok(mockHits === 1, `usable custom provider (no key needed): LLM loop still runs (mock hits=${mockHits})`)
    ok(r.json?.message === "MOCK_LLM_ANSWER", "usable custom provider: loop answer comes from the LLM, not the offline fallback")
  }

  ok(mockHits === 1, `overall: mock LLM hit exactly once (the usable-config case only; hits=${mockHits})`)
} catch (e) {
  fail++; console.log("  FAIL- harness error:", e.message)
  console.log(serverLog.slice(-3000))
} finally {
  try { child.kill("SIGTERM") } catch {}
  try { mock.close() } catch {}
}

console.log(`\nverify-agent-offline: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
