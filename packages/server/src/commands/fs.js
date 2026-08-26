import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { recordFileVersion, listFileHistory, restoreFileHistory } from "./fileHistory.js"
import { extractPdfMarkdown } from "./extractImages.js"
import {
  preprocessFile as preprocessBinary,
  readPreprocessedCache,
  extractPdf,
  extractOfficeTextFile,
  extractEbookTextFile,
  orgToMarkdown,
  OFFICE_EXTS,
  EBOOK_EXTS,
  IMAGE_EXTS,
  MEDIA_EXTS,
  LEGACY_DOC_EXTS,
} from "./preprocess.js"
import { markAppWrite } from "../appwrite.js"
import { emit } from "../events.js"
import { EventTypes } from "../events/bus.js"
import { findProjectByPathPrefix } from "../store/projects.js"

// Node port of the filesystem Tauri commands (src-tauri/src/commands/fs.rs).
// Paths are normalized to forward slashes on the way out so the TS layer
// can compare/compose them consistently, matching the Rust behavior.

const fwd = (p) => p.split(path.sep).join("/")

function assertAbsoluteFsPath(op, p) {
  if (!path.isAbsolute(p)) throw new Error(`${op} requires an absolute path, got: ${p}`)
}

// ── SSE file:* emission (plans/sse-taxonomy.md stage 3) ──────────────────
// Legacy invoke writers have no project context, so attribution resolves by
// longest-prefix match against projects.path (null when unresolved); the
// payload path is the path as given (the one exception is
// createMissingWikiPage, which reports its returned project-relative path).
// Emission is explicit and independent of markAppWrite (which only keeps the
// filesystem watchers quiet). Routes that emit their own richer frame for
// the same write (api/files.js upload: project-relative path + size) pass
// suppressFileEvents so a single write produces exactly ONE frame.
function emitFileEvent(type, absPath, extra) {
  try {
    const project = findProjectByPathPrefix(absPath)
    emit(type, {
      projectId: project ? project.id : null,
      path: absPath,
      ...(extra ?? {}),
    })
  } catch (err) {
    // Emission must never break the write itself.
    console.warn(`[fs] file event emission failed for ${absPath}: ${err.message}`)
  }
}

const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", tiff: "image/tiff", tif: "image/tiff",
  svg: "image/svg+xml", pdf: "application/pdf",
}

// Extensions we can extract text from directly in the browser-server (no
// native parsers). Binary formats (pdf/docx/xlsx/epub/mobi/images) need the
// desktop Rust backend and report a clear, actionable error instead.
const TEXT_EXTS = new Set([
  "md", "markdown", "txt", "text", "org", "rst", "adoc", "csv", "tsv",
  "json", "jsonl", "yaml", "yml", "toml", "ini", "conf", "cfg", "log",
  "html", "htm", "xml", "css", "js", "mjs", "ts", "tsx", "jsx", "py",
  "rb", "go", "rs", "java", "c", "h", "cpp", "hpp", "sh", "sql", "tex",
  "bib", "srt", "vtt",
])

function entryIsVisible(name, includeHidden) {
  return includeHidden || !name.startsWith(".")
}

function buildTree(dir, depth, maxDepth, includeHidden) {
  if (depth >= maxDepth) return []
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) }
  catch (e) { throw new Error(`Failed to read directory '${dir}': ${e.message}`) }
  const visible = entries.filter((e) => entryIsVisible(e.name, includeHidden))
  visible.sort((a, b) => {
    const ad = a.isDirectory(), bd = b.isDirectory()
    if (ad && !bd) return -1
    if (!ad && bd) return 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  const nodes = []
  for (const entry of visible) {
    const full = path.join(dir, entry.name)
    const isDir = entry.isDirectory()
    const node = { name: entry.name, path: fwd(full), is_dir: isDir }
    if (isDir) {
      const kids = buildTree(full, depth + 1, maxDepth, includeHidden)
      if (kids.length) node.children = kids
    }
    nodes.push(node)
  }
  return nodes
}

// Rust read_file PDF branch: extract_pdf_markdown with a media destination
// only for files under <project>/raw/sources when extractImages is on (the
// desktop writes the extracted rasters to wiki/media/<stem>/), otherwise
// per-page markdown without image extraction.
async function extractPdfText(p, includeImages) {
  if (includeImages) {
    const parent = path.dirname(p)
    const stem = path.basename(p, path.extname(p))
    const rawDir = path.dirname(parent)
    const parentIsSources = parent.endsWith("sources")
    const rawIsRaw = rawDir.endsWith("raw")
    if (parentIsSources && rawIsRaw && stem) {
      const projectRoot = path.dirname(rawDir)
      const mediaDir = path.join(projectRoot, "wiki", "media", stem)
      const urlPrefix = mediaDir.split(path.sep).join("/")
      return await extractPdfMarkdown(p, { mediaDir, urlPrefix })
    }
  }
  return await extractPdf(await fsp.readFile(p))
}

async function readFile({ path: p, extractImages }) {
  // Rust read_file: the <dir>/.cache/<file>.txt written by preprocess_file is
  // authoritative when at least as new as the original.
  const cached = await readPreprocessedCache(p)
  if (cached !== null) return cached
  // Uniform missing-file contract (the desktop's other extractors report their
  // own open-failure string; the text branch normalizes to this message).
  if (!fs.existsSync(p)) throw new Error(`File does not exist: '${p}'`)
  const ext = (path.extname(p).slice(1) || "").toLowerCase()
  const fileName = path.basename(p)
  if (ext === "pdf") return await extractPdfText(p, extractImages ?? true)
  if (ext === "org") return orgToMarkdown(await fsp.readFile(p, "utf-8"))
  if (OFFICE_EXTS.has(ext)) return await extractOfficeTextFile(p, ext)
  if (EBOOK_EXTS.has(ext)) return await extractEbookTextFile(p, ext)
  if (IMAGE_EXTS.has(ext)) {
    const size = await fsp.stat(p).then((st) => st.size).catch(() => 0)
    return `[Image: ${fileName} (${(size / 1024).toFixed(1)} KB)]`
  }
  if (MEDIA_EXTS.has(ext)) {
    const size = await fsp.stat(p).then((st) => st.size).catch(() => 0)
    return `[Media: ${fileName} (${(size / 1048576).toFixed(1)} MB)]`
  }
  if (LEGACY_DOC_EXTS.has(ext)) {
    return `[Document: ${fileName} — text extraction not supported for .${ext} format]`
  }
  try {
    return await fsp.readFile(p, "utf-8")
  } catch (e) {
    const exists = fs.existsSync(p)
    if (!exists) throw new Error(`File does not exist: '${p}'`)
    throw new Error(`Failed to read file '${p}' as text: ${e.message} (likely binary, locked, or non-UTF-8)`)
  }
}

async function writeFile({ path: p, contents, suppressFileEvents = false }) {
  assertAbsoluteFsPath("writeFile", p)
  // Pre-write existence decides created vs modified (plans/sse-taxonomy.md).
  const existed = fs.existsSync(p)
  await fsp.mkdir(path.dirname(p), { recursive: true })
  recordFileVersion(p, "baseline", "before.human.write")
  await fsp.writeFile(p, contents ?? "", "utf-8")
  recordFileVersion(p, "human", "human.write")
  markAppWrite(p)
  if (!suppressFileEvents) {
    emitFileEvent(existed ? EventTypes.FILE_MODIFIED : EventTypes.FILE_CREATED, p, {
      size: Buffer.byteLength(contents ?? "", "utf-8"),
    })
  }
}

async function writeFileBase64({ path: p, base64, suppressFileEvents = false }) {
  assertAbsoluteFsPath("writeFileBase64", p)
  const existed = fs.existsSync(p)
  await fsp.mkdir(path.dirname(p), { recursive: true })
  const buf = Buffer.from(base64, "base64")
  await fsp.writeFile(p, buf)
  markAppWrite(p)
  if (!suppressFileEvents) {
    emitFileEvent(existed ? EventTypes.FILE_MODIFIED : EventTypes.FILE_CREATED, p, {
      size: buf.length,
    })
  }
}

async function writeFileAtomic({ path: p, contents, suppressFileEvents = false }) {
  assertAbsoluteFsPath("writeFileAtomic", p)
  // Existence is checked BEFORE the rename onto the final path (rename
  // silently replaces the target).
  const existed = fs.existsSync(p)
  await fsp.mkdir(path.dirname(p), { recursive: true })
  recordFileVersion(p, "baseline", "before.human.write")
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, contents ?? "", "utf-8")
  await fsp.rename(tmp, p)
  recordFileVersion(p, "human", "human.write")
  markAppWrite(p)
  if (!suppressFileEvents) {
    // ONE frame for the final path after the rename — the .tmp never emits.
    emitFileEvent(existed ? EventTypes.FILE_MODIFIED : EventTypes.FILE_CREATED, p, {
      size: Buffer.byteLength(contents ?? "", "utf-8"),
    })
  }
}

async function listDirectory({ path: p, includeHidden, maxDepth }) {
  const inc = includeHidden ?? false
  let md = maxDepth ?? 30
  md = Math.max(1, Math.min(30, md))
  if (!fs.existsSync(p)) throw new Error(`Path does not exist: '${p}'`)
  if (!fs.statSync(p).isDirectory()) throw new Error(`Path is not a directory: '${p}'`)
  return buildTree(p, 0, md, inc)
}

// 1:1 ports of src-tauri/src/commands/fs.rs copy_file / copy_directory /
// delete_file (incl. file_sync::mark_app_write_path semantics): the server's
// own copies/deletes stay invisible to the filesystem watchers — a copy into
// raw/sources must NOT be re-enqueued into the shared file-change-queue.json
// (the desktop suppresses it via mark_app_write_path; the web now does too).

async function copyFile({ source, destination, suppressFileEvents = false }) {
  const parent = path.dirname(destination)
  try {
    await fsp.mkdir(parent, { recursive: true })
  } catch (err) {
    throw new Error(`Failed to create parent dirs: ${err.message}`)
  }
  markAppWrite(destination)
  try {
    await fsp.copyFile(source, destination)
  } catch (err) {
    throw new Error(`Failed to copy '${source}' to '${destination}': ${err.message}`)
  }
  markAppWrite(destination)
  if (!suppressFileEvents) {
    emitFileEvent(EventTypes.FILE_CREATED, destination)
  }
}

async function copyDirectory({ source, destination, suppressFileEvents = false }) {
  // 1:1 port of Rust copy_directory (fs.rs): the destination root is marked
  // as an app write BEFORE validating/copying, entries whose name starts
  // with "." are skipped (files AND dirs), the non-directory source guard and
  // error strings match Rust, and the returned list contains the copied FILES
  // only (destination paths, forward slashes) — directories are created but
  // not listed, exactly like the desktop's Vec<String> return.
  markAppWrite(destination)
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`'${source}' is not a directory`)
  }
  const copiedFiles = []
  const created = []
  const walk = async (src, dest) => {
    try {
      await fsp.mkdir(dest, { recursive: true })
    } catch (err) {
      throw new Error(`Failed to create dir '${dest}': ${err.message}`)
    }
    created.push(fwd(dest))
    let entries
    try {
      entries = await fsp.readdir(src, { withFileTypes: true })
    } catch (err) {
      throw new Error(`Dir entry error: ${err.message}`)
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      const s = path.join(src, entry.name)
      const d = path.join(dest, entry.name)
      if (entry.isDirectory()) {
        await walk(s, d)
      } else {
        try {
          await fsp.copyFile(s, d)
        } catch (err) {
          throw new Error(`Failed to copy '${s}': ${err.message}`)
        }
        markAppWrite(d)
        copiedFiles.push(fwd(d))
        created.push(fwd(d))
      }
    }
  }
  await walk(source, destination)
  if (!suppressFileEvents) {
    // file:created per created path (dirs + files) — richer than the Rust
    // return list, which only feeds command results, not the SSE tree.
    for (const createdPath of created) {
      emitFileEvent(EventTypes.FILE_CREATED, createdPath)
    }
  }
  return copiedFiles
}

// Desktop remove_path_with_retry (fs.rs): up to 4 attempts, backing off
// 250/500/1000 ms on Windows transient delete errors (antivirus/indexer
// locks), so a one-shot delete does not fail on a momentary lock.
function isWindowsTransientDeleteError(err) {
  if (process.platform !== "win32") return false
  const code = err && err.code
  return code === "EBUSY" || code === "EPERM" || code === "EACCES"
}

async function removePathWithRetry(target, isDir) {
  let lastErr = null
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // No force: a missing path must throw (Rust fs::remove_file errors),
      // so delete_file reports the desktop's hard failure instead of a
      // silent no-op.
      if (isDir) await fsp.rm(target, { recursive: true })
      else await fsp.rm(target)
      return
    } catch (err) {
      lastErr = err
      if (attempt < 3 && isWindowsTransientDeleteError(err)) {
        await new Promise((r) => setTimeout(r, 250 * (1 << attempt)))
        continue
      }
      throw err
    }
  }
  throw lastErr ?? new Error("delete failed")
}

async function deleteFile({ path: p, suppressFileEvents = false }) {
  // 1:1 port of Rust delete_file (fs.rs): mark app-write BEFORE and AFTER
  // (the watchers must not treat the app's own delete as an external edit),
  // directories remove recursively like remove_dir_all, and a missing path
  // is a hard error (`Failed to delete file '<path>': <cause>`), NOT a
  // silent no-op — the desktop frontend already tolerates that error.
  markAppWrite(p)
  const isDir = fs.existsSync(p) && fs.statSync(p).isDirectory()
  try {
    await removePathWithRetry(p, isDir)
  } catch (err) {
    throw new Error(
      isDir
        ? `Failed to delete directory '${p}': ${err.message}`
        : `Failed to delete file '${p}': ${err.message}`,
    )
  }
  markAppWrite(p)
  if (!suppressFileEvents) {
    emitFileEvent(EventTypes.FILE_DELETED, p)
  }
}

async function preprocessFile(args) {
  // Full multi-format extraction (PDF/Office/ODF/EPUB/MOBI/Org/text) lives in
  // preprocess.js so the browser ingest pipeline gets the same text the
  // desktop app produces from binary documents.
  return preprocessBinary(args)
}

async function createDirectory({ path: p }) {
  assertAbsoluteFsPath("createDirectory", p)
  await fsp.mkdir(p, { recursive: true })
}

async function fileExists({ path: p }) {
  return fs.existsSync(p)
}

async function getFileModifiedTime({ path: p }) {
  const stat = await fsp.stat(p)
  return Math.floor(stat.mtimeMs)
}

async function getFileSize({ path: p }) {
  const stat = await fsp.stat(p)
  return stat.size
}

async function getFileMd5({ path: p }) {
  const buf = await fsp.readFile(p)
  return crypto.createHash("md5").update(buf).digest("hex")
}

async function readFileAsBase64({ path: p }) {
  const buf = await fsp.readFile(p)
  const ext = (path.extname(p).slice(1) || "").toLowerCase()
  return { base64: buf.toString("base64"), mimeType: MIME_BY_EXT[ext] || "application/octet-stream" }
}

async function applyTextSelectionEdit({ projectPath, filePath, prefix, selectedText, suffix, replacement, suppressFileEvents = false }) {
  const project = fs.realpathSync(projectPath)
  const file = fs.realpathSync(filePath)
  if (!file.startsWith(project) || !fs.statSync(file).isFile()) {
    throw new Error("Selection edit target must be an existing file inside the project")
  }
  const current = await fsp.readFile(file, "utf-8")
  const expected = `${prefix}${selectedText}${suffix}`
  if (current !== expected) {
    throw new Error("The file changed after the selection was captured. Re-select the text before applying the Agent suggestion.")
  }
  const updated = `${prefix}${replacement}${suffix}`
  recordFileVersion(file, "baseline", "before.agent.selection_edit")
  await fsp.writeFile(file, updated, "utf-8")
  recordFileVersion(file, "agent", "agent.selection_edit")
  markAppWrite(file)
  if (!suppressFileEvents) {
    // Target pre-existence is enforced above ⇒ always file:modified.
    emitFileEvent(EventTypes.FILE_MODIFIED, filePath, {
      size: Buffer.byteLength(updated, "utf-8"),
    })
  }
  return updated
}

function safeMissingPageStem(title) {
  let stem = ""
  for (const ch of title) {
    if (/[\x00-\x1f]/.test(ch) || "<>:\"/\\|?*".includes(ch)) stem += "-"
    else if (/\s/.test(ch)) stem += " "
    else stem += ch
  }
  while (stem.includes("--")) stem = stem.replace(/--/g, "-")
  stem = stem.replace(/^[ .-]+|[ .-]+$/g, "")
  if (!stem) stem = "untitled"
  const device = (stem.split(".")[0] || "").toUpperCase()
  const reserved = device === "CON" || device === "PRN" || device === "AUX" || device === "NUL" ||
    (device.length === 4 && (device.startsWith("COM") || device.startsWith("LPT")) &&
      /[1-9]/.test(device[3]))
  if (reserved) stem = `page-${stem}`
  return [...stem].slice(0, 120).join("")
}

async function createMissingWikiPage({ projectPath, title, content, suppressFileEvents = false }) {
  const project = fs.realpathSync(projectPath)
  let t = (title || "").trim()
  if (!t || [...t].length > 200) throw new Error("Missing-link page title must contain 1 to 200 characters")
  t = [...t].map((c) => (/[\x00-\x1f]/.test(c) ? " " : c)).join("").trim()
  if (content && content.length > 2 * 1024 * 1024) throw new Error("Missing-link page content exceeds the 2 MB limit")
  const wikiRoot = path.join(project, "wiki")
  const directory = path.join(wikiRoot, "concepts")
  await fsp.mkdir(directory, { recursive: true })
  const base = safeMissingPageStem(t)
  let target = path.join(directory, `${base}.md`)
  for (let suffix = 2; suffix <= 9999; suffix++) {
    if (!fs.existsSync(target)) break
    target = path.join(directory, `${base}-${suffix}.md`)
  }
  if (fs.existsSync(target)) throw new Error("Could not allocate a unique wiki page filename")
  const today = new Date().toISOString().slice(0, 10)
  const escaped = t.replace(/"/g, '\\"')
  const defaultContent = `---\ntype: concept\ntitle: "${escaped}"\ncreated: ${today}\nupdated: ${today}\ntags: []\nrelated: []\n---\n\n# ${t}\n`
  const body = content && content.trim() ? content : defaultContent
  await fsp.writeFile(target, body, { encoding: "utf-8", flag: "wx" })
  recordFileVersion(target, "agent", "wiki.missing_link.create")
  markAppWrite(target)
  const rel = fwd(path.relative(project, target))
  if (!suppressFileEvents) {
    // Created, reported with the returned project-relative path.
    emitFileEvent(EventTypes.FILE_CREATED, projectPath, { path: rel, size: Buffer.byteLength(body, "utf-8") })
  }
  return rel
}

function collectRelatedPages(dir, sourceName, results) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  const fileName = path.basename(sourceName)
  const fileNameLower = fileName.toLowerCase()
  const dotIdx = fileName.lastIndexOf(".")
  const fileStem = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName
  const fileStemLower = fileStem ? fileStem.toLowerCase() : fileNameLower
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectRelatedPages(full, sourceName, results)
    } else if (entry.name.endsWith(".md")) {
      const fname = entry.name
      if (fname === "index.md" || fname === "log.md" || fname === "overview.md") continue
      let content
      try { content = fs.readFileSync(full, "utf-8") } catch { continue }
      const contentLower = content.toLowerCase()
      const sourcesMatch = contentLower.includes(`"${fileNameLower}"`) || contentLower.includes(`'${fileNameLower}'`)
      const inSourcesDir = full.split(path.sep).includes("sources")
      const isSourceSummary = inSourcesDir && fname.toLowerCase().startsWith(fileStemLower)
      let frontmatterMatch = false
      if (content.startsWith("---\n")) {
        const endRel = content.slice(4).indexOf("\n---")
        if (endRel >= 0) {
          const fm = content.slice(4, 4 + endRel).toLowerCase()
          let inSourcesBlock = false
          for (const line of fm.split("\n")) {
            if (line.startsWith("sources:")) {
              if (line.includes(fileNameLower)) { frontmatterMatch = true; break }
              inSourcesBlock = true
              continue
            }
            if (inSourcesBlock) {
              if (line === "" || line.startsWith(" ") || line.startsWith("\t")) {
                if (line.includes(fileNameLower)) { frontmatterMatch = true; break }
              } else inSourcesBlock = false
            }
          }
        }
      }
      if (sourcesMatch || isSourceSummary || frontmatterMatch) results.push(fwd(full))
    }
  }
}

async function findRelatedWikiPages({ projectPath, sourceName }) {
  const wikiDir = path.join(projectPath, "wiki")
  if (!fs.existsSync(wikiDir) || !fs.statSync(wikiDir).isDirectory()) return []
  const results = []
  collectRelatedPages(wikiDir, sourceName, results)
  return results
}

export const fsCommands = {
  read_file: readFile,
  write_file: writeFile,
  write_file_base64: writeFileBase64,
  write_file_atomic: writeFileAtomic,
  list_directory: listDirectory,
  copy_file: copyFile,
  copy_directory: copyDirectory,
  preprocess_file: preprocessFile,
  delete_file: deleteFile,
  create_directory: createDirectory,
  file_exists: fileExists,
  get_file_modified_time: getFileModifiedTime,
  get_file_size: getFileSize,
  get_file_md5: getFileMd5,
  read_file_as_base64: readFileAsBase64,
  apply_text_selection_edit: applyTextSelectionEdit,
  create_missing_wiki_page: createMissingWikiPage,
  find_related_wiki_pages: findRelatedWikiPages,
  list_file_history: (a) => listFileHistory(a),
  restore_file_history: (a) => restoreFileHistory(a),
}
