// Main-listener port-conflict acceptance harness.
//
// The supported topology is SAME HOST: the web server runs where the user's
// projects live, often while the DESKTOP app is open. The desktop always
// owns :19828 (its built-in REST API, src-tauri/src/api_server.rs — the
// Settings kill-switch only 503s requests, the port stays bound) and :19827
// (clipper companion). The web server's default main port is also :19828, so
// a bind failure is EXPECTED in that topology and must be a clear, actionable
// exit — not:
//   - index.js    : a raw unhandled 'error' stack-trace crash, or
//   - index-v2.js : a success banner + zombie process (Express 5's app.listen
//                   delivers bind errors to the listen CALLBACK).
//
// PART 1 — both entry points against an occupied port: fast non-zero exit,
//          actionable diagnosis (desktop ownership, LLM_WIKI_PORT fix,
//          LLM_WIKI_API_BASE_URL override), no success banner, no raw trace.
// PART 2 — listen-guard diagnostics for the other failure classes
//          (EACCES, EADDRNOTAVAIL, unknown) + idempotent-exit guarantee.
// PART 3 — positive control: both entries still boot + serve on a free port
//          and stop cleanly on SIGTERM.
//
//   node scripts/verify/verify-port-conflict.mjs

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
function health(port) {
  return fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.status).catch(() => 0)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llmwiki-portconflict-"))
const children = []

function spawnEntry(entry, port, extraEnv = {}) {
  const child = spawn(process.execPath, [entry], {
    cwd: REPO,
    env: {
      ...process.env,
      LLM_WIKI_PORT: String(port),
      LLM_WIKI_NO_SHARE: "1",
      LLM_WIKI_DATA_DIR: path.join(tmp, `data-${entry.includes("v2") ? "v2" : "v1"}-${port}`),
      LLM_WIKI_CLIP_PORT: String(port + 200),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.push(child)
  let log = ""
  child.stdout.on("data", (d) => (log += d))
  child.stderr.on("data", (d) => (log += d))
  return { child, getLog: () => log }
}

/** Wait for the child to exit; SIGKILL after `timeoutMs` and report timeout. */
function waitExit(child, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const to = setTimeout(() => { try { child.kill("SIGKILL") } catch {} resolve({ code: null, signal: "TIMEOUT" }) }, timeoutMs)
    child.on("exit", (code, signal) => { clearTimeout(to); resolve({ code, signal }) })
  })
}

const ENTRIES = [
  { entry: "packages/server/src/index.js", name: "index.js" },
  { entry: "packages/server/src/index-v2.js", name: "index-v2.js" },
]

// ════════════════════════════════════════════════════════════════════════
// PART 1 — occupied port (the desktop-app-is-running topology)
// ════════════════════════════════════════════════════════════════════════
console.log("\nPART 1 — bind failure on an occupied port")
for (const { entry, name } of ENTRIES) {
  const port = await freePort()
  // Simulate the desktop's api_server owning the port.
  const blocker = http.createServer((q, s) => s.end("desktop"))
  await new Promise((res) => blocker.listen(port, "127.0.0.1", res))
  try {
    const t0 = Date.now()
    const { child, getLog } = spawnEntry(entry, port)
    const { code, signal } = await waitExit(child)
    const log = getLog()
    const ms = Date.now() - t0

    ok(signal !== "TIMEOUT", `${name}: exits on its own within 8s when the port is taken (no zombie/hang)`)
    ok(code === 1, `${name}: exit code is 1 (got code=${code} signal=${signal})`)
    ok(log.includes(`could not bind http://127.0.0.1:${port}`), `${name}: names the address it could not bind`)
    ok(log.includes("EADDRINUSE"), `${name}: reports EADDRINUSE`)
    ok(log.includes(`LLM_WIKI_PORT=${port + 1}`), `${name}: suggests a concrete free port (LLM_WIKI_PORT=${port + 1})`)
    ok(log.includes("LLM_WIKI_API_BASE_URL"), `${name}: tells MCP/agent tools how to follow (LLM_WIKI_API_BASE_URL)`)
    ok(/DESKTOP app is running/i.test(log), `${name}: explains the likely cause (desktop owns :19828 while running)`)
    ok(!log.includes("▸ Local:") && !log.includes("Unhandled 'error'"),
      `${name}: no success banner and no raw unhandled-error trace (diag printed in ${ms}ms)`)
  } finally {
    blocker.close()
  }
}

// ════════════════════════════════════════════════════════════════════════
// PART 2 — diagnostics for the other failure classes (pure unit checks)
// ════════════════════════════════════════════════════════════════════════
console.log("\nPART 2 — listen-guard diagnostics")
const { bindFailureMessage } = await import(path.join(REPO, "packages/server/src/listen-guard.js"))
const ctx = { port: 19828, host: "127.0.0.1", entry: "index.js" }

const eacces = bindFailureMessage(Object.assign(new Error("listen EACCES: permission denied 127.0.0.1:80"), { code: "EACCES" }), { ...ctx, port: 80 })
ok(eacces.includes("permission denied") && eacces.includes("LLM_WIKI_PORT"), "EACCES: permission guidance + port fix")
const notavail = bindFailureMessage(Object.assign(new Error("listen EADDRNOTAVAIL"), { code: "EADDRNOTAVAIL" }), { ...ctx, host: "10.255.255.1" })
ok(notavail.includes("LLM_WIKI_HOST"), "EADDRNOTAVAIL: points at LLM_WIKI_HOST")
const unknown = bindFailureMessage(new Error("something odd"), ctx)
ok(unknown.includes("something odd"), "unknown error: original message preserved")

// Idempotent exit: calling exitOnBindFailure twice must print ONE diagnosis.
const idem = spawn(process.execPath, ["--input-type=module", "-e", `
  import { exitOnBindFailure } from ${JSON.stringify(path.join(REPO, "packages/server/src/listen-guard.js"))}
  const err = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:19828"), { code: "EADDRINUSE" })
  exitOnBindFailure(err, { port: 19828, host: "127.0.0.1", entry: "index-v2.js" })
  exitOnBindFailure(err, { port: 19828, host: "127.0.0.1", entry: "index-v2.js" })
`], { stdio: ["ignore", "pipe", "pipe"] })
children.push(idem)
let idemErr = ""
idem.stderr.on("data", (d) => (idemErr += d))
const idemExit = await waitExit(idem)
ok(idemExit.code === 1 && (idemErr.match(/could not bind/g) || []).length === 1,
  "exitOnBindFailure is idempotent (Express 5 double-delivers the error; diagnosis printed once)")

// ════════════════════════════════════════════════════════════════════════
// PART 3 — positive control: free port still boots and stops cleanly
// ════════════════════════════════════════════════════════════════════════
console.log("\nPART 3 — positive control (free port)")
for (const { entry, name } of ENTRIES) {
  const port = await freePort()
  const { child, getLog } = spawnEntry(entry, port)
  let up = false
  for (let i = 0; i < 80; i++) { await sleep(100); if ((await health(port)) === 200) { up = true; break } }
  ok(up, `${name}: boots and serves /api/health on a free port`)
  ok(getLog().includes("▸ Local:"), `${name}: prints the success banner on a free port`)
  child.kill("SIGTERM")
  const { code, signal } = await waitExit(child, 5000)
  ok(code === 0 || signal === "SIGTERM", `${name}: stops cleanly on SIGTERM (code=${code} signal=${signal})`)
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\nport-conflict: ${pass}/${pass + fail} passed${fail ? ` (${fail} FAILED)` : ""}`)
process.exit(fail ? 1 : 0)
