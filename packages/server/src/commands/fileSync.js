import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import { emit } from "../events.js"
import { isAppWriteIgnored } from "../appwrite.js"

// Faithful Node port of src-tauri/src/commands/file_sync.rs (source-folder
// auto-watch + change queue). Contract details that MUST match the desktop,
// because both clients share the same on-disk snapshot/queue and the same
// React frontend:
//   - snapshot keys and task paths are PROJECT-ROOT-relative forward-slash
//     paths ("raw/sources/doc.pdf", "wiki/index.md", "schema.md");
//   - the snapshot is wrapped { version, updatedAt, files: { rel: FileMeta } }
//     (reading also tolerates the legacy flat map an older web server wrote);
//   - which files are watched is decided by SourceWatchRules (the frontend's
//     `sourceWatchConfig` argument: include/exclude extensions, excluded dirs,
//     exclude globs, max file size) exactly like `should_watch_rel`;
//   - "modified" is decided by (hash, size), not mtime; sources > 32 MiB get
//     hash:null and diff by size (MAX_HASH_BYTES);
//   - tasks upsert/merge by (projectId, path) while pending/processing/failed,
//     processed tasks update the snapshot and are REMOVED (status done);
//   - the server's own writes (app-write-ignore) are silently synced into the
//     snapshot instead of becoming tasks (no self-ingest self-echo).
//
// `project://files-changed` (live tree refresh for the open web UI) mirrors
// the desktop's own-write suppression: anything the server itself writes
// (app-write-ignore) is NOT broadcast — the writing client updates its own
// stores directly, so echoing would be a self-echo. Out-of-band edits (the
// desktop app, another process) are delivered live, and a tiny allowlist of
// `.llm-wiki` state files (review.json) is delivered for out-of-band writes
// only, so cross-client review sync works while self-writes stay quiet.

const SNAPSHOT_FILE = ".llm-wiki/file-snapshot.json"
const QUEUE_FILE = ".llm-wiki/file-change-queue.json"
const EVENT_QUEUE_UPDATED = "file-sync://queue-updated"
const EVENT_CHANGED = "file-sync://changed"
const EVENT_PROJECT_CHANGED = "project://files-changed"
const MAX_HASH_BYTES = 32 * 1024 * 1024
const MAX_RETRY_COUNT = 3
const QUEUE_EMIT_EVERY = 25
const RESCAN_DEBOUNCE_MS = 700
// Desktop's LINUX_RESCAN_INTERVAL_MS periodic safety-net rescan.
const PERIODIC_RESCAN_MS = 10_000
const STARTUP_PREFIXES = ["raw/sources", "wiki", "purpose.md", "schema.md"]
// Tree-refresh events (project://files-changed) skip these top-level dirs;
// separate from the source-watch rules, which have their own excludeDirs.
const IGNORED_TOP = new Set([".llm-wiki", ".obsidian", ".git", "node_modules", ".cache", ".superpowers"])
// Cross-client live state: a small allowlist of `.llm-wiki` state files whose
// EXTERNAL edits (e.g. the desktop app resolving/writing a review item) are
// delivered on `project://files-changed` so the open web client can live-reload
// them (issue #13 item 3). Everything else under `.llm-wiki` stays ignored:
// chat/queue/history are read from disk on access (no client-held cache), and
// the server's own writes are suppressed by app-write-ignore regardless.
const PROJECT_STATE_ALLOWLIST = new Set([".llm-wiki/review.json"])

const fwd = (p) => p.split(path.sep).join("/")

// ---------------------------------------------------------------------------
// SourceWatchConfig: defaults + normalization (mirrors normalize_source_watch_config)

// Rust `include_str!`s the SAME file the frontend ships, so the defaults can
// never drift between the three. Resolve relative to this module so it works
// regardless of the server's cwd; fall back to an embedded copy if the server
// is ever installed standalone.
const EMBEDDED_DEFAULTS = {
  enabled: true,
  autoIngest: true,
  includeExtensions: ["md", "mdx", "txt", "org", "pdf", "doc", "docx", "pptx", "xls", "xlsx", "odt", "odp", "ods", "rtf", "html", "htm", "csv"],
  excludeExtensions: ["tmp", "temp", "bak", "swp", "part", "partial", "crdownload", "exe", "dll", "so", "dylib", "bin", "iso", "dmg"],
  excludeDirs: [".git", ".svn", ".hg", ".obsidian", ".idea", ".vscode", "node_modules", ".cache", "__pycache__"],
  excludeGlobs: ["~$*", ".~lock.*#", "*.draft.*", "draft-*", "*.private.*"],
  maxFileSizeMb: 100,
}

function loadSharedDefaults() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const file = path.resolve(here, "..", "..", "..", "..", "src", "lib", "source-watch-defaults.json")
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"))
    if (parsed && typeof parsed === "object") return { ...EMBEDDED_DEFAULTS, ...parsed }
  } catch { /* fall back to embedded */ }
  return EMBEDDED_DEFAULTS
}

const DEFAULT_SOURCE_WATCH_CONFIG = loadSharedDefaults()

// normalize_ext_list: trim, strip leading '.', lowercase, dedupe, sort.
function normalizeExtList(values) {
  const out = new Set()
  for (const raw of Array.isArray(values) ? values : []) {
    const v = String(raw).trim().replace(/^\.+/, "").toLowerCase()
    if (v) out.add(v)
  }
  return [...out].sort()
}

// normalize_string_list: trim, drop empty, dedupe, sort.
function normalizeStringList(values) {
  const out = new Set()
  for (const raw of Array.isArray(values) ? values : []) {
    const v = String(raw).trim()
    if (v) out.add(v)
  }
  return [...out].sort()
}

export function normalizeSourceWatchConfig(config) {
  const cfg = config && typeof config === "object" ? config : {}
  const d = DEFAULT_SOURCE_WATCH_CONFIG
  const maxSize = Number(cfg.maxFileSizeMb)
  return {
    enabled: cfg.enabled ?? d.enabled,
    autoIngest: cfg.autoIngest ?? d.autoIngest,
    includeExtensions: normalizeExtList(cfg.includeExtensions ?? d.includeExtensions),
    excludeExtensions: normalizeExtList(cfg.excludeExtensions ?? d.excludeExtensions),
    excludeDirs: normalizeStringList(cfg.excludeDirs ?? d.excludeDirs),
    excludeGlobs: normalizeStringList(cfg.excludeGlobs ?? d.excludeGlobs),
    maxFileSizeMb: Math.min(4096, Math.max(1, Number.isFinite(maxSize) ? Math.trunc(maxSize) : d.maxFileSizeMb)),
  }
}

// ---------------------------------------------------------------------------
// SourceWatchRules (mirrors should_watch_rel / relative_watch_path)

// wildcard_match: case-insensitive, Unicode-character based, '*' = any run,
// '?' = exactly one char. Code points mirror Rust's char semantics.
export function wildcardMatch(pattern, value) {
  const p = [...String(pattern).toLowerCase()]
  const v = [...String(value).toLowerCase()]
  let pi = 0
  let vi = 0
  let star = -1
  let matchAfterStar = 0
  while (vi < v.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === v[vi])) {
      pi += 1
      vi += 1
    } else if (pi < p.length && p[pi] === "*") {
      star = pi
      matchAfterStar = vi
      pi += 1
    } else if (star >= 0) {
      pi = star + 1
      matchAfterStar += 1
      vi = matchAfterStar
    } else {
      return false
    }
  }
  while (pi < p.length && p[pi] === "*") pi += 1
  return pi === p.length
}

function extensionOf(name) {
  const i = name.lastIndexOf(".")
  return i < 0 ? "" : name.slice(i + 1)
}

export function makeRules(config) {
  const cfg = normalizeSourceWatchConfig(config)
  return {
    config: cfg,
    includeExtensions: new Set(cfg.includeExtensions),
    excludeExtensions: new Set(cfg.excludeExtensions),
    // normalize_rel_string: backslashes -> '/', trim '/', lowercase.
    excludeDirs: cfg.excludeDirs
      .map((dir) => dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase())
      .filter((dir) => dir.length > 0),
    excludeGlobs: cfg.excludeGlobs,
  }
}

function matchesExcludedDir(relLower, rules) {
  return rules.excludeDirs.some((dir) => {
    if (dir.includes("/")) {
      return relLower === dir || relLower.startsWith(`${dir}/`) || relLower.includes(`/${dir}/`)
    }
    return relLower.split("/").some((part) => part === dir)
  })
}

export function shouldWatchRel(rel, rules) {
  if (!rel) return false
  const lower = rel.toLowerCase()
  if (
    lower.includes("/.llm-wiki/") ||
    lower.startsWith(".llm-wiki/") ||
    // App-managed generated media is intentionally ignored; the source
    // markdown references drive graph/index refresh, not the media bytes.
    lower.startsWith("wiki/media/") ||
    lower.endsWith(".ds_store")
  ) {
    return false
  }
  const name = lower.split("/").pop() ?? lower
  if (name === "thumbs.db" || name === "desktop.ini") return false
  if (matchesExcludedDir(lower, rules)) return false
  if (rules.excludeGlobs.some((pattern) => wildcardMatch(pattern, rel) || wildcardMatch(pattern, name))) {
    return false
  }
  if (rel.startsWith("raw/sources/")) {
    const ext = extensionOf(name)
    if (ext && rules.excludeExtensions.has(ext)) return false
    if (rules.includeExtensions.size > 0 && (!ext || !rules.includeExtensions.has(ext))) return false
    return true
  }
  return rel === "purpose.md" || rel === "schema.md" || (rel.startsWith("wiki/") && rel.endsWith(".md"))
}

function normalizeRelPath(root, abs) {
  const rel = path.relative(root, abs)
  if (!rel) return ""
  const parts = rel.split(path.sep)
  if (parts.some((part) => part === ".." || part === "")) return null
  return parts.join("/")
}

// relative_watch_path: root-relative rel if the path is watchable, else null.
// The max-size gate applies only to existing raw/sources files, like Rust.
export function relativeWatchPath(root, abs, rules, size) {
  const rel = normalizeRelPath(root, abs)
  if (rel == null || !shouldWatchRel(rel, rules)) return null
  if (rel.startsWith("raw/sources/") && fs.existsSync(abs)) {
    let sz = size
    if (sz == null) {
      try { sz = fs.statSync(abs).size } catch { return null }
    }
    if (sz > rules.config.maxFileSizeMb * 1024 * 1024) return null
  }
  return rel
}

// ---------------------------------------------------------------------------
// File meta + snapshot + queue persistence

function md5OfFile(file) {
  const hasher = crypto.createHash("md5")
  hasher.update(fs.readFileSync(file))
  return hasher.digest("hex")
}

// read_meta: null when missing/not a file; throws on stat/read errors (the
// desktop propagates those as task failures / command errors).
function readMeta(root, rel) {
  const abs = path.join(root, rel)
  let st
  try { st = fs.statSync(abs) } catch { return null }
  if (!st.isFile()) return null
  const size = st.size
  const mtimeMs = Math.floor(st.mtimeMs)
  const hash = size <= MAX_HASH_BYTES ? md5OfFile(abs) : null
  return { hash, size, mtimeMs }
}

// read_meta_fast: size+mtime only (no hashing) for cheap startup comparisons.
function readMetaFast(root, rel) {
  const abs = path.join(root, rel)
  let st
  try { st = fs.statSync(abs) } catch { return null }
  if (!st.isFile()) return null
  return { hash: null, size: st.size, mtimeMs: Math.floor(st.mtimeMs) }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")) } catch { return fallback }
}

// Atomic pretty-JSON write (tmp + rename), mirroring the desktop write_json so
// a concurrent reader on either client never sees a torn file.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.hrtime.bigint()}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8")
  try {
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* ignore */ }
    throw err
  }
}

function ensureSyncDir(root) {
  fs.mkdirSync(path.join(root, ".llm-wiki"), { recursive: true })
}

// The snapshot is shared on disk with the desktop app (FileSnapshot, camelCase,
// root-relative keys). Read tolerates the legacy flat map an older web server
// wrote; write always emits the desktop shape.
function loadSnapshotFiles(root) {
  const raw = readJson(path.join(root, SNAPSHOT_FILE), null)
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  if (raw.files && typeof raw.files === "object" && !Array.isArray(raw.files)) return raw.files
  const { version: _v, updatedAt: _u, ...flat } = raw
  return flat
}

function saveSnapshotFiles(root, files) {
  writeJson(path.join(root, SNAPSHOT_FILE), { version: 1, updatedAt: Date.now(), files })
}

function writeTaskMetaToSnapshot(root, rel, meta) {
  const files = loadSnapshotFiles(root)
  if (meta) files[rel] = meta
  else delete files[rel]
  saveSnapshotFiles(root, files)
}

// sync_snapshot_paths: silently bring the snapshot up to date for paths the
// server itself wrote (app-write-ignore), so they never become tasks later.
function syncSnapshotPaths(root, rels) {
  if (!rels.size) return
  const files = loadSnapshotFiles(root)
  for (const rel of rels) {
    let meta = null
    try { meta = readMeta(root, rel) } catch { meta = null }
    if (meta) files[rel] = meta
    else delete files[rel]
  }
  saveSnapshotFiles(root, files)
}

function loadQueue(root) {
  const q = readJson(path.join(root, QUEUE_FILE), null)
  if (q && typeof q === "object" && !Array.isArray(q) && Array.isArray(q.tasks)) {
    return { version: typeof q.version === "number" && q.version > 0 ? q.version : 1, tasks: q.tasks }
  }
  return { version: 1, tasks: [] }
}

function saveQueue(root, queue) {
  writeJson(path.join(root, QUEUE_FILE), queue)
}

// ---------------------------------------------------------------------------
// Queue mutation (mirrors upsert_task / merge_kind / process_queue)

// stable_path_hash: first 12 hex chars of md5(path).
function stablePathHash(rel) {
  return crypto.createHash("md5").update(rel).digest("hex").slice(0, 12)
}

// normalize_key: case-insensitive on Windows, identity elsewhere.
function normalizeKey(p) {
  return process.platform === "win32" ? p.toLowerCase() : p
}

function mergeKind(existing, incoming) {
  if ((existing === "deleted" && incoming === "created") ||
      (existing === "created" && incoming === "deleted") ||
      incoming === "modified") {
    return "modified"
  }
  return incoming
}

function sameHashSize(oldMeta, newMeta) {
  if (!oldMeta && !newMeta) return true
  if (!oldMeta || !newMeta) return false
  return (oldMeta.hash ?? null) === (newMeta.hash ?? null) && oldMeta.size === newMeta.size
}

function upsertTask(queue, projectId, rel, kind, oldMeta, newMeta, now) {
  const key = normalizeKey(rel)
  const existing = queue.tasks.find((t) =>
    t.projectId === projectId &&
    normalizeKey(t.path) === key &&
    (t.status === "pending" || t.status === "processing" || t.status === "failed"))
  if (existing) {
    existing.kind = mergeKind(existing.kind, kind)
    existing.hashAfter = newMeta?.hash ?? null
    existing.size = newMeta?.size ?? oldMeta?.size ?? null
    existing.mtimeMs = newMeta?.mtimeMs ?? null
    existing.updatedAt = now
    if (existing.status === "failed") {
      if (existing.retryCount < MAX_RETRY_COUNT) {
        existing.status = "pending"
        existing.error = null
      } else {
        existing.error = `Retry limit reached (${MAX_RETRY_COUNT})`
      }
    } else if (existing.status === "processing") {
      existing.needsRerun = true
      existing.error = null
    } else {
      existing.error = null
    }
    return
  }
  queue.tasks.push({
    id: `change_${now}_${stablePathHash(rel)}`,
    projectId,
    path: rel,
    kind,
    status: "pending",
    hashBefore: oldMeta?.hash ?? null,
    hashAfter: newMeta?.hash ?? null,
    // Deleted tasks keep the previous size so frontend rename detection can
    // reject empty/tiny hash matches without disabling all moves.
    size: newMeta?.size ?? oldMeta?.size ?? null,
    mtimeMs: newMeta?.mtimeMs ?? null,
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
    error: null,
    needsRerun: false,
  })
}

// enqueue_paths: hash-diff the candidate rels against the snapshot and upsert
// tasks for real (hash, size) changes.
function enqueuePaths(root, projectId, rels, opts = {}) {
  const appWritten = opts.appWritten ?? new Set()
  const snapshotFiles = loadSnapshotFiles(root)
  const now = Date.now()
  const changes = []
  for (const rel of rels instanceof Set ? rels : new Set(rels)) {
    if (appWritten.has(rel)) {
      // App-write-ignore in the rescan paths too: the server's own write is
      // silently brought in line with the snapshot (created/modified/deleted)
      // instead of becoming a task — a rescan must never re-enqueue what this
      // server just wrote (the desktop's event path does this via
      // sync_snapshot_paths; rescans reach the same end state here).
      let meta = null
      try { meta = readMeta(root, rel) } catch { meta = null }
      if (meta) snapshotFiles[rel] = meta
      else delete snapshotFiles[rel]
      continue
    }
    const oldMeta = Object.prototype.hasOwnProperty.call(snapshotFiles, rel) ? snapshotFiles[rel] : null
    const newMeta = readMeta(root, rel)
    if (sameHashSize(oldMeta, newMeta)) continue
    let kind
    if (!oldMeta && newMeta) kind = "created"
    else if (oldMeta && !newMeta) kind = "deleted"
    else if (oldMeta && newMeta) kind = "modified"
    else continue
    changes.push([rel, kind, oldMeta, newMeta])
  }
  if (appWritten.size > 0) saveSnapshotFiles(root, snapshotFiles)
  if (changes.length === 0) return
  const queue = loadQueue(root)
  for (const [rel, kind, oldMeta, newMeta] of changes) {
    upsertTask(queue, projectId, rel, kind, oldMeta, newMeta, now)
  }
  saveQueue(root, queue)
}

function emitQueue(projectId, queue) {
  emit(EVENT_QUEUE_UPDATED, { projectId, tasks: queue.tasks })
}

function emitChanged(projectId, tasks) {
  if (tasks.length > 0) emit(EVENT_CHANGED, { projectId, tasks })
}

// process_queue: run pending tasks to completion — each task's fresh meta is
// written to the snapshot and DONE TASKS ARE REMOVED from the queue (exactly
// like the desktop). Returns the changed tasks and emits the SSE events.
function processQueue(root, projectId) {
  const allChanged = []
  let batch = []
  let emittedProcessing = false
  for (;;) {
    const queue = loadQueue(root)
    const idx = queue.tasks.findIndex((t) => t.projectId === projectId && t.status === "pending")
    if (idx < 0) {
      emitChanged(projectId, batch)
      if (allChanged.length > 0 || emittedProcessing) emitQueue(projectId, loadQueue(root))
      return allChanged
    }
    queue.tasks[idx].status = "processing"
    queue.tasks[idx].updatedAt = Date.now()
    const task = { ...queue.tasks[idx] }
    saveQueue(root, queue)
    if (!emittedProcessing) {
      emittedProcessing = true
      emitQueue(projectId, queue)
    }

    let meta = null
    let metaError = null
    try { meta = readMeta(root, task.path) } catch (err) { metaError = err }

    const freshQueue = loadQueue(root)
    const current = freshQueue.tasks.find((t) => t.id === task.id)
    if (current) {
      if (current.status !== "processing" || current.updatedAt !== task.updatedAt) {
        // Touched concurrently: re-run later if it asked for it.
        if (current.status === "processing" && current.needsRerun) {
          current.status = "pending"
          current.needsRerun = false
          current.updatedAt = Date.now()
        }
      } else if (metaError) {
        current.status = "failed"
        current.error = String(metaError?.message ?? metaError)
        current.retryCount += 1
        current.updatedAt = Date.now()
      } else {
        writeTaskMetaToSnapshot(root, task.path, meta)
        if (current.needsRerun) {
          current.status = "pending"
          current.needsRerun = false
        } else {
          current.status = "done"
        }
        current.error = null
        current.updatedAt = Date.now()
      }
      allChanged.push(task)
      batch.push(task)
      if (batch.length >= QUEUE_EMIT_EVERY) {
        emitChanged(projectId, batch)
        batch = []
      }
    }
    freshQueue.tasks = freshQueue.tasks.filter((t) => t.status !== "done")
    saveQueue(root, freshQueue)
  }
}

// reset_processing_tasks: on watcher start the desktop keeps only this
// project's tasks and re-pends any stuck "processing" ones.
function resetProcessingTasks(root, projectId) {
  const queue = loadQueue(root)
  const kept = queue.tasks.filter((t) => t.projectId === projectId)
  let changed = kept.length !== queue.tasks.length
  for (const task of kept) {
    if (task.status === "processing") {
      task.status = "pending"
      task.needsRerun = false
      task.error = null
      task.updatedAt = Date.now()
      changed = true
    }
  }
  queue.tasks = kept
  if (changed) saveQueue(root, queue)
}

// ---------------------------------------------------------------------------
// Rescans (mirrors enqueue_rescan_changes / enqueue_rescan_changes_for_prefixes)

function* walkFiles(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkFiles(full)
    } else if (entry.isFile()) {
      let st
      try { st = fs.statSync(full) } catch { continue }
      yield [full, st.size]
    }
  }
}

// Full rescan (rescan_project_files): walk the whole project root (rules decide
// what is watchable) plus snapshot keys that no longer exist on disk.
function enqueueRescanChanges(root, projectId, rules) {
  const rels = new Set()
  const appWritten = new Set()
  for (const [abs, size] of walkFiles(root)) {
    const rel = relativeWatchPath(root, abs, rules, size)
    if (rel) (isAppWriteIgnored(abs) ? appWritten : rels).add(rel)
  }
  const snapshotFiles = loadSnapshotFiles(root)
  for (const rel of Object.keys(snapshotFiles)) {
    if (!fs.existsSync(path.join(root, rel))) {
      (isAppWriteIgnored(path.join(root, rel)) ? appWritten : rels).add(rel)
    }
  }
  enqueuePaths(root, projectId, rels, { appWritten })
}

// Startup/periodic rescan: only the watched prefixes, and a cheap
// (size, mtime) pre-compare so unchanged files are never hashed.
function enqueueRescanChangesForPrefixes(root, projectId, prefixes, rules) {
  const rels = new Set()
  const appWritten = new Set()
  const snapshotFiles = loadSnapshotFiles(root)
  const fastDiffers = (rel) => {
    const oldMeta = Object.prototype.hasOwnProperty.call(snapshotFiles, rel) ? snapshotFiles[rel] : null
    const fast = readMetaFast(root, rel)
    const a = oldMeta ? `${oldMeta.size}:${oldMeta.mtimeMs}` : ""
    const b = fast ? `${fast.size}:${fast.mtimeMs}` : ""
    return a !== b
  }
  for (const prefix of prefixes) {
    const abs = path.join(root, prefix)
    let st
    try { st = fs.statSync(abs) } catch { st = null }
    if (st && st.isFile()) {
      const rel = relativeWatchPath(root, abs, rules, st.size)
      if (rel && fastDiffers(rel)) (isAppWriteIgnored(abs) ? appWritten : rels).add(rel)
    } else if (st && st.isDirectory()) {
      for (const [file, size] of walkFiles(abs)) {
        const rel = relativeWatchPath(root, file, rules, size)
        if (rel && fastDiffers(rel)) (isAppWriteIgnored(file) ? appWritten : rels).add(rel)
      }
    }
  }
  for (const rel of Object.keys(snapshotFiles)) {
    const underPrefix = prefixes.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))
    if (underPrefix && !fs.existsSync(path.join(root, rel))) {
      (isAppWriteIgnored(path.join(root, rel)) ? appWritten : rels).add(rel)
    }
  }
  enqueuePaths(root, projectId, rels, { appWritten })
}

// ---------------------------------------------------------------------------
// Watchers

/** @type {Map<string, object>} project root -> watcher entry */
const watchers = new Map()

// collect_known_paths: for an event path, the watchable rels it stands for.
function collectKnownPaths(root, abs, rel, snapshotFiles, out, rules) {
  let st
  try { st = fs.statSync(abs) } catch { st = null }
  if (st && st.isDirectory()) {
    for (const [file, size] of walkFiles(abs)) {
      const r = relativeWatchPath(root, file, rules, size)
      if (r) out.add(r)
    }
    return
  }
  if (st) {
    const r = relativeWatchPath(root, abs, rules, st.size)
    if (r) out.add(r)
    return
  }
  // Gone: every known snapshot key under this path may have been deleted.
  for (const known of Object.keys(snapshotFiles)) {
    if (known === rel || known.startsWith(`${rel}/`)) out.add(known)
  }
}

// handle_changed_paths: the event-driven pipeline. App-written paths are
// silently synced into the snapshot; everything else is diffed + enqueued.
function handleChangedPaths(entry, relPaths) {
  const { projectPath: root, projectId, rules } = entry
  const snapshotFiles = loadSnapshotFiles(root)
  const rels = new Set()
  const appWritten = new Set()
  for (const rel of relPaths) {
    const abs = path.join(root, rel)
    if (isAppWriteIgnored(abs)) {
      collectKnownPaths(root, abs, rel, snapshotFiles, appWritten, rules)
      continue
    }
    collectKnownPaths(root, abs, rel, snapshotFiles, rels, rules)
  }
  if (appWritten.size > 0) syncSnapshotPaths(root, appWritten)
  if (rels.size === 0) return
  enqueuePaths(root, projectId, rels)
  processQueue(root, projectId)
}

// project://files-changed: live tree refresh for the web UI. raw/sources is
// excluded (the source pipeline owns it). Unlike the single-process desktop,
// the web server broadcasts its OWN writes as well (app-write-ignore does not
// apply here): one server serves every browser tab, so a save/ingest/agent
// write made through it by one client must reach all the others live. The
// writing tab is protected from clobbering by the frontend's edit guard, and
// the ingest queue still ignores app writes (see handleChangedPaths).
function flushProjectChanges(entry, rels, unknown) {
  const out = []
  for (const rel of rels) {
    const segs = rel.split("/")
    if (segs[0] === ".llm-wiki") {
      // Only the small allowlist of live state files (review.json) is ever
      // delivered, and only for OUT-OF-BAND edits: the server's own writes to
      // them are suppressed (app-write-ignore) so a resolving client never
      // echoes its own action back at itself.
      if (!PROJECT_STATE_ALLOWLIST.has(rel)) continue
      if (isAppWriteIgnored(path.join(entry.projectPath, rel))) continue
    } else if (IGNORED_TOP.has(segs[0])) {
      continue
    }
    if (segs[0] === "raw" && segs[1] === "sources") continue // the source pipeline owns raw/sources
    // The server's own writes stay suppressed here too (app-write-ignore):
    // a write made through the web updates its own client stores directly,
    // so echoing it back would be a self-echo (the desktop is one single UI
    // process and never sees its own writes either).
    if (isAppWriteIgnored(path.join(entry.projectPath, rel))) continue
    out.push(rel)
  }
  // paths=[] (unknown platform or only-ignored activity) tells the client to
  // refresh the tree but NOT reload the open file; a non-empty list lets it
  // also reload the open file if affected.
  if (out.length === 0 && !unknown) return
  emit(EVENT_PROJECT_CHANGED, { projectId: entry.projectId, paths: out })
}

function onRootFsEvent(entry, filename) {
  if (filename == null) entry.projUnknown = true
  else entry.projPaths.add(fwd(String(filename)))
  if (entry.debounce) clearTimeout(entry.debounce)
  entry.debounce = setTimeout(() => flushEntry(entry), RESCAN_DEBOUNCE_MS)
}

function flushEntry(entry) {
  entry.debounce = null
  const rels = [...entry.projPaths]
  entry.projPaths = new Set()
  const unknown = entry.projUnknown
  entry.projUnknown = false
  try {
    if (unknown) {
      // Overflow / unknown filenames: fall back to the prefix rescan, like the
      // desktop's root-path overflow triggers a full re-walk.
      enqueueRescanChangesForPrefixes(entry.projectPath, entry.projectId, STARTUP_PREFIXES, entry.rules)
      processQueue(entry.projectPath, entry.projectId)
    } else if (rels.length > 0) {
      handleChangedPaths(entry, rels)
    }
  } catch {
    // Keep the watcher alive no matter what a single batch does.
  }
  try { flushProjectChanges(entry, rels, unknown) } catch { /* ignore */ }
}

// maybe_periodic_rescan / rescan_watch_roots (Linux safety net).
function periodicRescan(entry) {
  try {
    enqueueRescanChangesForPrefixes(entry.projectPath, entry.projectId, STARTUP_PREFIXES, entry.rules)
    processQueue(entry.projectPath, entry.projectId)
  } catch { /* ignore */ }
}

function stopWatcherForKey(key) {
  const entry = watchers.get(key)
  if (!entry) return
  try { entry.rootWatcher?.close() } catch { /* ignore */ }
  if (entry.timer) clearInterval(entry.timer)
  if (entry.debounce) clearTimeout(entry.debounce)
  watchers.delete(key)
}

// ---------------------------------------------------------------------------
// Commands (arg names + return shapes match the Rust #[tauri::command]s)

function startProjectFileWatcher({ projectId, projectPath, sourceWatchConfig }) {
  const root = projectPath
  const rules = makeRules(sourceWatchConfig)
  ensureSyncDir(root)
  resetProcessingTasks(root, projectId)
  enqueueRescanChangesForPrefixes(root, projectId, STARTUP_PREFIXES, rules)
  const changedTasks = processQueue(root, projectId)

  const key = path.resolve(root)
  stopWatcherForKey(key)
  const entry = {
    projectId, projectPath: root, rules,
    rootWatcher: null, timer: null, debounce: null,
    projPaths: new Set(), projUnknown: false,
  }
  try {
    entry.rootWatcher = fs.watch(root, { recursive: true }, (_e, fn) => onRootFsEvent(entry, fn))
  } catch {
    // Recursive watch unsupported; the Linux periodic rescan still covers the
    // source pipeline, live tree refresh degrades to manual.
    entry.rootWatcher = null
  }
  if (process.platform === "linux") {
    entry.timer = setInterval(() => periodicRescan(entry), PERIODIC_RESCAN_MS)
    if (entry.timer.unref) entry.timer.unref()
  }
  watchers.set(key, entry)

  const queue = loadQueue(root)
  emitQueue(projectId, queue)
  return { queue, changedTasks }
}

function stopProjectFileWatcher() {
  for (const key of [...watchers.keys()]) stopWatcherForKey(key)
}

function rescanProjectFiles({ projectId, projectPath, sourceWatchConfig }) {
  const root = projectPath
  const rules = makeRules(sourceWatchConfig)
  ensureSyncDir(root)
  enqueueRescanChanges(root, projectId, rules)
  const changedTasks = processQueue(root, projectId)
  const queue = loadQueue(root)
  emitQueue(projectId, queue)
  return { queue, changedTasks }
}

function getFileChangeQueue({ projectPath }) {
  return loadQueue(projectPath)
}

function retryFileChangeTask({ projectId, projectPath, taskId }) {
  const root = projectPath
  const queue = loadQueue(root)
  const now = Date.now()
  for (const task of queue.tasks) {
    if (task.id === taskId && task.projectId === projectId) {
      task.status = "pending"
      task.error = null
      task.retryCount = 0
      task.needsRerun = false
      task.updatedAt = now
    }
  }
  saveQueue(root, queue)
  processQueue(root, projectId)
  const fresh = loadQueue(root)
  emitQueue(projectId, fresh)
  return fresh
}

function ignoreFileChangeTask({ projectId, projectPath, taskId }) {
  const root = projectPath
  const queue = loadQueue(root)
  queue.tasks = queue.tasks.filter((t) => !(t.id === taskId && t.projectId === projectId))
  saveQueue(root, queue)
  const fresh = loadQueue(root)
  emitQueue(projectId, fresh)
  return fresh
}

export const fileSyncCommands = {
  start_project_file_watcher: startProjectFileWatcher,
  stop_project_file_watcher: stopProjectFileWatcher,
  rescan_project_files: rescanProjectFiles,
  get_file_change_queue: getFileChangeQueue,
  retry_file_change_task: retryFileChangeTask,
  ignore_file_change_task: ignoreFileChangeTask,
}
