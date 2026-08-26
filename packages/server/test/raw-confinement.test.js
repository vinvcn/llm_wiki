// Owner decision 2026-08-26 ("no filesystem exposed to clients"): /api/raw
// streams only paths inside registered project roots. Pins the confinement
// predicate and both handlers' behavior (lexical prefix + realpath hardening
// against symlink escapes; out-of-root answers 404 without confirming
// existence).

import { describe, it, expect, afterAll } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-raw-confine-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR

const { getDb } = await import("../src/store/db.js")
const { isPathInsideRoots, isAllowedRawPath, streamRawFile } = await import("../src/raw.js")

const ROOT = mkdtempSync(path.join(tmpdir(), "llmwiki-raw-proj-"))
mkdirSync(path.join(ROOT, "wiki"), { recursive: true })
writeFileSync(path.join(ROOT, "wiki", "page.md"), "# hello\n")
const OUTSIDE = mkdtempSync(path.join(tmpdir(), "llmwiki-raw-outside-"))
writeFileSync(path.join(OUTSIDE, "secret.txt"), "top secret")

getDb()
  .prepare("INSERT INTO projects (name, path, owner_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)")
  .run("raw-confine-fixture", ROOT, Date.now(), Date.now())

// Minimal express-like response double: records status/send and satisfies
// .status().type().send() and .set()/writeHead used by the handler.
function mockRes() {
  const res = {
    statusCode: 0,
    body: null,
    headers: {},
    ended: false,
    status(code) { this.statusCode = code; return this },
    type() { return this },
    set(h) { Object.assign(this.headers, h); return this },
    send(body) { this.body = body; this.ended = true },
    writeHead(code) { this.statusCode = code; this.ended = true },
    write() { return true }, // ReadStream.pipe writes here
    end(body) { if (body !== undefined) this.body = body; this.ended = true },
    on() { /* stream plumbing not needed for rejection paths */ },
    once() { this.ended = true },
    emit() {},
  }
  return res
}

describe("raw streaming confinement", () => {
  // Deliberately NO afterAll removal of DATA_DIR/ROOT/OUTSIDE: the served
  // file's async open would race rmSync and surface an unhandled ENOENT.
  // Tempdirs under os.tmpdir() are OS-reclaimed; correctness beats tidy.

  it("isPathInsideRoots: exact root, nested, and traversal", () => {
    const roots = [ROOT]
    expect(isPathInsideRoots(ROOT, roots)).toBe(true)
    expect(isPathInsideRoots(path.join(ROOT, "wiki", "page.md"), roots)).toBe(true)
    expect(isPathInsideRoots(OUTSIDE, roots)).toBe(false)
    // sibling with shared prefix must NOT pass (no string-prefix accident)
    expect(isPathInsideRoots(ROOT + "-evil", roots)).toBe(false)
    expect(isPathInsideRoots(path.join(ROOT, "..", OUTSIDE, "secret.txt"), roots)).toBe(false)
  })

  it("isAllowedRawPath: inside ok, outside rejected, symlink escape rejected", async () => {
    expect(await isAllowedRawPath(path.join(ROOT, "wiki", "page.md"))).toBe(true)
    expect(await isAllowedRawPath(path.join(OUTSIDE, "secret.txt"))).toBe(false)

    const link = path.join(ROOT, "wiki", "escape.lnk")
    symlinkSync(path.join(OUTSIDE, "secret.txt"), link)
    expect(await isAllowedRawPath(link)).toBe(false) // realpath lands outside
  })

  it("missing in-root path stays allowed (handler turns it into 404)", async () => {
    expect(await isAllowedRawPath(path.join(ROOT, "wiki", "ghost.md"))).toBe(true)
  })

  it("streamRawFile serves in-project files and 404s out-of-root ones", async () => {
    const insideRes = mockRes()
    await streamRawFile({ query: { path: path.join(ROOT, "wiki", "page.md") } }, insideRes)
    expect(insideRes.statusCode).toBe(200)
    const outsideRes = mockRes()
    await streamRawFile({ query: { path: path.join(OUTSIDE, "secret.txt") } }, outsideRes)
    expect(outsideRes.statusCode).toBe(404) // no existence oracle for foreign paths
  })
})
