// Live cross-client review sync (issue #13 item 3): the project watcher
// allowlists `.llm-wiki/review.json` on `project://files-changed` so an
// OUT-OF-BAND write (the desktop app, another tab) reaches the open web
// Review view, while the server's OWN writes stay suppressed via
// app-write-ignore and every other `.llm-wiki` state file stays ignored
// (chat/queue/history are read from disk on access instead).
//
// Frames ride the legacy emit() bridge, so the bus envelope keeps
// projectId: null and attribution rides in payload.projectId (same shape as
// the /tmp/verify-filesync-shared.mjs standing gate).

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-watchstate-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const { fileSyncCommands } = await import("../src/commands/fileSync.js")
const { fsCommands } = await import("../src/commands/fs.js")
const { eventBus } = await import("../src/events/bus.js")

const PROJECT_ID = "watch-state-proj"
const REVIEW_REL = ".llm-wiki/review.json"
const LINT_REL = ".llm-wiki/lint.json"
const PROJECT = mkdtempSync(path.join(tmpdir(), "llmwiki-watchstate-proj-"))
fs.mkdirSync(path.join(PROJECT, "wiki"), { recursive: true })
fs.mkdirSync(path.join(PROJECT, "raw", "sources"), { recursive: true })
fs.mkdirSync(path.join(PROJECT, ".llm-wiki"), { recursive: true })
fs.writeFileSync(path.join(PROJECT, "wiki/index.md"), "# Home\n")

const PROJECT_CHANGED = "project://files-changed"

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

async function waitFor(pred, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const hit = pred()
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

beforeAll(async () => {
  unsubscribe = eventBus.subscribe((env) => { frames.push(env) })
  fileSyncCommands.start_project_file_watcher({ projectId: PROJECT_ID, projectPath: PROJECT })
  // Let the recursive watcher settle (initial rescan happens synchronously).
  await new Promise((r) => setTimeout(r, 800))
})

afterAll(() => {
  unsubscribe?.()
  fileSyncCommands.stop_project_file_watcher()
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
  try { rmSync(PROJECT, { recursive: true, force: true }) } catch { /* noop */ }
})

describe("project://files-changed state allowlist", () => {
  it("emits .llm-wiki/review.json for an out-of-band write", async () => {
    frames = []
    const reviewPath = path.join(PROJECT, REVIEW_REL)
    fs.writeFileSync(reviewPath, JSON.stringify([
      { id: "r1", type: "suggestion", title: "External review", description: "d",
        options: [], resolved: false, createdAt: 1 },
    ]))
    const ev = await waitFor(() => eventsWith(REVIEW_REL)[0] ?? null)
    expect(ev).toBeTruthy()
    expect(ev.payload.projectId).toBe(PROJECT_ID)
    expect(ev.payload.paths).toContain(REVIEW_REL)
  })

  it("suppresses the server's own review.json write (app-write-ignore)", async () => {
    frames = []
    const res = await fsCommands.write_file({
      path: path.join(PROJECT, REVIEW_REL),
      contents: JSON.stringify([{ id: "r2", type: "confirm", title: "Self",
        description: "d", options: [], resolved: true, resolvedAction: "ok",
        createdAt: 2 }]),
    })
    expect(res).toBeUndefined()
    // Debounce is 700 ms; wait past the ignore window+debounce, then assert
    // no event carried the review path (a tree-refresh-only frame may still
    // arrive if unrelated activity happened — it must NOT contain review.json).
    await new Promise((r) => setTimeout(r, 2500))
    expect(eventsWith(REVIEW_REL).length).toBe(0)
  })

  it("keeps non-allowlisted .llm-wiki state files ignored", async () => {
    frames = []
    fs.writeFileSync(path.join(PROJECT, LINT_REL), JSON.stringify([{ id: "l1" }]))
    await new Promise((r) => setTimeout(r, 2500))
    expect(eventsWith(LINT_REL).length).toBe(0)
  })

  it("still emits wiki edits (regression) and keeps raw/sources excluded", async () => {
    frames = []
    fs.appendFileSync(path.join(PROJECT, "wiki/index.md"), "\n## External\n")
    const ev = await waitFor(() => eventsWith("wiki/index.md")[0] ?? null)
    expect(ev).toBeTruthy()

    const nBefore = frames.length
    fs.writeFileSync(path.join(PROJECT, "raw/sources/new.txt"), "hello\n")
    await new Promise((r) => setTimeout(r, 2500))
    const sourceEcho = frames
      .slice(nBefore)
      .some((f) => f.type === PROJECT_CHANGED
        && Array.isArray(f.payload?.paths)
        && f.payload.paths.some((p) => p.startsWith("raw/sources/")))
    expect(sourceEcho).toBe(false)
  })
})
