// Legacy Word `.doc` (OLE2) acceptance tests — REAL Word 97–2003 binaries.
//
// The vendored MIT corpus under test/fixtures/word-doc/ (from the
// word-extractor project whose exact npm version this repo ships) proves the
// server's legacy `.doc` path against genuine files, not synthetic ones:
//
//   read_file       -> cache-first, per-format extraction, image/media/
//                      legacy-doc placeholders, exact missing-file contract
//   preprocess_file -> extracts AND writes <dir>/.cache/<name>.txt (the
//                      desktop-shared cache format read_file/source.search
//                      short-circuit on)
//   agent source.search -> binary sources match ONLY through a fresh cache;
//                      text sources match directly; empty query errors
//
// Expected bodies are pinned by the upstream Jest snapshots for these files
// (cf. test/fixtures/word-doc/README.md).

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-legacydoc-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"

const { fsCommands } = await import("../src/commands/fs.js")
const { preprocessFile } = await import("../src/commands/preprocess.js")
const { runTool } = await import("../src/agent-tools.js")

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "word-doc")
const PROJECT = path.join(DATA_DIR, "project")
const SOURCES = path.join(PROJECT, "raw", "sources")
const CACHE = path.join(SOURCES, ".cache")

const DOC01_BODY =
  "A second test of reviewing, but with Unicode characters in to see if character offsets get broken. \u{1F600} \u2200\n\n" +
  "This is a test of reviewing\n\nThis text has been inserted, \u273Band should be included"
const DOC05_BODY = "This is a simple file created with Word 97-SR2."

function fixture(name) {
  return path.join(FIXTURES, name)
}

function source(name) {
  return path.join(SOURCES, name)
}

beforeAll(() => {
  mkdirSync(CACHE, { recursive: true })
  for (const f of ["test01.doc", "test03.doc", "test05.doc", "bigfile-01.doc", "badfile-01-bad-header.doc"]) {
    copyFileSync(fixture(f), source(f))
  }
  // Placeholder probes (image/media/legacy-doc), plain text, and a cache-only doc.
  writeFileSync(source("pixel.png"), Buffer.from("89504e470d0a1a0a", "hex"))
  writeFileSync(source("movie.mp4"), Buffer.alloc(2 * 1024 * 1024))
  writeFileSync(source("legacy.ppt"), "old powerpoint bytes")
  writeFileSync(source("plain.md"), "Hello source world from markdown")
})

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

describe("read_file legacy .doc extraction (real Word 97–2003 fixtures)", () => {
  it("extracts a Word 97-SR2 file exactly", async () => {
    await expect(fsCommands.read_file({ path: source("test05.doc") })).resolves.toBe(DOC05_BODY)
  })

  it("extracts revisions + Unicode (😀 ∀ ✻) exactly", async () => {
    await expect(fsCommands.read_file({ path: source("test01.doc") })).resolves.toBe(DOC01_BODY)
  })

  it("extracts a table page with tab-separated cells", async () => {
    const body = await fsCommands.read_file({ path: source("test03.doc") })
    expect(body.startsWith("Each license name is hyperlinked to its location.")).toBe(true)
    expect(body).toContain("License\tGPL v3.0\tLGPL v3.0\tBSD\tMIT (X11)\tApache v2.0")
  })

  it("extracts a long, complex real-world document", async () => {
    const body = await fsCommands.read_file({ path: source("bigfile-01.doc") })
    expect(body.startsWith("BlogCFC\n\nWelcome to BlogCFC")).toBe(true)
    expect(body.length).toBeGreaterThan(30000)
  })

  it("degrades an invalid .doc to the documented convert-first error", async () => {
    await expect(fsCommands.read_file({ path: source("badfile-01-bad-header.doc") })).rejects.toThrow(
      /Legacy \.doc extraction failed:.*Re-save as \.docx/,
    )
  })
})

describe("read_file desktop contract (cache + placeholders + errors)", () => {
  it("short-circuits on a fresh preprocess cache", async () => {
    copyFileSync(fixture("test05.doc"), source("cached.doc"))
    writeFileSync(path.join(CACHE, "cached.doc.txt"), "CUSTOM CACHED DOC TEXT")
    await expect(fsCommands.read_file({ path: source("cached.doc") })).resolves.toBe("CUSTOM CACHED DOC TEXT")
  })

  it("ignores a stale cache and re-extracts", async () => {
    copyFileSync(fixture("test05.doc"), source("stale.doc"))
    const cachePath = path.join(CACHE, "stale.doc.txt")
    writeFileSync(cachePath, "STALE CACHE TEXT")
    const nowSec = Math.floor(Date.now() / 1000)
    // Force the original strictly newer than its cache file.
    const { utimesSync } = await import("node:fs")
    utimesSync(cachePath, nowSec - 60, nowSec - 60)
    utimesSync(source("stale.doc"), nowSec, nowSec)
    await expect(fsCommands.read_file({ path: source("stale.doc") })).resolves.toBe(DOC05_BODY)
  })

  it("returns exact image / media / legacy-doc placeholders", async () => {
    await expect(fsCommands.read_file({ path: source("pixel.png") })).resolves.toBe("[Image: pixel.png (0.0 KB)]")
    await expect(fsCommands.read_file({ path: source("movie.mp4") })).resolves.toBe("[Media: movie.mp4 (2.0 MB)]")
    await expect(fsCommands.read_file({ path: source("legacy.ppt") })).resolves.toBe(
      "[Document: legacy.ppt — text extraction not supported for .ppt format]",
    )
  })

  it("reports the exact missing-file contract", async () => {
    const missing = path.join(SOURCES, "does-not-exist.txt")
    await expect(fsCommands.read_file({ path: missing })).rejects.toThrow(`File does not exist: '${missing}'`)
  })
})

describe("preprocess_file writes the desktop-shared cache", () => {
  it("extracts .doc and writes <dir>/.cache/<name>.txt", async () => {
    const text = await preprocessFile({ path: source("test03.doc") })
    expect(text.startsWith("Each license name is hyperlinked")).toBe(true)
    const cachePath = path.join(CACHE, "test03.doc.txt")
    expect(existsSync(cachePath)).toBe(true)
    expect(readFileSync(cachePath, "utf-8").startsWith("Each license name is hyperlinked")).toBe(true)
  })

  it("returns the Rust sentinel for non-extractable formats", async () => {
    await expect(preprocessFile({ path: source("legacy.ppt") })).resolves.toBe("no preprocessing needed")
  })

  it("returns the Rust `no preprocessing needed` sentinel for text formats too", async () => {
    // fs.rs preprocess_file: the match is ONLY pdf/org/office/ebook; every
    // other extension (including plain text) returns the no-op sentinel.
    await expect(preprocessFile({ path: source("plain.md") })).resolves.toBe("no preprocessing needed")
  })
})

describe("agent source.search reads binaries through the fresh cache only", () => {
  const ctx = { projectPath: PROJECT, topK: 5, store: {} }

  it("matches a .doc binary via its fresh cache (preprocessed above)", async () => {
    const res = await runTool("source.search", { query: "hyperlinked to its location" }, ctx)
    const ref = res.references.find((r) => r.path === "raw/sources/test03.doc")
    expect(ref).toBeTruthy()
    expect(ref.snippet).toContain("hyperlinked")
  })

  it("matches text extensions directly", async () => {
    const res = await runTool("source.search", { query: "source world" }, ctx)
    expect(res.references.some((r) => r.path === "raw/sources/plain.md")).toBe(true)
  })

  it("skips binaries without a fresh cache", async () => {
    const res = await runTool("source.search", { query: "97-SR2" }, ctx)
    expect(res.references.some((r) => r.path === "raw/sources/test05.doc")).toBe(false)
  })

  it("errors on an empty query", async () => {
    await expect(runTool("source.search", { query: "   " }, ctx)).rejects.toThrow("source.search query is required")
  })

  it("clamps top_k to 1..10 and caps the snippet at 500 chars", async () => {
    const res = await runTool("source.search", { query: "hello", top_k: 2 }, ctx)
    expect(res.references.length).toBeLessThanOrEqual(2)
    for (const r of res.references) {
      expect(r.snippet.length).toBeLessThanOrEqual(503) // 500 chars + up to two "..." ellipses
    }
  })
})
