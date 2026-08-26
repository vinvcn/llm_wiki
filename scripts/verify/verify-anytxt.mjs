// AnyTXT faithful-port acceptance harness.
// Verifies packages/server/src/anytxt.js + the anytxt_search command + the
// agent anytxt.search tool against the desktop contract
// (src-tauri/src/agent/tools.rs run_anytxt_search, JSON-RPC protocol,
// error semantics, file URL encoding):
//   - unit: file_url_for_path (the desktop's own test fixtures), endpoint
//     normalization, trim_text, item/fragment extraction variants
//   - command e2e via /api/invoke against a mock JSON-RPC service: request
//     body contract (GetResult/GetFragment), result shape, fragment
//     preference, limit clamping, enabled:false / empty-query short-circuits,
//     exact error semantics (down / HTTP 500 / invalid JSON / RPC error)
//   - agent e2e: anytxt.search tool picks the config up from the shared
//     store's searchApiConfig.anyTxt (desktop key), emits anytxt references,
//     and degrades gracefully when the service is unreachable.
//
//   node scripts/verify/verify-anytxt.mjs

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
function freePort() { return new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) }) }
async function waitFor(fn, t, what) { const s = Date.now(); while (Date.now() - s < t) { try { if (await fn()) return true } catch {} await sleep(80) } throw new Error(`timeout waiting for ${what}`) }
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

// ── Unit checks against the ported module ─────────────────────────────────
const A = await import(path.join(REPO, "packages/server/src/anytxt.js"))

console.log("unit: file URL encoding (desktop test fixtures)")
ok(A.fileUrlForPath("C:\\docs\\煤矿 安全.pdf") === "file:///C:/docs/%E7%85%A4%E7%9F%BF%20%E5%AE%89%E5%85%A8.pdf", "Windows path + unicode -> encoded file URL")
ok(A.fileUrlForPath("/Users/me/docs/a b.txt") === "file:///Users/me/docs/a%20b.txt", "POSIX path -> encoded file URL")
ok(A.fileUrlForPath("anytxt://99") === "anytxt://99", "scheme paths pass through")
ok(A.fileUrlForPath("//server/share/x.txt") === "file://server/share/x.txt", "UNC path -> file:// URL")
ok(A.fileUrlForPath("") === "", "empty path stays empty")

console.log("unit: endpoint normalization + trim")
ok(A.normalizeAnytxtEndpoint("127.0.0.1:9920") === "http://127.0.0.1:9920", "bare host gets http://")
ok(A.normalizeAnytxtEndpoint("https://x:1") === "https://x:1", "https kept")
ok(A.trimText("abc", 5) === "abc", "trim_text no-op under max")
ok(A.trimText("abcdef", 3) === "abc...", "trim_text cuts + ellipsis")
ok(A.trimText("煤矿安全规程xy", 6) === "煤矿安全规程...", "trim_text counts Unicode chars, not bytes")

console.log("unit: item extraction variants")
{
  const items = A.extractAnytxtItems({ result: { items: [
    { fid: "f1", title: "T1", path: "/x/a.md", snippet: "s1" },
    { path: "", snippet: "" },
    { id: 42, name: "only-name.txt" },
    { fid: "77" },
  ] } })
  ok(items.length === 3, "empty path+snippet item skipped")
  ok(items[0].fid === "f1" && items[0].title === "T1" && items[0].path === "/x/a.md" && items[0].snippet === "s1", "object item mapped")
  ok(items[1].fid === "42" && items[1].path === "only-name.txt" && items[1].title === "only-name.txt", "numeric id stringified; 'name' is a path key (desktop contract); title from name")
  ok(items[2].fid === "77" && items[2].path === "anytxt://77" && items[2].title === "77", "fid-only item gets anytxt:// path; title falls back to basename")
}
{
  // array rows + fields header
  const items = A.extractAnytxtItems({ result: { field: ["fid", "path", "snippet"], items: [
    ["9", "/y/b.txt", "row snippet"],
  ] } })
  ok(items.length === 1 && items[0].fid === "9" && items[0].path === "/y/b.txt" && items[0].snippet === "row snippet" && items[0].title === "b.txt", "array-row records zipped with fields; title falls back to basename")
}
{
  const items = A.extractAnytxtItems({ result: { items: ["just some text"] } })
  ok(items.length === 1 && items[0].snippet === "just some text" && items[0].title === "AnyTXT result", "scalar record -> {text}; title fallback label")
}
{
  const items = A.extractAnytxtItems({ result: { output: { data: [{ file: "/z/c.md", summary: "alt keys" }] } } })
  ok(items.length === 1 && items[0].path === "/z/c.md" && items[0].snippet === "alt keys" && items[0].title === "c.md", "nested output.data + alternate field names")
}

console.log("unit: fragment text extraction")
ok(A.extractAnytxtFragmentText("plain") === "plain", "string fragment")
ok(A.extractAnytxtFragmentText(["a", "", "b"]) === "a\n\nb", "array fragments joined, empties dropped")
ok(A.extractAnytxtFragmentText({ html: "<b>x</b>" }) === "<b>x</b>", "object key priority")
ok(A.extractAnytxtFragmentText({ output: { fragments: [{ text: "nested" }] } }) === "nested", "nested descent")
ok(A.extractAnytxtFragmentText(null) === "", "null -> empty")

// ── Mock AnyTXT JSON-RPC service ──────────────────────────────────────────
const seen = []
function mockAnytxtHandler(body, res) {
  seen.push(body)
  const input = body?.params?.input ?? {}
  if (body.method === "ATRpcServer.Searcher.V1.GetResult") {
    if (input.pattern === "err500") { res.writeHead(500, { "Content-Type": "text/plain" }); res.end("boom"); return }
    if (input.pattern === "badjson") { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{not json"); return }
    if (input.pattern === "rpcerr") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ id: body.id, jsonrpc: "2.0", error: { code: -32000, message: "index corrupted" } }))
      return
    }
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({
      id: body.id, jsonrpc: "2.0",
      result: {
        items: [
          { fid: "f-1", title: "煤矿安全规程", path: "C:\\docs\\煤矿 安全.pdf", snippet: "original snippet one" },
          { fid: "", title: "", path: "/Users/me/docs/a b.txt", snippet: "plain snippet two" },
          { title: "no-path-no-snippet" },
        ],
      },
    }))
    return
  }
  if (body.method === "ATRpcServer.Searcher.V1.GetFragment") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ id: body.id, jsonrpc: "2.0", result: { text: `FRAGMENT for ${input.fid} matching '${input.pattern}'` } }))
    return
  }
  res.writeHead(400); res.end("unknown method")
}
const anytxtPort = await freePort()
const anytxtMock = http.createServer((rq, rs) => {
  let buf = ""; rq.on("data", (c) => (buf += c))
  rq.on("end", () => { try { mockAnytxtHandler(JSON.parse(buf), rs) } catch (e) { rs.writeHead(500); rs.end(String(e)) } })
})
await new Promise((r) => anytxtMock.listen(anytxtPort, r))
const ANYTXT_URL = `http://127.0.0.1:${anytxtPort}`
const closedPort = await freePort() // nothing listens here

// ── Mock OpenAI-compatible LLM (for the agent e2e) ────────────────────────
const TOOL_CALL_ID = "call_anytxt_1"
function mockLlmHandler(reqBody, res) {
  const messages = reqBody.messages ?? []
  const wantsTool = !messages.some((m) => m.role === "tool")
  if (wantsTool) {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: TOOL_CALL_ID, type: "function", function: { name: "anytxt.search", arguments: JSON.stringify({ query: "safety", max_results: 5 }) } }] } }] }))
  } else {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "I found the safety documents." } }] }))
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

// ── Isolated server + shared-store wiring ─────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-anytxt-"))
const dataDir = path.join(tmp, "data")
const storesDir = path.join(dataDir, "stores")
fs.mkdirSync(storesDir, { recursive: true })
const projectPath = path.join(tmp, "project")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n")

const storeFile = path.join(storesDir, "app-state.json")
const writeStore = (anyTxt) => fs.writeFileSync(storeFile, JSON.stringify({
  llmConfig: { provider: "custom", apiKey: "test-key", model: "mock-model", customEndpoint: `http://127.0.0.1:${llmPort}/v1`, apiMode: "chat_completions" },
  projectRegistry: { "proj-1": { id: "proj-1", path: projectPath, name: "project" } },
  lastProject: { id: "proj-1", path: projectPath },
  searchApiConfig: { provider: "none", anyTxt },
}, null, 2))
writeStore({ enabled: true, endpoint: ANYTXT_URL, filterExt: "*", limit: 20 })

const port = await freePort()
const child = spawn(process.execPath, ["packages/server/src/index.js"], {
  cwd: REPO,
  env: { ...process.env, LLM_WIKI_PORT: String(port), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", (d) => (serverLog += d)); child.stderr.on("data", (d) => (serverLog += d))

try {
  await waitFor(async () => (await req(port, "GET", "/api/health")).status === 200, 8000, "server health")
  console.log("server up on", port, "| mock AnyTXT on", anytxtPort)

  // ── command e2e: happy path + request contract ──────────────────────────
  {
    seen.length = 0
    const r = await req(port, "POST", "/api/invoke/anytxt_search", {
      query: "safety", config: { enabled: true, endpoint: ANYTXT_URL }, maxResults: 20,
    })
    ok(r.status === 200 && Array.isArray(r.json) && r.json.length === 2, `happy path: 2 results (no-path-no-snippet skipped) (got ${JSON.stringify(r.json)?.slice(0, 120)})`)
    const [a, b] = r.json ?? []
    ok(a?.title === "煤矿安全规程" && a?.source === "AnyTXT", "result[0] title + source")
    ok(a?.url === "file:///C:/docs/%E7%85%A4%E7%9F%BF%20%E5%AE%89%E5%85%A8.pdf", `result[0] url is the encoded Windows file URL (got ${a?.url})`)
    ok(a?.snippet === "FRAGMENT for f-1 matching 'safety'", `result[0] snippet prefers GetFragment text (got ${JSON.stringify(a?.snippet)})`)
    ok(b?.title === "a b.txt" && b?.url === "file:///Users/me/docs/a%20b.txt" && b?.snippet === "plain snippet two", "result[1] basename title + POSIX file URL + own snippet (no fid)")
    const getResult = seen.find((s) => s.method === "ATRpcServer.Searcher.V1.GetResult")
    ok(!!getResult, "mock received GetResult JSON-RPC call")
    const gi = getResult?.params?.input
    ok(gi?.pattern === "safety" && gi?.filterExt === "*" && gi?.limit === "20" && gi?.offset === 0 && gi?.order === 0 && gi?.lastModifyBegin === 0 && gi?.lastModifyEnd === 2147483647 && !("filterDir" in (gi ?? {})), `GetResult input contract exact (got ${JSON.stringify(gi)})`)
    const frag = seen.find((s) => s.method === "ATRpcServer.Searcher.V1.GetFragment")
    ok(frag?.params?.input?.fid === "f-1" && frag?.params?.input?.pattern === "safety", "GetFragment called only for fid-bearing item with pattern")
    ok(seen.filter((s) => s.method === "ATRpcServer.Searcher.V1.GetFragment").length === 1, "exactly one fragment fetch")
  }

  // ── filterDir / filterExt pass-through ──────────────────────────────────
  {
    seen.length = 0
    await req(port, "POST", "/api/invoke/anytxt_search", {
      query: "safety", config: { enabled: true, endpoint: ANYTXT_URL, filterDir: "D:\\work", filterExt: "pdf" }, maxResults: 5,
    })
    const gi = seen.find((s) => s.method === "ATRpcServer.Searcher.V1.GetResult")?.params?.input
    ok(gi?.filterDir === "D:\\work" && gi?.filterExt === "pdf" && gi?.limit === "5", `filterDir/filterExt/limit honored (got ${JSON.stringify(gi)})`)
  }

  // ── limit clamping: maxResults 500 vs config.limit 2 ────────────────────
  {
    const r = await req(port, "POST", "/api/invoke/anytxt_search", {
      query: "safety", config: { enabled: true, endpoint: ANYTXT_URL, limit: 2 }, maxResults: 500,
    })
    const gi = seen.filter((s) => s.method === "ATRpcServer.Searcher.V1.GetResult").at(-1)?.params?.input
    ok(r.json?.length === 2 && gi?.limit === "2", `limit = min(topK.clamp, config.limit.clamp) (got n=${r.json?.length}, limit=${gi?.limit})`)
  }

  // ── short-circuits (no HTTP traffic) ────────────────────────────────────
  {
    seen.length = 0
    const r1 = await req(port, "POST", "/api/invoke/anytxt_search", { query: "safety", config: { enabled: false, endpoint: ANYTXT_URL } })
    const r2 = await req(port, "POST", "/api/invoke/anytxt_search", { query: "   ", config: { enabled: true, endpoint: ANYTXT_URL } })
    ok(Array.isArray(r1.json) && r1.json.length === 0 && Array.isArray(r2.json) && r2.json.length === 0, "enabled:false and empty query -> []")
    ok(seen.length === 0, "no JSON-RPC traffic for short-circuited searches")
  }

  // ── error semantics ─────────────────────────────────────────────────────
  {
    const r = await req(port, "POST", "/api/invoke/anytxt_search", { query: "safety", config: { enabled: true, endpoint: `http://127.0.0.1:${closedPort}` } })
    const msg = r.json?.error ?? ""
    ok(r.status === 500 && msg.startsWith(`AnyTXT search failed. Check that ATGUI.exe or the AnyTXT service is running at http://127.0.0.1:${closedPort}:`), `service down -> desktop error text (got ${JSON.stringify(msg)?.slice(0, 120)})`)
  }
  {
    const r = await req(port, "POST", "/api/invoke/anytxt_search", { query: "err500", config: { enabled: true, endpoint: ANYTXT_URL } })
    ok(r.status === 500 && (r.json?.error ?? "").startsWith("AnyTXT HTTP 500: boom"), `HTTP 500 -> 'AnyTXT HTTP 500: …' (got ${JSON.stringify(r.json?.error)})`)
  }
  {
    const r = await req(port, "POST", "/api/invoke/anytxt_search", { query: "badjson", config: { enabled: true, endpoint: ANYTXT_URL } })
    ok(r.status === 500 && (r.json?.error ?? "").startsWith("AnyTXT returned invalid JSON: {not json"), `invalid JSON -> exact error (got ${JSON.stringify(r.json?.error)})`)
  }
  {
    const r = await req(port, "POST", "/api/invoke/anytxt_search", { query: "rpcerr", config: { enabled: true, endpoint: ANYTXT_URL } })
    ok(r.status === 500 && /AnyTXT error: .*index corrupted/.test(r.json?.error ?? ""), `JSON-RPC error -> 'AnyTXT error: …' (got ${JSON.stringify(r.json?.error)})`)
  }

  // ── agent e2e: anytxt.search via shared-store searchApiConfig.anyTxt ────
  {
    const r = await req(port, "POST", "/api/invoke/agent_start_turn", {
      projectId: "proj-1",
      request: { sessionId: "sess-anytxt-1", runId: "run-anytxt-1", message: "Search my files for safety docs", history: [], mode: "standard", tools: { anytxt: true }, topK: 5 },
    })
    const b = r.json
    ok(r.status === 200, `agent_start_turn 200 (got ${r.status}: ${JSON.stringify(b)?.slice(0, 120)})`)
    const anytxtRef = b?.references?.find((x) => x.kind === "anytxt")
    ok(!!anytxtRef, "agent response carries an anytxt reference")
    ok(anytxtRef?.path === "file:///C:/docs/%E7%85%A4%E7%9F%BF%20%E5%AE%89%E5%85%A8.pdf", `reference path is the encoded file URL (got ${anytxtRef?.path})`)
    ok(anytxtRef?.snippet === "FRAGMENT for f-1 matching 'safety'", "reference snippet from GetFragment")
    ok(b?.toolEvents?.some((t) => t.tool === "anytxt.search" && t.status === "completed"), "toolEvents: anytxt.search completed")
    ok(typeof b?.message === "string" && /safety documents/.test(b.message), "turn completes with model answer")
  }

  // ── agent e2e: unreachable service degrades gracefully ──────────────────
  {
    writeStore({ enabled: true, endpoint: `http://127.0.0.1:${closedPort}` }) // out-of-band store edit; server must re-read
    const r = await req(port, "POST", "/api/invoke/agent_start_turn", {
      projectId: "proj-1",
      request: { sessionId: "sess-anytxt-2", runId: "run-anytxt-2", message: "Search my files again", history: [], mode: "standard", tools: { anytxt: true }, topK: 5 },
    })
    const b = r.json
    const failedStep = b?.toolEvents?.filter((t) => t.tool === "anytxt.search").at(-1)
    ok(r.status === 200 && failedStep?.status === "failed" && /AnyTXT search failed/.test(failedStep?.detail ?? ""), `unreachable service -> failed tool step, turn survives (got ${JSON.stringify(failedStep)?.slice(0, 140)})`)
    ok(typeof b?.message === "string" && b.message.length > 0, "model still answers after tool failure")
  }
} catch (err) {
  fail++
  console.log("  FAIL- harness error:", err.message)
  console.log("--- server log ---\n" + serverLog.slice(-2000))
} finally {
  child.kill("SIGKILL"); anytxtMock.close(); llmMock.close()
}

console.log(`\nanytxt: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
