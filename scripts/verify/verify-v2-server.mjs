// v2-server faithful legacy-surface acceptance harness.
//
//   node scripts/verify/verify-v2-server.mjs
//
// packages/server/src/index-v2.js is the Docker entrypoint. The unmodified
// browser client depends on the COMPLETE legacy web surface there (index.js
// semantics), so this harness spawns index-v2.js on a free port (with an API
// token configured) and asserts:
//   1.  /api/health diagnostics shape (commands count, webBuilt, store diag)
//   2.  /api/home + /api/commands
//   3.  /api/invoke returns the v2 { ok, result } envelope, 404
//       "Unknown command: …", 400 "Invalid JSON body", deprecation header
//   4.  /api/store key-level get/put/delete
//   5.  /api/raw streams bytes (404 missing, 400 directory)
//   6.  /api/v2/events SSE (token via ?token=) delivers
//       project://files-changed for an out-of-band wiki edit AND for the
//       server's own writes (cross-tab live sync)
//   7.  /api/proxy streams an upstream response verbatim (JSON + chunked SSE)
//       and rejects non-http(s) URLs
//   8.  token semantics: /api/v1/* gated by api_server.rs's own auth
//       (/api/v1/health public), every other /api/* route (incl. /api/invoke)
//       gated by authMiddleware in token mode, /api/v2/* gated the same way
//   9.  the :19827-style clipper companion starts (GET /status, /projects)
//   10. SPA fallback serves dist-web; unknown /api/* returns JSON 404

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http from "node:http"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const TOKEN = "v2-harness-token"
const TOKEN_HDR = { "x-llm-wiki-token": TOKEN }
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log("  ok  -", m) } else { fail++; console.log("  FAIL-", m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((res) => {
    const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) })
  })
}

async function waitFor(fn, timeoutMs, what) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try { if (await fn()) return true } catch { /* retry */ }
    await sleep(100)
  }
  throw new Error(`timeout waiting for ${what}`)
}

function req(port, method, p, { body = null, headers = {}, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body))
    const h = { ...headers }
    if (data != null && !h["Content-Type"]) h["Content-Type"] = "application/json"
    if (data != null) h["Content-Length"] = Buffer.byteLength(data)
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: h }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => {
        const buf = Buffer.concat(chunks).toString("utf-8")
        if (raw) { resolve({ status: res.statusCode, headers: res.headers, raw: buf }); return }
        try { resolve({ status: res.statusCode, headers: res.headers, json: buf ? JSON.parse(buf) : null }) }
        catch { resolve({ status: res.statusCode, headers: res.headers, raw: buf }) }
      })
    })
    r.on("error", reject)
    if (data != null) r.write(data)
    r.end()
  })
}

// SSE client: collects {event, payload} envelopes + the initial comment.
function sseCollect(port) {
  const events = []
  let connected = false
  const rq = http.request({ host: "127.0.0.1", port, path: `/api/v2/events?token=${TOKEN}`, method: "GET" }, (res) => {
    let buf = ""
    res.on("data", (c) => {
      buf += c.toString()
      if (buf.includes(": connected")) connected = true
      let idx
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2)
        const line = frame.split("\n").find((l) => l.startsWith("data: "))
        if (!line) continue
        try { events.push(JSON.parse(line.slice(6))) } catch { /* ignore */ }
      }
    })
  })
  rq.on("error", () => { /* server went away at teardown */ })
  rq.end()
  return { events, isConnected: () => connected, close: () => { try { rq.destroy() } catch { /* noop */ } } }
}

// ── mock upstream for /api/proxy tests ────────────────────────────────────
const upPort = await freePort()
const upstream = http.createServer((rq, rs) => {
  if (rq.url === "/json") {
    rs.writeHead(200, { "Content-Type": "application/json", "x-upstream": "yes" })
    rs.end(JSON.stringify({ upstream: true, n: 42 }))
  } else if (rq.url === "/stream") {
    rs.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
    rs.write("data: one\n\n")
    setTimeout(() => rs.write("data: two\n\n"), 40)
    setTimeout(() => { rs.write("data: three\n\n"); rs.end() }, 80)
  } else {
    rs.writeHead(404, { "Content-Type": "text/plain" }); rs.end("nope")
  }
})
await new Promise((r) => upstream.listen(upPort, "127.0.0.1", r))

// ── fake project + isolated server ────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-v2srv-"))
const dataDir = path.join(tmp, "data")
const projectPath = path.join(tmp, "proj")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\nhello\n")

const port = await freePort()
const clipPort = await freePort()
const child = spawn(process.execPath, ["packages/server/src/index-v2.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    LLM_WIKI_PORT: String(port),
    LLM_WIKI_CLIP_PORT: String(clipPort),
    LLM_WIKI_NO_SHARE: "1",
    LLM_WIKI_DATA_DIR: dataDir,
    LLM_WIKI_API_TOKEN: TOKEN,
  },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", (d) => (serverLog += d))
child.stderr.on("data", (d) => (serverLog += d))

try {
  await waitFor(async () => (await req(port, "GET", "/api/health?token=" + TOKEN)).status === 200, 10000, "server health")
  console.log("v2 server up on", port, "(clipper on", clipPort + ")")

  // 1. health diagnostics (index.js shape)
  const health = (await req(port, "GET", "/api/health", { headers: TOKEN_HDR })).json
  ok(health?.ok === true && health?.name === "llm-wiki-server", `health ok + name (${health?.name})`)
  ok(typeof health?.commands === "number" && health.commands >= 75, `health commands >= 75 (got ${health?.commands})`)
  ok(health?.webBuilt === true, `health webBuilt=true (dist-web served)`)
  ok(health?.store?.shared === false && health?.store?.source === "disabled", `isolated store: shared=false source=disabled (got ${health?.store?.shared}/${health?.store?.source})`)

  // 2. home + commands
  const home = (await req(port, "GET", "/api/home", { headers: TOKEN_HDR })).json
  ok(home && typeof home.home === "string" && typeof home.cwd === "string" && typeof home.separator === "string" && typeof home.platform === "string", "home info shape")
  const cmds = (await req(port, "GET", "/api/commands", { headers: TOKEN_HDR })).json
  ok(Array.isArray(cmds) && cmds.includes("agent_start_turn") && cmds.includes("clip_server_status"), "commands list includes agent + clipper commands")

  // 3. invoke raw contract
  const wikiFile = path.join(projectPath, "wiki", "note.md")
  const wr = await req(port, "POST", "/api/invoke/write_file", { body: { path: wikiFile, contents: "v2 surface says hi" }, headers: TOKEN_HDR })
  ok(wr.status === 200, `invoke write_file 200 (got ${wr.status})`)
  const rd = await req(port, "POST", "/api/invoke/read_file", { body: { path: wikiFile }, headers: TOKEN_HDR })
  ok(rd.status === 200 && rd.json?.result === "v2 surface says hi", `invoke read_file returns the result inside the { ok, result } envelope (got ${JSON.stringify(rd.json)})`)
  ok(typeof rd.headers.deprecation === "string", "invoke carries the Deprecation header")
  const unk = await req(port, "POST", "/api/invoke/nope_cmd", { body: {}, headers: TOKEN_HDR })
  ok(unk.status === 404 && unk.json?.error?.code === "NOT_FOUND" && unk.json?.error?.message === "Unknown command: nope_cmd",
    `unknown command -> 404 NOT_FOUND "Unknown command: nope_cmd" (got ${unk.status} ${JSON.stringify(unk.json)})`)
  const bad = await req(port, "POST", "/api/invoke/read_file", { body: "{bad json", headers: { "Content-Type": "application/json", ...TOKEN_HDR } })
  ok(bad.status === 400 && bad.json?.error?.message === "Invalid JSON body", `invalid JSON body -> 400 "Invalid JSON body" (got ${bad.status} ${JSON.stringify(bad.json)})`)

  // 4. store key-level contract
  const sPut = await req(port, "PUT", "/api/store/app-state.json/harnessKey", { body: { deep: [1, 2, 3] }, headers: TOKEN_HDR })
  ok(sPut.status === 200, `store PUT key 200 (got ${sPut.status})`)
  const sGet = await req(port, "GET", "/api/store/app-state.json/harnessKey", { headers: TOKEN_HDR })
  ok(sGet.status === 200 && JSON.stringify(sGet.json) === JSON.stringify({ deep: [1, 2, 3] }), "store GET key round-trip")
  const sAll = await req(port, "GET", "/api/store/app-state.json", { headers: TOKEN_HDR })
  ok(sAll.status === 200 && JSON.stringify(sAll.json?.harnessKey) === JSON.stringify({ deep: [1, 2, 3] }), "store whole-object GET shows the key")
  await req(port, "DELETE", "/api/store/app-state.json/harnessKey", { headers: TOKEN_HDR })
  const sGone = await req(port, "GET", "/api/store/app-state.json/harnessKey", { headers: TOKEN_HDR })
  ok(sGone.status === 200 && sGone.json === null, "store DELETE key -> GET returns null")

  // 5. raw file streaming
  const raw = await req(port, "GET", `/api/raw?path=${encodeURIComponent(wikiFile)}&token=${TOKEN}`, { raw: true })
  ok(raw.status === 200 && raw.raw === "v2 surface says hi" && String(raw.headers["content-type"]).includes("text/markdown"), "raw streams exact bytes with markdown content-type")
  const rawMiss = await req(port, "GET", `/api/raw?path=${encodeURIComponent(path.join(tmp, "nope.md"))}&token=${TOKEN}`, { raw: true })
  ok(rawMiss.status === 404, `raw missing file -> 404 (got ${rawMiss.status})`)
  const rawDir = await req(port, "GET", `/api/raw?path=${encodeURIComponent(projectPath)}&token=${TOKEN}`, { raw: true })
  ok(rawDir.status === 400, `raw directory -> 400 (got ${rawDir.status})`)

  // 6. SSE: live watcher events — out-of-band edits AND the server's own
  //    writes are broadcast (live cross-tab sync: one server serves every
  //    browser tab, so a write made through it must reach the other tabs).
  const sse = sseCollect(port)
  await waitFor(() => sse.isConnected(), 5000, "SSE connect")
  ok(true, "SSE /api/events connected (got ': connected')")
  const watch = await req(port, "POST", "/api/invoke/start_project_file_watcher", { body: { projectId: "proj-v2", projectPath }, headers: TOKEN_HDR })
  ok(watch.status === 200, `start_project_file_watcher 200 (got ${watch.status})`)
  await sleep(400) // let the watcher arm
  fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\nhello from outside\n")
  await waitFor(() => sse.events.some((e) => e.event === "project://files-changed"), 6000, "project://files-changed for out-of-band edit")
  ok(true, "SSE delivered project://files-changed for the out-of-band wiki edit")
  sse.events.length = 0
  const wikiIndex = path.join(projectPath, "wiki", "index.md")
  await req(port, "POST", "/api/invoke/write_file", { body: { path: wikiIndex, contents: "---\ntype: overview\ntitle: Index\n---\n# Index\nserver write\n" }, headers: TOKEN_HDR })
  await waitFor(() => sse.events.some((e) => e.event === "file:modified" && e.payload?.path === wikiIndex), 6000, "file:modified for the server's own write")
  ok(true, "SSE broadcast the server's own wiki write as file:modified (cross-tab live sync)")
  await sleep(1200) // let any (wrong) watcher echo land
  ok(!sse.events.some((e) => e.event === "project://files-changed" && (e.payload?.paths ?? []).includes("wiki/index.md")),
    "the server's own write is NOT echoed as project://files-changed (app-write-ignore, no self-echo)")
  sse.close()

  // 7. proxy
  const px = await req(port, "POST", "/api/proxy", { body: { url: `http://127.0.0.1:${upPort}/json`, method: "GET", headers: {} }, headers: TOKEN_HDR })
  ok(px.status === 200 && px.json?.upstream === true && px.json?.n === 42, "proxy passes through the upstream JSON body")
  ok(String(px.headers["x-upstream"]) === "yes", "proxy passes through upstream response headers")
  const pxs = await req(port, "POST", "/api/proxy", { body: { url: `http://127.0.0.1:${upPort}/stream`, method: "GET", headers: {} }, raw: true, headers: TOKEN_HDR })
  ok(pxs.status === 200 && pxs.raw === "data: one\n\ndata: two\n\ndata: three\n\n", "proxy streams a chunked upstream response verbatim")
  const pxBad = await req(port, "POST", "/api/proxy", { body: { url: "ftp://example.com/x" }, headers: TOKEN_HDR })
  ok(pxBad.status === 400 && pxBad.json?.error === "Only http(s) URLs may be proxied", `proxy rejects non-http(s) URLs (got ${pxBad.status} ${JSON.stringify(pxBad.json)})`)

  // 8. token semantics parity with index.js
  const v1h = await req(port, "GET", "/api/v1/health")
  ok(v1h.status === 200 && v1h.json?.ok === true, "/api/v1/health is public (desktop contract)")
  const v1NoTok = await req(port, "GET", "/api/v1/projects")
  ok(v1NoTok.status === 401 && v1NoTok.json?.ok === false, `/api/v1/projects without token -> 401 (got ${v1NoTok.status})`)
  const v1Tok = await req(port, "GET", "/api/v1/projects", { headers: { "x-llm-wiki-token": TOKEN } })
  ok(v1Tok.status === 200 && v1Tok.json?.ok === true, "/api/v1/projects with x-llm-wiki-token -> 200")
  const invokeNoTok = await req(port, "POST", "/api/invoke/list_directory", { body: { path: projectPath } })
  ok(invokeNoTok.status === 401 && invokeNoTok.json?.error?.code === "UNAUTHORIZED",
    `/api/invoke gated by authMiddleware in token mode (got ${invokeNoTok.status} ${JSON.stringify(invokeNoTok.json)})`)
  const invokeTok = await req(port, "POST", "/api/invoke/list_directory", { body: { path: projectPath }, headers: TOKEN_HDR })
  ok(invokeTok.status === 200 && Array.isArray(invokeTok.json?.result), "invoke with token -> 200 + result array (the web SPA sends the Bearer token)")
  const v2NoTok = await req(port, "GET", "/api/v2/projects")
  ok(v2NoTok.status === 401 && v2NoTok.json?.error?.code === "UNAUTHORIZED", `/api/v2 gated by authMiddleware (got ${v2NoTok.status} ${v2NoTok.json?.error?.code})`)
  const v2Tok = await req(port, "GET", "/api/v2/projects", { headers: { Authorization: `Bearer ${TOKEN}` } })
  ok(v2Tok.status === 200, `/api/v2 with Bearer token -> 200 (got ${v2Tok.status})`)

  // 9. clipper companion
  await waitFor(async () => {
    const st = await req(port, "POST", "/api/invoke/clip_server_status", { body: {}, headers: TOKEN_HDR })
    return st.status === 200 && st.json?.result === "running"
  }, 8000, "clipper status running")
  ok(true, "clip_server_status -> running")
  const clipStatus = await req(clipPort, "GET", "/status")
  ok(clipStatus.status === 200 && clipStatus.json?.ok === true, "clipper GET /status (desktop protocol)")
  const clipProjects = await req(clipPort, "GET", "/projects")
  ok(clipProjects.status === 200 && Array.isArray(clipProjects.json?.projects), "clipper GET /projects lists projects (loopback bypass)")

  // 10. SPA fallback + unknown /api/* JSON 404
  const spa = await req(port, "GET", "/", { raw: true })
  ok(spa.status === 200 && String(spa.headers["content-type"]).includes("text/html") && spa.raw.includes("<div id=\"root\">"), "SPA fallback serves dist-web/index.html")
  // With a token configured, unknown /api/* paths are refused by
  // authMiddleware before the SPA fallback (the API surface is gated as a
  // whole; without a token the same path falls through to a JSON 404).
  const notFound = await req(port, "GET", "/api/nope")
  ok(notFound.status === 401 && notFound.json?.error?.code === "UNAUTHORIZED", `unknown /api/* with token -> 401 envelope (got ${notFound.status} ${JSON.stringify(notFound.json)})`)
} catch (err) {
  fail++
  console.log("  FAIL- harness error:", err.message)
  console.log("--- server log tail ---")
  console.log(serverLog.split("\n").slice(-30).join("\n"))
} finally {
  try { child.kill("SIGKILL") } catch { /* noop */ }
  try { upstream.close() } catch { /* noop */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* noop */ }
}

console.log(`\nv2-server: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
