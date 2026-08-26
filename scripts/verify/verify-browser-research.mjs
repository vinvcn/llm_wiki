// Headless browser DEEP RESEARCH gate (standing; /tmp is volatile).
//
// Drives the real Deep Research panel end-to-end against a mock SearXNG
// web-search provider and a mock OpenAI-compatible LLM (no real keys) —
// the one primary view the earlier e2e gate only opened without exercising:
//
//   1. opens a desktop-created project through the server-backed picker;
//   2. opens the Deep Research panel, types a topic, presses Enter;
//   3. the panel runs the topic through the server-side web_search command
//      (SearXNG provider), shows the collected sources inline ("Sources (3)"),
//      then STREAMS the synthesis from the mock LLM into the card;
//   4. the task reaches "Saved" with the "Open" button;
//   5. the synthesized page lands on disk at
//      <project>/wiki/queries/research-<topic>-<ts>.md with the desktop
//      format (type: query / origin: deep-research / tags: [research] /
//      References with the searched URLs) — the desktop-visible shared file,
//      proving anything generated on the web is usable on the desktop;
//   6. the SearXNG provider received the topic query (format=json) and the
//      LLM received EXACTLY ONE synthesis completion carrying the collected
//      sources and the cross-referencing system prompt.
//
// All with ZERO page errors, ZERO genuine console errors, ZERO failed
// requests (tolerating only the documented optional-state reads), and ZERO
// dialogs (the "not configured" alert must not fire — the config seeded into
// the shared store is what the panel reads).
//
//   node scripts/verify/verify-browser-research.mjs

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
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

const TOPIC = "Quantum computing overview"
const ANSWER = "Quantum computing harnesses superposition and entanglement to outperform classical machines."
const SEARX_RESULTS = [
  { url: "https://example.org/quantum-supremacy", title: "Quantum Supremacy Explained", content: "A review of the quantum supremacy milestone." },
  { url: "https://example.org/entanglement", title: "Entanglement Basics", content: "How entanglement powers quantum algorithms." },
  { url: "https://example.org/error-correction", title: "Quantum Error Correction", content: "Surface codes and fault tolerance." },
]

// ── Mock SearXNG (the server-side web_search provider) ────────────────────
const searxQueries = []
const searxPort = await freePort()
const searx = http.createServer((rq, rs) => {
  if (rq.method !== "GET" || !rq.url.includes("/search")) { rs.writeHead(404); rs.end("nope"); return }
  const u = new URL(rq.url, "http://127.0.0.1")
  searxQueries.push({ q: u.searchParams.get("q") ?? "", format: u.searchParams.get("format"), categories: u.searchParams.get("categories") })
  rs.writeHead(200, { "Content-Type": "application/json" })
  rs.end(JSON.stringify({ results: SEARX_RESULTS }))
})
await new Promise((r) => searx.listen(searxPort, r))

// ── Mock OpenAI-compatible LLM (plain synthesis completion, streamed) ──────
const mockLlmBodies = []
const mockPort = await freePort()
const mock = http.createServer((rq, rs) => {
  let buf = ""
  rq.on("data", (c) => (buf += c))
  rq.on("end", () => {
    if (rq.method === "POST" && rq.url.includes("/chat/completions")) {
      try {
        const reqBody = JSON.parse(buf)
        mockLlmBodies.push(reqBody)
        const chunk = (delta, finish) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`
        if (reqBody.stream) {
          rs.writeHead(200, { "Content-Type": "text/event-stream" })
          for (const word of ANSWER.split(" ")) rs.write(chunk({ role: "assistant", content: word + " " }))
          rs.write(chunk({}, "stop"))
          rs.end("data: [DONE]\n\n")
        } else {
          rs.writeHead(200, { "Content-Type": "application/json" })
          rs.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: ANSWER } }] }))
        }
      } catch (e) { rs.writeHead(500); rs.end(String(e)) }
    } else { rs.writeHead(404); rs.end("nope") }
  })
})
await new Promise((r) => mock.listen(mockPort, r))

// ── Fake "desktop" project on disk + shared app-state store ───────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-research-"))
const dataDir = path.join(tmp, "data")
const storesDir = path.join(dataDir, "stores")
fs.mkdirSync(storesDir, { recursive: true })
const projectPath = path.join(tmp, "desktop-project")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.mkdirSync(path.join(projectPath, "raw", "sources"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "schema.md"), "# Schema\n\nEntity pages describe things.\n")
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n\nHome page of the wiki.\n")
fs.writeFileSync(path.join(projectPath, "wiki", "quantum.md"), "---\ntype: entity\ntitle: Quantum Mechanics\n---\n# Quantum Mechanics\n\nQuantum mechanics is the study of matter at atomic and subatomic scales.\n")

// The panel reads llmConfig + searchApiConfig from the SHARED store
// (app-state.json). No projectRegistry/lastProject: the UI must open the
// project via the picker (the shared-data scenario).
fs.writeFileSync(path.join(storesDir, "app-state.json"), JSON.stringify({
  llmConfig: { provider: "custom", apiKey: "test-key", model: "mock-model", customEndpoint: `http://127.0.0.1:${mockPort}/v1`, apiMode: "chat_completions" },
  searchApiConfig: { provider: "searxng", searXngUrl: `http://127.0.0.1:${searxPort}`, searXngCategories: ["general"], deepResearchSource: "web" },
}, null, 2))

const port = await freePort()
const child = spawn(process.execPath, ["packages/server/src/index-v2.js"], {
  cwd: REPO,
  env: { ...process.env, LLM_WIKI_AUTH_MODE: "none", LLM_WIKI_PORT: String(port), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", (d) => (serverLog += d)); child.stderr.on("data", (d) => (serverLog += d))

let browser
try {
  await waitFor(async () => {
    const r = await new Promise((res) => { const q = http.get({ host: "127.0.0.1", port, path: "/api/health" }, (x) => res(x.statusCode)); q.on("error", () => res(0)) })
    return r === 200
  }, 8000, "server health")

  browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
  const page = await browser.newPage()

  const pageErrors = []
  const consoleErrors = []
  const badResponses = []
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
      if (p.includes("/.llm-wiki/") && (cmd === "read_file" || cmd === "list_directory")) {
        tolerated = true
        detail += ` [optional-state: ${cmd} ${p.replace(projectPath, "")}]`
      }
    } catch { /* non-json body */ }
    if (!tolerated) badResponses.push(detail)
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
  await page.click(".lw-btn.primary")
  await waitFor(async () => (await page.$$(".lw-overlay")).length === 0, 5000, "picker closed")
  await page.waitForSelector("text=Quantum Mechanics", { timeout: 15000 })
  ok(true, "project opened via picker; Knowledge tree rendered")

  // ── Open the Deep Research panel (Globe nav trigger) ────────────────────
  const researchInput = 'input[placeholder="Enter a research topic..."]'
  let panelOpen = Boolean(await page.$(researchInput))
  const navTriggers = page.locator('[data-slot="tooltip-trigger"]')
  const navCount = Math.min(await navTriggers.count(), 9)
  for (let i = 0; i < navCount && !panelOpen; i++) {
    await navTriggers.nth(i).click()
    await sleep(300)
    panelOpen = Boolean(await page.$(researchInput))
  }
  if (!panelOpen) throw new Error("Deep Research panel did not open")
  ok(true, "Deep Research panel opened")

  // ── Start a research task for the topic ─────────────────────────────────
  await page.fill(researchInput, TOPIC)
  await page.press(researchInput, "Enter")

  // The collected sources render inline in the card (proves the server-side
  // web_search round-trip through the real UI).
  await page.waitForSelector("text=Sources (3)", { timeout: 15000 })
  ok(true, "research card shows the 3 collected web sources inline")

  // The synthesis STREAMS into the card from the mock LLM.
  await page.waitForSelector(`text=${ANSWER.slice(0, 40)}`, { timeout: 25000 })
  ok(true, "synthesis streamed inline into the research card")

  // The task reaches "Saved" with the "Open" affordance.
  await waitFor(async () => (await page.textContent("body"))?.includes("Saved"), 20000, "task saved")
  ok(true, "research task reached Saved status")
  await page.waitForSelector("button:has-text('Open')", { timeout: 5000 })
  ok(true, "Open button shown on the saved task")
  // The answer the user was watching stream must STAY visible inline now that
  // the task completed (issue #13 item 4) — not collapse with the card.
  ok(Boolean(await page.$(`text=${ANSWER.slice(0, 40)}`)), "synthesis stays visible inline after completion (#13 item 4)")

  // ── Shared data: the generated page landed in the desktop wiki ──────────
  const queriesDir = path.join(projectPath, "wiki", "queries")
  await waitFor(() => fs.existsSync(queriesDir) && fs.readdirSync(queriesDir).length > 0, 15000, "wiki/queries file on disk")
  const files = fs.readdirSync(queriesDir).filter((f) => f.endsWith(".md"))
  ok(files.length >= 1, `research page written to wiki/queries/ (${files.length} file(s))`)
  const pageText = fs.readFileSync(path.join(queriesDir, files[0]), "utf8")
  ok(pageText.includes("type: query"), "written page has type: query frontmatter")
  ok(pageText.includes("origin: deep-research"), "written page has origin: deep-research frontmatter")
  ok(pageText.includes("tags: [research]"), "written page has tags: [research] frontmatter")
  ok(pageText.includes(`"Research: ${TOPIC}"`), "written page has the research title frontmatter")
  ok(pageText.includes(`# Research: ${TOPIC}`), "written page has the research H1")
  ok(pageText.includes(ANSWER.slice(0, 40)), "written page contains the streamed synthesis")
  ok(pageText.includes("## References"), "written page has a References section")
  for (const r of SEARX_RESULTS) {
    ok(pageText.includes(r.url), `written page cites searched source: ${r.url}`)
  }

  // ── Provider contract: the SearXNG query + exactly one LLM completion ───
  ok(searxQueries.length >= 1, `SearXNG received the topic query (${searxQueries.length} call(s))`)
  ok(searxQueries.some((s) => s.q === TOPIC), "SearXNG query q matches the research topic")
  ok(searxQueries.every((s) => s.format === "json"), "SearXNG format=json on every call")
  ok(mockLlmBodies.length === 1, `EXACTLY ONE LLM synthesis completion (got ${mockLlmBodies.length})`)
  const llmText = JSON.stringify(mockLlmBodies[0]?.messages ?? [])
  ok(llmText.includes("Research Sources"), "LLM prompt carries the collected research sources")
  ok(llmText.includes(SEARX_RESULTS[0].title), "LLM prompt carries the first searched source title")
  ok(llmText.includes("Synthesize into a wiki page"), "LLM prompt requests wiki-page synthesis")

  // ── Cleanliness ──────────────────────────────────────────────────────────
  await sleep(500)
  ok(dialogs.length === 0, `ZERO alert/confirm dialogs (got ${dialogs.length}: ${dialogs.slice(0, 3).join(" | ")})`)
  ok(pageErrors.length === 0, `ZERO page errors (got ${pageErrors.length}: ${pageErrors.slice(0, 3).join(" | ")})`)
  ok(consoleErrors.length === 0, `ZERO console errors (got ${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(" | ")})`)
  ok(badResponses.length === 0, `ZERO non-optional failed/4xx/5xx requests (got ${badResponses.length}: ${badResponses.slice(0, 4).join(" | ")})`)

  if (fail > 0) {
    try { await page.screenshot({ path: "/tmp/lw-research-fail.png", fullPage: true }); console.log("  screenshot -> /tmp/lw-research-fail.png") } catch {}
  }
} catch (err) {
  fail++
  console.log("  FAIL- harness error:", err.message)
  console.log("--- server log ---\n" + serverLog.slice(-1500))
} finally {
  try { await browser?.close() } catch {}
  child.kill("SIGKILL")
  searx.close()
  mock.close()
}

console.log(`\nbrowser-research: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
