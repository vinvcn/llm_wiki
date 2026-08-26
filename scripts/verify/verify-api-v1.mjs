// External REST API (/api/v1) acceptance harness.
// Verifies the web server speaks the desktop's exact api_server.rs contract:
// auth (incl. the chat-only token gate under allowUnauthenticated), health
// fields, projects/files (+ public-path guard), reviews GET (stable FNV ids,
// sanitize, duplicate merge, query validation), PATCH /reviews/:id and POST
// /reviews/resolve (raw-array write-back preserving unknown fields, partial
// success, exact errors), search (query/topK/queryEmbedding validation +
// envelope), graph, sources/rescan, chat (mock LLM; api_ session, events —
// non-stream vector collects toolStart/referenceAdded/toolEnd/done and no
// messageDelta, runtime.rs sink semantics — error mapping 400/499/502),
// cancel (real bool), 405 + 404 semantics.
//
//   node scripts/verify/verify-api-v1.mjs

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
function req(port, method, p, { body, raw, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw != null ? raw : (body == null ? null : JSON.stringify(body))
    const h = { ...headers }
    if (data != null) { h["Content-Type"] = h["Content-Type"] || "application/json"; h["Content-Length"] = Buffer.byteLength(data) }
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: h }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c))
      res.on("end", () => { try { resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }) } catch { resolve({ status: res.statusCode, raw: buf }) } })
    })
    r.on("error", reject); if (data != null) r.write(data); r.end()
  })
}

// Independent FNV-1a/32 over UTF-16 code units — mirrors the desktop's
// review_id_for_parts so the harness can predict stable review ids.
function expectedReviewId(type, normalizedTitle) {
  const key = `${type}::${normalizedTitle}`
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return `review-${(h >>> 0).toString(16).padStart(8, "0")}`
}

// ── Mock OpenAI-compatible LLM (tool round-trip, then answer) ─────────────
const TOOL_CALL_ID = "call_mock_1"
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

// ── Fake project + isolated store ─────────────────────────────────────────
const TOKEN = "api-test-token"
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-apiv1-"))
const dataDir = path.join(tmp, "data")
const storesDir = path.join(dataDir, "stores")
fs.mkdirSync(storesDir, { recursive: true })
const projectPath = path.join(tmp, "project")
const bareProjectPath = path.join(tmp, "bare-project") // no .llm-wiki at all
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.mkdirSync(path.join(bareProjectPath, "wiki"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n")
fs.writeFileSync(path.join(projectPath, "wiki", "quantum.md"), "---\ntype: entity\ntitle: Quantum\n---\n# Quantum\nQuantum mechanics is the study of matter at atomic scales.\n")
fs.writeFileSync(path.join(bareProjectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n")

// Review fixture: two items that normalize to the SAME stable id (one carries
// an unknown field that must survive write-back), a resolved legacy-id item,
// and two bulk targets.
const FOO_STABLE = expectedReviewId("missing_page", "foo bar")
const LEGACY_STABLE = expectedReviewId("quality", "check q")
const ALPHA_STABLE = expectedReviewId("missing_page", "alpha page")
const reviewFixture = [
  { type: "missing_page", title: "Missing page: Foo Bar", description: "d1", createdAt: 200 },
  { type: "missing_page", title: "foo   bar", affectedPages: ["P1"], internalSecret: "s3cr3t", createdAt: 100 },
  { id: "legacy-1", type: "quality", title: "Check Q", resolved: true, resolvedAction: "Skip", createdAt: 50 },
  { id: "bulk-a", type: "missing_page", title: "Alpha Page", createdAt: 10 },
  { id: "bulk-b", type: "missing_page", title: "Beta Page", createdAt: 20 },
]
fs.mkdirSync(path.join(projectPath, ".llm-wiki"), { recursive: true })
const reviewFile = path.join(projectPath, ".llm-wiki", "review.json")
fs.writeFileSync(reviewFile, JSON.stringify(reviewFixture, null, 2))

const storeFile = path.join(storesDir, "app-state.json")
const storeData = {
  apiConfig: { token: TOKEN },
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
fs.writeFileSync(storeFile, JSON.stringify(storeData, null, 2))

const port = await freePort()
const child = spawn(process.execPath, ["packages/server/src/index.js"], {
  cwd: REPO,
  env: { ...process.env, LLM_WIKI_PORT: String(port), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", (d) => (serverLog += d)); child.stderr.on("data", (d) => (serverLog += d))
const auth = { headers: { "x-llm-wiki-token": TOKEN } }
const api = (method, p, opts = {}) => req(port, method, `/api/v1${p}`, opts)

try {
  await waitFor(async () => (await api("GET", "/health")).status === 200, 15000, "server up")

  // ── health ──────────────────────────────────────────────────────────────
  const health = await api("GET", "/health")
  ok(health.status === 200 && health.json.ok === true, "health 200 ok")
  ok(health.json.status === "ok" && typeof health.json.version === "string", `health status/version (got ${health.json.version})`)
  ok(health.json.agent && health.json.agent.chat === true && health.json.agent.streaming === false, "health agent {chat:true,streaming:false}")
  ok(health.json.authRequired === true && health.json.authConfigured === true && health.json.tokenSource === "store", "health auth fields from shared store")
  ok(health.json.allowLanAccess === false, "health allowLanAccess default false")

  // ── auth ────────────────────────────────────────────────────────────────
  const noTok = await api("GET", "/projects")
  ok(noTok.status === 401 && noTok.json.ok === false && noTok.json.error === "Unauthorized", "401 without token")
  ok((await api("GET", "/projects", { headers: { "x-llm-wiki-token": TOKEN } })).status === 200, "x-llm-wiki-token header accepted")
  ok((await api("GET", "/projects", { headers: { authorization: `Bearer ${TOKEN}` } })).status === 200, "Bearer header accepted")
  ok((await api("GET", `/projects?token=${TOKEN}`)).status === 200, "?token= accepted")

  // ── projects / files ────────────────────────────────────────────────────
  const projects = await api("GET", "/projects", auth)
  ok(projects.json.ok && projects.json.projects.some((p) => p.id === "proj-1") && projects.json.currentProject?.id === "proj-1", "projects list + current")
  const unknown = await api("GET", "/projects/nope/files", auth)
  ok(unknown.status === 404 && unknown.json.error === "Unknown project: nope", `unknown project error (got ${unknown.status} ${unknown.json.error})`)
  const files = await api("GET", "/projects/proj-1/files", auth)
  ok(files.status === 200 && files.json.files.some((f) => f.name === "wiki"), "files lists wiki/")
  const content = await api("GET", "/projects/proj-1/files/content?path=wiki/quantum.md", auth)
  ok(content.status === 200 && content.json.content.includes("Quantum mechanics"), "files/content reads a public page")
  const guarded = await api("GET", `/projects/proj-1/files/content?path=${encodeURIComponent(".llm-wiki/review.json")}`, auth)
  ok(guarded.status === 403, `public-path guard 403 (got ${guarded.status})`)
  // The public-path guard runs BEFORE safe_join (desktop order), so a ".."
  // path is rejected as non-public (403), never reaching the traversal 400.
  const traversal = await api("GET", `/projects/proj-1/files/content?path=${encodeURIComponent("../secret.md")}`, auth)
  ok(traversal.status === 403, `traversal rejected by public guard 403 (got ${traversal.status})`)

  // ── reviews GET: stable ids, sanitize, merge, query ─────────────────────
  const unresolved = await api("GET", "/projects/proj-1/reviews", auth)
  ok(unresolved.status === 200 && unresolved.json.status === "unresolved", "GET reviews default status=unresolved echo")
  const fooItems = unresolved.json.reviews.filter((r) => r.id === FOO_STABLE)
  ok(fooItems.length === 1, `duplicate titles merged under one stable id (got ${fooItems.length}; want ${FOO_STABLE})`)
  const foo = fooItems[0] || {}
  ok(foo.description === "d1" && Array.isArray(foo.affectedPages) && foo.affectedPages[0] === "P1", "merged fields (description + affectedPages)")
  ok(foo.createdAt === 100, `merged createdAt is the min (got ${foo.createdAt})`)
  ok(!("internalSecret" in foo), "sanitized: internalSecret not exposed")
  ok(!unresolved.json.reviews.some((r) => r.id === LEGACY_STABLE), "resolved item excluded from unresolved (by stable id)")
  ok(unresolved.json.count === unresolved.json.reviews.length, "count matches reviews length")
  const pending = await api("GET", "/projects/proj-1/reviews?status=pending", auth)
  ok(pending.status === 200 && pending.json.status === "unresolved", "status=pending normalizes to unresolved")
  const bogus = await api("GET", "/projects/proj-1/reviews?status=bogus", auth)
  ok(bogus.status === 400 && bogus.json.error === "Invalid review status 'bogus'. Expected unresolved, resolved, or all", "invalid status 400 exact message")
  const all = await api("GET", "/projects/proj-1/reviews?status=all", auth)
  const legacy = all.json.reviews.find((r) => r.id === LEGACY_STABLE)
  ok(all.status === 200 && legacy && legacy.resolved === true && legacy.resolvedAction === "Skip", "status=all includes resolved item with action")
  const typed = await api("GET", "/projects/proj-1/reviews?status=all&type=quality", auth)
  ok(typed.json.reviews.length === 1 && typed.json.reviews[0].id === LEGACY_STABLE, "type filter (stable id, raw id hidden)")
  const limited = await api("GET", "/projects/proj-1/reviews?status=all&limit=1", auth)
  ok(limited.json.reviews.length === 1, "limit applied")

  // ── PATCH single review ─────────────────────────────────────────────────
  const patchMissing = await api("PATCH", "/projects/proj-1/reviews/nope-1", { ...auth, body: {} })
  ok(patchMissing.status === 404 && patchMissing.json.error === "Review item 'nope-1' not found", "PATCH unknown id 404 exact message")
  const patchBad = await api("PATCH", `/projects/proj-1/reviews/${FOO_STABLE}`, { ...auth, raw: "not-json" })
  ok(patchBad.status === 400 && String(patchBad.json.error).startsWith("Invalid request body:"), "PATCH invalid JSON 400")
  const patchType = await api("PATCH", `/projects/proj-1/reviews/${FOO_STABLE}`, { ...auth, body: { resolved: "yes" } })
  ok(patchType.status === 400 && String(patchType.json.error).startsWith("Invalid request body:"), "PATCH non-boolean resolved 400")
  const patch1 = await api("PATCH", `/projects/proj-1/reviews/${FOO_STABLE}`, { ...auth, body: { action: "Created page" } })
  ok(patch1.status === 200 && patch1.json.ok && patch1.json.reviewId === FOO_STABLE && patch1.json.resolved === true, "PATCH by stable id resolves (body without resolved defaults to true)")
  let rawItems = JSON.parse(fs.readFileSync(reviewFile, "utf-8"))
  const rawFoo = rawItems.find((it) => it.title === "Missing page: Foo Bar")
  ok(rawFoo && rawFoo.resolved === true && rawFoo.resolvedAction === "Created page" && rawFoo.id === FOO_STABLE, "raw write-back: resolved + action + stable id stamped")
  const rawSecret = rawItems.find((it) => it.title === "foo   bar")
  ok(rawSecret && rawSecret.internalSecret === "s3cr3t", "raw write-back preserves unknown field (internalSecret)")
  const patchReopen = await api("PATCH", "/projects/proj-1/reviews/legacy-1", { ...auth, body: { resolved: false } })
  ok(patchReopen.status === 200 && patchReopen.json.resolved === false, "PATCH reopen resolved:false")
  rawItems = JSON.parse(fs.readFileSync(reviewFile, "utf-8"))
  // PATCH stamps the stable id onto the raw item (desktop does the same), so
  // the raw "legacy-1" id is gone after the write-back.
  const rawLegacy = rawItems.find((it) => it.id === LEGACY_STABLE)
  ok(rawLegacy && rawLegacy.resolved === false && !("resolvedAction" in rawLegacy), "reopen removes resolvedAction on disk")

  // ── bulk resolve ────────────────────────────────────────────────────────
  const bulkBad1 = await api("POST", "/projects/proj-1/reviews/resolve", { ...auth, body: {} })
  ok(bulkBad1.status === 400 && String(bulkBad1.json.error).includes("ids"), "bulk missing ids 400")
  const bulkBad2 = await api("POST", "/projects/proj-1/reviews/resolve", { ...auth, body: { ids: [] } })
  ok(bulkBad2.status === 400 && bulkBad2.json.error === "ids must be a non-empty array", "bulk empty ids 400 exact")
  const bulkBad3 = await api("POST", "/projects/proj-1/reviews/resolve", { ...auth, body: { ids: ["ok", 7] } })
  ok(bulkBad3.status === 400, "bulk non-string id 400")
  const bulk = await api("POST", "/projects/proj-1/reviews/resolve", { ...auth, body: { ids: ["bulk-a", "nope-x", "bulk-b"], action: "Batch" } })
  ok(bulk.status === 200 && bulk.json.ok, "bulk 200 (partial success is not an error)")
  ok(JSON.stringify(bulk.json.resolved) === JSON.stringify(["bulk-a", "bulk-b"]), `bulk resolved preserves input order (got ${JSON.stringify(bulk.json.resolved)})`)
  ok(JSON.stringify(bulk.json.notFound) === JSON.stringify(["nope-x"]) && bulk.json.count === 2, "bulk notFound + count")
  rawItems = JSON.parse(fs.readFileSync(reviewFile, "utf-8"))
  const rawBulkA = rawItems.find((it) => it.id === ALPHA_STABLE)
  ok(rawBulkA && rawBulkA.resolved === true && rawBulkA.resolvedAction === "Batch", "bulk action written to disk")
  const bulkBare = await api("POST", "/projects/proj-2/reviews/resolve", { ...auth, body: { ids: ["x", "y"] } })
  ok(bulkBare.status === 200 && bulkBare.json.resolved.length === 0 && bulkBare.json.notFound.length === 2, "bulk on project without review.json -> all notFound")

  // ── search ──────────────────────────────────────────────────────────────
  const search = await api("POST", "/projects/proj-1/search", { ...auth, body: { query: "quantum" } })
  ok(search.status === 200 && search.json.projectId === "proj-1" && Array.isArray(search.json.results), "search 200 envelope")
  ok(typeof search.json.note === "string" && search.json.note.startsWith("Search uses the shared backend hybrid retrieval service"), "search note matches desktop")
  ok(search.json.results.some((r) => (r.path || "").includes("quantum")), "search finds the quantum page")
  const sNoQuery = await api("POST", "/projects/proj-1/search", { ...auth, body: { query: "   " } })
  ok(sNoQuery.status === 400 && sNoQuery.json.error === "query is required", "search blank query 400 exact")
  const sMissing = await api("POST", "/projects/proj-1/search", { ...auth, body: {} })
  ok(sMissing.status === 400 && String(sMissing.json.error).startsWith("Invalid JSON:"), "search missing query 400")
  const sBadJson = await api("POST", "/projects/proj-1/search", { ...auth, raw: "{nope" })
  ok(sBadJson.status === 400 && String(sBadJson.json.error).startsWith("Invalid JSON:"), "search invalid JSON 400")
  const sEmptyEmb = await api("POST", "/projects/proj-1/search", { ...auth, body: { query: "q", queryEmbedding: [] } })
  ok(sEmptyEmb.status === 400 && sEmptyEmb.json.error === "queryEmbedding must not be empty", "empty queryEmbedding 400 exact")
  const sBadEmb = await api("POST", "/projects/proj-1/search", { ...auth, body: { query: "q", queryEmbedding: [0.1, "x"] } })
  ok(sBadEmb.status === 400 && sBadEmb.json.error === "queryEmbedding must contain only finite numbers", "non-finite queryEmbedding 400 exact")
  const sEmb = await api("POST", "/projects/proj-1/search", { ...auth, body: { query: "quantum", queryEmbedding: [0.1, 0.2] } })
  ok(sEmb.status === 200, "explicit queryEmbedding accepted")

  // ── graph + rescan ──────────────────────────────────────────────────────
  const graph = await api("GET", "/projects/proj-1/graph", auth)
  ok(graph.status === 200 && Array.isArray(graph.json.nodes) && Array.isArray(graph.json.edges), "graph nodes/edges")
  const rescan = await api("POST", "/projects/proj-1/sources/rescan", auth)
  ok(rescan.status === 200 && rescan.json.result && typeof rescan.json.result.queueVersion === "number", "sources/rescan envelope")

  // ── chat (mock LLM) ─────────────────────────────────────────────────────
  const chatNoMsg = await api("POST", "/projects/proj-1/chat", { ...auth, body: {} })
  ok(chatNoMsg.status === 400 && String(chatNoMsg.json.error).startsWith("Invalid JSON:"), "chat missing message 400")
  const chatBlank = await api("POST", "/projects/proj-1/chat", { ...auth, body: { message: "  " } })
  ok(chatBlank.status === 400 && chatBlank.json.error === "message is required", "chat blank message 400 exact")
  const chat = await api("POST", "/projects/proj-1/chat", { ...auth, body: { message: "What does the quantum page say?" } })
  ok(chat.status === 200 && chat.json.ok, "chat 200")
  ok(typeof chat.json.sessionId === "string" && chat.json.sessionId.startsWith("api_"), `chat sessionId api_ prefix (got ${chat.json.sessionId})`)
  ok(chat.json.message?.role === "assistant" && chat.json.message?.content === ANSWER, "chat message content from mock LLM")
  ok(Array.isArray(chat.json.references) && chat.json.references.length >= 1, `chat references from tool round-trip (got ${chat.json.references?.length})`)
  ok(Array.isArray(chat.json.toolEvents) && chat.json.toolEvents.some((t) => t.tool === "wiki.search"), "chat toolEvents include wiki.search")
  const evTypes = new Set((chat.json.events || []).map((e) => e.type))
  // runtime.rs contract: handle_chat runs with event_sink=None, and every
  // final-answer MessageDelta emission is gated on event_sink.is_some(), so
  // the NON-STREAM collected vector carries toolStart/referenceAdded/toolEnd
  // + Done but NOT messageDelta (the SSE stream path carries the deltas).
  ok(evTypes.has("toolStart") && evTypes.has("referenceAdded") && evTypes.has("toolEnd") && evTypes.has("done") && !evTypes.has("messageDelta"), `chat events collected (got ${[...evTypes].join(",")})`)
  ok((chat.json.events || []).every((e) => e.type !== "fileChanged" || !("previousContent" in e)), "fileChanged events redacted (previousContent absent)")
  ok(chat.json.usage && chat.json.usage.referenceCount === chat.json.references.length, "chat usage.referenceCount")
  const cancel = await api("POST", "/projects/proj-1/chat/dead-session/cancel", auth)
  ok(cancel.status === 200 && cancel.json.cancelled === false && cancel.json.sessionId === "dead-session", "cancel returns real bool (false when idle)")

  // ── chat token gate under allowUnauthenticated ──────────────────────────
  writeStore({ apiConfig: { token: TOKEN, allowUnauthenticated: true } })
  await sleep(50)
  const openList = await api("GET", "/projects")
  ok(openList.status === 200, "allowUnauthenticated: non-chat endpoint opens")
  const gatedChat = await api("POST", "/projects/proj-1/chat", { body: { message: "hi" } })
  ok(gatedChat.status === 401, `allowUnauthenticated: chat still requires a token (got ${gatedChat.status})`)
  writeStore({ apiConfig: { token: TOKEN } })

  // ── chat error mapping: dead LLM endpoint -> 502 ────────────────────────
  const deadPort = await freePort()
  writeStore({ llmConfig: { provider: "custom", apiKey: "k", model: "m", customEndpoint: `http://127.0.0.1:${deadPort}/v1`, apiMode: "chat_completions" } })
  await sleep(50)
  const chatDead = await api("POST", "/projects/proj-1/chat", { ...auth, body: { message: "hi" } })
  ok(chatDead.status === 502 && chatDead.json.ok === false, `chat LLM failure maps to 502 (got ${chatDead.status})`)
  writeStore({ llmConfig: storeData.llmConfig })

  // ── method gate + unknown route ─────────────────────────────────────────
  const del = await api("DELETE", "/projects", auth)
  ok(del.status === 405 && del.json.error === "Method not allowed", "405 for non GET/POST/PATCH")
  const nf = await api("GET", "/bogus", auth)
  ok(nf.status === 404 && nf.json.error === "Not found", "404 'Not found' for unknown route")
} catch (e) {
  fail++
  console.log("  FAIL- harness error:", e.message)
  console.log(serverLog.split("\n").slice(-15).join("\n"))
} finally {
  child.kill("SIGKILL")
  mock.close()
}

console.log(`\napi-v1: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
