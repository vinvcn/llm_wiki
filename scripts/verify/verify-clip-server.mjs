// Chrome Web Clipper companion gate.
//
// Verifies packages/server/src/clip-server.js — the faithful port of the
// desktop's src-tauri/src/clip_server.rs — so the UNMODIFIED Chrome
// extension (extension/) works against the web server exactly like it works
// against the desktop app:
//
//   Part 1  protocol fidelity: every route, exact bodies/status codes, clip
//           file naming + markdown bytes, pending-queue semantics, slug
//           rules, CORS allow-list (cors.rs), exact-match URL routing
//   Part 2  port_conflict: occupied port -> 3 bind retries -> "port_conflict"
//           status, no further retries (desktop semantics)
//   Part 3  LAN auth: loopback bypass; non-loopback needs the API token via
//           Authorization: Bearer / x-llm-wiki-token (no ?token= on the clip
//           listener — the desktop passes an empty query to is_token_authorized)
//   Part 4  browser end-to-end: real web UI opens a project, a clip POSTed
//           to :19827 lands in raw/sources and the UI's clip watcher picks it
//           up and enqueues ingest (extension -> server -> UI -> queue), with
//           ZERO page/console/request errors. Since issue #14 P0 stage 9 the
//           ingest queue is SERVER-owned (SQLite in LLM_WIKI_DATA_DIR/server.db,
//           the same queue the desktop UI drives via the shared server), so
//           this part boots the shipped index-v2.js entry and asserts the
//           enqueued task in the server queue (a task that is claimed and
//           processed against the mock LLM) instead of the retired client-side
//           `.llm-wiki/ingest-queue.json` file.
//
//   node scripts/verify/verify-clip-server.mjs

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { createRequire } from "node:module"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const pwRequire = createRequire("/tmp/pw/package.json")
const { chromium } = pwRequire("playwright-core")

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log("  ok  -", m) } else { fail++; console.log("  FAIL-", m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function freePort() { return new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) }) }
async function waitFor(fn, t, what) { const s = Date.now(); while (Date.now() - s < t) { try { if (await fn()) return true } catch {} await sleep(100) } throw new Error(`timeout: ${what}`) }

function findChromium() {
  const base = path.join(os.homedir(), ".cache", "ms-playwright")
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()
  for (const d of dirs) { const exe = path.join(base, d, "chrome-linux64", "chrome"); if (fs.existsSync(exe)) return exe }
  throw new Error("no chromium binary under ~/.cache/ms-playwright")
}

async function spawnServer(env, what, entry) {
  // Parts 1-3 drive the legacy index.js entry (protocol fidelity is
  // entry-independent). Part 4 boots the SHIPPED v2 entry (index-v2.js):
  // the current React client's v2 REST surface and the server-owned ingest
  // orchestrator (issue #14 P0 stage 9) only exist there.
  const child = spawn(process.execPath, [entry || "packages/server/src/index.js"], {
    cwd: REPO,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let log = ""
  child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d))
  const port = Number(env.LLM_WIKI_PORT)
  try {
    await waitFor(async () => {
      const r = await new Promise((res) => { const q = http.get({ host: "127.0.0.1", port, path: "/api/health" }, (x) => res(x.statusCode)); q.on("error", () => res(0)) })
      return r === 200
    }, 8000, `server health (${what})`)
  } catch (e) {
    child.kill("SIGKILL")
    throw new Error(`${what}: ${e.message}\n--- log ---\n${log}`)
  }
  return { child, log: () => log, port }
}

const invoke = async (port, cmd, args = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/invoke/${cmd}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const j = async (method, url, body, headers = {}) => {
  const res = await fetch(url, { method, body: body ?? undefined, headers: body != null ? { "Content-Type": "application/json", ...headers } : headers, redirect: "manual" })
  let text = ""; try { text = await res.text() } catch {}
  return { status: res.status, text, headers: res.headers }
}

const today = (() => { const n = new Date(); const p = (x) => String(x).padStart(2, "0"); return {
  date: `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`,
  compact: `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}`,
} })()

function expectedClipMd(title, url, content) {
  const esc = (s) => s.replace(/"/g, '\\"')
  return `---\ntype: clip\ntitle: "${esc(title)}"\nurl: "${esc(url)}"\nclipped: ${today.date}\norigin: web-clip\nsources: []\ntags: [web-clip]\n---\n\n# ${title}\n\nSource: ${url}\n\n${content}\n`
}

// ────────────────────────────────────────────────────────────────────────────
// Part 1 — protocol fidelity
// ────────────────────────────────────────────────────────────────────────────
console.log("part 1: protocol fidelity (faithful clip_server.rs port)")
const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), "lw-clip-1-"))
const projA = path.join(tmp1, "proj-a")
const projB = path.join(tmp1, "proj-b")
fs.mkdirSync(projA, { recursive: true })
fs.mkdirSync(projB, { recursive: true })
const clipPort1 = await freePort()
const port1 = await freePort()
const s1 = await spawnServer({
  LLM_WIKI_PORT: String(port1), LLM_WIKI_CLIP_PORT: String(clipPort1),
  LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: path.join(tmp1, "data"),
}, "part-1 server")
const C1 = `http://127.0.0.1:${clipPort1}`

try {
  // status command reports the real daemon state
  const st = await invoke(port1, "clip_server_status")
  ok(st.body === "running", `clip_server_status -> "running" (got ${JSON.stringify(st.body)})`)

  // GET /status — exact body
  let r = await j("GET", `${C1}/status`)
  ok(r.status === 200 && r.text === `{"ok":true,"version":"0.1.0"}`, `GET /status exact body (got ${r.status} ${r.text})`)

  // exact-match routing: a query string is a 404 (desktop matches request.url verbatim)
  r = await j("GET", `${C1}/status?x=1`)
  ok(r.status === 404 && r.text === `{"ok":false,"error":"Not found"}`, `GET /status?x=1 -> 404 exact body (got ${r.status})`)

  // GET /project — empty before any registration
  r = await j("GET", `${C1}/project`)
  ok(r.status === 200 && r.text === `{"ok":true,"path":""}`, `GET /project initial empty (got ${r.text})`)

  // POST /project — set + read back
  r = await j("POST", `${C1}/project`, JSON.stringify({ path: projA }))
  ok(r.status === 200 && r.text === `{"ok":true}`, `POST /project ok (got ${r.status} ${r.text})`)
  r = await j("GET", `${C1}/project`)
  ok(r.text === JSON.stringify({ ok: true, path: projA.split(path.sep).join("/") }), `GET /project reflects set path`)

  // POST /project — validation errors (exact messages)
  r = await j("POST", `${C1}/project`, JSON.stringify({ nope: 1 }))
  ok(r.status === 400 && r.text === `{"ok":false,"error":"path field is required"}`, `POST /project missing path -> 400 exact (got ${r.status} ${r.text})`)
  r = await j("POST", `${C1}/project`, "{bad json")
  ok(r.status === 400 && r.text.startsWith(`{"ok":false,"error":"Invalid JSON:`), `POST /project invalid JSON -> 400 (got ${r.status})`)

  // POST /projects — registration list (empty-path entries skipped), current flag
  r = await j("POST", `${C1}/projects`, JSON.stringify({ projects: [
    { name: "Alpha", path: projA }, { name: "Beta", path: projB }, { name: "Skipped", path: "" },
  ] }))
  ok(r.status === 200 && r.text === `{"ok":true}`, `POST /projects ok`)
  r = await j("GET", `${C1}/projects`)
  {
    const parsed = JSON.parse(r.text)
    const a = parsed.projects?.find((p) => p.name === "Alpha")
    const b = parsed.projects?.find((p) => p.name === "Beta")
    ok(parsed.ok === true && parsed.projects.length === 2, `GET /projects skips empty paths (got ${parsed.projects?.length})`)
    ok(a?.current === true && b?.current === false, `GET /projects marks the current project`)
  }
  r = await j("POST", `${C1}/projects`, "{not json")
  ok(r.status === 200 && r.text === `{"ok":true}`, `POST /projects invalid body still ok:true (desktop parity)`)

  // POST /clip — writes the clip file (current-project fallback), exact naming + bytes
  const clipTitle = "Hello, World! (Test)"
  r = await j("POST", `${C1}/clip`, JSON.stringify({ title: clipTitle, url: "https://example.com/a", content: "Some **content** here" }))
  {
    const rel = `raw/sources/hello-world-test-${today.compact}.md`
    ok(r.status === 200 && r.text === JSON.stringify({ ok: true, path: rel }), `POST /clip -> relative path ${rel} (got ${r.text})`)
    const abs = path.join(projA, "raw", "sources", `hello-world-test-${today.compact}.md`)
    ok(fs.existsSync(abs) && fs.readFileSync(abs, "utf8") === expectedClipMd(clipTitle, "https://example.com/a", "Some **content** here"), "clip file bytes match the desktop frontmatter exactly")
  }

  // dedup: same slug again -> -2 suffix (counter starts at 2)
  r = await j("POST", `${C1}/clip`, JSON.stringify({ title: clipTitle, url: "https://example.com/a", content: "again" }))
  ok(r.status === 200 && r.text === JSON.stringify({ ok: true, path: `raw/sources/hello-world-test-${today.compact}-2.md` }), `duplicate clip -> -2 suffix (got ${r.text})`)

  // projectPath in the body wins over the registered current project
  r = await j("POST", `${C1}/clip`, JSON.stringify({ title: "Other Project Clip", url: "u", content: "body-routed", projectPath: projB }))
  {
    const rel = `raw/sources/other-project-clip-${today.compact}.md`
    ok(r.status === 200 && r.text === JSON.stringify({ ok: true, path: rel }), `POST /clip honors body projectPath (got ${r.text})`)
    ok(fs.existsSync(path.join(projB, rel)), "clip landed in the body project, not the current one")
  }

  // slug rules: unicode alphanumerics kept, punctuation -> separator, lowercased
  r = await j("POST", `${C1}/clip`, JSON.stringify({ title: "  Héllo  Wörld! 测试 -- Café  ", url: "u", content: "slug probe" }))
  ok(r.text === JSON.stringify({ ok: true, path: `raw/sources/héllo-wörld-测试----café-${today.compact}.md` }), `unicode slug follows the Rust char rules (got ${r.text})`)

  // slug capped at 50 chars
  {
    const long = "a".repeat(80)
    r = await j("POST", `${C1}/clip`, JSON.stringify({ title: long, url: "u", content: "cap probe" }))
    ok(r.text === JSON.stringify({ ok: true, path: `raw/sources/${"a".repeat(50)}-${today.compact}.md` }), `slug truncated to 50 chars (got ${r.text})`)
  }

  // POST /clip — error semantics (500 + exact messages, like the Rust status rule)
  r = await j("POST", `${C1}/clip`, JSON.stringify({ title: "x", url: "y", content: "" }))
  ok(r.status === 500 && r.text === `{"ok":false,"error":"content is required"}`, `empty content -> 500 exact (got ${r.status} ${r.text})`)
  r = await j("POST", `${C1}/clip`, "{nope")
  ok(r.status === 500 && r.text.startsWith(`{"ok":false,"error":"Invalid JSON:`), `invalid JSON -> 500 (got ${r.status})`)
  await j("POST", `${C1}/project`, JSON.stringify({ path: "" })) // reset current
  r = await j("POST", `${C1}/clip`, JSON.stringify({ title: "x", url: "y", content: "z" }))
  ok(r.status === 500 && r.text === `{"ok":false,"error":"projectPath is required (set via POST /project or include in request body)"}`, `no project anywhere -> 500 exact (got ${r.text})`)
  await j("POST", `${C1}/project`, JSON.stringify({ path: projA })) // restore

  // GET /clips/pending — returns then clears (desktop hand-off to the frontend)
  r = await j("GET", `${C1}/clips/pending`)
  {
    const parsed = JSON.parse(r.text)
    const fwdA = projA.split(path.sep).join("/")
    const fwdB = projB.split(path.sep).join("/")
    ok(parsed.ok === true && parsed.clips.length === 5, `pending lists all 5 clips (got ${parsed.clips?.length})`)
    ok(parsed.clips.every((c) => typeof c.projectPath === "string" && typeof c.filePath === "string"), "pending entries carry projectPath + filePath")
    ok(parsed.clips[0].projectPath === fwdA && parsed.clips[0].filePath === `${fwdA}/raw/sources/hello-world-test-${today.compact}.md`, "pending paths are absolute + forward-slashed")
    ok(parsed.clips[2].projectPath === fwdB, "body-routed clip pending for the body project")
  }
  r = await j("GET", `${C1}/clips/pending`)
  ok(r.text === `{"ok":true,"clips":[]}`, `pending cleared after read (got ${r.text})`)

  // 404 + wrong-method semantics
  r = await j("GET", `${C1}/definitely-not-a-route`)
  ok(r.status === 404 && r.text === `{"ok":false,"error":"Not found"}`, `unknown route -> 404 exact body`)
  r = await j("GET", `${C1}/clip`)
  ok(r.status === 404, `GET /clip (wrong method) -> 404 (got ${r.status})`)

  // CORS — narrow allow-list from cors.rs
  r = await j("OPTIONS", `${C1}/clip`, null, { Origin: "chrome-extension://abcdef" })
  ok(r.status === 204
    && r.headers.get("access-control-allow-origin") === "chrome-extension://abcdef"
    && r.headers.get("access-control-allow-methods") === "GET, POST, PATCH, OPTIONS"
    && r.headers.get("access-control-allow-headers") === "Content-Type, Authorization, X-LLM-Wiki-Token"
    && r.headers.get("access-control-allow-private-network") === "true"
    && r.headers.get("vary") === "Origin"
    && r.headers.get("access-control-max-age") === "600",
    "OPTIONS preflight: 204 + full CORS set for chrome-extension origin")
  r = await j("GET", `${C1}/status`, null, { Origin: "http://localhost:34567" })
  ok(r.headers.get("access-control-allow-origin") === "http://localhost:34567", "local web origin gets Allow-Origin echoed")
  r = await j("GET", `${C1}/status`, null, { Origin: "https://evil.com" })
  ok(r.headers.get("access-control-allow-origin") === null, "evil origin gets NO Allow-Origin")
  r = await j("GET", `${C1}/status`, null, { Origin: "https://localhost" })
  ok(r.headers.get("access-control-allow-origin") === null, "https://localhost is NOT an allowed origin (parity)")
  r = await j("GET", `${C1}/status`, null, { Origin: "HTTP://LOCALHOST" })
  ok(r.headers.get("access-control-allow-origin") === null, "origin matching is case-sensitive (parity)")
  r = await j("GET", `${C1}/status`, null, { Origin: "http://localhost.evil.com" })
  ok(r.headers.get("access-control-allow-origin") === null, "localhost.evil.com prefix trick rejected (parity)")
} finally {
  s1.child.kill("SIGKILL")
}

// ────────────────────────────────────────────────────────────────────────────
// Part 2 — port_conflict (desktop: 3 bind retries, then park; no restart)
// ────────────────────────────────────────────────────────────────────────────
console.log("part 2: port_conflict status when the port is owned by another process")
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "lw-clip-2-"))
const busyPort = await freePort()
const squatter = net.createServer(() => {})
await new Promise((res) => squatter.listen(busyPort, "127.0.0.1", res))
const port2 = await freePort()
const s2 = await spawnServer({
  LLM_WIKI_PORT: String(port2), LLM_WIKI_CLIP_PORT: String(busyPort),
  LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: path.join(tmp2, "data"),
}, "part-2 server")
try {
  await waitFor(async () => (await invoke(port2, "clip_server_status")).body === "port_conflict", 12000, "port_conflict status")
  ok(true, `occupied clip port -> status "port_conflict" (3 retries, then parked)`)
  ok(s2.log().includes("unavailable after 3 attempts"), "bind-retry log matches the desktop (3 attempts)")
} catch (e) {
  ok(false, `port_conflict: ${e.message}`)
} finally {
  s2.child.kill("SIGKILL")
  squatter.close()
}

// ────────────────────────────────────────────────────────────────────────────
// Part 3 — LAN auth (loopback bypass; token otherwise; headers-only)
// ────────────────────────────────────────────────────────────────────────────
console.log("part 3: LAN token auth (loopback bypass, headers-only token)")
const lanIp = (() => {
  const ifaces = os.networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal) return i.address
    }
  }
  return null
})()
let tmp3 = null
if (!lanIp) {
  console.log("  skip - no non-loopback IPv4 interface on this host; LAN auth path not reachable")
  pass += 1
} else {
  tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "lw-clip-3-"))
  const clipPort3 = await freePort()
  const port3 = await freePort()
  const s3 = await spawnServer({
    LLM_WIKI_PORT: String(port3), LLM_WIKI_CLIP_PORT: String(clipPort3),
    LLM_WIKI_HOST: "0.0.0.0", LLM_WIKI_API_TOKEN: "sekrit-token",
    LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: path.join(tmp3, "data"),
  }, "part-3 server")
  const C3 = (host) => `http://${host}:${clipPort3}`
  try {
    let r = await j("GET", `${C3(lanIp)}/status`)
    ok(r.status === 401 && r.text === `{"ok":false,"error":"Missing or invalid API token"}`, `LAN request without token -> 401 exact (got ${r.status} ${r.text})`)
    r = await j("GET", `${C3(lanIp)}/status`, null, { Authorization: "Bearer wrong" })
    ok(r.status === 401, `LAN request with wrong token -> 401 (got ${r.status})`)
    r = await j("GET", `${C3(lanIp)}/status`, null, { Authorization: "Bearer sekrit-token" })
    ok(r.status === 200 && r.text === `{"ok":true,"version":"0.1.0"}`, `LAN request with Bearer token -> 200`)
    r = await j("GET", `${C3(lanIp)}/status`, null, { "x-llm-wiki-token": "sekrit-token" })
    ok(r.status === 200, `LAN request with x-llm-wiki-token -> 200`)
    r = await j("GET", `${C3(lanIp)}/status?token=sekrit-token`)
    ok(r.status === 401, `?token= query is NOT accepted on the clip listener (desktop passes empty query) (got ${r.status})`)
    r = await j("GET", `${C3("127.0.0.1")}/status`)
    ok(r.status === 200, `loopback bypasses the token even when one is configured`)
  } finally {
    s3.child.kill("SIGKILL")
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Part 4 — browser end-to-end: extension POST -> server file -> UI watcher ->
//           ingest queue, with zero page/console/request errors
// ────────────────────────────────────────────────────────────────────────────
console.log("part 4: browser e2e (web UI clip watcher picks up a :19827 clip)")

// The web UI's clip watcher polls the FIXED companion port (desktop parity),
// so this part runs on the real default port. Refuse to run if something else
// owns it (e.g. a desktop app on the same host).
const CLIP_DEFAULT = 19827
await new Promise((res, rej) => {
  const probe = net.createServer(() => {})
  probe.once("error", (e) => rej(new Error(`default clip port ${CLIP_DEFAULT} is occupied (${e.code}) — this gate needs it free`)))
  probe.listen(CLIP_DEFAULT, "127.0.0.1", () => probe.close(() => res()))
})

const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), "lw-clip-4-"))
const dataDir = path.join(tmp4, "data")
const storesDir = path.join(dataDir, "stores")
const projectPath = path.join(tmp4, "desktop-project")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.mkdirSync(path.join(projectPath, "raw", "sources"), { recursive: true })
fs.mkdirSync(storesDir, { recursive: true })
fs.writeFileSync(path.join(projectPath, "schema.md"), "# Schema\n\nEntity pages describe things.\n")
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n\nHome page of the wiki.\n")
fs.writeFileSync(path.join(projectPath, "wiki", "quantum.md"), "---\ntype: entity\ntitle: Quantum Mechanics\n---\n# Quantum Mechanics\n\nQuantum mechanics is the study of matter at atomic and subatomic scales.\n")
// purpose.md + wiki/overview.md exist in real projects; the ingest pipeline
// reads them as LLM context (the desktop's ingest does the same).
fs.writeFileSync(path.join(projectPath, "purpose.md"), "# Purpose\n\nA test knowledge base.\n")
fs.writeFileSync(path.join(projectPath, "wiki", "overview.md"), "---\ntype: overview\ntitle: Overview\n---\n# Overview\n\nOverview of the test knowledge base.\n")

// Mock LLM so hasUsableLlm(llmConfig) is true and the watcher enqueues ingest.
// Responses are slow enough that the queue task is still persisted/visible
// while we assert on it.
let mockHits = 0
const mockPort = await freePort()
const mock = http.createServer((rq, rs) => {
  let buf = ""
  rq.on("data", (c) => (buf += c))
  rq.on("end", async () => {
    mockHits++
    await sleep(2500)
    rs.writeHead(200, { "Content-Type": "application/json" })
    rs.end(JSON.stringify({
      id: "cmpl_mock", object: "chat.completion", created: 1, model: "mock",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Mock answer." } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })
})
await new Promise((r) => mock.listen(mockPort, r))
fs.writeFileSync(path.join(storesDir, "app-state.json"), JSON.stringify({
  llmConfig: { provider: "custom", apiKey: "test-key", model: "mock-model", customEndpoint: `http://127.0.0.1:${mockPort}/v1`, apiMode: "chat_completions" },
}, null, 2))

const port4 = await freePort()
const s4 = await spawnServer({
  LLM_WIKI_PORT: String(port4), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir,
}, "part-4 server", process.env.SERVER_ENTRY || "packages/server/src/index-v2.js")

let browser
try {
  // The legacy entry returns the raw status string; the v2 entry wraps it in
  // the { ok, result } envelope. Accept either shape (entry-agnostic).
  await waitFor(async () => {
    const r = await invoke(port4, "clip_server_status")
    const b = r.body
    return b === "running" || (b && typeof b === "object" && b.result === "running")
  }, 8000, "part-4 clip status running")
  ok(true, "part-4 server owns :19827 (clip_server_status -> running)")

  browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
  const page = await browser.newPage()
  const pageErrors = []
  const consoleErrors = []
  const badResponses = []
  const failedRequests = []
  const optionalReads = []
  const dialogs = []
  const clipPolls = []
  page.on("pageerror", (e) => pageErrors.push(String(e)))
  page.on("console", (m) => {
    if (m.type() !== "error") return
    const t = m.text()
    if (/Failed to load resource/i.test(t)) return
    consoleErrors.push(t)
  })
  page.on("requestfailed", (rq) => failedRequests.push(`FAILED ${rq.method()} ${rq.url()} :: ${rq.failure()?.errorText}`))
  page.on("request", (rq) => { if (rq.url().includes("/clips/pending")) clipPolls.push(Date.now()) })
  page.on("response", (resp) => {
    if (resp.status() < 400) return
    const req = resp.request()
    const u = req.url()
    let detail = `HTTP ${resp.status()} ${req.method()} ${u}`
    let tolerated = false
    try {
      const body = req.postDataJSON?.() ?? {}
      const p = typeof body?.path === "string" ? body.path : ""
      const cmd = u.split("/api/invoke/").pop()
      detail += ` [${cmd} ${p}]`
      if (p.includes("/.llm-wiki/") && (cmd === "read_file" || cmd === "list_directory")) tolerated = true
    } catch {}
    if (tolerated) optionalReads.push(detail)
    else badResponses.push(detail)
  })
  page.on("dialog", async (d) => { dialogs.push(`${d.type()}: ${d.message()}`); try { await d.dismiss() } catch {} })

  await page.goto(`http://127.0.0.1:${port4}/`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("button:has-text('Open Project')", { timeout: 10000 })

  // Open the project through the server-backed picker (same flow as the e2e gate).
  await page.click("button:has-text('Open Project')")
  await page.waitForSelector(".lw-overlay", { timeout: 5000 })
  await page.waitForSelector(".lw-list .lw-row, .lw-list .lw-empty", { timeout: 5000 })
  const base = projectPath.split("/").filter(Boolean).pop()
  let navigated = false
  for (let attempt = 0; attempt < 4 && !navigated; attempt++) {
    await page.fill(".lw-pathbar input", projectPath)
    await page.click(".lw-pathbar button.lw-btn:has-text('Go')")
    try {
      await waitFor(async () => {
        const v = await page.inputValue(".lw-pathbar input")
        const btn = await page.textContent(".lw-btn.primary")
        return v === projectPath || (btn || "").includes(base)
      }, 2500, "picker navigated")
      navigated = true
    } catch {}
  }
  if (!navigated) throw new Error("picker did not navigate to the project path")
  await page.waitForSelector(`.lw-btn.primary:has-text('Select')`, { timeout: 5000 })
  await page.click(".lw-btn.primary")
  await waitFor(async () => (await page.$$(".lw-overlay")).length === 0, 5000, "picker closed")
  await page.waitForSelector("text=Quantum Mechanics", { timeout: 15000 })
  ok(true, "project opened via picker; Knowledge tree rendered")

  // The web UI must have REGISTERED the project with the companion (App.tsx),
  // exactly like the desktop does on project open.
  await waitFor(async () => {
    const r = await j("GET", "http://127.0.0.1:19827/project")
    return JSON.parse(r.text).path === projectPath
  }, 10000, "UI registered the current project with the companion")
  ok(true, "web UI registered the open project with the clip companion (POST /project)")
  await waitFor(async () => {
    const r = await j("GET", "http://127.0.0.1:19827/projects")
    const parsed = JSON.parse(r.text)
    return parsed.ok === true && Array.isArray(parsed.projects) && parsed.projects.some((x) => x.path === projectPath)
  }, 10000, "UI pushed the recents list")
  ok(true, "web UI pushed the recents list (POST /projects)")

  // The watcher must be polling /clips/pending on the companion port.
  await waitFor(async () => clipPolls.length >= 1, 12000, "clip watcher polling /clips/pending")
  ok(true, `web clip watcher is polling :19827/clips/pending (got ${clipPolls.length} poll(s))`)

  // Simulate the Chrome extension: POST a clip for the open project.
  const clipRes = await j("POST", "http://127.0.0.1:19827/clip", JSON.stringify({
    title: "Web Clip E2E",
    url: "https://example.com/web-clip-e2e",
    content: "Clipped while the web client watched.",
    projectPath,
  }))
  const clipParsed = JSON.parse(clipRes.text)
  ok(clipRes.status === 200 && clipParsed.ok === true, `extension-style POST /clip accepted (got ${clipRes.text})`)
  const clipRel = clipParsed.path
  const clipAbs = path.join(projectPath, clipRel)
  ok(fs.existsSync(clipAbs), `clip file exists on disk (${clipRel})`)

  // The watcher must pick the pending clip up and enqueue ingest. The queue
  // is SERVER-OWNED (SQLite in LLM_WIKI_DATA_DIR/server.db — the same queue
  // the desktop UI drives via the shared server); the enqueued task for the
  // clip path is claimed/processed while the mock LLM is slow. This is the
  // full extension -> server -> UI -> queue loop.
  const dbPath = path.join(dataDir, "server.db")
  await waitFor(async () => {
    try {
      const { DatabaseSync } = await import("node:sqlite")
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const row = db.prepare("SELECT file_path FROM ingest_queue WHERE file_path = ?").get(clipAbs.split(path.sep).join("/"))
        return !!row
      } finally {
        db.close()
      }
    } catch {
      return false // db not ready / migration not run yet
    }
  }, 20000, "clip watcher enqueued ingest for the clip")
  ok(true, "clip watcher enqueued ingest for the clip (server queue, shared with the desktop)")
  ok(mockHits >= 1, `ingest processing started against the mock LLM (${mockHits} call(s))`)

  // Cleanliness — the watcher's 3s polling must produce zero errors.
  await sleep(500)
  ok(dialogs.length === 0, `ZERO alert/confirm dialogs (got ${dialogs.length})`)
  ok(pageErrors.length === 0, `ZERO page errors (got ${pageErrors.length}: ${pageErrors.slice(0, 3).join(" | ")})`)
  ok(consoleErrors.length === 0, `ZERO console errors (got ${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(" | ")})`)
  ok(failedRequests.length === 0, `ZERO failed requests (got ${failedRequests.length}: ${failedRequests.slice(0, 3).join(" | ")})`)
  ok(badResponses.length === 0, `ZERO non-optional 4xx/5xx responses (got ${badResponses.length}: ${badResponses.slice(0, 3).join(" | ")})`)

  if (fail > 0) {
    try { await page.screenshot({ path: "/tmp/lw-clip-e2e-fail.png", fullPage: true }); console.log("  screenshot -> /tmp/lw-clip-e2e-fail.png") } catch {}
  }
} catch (err) {
  fail++
  console.log("  FAIL- harness error:", err.message)
  console.log("--- server log ---\n" + s4.log().slice(-1500))
} finally {
  try { await browser?.close() } catch {}
  s4.child.kill("SIGKILL")
  mock.close()
}

// Clean up temp fixtures (harness hygiene; /tmp is shared).
for (const d of [tmp1, tmp2, tmp3, tmp4].filter(Boolean)) {
  try { fs.rmSync(d, { recursive: true, force: true }) } catch {}
}

console.log(`\nclip-server: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
