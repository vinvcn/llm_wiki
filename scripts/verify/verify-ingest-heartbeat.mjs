// Ingest liveness-heartbeat acceptance harness (recreated; the RUNBOOK
// documents it as a standing-gate target). Boots the SHIPPED v2 server with a
// fast heartbeat cadence (LLM_WIKI_INGEST_HEARTBEAT_MS=200 — the issue-#32
// test hook, clamped to 100ms..60s) and a SLOW mock OpenAI-compatible LLM
// (~1.2s per streaming chat call), then enqueues two sources by path and
// pins the desktop/issue-#32 contract over the REST queue
// (GET /api/v2/projects/:id/ingest/queue/:taskId):
//   - a PENDING task has heartbeat_at null (the orchestrator never touches
//     rows it has not claimed; concurrency=1 keeps task B pending behind the
//     slow task A for a deterministic window)
//   - a PROCESSING task's heartbeat_at appears and ADVANCES while the long
//     LLM call runs, with progress still frozen at 0 until the stage boundary
//   - a COMPLETED task keeps heartbeat_at > 0 and then STOPS advancing
//     (the liveness signal must not keep ticking after the run leaves
//     'processing' — a stale counter would mask exactly the hung runs the
//     heartbeat exists to expose)
//
//   node scripts/verify/verify-ingest-heartbeat.mjs

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http from "node:http"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const ENTRY = "packages/server/src/index-v2.js"
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log("  ok  -", m) } else { fail++; console.log("  FAIL-", m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function freePort() { return new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) }) }
async function waitFor(fn, t, what) { const s = Date.now(); while (Date.now() - s < t) { try { if (await fn()) return true } catch {} await sleep(100) } throw new Error(`timeout waiting for ${what}`) }
function req(port, method, p, body) {
  return new Promise((resolve) => {
    const data = body == null ? null : JSON.stringify(body)
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c))
      res.on("end", () => { try { resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }) } catch { resolve({ status: res.statusCode, raw: buf }) } })
    })
    r.on("error", () => resolve({ status: 0, json: null })); if (data) r.write(data); r.end()
  })
}
const getTask = (port, projectUuid, taskId) => req(port, "GET", `/api/v2/projects/${projectUuid}/ingest/queue/${taskId}`).then((r) => (r.json?.id != null ? r.json : null))

// ── Slow mock OpenAI-compatible LLM ───────────────────────────────────────
// Analysis + generation each stream ~1.2s worth of chunks, giving the 200ms
// heartbeat cadence several ticks inside BOTH pipeline LLM calls.
const SLOW_MS = 2500
const llmHits = []
function mockLlm(reqBody, res) {
  llmHits.push(reqBody)
  const sys = String((reqBody.messages ?? []).find((m) => m.role === "system")?.content ?? "")
  const isAnalysis = /expert research analyst/i.test(sys)
  const text = isAnalysis
    ? "## Key Entities\n- Heartbeat concept: central to liveness observability.\n\n## Key Concepts\n- Heartbeat-note contents.\n"
    : [
        "---FILE: wiki/sources/heartbeat-note.md---",
        "---",
        "type: source",
        "title: Heartbeat Note",
        "created: 2026-01-01",
        "updated: 2026-01-01",
        "tags: [liveness]",
        "related: []",
        'sources: ["heartbeat-note.md"]',
        "---",
        "",
        "# Heartbeat Note",
        "",
        "MOCK-HEARTBEAT-MARKER This source was summarized by the mock LLM while",
        "the queue task's heartbeat_at ticks.",
        "---END FILE---",
      ].join("\n")
  const chunk = (delta, finish) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`
  res.writeHead(200, { "Content-Type": "text/event-stream" })
  const parts = text.match(/.{1,40}/gs) ?? [text]
  // ~5 chunks over SLOW_MS: each pipeline call stays in-flight well past
  // several 200ms heartbeat intervals.
  const step = Math.max(1, Math.floor(SLOW_MS / Math.max(1, parts.length)))
  let i = 0
  const timer = setInterval(() => {
    if (i < parts.length) {
      res.write(chunk({ role: "assistant", content: parts[i++] }))
      return
    }
    clearInterval(timer)
    res.write(chunk({}, "stop"))
    res.end("data: [DONE]\n\n")
  }, step)
}
const llmPort = await freePort()
const llmMock = http.createServer((rq, rs) => {
  let buf = ""; rq.on("data", (c) => (buf += c))
  rq.on("end", () => {
    if (rq.method === "POST" && rq.url.includes("/chat/completions")) { try { mockLlm(JSON.parse(buf), rs) } catch (e) { rs.writeHead(500); rs.end(String(e)) } }
    else { rs.writeHead(404); rs.end("nope") }
  })
})
await new Promise((r) => llmMock.listen(llmPort, r))

// ── Isolated server + shared-store wiring (one backend, shared user data) ─
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-heartbeat-"))
const dataDir = path.join(tmp, "data")
const storesDir = path.join(dataDir, "stores")
fs.mkdirSync(storesDir, { recursive: true })
const projectUuid = "proj-heartbeat-1"
const projectPath = path.join(tmp, "project")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.mkdirSync(path.join(projectPath, "raw", "sources"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "schema.md"), "# Schema\n\nSource pages summarize raw sources. Entity pages describe things.\n")
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n")
const sourcePath = path.join(projectPath, "raw", "sources", "heartbeat-note.md")
fs.writeFileSync(sourcePath, [
  "# Heartbeat Note",
  "",
  "This note exists so the ingest pipeline holds a stage open long enough",
  "for the liveness heartbeat to tick.",
  "- Measurement collapses the wavefunction.",
].join("\n"))
const sourcePathB = path.join(projectPath, "raw", "sources", "heartbeat-note-b.md")
fs.writeFileSync(sourcePathB, [
  "# Heartbeat Note B",
  "",
  "A second source so task B is a distinct queue row (enqueue-by-path dedupes",
  "on project + resolved path while a task is live).",
].join("\n"))

const storeFile = path.join(storesDir, "app-state.json")
fs.writeFileSync(storeFile, JSON.stringify({
  llmConfig: { provider: "custom", apiKey: "test-key", model: "mock-model", customEndpoint: `http://127.0.0.1:${llmPort}/v1`, apiMode: "chat_completions" },
  projectRegistry: { [projectUuid]: { id: projectUuid, path: projectPath, name: "project" } },
  lastProject: { id: projectUuid, path: projectPath },
}, null, 2))

const port = await freePort()
const child = spawn(process.execPath, [ENTRY], {
  cwd: REPO,
  env: {
    ...process.env,
    LLM_WIKI_PORT: String(port),
    LLM_WIKI_NO_SHARE: "1",
    LLM_WIKI_DATA_DIR: dataDir,
    LLM_WIKI_AUTH_MODE: "none",
    LLM_WIKI_INGEST_HEARTBEAT_MS: "200",
    LLM_WIKI_INGEST_CONCURRENCY: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", (d) => (serverLog += d)); child.stderr.on("data", (d) => (serverLog += d))

try {
  await waitFor(async () => (await req(port, "GET", "/api/health")).status === 200, 8000, "server health")
  console.log(`server up on ${port} (${ENTRY}) | mock LLM on ${llmPort} | heartbeat 200ms, concurrency 1`)

  // ── enqueue task A (slow) then task B (must sit pending behind it) ──────
  // v2 enqueue-by-path takes a project-RELATIVE path (safeJoin strips a
  // leading "/" and joins under the project root); the resolved ABSOLUTE path
  // is what the queue row stores and what the client displays.
  const enq = async (rel) => req(port, "POST", `/api/v2/projects/${projectUuid}/ingest`, { filePath: rel })
  const rA = await enq("raw/sources/heartbeat-note.md")
  ok(rA.status === 200 || rA.status === 201, `enqueue-by-path task A ${rA.status} (got ${JSON.stringify(rA.json)?.slice(0, 120)})`)
  const taskIdA = rA.json?.taskId
  ok(typeof taskIdA === "number" && rA.json?.status === "pending", `enqueue A returns {taskId, status:'pending'} (got ${JSON.stringify(rA.json)?.slice(0, 140)})`)
  const rB = await enq("raw/sources/heartbeat-note-b.md")
  const taskIdB = rB.json?.taskId
  ok(typeof taskIdB === "number" && taskIdB !== taskIdA, `enqueue B returns its own taskId (got ${JSON.stringify(rB.json)?.slice(0, 120)})`)

  // ── B (pending behind A with concurrency=1) never gets a heartbeat ──────
  {
    await sleep(250) // let several heartbeat intervals elapse while B waits
    const b = await getTask(port, projectUuid, taskIdB)
    ok(b?.status === "pending", `B stays pending while A holds the worker (got ${b?.status})`)
    ok(b?.heartbeat_at == null, `pending task B keeps heartbeat_at null (got ${b?.heartbeat_at})`)
  }

  // ── A: heartbeat appears at claim, then ADVANCES during the slow LLM ────
  await waitFor(async () => (await getTask(port, projectUuid, taskIdA))?.status === "processing", 8000, "task A processing")
  const atClaim = await getTask(port, projectUuid, taskIdA)
  ok(atClaim?.heartbeat_at == null || atClaim?.heartbeat_at > 0, "task A claimed (processing); heartbeat null or already ticking")
  await waitFor(async () => (await getTask(port, projectUuid, taskIdA))?.heartbeat_at != null, 5000, "first A heartbeat")
  const first = (await getTask(port, projectUuid, taskIdA)).heartbeat_at
  await waitFor(async () => (await getTask(port, projectUuid, taskIdA))?.heartbeat_at > first, 5000, "A heartbeat advances")
  // Sample TWICE inside the SAME in-flight LLM call (analysis streams for
  // SLOW_MS=2500ms): the heartbeat keeps updating updated_at while progress
  // itself must not move — the liveness signal, not a progress lie.
  const s1 = await getTask(port, projectUuid, taskIdA)
  await waitFor(async () => (await getTask(port, projectUuid, taskIdA))?.updated_at > s1.updated_at, 5000, "another heartbeat tick while the call is in flight")
  const s2 = await getTask(port, projectUuid, taskIdA)
  ok(s1?.status === "processing" && s2?.status === "processing", `A still processing across heartbeat ticks (got ${s1?.status}/${s2?.status})`)
  ok(s2?.progress === s1?.progress, `progress itself frozen while the LLM call is in flight (${s1?.progress} vs ${s2?.progress})`)
  ok(s2?.updated_at > s1?.updated_at, "updated_at advanced with the heartbeat (liveness, not progress)")

  // ── A completes; heartbeat_at lands > 0 then STOPS advancing ───────────
  await waitFor(async () => (await getTask(port, projectUuid, taskIdA))?.status === "completed", 90000, "task A completed")
  const done = await getTask(port, projectUuid, taskIdA)
  ok(done?.heartbeat_at > 0, `completed A keeps heartbeat_at > 0 (got ${done?.heartbeat_at})`)
  ok(done?.file_path === sourcePath, "task row carries the resolved absolute source path")
  const stable = done.heartbeat_at
  const stableUpdated = done.updated_at
  await sleep(450) // > two 200ms intervals
  const later = await getTask(port, projectUuid, taskIdA)
  ok(later?.heartbeat_at === stable && later?.updated_at === stableUpdated, `heartbeat and updated_at STOP after completion (heartbeat ${later?.heartbeat_at} vs ${stable})`)

  // ── B eventually processes and completes (heartbeat ticks for it too) ───
  await waitFor(async () => (await getTask(port, projectUuid, taskIdB))?.status === "completed", 90000, "task B completed")
  const bDone = await getTask(port, projectUuid, taskIdB)
  ok(bDone?.heartbeat_at > 0, `completed B also carries a heartbeat (got ${bDone?.heartbeat_at})`)

  // ── clean pipeline: exactly two LLM calls (analysis + generation) ───────
  ok(llmHits.length === 4, `exactly 4 pipeline LLM calls for 2 sources (2 per source; got ${llmHits.length})`)
} catch (err) {
  fail++
  console.log("  FAIL- harness error:", err.message)
  console.log("--- server log ---\n" + serverLog.slice(-2000))
} finally {
  child.kill("SIGKILL"); llmMock.close()
}

console.log(`\ningest-heartbeat: ${pass} passed, ${fail} failed (entry: ${ENTRY})`)
process.exit(fail === 0 ? 0 : 1)
