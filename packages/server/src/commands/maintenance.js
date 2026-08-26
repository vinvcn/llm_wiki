import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { countWikilinks } from "../graph.js"

// Node port of src-tauri/src/commands/project_maintenance.rs: project archive
// export/import (zip) and wiki index rebuild. Uses jszip (already a project
// dependency) so the web client's "Export / Import project" and "Rebuild
// index" buttons work exactly as on the desktop.
//
// The limits and guards mirror the Rust module 1:1 (see the `MAX_*` constants
// and `safe_relative` in the Rust source): MAX_ARCHIVE_ENTRIES bounds the
// central-directory entry count, MAX_ARCHIVE_BYTES bounds the expanded size,
// and archive paths must be safe-relative (no absolute paths, no `..` or `.`
// segments — the Rust `Component::Normal` check).
//
// Import validation walks the RAW central directory (like the `zip` crate's
// ZipArchive) rather than trusting a JSZip object: JSZip *normalizes* entry
// names on load (`../evil` → `evil`), which would silently rename hostile
// entries instead of rejecting the archive the way the desktop does. The raw
// walk sees the exact names/modes/sizes a foreign archive carries, and the
// entry count is counted from the directory itself (JSZip's EOCD count field
// is not reliable for large archives).

export const MAX_ARCHIVE_ENTRIES = 100_000 // project_maintenance.rs
export const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024 // project_maintenance.rs

const fwd = (p) => p.split(path.sep).join("/")
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOC = 0x07064b50
const SIG_ZIP64_EOCD = 0x06064b50
const SIG_CD = 0x02014b50
const U32_MAX = 0xffffffff

// Rust safe_relative(): every component must be Component::Normal — `..`
// (ParentDir) and `.` (CurDir) segments are as unsafe as absolute paths,
// because they can disguise traversal on extraction.
function isSafeRel(name) {
  if (!name || name.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(name)) return false
  const parts = name.split(/[\\/]/)
  return !parts.some((p) => p === ".." || p === ".")
}

// Parse the zip central directory (EOCD → zip64 → entries) and validate it
// exactly like the Rust ZipArchive-based importer: entry-count cap, symlink
// rejection, safe-relative names, project-index presence, expanded-size cap.
// Returns { hasIndex, count } — everything the import needs before any
// extraction (`count` is the true central-directory entry count).
function validateRawZip(buf) {
  // ── EOCD ──────────────────────────────────────────────────────────────
  let eocd = -1
  const from = Math.max(0, buf.length - (0xffff + 22))
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error("Invalid zip archive: no end-of-central-directory record")
  let cdOffset = buf.readUInt32LE(eocd + 16)
  let cdSize = buf.readUInt32LE(eocd + 12)
  const count16 = buf.readUInt16LE(eocd + 10)
  if (cdOffset === U32_MAX || cdSize === U32_MAX || count16 === 0xffff) {
    // Zip64: locator sits 20 bytes before the EOCD.
    const loc = eocd - 20
    if (loc < 0 || buf.readUInt32LE(loc) !== SIG_ZIP64_LOC) {
      throw new Error("Invalid zip archive: zip64 EOCD locator missing")
    }
    const z64 = Number(buf.readBigUInt64LE(loc + 8))
    if (z64 + 56 > buf.length || buf.readUInt32LE(z64) !== SIG_ZIP64_EOCD) {
      throw new Error("Invalid zip archive: zip64 EOCD missing")
    }
    cdSize = Number(buf.readBigUInt64LE(z64 + 40))
    cdOffset = Number(buf.readBigUInt64LE(z64 + 48))
  }

  // ── First pass: count real entries (the EOCD field can lie — JSZip writes
  // ── a saturated/wrong value for large archives, so never trust it).
  const end = cdOffset + cdSize
  if (end > buf.length) throw new Error("Invalid zip archive: central directory out of bounds")
  let count = 0
  let pos = cdOffset
  while (pos + 46 <= end) {
    if (buf.readUInt32LE(pos) !== SIG_CD) throw new Error("Invalid zip archive: corrupt central directory")
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    count++
    pos += 46 + nameLen + extraLen + commentLen
  }
  if (count > MAX_ARCHIVE_ENTRIES) throw new Error("Project archive contains too many entries")

  // ── Second pass: per-entry contract (names/modes/sizes) + index probe.
  let expanded = 0
  let hasIndex = false
  pos = cdOffset
  while (pos + 46 <= end) {
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf-8")
    const extAttrs = buf.readUInt32LE(pos + 38)
    const mode = (extAttrs >>> 16) & 0o170000
    if (mode === 0o120000) {
      throw new Error(`Archive contains an unsupported symbolic link: ${name}`)
    }
    if (!isSafeRel(name)) throw new Error(`Unsafe archive path: ${name}`)
    const isDir = name.endsWith("/") || mode === 0o040000
    // Rust compares Path components: "wiki//index.md" counts as the index
    // (components collapse), "wiki/./index.md" does not (CurDir segment).
    const segs = name.split("/").filter(Boolean)
    hasIndex = hasIndex || (!isDir && segs.join("/") === "wiki/index.md")
    let size = Number(buf.readUInt32LE(pos + 24))
    if (size === U32_MAX) {
      // Zip64 extra field (id 0x0001) carries the true 64-bit sizes.
      size = readZip64Sizes(buf, pos + 46 + nameLen, extraLen) ?? MAX_ARCHIVE_BYTES + 1
    }
    if (!isDir) {
      expanded += size
      if (expanded > MAX_ARCHIVE_BYTES) throw new Error("Project archive exceeds 4 GB expanded limit")
    }
    pos += 46 + nameLen + extraLen + commentLen
  }
  return { hasIndex, count }
}

// Read the uncompressed size from a zip64 extra field (id 0x0001), or null
// when the field is absent/malformed. Layout: id(2) size(2) then, for files,
// the 8-byte uncompressed size (offset 4) after the 8-byte original size.
function readZip64Sizes(buf, extraStart, extraLen) {
  const extraEnd = extraStart + extraLen
  let p = extraStart
  while (p + 4 <= extraEnd) {
    const id = buf.readUInt16LE(p)
    const len = buf.readUInt16LE(p + 2)
    if (id === 0x0001 && len >= 16 && p + 4 + 16 <= extraEnd) {
      return Number(buf.readBigUInt64LE(p + 4 + 8)) // 8-byte original + 8-byte uncompressed
    }
    p += 4 + len
  }
  return null
}

async function exportProjectArchive({ projectPath, destination }) {
  if (!path.isAbsolute(projectPath) || !path.isAbsolute(destination)) {
    throw new Error("Project and archive paths must be absolute")
  }
  const root = fs.realpathSync(projectPath)
  const output = path.resolve(destination)
  if (output.startsWith(root + path.sep) || output === root) {
    throw new Error("Export destination must be outside the project directory")
  }
  const JSZip = (await import("jszip")).default
  const zip = new JSZip()
  const walk = async (dir, rel) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const name = rel ? `${rel}/${entry.name}` : entry.name
      let st
      try { st = await fsp.lstat(full) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        zip.folder(name)
        await walk(full, name)
      } else if (st.isFile()) {
        zip.file(name, await fsp.readFile(full))
      }
    }
  }
  await walk(root, "")
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" })
  // Rust File::create — a missing parent directory is an error, not
  // something the exporter creates on the user's behalf.
  await fsp.writeFile(output, buf)
}

async function importProjectArchive({ archivePath, destination }) {
  if (!path.isAbsolute(archivePath) || !path.isAbsolute(destination)) {
    throw new Error("Archive and destination paths must be absolute")
  }
  const buf = await fsp.readFile(archivePath)
  const { hasIndex } = validateRawZip(buf)
  if (!hasIndex) throw new Error("Archive is not an LLM Wiki project (wiki/index.md is missing)")
  const root = path.resolve(destination)
  if (fs.existsSync(root) && (await fsp.readdir(root)).length > 0) {
    throw new Error("Import destination must be empty")
  }
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(buf)
  const entries = Object.values(zip.files)
  await fsp.mkdir(root, { recursive: true })
  for (const e of entries) {
    if (e.name === "") continue
    const target = path.join(root, e.name)
    if (e.dir) { await fsp.mkdir(target, { recursive: true }); continue }
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, await e.async("nodebuffer"))
  }
  // Rust returns root.to_string_lossy() — the native path form (the web
  // client feeds it straight back into the shared recents registry).
  return root
}

function frontmatterValue(content, key) {
  const normalized = content.replace(/\r\n/g, "\n")
  if (!normalized.startsWith("---\n")) return null
  const body = normalized.slice(4).split("\n---")[0]
  for (const line of body.split("\n")) {
    const idx = line.indexOf(":")
    if (idx < 0) continue
    const name = line.slice(0, idx).trim()
    if (name !== key) continue
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "")
    if (value) return value
  }
  return null
}

async function rebuildWikiIndex({ projectPath }) {
  const wiki = path.join(projectPath, "wiki")
  const groups = new Map()
  // Best-effort graph edge tally across the pages the rebuild reads, so the
  // route can report edgesChanged in its graph:updated frame (stage 4).
  let links = 0
  const walk = async (dir) => {
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) }
    catch (err) { throw new Error(`Failed to enumerate wiki pages: ${err?.message ?? err}`) }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (!entry.name.endsWith(".md")) continue
      const stem = entry.name.replace(/\.md$/i, "")
      if (["index", "overview", "log"].includes(stem.toLowerCase())) continue
      const content = await fsp.readFile(full, "utf-8")
      links += countWikilinks(content)
      const kind = frontmatterValue(content, "type") || "other"
      const title = frontmatterValue(content, "title") || stem
      const target = fwd(path.relative(wiki, full)).replace(/\.md$/i, "")
      if (!groups.has(kind)) groups.set(kind, [])
      groups.get(kind).push([target, title])
    }
  }
  await walk(wiki)
  for (const pages of groups.values()) {
    // Rust BTreeMap-style ordering: byte/code-unit comparison of the
    // lowercased titles — deterministic across locales and hosts.
    pages.sort((a, b) => {
      const x = a[1].toLowerCase()
      const y = b[1].toLowerCase()
      return x < y ? -1 : x > y ? 1 : 0
    })
  }
  const sortedKinds = [...groups.keys()].sort()
  let count = 0
  let output = "# Wiki Index\n\n"
  for (const kind of sortedKinds) {
    const pages = groups.get(kind)
    count += pages.length
    output += `## ${kind}\n\n`
    for (const [slug, title] of pages) output += `- [[${slug}|${title}]]\n`
    output += "\n"
  }
  const indexPath = path.join(wiki, "index.md")
  const tmp = path.join(wiki, ".index.md.rebuild.tmp")
  await fsp.writeFile(tmp, output, "utf-8")
  await fsp.rename(tmp, indexPath)
  return { pages: count, groups: groups.size, links }
}

export const maintenanceCommands = {
  export_project_archive: exportProjectArchive,
  import_project_archive: importProjectArchive,
  rebuild_wiki_index: rebuildWikiIndex,
}
