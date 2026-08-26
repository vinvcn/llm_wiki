// Project-maintenance command parity tests — faithful Node port of the
// desktop's Rust unit fixtures (src-tauri/src/commands/project_maintenance.rs:
// rebuilds_index_from_page_frontmatter, archive_round_trip_preserves_hidden_
// project_state) plus the full error-contract matrix of the three commands
// (export_project_archive / import_project_archive / rebuild_wiki_index).
//
// Before this suite existed the matrix rows "Project archive export / import
// (zip)" and "Rebuild wiki index" were marked ✅ with zero automated coverage.
// This suite pins: the exact generated index bytes, the archive round-trip
// preserving hidden `.llm-wiki` state, the Rust argument/return shapes, and
// every documented error string — including the safety boundaries that must
// reject (absolute paths, `..`/`.` segments, symlink entries, entry-count and
// expanded-size caps).

import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import JSZip from "jszip"
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_BYTES,
  maintenanceCommands,
} from "../src/commands/maintenance.js"

const { export_project_archive, import_project_archive, rebuild_wiki_index } = maintenanceCommands

const cleanups = []
function makeRoot(label) {
  const root = mkdtempSync(path.join(tmpdir(), `llm-wiki-maint-${label}-`))
  cleanups.push(root)
  return root
}
function write(relPath, content) {
  const full = path.join(relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
  return full
}
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Minimal raw-zip builder (STORE, no compression): jszip sanitizes entry
// names on creation (`../evil` → `evil`), so the path-abuse fixtures must be
// written byte-level to carry the exact hostile names a real archive can.
function buildRawZip(entries) {
  // entries: [{ name, data?: Buffer, dir?: boolean, mode?: number }]
  const chunks = []
  const central = []
  let offset = 0
  let crc = (data) => zlib.crc32(data) >>> 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf-8")
    const data = e.dir ? Buffer.alloc(0) : Buffer.from(e.data ?? "")
    const crc32 = crc(data)
    const sizes = [data.length, data.length]
    // Local file header
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4) // version needed
    lh.writeUInt16LE(0, 6) // flags
    lh.writeUInt16LE(0, 8) // method (store)
    lh.writeUInt16LE(0, 10) // mod time
    lh.writeUInt16LE(0, 12) // mod date
    lh.writeUInt32LE(crc32, 14)
    lh.writeUInt32LE(sizes[0], 18)
    lh.writeUInt32LE(sizes[1], 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    chunks.push(lh, nameBuf, data)
    const localOffset = offset
    offset += 30 + nameBuf.length + data.length
    const mode = e.mode ?? (e.dir ? 0o040755 : 0o100644)
    // Central directory entry
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE((3 << 8) | 20, 4) // version made by (UNIX) + needed
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0, 14)
    cd.writeUInt32LE(crc32, 16)
    cd.writeUInt32LE(sizes[0], 20)
    cd.writeUInt32LE(sizes[1], 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE((mode << 16) >>> 0, 38)
    cd.writeUInt32LE(localOffset, 42)
    central.push(cd, nameBuf)
  }
  const cdStart = offset
  const cdSize = central.reduce((n, b) => n + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(cdStart, 16)
  return Buffer.concat([...chunks, ...central, eocd])
}

describe("rebuild_wiki_index (rebuilds_index_from_page_frontmatter — Rust fixture)", () => {
  it("rebuilds index.md from page frontmatter with exact Rust output bytes", async () => {
    const root = makeRoot("rebuild")
    write(path.join(root, "wiki/entities/a.md"),
      "---\ntype: entity\ntitle: Alpha\n---\nBody")
    write(path.join(root, "wiki/concepts/a.md"),
      "---\ntype: concept\ntitle: Also Alpha\n---\nBody")

    const result = await rebuild_wiki_index({ projectPath: root })
    expect(result.pages).toBe(2)
    expect(result.groups).toBe(2)

    const index = await import("node:fs/promises").then((f) =>
      f.readFile(path.join(root, "wiki/index.md"), "utf-8"))
    expect(index).toContain("## entity")
    expect(index).toContain("[[entities/a|Alpha]]")
    expect(index).toContain("[[concepts/a|Also Alpha]]")
    // BTreeMap group order (concept < entity) and the exact per-page lines.
    expect(index).toBe(
      "# Wiki Index\n\n" +
      "## concept\n\n" +
      "- [[concepts/a|Also Alpha]]\n" +
      "\n" +
      "## entity\n\n" +
      "- [[entities/a|Alpha]]\n" +
      "\n")
  })

  it("ignores index/overview/log and non-.md files; falls back to stem + other", async () => {
    const root = makeRoot("rebuild-filters")
    write(path.join(root, "wiki/log.md"), "# Log\nstale")
    write(path.join(root, "wiki/overview.md"), "# Overview\nstale")
    write(path.join(root, "wiki/index.md"), "# Stale index\nwill be replaced")
    write(path.join(root, "wiki/notes.txt"), "not a page")
    write(path.join(root, "wiki/sub/plain.md"), "no frontmatter here")
    write(path.join(root, "wiki/.hidden.md"), "---\ntype: entity\n---\nNo title")

    const result = await rebuild_wiki_index({ projectPath: root })
    expect(result.pages).toBe(2)
    expect(result.groups).toBe(2)
    const index = await import("node:fs/promises").then((f) =>
      f.readFile(path.join(root, "wiki/index.md"), "utf-8"))
    // .hidden.md skips (WalkDir still reads it — .md files are pages even
    // when dot-prefixed; the filtering here matches Rust: only stem + kind).
    expect(index).toContain("- [[sub/plain|plain]]")
    expect(index).toContain("- [[.hidden|.hidden]]")
    expect(index).toContain("## other")
    expect(index).toContain("## entity")
  })

  it("strips surrounding quotes from frontmatter titles", async () => {
    const root = makeRoot("rebuild-quotes")
    write(path.join(root, "wiki/a.md"), "---\ntype: note\ntitle: \"Quoted\"\n---\nA")
    write(path.join(root, "wiki/b.md"), "---\ntype: note\ntitle: 'Single'\n---\nB")
    const result = await rebuild_wiki_index({ projectPath: root })
    expect(result.pages).toBe(2)
    const index = await import("node:fs/promises").then((f) =>
      f.readFile(path.join(root, "wiki/index.md"), "utf-8"))
    expect(index).toContain("[[a|Quoted]]")
    expect(index).toContain("[[b|Single]]")
  })

  it("replaces a stale index.md atomically via the tmp file (no tmp left behind)", async () => {
    const root = makeRoot("rebuild-atomic")
    write(path.join(root, "wiki/index.md"), "# Stale")
    write(path.join(root, "wiki/a.md"), "---\ntype: page\ntitle: Zed\n---\nZ")
    write(path.join(root, "wiki/b.md"), "---\ntype: page\ntitle: Alpha\n---\nA")
    await rebuild_wiki_index({ projectPath: root })
    const index = await import("node:fs/promises").then((f) =>
      f.readFile(path.join(root, "wiki/index.md"), "utf-8"))
    expect(index).toContain("[[b|Alpha]]")
    expect(index).toContain("[[a|Zed]]")
    // Rust page sort is by lowercased title (Alpha < Zed), and the sort is
    // code-unit deterministic, not locale-dependent.
    expect(index.indexOf("[[b|Alpha]]")).toBeLessThan(index.indexOf("[[a|Zed]]"))
    await expect(import("node:fs/promises").then((f) =>
      f.access(path.join(root, "wiki/.index.md.rebuild.tmp")))).rejects.toThrow()
  })

  it("rejects when the project has no wiki directory (Rust WalkDir error path)", async () => {
    const root = makeRoot("rebuild-missing-wiki")
    writeFileSync(path.join(root, "schema.md"), "# Schema")
    await expect(rebuild_wiki_index({ projectPath: root })).rejects.toThrow(
      /Failed to enumerate wiki pages:/)
  })
})

describe("export_project_archive / import_project_archive (archive_round_trip_preserves_hidden_project_state — Rust fixture)", () => {
  it("round-trips a project incl. hidden .llm-wiki state to an exact destination", async () => {
    const base = makeRoot("roundtrip")
    const source = path.join(base, "source")
    const target = path.join(base, "target")
    const archive = path.join(base, "archive.zip")
    write(path.join(source, "wiki/index.md"), "# Index")
    write(path.join(source, "wiki/sub/page.md"), "# Page")
    write(path.join(source, ".llm-wiki/ingest-cache.json"), "{}")
    mkdirSync(path.join(source, "wiki/empty-dir"), { recursive: true })

    await expect(
      export_project_archive({ projectPath: source, destination: archive }),
    ).resolves.toBeUndefined()
    const root = await import_project_archive({ archivePath: archive, destination: target })

    // Rust returns root.to_string_lossy() — the destination itself, native form.
    expect(root).toBe(target)
    expect(await import("node:fs/promises").then((f) =>
      f.readFile(path.join(target, ".llm-wiki/ingest-cache.json"), "utf-8"))).toBe("{}")
    expect(await import("node:fs/promises").then((f) =>
      f.readFile(path.join(target, "wiki/index.md"), "utf-8"))).toBe("# Index")
    expect(await import("node:fs/promises").then((f) =>
      f.readFile(path.join(target, "wiki/sub/page.md"), "utf-8"))).toBe("# Page")
    // Directory entries are preserved, including empty ones.
    await expect(import("node:fs/promises").then((f) =>
      f.access(path.join(target, "wiki/empty-dir")))).resolves.toBeUndefined()
  })

  it("skips symlinks on export (Rust follow_links(false) + symlink skip)", async () => {
    const base = makeRoot("symlink-export")
    const source = path.join(base, "source")
    const target = path.join(base, "target")
    const archive = path.join(base, "archive.zip")
    write(path.join(source, "wiki/index.md"), "# Index")
    write(path.join(source, "wiki/real.md"), "# Real")
    try {
      symlinkSync(path.join(source, "wiki/real.md"), path.join(source, "wiki/link.md"))
    } catch {
      // Symlinks unavailable (e.g. restricted host) — skip the fixture.
      return
    }
    await export_project_archive({ projectPath: source, destination: archive })
    await import_project_archive({ archivePath: archive, destination: target })
    await expect(import("node:fs/promises").then((f) =>
      f.readFile(path.join(target, "wiki/real.md"), "utf-8"))).resolves.toBe("# Real")
    await expect(import("node:fs/promises").then((f) =>
      f.access(path.join(target, "wiki/link.md")))).rejects.toThrow()
  })
})

describe("export_project_archive error contract (project_maintenance.rs)", () => {
  it("requires absolute paths", async () => {
    const root = makeRoot("export-abs")
    await expect(export_project_archive({ projectPath: "relative", destination: "/tmp/x.zip" }))
      .rejects.toThrow("Project and archive paths must be absolute")
    await expect(export_project_archive({ projectPath: root, destination: "relative.zip" }))
      .rejects.toThrow("Project and archive paths must be absolute")
  })

  it("rejects a destination inside the project directory", async () => {
    const root = makeRoot("export-inside")
    write(path.join(root, "wiki/index.md"), "# Index")
    await expect(export_project_archive({ projectPath: root, destination: path.join(root, "out.zip") }))
      .rejects.toThrow("Export destination must be outside the project directory")
    await expect(export_project_archive({ projectPath: root, destination: path.join(root, "sub/out.zip") }))
      .rejects.toThrow("Export destination must be outside the project directory")
  })

  it("does not create missing parent directories (Rust File::create semantics)", async () => {
    const root = makeRoot("export-parent")
    const base = makeRoot("export-parent-out")
    write(path.join(root, "wiki/index.md"), "# Index")
    const missing = path.join(base, "no-such-dir", "out.zip")
    await expect(export_project_archive({ projectPath: root, destination: missing }))
      .rejects.toThrow()
    await expect(import("node:fs/promises").then((f) =>
      f.access(path.join(base, "no-such-dir")))).rejects.toThrow()
  })
})

describe("import_project_archive error contract (project_maintenance.rs)", () => {
  function zipWith(entries, options) {
    const zip = new JSZip()
    for (const e of entries) {
      const opts = {}
      if (e.mode != null) opts.unixPermissions = e.mode
      if (e.dir) zip.folder(e.name)
      else zip.file(e.name, e.data ?? "", opts)
    }
    return zip.generateAsync({ type: "nodebuffer", platform: "UNIX", ...options })
  }

  it("requires absolute paths", async () => {
    await expect(import_project_archive({ archivePath: "rel.zip", destination: "/tmp/x" }))
      .rejects.toThrow("Archive and destination paths must be absolute")
    await expect(import_project_archive({ archivePath: "/tmp/x.zip", destination: "rel" }))
      .rejects.toThrow("Archive and destination paths must be absolute")
  })

  it("rejects a missing archive file", async () => {
    const base = makeRoot("import-missing")
    await expect(import_project_archive({
      archivePath: path.join(base, "nope.zip"),
      destination: path.join(base, "dest"),
    })).rejects.toThrow()
  })

  it("rejects a non-zip archive", async () => {
    const base = makeRoot("import-notzip")
    const archive = path.join(base, "bad.zip")
    writeFileSync(archive, "this is not a zip file at all")
    await expect(import_project_archive({
      archivePath: archive,
      destination: path.join(base, "dest"),
    })).rejects.toThrow()
  })

  it("rejects an archive without wiki/index.md", async () => {
    const base = makeRoot("import-noindex")
    const archive = path.join(base, "noindex.zip")
    writeFileSync(archive, await zipWith([{ name: "wiki/page.md", data: "# Page" }]))
    await expect(import_project_archive({
      archivePath: archive,
      destination: path.join(base, "dest"),
    })).rejects.toThrow("Archive is not an LLM Wiki project (wiki/index.md is missing)")
  })

  it("rejects `..` traversal segments", async () => {
    const base = makeRoot("import-dotdot")
    const archive = path.join(base, "evil.zip")
    writeFileSync(archive, buildRawZip([
      { name: "wiki/index.md", data: "# Index" },
      { name: "../evil", data: "pwned" },
    ]))
    await expect(import_project_archive({
      archivePath: archive,
      destination: path.join(base, "dest"),
    })).rejects.toThrow("Unsafe archive path: ../evil")
  })

  it("rejects `.` segments (Rust Component::Normal check)", async () => {
    const base = makeRoot("import-dot")
    const archive = path.join(base, "dot.zip")
    writeFileSync(archive, buildRawZip([
      { name: "wiki/index.md", data: "# Index" },
      { name: "wiki/./x.md", data: "y" },
    ]))
    await expect(import_project_archive({
      archivePath: archive,
      destination: path.join(base, "dest"),
    })).rejects.toThrow("Unsafe archive path: wiki/./x.md")
  })

  it("rejects a symlink entry (unix mode 0o120000)", async () => {
    const base = makeRoot("import-symlink")
    const archive = path.join(base, "symlink.zip")
    writeFileSync(archive, await zipWith([
      { name: "wiki/index.md", data: "# Index" },
      { name: "link", data: "wiki/index.md", mode: 0o120777 },
    ]))
    await expect(import_project_archive({
      archivePath: archive,
      destination: path.join(base, "dest"),
    })).rejects.toThrow("Archive contains an unsupported symbolic link: link")
  })

  it("rejects a non-empty destination", async () => {
    const base = makeRoot("import-nonempty")
    const source = path.join(base, "source")
    const archive = path.join(base, "proj.zip")
    const dest = path.join(base, "dest")
    write(path.join(source, "wiki/index.md"), "# Index")
    await export_project_archive({ projectPath: source, destination: archive })
    mkdirSync(dest, { recursive: true })
    writeFileSync(path.join(dest, "existing.txt"), "occupied")
    await expect(import_project_archive({ archivePath: archive, destination: dest }))
      .rejects.toThrow("Import destination must be empty")
  })

  // The 100k-entry fixtures need several seconds to build/unpack — the
  // root `test:mocks` vitest run applies a 5s default per-test timeout, so
  // both cap tests declare their own generous budget.
  it("rejects archives over MAX_ARCHIVE_ENTRIES (Rust 100_000 cap)", async () => {
    const base = makeRoot("import-cap")
    const archive = path.join(base, "many.zip")
    const zip = new JSZip()
    const N = MAX_ARCHIVE_ENTRIES + 1
    for (let i = 0; i < N; i++) zip.file(`f${String(i).padStart(6, "0")}`, "")
    writeFileSync(archive, await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }))
    await expect(import_project_archive({
      archivePath: archive,
      destination: path.join(base, "dest"),
    })).rejects.toThrow("Project archive contains too many entries")
  }, 30000)

  it("accepts an archive at exactly MAX_ARCHIVE_ENTRIES (boundary)", async () => {
    const base = makeRoot("import-cap-ok")
    const archive = path.join(base, "at-cap.zip")
    const zip = new JSZip()
    zip.file("wiki/index.md", "# Index")
    // jszip auto-creates the `wiki/` folder entry, so 2 slots are
    // taken before the plain files: 1 (wiki/) + 1 (wiki/index.md) + N == cap.
    for (let i = 0; i < MAX_ARCHIVE_ENTRIES - 2; i++) zip.file(`f${String(i).padStart(6, "0")}`, "")
    writeFileSync(archive, await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }))
    const dest = path.join(base, "dest")
    await expect(import_project_archive({ archivePath: archive, destination: dest }))
      .resolves.toBe(dest)
    // 100k-entry zip build + import: ~5s locally, but shared CI runners have
    // been observed past 30s — keep headroom without disabling the test.
  }, 120_000)
})

describe("Rust parity constants (project_maintenance.rs)", () => {
  it("pins MAX_ARCHIVE_ENTRIES = 100_000", () => {
    expect(MAX_ARCHIVE_ENTRIES).toBe(100_000)
  })
  it("pins MAX_ARCHIVE_BYTES = 4 GiB", () => {
    expect(MAX_ARCHIVE_BYTES).toBe(4 * 1024 * 1024 * 1024)
  })
})
