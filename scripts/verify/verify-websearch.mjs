// Web-search provider acceptance harness (recreated; the RUNBOOK documents it
// as a standing-gate target). Verifies the desktop's full provider contract
// over the LIVE server:
//   - command e2e via /api/invoke/web_search against local mock services for
//     the configurable-URL providers (SearXNG, Ollama, key-free Firecrawl):
//     exact wire shapes (SearXNG q/format/categories, Ollama POST
//     /api/web_search + Bearer + {query,max_results}, Firecrawl POST /v2/search
//     {query,limit}), WebSearchConfig.resolved() per-provider overrides,
//     web_search_result_limit clamping (1..20, bocha 1..50 is unit-pinned),
//     normalize_web_result field fallbacks, empty-query short-circuit, and
//     the exact error strings (missing-key, HTTP status + trimmed body,
//     invalid JSON, Firecrawl success:false + blocked-IP hint).
//   - agent e2e: the web.search tool picks config up from the SHARED store's
//     searchApiConfig (the desktop key), emits web references, is gated by
//     request.tools.web in the offered tool specs, and an out-of-band store
//     edit (searxng -> ollama) is honored on the next turn with NO restart.
//
//   node scripts/verify/verify-websearch.mjs
//
// SERVER_ENTRY=packages/server/src/index.js (default) | index-v2.js re-runs
// the whole contract against the unified v2 server.

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http from "node:http"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const SERVER_ENTRY = process.env.SERVER_ENTRY || "packages/server/src/index.js"
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log("  ok  -", m) } else { fail++; console.log("  FAIL-", m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// command business errors: legacy bridge -> 500, index-v2 -> 400 (VALIDATION_ERROR)
const isErr = (r) => r.status === 500 || r.status === 400
const errText = (r) => {
  const e = r?.json?.error
  return typeof e === "string" ? e : (e && typeof e === "object" ? (e.message ?? "") : "")
}
function freePort() { return new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) }) }
async function waitFor(fn, t, what) { const s = Date.now(); while (Date.now() - s < t) { try { if (await fn()) return true } catch {} await sleep(80) } throw new Error(`timeout waiting for ${what}`) }
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body)
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c))
      res.on("end", () => {
        try {
          const parsed = buf ? JSON.parse(buf) : null
          // index-v2.js wraps command results in { ok: true, result }; the
          // legacy bridge returns the raw result. Unwrap so one assertion set
          // covers both entries (errors keep their { error } shape).
          const json = parsed && typeof parsed === "object" && !Array.isArray(parsed) && "result" in parsed ? parsed.result : parsed
          resolve({ status: res.statusCode, json })
        } catch { resolve({ status: res.statusCode, raw: buf }) }
      })
    })
    r.on("error", reject); if (data) r.write(data); r.end()
  })
}

// ── Local mock services for the configurable-URL providers ────────────────
function startJsonServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((rq, rs) => {
      let buf = ""; rq.on("data", (c) => (buf += c))
      rq.on("end", async () => {
        try {
          const payload = { method: rq.method, url: rq.url, headers: rq.headers, body: buf ? JSON.parse(buf) : undefined }
          const out = await handler(payload)
          if (out.raw !== undefined) { rs.writeHead(out.status ?? 200, { "Content-Type": "text/plain" }); rs.end(out.raw); return }
          rs.writeHead(out.status ?? 200, { "Content-Type": "application/json" })
          rs.end(JSON.stringify(out.body ?? {}))
        } catch {
          rs.writeHead(500, { "Content-Type": "text/plain" }); rs.end("mock boom")
        }
      })
    })
    srv.listen(0, "127.0.0.1", () => resolve(srv))
  })
}
const stopServer = (srv) => new Promise((r) => srv.close(() => r()))

const searxngHits = []
const searxngMock = await startJsonServer((p) => {
  searxngHits.push(p)
  if (p.url.includes("q=err500")) return { status: 500, body: { error: "internal" } }
  if (p.url.includes("q=badjson")) return { status: 200, raw: "{not json" }
  const results = Array.from({ length: 25 }, (_, i) => ({
    title: `searxng hit ${i + 1}`, url: `https://example.com/${i + 1}`,
    snippet: `snippet ${i + 1}`, engine: "mock",
  }))
  results.unshift({ metadata: { title: "meta title", sourceURL: "https://meta.example/x", description: "meta desc" } })
  return { status: 200, body: { results } }
})
const searxngUrl = `http://127.0.0.1:${searxngMock.address().port}`
// A second mock to prove the providerConfigs override routes elsewhere.
const searxngMockB = await startJsonServer((p) => {
  searxngHits.push({ ...p, _override: true })
  return { status: 200, body: { results: [{ title: "override hit", url: "https://override.example/x", snippet: "via providerConfigs" }] } }
})
const searxngUrlB = `http://127.0.0.1:${searxngMockB.address().port}`

const ollamaHits = []
const ollamaMock = await startJsonServer((p) => {
  ollamaHits.push(p)
  return { status: 200, body: { results: [{ title: "ollama hit", url: "https://ollama.example/x", snippet: "ollama snippet", extra: "ignored" }] } }
})
const ollamaUrl = `http://127.0.0.1:${ollamaMock.address().port}`

const firecrawlHits = []
const firecrawlMock = await startJsonServer((p) => {
  firecrawlHits.push(p)
  const q = p.body?.query ?? ""
  if (q === "blocked") {
    return { status: 200, body: { success: false, error: "Your IP address looks suspicious" } }
  }
  if (q === "plainfail") return { status: 200, body: { success: false } }
  return {
    status: 200,
    body: {
      success: true,
      data: [{ title: "fc a", url: "https://fc.example/a", content: "fc content a" },
             { id: "b" }], // id-only item -> url empty -> filtered by the command
    },
  }
})
const firecrawlUrl = `http://127.0.0.1:${firecrawlMock.address().port}`

// ── Mock OpenAI-compatible LLM (for the agent e2e) ────────────────────────
let llmRequests = []
function mockLlmHandler(reqBody, res) {
  llmRequests.push(reqBody)
  const offered = (reqBody.tools ?? []).map((t) => t?.function?.name)
  const messages = reqBody.messages ?? []
  const wantsTool = !messages.some((m) => m.role === "tool")
  if (wantsTool && offered.includes("web.search")) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_web_1", type: "function", function: { name: "web.search", arguments: JSON.stringify({ query: "hello world", max_results: 5 }) } }] } }] }))
  } else {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "The web search found results for you." } }] }))
  }
}
const llmPort = await freePort()
const llmMock = http.createServer((rq, rs) => {
  let buf = ""; rq.on("data", (c) => (buf += c))
  rq.on("end", () => {
    if (rq.method === "POST" && rq.url.includes("/chat/completions")) { try { mockLlmHandler(JSON.parse(buf), rs) } catch (e) { rs.writeHead(500); rs.end(String(e)) } }
    else { rs.writeHead(404); rs.end("nope") }
  })
})
await new Promise((r) => llmMock.listen(llmPort, r))

// ── Isolated server + shared-store wiring (one backend, shared user data) ─
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-websearch-"))
const dataDir = path.join(tmp, "data")
const storesDir = path.join(dataDir, "stores")
fs.mkdirSync(storesDir, { recursive: true })
const projectPath = path.join(tmp, "project")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n")

const storeFile = path.join(storesDir, "app-state.json")
const writeStore = (searchApiConfig) => fs.writeFileSync(storeFile, JSON.stringify({
  llmConfig: { provider: "custom", apiKey: "test-key", model: "mock-model", customEndpoint: `http://127.0.0.1:${llmPort}/v1`, apiMode: "chat_completions" },
  projectRegistry: { "proj-1": { id: "proj-1", path: projectPath, name: "project" } },
  lastProject: { id: "proj-1", path: projectPath },
  searchApiConfig,
}, null, 2))
writeStore({ provider: "searxng", searXngUrl: searxngUrl })

const port = await freePort()
const child = spawn(process.execPath, [SERVER_ENTRY], {
  cwd: REPO,
  env: { ...process.env, LLM_WIKI_PORT: String(port), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir, LLM_WIKI_AUTH_MODE: "none" },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", (d) => (serverLog += d)); child.stderr.on("data", (d) => (serverLog += d))

try {
  await waitFor(async () => (await req(port, "GET", "/api/health")).status === 200, 8000, "server health")
  console.log(`server up on ${port} (${SERVER_ENTRY}) | mock searxng:${searxngMock.address().port} ollama:${ollamaMock.address().port} firecrawl:${firecrawlMock.address().port} llm:${llmPort}`)

  { // ── command e2e: SearXNG happy path + wire contract ──
    searxngHits.length = 0
    const r = await req(port, "POST", "/api/invoke/web_search", {
      query: "hello world", config: { provider: "searxng", searXngUrl: searxngUrl }, maxResults: 5,
    })
    ok(r.status === 200 && Array.isArray(r.json) && r.json.length === 5, `searxng happy path: 5 results (got ${r.status} n=${r.json?.length})`)
    const hit = searxngHits[0]
    ok(hit?.method === "GET" && hit?.url === `/search?q=hello+world&format=json&categories=general`, `searxng request shape exact (got ${JSON.stringify(hit?.url)})`)
    ok(hit?.headers?.accept === "application/json", "searxng Accept: application/json")
    const [a, b] = r.json ?? []
    ok(a?.title === "meta title" && a?.url === "https://meta.example/x" && a?.snippet === "meta desc" && a?.source === "meta.example", "normalize_web_result metadata fallbacks (metadata.title/sourceURL/description)")
    ok(b?.title === "searxng hit 1" && b?.url === "https://example.com/1" && b?.snippet === "snippet 1" && b?.source === "example.com", "searxng result normalized (title/url/snippet/source=hostname)")
  }

  // ── limit clamp (1..20 for non-bocha) ──────────────────────────────────
  {
    searxngHits.length = 0
    const r = await req(port, "POST", "/api/invoke/web_search", {
      query: "many", config: { provider: "searxng", searXngUrl: searxngUrl }, maxResults: 200,
    })
    ok(r.json?.length === 20, `web_search_result_limit caps non-bocha at 20 (got ${r.json?.length})`)
  }

  // ── WebSearchConfig.resolved(): providerConfigs override wins ───────────
  {
    searxngHits.length = 0
    const overrideBody = { query: "override", config: { provider: "searxng", searXngUrl: searxngUrl, providerConfigs: { searxng: { searXngUrl: searxngUrlB, searXngCategories: ["science"] } } }, maxResults: 2 }
    const r = await req(port, "POST", "/api/invoke/web_search", overrideBody)
    const hitB = searxngHits.find((h) => h._override)
    ok(!!hitB && hitB?.url === `/search?q=override&format=json&categories=science`, `resolved() per-provider override routes to the override URL + categories (got ${hitB?.url})`)
    ok(r.json?.[0]?.title === "override hit" && r.json?.length === 1, "override provider results come back")
  }

  // ── empty query short-circuit (no traffic) ──────────────────────────────
  {
    searxngHits.length = 0
    const r = await req(port, "POST", "/api/invoke/web_search", { query: "   ", config: { provider: "searxng", searXngUrl: searxngUrl } })
    ok(Array.isArray(r.json) && r.json.length === 0 && searxngHits.length === 0, "empty query -> [] with zero provider traffic")
  }

  // ── searxng error semantics ─────────────────────────────────────────────
  {
    const r500 = await req(port, "POST", "/api/invoke/web_search", { query: "err500", config: { provider: "searxng", searXngUrl: searxngUrl } })
    ok(isErr(r500) && errText(r500).startsWith("SearXNG search failed (500): "), `searxng HTTP status -> 'SearXNG search failed (500): …' (got ${errText(r500).slice(0, 60)})`)
    const rBad = await req(port, "POST", "/api/invoke/web_search", { query: "badjson", config: { provider: "searxng", searXngUrl: searxngUrl } })
    ok(isErr(rBad) && errText(rBad).startsWith("SearXNG returned invalid JSON: "), `searxng invalid JSON -> exact error (got ${errText(rBad).slice(0, 60)})`)
    const rNoUrl = await req(port, "POST", "/api/invoke/web_search", { query: "x", config: { provider: "searxng" } })
    ok(isErr(rNoUrl) && errText(rNoUrl) === "SearXNG URL is required for web.search", `missing searxngUrl -> exact error (got ${JSON.stringify(errText(rNoUrl))})`)
  }

  // ── command e2e: Ollama ─────────────────────────────────────────────────
  {
    ollamaHits.length = 0
    const r = await req(port, "POST", "/api/invoke/web_search", {
      query: "ollama q", config: { provider: "ollama", apiKey: "sk-o", ollamaUrl }, maxResults: 3,
    })
    const hit = ollamaHits[0]
    ok(hit?.method === "POST" && hit?.url === "/api/web_search", `ollama posts to /api/web_search (got ${hit?.method} ${hit?.url})`)
    ok(hit?.headers?.authorization === "Bearer sk-o" && hit?.headers?.["content-type"]?.includes("application/json"), "ollama Bearer auth + JSON content type")
    ok(hit?.body?.query === "ollama q" && hit?.body?.max_results === 3, `ollama body {query, max_results} (got ${JSON.stringify(hit?.body)})`)
    ok(r.json?.[0]?.title === "ollama hit" && r.json?.[0]?.source === "ollama.example", "ollama result normalized")
    const rNoKey = await req(port, "POST", "/api/invoke/web_search", { query: "x", config: { provider: "ollama", ollamaUrl } })
    ok(isErr(rNoKey) && errText(rNoKey) === "Ollama web.search requires an API key in Settings.", `ollama missing key -> exact error (got ${JSON.stringify(errText(rNoKey))})`)
  }

  // ── command e2e: key-free Firecrawl + success:false handling ───────────
  {
    firecrawlHits.length = 0
    const r = await req(port, "POST", "/api/invoke/web_search", {
      query: "fc q", config: { provider: "firecrawl", providerConfigs: { firecrawl: { baseUrl: firecrawlUrl } } }, maxResults: 4,
    })
    const hit = firecrawlHits[0]
    ok(hit?.method === "POST" && hit?.url === "/v2/search", `firecrawl posts to {base}/v2/search (got ${hit?.url})`)
    ok(hit?.body?.query === "fc q" && hit?.body?.limit === 4 && !("Authorization" in (hit?.headers ?? {})), "firecrawl key-free: {query,limit} body, no auth header")
    ok(Array.isArray(r.json) && r.json.length === 1 && r.json[0]?.title === "fc a", "firecrawl data[] parsed; url-less item filtered")
    const rBlocked = await req(port, "POST", "/api/invoke/web_search", { query: "blocked", config: { provider: "firecrawl", providerConfigs: { firecrawl: { baseUrl: firecrawlUrl } } } })
    ok(isErr(rBlocked) && errText(rBlocked) === "Firecrawl anonymous search is blocked for this IP. Add a Firecrawl API key in Settings or choose another Web Search provider.", `firecrawl success:false blocked-IP -> localized hint (got ${errText(rBlocked).slice(0, 80)})`)
    const rFail = await req(port, "POST", "/api/invoke/web_search", { query: "plainfail", config: { provider: "firecrawl", providerConfigs: { firecrawl: { baseUrl: firecrawlUrl } } } })
    ok(isErr(rFail) && /^Firecrawl search failed \(200\)$/.test(errText(rFail)), `firecrawl success:false without message -> 'Firecrawl search failed (200)' (got ${JSON.stringify(errText(rFail))})`)
  }

  // ── provider config errors ──────────────────────────────────────────────
  {
    const rNone = await req(port, "POST", "/api/invoke/web_search", { query: "x", config: { provider: "none" } })
    const rEmpty = await req(port, "POST", "/api/invoke/web_search", { query: "x", config: {} })
    ok(isErr(rNone) && errText(rNone) === "Web search provider is not configured." && isErr(rEmpty) && errText(rEmpty) === "Web search provider is not configured.", "no provider -> 'Web search provider is not configured.'")
    const rUnknown = await req(port, "POST", "/api/invoke/web_search", { query: "x", config: { provider: "magic" } })
    ok(isErr(rUnknown) && errText(rUnknown) === "Web search provider 'magic' is not supported yet.", "unknown provider -> exact error")
  }

  // ── agent e2e: web.search via shared-store searchApiConfig ──────────────
  {
    llmRequests.length = 0
    searxngHits.length = 0
    const r = await req(port, "POST", "/api/invoke/agent_start_turn", {
      projectId: "proj-1",
      request: { sessionId: "sess-web-1", runId: "run-web-1", message: "Search the web for hello world", history: [], mode: "standard", tools: { web: true }, topK: 5 },
    })
    const b = r.json
    ok(r.status === 200, `agent_start_turn 200 (got ${r.status}: ${JSON.stringify(b)?.slice(0, 120)})`)
    const webRef = b?.references?.find((x) => x.kind === "web")
    ok(!!webRef, "agent response carries a web reference")
    ok(webRef?.title === "meta title" && webRef?.url === "https://meta.example/x" && webRef?.snippet === "meta desc", `web reference shape (got ${JSON.stringify(webRef)?.slice(0, 140)})`)
    ok(b?.toolEvents?.some((t) => t.tool === "web.search" && t.status === "completed"), "toolEvents: web.search completed")
    const llmReq = llmRequests[0]
    ok(Array.isArray(llmReq?.tools) && llmReq.tools.some((t) => t?.function?.name === "web.search"), "web.search offered to the model when tools.web=true")
    const providerCall = searxngHits.at(-1)
    ok(providerCall?.url?.startsWith("/search?q=hello+world"), `agent turn routes through the shared-store searxng config (got ${providerCall?.url})`)
    ok(typeof b?.message === "string" && /web search found results/.test(b.message), "turn completes with model answer")
  }

  // ── agent e2e: tools.web=false excludes the spec; out-of-band store edit (searxng -> ollama) is picked up with NO restart ──
  {
    llmRequests.length = 0
    ollamaHits.length = 0
    writeStore({ provider: "ollama", apiKey: "sk-o", ollamaUrl }) // desktop-style out-of-band edit
    const r = await req(port, "POST", "/api/invoke/agent_start_turn", {
      projectId: "proj-1",
      request: { sessionId: "sess-web-2", runId: "run-web-2", message: "Search the web again", history: [], mode: "standard", tools: { web: false }, topK: 5 },
    })
    const b = r.json
    ok(r.status === 200, `agent_start_turn (gated) 200 (got ${r.status})`)
    const llmReq = llmRequests[0]
    ok(!!llmReq && !(llmReq.tools ?? []).some((t) => t?.function?.name === "web.search"), `web.search NOT in offered specs when tools.web=false (offered: ${(llmReq?.tools ?? []).map((t) => t?.function?.name).join(",")})`)
    ok(ollamaHits.length === 0, "no provider traffic for a gated turn")
  }
  {
    // Same isolate, but with tools.web=true now hitting the OLLAMA endpoint (the store edit above).
    llmRequests.length = 0
    ollamaHits.length = 0
    const r = await req(port, "POST", "/api/invoke/agent_start_turn", {
      projectId: "proj-1",
      request: { sessionId: "sess-web-3", runId: "run-web-3", message: "Search the web once more", history: [], mode: "standard", tools: { web: true }, topK: 5 },
    })
    const b = r.json
    const webRef = b?.references?.find((x) => x.kind === "web")
    ok(ollamaHits.length === 1 && ollamaHits[0]?.body?.query === "hello world", `out-of-band store edit (searxng -> ollama) honored on the next turn (ollama hits=${ollamaHits.length})`)
    ok(webRef?.url === "https://ollama.example/x" && webRef?.title === "ollama hit", "web reference now carries the ollama result")
  }
} catch (err) {
  fail++
  console.log("  FAIL- harness error:", err.message)
  console.log("--- server log ---\n" + serverLog.slice(-2000))
} finally {
  child.kill("SIGKILL")
  await Promise.allSettled([stopServer(searxngMock), stopServer(searxngMockB), stopServer(ollamaMock), stopServer(firecrawlMock), stopServer(llmMock)])
}

console.log(`\nwebsearch: ${pass} passed, ${fail} failed (entry: ${SERVER_ENTRY})`)
process.exit(fail === 0 ? 0 : 1)
