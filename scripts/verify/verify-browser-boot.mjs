// Headless browser BOOT gate (recreated; /tmp is volatile).
// Serves the built SPA (dist-web) from the server with an EMPTY isolated store
// (LLM_WIKI_NO_SHARE=1 + fresh LLM_WIKI_DATA_DIR), drives Chromium, and asserts
// the welcome screen renders with ZERO pageerror / console error / failed
// request. (No project is opened here, so the documented optional-state 404s
// do not occur — boot must be clean.)
//
//   node /tmp/verify-browser-boot.mjs
//
// Requires playwright-core resolvable from /tmp/pw and a Chromium under
// ~/.cache/ms-playwright (does NOT download a browser).

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
  for (const d of dirs) {
    const exe = path.join(base, d, "chrome-linux64", "chrome")
    if (fs.existsSync(exe)) return exe
  }
  throw new Error("no chromium binary under ~/.cache/ms-playwright")
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-boot-"))
const dataDir = path.join(tmp, "data") // fresh + empty
const port = await freePort()
const SERVER_ENTRY = process.env.SERVER_ENTRY || "packages/server/src/index-v2.js"
const child = spawn(process.execPath, [SERVER_ENTRY], {
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
  const health = await new Promise((res) => { http.get({ host: "127.0.0.1", port, path: "/api/health" }, (x) => { let b = ""; x.on("data", (c) => b += c); x.on("end", () => res(JSON.parse(b))) }) })
  ok(health.webBuilt === true, `server reports webBuilt=true (dist-web served)`)
  ok(health.store?.shared === false, `empty isolated store: shared=false (got ${health.store?.shared})`)

  const exe = findChromium()
  browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
  const page = await browser.newPage()
  const pageErrors = []
  const consoleErrors = []
  const failedRequests = []
  page.on("pageerror", (e) => pageErrors.push(String(e)))
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()) })
  page.on("requestfailed", (r) => failedRequests.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`))

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" })
  // Welcome screen: h1 "LLM Wiki" + an "Open Project" button.
  await page.waitForSelector("h1:has-text('LLM Wiki')", { timeout: 10000 })
  await page.waitForSelector("button:has-text('Open Project')", { timeout: 10000 })
  await sleep(800) // let any deferred boot work settle

  ok(true, "welcome screen rendered (h1 'LLM Wiki' + 'Open Project' button)")
  ok(pageErrors.length === 0, `ZERO page errors (got ${pageErrors.length}: ${pageErrors.slice(0, 3).join(" | ")})`)
  ok(consoleErrors.length === 0, `ZERO console errors (got ${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(" | ")})`)
  ok(failedRequests.length === 0, `ZERO failed requests (got ${failedRequests.length}: ${failedRequests.slice(0, 3).join(" | ")})`)
} catch (err) {
  fail++
  console.log("  FAIL- harness error:", err.message)
  console.log("--- server log ---\n" + serverLog.slice(-1500))
} finally {
  try { await browser?.close() } catch {}
  child.kill("SIGKILL")
}

console.log(`\nbrowser-boot: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
