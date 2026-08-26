// Headless SCHEDULED IMPORT gate (durable; /tmp is volatile).
//
// The desktop feature: the app periodically scans a user-chosen OUTSIDE
// folder and copies new/changed ingestible files into <project>/raw/sources/
// scheduled-import/, recording md5s in .llm-wiki/scheduled-import-db.json,
// then enqueues the copies for ingest. The scan is frontend-driven but every
// filesystem primitive is an invoke() command, so in web mode it all runs
// through the server — which runs on the host and CAN read the outside
// folder. Config lives in the shared plugin-store (scheduledImportConfig:
// <projectPath>), so a schedule set on the desktop runs on the web client.
//
// Part A (server contract, no browser) pins the watcher-critical fs command
// contract that scheduled import depends on — the desktop marks copy_file /
// copy_directory / delete_file destinations as APP WRITES (fs.rs) so the
// source watcher never turns the app's own copies/deletes into change tasks
// in the SHARED file-change-queue.json (which both clients process):
//   A1 copy_file into raw/sources creates NO change task and is silently
//      synced into the snapshot (app-write-ignore), surviving the periodic
//      safety-net rescan.
//   A2 copy_directory keeps the desktop contract: destination marked, the
//      exact "'X' is not a directory" error, dotfiles skipped at every
//      level, ONLY file paths returned, no change tasks.
//   A3 delete_file of an app-copied source creates NO "deleted" task.
//   A4 contrast: an out-of-band file written straight to disk DOES produce
//      a "created" change task (the watcher is provably alive, so A1-A3 are
//      meaningful).
//
// Part B (real browser UI) proves the feature end-to-end: the "desktop"
// writes the schedule + LLM config into the store file out-of-band; the web
// client opens the project through the picker, hydrates the schedule, and
// the immediate scan copies the ingestible files (nested structure kept,
// dotfile + config-extension files skipped), writes the desktop-format db,
// enqueues ingest, and the mock-LLM summaries land on disk — while the
// concurrently running source watcher stays SILENT (zero change tasks, zero
// extra LLM calls), all with zero page/console/request errors.
//
//   node scripts/verify/verify-scheduled-import.mjs
//   SERVER_ENTRY=packages/server/src/index-v2.js node scripts/verify/verify-scheduled-import.mjs

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
// The v2/Docker entrypoint wraps invoke results as { ok, result } and serves
// SSE on /api/v2/events; the legacy entry returns raw results on /api/events.
const V2_INVOKE = ENTRY.includes("index-v2")
const EVENTS_PATH = V2_INVOKE ? "/api/v2/events" : "/api/events"
const pwRequire = createRequire("/tmp/pw/package.json")
const { chromium } = pwRequire("playwright-core")

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log("  ok  -", m) } else { fail++; console.log("  FAIL-", m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function freePort() { return new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) }) }
async function waitFor(fn, t, what) { const s = Date.now(); while (Date.now() - s < t) { try { if (await fn()) return true } catch {} await sleep(100) } throw new Error(`timeout: ${what}`) }
const md5 = (buf) => crypto.createHash("md5").update(buf).digest("hex")

function findChromium() {
  const base = path.join(os.homedir(), ".cache", "ms-playwright")
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()
  for (const d of dirs) { const exe = path.join(base, d, "chrome-linux64", "chrome"); if (fs.existsSync(exe)) return exe }
  throw new Error("no chromium binary under ~/.cache/ms-playwright")
}

function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body)
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
      let buf = ""
      res.on("data", (c) => (buf += c))
      res.on("end", () => { try { resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }) } catch { resolve({ status: res.statusCode, raw: buf }) } })
    })
    r.on("error", reject)
    if (data) r.write(data)
    r.end()
  })
}
const invoke = (port, cmd, args) => req(port, "POST", `/api/invoke/${cmd}`, args)
const invokeResult = async (port, cmd, args) => { const r = await invoke(port, cmd, args); return V2_INVOKE ? r.json?.result : r.json }
const invokeError = (r) => (V2_INVOKE ? r?.json?.error?.message ?? r?.json?.error?.code : r?.json?.error ?? r?.raw) ?? ""

function sseCollect(port) {
  const events = []
  const rq = http.request({ host: "127.0.0.1", port, path: EVENTS_PATH, method: "GET" }, (res) => {
    let buf = ""
    res.on("data", (c) => {
      buf += c.toString()
      let idx
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2)
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue
          try { events.push(JSON.parse(line.slice(5).trim())) } catch { /* comment/ping */ }
        }
      }
    })
  })
  rq.on("error", () => {})
  rq.end()
  return { events, close: () => rq.destroy() }
}

function readQueue(projectPath) {
  try { return JSON.parse(fs.readFileSync(path.join(projectPath, ".llm-wiki", "file-change-queue.json"), "utf-8")) } catch { return { tasks: [] } }
}
function readSnapshot(projectPath) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(projectPath, ".llm-wiki", "file-snapshot.json"), "utf-8"))
    return j && typeof j === "object" && j.files ? j.files : j
  } catch { return {} }
}

async function startServer(env) {
  const port = await freePort()
  const child = spawn(process.execPath, [ENTRY], {
    cwd: REPO,
    env: { ...process.env, LLM_WIKI_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let log = ""
  child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d))
  await waitFor(async () => {
    const r = await new Promise((res) => { const q = http.get({ host: "127.0.0.1", port, path: "/api/health" }, (x) => res(x.statusCode)); q.on("error", () => res(0)) })
    return r === 200
  }, 8000, "server health")
  return { port, child, getLog: () => log }
}

function scaffoldProject(projectPath) {
  fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
  fs.mkdirSync(path.join(projectPath, "raw", "sources"), { recursive: true })
  fs.writeFileSync(path.join(projectPath, "schema.md"), "# Schema\n\nSource pages summarize raw sources.\n")
  fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n\nHome page.\n")
}

// ════════════════════════════════════════════════════════════════════════
// Part A — server contract: copy/delete app-write-ignore + watcher silence
// ════════════════════════════════════════════════════════════════════════
console.log(`scheduled-import (entry: ${ENTRY})`)
console.log("A. copy/delete app-write-ignore contract (shared source queue)")
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-sched-a-"))
  const dataDir = path.join(tmp, "data")
  const projectPath = path.join(tmp, "project")
  scaffoldProject(projectPath)
  const inbox = path.join(tmp, "inbox")
  fs.mkdirSync(inbox, { recursive: true })
  fs.writeFileSync(path.join(inbox, "alpha.md"), "# Alpha\n\noutside note.\n")

  const { port, child } = await startServer({ LLM_WIKI_NO_SHARE: "1", LLM_WIKI_AUTH_MODE: "none", LLM_WIKI_DATA_DIR: dataDir })
  const sse = sseCollect(port)
  try {
    await invoke(port, "start_project_file_watcher", { projectId: "proj-1", projectPath })
    await sleep(300)
    const t0 = Date.now()

    // A1. copy_file into raw/sources/scheduled-import (the exact scheduled-
    // import destination) must not become a change task.
    const destA = path.join(projectPath, "raw", "sources", "scheduled-import", "alpha.md")
    const cp = await invoke(port, "copy_file", { source: path.join(inbox, "alpha.md"), destination: destA })
    ok(cp.status === 200, "copy_file outside->raw/sources/scheduled-import succeeded")
    ok(fs.existsSync(destA) && fs.readFileSync(destA, "utf-8").includes("outside note."), "copied file on disk with source content")

    // A2. copy_directory: dotfiles skipped, files-only return shape, no tasks.
    const folderSrc = path.join(tmp, "import-folder")
    fs.mkdirSync(path.join(folderSrc, "sub"), { recursive: true })
    fs.writeFileSync(path.join(folderSrc, "beta.md"), "# Beta\n")
    fs.writeFileSync(path.join(folderSrc, "sub", "gamma.txt"), "gamma text\n")
    fs.writeFileSync(path.join(folderSrc, ".hidden.md"), "# hidden, must NOT be copied\n")
    fs.writeFileSync(path.join(folderSrc, "sub", ".keep"), "hidden nested\n")
    const destDir = path.join(projectPath, "raw", "sources", "imported-folder")
    const cd = await invoke(port, "copy_directory", { source: folderSrc, destination: destDir })
    ok(cd.status === 200, "copy_directory succeeded")
    const returned = await invokeResult(port, "copy_directory", { source: folderSrc, destination: destDir })
    const expected = [path.join(destDir, "beta.md"), path.join(destDir, "sub", "gamma.txt")]
    ok(Array.isArray(returned) && returned.length === 2 && expected.every((e) => returned.includes(e)),
      `copy_directory returned ONLY the copied file paths (got ${JSON.stringify(returned)})`)
    ok(!fs.existsSync(path.join(destDir, ".hidden.md")) && !fs.existsSync(path.join(destDir, "sub", ".keep")),
      "copy_directory skipped dotfiles at every level (desktop contract)")
    ok(fs.existsSync(path.join(destDir, "beta.md")) && fs.existsSync(path.join(destDir, "sub", "gamma.txt")),
      "copy_directory copied the regular files with structure")
    const cdErr = await invoke(port, "copy_directory", { source: path.join(folderSrc, "beta.md"), destination: path.join(tmp, "nope") })
    ok(cdErr.status !== 200 && String(invokeError(cdErr)).includes(`'${path.join(folderSrc, "beta.md")}' is not a directory`),
      "copy_directory keeps the desktop's exact not-a-directory error")

    // A3. delete_file of an app-copied source must not become a "deleted" task.
    const del = await invoke(port, "delete_file", { path: path.join(destDir, "beta.md") })
    ok(del.status === 200 && !fs.existsSync(path.join(destDir, "beta.md")), "delete_file removed the app-copied source")

    // Let the event-driven pipeline (700ms debounce) run its course.
    await sleep(1600)
    const q1 = readQueue(projectPath).tasks
    ok(!q1.some((t) => String(t.path).includes("scheduled-import/alpha.md")), "copy_file produced NO change task in the shared queue")
    ok(!q1.some((t) => String(t.path).includes("imported-folder")), "copy_directory produced NO change task in the shared queue")
    ok(!q1.some((t) => String(t.path).includes("beta.md") && t.kind === "deleted"), "delete_file produced NO 'deleted' change task")
    const snap1 = readSnapshot(projectPath)
    ok(Boolean(snap1["raw/sources/scheduled-import/alpha.md"]?.hash), "app-written copy silently synced into the snapshot (hash present)")
    ok(Boolean(snap1["raw/sources/imported-folder/sub/gamma.txt"]?.hash), "copy_directory files silently synced into the snapshot")
    ok(!("raw/sources/imported-folder/beta.md" in snap1), "deleted file silently synced OUT of the snapshot")
    const fsChanged = sse.events.filter((e) => e.event === "file-sync://changed" &&
      /scheduled-import|imported-folder/.test(JSON.stringify(e.payload ?? {})))
    ok(fsChanged.length === 0, "no file-sync://changed task events for the app's own copies/deletes")

    // A4. contrast: an out-of-band write MUST still produce a task. Observe
    // it through EITHER the queue file or the file-sync://changed SSE event:
    // the desktop contract has process_queue consume (and delete) done tasks
    // immediately, so the queue-file window can be sub-millisecond; the SSE
    // broadcast is the desktop's own durable notification of the same task.
    fs.writeFileSync(path.join(projectPath, "raw", "sources", "outofband.md"), "# out of band\n")
    const sawOutOfBand = () =>
      readQueue(projectPath).tasks.some((t) => t.path === "raw/sources/outofband.md" && t.kind === "created") ||
      sse.events.some((e) => e.event === "file-sync://changed" &&
        (e.payload?.tasks ?? []).some((t) => t.path === "raw/sources/outofband.md" && t.kind === "created"))
    await waitFor(sawOutOfBand, 6000, "out-of-band created task")
    ok(true, "contrast: out-of-band raw/sources write DID produce a 'created' change task (watcher alive)")

    // Survive the 10s periodic safety-net rescan: still no tasks for app writes.
    const elapsed = Date.now() - t0
    if (elapsed < 11000) await sleep(11000 - elapsed)
    const q2 = readQueue(projectPath).tasks
    ok(!q2.some((t) => /scheduled-import|imported-folder/.test(String(t.path))),
      "periodic safety-net rescan created no tasks for the app-written paths either")

    await invoke(port, "stop_project_file_watcher", {})
  } finally {
    sse.close()
    child.kill("SIGTERM")
  }
}

// ════════════════════════════════════════════════════════════════════════
// Part B — real browser e2e: desktop-written schedule runs on the web client
// ════════════════════════════════════════════════════════════════════════
console.log("B. scheduled import end-to-end through the real browser UI")
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-sched-b-"))
  const dataDir = path.join(tmp, "data")
  const storesDir = path.join(dataDir, "stores")
  fs.mkdirSync(storesDir, { recursive: true })
  const projectPath = path.join(tmp, "desktop-project")
  scaffoldProject(projectPath)

  // The OUTSIDE folder the "desktop" configured. Mixed content: two
  // ingestibles (one nested), a dotfile, and a config-extension file — the
  // scan must import exactly the two ingestibles.
  const inbox = path.join(tmp, "inbox")
  fs.mkdirSync(path.join(inbox, "nested"), { recursive: true })
  const NOTE_BODY = "# Field Note\n\nSolar flux varies with the sunspot cycle.\n"
  const NESTED_BODY = "Nested observations of sunspot groups.\n"
  fs.writeFileSync(path.join(inbox, "note.md"), NOTE_BODY)
  fs.writeFileSync(path.join(inbox, "nested", "sunspots.txt"), NESTED_BODY)
  fs.writeFileSync(path.join(inbox, ".hidden-note.md"), "# must never be imported\n")
  fs.writeFileSync(path.join(inbox, "settings.json"), '{"agent": "keys must not enter ingest"}')

  // Mock OpenAI-compatible LLM (same two-stage contract as the ingest gate).
  const mockCalls = []
  const mockPort = await freePort()
  function generationOutput(sourceRel) {
    const stem = path.basename(sourceRel).replace(/\.[^.]+$/, "")
    return [
      `---FILE: wiki/sources/${stem}.md---`,
      `---`,
      `type: source`,
      `title: ${stem}`,
      `created: 2026-01-01`,
      `updated: 2026-01-01`,
      `tags: []`,
      `related: []`,
      `sources: ["${sourceRel}"]`,
      `---`,
      ``,
      `# ${stem}`,
      ``,
      `MOCK-SCHEDULED-IMPORT-SUMMARY for ${sourceRel}.`,
      `---END FILE---`,
      ``,
    ].join("\n")
  }
  const mock = http.createServer((rq, rs) => {
    let buf = ""
    rq.on("data", (c) => (buf += c))
    rq.on("end", () => {
      if (rq.method !== "POST" || !rq.url.includes("/chat/completions")) { rs.writeHead(404); rs.end("nope"); return }
      let body
      try { body = JSON.parse(buf) } catch { rs.writeHead(400); rs.end("bad json"); return }
      mockCalls.push(body)
      const sys = String((body.messages ?? []).find((m) => m.role === "system")?.content ?? "")
      const user = String((body.messages ?? []).find((m) => m.role === "user")?.content ?? "")
      const isAnalysis = /expert research analyst/i.test(sys)
      const isGeneration = /wiki maintainer/i.test(sys)
      const sourceRel = user.includes("nested/sunspots.txt") ? "raw/sources/scheduled-import/nested/sunspots.txt"
        : user.includes("note.md") ? "raw/sources/scheduled-import/note.md" : null
      const text = isGeneration
        ? generationOutput(sourceRel ?? "raw/sources/scheduled-import/note.md")
        : isAnalysis
          ? "## Key Entities\n- Sunspots.\n"
          : "Mock answer."
      const stream = !!body.stream
      const emit = () => {
        if (stream) {
          rs.writeHead(200, { "Content-Type": "text/event-stream" })
          const parts = text.match(/.{1,48}/gs) ?? [text]
          for (const p of parts) rs.write(`data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: p }, finish_reason: null }] })}\n\n`)
          rs.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`)
          rs.end("data: [DONE]\n\n")
        } else {
          rs.writeHead(200, { "Content-Type": "application/json" })
          rs.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }))
        }
      }
      if (isAnalysis) setTimeout(emit, 300)
      else emit()
    })
  })
  await new Promise((r) => mock.listen(mockPort, r))

  // The "desktop" wrote the schedule + LLM config into the shared store
  // out-of-band. The web client must pick them up with NO restart/reload.
  fs.writeFileSync(path.join(storesDir, "app-state.json"), JSON.stringify({
    llmConfig: { provider: "custom", apiKey: "test-key", model: "mock-model", customEndpoint: `http://127.0.0.1:${mockPort}/v1`, apiMode: "chat_completions" },
    [`scheduledImportConfig:${projectPath}`]: { enabled: true, path: inbox, interval: 1, lastScan: null },
  }, null, 2))

  const { port, child } = await startServer({ LLM_WIKI_NO_SHARE: "1", LLM_WIKI_AUTH_MODE: "none", LLM_WIKI_DATA_DIR: dataDir })
  const storeFile = path.join(storesDir, "app-state.json")
  const dbFile = path.join(projectPath, ".llm-wiki", "scheduled-import-db.json")
  const changeQueueFile = path.join(projectPath, ".llm-wiki", "file-change-queue.json")
  // The ingest queue is SERVER-owned (SQLite) — the deleted client-side
  // .llm-wiki/ingest-queue.json no longer exists. Observe it over the v2 REST
  // API; the client's UUID is the WikiProject lastProject.id the app writes to
  // the shared plugin store once the project is opened.
  async function readProjectUuid() {
    try { return JSON.parse(fs.readFileSync(storeFile, "utf8"))?.lastProject?.id ?? null } catch { return null }
  }
  async function fetchQueue(uuid, status) {
    const q = status ? `?status=${status}&limit=200` : "?limit=200"
    const r = await req(port, "GET", `/api/v2/projects/${uuid}/ingest/queue${q}`)
    return r.status === 200 && Array.isArray(r.json?.tasks) ? r.json.tasks : null
  }
  let browser
  try {
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
      const r = resp.request()
      const u = r.url()
      let detail = `HTTP ${resp.status()} ${r.method()} ${u}`
      let tolerated = false
      try {
        const body = r.postDataJSON?.() ?? {}
        const p = typeof body?.path === "string" ? body.path : ""
        const cmd = u.split("/api/invoke/").pop()
        detail += ` [${cmd} ${p.replace(projectPath, "")}]`
        if (p.includes("/.llm-wiki/") && (cmd === "read_file" || cmd === "list_directory")) {
          tolerated = true
          detail += " [optional-state]"
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

    // Open the project through the server-backed picker.
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
    await page.click(`.lw-btn.primary:has-text('Select')`)

    // The app hydrates the desktop-written schedule and scans immediately.
    const destNote = path.join(projectPath, "raw", "sources", "scheduled-import", "note.md")
    const destNested = path.join(projectPath, "raw", "sources", "scheduled-import", "nested", "sunspots.txt")
    await waitFor(() => fs.existsSync(destNote) && fs.existsSync(destNested), 20000, "scheduled scan copied the ingestible files")
    ok(true, "scan copied note.md + nested/sunspots.txt into raw/sources/scheduled-import/ (server-mediated)")
    ok(fs.readFileSync(destNote, "utf-8") === NOTE_BODY, "copied note.md carries the source content byte-for-byte")
    ok(!fs.existsSync(path.join(projectPath, "raw", "sources", "scheduled-import", ".hidden-note.md")),
      "dotfile .hidden-note.md was NOT imported")
    ok(!fs.existsSync(path.join(projectPath, "raw", "sources", "scheduled-import", "settings.json")),
      "config-extension settings.json was NOT imported")

    // Desktop-format scan database with md5s of the imported files.
    await waitFor(() => fs.existsSync(dbFile), 10000, "scheduled-import-db.json written")
    const db = JSON.parse(fs.readFileSync(dbFile, "utf-8"))
    const dbDir = db.directories?.[inbox]
    ok(db.version === 1 && Boolean(dbDir), "db has the desktop shape { version: 1, directories: { <importPath>: ImportDb } }")
    ok(dbDir?.files?.[path.join(inbox, "note.md")] === md5(NOTE_BODY), "db recorded the md5 of note.md")
    ok(dbDir?.files?.[path.join(inbox, "nested", "sunspots.txt")] === md5(NESTED_BODY), "db recorded the md5 of nested/sunspots.txt")
    ok(typeof dbDir?.lastScan === "number" && dbDir.lastScan > 0, "db lastScan stamped")
    ok(!Object.keys(dbDir?.files ?? {}).some((k) => k.includes(".hidden-note.md") || k.includes("settings.json")),
      "db has no entries for the skipped files")

    // Ingest runs through the mock: both sources summarized, pages on disk.
    const taskPathMatches = (t) => !!t && (
      t.file_path === "raw/sources/scheduled-import/note.md" ||
      t.file_path === "raw/sources/scheduled-import/nested/sunspots.txt" ||
      String(t.file_path ?? "").includes("scheduled-import")
    )
    await waitFor(async () => {
      const uuid = await readProjectUuid()
      if (!uuid) return false
      const tasks = await fetchQueue(uuid)
      if (!tasks || tasks.length < 2) return false
      const mine = tasks.filter((t) => taskPathMatches(t))
      return mine.length === 2 && mine.every((t) => t.status === "completed") &&
        !tasks.some((t) => t.status === "pending" || t.status === "processing")
    }, 30000, "ingest queue drained")
    ok(true, "scheduled-import enqueued BOTH copies and both server-queue tasks completed (server-owned SQLite queue)")
    // The pipeline sanitizes the FILE target against the source's folder
    // context, so the pages land as slug--stableSuffix names under
    // wiki/sources/; find them by the mock's marker + source citation.
    const sourcesDir = path.join(projectPath, "wiki", "sources")
    const pages = fs.existsSync(sourcesDir)
      ? fs.readdirSync(sourcesDir).filter((f) => f.endsWith(".md")).map((f) => fs.readFileSync(path.join(sourcesDir, f), "utf-8"))
      : []
    ok(pages.some((c) => c.includes("MOCK-SCHEDULED-IMPORT-SUMMARY for raw/sources/scheduled-import/note.md")),
      "summary page for note.md written to disk (desktop-readable)")
    ok(pages.some((c) => c.includes("MOCK-SCHEDULED-IMPORT-SUMMARY for raw/sources/scheduled-import/nested/sunspots.txt")),
      "summary page for nested/sunspots.txt written to disk")

    // The watcher ran the whole time (desktop defaults ON): it must have
    // stayed silent about the app's own copies — no change tasks on disk...
    const changeTasks = readQueue(projectPath).tasks
    ok(!changeTasks.some((t) => String(t.path).includes("scheduled-import")),
      "source watcher created ZERO change tasks for the scheduled-import copies (app-write-ignore end-to-end)")
    // ...and no duplicate ingest work: exactly one analysis + one generation
    // per source reached the mock.
    await sleep(2000) // let any (wrong) duplicate pipeline hit the mock
    const analysisCalls = mockCalls.filter((c) => /expert research analyst/i.test(String((c.messages ?? []).find((m) => m.role === "system")?.content ?? "")))
    const generationCalls = mockCalls.filter((c) => /wiki maintainer/i.test(String((c.messages ?? []).find((m) => m.role === "system")?.content ?? "")))
    ok(analysisCalls.length === 2, `exactly TWO analysis calls (one per imported source; got ${analysisCalls.length})`)
    ok(generationCalls.length === 2, `exactly TWO generation calls (got ${generationCalls.length})`)

    // Rescan idempotence: unchanged files are NOT re-imported. Reload — the
    // app auto-reopens the last project and hydrates the desktop-written
    // schedule again; the immediate rescan must find nothing new.
    mockCalls.length = 0
    const lastScanBefore = JSON.parse(fs.readFileSync(dbFile, "utf-8")).directories[inbox].lastScan
    await page.reload()
    await waitFor(async () => {
      try {
        return JSON.parse(fs.readFileSync(dbFile, "utf-8")).directories[inbox].lastScan > lastScanBefore
      } catch { return false }
    }, 20000, "rescan after reload stamped a fresh lastScan")
    ok(true, "reload re-opened the project and re-ran the scheduled scan (fresh lastScan)")
    const dbAfter = JSON.parse(fs.readFileSync(dbFile, "utf-8"))
    const filesAfter = dbAfter.directories?.[inbox]?.files ?? {}
    ok(Object.keys(filesAfter).length === 2, "second scan kept exactly the two known files (no phantom entries)")
    ok(mockCalls.filter((c) => /expert research analyst|wiki maintainer/i.test(String((c.messages ?? []).find((m) => m.role === "system")?.content ?? ""))).length === 0,
      "second scan over unchanged files made ZERO new LLM calls (md5 dedup)")

    // Resolve the probe-before-write tolerance, then assert a clean console.
    // The ingest pipeline probes the FILE block's naive target
    // (wiki/sources/<stem>.md) before writing; for sources under
    // scheduled-import/ the written page gets the sanitized slug name, so
    // the probed path never exists — exactly like the desktop, where
    // read_file also errors on missing files and the pipeline falls back.
    // Tolerate such a probe iff the sanitized summary page for the same
    // stem exists on disk by the end (proven probe-before-write).
    const summaryStems = fs.existsSync(sourcesDir)
      ? fs.readdirSync(sourcesDir).filter((f) => f.endsWith(".md"))
      : []
    for (const p of pendingProbes) {
      const m = p.abs.split("/wiki/sources/").pop()
      const stem = m ? m.replace(/\.md$/, "") : null
      const probeResolved = fs.existsSync(p.abs) ||
        (stem && summaryStems.some((f) => f.includes(stem)))
      if (probeResolved) optionalReads.push(`${p.detail} [probe-before-write]`)
      else badResponses.push(p.detail)
    }
    ok(dialogs.length === 0, `ZERO alert/confirm dialogs (got ${dialogs.length}: ${dialogs.join(" | ")})`)
    ok(pageErrors.length === 0, `ZERO page errors (got ${pageErrors.length}: ${pageErrors.join(" | ")})`)
    ok(consoleErrors.length === 0, `ZERO console errors (got ${consoleErrors.length}: ${consoleErrors.join(" | ")})`)
    ok(badResponses.length === 0, `ZERO non-optional failed/4xx/5xx requests (got ${badResponses.length}: ${badResponses.join(" | ")})`)
    if (optionalReads.length) console.log(`      (${optionalReads.length} tolerated optional-state/probe reads)`)
  } finally {
    try { await browser?.close() } catch {}
    mock.close()
    child.kill("SIGTERM")
  }
}

console.log(`\nscheduled-import: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
