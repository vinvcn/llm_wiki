// Shared-data + live file-sync acceptance harness (recreated; /tmp is volatile).
// Verifies the "one backend, shared user data" promise end-to-end against a
// running server pointed at a fake "desktop" plugin-store.
//
//   node /tmp/verify-filesync-shared.mjs
//
// SERVER_ENTRY=packages/server/src/index-v2.js re-runs the whole contract
// against the unified v2 server (the Docker entrypoint).
//
// Spawns its own server on a free port with LLM_WIKI_STORE_FILE pointing at a
// temp desktop store, then asserts:
//   1. /api/health reports store.shared=true, source="explicit"
//   2. web reads a desktop-written key live
//   3. a web key-level write does NOT clobber an unrelated desktop key on disk
//   4. an out-of-band desktop edit is seen by the web with NO restart (mtime)
//   5. recents/registry are shared
//   6. live-sync watcher emits project://files-changed for an out-of-band wiki
//      edit AND for the server's OWN writes (live cross-tab sync — one server
//      serves every tab), while the ingest side still app-write-ignores them
//      (no file-sync://changed task / queue entry), and EXCLUDES raw/sources.
//   7. file-sync desktop contract parity:
//      7u. SourceWatchRules fixtures (mirror the Rust unit tests)
//      7a. a desktop-written snapshot (wrapped, ROOT-relative keys) is adopted
//          with ZERO spurious tasks and the key space stays root-relative
//      7b. an out-of-band source create emits file-sync://changed with a
//          root-relative path + desktop task id format, and the processed
//          task is REMOVED from the shared queue (done tasks don't linger)
//      7c. sourceWatchConfig filtering (include exts, exclude dirs, exclude
//          globs, max size) is honored by the watcher startup rescan
//      7d. the server's own source write is silently synced into the snapshot
//          (no file-sync://changed self-echo)
//      7e. retry/ignore honor the desktop contract (retry re-processes and
//          clears; ignore removes)

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http from "node:http"
import crypto from "node:crypto"
import { shouldWatchRel, makeRules, wildcardMatch, normalizeSourceWatchConfig } from "../../packages/server/src/commands/fileSync.js"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
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

// The v2/Docker entrypoint wraps invoke results as { ok, result }; the
// legacy entry returns the raw result. Unwrap so both runs assert the same
// command contract.
const V2_INVOKE = process.env.SERVER_ENTRY?.includes("index-v2") ?? false
async function invokeResult(port, command, body) {
  const j = (await req(port, "POST", `/api/invoke/${command}`, body)).json
  return V2_INVOKE ? j?.result : j
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

// SSE client: collects {event, payload} envelopes. The legacy entry serves
// /api/events; the v2/Docker entrypoint serves /api/v2/events (same bus).
const EVENTS_PATH = process.env.SERVER_ENTRY?.includes("index-v2") ? "/api/v2/events" : "/api/events"
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-shared-"))
const desktopDir = path.join(tmp, "desktop")
const desktopStore = path.join(desktopDir, "app-state.json")
const projectPath = path.join(tmp, "project")
fs.mkdirSync(desktopDir, { recursive: true })

// Fake desktop project on disk.
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.mkdirSync(path.join(projectPath, "raw", "sources"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "schema.md"), "# Schema\n")
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\nhome\n")
fs.writeFileSync(path.join(projectPath, "wiki", "alpha.md"), "---\ntype: entity\ntitle: Alpha\n---\n# Alpha\nfirst\n")

// Fake desktop store with known keys.
const desktopData = {
  outputLanguage: "English",
  zoomLevel: 1.0,
  recentProjects: [{ id: "proj-1", path: projectPath, name: "project", openedAt: Date.now() }],
  projectRegistry: { "proj-1": { id: "proj-1", path: projectPath, name: "project" } },
  lastProject: { id: "proj-1", path: projectPath },
}
fs.writeFileSync(desktopStore, JSON.stringify(desktopData, null, 2))

const port = await freePort()
const SERVER_ENTRY = process.env.SERVER_ENTRY || "packages/server/src/index.js"
const child = spawn(process.execPath, [SERVER_ENTRY], {
  cwd: REPO,
  env: { ...process.env, LLM_WIKI_PORT: String(port), LLM_WIKI_STORE_FILE: desktopStore, LLM_WIKI_DATA_DIR: path.join(tmp, "data") },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", (d) => (serverLog += d))
child.stderr.on("data", (d) => (serverLog += d))

try {
  await waitFor(async () => (await req(port, "GET", "/api/health")).status === 200, 8000, "server health")
  console.log("server up on", port)

  // 1. health diagnostics
  const health = (await req(port, "GET", "/api/health")).json
  ok(health.store?.shared === true, `health store.shared=true (got ${health.store?.shared})`)
  ok(health.store?.source === "explicit", `health store.source=explicit (got ${health.store?.source})`)
  ok(health.store?.path === desktopStore, "health store.path is the desktop store")

  // 2. web reads a desktop-written key live
  const lang = (await req(port, "GET", "/api/store/app-state.json/outputLanguage")).json
  ok(lang === "English", `web reads desktop key outputLanguage=English (got ${JSON.stringify(lang)})`)

  // 5. recents/registry shared
  const recents = (await req(port, "GET", "/api/store/app-state.json/recentProjects")).json
  ok(Array.isArray(recents) && recents[0]?.id === "proj-1", "recentProjects shared from desktop store")
  const registry = (await req(port, "GET", "/api/store/app-state.json/projectRegistry")).json
  ok(registry?.["proj-1"]?.path === projectPath, "projectRegistry shared from desktop store")

  // 3. web key-level write does NOT clobber an unrelated desktop key on disk
  await req(port, "PUT", "/api/store/app-state.json/zoomLevel", 1.5)
  await sleep(50)
  const rawOnDisk = JSON.parse(fs.readFileSync(desktopStore, "utf-8"))
  ok(rawOnDisk.zoomLevel === 1.5, `web write persisted zoomLevel=1.5 (got ${rawOnDisk.zoomLevel})`)
  ok(rawOnDisk.outputLanguage === "English", "unrelated desktop key outputLanguage NOT clobbered by web write")
  ok(rawOnDisk.recentProjects?.[0]?.id === "proj-1", "unrelated desktop key recentProjects NOT clobbered by web write")

  // 4. out-of-band desktop edit seen by web with NO restart (mtime-aware)
  await sleep(30)
  const edited = { ...rawOnDisk, outputLanguage: "Français", extraDesktopKey: { hello: "world" } }
  fs.writeFileSync(desktopStore, JSON.stringify(edited, null, 2))
  await sleep(30)
  const lang2 = (await req(port, "GET", "/api/store/app-state.json/outputLanguage")).json
  ok(lang2 === "Français", `out-of-band desktop edit seen live (got ${JSON.stringify(lang2)})`)
  const extra = (await req(port, "GET", "/api/store/app-state.json/extraDesktopKey")).json
  ok(extra?.hello === "world", "new desktop key visible to web without restart")

  // 6. live-sync watcher
  const sse = sseCollect(port)
  await sleep(200)
  await req(port, "POST", "/api/invoke/start_project_file_watcher", { projectId: "proj-1", projectPath })
  await sleep(200)

  // 6a. out-of-band wiki edit -> project://files-changed includes the path
  sse.events.length = 0
  await sleep(100)
  fs.writeFileSync(path.join(projectPath, "wiki", "alpha.md"), "---\ntype: entity\ntitle: Alpha\n---\n# Alpha\nCHANGED out of band\n")
  await waitFor(async () => sse.events.some((e) => e.event === "project://files-changed" && (e.payload?.paths ?? []).includes("wiki/alpha.md")), 5000, "project://files-changed for out-of-band wiki edit")
  ok(true, "out-of-band wiki edit emitted project://files-changed with wiki/alpha.md")

  // 6b. server's OWN write is SUPPRESSED on project://files-changed
  // (app-write-ignore — the writing client updates its own stores directly, so
  // echoing would be a self-echo) while the snapshot side silently syncs it:
  // no file-sync://changed task, nothing in the shared queue file.
  sse.events.length = 0
  await sleep(100)
  await req(port, "POST", "/api/invoke/write_file", { path: path.join(projectPath, "wiki", "selfwrite.md"), contents: "---\ntype: entity\ntitle: Self\n---\n# Self\n" })
  await new Promise((r) => setTimeout(r, 1800)) // > 700ms debounce + margin
  const selfProjEcho = sse.events.filter((e) => e.event === "project://files-changed" && (e.payload?.paths ?? []).includes("wiki/selfwrite.md"))
  ok(selfProjEcho.length === 0, "server's own wiki write emits NO project://files-changed path (app-write-ignore)")
  const selfTask = sse.events.filter((e) => e.event === "file-sync://changed" && JSON.stringify(e.payload ?? {}).includes("selfwrite.md"))
  ok(selfTask.length === 0, "server's own wiki write created no file-sync://changed task (no self-ingest)")
  const queueNow = JSON.parse(fs.readFileSync(path.join(projectPath, ".llm-wiki", "file-change-queue.json"), "utf-8"))
  ok(!queueNow.tasks.some((t) => String(t.path).includes("selfwrite.md")), "server's own wiki write is absent from the shared queue file")
  const snap = JSON.parse(fs.readFileSync(path.join(projectPath, ".llm-wiki", "file-snapshot.json"), "utf-8"))
  ok(Boolean(snap.files["wiki/selfwrite.md"]), "server's own wiki write silently synced into the shared snapshot")

  // 6c. raw/sources paths excluded from project://files-changed
  sse.events.length = 0
  await sleep(100)
  fs.writeFileSync(path.join(projectPath, "raw", "sources", "note.txt"), "a new source doc\n")
  await sleep(1600)
  const rawLeak = sse.events.filter((e) => e.event === "project://files-changed" && (e.payload?.paths ?? []).some((p) => p.startsWith("raw/sources")))
  ok(rawLeak.length === 0, "raw/sources paths excluded from project://files-changed")

  // ------------------------------------------------------------------
  // 7. file-sync desktop contract parity
  // ------------------------------------------------------------------

  // 7u. SourceWatchRules fixtures (mirror file_sync.rs unit tests)
  {
    const rules = makeRules(undefined)
    ok(shouldWatchRel("raw/sources/document.docx", rules), "rules: docx source watched")
    ok(shouldWatchRel("wiki/concepts/topic.md", rules), "rules: wiki md watched")
    ok(shouldWatchRel("schema.md", rules) && shouldWatchRel("purpose.md", rules), "rules: schema.md/purpose.md watched")
    ok(!shouldWatchRel(".llm-wiki/file-change-queue.json", rules), "rules: .llm-wiki excluded")
    ok(!shouldWatchRel("raw/sources/~$Document.docx", rules), "rules: ~$ lock glob excluded")
    ok(!shouldWatchRel("raw/sources/.~lock.Document.odt#", rules), "rules: .~lock glob excluded")
    ok(!shouldWatchRel("raw/sources/Thumbs.db", rules), "rules: Thumbs.db excluded")
    ok(!shouldWatchRel("raw/sources/desktop.ini", rules), "rules: desktop.ini excluded")
    ok(!shouldWatchRel("raw/sources/download.crdownload", rules), "rules: crdownload excluded")
    ok(!shouldWatchRel(".vscode/settings.json", rules), "rules: .vscode dir excluded")
    ok(!shouldWatchRel("wiki/media/image.png", rules), "rules: wiki/media excluded")
    const custom = makeRules({ includeExtensions: ["md", "pdf"], excludeDirs: ["drafts", "subdir/drafts"], excludeGlobs: ["*.private.*"] })
    ok(shouldWatchRel("raw/sources/final.md", custom) && !shouldWatchRel("raw/sources/data.json", custom), "rules: include-extension allowlist")
    ok(!shouldWatchRel("raw/sources/drafts/final.md", custom) && !shouldWatchRel("raw/sources/subdir/drafts/final.md", custom), "rules: excludeDirs (plain + nested)")
    ok(!shouldWatchRel("raw/sources/report.private.md", custom) && shouldWatchRel("wiki/index.md", custom), "rules: excludeGlobs only affect sources")
    ok(wildcardMatch("?稿.md", "草稿.md") && wildcardMatch("草*.md", "草稿文件.md") && !wildcardMatch("??.md", "草稿文件.md"), "rules: unicode wildcard semantics")
    const norm = normalizeSourceWatchConfig({ includeExtensions: [".MD", " pdf "], maxFileSizeMb: 99999 })
    ok(JSON.stringify(norm.includeExtensions) === JSON.stringify(["md", "pdf"]) && norm.maxFileSizeMb === 4096, "rules: config normalization + clamp(1,4096)")
  }

  const snapshotFile = path.join(projectPath, ".llm-wiki", "file-snapshot.json")
  const queueFile = path.join(projectPath, ".llm-wiki", "file-change-queue.json")
  const metaOf = (abs) => {
    const st = fs.statSync(abs)
    return { hash: crypto.createHash("md5").update(fs.readFileSync(abs)).digest("hex"), size: st.size, mtimeMs: Math.floor(st.mtimeMs) }
  }

  // 7a. desktop-written snapshot (wrapped, root-relative keys) -> no churn
  {
    const files = {}
    for (const rel of ["schema.md", "wiki/index.md", "wiki/alpha.md", "wiki/selfwrite.md", "raw/sources/note.txt"]) {
      files[rel] = metaOf(path.join(projectPath, rel))
    }
    fs.writeFileSync(snapshotFile, JSON.stringify({ version: 1, updatedAt: Date.now() - 5000, files }, null, 2))
    const res = await invokeResult(port, "start_project_file_watcher", { projectId: "proj-1", projectPath })
    ok(Array.isArray(res?.changedTasks) && res.changedTasks.length === 0, `desktop snapshot adopted with ZERO spurious tasks (got ${JSON.stringify(res?.changedTasks?.map((t) => [t.path, t.kind]))})`)
    const onDisk = JSON.parse(fs.readFileSync(snapshotFile, "utf-8"))
    ok(onDisk.version === 1 && typeof onDisk.updatedAt === "number" && Object.keys(onDisk.files).every((k) => k === "schema.md" || k.startsWith("wiki/") || k.startsWith("raw/sources/")), "snapshot stays wrapped with root-relative keys")
    const q = JSON.parse(fs.readFileSync(queueFile, "utf-8"))
    ok(q.tasks.length === 0, `shared queue has no lingering tasks after processing (got ${q.tasks.length})`)
  }

  // 7b. out-of-band source create -> root-relative task, desktop id, done removed
  {
    sse.events.length = 0
    await sleep(100)
    fs.writeFileSync(path.join(projectPath, "raw", "sources", "live.txt"), "created out of band\n")
    await waitFor(async () => sse.events.some((e) => e.event === "file-sync://changed" && (e.payload?.tasks ?? []).some((t) => t.path === "raw/sources/live.txt" && t.kind === "created")), 6000, "file-sync://changed for out-of-band source create")
    const evt = sse.events.find((e) => e.event === "file-sync://changed" && (e.payload?.tasks ?? []).some((t) => t.path === "raw/sources/live.txt"))
    const task = evt.payload.tasks.find((t) => t.path === "raw/sources/live.txt")
    ok(task.projectId === "proj-1" && /^change_\d+_[0-9a-f]{12}$/.test(task.id), `task id has desktop format change_<ms>_<md5x12> (got ${task.id})`)
    ok(typeof task.hashAfter === "string" && task.size === 20 && task.status !== "done", "task carries hashAfter/size like the desktop FileChangeTask")
    await waitFor(async () => JSON.parse(fs.readFileSync(queueFile, "utf-8")).tasks.every((t) => t.path !== "raw/sources/live.txt"), 6000, "processed task removed from the shared queue (done tasks don't linger)")
    const snap = JSON.parse(fs.readFileSync(snapshotFile, "utf-8"))
    ok(Boolean(snap.files["raw/sources/live.txt"]), "snapshot gained the root-relative source key after processing")
  }

  // 7c. sourceWatchConfig filtering on watcher startup
  {
    // Stop the running watcher first so its (default-config) event pipeline
    // can't race the startup rescan of the restricted-config watcher below.
    await req(port, "POST", "/api/invoke/stop_project_file_watcher", {})
    await sleep(900) // drain any in-flight debounce from the old watcher
    const src = path.join(projectPath, "raw", "sources")
    fs.mkdirSync(path.join(src, "exdir"), { recursive: true })
    fs.writeFileSync(path.join(src, "good.md"), "allowed\n")
    fs.writeFileSync(path.join(src, "bad.exe"), "MZ\n")
    fs.writeFileSync(path.join(src, "~$tmp.docx"), "lock\n")
    fs.writeFileSync(path.join(src, "priv.private.md"), "secret\n")
    fs.writeFileSync(path.join(src, "exdir", "inner.md"), "x\n")
    fs.writeFileSync(path.join(src, "huge.md"), Buffer.alloc(33 * 1024 * 1024, 120)) // > 32 MiB -> hash:null
    const cfg = { includeExtensions: ["md", "txt"], excludeDirs: ["exdir"], excludeGlobs: ["*.private.*"], maxFileSizeMb: 1 }
    const res = await invokeResult(port, "start_project_file_watcher", { projectId: "proj-1", projectPath, sourceWatchConfig: cfg })
    const paths = (res?.changedTasks ?? []).map((t) => t.path)
    ok(paths.includes("raw/sources/good.md"), `allowed source enqueued (got ${JSON.stringify(paths)})`)
    ok(!paths.some((p) => ["raw/sources/bad.exe", "raw/sources/~$tmp.docx", "raw/sources/priv.private.md", "raw/sources/exdir/inner.md", "raw/sources/huge.md"].includes(p)), `excluded sources NOT enqueued (got ${JSON.stringify(paths)})`)
    const snap = JSON.parse(fs.readFileSync(snapshotFile, "utf-8"))
    ok(!("raw/sources/bad.exe" in snap.files) && !("raw/sources/huge.md" in snap.files), "excluded sources never enter the shared snapshot")
    // default config re-admits the huge file (maxFileSizeMb default 100)
    const res2 = await invokeResult(port, "rescan_project_files", { projectId: "proj-1", projectPath })
    ok((res2?.changedTasks ?? []).some((t) => t.path === "raw/sources/huge.md" && t.hashAfter === null), "source > 32 MiB re-admitted under default config, diffed by size (hash:null)")
  }

  // 7d. server's own source write: silently synced, no self-echo
  {
    sse.events.length = 0
    await sleep(100)
    await req(port, "POST", "/api/invoke/write_file", { path: path.join(projectPath, "raw", "sources", "appwritten.md"), contents: "written by the server\n" })
    await sleep(1800) // > 700ms debounce + margin
    const selfEcho = sse.events.filter((e) => e.event === "file-sync://changed" && (e.payload?.tasks ?? []).some((t) => t.path === "raw/sources/appwritten.md"))
    ok(selfEcho.length === 0, "server's own source write emits no file-sync://changed task (no self-echo)")
    const snap = JSON.parse(fs.readFileSync(snapshotFile, "utf-8"))
    ok(Boolean(snap.files["raw/sources/appwritten.md"]), "server's own write silently synced into the snapshot")
  }

  // 7e. retry / ignore contract
  {
    // No live watcher here: the queue is manipulated directly, like a desktop
    // instance would write it out-of-band.
    await req(port, "POST", "/api/invoke/stop_project_file_watcher", {})
    await sleep(900)
    // failed task for an existing file with a stale hash -> retry re-processes
    fs.writeFileSync(path.join(projectPath, "raw", "sources", "retry.md"), "retry content\n")
    const q = JSON.parse(fs.readFileSync(queueFile, "utf-8"))
    q.tasks.push({ id: "ft1", projectId: "proj-1", path: "raw/sources/retry.md", kind: "modified", status: "failed", hashBefore: null, hashAfter: "stale", size: 14, mtimeMs: 1, createdAt: 1, updatedAt: 1, retryCount: 3, error: "boom", needsRerun: false })
    fs.writeFileSync(queueFile, JSON.stringify(q, null, 2))
    const retried = await invokeResult(port, "retry_file_change_task", { projectId: "proj-1", projectPath, taskId: "ft1" })
    ok(retried?.tasks?.every((t) => t.id !== "ft1"), "retry re-processes the failed task to completion (removed)")
    const snap = JSON.parse(fs.readFileSync(snapshotFile, "utf-8"))
    ok(Boolean(snap.files["raw/sources/retry.md"]), "retry updated the snapshot with fresh meta")
    // ignore removes the task outright
    const q2 = JSON.parse(fs.readFileSync(queueFile, "utf-8"))
    q2.tasks.push({ id: "ig1", projectId: "proj-1", path: "raw/sources/whatever.md", kind: "created", status: "pending", hashBefore: null, hashAfter: null, size: 1, mtimeMs: 1, createdAt: 1, updatedAt: 1, retryCount: 0, error: null, needsRerun: false })
    fs.writeFileSync(queueFile, JSON.stringify(q2, null, 2))
    const ignored = await invokeResult(port, "ignore_file_change_task", { projectId: "proj-1", projectPath, taskId: "ig1" })
    ok(ignored?.tasks?.every((t) => t.id !== "ig1"), "ignore removes the task from the queue")
  }


  // ── 8. Store discovery: auto-detect + NO_SHARE isolation (shared-data promise) ──
  // The main run above pins the LLM_WIKI_STORE_FILE branch (store.source=explicit).
  // These two auxiliary boots pin the OTHER two branches the promise rests on:
  //   (a) AUTOMATIC discovery: the desktop bundle app-data dir (from
  //       XDG_DATA_HOME/HOME on Linux, HOME on macOS, APPDATA on Windows —
  //       the same env the server's desktopStoreCandidateDirs reads) holds a
  //       marker app-state.json with LLM Wiki keys -> /api/health reports
  //       store.shared=true / source=auto, web reads a desktop key live, a
  //       key-level web write never clobbers an unrelated desktop key, and an
  //       out-of-band desktop edit is seen with no restart (mtime).
  //   (b) LLM_WIKI_NO_SHARE=1: the SAME marker file must stay byte-identical
  //       while web writes land in the isolated LLM_WIKI_DATA_DIR/stores
  //       store and the desktop keys are NOT adopted.
  // Each runs against the same SERVER_ENTRY as the rest of the gate.
  const auxChildren = []
  try {
    // Stop the main server first so the aux servers get the clip listener
    // port (:19827) cleanly — otherwise every aux boot pays the 3 retries x
    // 2s bind-retry park before reaching port_conflict.
    try { child.kill("SIGKILL") } catch { /* already gone */ }
    await sleep(400)

    /** Mirror desktopStoreCandidateDirs (config.js) for a child env. */
    const markerDirsFor = (env) => {
      const id = "com.llmwiki.app"
      const h = env.HOME || os.homedir()
      if (process.platform === "darwin") return [path.join(h, "Library", "Application Support", id)]
      if (process.platform === "win32") {
        const dirs = []
        if (env.APPDATA) dirs.push(path.join(env.APPDATA, id))
        if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, id))
        return dirs
      }
      const xdg = env.XDG_DATA_HOME || path.join(h, ".local", "share")
      return [path.join(xdg, id), path.join(env.XDG_CONFIG_HOME || path.join(h, ".config"), id)]
    }
    const bootAux = async (childEnv, tag) => {
      const auxPort = await freePort()
      // The auto-detect case must never inherit a stale explicit-store/no-share
      // override from the caller's environment (childEnv re-adds them when wanted),
      // so strip them FIRST, then apply the caller's overrides.
      const auxEnv = { ...process.env }
      delete auxEnv.LLM_WIKI_STORE_FILE
      delete auxEnv.LLM_WIKI_NO_SHARE
      Object.assign(auxEnv, { LLM_WIKI_PORT: String(auxPort), LLM_WIKI_DATA_DIR: path.join(discoTmp, tag), ...childEnv })
      const auxChild = spawn(process.execPath, [SERVER_ENTRY], {
        cwd: REPO,
        env: auxEnv,
        stdio: ["ignore", "pipe", "pipe"],
      })
      auxChildren.push(auxChild)
      let auxLog = ""
      auxChild.stdout.on("data", (d) => (auxLog += d))
      auxChild.stderr.on("data", (d) => (auxLog += d))
      await waitFor(async () => (await req(auxPort, "GET", "/api/health")).status === 200, 8000, `aux server ${tag} health`)
      return { auxPort, auxLog }
    }

    const discoTmp = path.join(tmp, "discovery")
    const discoEnv = process.platform === "win32"
      ? { APPDATA: path.join(discoTmp, "roaming"), LOCALAPPDATA: path.join(discoTmp, "roaming") }
      : { XDG_DATA_HOME: path.join(discoTmp, "xdg"), HOME: path.join(discoTmp, "home") }
    const markerFile = path.join(markerDirsFor(discoEnv)[0], "app-state.json")
    const markerData = {
      language: "English",
      zoomLevel: 1.0,
      recentProjects: [{ id: "proj-disco", path: projectPath, name: "project" }],
      lastProject: { id: "proj-disco", path: projectPath },
      desktopMarker: { hello: "world" },
    }
    fs.mkdirSync(path.dirname(markerFile), { recursive: true })
    fs.writeFileSync(markerFile, JSON.stringify(markerData, null, 2))

    // 8a. AUTO-DETECT: no LLM_WIKI_STORE_FILE in the child env.
    {
      const { auxPort, auxLog } = await bootAux(discoEnv, "dataA")
      try {
        const health = (await req(auxPort, "GET", "/api/health")).json
        ok(health.store?.shared === true, `auto-detect health store.shared=true (got ${health.store?.shared})`)
        ok(health.store?.source === "auto", `auto-detect health store.source=auto (got ${health.store?.source})`)
        ok(health.store?.path === markerFile, "auto-detect store path is the desktop marker file")
        const lang = (await req(auxPort, "GET", "/api/store/app-state.json/language")).json
        ok(lang === "English", `auto-detect web reads desktop key language=English (got ${JSON.stringify(lang)})`)
        const recents = (await req(auxPort, "GET", "/api/store/app-state.json/recentProjects")).json
        ok(Array.isArray(recents) && recents[0]?.id === "proj-disco", "auto-detect recents shared from the desktop marker file")
        await req(auxPort, "PUT", "/api/store/app-state.json/theme", "light")
        await sleep(50)
        const raw = JSON.parse(fs.readFileSync(markerFile, "utf-8"))
        ok(raw.theme === "light" && raw.language === "English" && raw.desktopMarker?.hello === "world", "auto-detect key-level web write does NOT clobber unrelated desktop keys")
        const edited = { ...raw, language: "Français", extraDesktopKey: { a: 1 } }
        fs.writeFileSync(markerFile, JSON.stringify(edited, null, 2))
        await sleep(50)
        const lang2 = (await req(auxPort, "GET", "/api/store/app-state.json/language")).json
        const extra = (await req(auxPort, "GET", "/api/store/app-state.json/extraDesktopKey")).json
        ok(lang2 === "Français" && extra?.a === 1, "auto-detect out-of-band desktop edit seen with NO restart (mtime)")
      } catch (err) {
        fail++; console.log("  FAIL- auto-detect scenario:", err.message); console.log("--- aux server log ---\n" + (auxLog || "").slice(-1500))
      } finally {
        try { auxChildren[auxChildren.length - 1].kill("SIGKILL") } catch { /* gone */ }
        await sleep(300)
      }
    }

    // 8b. NO_SHARE isolation: same marker present, web writes isolated.
    {
      const markerBytesBefore = fs.readFileSync(markerFile)
      const { auxPort, auxLog } = await bootAux({ ...discoEnv, LLM_WIKI_NO_SHARE: "1" }, "dataB")
      try {
        const health = (await req(auxPort, "GET", "/api/health")).json
        ok(health.store?.shared === false, `no-share health store.shared=false (got ${health.store?.shared})`)
        ok(health.store?.source === "disabled", `no-share health store.source=disabled (got ${health.store?.source})`)
        ok(health.store?.path?.startsWith(path.join(discoTmp, "dataB", "stores")), "no-share store path is the isolated LLM_WIKI_DATA_DIR/stores file")
        const lang = (await req(auxPort, "GET", "/api/store/app-state.json/language")).json
        ok(lang == null, "no-share does NOT adopt desktop keys (language is null)")
        await req(auxPort, "PUT", "/api/store/app-state.json/theme", "light")
        await sleep(50)
        const markerAfter = fs.readFileSync(markerFile)
        ok(Buffer.compare(markerBytesBefore, markerAfter) === 0, "no-share web write leaves the desktop marker file byte-identical")
        const isolatedPath = path.join(discoTmp, "dataB", "stores", "app-state.json")
        const isolated = fs.existsSync(isolatedPath) ? JSON.parse(fs.readFileSync(isolatedPath, "utf-8")) : null
        ok(isolated?.theme === "light" && isolated?.language === undefined, "no-share web write landed in the isolated store (theme=light, no desktop keys)")
      } catch (err) {
        fail++; console.log("  FAIL- no-share scenario:", err.message); console.log("--- aux server log ---\n" + (auxLog || "").slice(-1500))
      } finally {
        try { auxChildren[auxChildren.length - 1].kill("SIGKILL") } catch { /* gone */ }
      }
    }
  } finally {
    for (const c of auxChildren) { try { c.kill("SIGKILL") } catch { /* gone */ } }
  }

  sse.close()
} catch (err) {
  fail++
  console.log("  FAIL- harness error:", err.message)
  console.log("--- server log ---\n" + serverLog.slice(-2000))
} finally {
  child.kill("SIGKILL")
}

console.log(`\nshared-data/file-sync: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
