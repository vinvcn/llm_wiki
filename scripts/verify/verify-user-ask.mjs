// Agent `user.ask` acceptance harness.
//
// Part 1: pure-function fixtures — the desktop Rust #[test]s for
// sanitize_user_input_request (runtime.rs) re-expressed against the Node port
// (packages/server/src/user-input.js).
//
// Part 2: mock-LLM e2e — stands up a tiny in-process OpenAI-compatible LLM,
// points the server's resolved chat config at it (LLM_WIKI_NO_SHARE=1 so
// auto-detect can't grab a real desktop store), and drives both transports:
//   - streaming: model issues user.ask -> SSE userInputRequired + done, turn
//     ENDS (no pause), no tool events recorded for the successful ask; then a
//     stateless resume turn with the user's answers completes normally.
//   - non-stream: BackendAgentResponse.userInputRequest + message=description.
//   - invalid schema: rejected back to the model with the desktop's exact
//     message, the model retries corrected, the turn then ends at the form.
//   - alias tool name (AskUserQuestion + questions[]) is normalized.
//   - the turn is persisted to the shared agent-session store.
//
//   node scripts/verify/verify-user-ask.mjs

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

// ── Part 1: sanitizer fixtures (runtime.rs tests) ─────────────────────────
const U = await import(path.join(REPO, "packages/server/src/user-input.js"))

{
  // agent_loop_action_normalizes_user_ask_alias
  ok(U.isUserAskTool("AskUserQuestion") && U.isUserAskTool("user.ask") && U.isUserAskTool("user_input.ask")
    && U.isUserAskTool("askUserQuestion") && U.isUserAskTool("ask_user_question")
    && U.isUserAskTool(" user.ask ") && !U.isUserAskTool("wiki.search"), "isUserAskTool: all desktop aliases, trimmed")
  const aliasReq = U.sanitizeUserInputRequest({ questions: [{ id: "palette", question: "Palette?", options: [{ label: "Auto", value: "auto" }] }] })
  ok(aliasReq.fields[0].id === "palette" && aliasReq.fields[0].type === "single", "alias: questions[]/question label -> id=palette type=single")
  // Rust Option semantics: fields:null is PRESENT (serde Option<Value>
  // Some(Null)) and fails the array check like the committed unit test pins.
  let nullFieldsThrew = false
  try { U.sanitizeUserInputRequest({ fields: null, questions: [{ id: "q", question: "Q?", options: [{ label: "A", value: "a" }] }] }) } catch (e) { nullFieldsThrew = /fields must be an array/.test(e.message) }
  ok(nullFieldsThrew, "fields:null errors with the desktop message (present-but-null = Some(Null))")

  // user_ask_sanitizes_generic_field_schema
  const generic = U.sanitizeUserInputRequest({
    title: "Cover setup",
    fields: [
      { type: "text", id: "watermark", label: "Watermark", placeholder: "Optional" },
      { type: "multiChoice", id: "channels", label: "Channels", options: [{ label: "Web", value: "web" }, { label: "Print", value: "print" }] },
    ],
  })
  ok(generic.title === "Cover setup" && generic.fields.length === 2
    && generic.fields[0].type === "text" && generic.fields[1].type === "multi"
    && generic.fields[1].options.length === 2, "generic field schema sanitized (multiChoice->multi)")

  // user_ask_drops_unknown_field_types_without_failing_valid_fields
  const dropped = U.sanitizeUserInputRequest({ fields: [{ type: "date", id: "deadline", label: "Deadline" }, { type: "text", id: "topic", label: "Topic" }] })
  ok(dropped.fields.length === 1 && dropped.fields[0].id === "topic" && dropped.fields[0].type === "text", "unknown field type dropped, valid kept")

  // user_ask_deduplicates_field_ids_and_option_values
  const dedup = U.sanitizeUserInputRequest({
    fields: [
      { type: "single", id: "choice", label: "Primary", options: [{ label: "Auto", value: "auto" }, { label: "Auto again", value: "auto" }] },
      { type: "text", id: "choice", label: "Notes" },
    ],
  })
  ok(dedup.fields[0].id === "choice" && dedup.fields[1].id === "choice_2"
    && dedup.fields[0].options[0].value === "auto" && dedup.fields[0].options[1].value === "auto_2", "field ids + option values deduplicated")

  // user_ask_rejects_invalid_choice_defaults / preserves valid ones
  const badDefault = U.sanitizeUserInputRequest({ fields: [{ type: "single", id: "palette", label: "Palette", defaultValue: "missing", options: [{ label: "Auto", value: "auto" }] }] })
  ok(!("defaultValue" in badDefault.fields[0]), "invalid choice default dropped")
  const goodDefault = U.sanitizeUserInputRequest({
    fields: [
      { type: "single", id: "palette", label: "Palette", defaultValue: "auto", options: [{ label: "Auto", value: "auto" }] },
      { type: "multi", id: "channels", label: "Channels", defaultValue: ["web"], options: [{ label: "Web", value: "web" }] },
    ],
  })
  ok(goodDefault.fields[0].defaultValue === "auto" && JSON.stringify(goodDefault.fields[1].defaultValue) === '["web"]', "valid choice defaults preserved")

  // user_ask_empty_or_all_invalid_fields_return_schema_error
  for (const bad of [{ fields: [] }, { fields: [{ type: "date", label: "When?" }] }]) {
    let msg = ""
    try { U.sanitizeUserInputRequest(bad) } catch (e) { msg = e.message }
    ok(msg.includes("at least one valid field"), `empty/all-invalid fields -> "at least one valid field" (got "${msg}")`)
  }

  // missing / non-array fields errors (exact desktop strings)
  let msg = ""
  try { U.sanitizeUserInputRequest({}) } catch (e) { msg = e.message }
  ok(msg === "user.ask requires fields or questions", `missing fields error exact (got "${msg}")`)
  msg = ""
  try { U.sanitizeUserInputRequest({ fields: { a: 1 } }) } catch (e) { msg = e.message }
  ok(msg === "user.ask fields must be an array", `non-array fields error exact (got "${msg}")`)

  // title/description cleaning + fallbacks
  const cleaned = U.sanitizeUserInputRequest({ title: "<b>Cover</b>\n", description: "  Pick <one>  ", fields: [{ type: "text", id: "a", label: "A" }] })
  ok(cleaned.title === "bCover/b" && cleaned.description === "Pick one", "angle brackets stripped, text trimmed")
  const fallbacks = U.sanitizeUserInputRequest({ fields: [{ type: "text", id: "a", label: "A" }] })
  ok(fallbacks.title === "Input required", `title fallback "Input required" (got "${fallbacks.title}")`)
  ok(fallbacks.description === "Please provide the requested information so the Agent can continue.", "description fallback (sanitizer wording)")
  ok(U.userAskAnswer({ requestId: "x", title: "t", fields: [] }) === "Please provide the requested information to continue.", "turn-answer fallback (runtime wording)")

  // requestId: uuid + unique
  const a = U.sanitizeUserInputRequest({ fields: [{ type: "text", id: "a", label: "A" }] })
  const b = U.sanitizeUserInputRequest({ fields: [{ type: "text", id: "a", label: "A" }] })
  ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a.requestId) && a.requestId !== b.requestId, "requestId is a fresh UUID each call")

  // caps: 12 fields / 8 options (MAX_USER_INPUT_FIELDS / MAX_USER_INPUT_OPTIONS)
  const manyFields = U.sanitizeUserInputRequest({ fields: Array.from({ length: 13 }, (_, i) => ({ type: "text", id: `f${i}`, label: `F${i}` })) })
  ok(manyFields.fields.length === 12, "fields capped at 12")
  const manyOptions = U.sanitizeUserInputRequest({ fields: [{ type: "single", id: "c", label: "C", options: Array.from({ length: 9 }, (_, i) => ({ label: `O${i}`, value: `o${i}` })) }] })
  ok(manyOptions.fields[0].options.length === 8, "options capped at 8")

  // id cleaning + option value fallback + recommended passthrough
  const misc = U.sanitizeUserInputRequest({ fields: [
    { type: "confirm", id: "my id!@#", label: "Go?", defaultValue: true },
    { type: "single", label: "No id", options: [{ title: "Only title", recommended: true }] },
  ] })
  ok(misc.fields[0].id === "myid" && misc.fields[0].type === "confirm" && misc.fields[0].defaultValue === true, "id cleaned to ascii, confirm+bool default kept")
  ok(misc.fields[1].id === "field_2" && misc.fields[1].options[0].label === "Only title"
    && misc.fields[1].options[0].value === "Only title" && misc.fields[1].options[0].recommended === true, "default field id, option value falls back to label, recommended kept")

  // text caps (MAX_USER_INPUT_TEXT_CHARS=400)
  const longText = U.sanitizeUserInputRequest({ title: "x".repeat(500), fields: [{ type: "text", id: "a", label: "A" }] })
  ok(longText.title.length === 400, "title capped at 400 chars")
}

// ── Part 2: mock-LLM e2e ───────────────────────────────────────────────────
function freePort() { return new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) }) }
async function waitFor(fn, t, what) { const s = Date.now(); while (Date.now() - s < t) { try { if (await fn()) return true } catch {} await sleep(80) } throw new Error("timeout: " + what) }
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

const ASK_TITLE = "Cover setup"
const ASK_DESCRIPTION = "Choose the cover style before generation."
const validAskArgs = {
  title: ASK_TITLE,
  description: ASK_DESCRIPTION,
  fields: [
    { id: "style", type: "single", label: "Style", options: [{ label: "Auto", value: "auto", recommended: true }, { label: "Manual", value: "manual" }] },
    { id: "notes", type: "text", label: "Notes", placeholder: "Optional" },
  ],
}

function sseToolCall(res, id, name, args, stream) {
  if (stream) {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    const chunk = (delta, finish) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`
    res.write(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] }))
    res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }))
    res.write(chunk({}, "tool_calls"))
    res.end("data: [DONE]\n\n")
  } else {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] }))
  }
}
function sseFinal(res, answer, stream) {
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

function mockHandler(reqBody, res) {
  const messages = reqBody.messages ?? []
  const stream = !!reqBody.stream
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? ""
  const lastTool = [...messages].reverse().find((m) => m.role === "tool")
  if (lastTool && typeof lastTool.content === "string" && lastTool.content.startsWith("rejected:")) {
    // Model retries with a corrected schema after the rejection observation.
    return sseToolCall(res, "call_ask_retry", "user.ask", { ...validAskArgs, description: "Corrected: choose the cover style." }, stream)
  }
  if (typeof lastUser === "string" && lastUser.startsWith("User provided answers")) {
    return sseFinal(res, "Thanks! Generating the cover with your choices.", stream)
  }
  if (typeof lastUser === "string" && lastUser.includes("SCENARIO_REJECT")) {
    return sseToolCall(res, "call_ask_bad", "user.ask", { title: "Broken", fields: [] }, stream)
  }
  if (typeof lastUser === "string" && lastUser.includes("SCENARIO_ALIAS")) {
    return sseToolCall(res, "call_ask_alias", "AskUserQuestion", { title: "Palette", questions: [{ id: "palette", question: "Palette?", options: [{ label: "Auto", value: "auto" }] }] }, stream)
  }
  return sseToolCall(res, "call_ask_1", "user.ask", validAskArgs, stream)
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-userask-"))
const dataDir = path.join(tmp, "data")
const storesDir = path.join(dataDir, "stores")
fs.mkdirSync(storesDir, { recursive: true })
const projectPath = path.join(tmp, "project")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n")
fs.writeFileSync(path.join(storesDir, "app-state.json"), JSON.stringify({
  llmConfig: { provider: "custom", apiKey: "test-key", model: "mock-model", customEndpoint: `http://127.0.0.1:${mockPort}/v1`, apiMode: "chat_completions" },
  projectRegistry: { "proj-1": { id: "proj-1", path: projectPath, name: "project" } },
  lastProject: { id: "proj-1", path: projectPath },
}, null, 2))

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

  // ── STREAM: user.ask ends the turn with userInputRequired + done ─────────
  const streamSession = "sess-ask-stream"
  {
    const sse = sseCollect()
    await sleep(200)
    const runId = "run-ask-stream"
    const r = await req(port, "POST", "/api/invoke/agent_start_turn_stream", {
      projectId: "proj-1",
      request: { sessionId: streamSession, runId, message: "Make me a cover image", history: [], mode: "standard", tools: {}, topK: 5 },
    })
    ok(r.status === 200 && r.json === runId, "stream: agent_start_turn_stream returned runId")
    await waitFor(async () => sse.events.some((e) => e.event === "agent-event" && e.payload?.runId === runId && e.payload?.event?.type === "done"), 10000, "stream done")
    const evs = sse.events.filter((e) => e.event === "agent-event" && e.payload?.runId === runId).map((e) => e.payload.event)
    const iAsk = evs.findIndex((e) => e.type === "userInputRequired")
    const iDone = evs.findIndex((e) => e.type === "done")
    ok(iAsk >= 0, "stream: userInputRequired emitted")
    ok(iDone > iAsk, "stream: done follows userInputRequired (turn ends, no pause)")
    ok(evs[iDone]?.text === ASK_DESCRIPTION, `stream: done text is the ask description (got ${JSON.stringify(evs[iDone]?.text)})`)
    ok(!evs.some((e) => (e.type === "toolStart" || e.type === "toolEnd") && e.tool === "user.ask"), "stream: no toolStart/toolEnd recorded for a successful user.ask (desktop records none)")
    const form = evs[iAsk]?.request
    ok(!!form && /^[0-9a-f-]{36}$/i.test(form.requestId ?? ""), "stream: request.requestId is a UUID")
    ok(form?.title === ASK_TITLE, "stream: request.title sanitized")
    ok(Array.isArray(form?.fields) && form.fields.length === 2, "stream: request.fields sanitized (2 fields)")
    ok(form?.fields?.[0]?.type === "single" && form.fields[0].options?.length === 2 && form.fields[0].options[0].recommended === true, "stream: single-choice field with recommended option")
    ok(form?.fields?.[1]?.type === "text" && form.fields[1].placeholder === "Optional", "stream: text field keeps placeholder")
    sse.close()

    // Desktop parity (runtime.rs + agent-user-input.test.js): a turn stopping
    // at user.ask persists NO assistant scaffold row — the description is UI
    // scaffolding, and the CLIENT appends it to its own history for the resume
    // turn (as the stateless resume below does). The shared agent-sessions
    // file must NOT carry the description as an assistant message.
    await sleep(1200)
    const dir = path.join(projectPath, ".llm-wiki", "agent-sessions")
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : []
    const leaked = files.filter((f) => fs.readFileSync(path.join(dir, f), "utf-8").includes(ASK_DESCRIPTION))
    ok(leaked.length === 0, "stream: user.ask boundary persists no assistant scaffold row in agent-sessions")
  }

  // ── stateless resume: frontend sends the answers as a new turn ───────────
  {
    const r = await req(port, "POST", "/api/invoke/agent_start_turn", {
      projectId: "proj-1",
      request: {
        sessionId: streamSession, runId: "run-ask-resume",
        message: 'User provided answers for "Cover setup".\n\n- Style (style): auto\n- Notes (notes): (empty)\n\nContinue the previous task using these answers.',
        history: [
          { role: "user", content: "Make me a cover image" },
          { role: "assistant", content: ASK_DESCRIPTION },
        ],
        historyExplicit: true, mode: "standard", tools: {}, topK: 5,
      },
    })
    ok(r.status === 200 && /cover with your choices/i.test(r.json?.message ?? ""), `resume turn completes normally (got ${JSON.stringify(r.json?.message)})`)
    ok(!r.json?.userInputRequest, "resume turn carries no userInputRequest")
  }

  // ── NON-STREAM: BackendAgentResponse.userInputRequest ────────────────────
  {
    const r = await req(port, "POST", "/api/invoke/agent_start_turn", {
      projectId: "proj-1",
      request: { sessionId: "sess-ask-ns", runId: "run-ask-ns", message: "Make me a cover image", history: [], mode: "standard", tools: {}, topK: 5 },
    })
    const b = r.json
    ok(r.status === 200, "non-stream: 200")
    ok(b?.message === ASK_DESCRIPTION, `non-stream: message is the ask description (got ${JSON.stringify(b?.message)})`)
    ok(!!b?.userInputRequest && b.userInputRequest.title === ASK_TITLE && b.userInputRequest.fields?.length === 2, "non-stream: userInputRequest present + sanitized")
    ok(Array.isArray(b?.toolEvents) && !b.toolEvents.some((t) => t.tool === "user.ask"), "non-stream: no user.ask tool event recorded on success")
    ok(Array.isArray(b?.events) && b.events.some((e) => e.type === "userInputRequired" && e.request?.title === ASK_TITLE), "non-stream: events[] carries userInputRequired")
  }

  // ── invalid schema: rejected to the model, corrected retry ends at form ──
  {
    const r = await req(port, "POST", "/api/invoke/agent_start_turn", {
      projectId: "proj-1",
      request: { sessionId: "sess-ask-reject", runId: "run-ask-reject", message: "SCENARIO_REJECT", history: [], mode: "standard", tools: {}, topK: 5 },
    })
    const b = r.json
    const failedEv = b?.toolEvents?.find((t) => t.tool === "user.ask" && t.status === "failed")
    ok(!!failedEv && failedEv.detail.includes("at least one valid field") && failedEv.detail.endsWith("Return a corrected user.ask schema or answer without asking."), `rejection: failed tool event with desktop message (got ${JSON.stringify(failedEv?.detail)})`)
    ok(b?.events?.some((e) => e.type === "toolEnd" && e.tool === "user.ask" && typeof e.output === "string" && e.output.startsWith("rejected: ")), "rejection: toolEnd 'rejected: …' event emitted (no toolStart, desktop parity)")
    ok(!!b?.userInputRequest && b.userInputRequest.description === "Corrected: choose the cover style.", "rejection: corrected retry ends the turn at the form")
  }

  // ── alias tool name normalized (AskUserQuestion + questions[]) ───────────
  {
    const r = await req(port, "POST", "/api/invoke/agent_start_turn", {
      projectId: "proj-1",
      request: { sessionId: "sess-ask-alias", runId: "run-ask-alias", message: "SCENARIO_ALIAS", history: [], mode: "standard", tools: {}, topK: 5 },
    })
    const form = r.json?.userInputRequest
    ok(!!form && form.title === "Palette" && form.fields?.[0]?.id === "palette" && form.fields[0].type === "single", `alias: AskUserQuestion normalized to user.ask (got ${JSON.stringify(form?.fields?.[0])})`)
  }
} catch (err) {
  fail++
  console.log("  FAIL- harness error:", err.message)
  console.log("--- server log ---\n" + serverLog.slice(-2000))
} finally {
  child.kill("SIGKILL"); mock.close()
}

console.log(`\nuser-ask: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
