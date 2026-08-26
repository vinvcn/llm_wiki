// Headless browser gate for MinerU PDF extraction in web mode (durable;
// /tmp is volatile).
//
// The desktop's MinerU integration (Settings → MinerU) is configured in the
// SHARED app-state.json and runs from the frontend's ingest pipeline over the
// Tauri HTTP plugin — raw binary out (the PDF), raw binary in (result zip /
// JSON). In web mode that traffic goes through the src/web/http.ts shim +
// /api/proxy, which must carry binary BYTE-EXACT (envelope: bodyBase64 for
// the cloud PUT, formEntries for the local multipart submit).
//
// This gate proves the whole chain through the REAL browser UI with a mock
// self-hosted MinerU service (local backend, no real key/service):
//
//   "desktop" store: mineruConfig { enabled, backend: "local",
//     localEndpoint: mock } + llmConfig → mock LLM
//   "desktop" drops a REAL binary PDF (fixtures/mineru/sample.pdf, with the
//     standard E2 E3 CF D3 binary comment + a Flate stream) into raw/sources
//   web client opens the project via the picker → watcher auto-ingest runs →
//     ingest uploads the PDF through shim+proxy to the mock MinerU →
//     the mock returns markdown + one image → the cache file, the media
//     image, and the source-summary page land on disk via the mock LLM's
//     two-stage analysis→generation.
//
// The crux assertion: the mock MinerU receives the PDF's bytes BYTE-EXACT
// through the browser's multipart submit (a naive UTF-8 text round-trip —
// the old shim behavior — corrupts the Flate stream and the binary comment).
//
//   node scripts/verify/verify-browser-mineru.mjs
// SERVER_ENTRY=packages/server/src/index-v2.js re-runs it against Docker's
// entry point.

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http from "node:http"
import crypto from "node:crypto"
import { createRequire } from "node:module"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const ENTRY = process.env.SERVER_ENTRY || "packages/server/src/index-v2.js"
const pwRequire = createRequire("/tmp/pw/package.json")
const { chromium } = pwRequire("playwright-core")

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log("  ok  -", m) } else { fail++; console.log("  FAIL-", m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function httpJson(method, port, p, data) {
  return new Promise((res) => {
    const body = data ? JSON.stringify(data) : null
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {} }, (r) => {
      let buf = ""
      r.on("data", (c) => (buf += c))
      r.on("end", () => { try { res({ status: r.statusCode, json: buf ? JSON.parse(buf) : null }) } catch { res({ status: r.statusCode, raw: buf }) } })
    })
    req.on("error", () => res({ status: 0, json: null }))
    if (body) req.write(body)
    req.end()
  })
}
function freePort() { return new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) }) }
async function waitFor(fn, t, what) { const s = Date.now(); while (Date.now() - s < t) { try { if (await fn()) return true } catch {} await sleep(100) } throw new Error(`timeout: ${what}`) }

function findChromium() {
  const base = path.join(os.homedir(), ".cache", "ms-playwright")
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()
  for (const d of dirs) { const exe = path.join(base, d, "chrome-linux64", "chrome"); if (fs.existsSync(exe)) return exe }
  throw new Error("no chromium binary under ~/.cache/ms-playwright")
}

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex")

// ── The binary PDF fixture (real non-UTF-8 bytes; pdfjs-parseable) ─────────
const FIXTURE = path.join(REPO, "scripts/verify/fixtures/mineru/sample.pdf")
const PDF_BYTES = fs.readFileSync(FIXTURE)
if (!PDF_BYTES.subarray(10, 14).equals(Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]))) {
  throw new Error("fixture lost its binary comment — regenerate it")
}

// ── Mock OpenAI-compatible LLM (the ingest's two stages) ──────────────────
const SUMMARY_MARKER = "MOCK-MINERU-SUMMARY-MARKER"
const mockCalls = []
function generationOutput() {
  return [
    `---FILE: wiki/sources/sample.md---`,
    `---`,
    `type: source`,
    `title: Sample Doc`,
    `created: 2026-01-01`,
    `updated: 2026-01-01`,
    `tags: [testing]`,
    `related: []`,
    `sources: ["sample.pdf"]`,
    `---`,
    ``,
    `# Sample Doc`,
    ``,
    `${SUMMARY_MARKER} This PDF was parsed by the mock MinerU service and`,
    `summarized by the mock LLM through the web client's ingest pipeline.`,
    `---END FILE---`,
    ``,
  ].join("\n")
}
function mockHandler(reqBody, res) {
  mockCalls.push(reqBody)
  const sys = String((reqBody.messages ?? []).find((m) => m.role === "system")?.content ?? "")
  const isAnalysis = /expert research analyst/i.test(sys)
  const isGeneration = /wiki maintainer/i.test(sys)
  const text = isGeneration
    ? generationOutput()
    : isAnalysis
      ? "## Key Entities\n- Sample Doc: the fixture document.\n\n## Key Concepts\n- MinerU parses PDFs into markdown.\n"
      : "Mock answer."
  const stream = !!reqBody.stream
  const chunk = (delta, finish) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`
  const emit = () => {
    if (stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const parts = text.match(/.{1,48}/gs) ?? [text]
      for (const p of parts) res.write(chunk({ role: "assistant", content: p }))
      res.write(chunk({}, "stop"))
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }))
    }
  }
  if (isAnalysis) setTimeout(emit, 400)
  else emit()
}
const llmPort = await freePort()
const llmMock = http.createServer((rq, rs) => {
  let buf = ""
  rq.on("data", (c) => (buf += c))
  rq.on("end", () => {
    if (rq.method === "POST" && rq.url.includes("/chat/completions")) {
      try { mockHandler(JSON.parse(buf), rs) } catch (e) { rs.writeHead(500); rs.end(String(e)) }
    } else { rs.writeHead(404); rs.end("nope") }
  })
})
await new Promise((r) => llmMock.listen(llmPort, r))

// ── Mock self-hosted MinerU (the local backend's HTTP contract) ───────────
// 1x1 transparent PNG served as a data URI inside the result JSON, exactly
// like a real mineru-api response.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const MINERU_MD = [
  "# Sample Doc",
  "",
  "MINERU-PARSE-MARKER This markdown was produced by the mock MinerU service",
  "from the uploaded binary PDF. It contains a figure:",
  "",
  "![figure](images/img1.png)",
  "",
  "The figure shows the fixture's painted rectangle.",
].join("\n")
const mineruSeen = { submits: [], statuses: 0, results: 0, health: 0 }
const mineruMock = http.createServer((rq, rs) => {
  const chunks = []
  rq.on("data", (c) => chunks.push(c))
  rq.on("end", async () => {
    const raw = Buffer.concat(chunks)
    if (rq.method === "GET" && rq.url === "/health") {
      mineruSeen.health++
      rs.writeHead(200, { "Content-Type": "application/json" }); rs.end('{"status":"healthy"}'); return
    }
    if (rq.method === "POST" && rq.url === "/tasks") {
      let parsed = null
      try {
        const fd = await new Request("http://mineru/tasks", {
          method: "POST",
          headers: { "content-type": rq.headers["content-type"] || "" },
          body: raw,
        }).formData()
        const fields = {}
        const files = []
        for (const [name, value] of fd.entries()) {
          if (typeof value === "string") fields[name] = value
          else files.push({ name, fileName: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) })
        }
        parsed = { fields, files, contentType: rq.headers["content-type"] || "" }
      } catch (err) {
        parsed = { parseError: String(err), contentType: rq.headers["content-type"] || "" }
      }
      mineruSeen.submits.push(parsed)
      rs.writeHead(200, { "Content-Type": "application/json" }); rs.end('{"task_id":"task-1"}'); return
    }
    if (rq.method === "GET" && rq.url === "/tasks/task-1") {
      mineruSeen.statuses++
      rs.writeHead(200, { "Content-Type": "application/json" }); rs.end('{"status":"completed"}'); return
    }
    if (rq.method === "GET" && rq.url === "/tasks/task-1/result") {
      mineruSeen.results++
      rs.writeHead(200, { "Content-Type": "application/json" })
      rs.end(JSON.stringify({ results: { "sample.pdf": { md_content: MINERU_MD, images: { "images/img1.png": `data:image/png;base64,${PNG_B64}` } } } }))
      return
    }
    rs.writeHead(404); rs.end("nope")
  })
})
const mineruPort = await freePort()
await new Promise((r) => mineruMock.listen(mineruPort, r))

// ── Fake "desktop" project + shared store (MinerU configured on desktop) ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-mineru-"))
const dataDir = path.join(tmp, "data")
const storesDir = path.join(dataDir, "stores")
fs.mkdirSync(storesDir, { recursive: true })
const projectPath = path.join(tmp, "desktop-project")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.mkdirSync(path.join(projectPath, "raw", "sources"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "schema.md"), "# Schema\n\nSource pages summarize raw sources.\n")
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n\nHome page of the wiki.\n")
fs.copyFileSync(FIXTURE, path.join(projectPath, "raw", "sources", "sample.pdf"))

fs.writeFileSync(path.join(storesDir, "app-state.json"), JSON.stringify({
  llmConfig: { provider: "custom", apiKey: "test-key", model: "mock-model", customEndpoint: `http://127.0.0.1:${llmPort}/v1`, apiMode: "chat_completions" },
  mineruConfig: {
    enabled: true,
    backend: "local",
    localEndpoint: `http://127.0.0.1:${mineruPort}`,
    token: "",
    modelVersion: "pipeline",
  },
}, null, 2))

const port = await freePort()
const child = spawn(process.execPath, [ENTRY], {
  cwd: REPO,
  env: { ...process.env, LLM_WIKI_AUTH_MODE: "none", LLM_WIKI_PORT: String(port), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", (d) => (serverLog += d)); child.stderr.on("data", (d) => (serverLog += d))

const storeFile = path.join(storesDir, "app-state.json")
const cacheFile = path.join(projectPath, "raw", "sources", ".cache", "sample.pdf.txt")
const summaryFile = path.join(projectPath, "wiki", "sources", "sample.md")
const imageFile = path.join(projectPath, "wiki", "media", "sample", "mineru", "images", "image-1.png")

// The ingest queue is SERVER-owned (SQLite) — the deleted client-side
// .llm-wiki/ingest-queue.json no longer exists. Observe it over the v2 REST
// API; the client's UUID is the WikiProject lastProject.id the app writes to
// the shared plugin store once the project is opened.
async function readProjectUuid() {
  try { return JSON.parse(fs.readFileSync(storeFile, "utf8"))?.lastProject?.id ?? null } catch { return null }
}
async function fetchQueue(uuid, status) {
  const q = status ? `?status=${status}&limit=200` : "?limit=200"
  const r = await httpJson("GET", port, `/api/v2/projects/${uuid}/ingest/queue${q}`)
  return r.status === 200 && Array.isArray(r.json?.tasks) ? r.json.tasks : null
}
let browser
try {
  await waitFor(async () => {
    const r = await new Promise((res) => { const q = http.get({ host: "127.0.0.1", port, path: "/api/health" }, (x) => res(x.statusCode)); q.on("error", () => res(0)) })
    return r === 200
  }, 8000, "server health")

  browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
  const ctx = await browser.newContext({ locale: "en-US" })
  const page = await ctx.newPage()

  const pageErrors = []
  const consoleErrors = []
  const badResponses = []
  const optionalReads = []
  const pendingProbes = []
  const dialogs = []
  page.on("pageerror", (e) => pageErrors.push(String(e)))
  page.on("console", (m) => {
    if (m.type() !== "error") return
    const t = m.text()
    if (/Failed to load resource/i.test(t)) return
    consoleErrors.push(t)
  })
  page.on("requestfailed", (r) => badResponses.push(`FAILED ${r.method()} ${r.url()} :: ${r.failure()?.errorText}`))
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
      detail += ` [${cmd} ${p.replace(projectPath, "")}]`
      if (p.includes("/.llm-wiki/") && (cmd === "read_file" || cmd === "list_directory")) {
        tolerated = true
        detail += ` [optional-state]`
      } else if (cmd === "read_file") {
        const rel = p.replace(projectPath, "").replace(/^\//, "")
        const knownOptional = rel === "purpose.md" || rel === "wiki/overview.md"
        if (knownOptional) { tolerated = true; detail += " [optional-context]" }
        else { pendingProbes.push({ detail, abs: p }); return }
      }
    } catch { /* non-json body */ }
    if (tolerated) optionalReads.push(detail)
    else badResponses.push(detail)
  })
  page.on("dialog", async (d) => { dialogs.push(`${d.type()}: ${d.message()}`); try { await d.dismiss() } catch {} })

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("button:has-text('Open Project')", { timeout: 10000 })

  // ── Open the project through the server-backed picker ───────────────────
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
    } catch { /* retry */ }
  }
  if (!navigated) throw new Error("picker did not navigate to the project path")
  await page.waitForSelector(`.lw-btn.primary:has-text('Select')`, { timeout: 5000 })
  await page.click(".lw-btn.primary")
  await waitFor(async () => (await page.$$(".lw-overlay")).length === 0, 5000, "picker closed")
  // The main workspace renders once a project is open (the Knowledge tree
  // intentionally skips structural index.md/log.md pages, so the old
  // text=Index marker is no longer produced — the empty preview pane is the
  // stable post-open signal).
  await page.waitForSelector("text=Select a file to preview", { timeout: 15000 })
  ok(true, "project opened via picker (desktop-configured MinerU in the shared store)")

  // ── The watcher auto-ingests sample.pdf through the MinerU path ─────────
  await waitFor(() => mineruSeen.submits.length >= 1, 30000, "MinerU task submitted via shim+proxy")
  ok(mineruSeen.submits.length === 1, `exactly ONE MinerU submit (no retries; got ${mineruSeen.submits.length})`)
  const submit = mineruSeen.submits[0]
  ok(!submit.parseError, `mock MinerU parsed the multipart body (${submit.parseError ?? "ok"})`)
  if (!submit.parseError) {
    ok(/^multipart\/form-data; boundary=/.test(submit.contentType), `request is real multipart/form-data (got "${submit.contentType.slice(0, 60)}")`)
    ok(submit.fields.backend === "hybrid-engine" && submit.fields.return_md === "true" && submit.fields.parse_method === "auto", "multipart text fields delivered (backend/return_md/parse_method)")
    ok(submit.fields.lang_list === "ch" && submit.fields.effort === "medium", "multipart text fields delivered (lang_list/effort defaults)")
    const file = submit.files.find((f) => f.name === "files")
    ok(Boolean(file), `multipart carries the "files" part (parts: ${submit.files.map((f) => f.name).join(",") || "none"})`)
    ok(Boolean(file) && file.fileName === "sample.pdf" && file.type === "application/pdf", `file part metadata intact (name=${file?.fileName}, type=${file?.type})`)
    ok(Boolean(file) && file.bytes.equals(PDF_BYTES), `UPLOADED PDF IS BYTE-EXACT (${file?.bytes.length ?? 0}/${PDF_BYTES.length} bytes, sha ${sha(file?.bytes ?? Buffer.alloc(0)).slice(0, 12)}… vs ${sha(PDF_BYTES).slice(0, 12)}…)`)
  } else {
    for (let i = 0; i < 5; i++) ok(false, "multipart assertion skipped (parse failed)")
  }

  // ── MinerU output lands in the shared ingest cache ──────────────────────
  await waitFor(() => fs.existsSync(cacheFile), 20000, "MinerU markdown cached")
  const cached = fs.readFileSync(cacheFile, "utf8")
  ok(cached.includes("MINERU-PARSE-MARKER"), "raw/sources/.cache/sample.pdf.txt carries the MinerU markdown (desktop-readable cache)")
  ok(cached.includes("media/sample/mineru/images/image-1.png"), "cached markdown's image refs were rewritten to the wiki media path")

  // ── The image from the MinerU result is written byte-exact ──────────────
  await waitFor(() => fs.existsSync(imageFile), 20000, "MinerU image written")
  const pngBytes = fs.readFileSync(imageFile)
  ok(pngBytes.equals(Buffer.from(PNG_B64, "base64")), `wiki/media/sample/mineru/images/image-1.png is byte-exact (${pngBytes.length} bytes)`)

  // ── The two LLM stages run over MinerU's text and write the page ────────
  await waitFor(() => fs.existsSync(summaryFile), 30000, "source-summary page written")
  const summary = fs.readFileSync(summaryFile, "utf8")
  ok(summary.includes(SUMMARY_MARKER), "wiki/sources/sample.md carries the mock LLM's summary body")
  ok(summary.includes("sample.pdf"), "summary page cites the PDF source")
  const analysisCalls = mockCalls.filter((c) => /expert research analyst/i.test(String((c.messages ?? []).find((m) => m.role === "system")?.content ?? "")))
  const generationCalls = mockCalls.filter((c) => /wiki maintainer/i.test(String((c.messages ?? []).find((m) => m.role === "system")?.content ?? "")))
  ok(analysisCalls.length === 1 && generationCalls.length === 1, `exactly the desktop's two LLM stages (analysis=${analysisCalls.length}, generation=${generationCalls.length})`)
  const genUser = String((generationCalls[0]?.messages ?? []).find((m) => m.role === "user")?.content ?? "")
  ok(genUser.includes("MINERU-PARSE-MARKER"), "generation call carried the MINERU text (not pdfjs fallback text)")

  // ── Queue reaches the terminal state (server-owned SQLite queue) ────────
  const taskPathMatches = (t) => !!t && (
    t.file_path === "raw/sources/sample.pdf" ||
    t.file_path === path.join(projectPath, "raw", "sources", "sample.pdf") ||
    String(t.file_path ?? "").endsWith("sample.pdf")
  )
  await waitFor(async () => {
    const uuid = await readProjectUuid()
    if (!uuid) return false
    const tasks = await fetchQueue(uuid)
    if (!tasks || !tasks.some((t) => taskPathMatches(t))) return false
    return tasks.filter((t) => taskPathMatches(t)).every((t) => t.status === "completed") &&
      !tasks.some((t) => t.status === "pending" || t.status === "processing")
  }, 20000, "queue task completed")
  ok(true, "ingest queue task completed (server-owned SQLite queue — single source of truth)")

  // ── The new page appears live in the Knowledge tree ─────────────────────
  await page.waitForSelector("text=Sample Doc", { timeout: 15000 })
  ok(true, "ingested page appears live in the Knowledge tree (no reload)")

  // ── Cleanliness ──────────────────────────────────────────────────────────
  await sleep(500)
  for (const probe of pendingProbes) {
    if (fs.existsSync(probe.abs)) optionalReads.push(probe.detail + " [probe-before-write: file now exists]")
    else badResponses.push(probe.detail)
  }
  ok(dialogs.length === 0, `ZERO alert/confirm dialogs (got ${dialogs.length})`)
  ok(pageErrors.length === 0, `ZERO page errors (got ${pageErrors.length}: ${pageErrors.slice(0, 3).join(" | ")})`)
  ok(consoleErrors.length === 0, `ZERO console errors (got ${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(" | ")})`)
  ok(badResponses.length === 0, `ZERO non-optional failed/4xx/5xx requests (got ${badResponses.length}: ${badResponses.slice(0, 4).join(" | ")})`)
  console.log(`        (${optionalReads.length} tolerated optional-state reads; mineru health probes: ${mineruSeen.health})`)

  if (fail > 0) {
    try { await page.screenshot({ path: "/tmp/lw-mineru-fail.png", fullPage: true }); console.log("  screenshot -> /tmp/lw-mineru-fail.png") } catch {}
  }
} catch (err) {
  fail++
  console.log("  FAIL- harness error:", err.message)
  console.log("--- server log ---\n" + serverLog.slice(-1500))
} finally {
  try { await browser?.close() } catch {}
  child.kill("SIGKILL")
  llmMock.close()
  mineruMock.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed (entry: ${ENTRY})`)
process.exit(fail > 0 ? 1 : 0)
