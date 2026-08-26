// Agent runtime acceptance harness (recreated; /tmp is volatile).
// Stands up a tiny in-process mock OpenAI-compatible LLM, points the server's
// resolved chat config at it (LLM_WIKI_NO_SHARE=1 so auto-detect can't grab a
// real desktop store), and drives both agent_start_turn (non-stream) and
// agent_start_turn_stream (SSE), asserting:
//   - exact SSE event sequence: toolStart -> referenceAdded -> toolEnd
//     -> messageDelta -> done
//   - the non-stream BackendAgentResponse shape
//   - cancel returns cleanly
//   - unknown-project error
//
//   node /tmp/verify-agent.mjs

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

// ── Mock OpenAI-compatible LLM ────────────────────────────────────────────
// Turn 1 (no tool result yet): emit a wiki.search tool call.
// Turn 2 (tool result present): emit the final assistant answer.
const TOOL_CALL_ID = "call_mock_1"
function wantsTool(messages) { return !messages.some((m) => m.role === "tool") }

function mockHandler(reqBody, res) {
  const messages = reqBody.messages ?? []
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

const mockPort = await freePort()
const mock = http.createServer((rq, rs) => {
  let buf = ""
  rq.on("data", (c) => (buf += c))
  rq.on("end", () => {
    if (rq.method === "POST" && rq.url.includes("/chat/completions")) {
      try { mockHandler(JSON.parse(buf), rs) } catch (e) { rs.writeHead(500); rs.end(String(e)) }
    } else { rs.writeHead(404); rs.end("nope") }
  })
})
await new Promise((r) => mock.listen(mockPort, r))

// ── Fake project + isolated store ─────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-agent-"))
const dataDir = path.join(tmp, "data")
const storesDir = path.join(dataDir, "stores")
fs.mkdirSync(storesDir, { recursive: true })
const projectPath = path.join(tmp, "project")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n")
fs.writeFileSync(path.join(projectPath, "wiki", "quantum.md"), "---\ntype: entity\ntitle: Quantum\n---\n# Quantum\nQuantum mechanics is the study of matter at atomic scales.\n")

const storeData = {
  llmConfig: { provider: "custom", apiKey: "test-key", model: "mock-model", customEndpoint: `http://127.0.0.1:${mockPort}/v1`, apiMode: "chat_completions" },
  projectRegistry: { "proj-1": { id: "proj-1", path: projectPath, name: "project" } },
  lastProject: { id: "proj-1", path: projectPath },
}
fs.writeFileSync(path.join(storesDir, "app-state.json"), JSON.stringify(storeData, null, 2))

const port = await freePort()
const child = spawn(process.execPath, ["packages/server/src/index.js"], {
  cwd: REPO,
  env: { ...process.env, LLM_WIKI_PORT: String(port), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", (d) => (serverLog += d)); child.stderr.on("data", (d) => (serverLog += d))

function sseCollect() {
  const events = []
  const rq = http.request({ host: "127.0.0.1", port, path: "/api/events", method: "GET" }, (res) => {
    let buf = ""
    res.on("data", (c) => {
      buf += c.toString(); let idx
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2)
        for (const line of block.split("\n")) if (line.startsWith("data:")) { try { events.push(JSON.parse(line.slice(5).trim())) } catch {} }
      }
    })
  })
  rq.on("error", () => {}); rq.end()
  return { events, close: () => rq.destroy() }
}

try {
  await waitFor(async () => (await req(port, "GET", "/api/health")).status === 200, 8000, "server health")
  console.log("server up on", port, "| mock LLM on", mockPort)

  // ── STREAM path ──────────────────────────────────────────────────────────
  {
    const sse = sseCollect()
    await sleep(200)
    const runId = "run-stream-1"
    const sessionId = "sess-stream-1"
    const r = await req(port, "POST", "/api/invoke/agent_start_turn_stream", {
      projectId: "proj-1",
      request: { sessionId, runId, message: "What does the quantum page say?", history: [], mode: "standard", tools: {}, topK: 5 },
    })
    ok(r.status === 200 && r.json === runId, `agent_start_turn_stream returned runId (got ${JSON.stringify(r.json)})`)
    await waitFor(async () => sse.events.some((e) => e.event === "agent-event" && e.payload?.event?.type === "done" && e.payload?.runId === runId), 10000, "stream done event")
    const evs = sse.events.filter((e) => e.event === "agent-event" && e.payload?.runId === runId).map((e) => e.payload.event)
    const types = evs.map((e) => e.type)
    // Assert the exact ordered sequence of distinct phase markers.
    const iStart = types.indexOf("toolStart")
    const iRef = types.indexOf("referenceAdded")
    const iEnd = types.indexOf("toolEnd")
    const iDelta = types.indexOf("messageDelta")
    const iDone = types.indexOf("done")
    ok(evs[iStart]?.tool === "wiki.search", `toolStart is wiki.search (got ${evs[iStart]?.tool})`)
    ok(iStart >= 0 && iRef > iStart, "referenceAdded follows toolStart")
    ok(evs[iRef]?.reference?.kind === "wiki", `referenceAdded carries a wiki reference (got ${evs[iRef]?.reference?.kind})`)
    ok(iEnd > iRef, "toolEnd follows referenceAdded")
    ok(iDelta > iEnd, "messageDelta follows toolEnd")
    ok(iDone > iDelta, "done follows messageDelta")
    ok(typeof evs[iDone]?.text === "string" && /quantum/i.test(evs[iDone].text), "done carries final text mentioning quantum")
    ok(Array.isArray(evs[iDone]?.references) && evs[iDone].references.length >= 1, "done carries references[]")
    sse.close()
  }

  // ── NON-STREAM path ──────────────────────────────────────────────────────
  {
    const r = await req(port, "POST", "/api/invoke/agent_start_turn", {
      projectId: "proj-1",
      request: { sessionId: "sess-ns-1", runId: "run-ns-1", message: "What does the quantum page say?", history: [], mode: "standard", tools: {}, topK: 5 },
    })
    const b = r.json
    ok(r.status === 200, "agent_start_turn returned 200")
    ok(b?.sessionId === "sess-ns-1", `BackendAgentResponse.sessionId (got ${b?.sessionId})`)
    ok(b?.mode === "standard", `BackendAgentResponse.mode (got ${b?.mode})`)
    ok(typeof b?.message === "string" && /quantum/i.test(b.message), "BackendAgentResponse.message is the final answer")
    ok(Array.isArray(b?.references) && b.references.length >= 1 && b.references[0].kind === "wiki", "BackendAgentResponse.references[] with wiki ref")
    ok(Array.isArray(b?.toolEvents) && b.toolEvents.some((t) => t.tool === "wiki.search" && t.status === "completed"), "BackendAgentResponse.toolEvents has completed wiki.search")
  }

  // ── UNKNOWN PROJECT error ────────────────────────────────────────────────
  {
    const r = await req(port, "POST", "/api/invoke/agent_start_turn", {
      projectId: "does-not-exist",
      request: { sessionId: "s", runId: "r", message: "hi", history: [], mode: "standard", tools: {} },
    })
    ok(r.status === 500 && /Unknown project: does-not-exist/.test(r.json?.error ?? ""), `unknown-project errors (got ${r.status} ${JSON.stringify(r.json?.error)})`)
  }

  // ── CANCEL returns cleanly ───────────────────────────────────────────────
  {
    const r = await req(port, "POST", "/api/invoke/agent_cancel_turn", { runId: "no-such-run" })
    ok(r.status === 200, "agent_cancel_turn returns 200 even for unknown run")
  }
} catch (err) {
  fail++
  console.log("  FAIL- harness error:", err.message)
  console.log("--- server log ---\n" + serverLog.slice(-2000))
} finally {
  child.kill("SIGKILL"); mock.close()
}

console.log(`\nagent: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
