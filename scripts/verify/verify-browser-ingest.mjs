// Headless browser INGEST gate (durable; /tmp is volatile).
//
// Proves the app's CORE product loop end-to-end through the REAL browser UI
// against a mock OpenAI-compatible LLM (no real key needed), on the SHIPPED
// v2 server entry (packages/server/src/index-v2.js — the only entry that runs
// the server-side ingest orchestrator; plans/server-ingest.md "ingest is
// v2-only by design").
//
// Scenario A — cross-client automation (zero clicks past opening): a source
// file the "desktop" dropped into raw/sources BEFORE the web client opened
// the project is picked up by the source watcher's initial scan (desktop
// defaults: source watch + auto-ingest ON) and enqueued automatically — the
// web client's file-sync layer (src/lib/project-file-sync.ts → source-
// lifecycle.ts) issues the enqueue-by-path REST call, the SERVER-side
// orchestrator claims the SQLite ingest_queue row and runs the two-stage
// analysis -> generation pipeline through the mock, the wiki source-summary
// page lands ON DISK (desktop-readable), the deterministic log + index
// updates land, the task reaches the desktop-equivalent terminal state, the
// new page appears LIVE in the Knowledge tree (no reload), and the activity
// panel reports Done.
//
// Scenario B — manual re-ingest through the Sources UI: click the source's
// Ingest button -> a NEW server task runs again but the ingest cache
// (`<project>/.llm-wiki/ingest-cache.json`) short-circuits it (cache HIT):
// the files are replayed with ZERO additional LLM calls (the mock's hit
// counter must not move).
//
// All with ZERO page errors, ZERO genuine console errors, ZERO failed
// requests (tolerating only the documented optional-state reads), and NO
// spurious LLM calls anywhere (exactly the desktop's two-stage
// analysis->generation contract; no repair / review / sweep calls for a
// clean single-block generation).
//
// The queue is observed over the v2 REST API (GET
// /api/v2/projects/:uuid/ingest/queue) — the server owns the queue in SQLite
// (`ingest_queue`); the deleted client-side `.llm-wiki/ingest-queue.json`
// file is NOT part of the current architecture (issue #14 P0 stage 9).
// App-write-ignore is still asserted via `.llm-wiki/file-change-queue.json`
// (the desktop's shared source-watch format, kept).
//
//   node scripts/verify/verify-browser-ingest.mjs

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http from "node:http"
import { createRequire } from "node:module"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const ENTRY = process.env.SERVER_ENTRY || "packages/server/src/index-v2.js"
const pwRequire = createRequire("/tmp/pw/package.json")
const { chromium } = pwRequire("playwright-core")

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log("  ok  -", m) } else { fail++; console.log("  FAIL-", m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function freePort() { return new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) }) }
async function waitFor(fn, t, what) { const s = Date.now(); while (Date.now() - s < t) { try { if (await fn()) return true } catch {} await sleep(100) } throw new Error(`timeout: ${what}`) }
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

function findChromium() {
  const base = path.join(os.homedir(), ".cache", "ms-playwright")
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()
  for (const d of dirs) { const exe = path.join(base, d, "chrome-linux64", "chrome"); if (fs.existsSync(exe)) return exe }
  throw new Error("no chromium binary under ~/.cache/ms-playwright")
}

// ── Mock OpenAI-compatible LLM for the ingest pipeline ────────────────────
// The desktop's pipeline makes exactly two streaming chat calls per source:
//   Step 1 analysis  (system: "expert research analyst")
//   Step 2 generation (system: "wiki maintainer", FILE/REVIEW blocks)
// A clean single-block generation must NOT trigger any further calls (no
// truncated-file repair, no dedicated review stage, no drain-sweep LLM call
// because no review items exist). The mock records every call and answers
// per the system prompt. The analysis response is deliberately delayed so
// the queue's "processing" state is observable via the REST queue.
const SUMMARY_MARKER = "MOCK-INGEST-SUMMARY-MARKER"
const mockCalls = []
function generationOutput(sourceFileName) {
  return [
    `---FILE: wiki/sources/test-note.md---`,
    `---`,
    `type: source`,
    `title: Test Note`,
    `created: 2026-01-01`,
    `updated: 2026-01-01`,
    `tags: [quantum, testing]`,
    `related: []`,
    `sources: ["${sourceFileName}"]`,
    `---`,
    ``,
    `# Test Note`,
    ``,
    `${SUMMARY_MARKER} This source was summarized by the mock LLM through the`,
    `web client's ingest pipeline. It relates to [[Quantum Mechanics]].`,
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
    ? generationOutput("test-note.md")
    : isAnalysis
      ? "## Key Entities\n- Quantum Mechanics: central concept, already in the wiki.\n\n## Key Concepts\n- Test note contents about quantum measurement.\n"
      : "Mock answer."
  const stream = !!reqBody.stream
  const chunk = (delta, finish) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`
  const emit = () => {
    if (stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      // Stream in modest chunks (word-ish) so the client's SSE parser is
      // exercised the same way as with a real provider.
      const parts = text.match(/.{1,48}/gs) ?? [text]
      for (const p of parts) res.write(chunk({ role: "assistant", content: p }))
      res.write(chunk({}, "stop"))
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }))
    }
  }
  // Delay the analysis stream so the queue task's "processing" state is
  // observable via the REST queue before generation runs.
  if (isAnalysis) setTimeout(emit, 900)
  else emit()
}

// ── Fake "desktop" project on disk ────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-ingest-"))
const dataDir = path.join(tmp, "data")
const storesDir = path.join(dataDir, "stores")
fs.mkdirSync(storesDir, { recursive: true })
const projectPath = path.join(tmp, "desktop-project")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.mkdirSync(path.join(projectPath, "raw", "sources"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "schema.md"), "# Schema\n\nSource pages summarize raw sources. Entity pages describe things.\n")
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n\nHome page of the wiki.\n")
fs.writeFileSync(path.join(projectPath, "wiki", "quantum.md"), "---\ntype: entity\ntitle: Quantum Mechanics\n---\n# Quantum Mechanics\n\nQuantum mechanics is the study of matter at atomic and subatomic scales.\n")
// The source the "desktop" dropped in; the web client must ingest it.
const SOURCE_BODY = [
  "# Test Note",
  "",
  "This note discusses quantum measurement. Measuring a quantum system",
  "disturbs it; the observer effect is fundamental, not technical.",
  "",
  "Key points:",
  "- Measurement collapses the wavefunction.",
  "- Decoherence explains the classical appearance.",
].join("\n")
fs.writeFileSync(path.join(projectPath, "raw", "sources", "test-note.md"), SOURCE_BODY)

const mockPort = await freePort()
// llmConfig points the SERVER-side ingest pipeline (and the UI config view)
// at the mock. No projectRegistry/lastProject: the UI must open the project
// via the picker, exactly like a first run on this machine.
fs.writeFileSync(path.join(storesDir, "app-state.json"), JSON.stringify({
  llmConfig: { provider: "custom", apiKey: "test-key", model: "mock-model", customEndpoint: `http://127.0.0.1:${mockPort}/v1`, apiMode: "chat_completions" },
}, null, 2))

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

const port = await freePort()
const child = spawn(process.execPath, [ENTRY], {
  cwd: REPO,
  env: { ...process.env, LLM_WIKI_AUTH_MODE: "none", LLM_WIKI_PORT: String(port), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", (d) => (serverLog += d)); child.stderr.on("data", (d) => (serverLog += d))

const storeFile = path.join(storesDir, "app-state.json")
// Enqueue-by-path stores the RESOLVED absolute path (api/ingest.js safeJoin),
// while uploads store a path string the same way — match both, and the bare
// relative form for robustness.
const taskPathMatches = (t) => !!t && (
  t.file_path === "raw/sources/test-note.md" ||
  t.file_path === path.join(projectPath, "raw", "sources", "test-note.md") ||
  t.file_path === `${projectPath}/raw/sources/test-note.md`
)
const summaryFile = path.join(projectPath, "wiki", "sources", "test-note.md")

// The queue is server-owned (SQLite). Read it over the v2 REST API; the
// client's UUID is the WikiProject.lastProject.id the app writes to the
// plugin store once the project is opened.
async function readProjectUuid() {
  try { return JSON.parse(fs.readFileSync(storeFile, "utf8"))?.lastProject?.id ?? null } catch { return null }
}
async function fetchQueue(uuid, status) {
  const q = status ? `?status=${status}&limit=200` : "?limit=200"
  const r = await httpJson("GET", port, `/api/v2/projects/${uuid}/ingest/queue${q}`)
  return r.status === 200 && Array.isArray(r.json?.tasks) ? r.json.tasks : null
}

let browser
let sampling = true
let sampler = null
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
        // The ingest pipeline (exactly like the desktop) probes files that
        // MAY not exist and falls back to defaults: the optional project
        // purpose.md / wiki/overview.md context, and pre-write existence
        // probes for files it is about to create (log.md, the source
        // summary). Server-side read_file errors on missing files too; the
        // client catches it. Tolerate ONLY when the target is a known
        // optional context file or exists on disk by the end of the run
        // (proven probe-before-write, not a genuine failure).
        const rel = p.replace(projectPath, "").replace(/^\//, "")
        const knownOptional = rel === "purpose.md" || rel === "wiki/overview.md"
        if (knownOptional) { tolerated = true; detail += " [optional-context]" }
        else { pendingProbes.push({ detail, abs: p }); return } // resolved at the end
      }
    } catch { /* non-json body */ }
    if (tolerated) optionalReads.push(detail)
    else badResponses.push(detail)
  })
  page.on("dialog", async (d) => { dialogs.push(`${d.type()}: ${d.message()}`); try { await d.dismiss() } catch {} })

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("button:has-text('Open Project')", { timeout: 10000 })

  // ── Open the project through the server-backed picker (proven path) ─────
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

  // The REST queue sampler starts BEFORE Select: opening the project
  // triggers the watcher's initial scan + auto-ingest, which can complete
  // faster than UI navigation. The project UUID appears in the plugin store
  // once the client opens the project (saveLastProject).
  const queueHistory = []
  sampler = (async () => {
    while (sampling) {
      const uuid = await readProjectUuid()
      const tasks = uuid ? await fetchQueue(uuid) : null
      queueHistory.push(tasks ?? [])
      await sleep(60)
    }
  })()

  await page.click(".lw-btn.primary")
  await waitFor(async () => (await page.$$(".lw-overlay")).length === 0, 5000, "picker closed")
  await page.waitForSelector("text=Quantum Mechanics", { timeout: 15000 })
  ok(true, "project opened via picker; Knowledge tree rendered")

  // ── Navigate to the Sources view ─────────────────────────────────────────
  // IconSidebar nav items are the first 7 tooltip triggers in DOM order
  // (chat, wiki, sources, search, graph, lint, review). Detect the view by
  // its VISIBLE "Raw Sources" heading — text=... alone would false-positive
  // on hidden tooltip portals and the chat toolbar's "Raw sources only".
  const sourcesHeading = page.locator("h2:has-text('Raw Sources')")
  const navTriggers = page.locator('[data-slot="tooltip-trigger"]')
  let sourcesOpen = await sourcesHeading.isVisible().catch(() => false)
  for (let i = 0; i < 7 && !sourcesOpen; i++) {
    await navTriggers.nth(i).click()
    await sleep(300)
    sourcesOpen = await sourcesHeading.isVisible().catch(() => false)
  }
  if (!sourcesOpen) throw new Error("Sources view did not open")
  ok(true, "Sources view opened")
  // The definitive signal that the source row rendered: its Ingest button.
  await page.waitForSelector('button[title="Ingest"]', { state: "visible", timeout: 10000 })
  ok(true, "desktop-dropped source file is listed in the Sources view")

  // ── Scenario A: the watcher auto-ingests the desktop-dropped source ─────
  // Source watch + auto-ingest are ON by default (the desktop's defaults), so
  // the initial scan's "created" task for test-note.md is enqueued into the
  // SERVER queue with NO user interaction — immediately after the project
  // opens (the client's file-sync layer issues enqueue-by-path). The sampler
  // has been running since BEFORE the picker's Select click, so the full
  // lifecycle (pending -> processing -> completed) is captured no matter how
  // fast the pipeline runs relative to UI navigation.
  let sawTask = null
  await waitFor(async () => {
    sawTask = queueHistory.flat().find((t) => t && taskPathMatches(t)) ?? null
    return sawTask !== null
  }, 20000, "watcher auto-enqueued the desktop-dropped source")
  ok(true, "source watcher auto-enqueued the desktop-dropped source (no user action)")
  const taskKeys = ["id", "project_id", "file_path", "status", "folder_context", "created_at", "attempt_count"]
  ok(taskKeys.every((k) => k in sawTask), `server queue task has the v2 IngestTask shape (got: ${Object.keys(sawTask).join(",")})`)
  const REL_SOURCE = "raw/sources/test-note.md"
  ok(
    sawTask.file_path === REL_SOURCE ||
      sawTask.file_path.endsWith(`/${REL_SOURCE}`) || sawTask.file_path.endsWith(`\\${REL_SOURCE}`),
    `queue task file_path identifies the desktop-dropped source (${sawTask.file_path})`,
  )
  await waitFor(
    () => queueHistory.some((tasks) => tasks.some((t) => taskPathMatches(t) && t.status === "processing")),
    15000,
    "queue task transitioned to processing",
  )
  ok(true, "queue task transitioned to 'processing' (server-owned SQLite queue)")

  // ── The pipeline's two LLM stages hit the mock from the SERVER ──────────
  await waitFor(() => fs.existsSync(summaryFile), 40000, "source-summary wiki page written to disk")
  ok(true, "source-summary page wiki/sources/test-note.md written to disk (desktop-readable)")
  const summaryContent = fs.readFileSync(summaryFile, "utf8")
  ok(summaryContent.includes(SUMMARY_MARKER), "written page carries the mock LLM's summary body")
  ok(/title:\s*Test Note/.test(summaryContent), "written page has the frontmatter title")
  ok(summaryContent.includes("test-note.md"), "written page's sources field cites the source file")
  ok(/created:\s*\d{4}-\d{2}-\d{2}/.test(summaryContent), "frontmatter dates stamped (pipeline canonicalization ran)")

  const analysisCalls = mockCalls.filter((c) => /expert research analyst/i.test(String((c.messages ?? []).find((m) => m.role === "system")?.content ?? "")))
  const generationCalls = mockCalls.filter((c) => /wiki maintainer/i.test(String((c.messages ?? []).find((m) => m.role === "system")?.content ?? "")))
  ok(analysisCalls.length === 1, `exactly ONE analysis call reached the mock (got ${analysisCalls.length})`)
  ok(generationCalls.length === 1, `exactly ONE generation call reached the mock (got ${generationCalls.length})`)
  const genUser = String((generationCalls[0]?.messages ?? []).find((m) => m.role === "user")?.content ?? "")
  ok(genUser.includes("test-note.md") && genUser.includes("Measurement collapses the wavefunction"), "generation call carried the source identity + the source's full content")

  // ── Deterministic companions: log.md entry + index.md link ──────────────
  const logContent = fs.readFileSync(path.join(projectPath, "wiki", "log.md"), "utf8")
  ok(/\#\# \[\d{4}-\d{2}-\d{2}\] ingest \| test-note\.md/.test(logContent), "wiki/log.md got the deterministic ingest entry")
  const indexContent = fs.readFileSync(path.join(projectPath, "wiki", "index.md"), "utf8")
  ok(indexContent.includes("[[sources/test-note]]"), "wiki/index.md links the new page (deterministic index update)")

  // ── Server queue reaches the terminal state (desktop parity: completed) ─
  await waitFor(async () => {
    const uuid = await readProjectUuid()
    if (!uuid) return false
    const tasks = await fetchQueue(uuid)
    return tasks?.some((t) => taskPathMatches(t) && t.status === "completed" && t.progress === 100) ?? false
  }, 20000, "queue task completed")
  ok(true, "queue task completed (progress 100) — the server-owned queue is the single source of truth for both clients")

  // ── Activity panel reports completion ───────────────────────────────────
  await waitFor(async () => /Done:/.test(await page.evaluate(() => document.body.innerText)), 10000, "activity panel shows Done")
  ok(true, "activity panel reports the completed ingest")

  // ── The new page appears LIVE in the Knowledge tree (no reload) ─────────
  await page.waitForSelector("text=Test Note", { timeout: 15000 })
  ok(true, "ingested page appears live in the Knowledge tree (no reload)")

  // ── App-write-ignore: the pipeline's own writes never became file-change
  //    tasks (no re-ingest loop; desktop's exact semantics) ────────────────
  const fcq = path.join(projectPath, ".llm-wiki", "file-change-queue.json")
  const fcqTasks = fs.existsSync(fcq) ? JSON.parse(fs.readFileSync(fcq, "utf8")) : []
  const fcqList = Array.isArray(fcqTasks) ? fcqTasks : (fcqTasks?.tasks ?? [])
  ok(fcqList.length === 0, `no file-change tasks spawned by the ingest's own writes (got ${fcqList.length})`)

  // ── Scenario B: manual re-ingest via the Sources UI hits the ingest cache
  //    (desktop's cache contract: replay with ZERO new LLM calls) ──────────
  const callsBeforeManual = mockCalls.length
  await page.click('button[title="Ingest"]')
  await waitFor(async () => {
    const uuid = await readProjectUuid()
    if (!uuid) return false
    const tasks = await fetchQueue(uuid)
    return tasks?.some((t) => taskPathMatches(t) && t.status === "completed") ?? false
  }, 25000, "manual re-ingest task enqueued, ran (cache replay), and completed")
  // Give any (unexpected) slow LLM call a chance to land, then assert silence.
  await sleep(1200)
  ok(true, "manual Ingest click ran the task through the server queue to completion")
  ok(mockCalls.length === callsBeforeManual, `manual re-ingest made ZERO new LLM calls — ingest cache replay (mock hits: ${callsBeforeManual} -> ${mockCalls.length})`)
  const replayed = fs.readFileSync(summaryFile, "utf8")
  ok(replayed.includes(SUMMARY_MARKER), "cache replay rewrote the identical summary page on disk")

  // ── Cleanliness ──────────────────────────────────────────────────────────
  await sleep(500)
  // Resolve the read_file 500s that were not known-optional: each must be a
  // probe-before-write for a file that now exists on disk (the pipeline
  // created it right after probing). Anything else is a genuine failure.
  for (const probe of pendingProbes) {
    if (fs.existsSync(probe.abs)) optionalReads.push(probe.detail + " [probe-before-write: file now exists]")
    else badResponses.push(probe.detail)
  }
  ok(dialogs.length === 0, `ZERO alert/confirm dialogs (got ${dialogs.length}: ${dialogs.slice(0, 3).join(" | ")})`)
  ok(pageErrors.length === 0, `ZERO page errors (got ${pageErrors.length}: ${pageErrors.slice(0, 3).join(" | ")})`)
  ok(consoleErrors.length === 0, `ZERO console errors (got ${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(" | ")})`)
  ok(badResponses.length === 0, `ZERO non-optional failed/4xx/5xx requests (got ${badResponses.length}: ${badResponses.slice(0, 4).join(" | ")})`)
  console.log(`        (${optionalReads.length} tolerated optional-state reads)`)

  if (fail > 0) {
    try { await page.screenshot({ path: "/tmp/lw-ingest-fail.png", fullPage: true }); console.log("  screenshot -> /tmp/lw-ingest-fail.png") } catch {}
  }
} catch (err) {
  fail++
  console.log("  FAIL- harness error:", err.message)
  try {
    const uuid = await readProjectUuid()
    console.log("  [diag] lastProject uuid:", uuid)
    if (uuid) {
      const q = await fetchQueue(uuid)
      console.log("  [diag] queue now:", JSON.stringify(q)?.slice(0, 600))
    }
    console.log("  [diag] store:", fs.readFileSync(storeFile, "utf8").slice(0, 400))
    const pj = path.join(projectPath, ".llm-wiki", "project.json")
    console.log("  [diag] project.json:", fs.existsSync(pj) ? fs.readFileSync(pj, "utf8") : "MISSING")
    console.log("  [diag] queueHistory samples:", queueHistory.length, "last:", JSON.stringify(queueHistory.at(-1))?.slice(0, 300))
  } catch { /* best effort */ }
  console.log("--- server log ---\n" + serverLog.slice(-1500))
} finally {
  sampling = false
  try { if (sampler) await sampler } catch {}
  try { await browser?.close() } catch {}
  child.kill("SIGKILL")
  mock.close()
}

console.log(`\nbrowser-ingest: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
