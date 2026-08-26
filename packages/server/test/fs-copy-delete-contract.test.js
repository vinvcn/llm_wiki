// Faithful-port contract for the Rust fs copy/delete commands
// (src-tauri/src/commands/fs.rs copy_file / copy_directory / delete_file +
// file_sync::mark_app_write_path):
//
//   1. copy_file / copy_directory / delete_file mark the touched paths as
//      app writes BEFORE and AFTER the operation, so the filesystem watchers
//      never treat the server's own copy/delete as an external edit. The
//      consequence that matters for the shared-data promise: a copy into
//      raw/sources (source import, scheduled import, folder import) must NOT
//      land a second, spurious task in the SHARED .llm-wiki/file-change-queue.json
//      — the desktop suppresses it via mark_app_write_path, and the web must
//      too, or the two clients diverge on the same project.
//   2. Error strings match the Rust contract:
//        copy_file        -> "Failed to create parent dirs: {e}"
//                            "Failed to copy '{source}' to '{destination}': {e}"
//        copy_directory   -> "'{source}' is not a directory"
//                            "Failed to create dir '{dest}': {e}"
//                            "Dir entry error: {e}"
//                            "Failed to copy '{file}': {e}"
//        delete_file      -> "Failed to delete file '{path}': {e}"
//                            "Failed to delete directory '{path}': {e}"
//      A missing delete target is a hard error (Rust fs::remove_file
//      errors), NOT a silent no-op.
//   3. copy_directory returns the copied FILES only (dot-entries skipped),
//      exactly like the Rust Vec<String>, forward-slash normalized.
//
// The last describe() drives the real fileSync source watcher + project
// watcher to prove the suppression end to end (deterministic via
// rescan_project_files, the same diff path fs.watch schedules).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-fscopy-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const { fileSyncCommands } = await import("../src/commands/fileSync.js")
const { fsCommands } = await import("../src/commands/fs.js")
const { eventBus } = await import("../src/events/bus.js")
const { isAppWriteIgnored } = await import("../src/appwrite.js")

const PROJECT_ID = "fs-contract-proj"
const PROJECT = mkdtempSync(path.join(tmpdir(), "llmwiki-fscopy-proj-"))
fs.mkdirSync(path.join(PROJECT, "wiki"), { recursive: true })
fs.mkdirSync(path.join(PROJECT, "raw", "sources"), { recursive: true })
fs.mkdirSync(path.join(PROJECT, ".llm-wiki"), { recursive: true })
fs.writeFileSync(path.join(PROJECT, "wiki/index.md"), "# Home\n")

const PROJECT_CHANGED = "project://files-changed"
const fwd = (p) => p.split(path.sep).join("/")

/** All captured bus envelopes. */
let frames = []
let unsubscribe = null

function eventsWith(rel) {
  return frames.filter(
    (f) => f.type === PROJECT_CHANGED
      && Array.isArray(f.payload?.paths)
      && f.payload.paths.includes(rel),
  )
}

function queueTasks() {
  const q = fileSyncCommands.get_file_change_queue({ projectPath: PROJECT })
  return q.tasks ?? []
}

function tasksForPath(relTail) {
  return queueTasks().filter((t) => (t.path ?? "").endsWith(relTail))
}

async function waitFor(pred, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const hit = pred()
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

let watcherStarted = false

beforeAll(async () => {
  unsubscribe = eventBus.subscribe((env) => { frames.push(env) })
  fileSyncCommands.start_project_file_watcher({ projectId: PROJECT_ID, projectPath: PROJECT })
  watcherStarted = true
  // Let the recursive watcher settle (initial rescan happens synchronously).
  await new Promise((r) => setTimeout(r, 800))
})

afterAll(() => {
  unsubscribe?.()
  if (watcherStarted) fileSyncCommands.stop_project_file_watcher()
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
  try { rmSync(PROJECT, { recursive: true, force: true }) } catch { /* noop */ }
})

describe("copy_file Rust contract", () => {
  it("copies, creates parent dirs, and marks the destination as an app write", async () => {
    const source = path.join(PROJECT, "wiki", "src.md")
    const destination = path.join(PROJECT, "wiki", "deep", "nested", "dst.md")
    fs.writeFileSync(source, "# Source\n")
    await fsCommands.copy_file({ source, destination })
    expect(fs.readFileSync(destination, "utf-8")).toBe("# Source\n")
    expect(fs.existsSync(path.dirname(destination))).toBe(true)
    // mark_app_write_path BEFORE + AFTER => still active right after the call.
    expect(isAppWriteIgnored(destination)).toBe(true)
  })

  it("missing source errors with the Rust string", async () => {
    const destination = path.join(PROJECT, "wiki", "nope.md")
    await expect(fsCommands.copy_file({
      source: path.join(PROJECT, "wiki", "does-not-exist.md"),
      destination,
    })).rejects.toThrow(/^Failed to copy '.*does-not-exist\.md' to '.*nope\.md': /)
  })
})

describe("copy_directory Rust contract", () => {
  it("rejects a non-directory (or missing) source with the Rust string", async () => {
    const fileSource = path.join(PROJECT, "wiki", "not-a-dir.md")
    fs.writeFileSync(fileSource, "x")
    await expect(fsCommands.copy_directory({
      source: fileSource,
      destination: path.join(PROJECT, "copied-file"),
    })).rejects.toThrow(new RegExp(`^'${fileSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' is not a directory$`))
    await expect(fsCommands.copy_directory({
      source: path.join(PROJECT, "missing-dir"),
      destination: path.join(PROJECT, "copied-missing"),
    })).rejects.toThrow(/ is not a directory$/)
  })

  it("returns the copied FILES only (dot-entries skipped) and marks app writes", async () => {
    const source = path.join(PROJECT, "import-src")
    fs.mkdirSync(path.join(source, "sub"), { recursive: true })
    fs.writeFileSync(path.join(source, "a.txt"), "a")
    fs.writeFileSync(path.join(source, "sub", "b.txt"), "b")
    fs.mkdirSync(path.join(source, ".hiddendir"), { recursive: true })
    fs.writeFileSync(path.join(source, ".hidden.txt"), "secret")
    fs.writeFileSync(path.join(source, ".hiddendir", "c.txt"), "c")

    const destination = path.join(PROJECT, "import-dst")
    const copied = await fsCommands.copy_directory({ source, destination })

    expect(copied).toEqual([
      fwd(path.join(destination, "a.txt")),
      fwd(path.join(destination, "sub", "b.txt")),
    ])
    expect(fs.existsSync(path.join(destination, ".hidden.txt"))).toBe(false)
    expect(fs.existsSync(path.join(destination, ".hiddendir"))).toBe(false)
    expect(fs.existsSync(path.join(destination, "sub", "b.txt"))).toBe(true)
    // Root marked up front; every copied file re-marked after the copy.
    expect(isAppWriteIgnored(destination)).toBe(true)
    expect(isAppWriteIgnored(path.join(destination, "sub", "b.txt"))).toBe(true)
  })

  it("surfaces the Rust create-dir error string", async () => {
    const blocker = path.join(PROJECT, "blocker.txt")
    fs.writeFileSync(blocker, "file")
    const source = path.join(PROJECT, "src-dir")
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, "x.txt"), "x")
    await expect(fsCommands.copy_directory({
      source,
      destination: path.join(blocker, "sub"),
    })).rejects.toThrow(/^Failed to create dir '.*blocker\.txt\/sub': /)
  })
})

describe("delete_file Rust contract", () => {
  it("errors on a missing target (Rust remove_file) and deletes files + dirs", async () => {
    const missingFile = path.join(PROJECT, "wiki", "missing.md")
    await expect(fsCommands.delete_file({ path: missingFile }))
      .rejects.toThrow(/^Failed to delete file '.*missing\.md': /)

    const p = path.join(PROJECT, "wiki", "gone.md")
    fs.writeFileSync(p, "bye")
    await fsCommands.delete_file({ path: p })
    expect(fs.existsSync(p)).toBe(false)

    const dir = path.join(PROJECT, "wiki", "gone-dir")
    fs.mkdirSync(path.join(dir, "inner"), { recursive: true })
    fs.writeFileSync(path.join(dir, "inner", "a.md"), "a")
    await fsCommands.delete_file({ path: dir })
    expect(fs.existsSync(dir)).toBe(false)
  })

  it("marks the target as an app write around the delete", async () => {
    const p = path.join(PROJECT, "wiki", "marked.md")
    fs.writeFileSync(p, "x")
    await fsCommands.delete_file({ path: p })
    expect(isAppWriteIgnored(p)).toBe(true)
  })
})

const relSlash = (abs) => fwd(path.relative(PROJECT, abs))

describe("watcher suppression (shared queue promise)", () => {
  it("copy_file into raw/sources does NOT enqueue a spurious shared-queue task", async () => {
    // The source watcher's rescan is the exact diff path fs.watch schedules
    // (scheduleRescan -> rescan); driving it directly keeps the test
    // deterministic while proving app-write-ignore in the queue pipeline.
    const source = path.join(PROJECT, "wiki", "import-me.md")
    fs.writeFileSync(source, "# New source\n")
    const dest = path.join(PROJECT, "raw", "sources", "imported.md")
    await fsCommands.copy_file({ source, destination: dest })

    const before = queueTasks().length
    const res = fileSyncCommands.rescan_project_files({ projectId: PROJECT_ID, projectPath: PROJECT })
    // Task paths are project-ROOT-RELATIVE (the desktop FileChangeTask contract).
    expect(res.changedTasks.map((t) => t.path)).not.toContain(relSlash(dest))
    expect(res.changedTasks.map((t) => t.path)).not.toContain(fwd(dest))
    // Nothing landed in the SHARED queue file either (the desktop-visible file).
    expect(tasksForPath("raw/sources/imported.md")).toHaveLength(0)
    expect(queueTasks().length).toBe(before)

    // An OUT-OF-BAND copy (the desktop app, another tab) still queues.
    const external = path.join(PROJECT, "raw", "sources", "external.md")
    fs.copyFileSync(source, external)
    const res2 = fileSyncCommands.rescan_project_files({ projectId: PROJECT_ID, projectPath: PROJECT })
    expect(res2.changedTasks.map((t) => t.path)).toContain(relSlash(external))
  })

  it("delete_file of a source the app owns does not enqueue a deleted task", async () => {
    const dest = path.join(PROJECT, "raw", "sources", "to-remove.md")
    fs.writeFileSync(dest, "temp")
    // Sync the snapshot first so the delete is a real diff candidate.
    fileSyncCommands.rescan_project_files({ projectId: PROJECT_ID, projectPath: PROJECT })
    await fsCommands.delete_file({ path: dest })

    const res = fileSyncCommands.rescan_project_files({ projectId: PROJECT_ID, projectPath: PROJECT })
    // rescan rebuilds pending from the fresh diff; the app-owned delete must
    // NOT surface as a "deleted" task in the shared queue file.
    expect(res.changedTasks.filter((t) => t.path === relSlash(dest))).toHaveLength(0)
    expect(res.changedTasks.filter((t) => t.path === fwd(dest))).toHaveLength(0)
    expect(queueTasks().some((t) => t.path === relSlash(dest))).toBe(false)
  })

  it("server copy into wiki/ does not echo project://files-changed (out-of-band still does)", async () => {
    frames = []
    const src = path.join(PROJECT, "wiki", "copy-src.md")
    fs.writeFileSync(src, "s")
    const dst = path.join(PROJECT, "wiki", "copied.md")
    await fsCommands.copy_file({ source: src, destination: dst })
    await new Promise((r) => setTimeout(r, 2500))
    expect(eventsWith("wiki/copied.md").length).toBe(0)

    frames = []
    fs.copyFileSync(src, path.join(PROJECT, "wiki", "external-copy.md"))
    const ev = await waitFor(() => eventsWith("wiki/external-copy.md")[0] ?? null)
    expect(ev).toBeTruthy()
  })
})
