// Standing gate: OS default-opener / file-manager reveal parity.
//
// Pins `packages/server/src/opener.js` (the faithful port of
// tauri-plugin-opener) + the commands built on it:
//   - open_project_folder / open_path_in_project  (1:1 ports of
//     src-tauri/src/commands/project.rs: same validation, canonicalization,
//     path-containment guard, exact error strings, open -> reveal fallback)
//   - web_open_path / web_reveal_path             (web-only commands the
//     browser opener shim delegates to)
//
// Technique (same as verify-cli-transports.mjs): real server(s) booted with
// a SCRUBBED PATH that contains ONLY mock `xdg-open` / `dbus-send` binaries
// (SHELL=/bin/sh keeps the login-shell PATH probe inside the mock bin too),
// so the host's real handlers are never touched and absence is real:
//   server A: xdg-open OK  + dbus-send OK    (happy paths + argv contracts)
//   server B: dbus-send OK only              (open fails -> reveal fallback)
//   server C: dbus-send FAIL only            (everything fails -> exact error)
//   server D: xdg-open OK + dbus-send FAIL   (reveal chain last resort)
// Every mock appends its argv to $MOCK_LOG so the harness can assert exactly
// what the OS was asked to run.
//
//   node scripts/verify/verify-opener.mjs

import { spawn } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http from "node:http"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const ENTRY = process.env.SERVER_ENTRY || "packages/server/src/index.js"
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log("  ok  -", m) } else { fail++; console.log("  FAIL-", m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
}
async function waitFor(fn, t, what) {
  const start = Date.now()
  while (Date.now() - start < t) { try { if (await fn()) return true } catch {} await sleep(60) }
  throw new Error(`timeout waiting for ${what}`)
}
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

console.log(`opener harness (entry: ${ENTRY})`)

// ── Fixtures ──────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-opener-"))
const projectPath = path.join(tmp, "project")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "schema.md"), "# Schema\n")
fs.writeFileSync(path.join(projectPath, "wiki", "alpha.md"), "# Alpha\n")
const canonicalProject = fs.realpathSync(projectPath)

const outsideDir = path.join(tmp, "outside")
fs.mkdirSync(outsideDir, { recursive: true })
const outsideFile = path.join(outsideDir, "secret.txt")
fs.writeFileSync(outsideFile, "outside the project")

const noSchemaDir = path.join(tmp, "no-schema")
fs.mkdirSync(noSchemaDir, { recursive: true })
const noWikiDir = path.join(tmp, "no-wiki")
fs.mkdirSync(noWikiDir, { recursive: true })
fs.writeFileSync(path.join(noWikiDir, "schema.md"), "# Schema\n")
const justAFile = path.join(tmp, "just-a-file")
fs.writeFileSync(justAFile, "not a directory")

// symlinks for the canonicalization guard tests
const linkInside = path.join(projectPath, "wiki", "link-inside.md")
fs.symlinkSync(path.join(projectPath, "wiki", "alpha.md"), linkInside)
const linkOutside = path.join(projectPath, "wiki", "link-outside.md")
fs.symlinkSync(outsideFile, linkOutside)

// ── Mock bins ─────────────────────────────────────────────────────────────
function writeMock(dir, name, body) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, body)
  fs.chmodSync(p, 0o755)
  return p
}
const xdgOpenOk = (log) => `#!/bin/sh
printf 'XDG %s\\n' "$@" >> "${log}"
exit 0
`
const dbusOk = (log) => `#!/bin/sh
printf 'DBUS %s\\n' "$*" >> "${log}"
exit 0
`
const dbusFail = (log) => `#!/bin/sh
printf 'DBUS-FAIL %s\\n' "$*" >> "${log}"
exit 1
`
const binA = path.join(tmp, "binA"); fs.mkdirSync(binA)
const binB = path.join(tmp, "binB"); fs.mkdirSync(binB)
const binC = path.join(tmp, "binC"); fs.mkdirSync(binC)
const binD = path.join(tmp, "binD"); fs.mkdirSync(binD)
const logA = path.join(tmp, "logA"); const logB = path.join(tmp, "logB")
const logC = path.join(tmp, "logC"); const logD = path.join(tmp, "logD")
writeMock(binA, "xdg-open", xdgOpenOk(logA)); writeMock(binA, "dbus-send", dbusOk(logA))
writeMock(binB, "dbus-send", dbusOk(logB))
writeMock(binC, "dbus-send", dbusFail(logC))
writeMock(binD, "xdg-open", xdgOpenOk(logD)); writeMock(binD, "dbus-send", dbusFail(logD))
const readLog = (f) => fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : []

// The mock bins append to $MOCK_LOG AFTER the server's HTTP response returns
// (the server spawns the child and does not await it), so reading the log
// immediately can race the child's first write under load. waitForLogCount
// polls until the expected line(s) land (or the grace window expires), which
// makes every argv assertion deterministic regardless of machine load.
async function waitForLogCount(logFile, pred, min = 1, ms = 5000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (readLog(logFile).filter(pred).length >= min) return true
    await sleep(40)
  }
  return false
}
const logHas = (logFile, pred, min = 1) => waitForLogCount(logFile, pred, min)

// ── Servers ───────────────────────────────────────────────────────────────
async function startServer(bin, logFile) {
  const port = await freePort()
  const child = spawn(process.execPath, [ENTRY], {
    cwd: REPO,
    env: {
      ...process.env,
      LLM_WIKI_PORT: String(port),
      LLM_WIKI_NO_SHARE: "1",
      LLM_WIKI_DATA_DIR: path.join(tmp, `data-${port}`),
      // Scrubbed PATH: ONLY the mock bin. SHELL=/bin/sh keeps the
      // login-shell PATH probe (cli.js#loginShellPath) inside the mock too,
      // so "absent" binaries are genuinely absent.
      PATH: bin,
      SHELL: "/bin/sh",
      MOCK_LOG: logFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let serverLog = ""
  child.stdout.on("data", (d) => (serverLog += d)); child.stderr.on("data", (d) => (serverLog += d))
  try {
    await waitFor(async () => (await req(port, "GET", "/api/health")).status === 200, 8000, `server health (${port})`)
  } catch (e) {
    console.log("server failed to boot:", serverLog)
    throw e
  }
  return {
    port, child,
    invoke: (cmd, args) => req(port, "POST", `/api/invoke/${cmd}`, args ?? {}),
    getLog: () => serverLog,
  }
}

const srvA = await startServer(binA, logA)
const invokeA = srvA.invoke

// ═════════════════════════════════════════════════════════════════════════
// A. open_project_folder — happy path + validation contract (server A)
// ═════════════════════════════════════════════════════════════════════════
{
  const r = await invokeA("open_project_folder", { path: projectPath })
  ok(r.status === 200 && r.json === null, "open_project_folder succeeds and returns null")
  ok(await logHas(logA, (l) => l.includes(`XDG ${canonicalProject}`)), `xdg-open spawned with the CANONICAL project path (log: ${JSON.stringify(readLog(logA))})`)
  ok(!readLog(logA).some((l) => l.startsWith("DBUS")), "no reveal attempted when open succeeds")

  const missing = path.join(tmp, "does-not-exist")
  const r2 = await invokeA("open_project_folder", { path: missing })
  ok(r2.status === 500 && r2.json?.error === `Path does not exist: '${missing}'`,
    `exact missing-path error (got ${JSON.stringify(r2.json?.error)})`)

  const r3 = await invokeA("open_project_folder", { path: justAFile })
  ok(r3.status === 500 && r3.json?.error === `Path is not a directory: '${justAFile}'`,
    `exact not-a-directory error (got ${JSON.stringify(r3.json?.error)})`)

  const r4 = await invokeA("open_project_folder", { path: noSchemaDir })
  ok(r4.status === 500 && r4.json?.error === `Not a valid wiki project (missing schema.md): '${noSchemaDir}'`,
    `exact missing-schema error (got ${JSON.stringify(r4.json?.error)})`)

  const r5 = await invokeA("open_project_folder", { path: noWikiDir })
  ok(r5.status === 500 && r5.json?.error === `Not a valid wiki project (missing wiki/ directory): '${noWikiDir}'`,
    `exact missing-wiki error (got ${JSON.stringify(r5.json?.error)})`)
}

// ═════════════════════════════════════════════════════════════════════════
// B. open_path_in_project — containment guard + argv (server A)
// ═════════════════════════════════════════════════════════════════════════
{
  const targetCanonical = fs.realpathSync(path.join(projectPath, "wiki", "alpha.md"))
  const r = await invokeA("open_path_in_project", { projectPath, targetPath: "wiki/alpha.md" })
  ok(r.status === 200 && r.json === null, "open_path_in_project (relative target) succeeds")
  ok(await logHas(logA, (l) => l.includes(`XDG ${targetCanonical}`)), "xdg-open spawned with the canonical ABSOLUTE target")

  const r2 = await invokeA("open_path_in_project", { projectPath, targetPath: targetCanonical })
  ok(r2.status === 200 && r2.json === null, "open_path_in_project (absolute target inside) succeeds")

  const r3 = await invokeA("open_path_in_project", { projectPath, targetPath: "../outside/secret.txt" })
  ok(r3.status === 500 && r3.json?.error === `Refusing to open a path outside the project: '${fs.realpathSync(outsideFile)}'`,
    `exact refusal for relative escape (got ${JSON.stringify(r3.json?.error)})`)

  const r4 = await invokeA("open_path_in_project", { projectPath, targetPath: outsideFile })
  ok(r4.status === 500 && r4.json?.error === `Refusing to open a path outside the project: '${fs.realpathSync(outsideFile)}'`,
    `exact refusal for absolute escape (got ${JSON.stringify(r4.json?.error)})`)

  const ghost = path.join(projectPath, "wiki", "ghost.md")
  const r5 = await invokeA("open_path_in_project", { projectPath, targetPath: "wiki/ghost.md" })
  ok(r5.status === 500 && String(r5.json?.error).startsWith(`Failed to resolve target path '${ghost}':`) && String(r5.json?.error).includes("ENOENT"),
    `missing-target error prefix + ENOENT (got ${JSON.stringify(r5.json?.error)})`)

  const r6 = await invokeA("open_path_in_project", { projectPath: noSchemaDir, targetPath: "x.md" })
  ok(r6.status === 500 && r6.json?.error === `Not a valid wiki project (missing schema.md): '${noSchemaDir}'`,
    "project root validated before the target")

  const r7 = await invokeA("open_path_in_project", { projectPath, targetPath: "wiki/link-inside.md" })
  ok(r7.status === 200 && r7.json === null, "symlink resolving INSIDE the project is allowed")

  const r8 = await invokeA("open_path_in_project", { projectPath, targetPath: "wiki/link-outside.md" })
  ok(r8.status === 500 && r8.json?.error === `Refusing to open a path outside the project: '${fs.realpathSync(outsideFile)}'`,
    `symlink escaping the project refused at its CANONICAL target (got ${JSON.stringify(r8.json?.error)})`)

  ok(!readLog(logA).some((l) => l.startsWith("DBUS")), "still no reveal attempted on the happy paths")
}

// ═════════════════════════════════════════════════════════════════════════
// C. web_open_path / web_reveal_path — the browser shim's server commands
//    (server A: happy paths + exact D-Bus argv contract)
// ═════════════════════════════════════════════════════════════════════════
{
  const f = path.join(projectPath, "wiki", "alpha.md")
  const r = await invokeA("web_open_path", { path: f })
  ok(r.status === 200 && r.json === null, "web_open_path succeeds and returns null")
  ok(await logHas(logA, (l) => l.includes(`XDG ${fs.realpathSync(f)}`)), "web_open_path spawned xdg-open with the path")

  const r2 = await invokeA("web_reveal_path", { path: f })
  ok(r2.status === 200 && r2.json === null, "web_reveal_path succeeds and returns null")
  const expectedArgv = `DBUS --session --type=method_call --print-reply --dest=org.freedesktop.FileManager1 /org/freedesktop/FileManager1 org.freedesktop.FileManager1.ShowItems array:string:${pathToFileURL(fs.realpathSync(f)).href} string:`
  ok(await logHas(logA, (l) => l.includes(expectedArgv)), `FileManager1.ShowItems called with the exact argv + file:// URI (got ${JSON.stringify(readLog(logA).filter((l) => l.startsWith("DBUS ")))})`)

  const ghost = path.join(tmp, "ghost-file.md")
  const r3 = await invokeA("web_open_path", { path: ghost })
  ok(r3.status === 500 && String(r3.json?.error).includes("ENOENT"), `web_open_path on a missing file errors before any spawn (got ${JSON.stringify(r3.json?.error)})`)
  const r4 = await invokeA("web_reveal_path", { path: ghost })
  ok(r4.status === 500 && String(r4.json?.error).includes("ENOENT"), `web_reveal_path on a missing file errors (canonicalize) (got ${JSON.stringify(r4.json?.error)})`)
}

// ═════════════════════════════════════════════════════════════════════════
// D. open -> reveal fallback (server B: xdg-open ABSENT, dbus-send OK)
// ═════════════════════════════════════════════════════════════════════════
{
  const srvB = await startServer(binB, logB)
  const r = await srvB.invoke("open_project_folder", { path: projectPath })
  ok(r.status === 200 && r.json === null, "open_project_folder succeeds via the reveal fallback when xdg-open is absent")
  const expectedArgv = `DBUS --session --type=method_call --print-reply --dest=org.freedesktop.FileManager1 /org/freedesktop/FileManager1 org.freedesktop.FileManager1.ShowItems array:string:${pathToFileURL(canonicalProject).href} string:`
  ok(await logHas(logB, (l) => l.includes(expectedArgv)), "the fallback revealed the project via FileManager1.ShowItems")
  ok(!readLog(logB).some((l) => l.startsWith("XDG ")), "no xdg-open call happened (it is absent)")
  srvB.child.kill("SIGKILL")
}

// ═════════════════════════════════════════════════════════════════════════
// E. everything fails -> the desktop's exact combined error (server C:
//    xdg-open ABSENT, dbus-send exits 1)
// ═════════════════════════════════════════════════════════════════════════
{
  const srvC = await startServer(binC, logC)
  const revealErr = "reveal_item_in_dir failed: FileManager1.ShowItems failed (dbus-send exited with code 1); portal.OpenDirectory failed (dbus-send exited with code 1); xdg-open parent failed (xdg-open not found on PATH)"

  const r = await srvC.invoke("open_project_folder", { path: projectPath })
  ok(r.status === 500 && r.json?.error === `Failed to open project folder: xdg-open not found on PATH; reveal fallback also failed: ${revealErr}`,
    `open_project_folder exact combined open+reveal error (got ${JSON.stringify(r.json?.error)})`)

  const r2 = await srvC.invoke("open_path_in_project", { projectPath, targetPath: "wiki/alpha.md" })
  ok(r2.status === 500 && r2.json?.error === `Failed to open project path: xdg-open not found on PATH; reveal fallback also failed: ${revealErr}`,
    `open_path_in_project exact combined open+reveal error (got ${JSON.stringify(r2.json?.error)})`)

  ok(await logHas(logC, (l) => l.startsWith("DBUS-FAIL ") && l.includes("--dest=org.freedesktop.FileManager1"), 2), "both commands tried ShowItems (open_project_folder + open_path_in_project)")
  ok(await logHas(logC, (l) => l.startsWith("DBUS-FAIL ") && l.includes("--dest=org.freedesktop.portal.OpenURI")), "the portal OpenDirectory fallback was also tried")
  srvC.child.kill("SIGKILL")
}

// ═════════════════════════════════════════════════════════════════════════
// F. reveal chain last resort -> open the PARENT dir (server D: dbus-send
//    fails, xdg-open present)
// ═════════════════════════════════════════════════════════════════════════
{
  const srvD = await startServer(binD, logD)
  const f = path.join(projectPath, "wiki", "alpha.md")
  const r = await srvD.invoke("web_reveal_path", { path: f })
  ok(r.status === 200 && r.json === null, "web_reveal_path succeeds via the last-resort parent-dir open")
  ok(await logHas(logD, (l) => l.startsWith("DBUS-FAIL ") && l.includes("--dest=org.freedesktop.FileManager1")), "ShowItems tried first and failed")
  ok(await logHas(logD, (l) => l.startsWith("DBUS-FAIL ") && l.includes("--dest=org.freedesktop.portal.OpenURI")), "portal OpenDirectory tried second and failed")
  ok(await logHas(logD, (l) => l.includes(`XDG ${path.dirname(fs.realpathSync(f))}`)), "last resort opened the PARENT directory with xdg-open")
  srvD.child.kill("SIGKILL")
}

// ═════════════════════════════════════════════════════════════════════════
// G. pure helpers (opener.js module contract)
// ═════════════════════════════════════════════════════════════════════════
{
  const { escapeForCmdStart } = await import(new URL("../../packages/server/src/opener.js", import.meta.url).href)
  ok(escapeForCmdStart("C:\\dir\\file.txt") === '"C:\\dir\\file.txt"', "escapeForCmdStart wraps a plain path in quotes")
  ok(escapeForCmdStart('has "quote"') === '"has ""quote"""', "escapeForCmdStart doubles embedded quotes (cmd /c start title rule)")
}

srvA.child.kill("SIGKILL")
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\nopener: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
