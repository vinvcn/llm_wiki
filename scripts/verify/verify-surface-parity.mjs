#!/usr/bin/env node
// Standing parity-surface gate: pins the "one unmodified React frontend works
// against the web backend" contract so a future change that silently drops a
// command, leaves a throwing stub, or forgets a web shim fails the suite
// immediately (the continuation prompt's manual greps, mechanized).
//
// Checks (all static, no server / browser needed):
//   1. NO THROWING STUBS in packages/server/src — the continuation greps
//      `notSupported(`, `: noop` and `"not available in web-server mode"`
//      must match NOTHING (the desktop's web-server-mode stubs are gone;
//      browser-impossible features are documented no-ops, never throwing).
//   2. RUST COMMAND PARITY — every command in the desktop's
//      `tauri::generate_handler![...]` list (src-tauri/src/lib.rs) is
//      registered in the Node invoke registry (packages/server/src/invoke.js),
//      so the unmodified frontend can invoke each desktop command over HTTP.
//   3. FRONTEND INVOKE PARITY — every literal command name the SHIPPED
//      frontend (src/**, excluding *.test.* test doubles) passes to
//      invoke()/invokeHttp() resolves in the Node registry.
//   4. WEB-SHIM COVERAGE — every `@tauri-apps/*` import in src/** (static and
//      dynamic) is covered by a `vite.web.config.ts` resolve.alias regex, and
//      each alias target file exists under src/web/.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const SERVER_SRC = path.join(ROOT, "packages", "server", "src")
const SRC = path.join(ROOT, "src")

let pass = 0
let fail = 0
const failures = []
const ok = (cond, msg) => {
  if (cond) { pass++; console.log("  ok  -", msg) }
  else { fail++; failures.push(msg); console.log("  FAIL-", msg) }
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(full, out)
    else if (ent.isFile()) out.push(full)
  }
  return out
}

// ── 1. No throwing stubs ──────────────────────────────────────────────────
{
  const files = walk(SERVER_SRC).filter((f) => f.endsWith(".js"))
  const blobs = new Map()
  for (const f of files) blobs.set(f, fs.readFileSync(f, "utf8"))
  const scan = (pattern, label) => {
    const hits = []
    for (const [f, src] of blobs) {
      const rel = path.relative(ROOT, f)
      for (const m of src.matchAll(pattern)) {
        const line = src.slice(0, m.index).split("\n").length
        hits.push(`${rel}:${line}`)
      }
    }
    ok(hits.length === 0, `no throwing stubs in packages/server/src (${label})` + (hits.length ? ` -> ${hits.join(", ")}` : ""))
  }
  scan(/notSupported\(/g, "notSupported(")
  scan(/:\s*noop\b/g, ": noop")
  scan(/not available in web-server mode/g, '"not available in web-server mode"')
}

// ── 2. Rust handler parity ────────────────────────────────────────────────
{
  const lib = fs.readFileSync(path.join(ROOT, "src-tauri", "src", "lib.rs"), "utf8")
  const m = lib.match(/generate_handler!\[([\s\S]*?)\]\s*\)/)
  if (!m) { ok(false, "generate_handler![...] found in src-tauri/src/lib.rs") }
  else {
    const items = m[1].split(",").map((s) => s.trim()).filter(Boolean)
    const rustNames = new Set(items.map((item) => item.split("::").pop()))
    const { commandNames } = await import(path.join(SERVER_SRC, "invoke.js"))
    const nodeNames = new Set(commandNames())
    const missing = [...rustNames].filter((n) => !nodeNames.has(n)).sort()
    ok(missing.length === 0, `every generate_handler! command registered in Node (${rustNames.size}/${rustNames.size})` + (missing.length ? ` -> missing: ${missing.join(", ")}` : ""))
  }
}

// ── 3. Shipped-frontend invoke parity ─────────────────────────────────────
{
  const files = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f) && !/(^|\/)[^/]*\.(test|spec)\.(ts|tsx)$/.test(f))
  const invoked = new Set()
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8")
    for (const m of src.matchAll(/invoke(?:<[^>]*>)?\(\s*["']([a-z_0-9]+)["']/g)) invoked.add(m[1])
    for (const m of src.matchAll(/invokeHttp\(\s*["']([a-z_0-9]+)["']/g)) invoked.add(m[1])
  }
  const { commandNames } = await import(path.join(SERVER_SRC, "invoke.js"))
  const nodeNames = new Set(commandNames())
  const missing = [...invoked].filter((n) => !nodeNames.has(n)).sort()
  ok(missing.length === 0, `every shipped-frontend invoke()/invokeHttp() target registered (${invoked.size}/${invoked.size})` + (missing.length ? ` -> missing: ${missing.join(", ")}` : ""))
}

// ── 4. Web-shim coverage ──────────────────────────────────────────────────
{
  const cfg = fs.readFileSync(path.join(ROOT, "vite.web.config.ts"), "utf8")
  const aliases = []
  const findRe = /find:\s*\/(.+)\/\s*,/g
  const replRe = /replacement:\s*web\("([^"]+)"\)/g
  let fm
  const finds = []
  while ((fm = findRe.exec(cfg))) finds.push(fm[1])
  const repls = []
  let rm
  while ((rm = replRe.exec(cfg))) repls.push(rm[1])
  // Pair find/replacement in order (the config emits them adjacently).
  for (let i = 0; i < finds.length && i < repls.length; i++) {
    aliases.push({ find: finds[i], replacement: repls[i] })
  }
  const matcher = (spec) => aliases.some((a) => new RegExp(a.find).test(spec))
  for (const a of aliases) {
    ok(fs.existsSync(path.join(SRC, "web", a.replacement)), `alias target exists src/web/${a.replacement}`)
  }
  const files = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f))
  const specifiers = new Set()
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8")
    for (const m of src.matchAll(/(?:from\s+|import\(\s*)["'](@tauri-apps\/[a-z0-9/-]+)["']/g)) specifiers.add(m[1])
  }
  const uncovered = [...specifiers].filter((s) => !matcher(s)).sort()
  ok(uncovered.length === 0, `every @tauri-apps/* import covered by a vite.web.config.ts alias (${specifiers.size}/${specifiers.size})` + (uncovered.length ? ` -> uncovered: ${uncovered.join(", ")}` : ""))
}

console.log(`\nsurface-parity: ${pass} passed, ${fail} failed`)
if (fail) {
  console.error(failures.join("\n"))
  process.exit(1)
}
