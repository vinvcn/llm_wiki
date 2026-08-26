import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import zlib from "node:zlib"

// Server port of src-tauri/src/commands/extract_images.rs (the four
// extract_*_images commands the ingest pipeline calls). The desktop uses
// pdfium + the `image` crate; the web server has neither, so we use
// pdfjs-dist (already a dependency) for PDF and a small pure-Node PNG
// encoder for re-encoding decoded PDF raster, while Office images are read
// straight out of the OOXML zip (the embedded media are already complete
// PNG/JPEG/... files — no re-encoding needed).
//
// Wire shapes mirror the Rust `#[serde(rename_all = "camelCase")]` structs
// EXACTLY, because the frontend hard-filters on `index`/`relPath`/`absPath`
// (a single wrong casing silently drops every image — see the warning in
// src/lib/extract-source-images.ts).

const fwd = (p) => p.split(path.sep).join("/")

// ── CRC32 + PNG encoder (8-bit gray/rgb/rgba) ─────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const tb = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0)
  return Buffer.concat([len, tb, data, crc])
}
/** Encode raw samples to PNG. channels: 1=gray,3=rgb,4=rgba. */
export function encodePng(width, height, channels, samples) {
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6
  const stride = width * channels
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    samples.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))])
}

// ── dimension parsers (best-effort; never throw) ──────────────────────────
function dimsPng(b) { return b.length >= 24 ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null }
function dimsGif(b) { return b.length >= 10 ? [b.readUInt16LE(6), b.readUInt16LE(8)] : null }
function dimsBmp(b) { return b.length >= 26 ? [b.readInt32LE(18), Math.abs(b.readInt32LE(22))] : null }
function dimsJpeg(b) {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue }
    const m = b[i + 1]
    if (m === 0xd8 || m === 0xd9) { i += 2; continue }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]
    }
    const seg = b.readUInt16BE(i + 2)
    i += 2 + seg
  }
  return null
}
function dimsOf(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50) return dimsPng(buf)
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return dimsJpeg(buf)
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49) return dimsGif(buf)
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) return dimsBmp(buf)
  return null
}
function mimeByMagic(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png"
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg"
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif"
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp"
  if (buf.length >= 12 && buf[0] === 0x52 && buf[8] === 0x57) return "image/webp"
  return "application/octet-stream"
}
const MIME_BY_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", tif: "image/tiff", tiff: "image/tiff", jfif: "image/jpeg" }
function mimeOf(name, buf) {
  const ext = (path.extname(name).slice(1) || "").toLowerCase()
  return MIME_BY_EXT[ext] || mimeByMagic(buf)
}
const sha256hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex")
function sanitize(name) { return String(name).replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/\/+/g, "_") || "img" }

// ── Office (docx/pptx) ────────────────────────────────────────────────────
async function officeMediaEntries(zip) {
  // Returns [{ name, bytes, page }] in document order. page = slide# for pptx
  // (1-based) or null for docx.
  const names = Object.keys(zip.files)
  const isPptx = names.some((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
  if (isPptx) {
    const slideNums = names
      .map((n) => { const m = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(n); return m ? Number(m[1]) : null })
      .filter((n) => n != null).sort((a, b) => a - b)
    const out = []
    const seen = new Set()
    for (const sn of slideNums) {
      const relsName = `ppt/slides/_rels/slide${sn}.xml.rels`
      const relsFile = zip.files[relsName]
      if (!relsFile) continue
      const xml = await relsFile.async("string")
      const targets = []
      const re = /Target="([^"]+)"/g
      let m
      while ((m = re.exec(xml))) {
        let t = m[1]
        if (!/media\//i.test(t)) continue
        // resolve relative to ppt/slides/
        const resolved = path.posix.normalize(`ppt/slides/${t}`)
        targets.push(resolved)
      }
      for (const t of targets) {
        if (seen.has(t)) continue
        const f = zip.files[t]
        if (!f || f.dir) continue
        seen.add(t)
        out.push({ name: path.posix.basename(t), bytes: Buffer.from(await f.async("uint8array")), page: sn })
      }
    }
    // media not referenced by any slide (e.g. masters): append with page=null
    for (const n of names.filter((x) => /^ppt\/media\//i.test(x) && !zip.files[x].dir)) {
      if (seen.has(n)) continue
      const f = zip.files[n]
      out.push({ name: path.posix.basename(n), bytes: Buffer.from(await f.async("uint8array")), page: null })
    }
    return out
  }
  // docx: all word/media/* in sorted order, page=null
  return names
    .filter((n) => /^word\/media\//i.test(n) && !zip.files[n].dir)
    .sort()
    .map(async (n) => ({ name: path.posix.basename(n), bytes: Buffer.from(await zip.files[n].async("uint8array")), page: null }))
    .reduce(async (accP, p) => { const acc = await accP; acc.push(await p); return acc }, Promise.resolve([]))
}

// ── PDF (pdfjs + PNG re-encode) ───────────────────────────────────────────
let pdfjsPromise = null
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch((e) => { pdfjsPromise = null; throw e })
  return pdfjsPromise
}
function objsGet(page, name) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    try { page.objs.get(name, finish) } catch { finish(null) }
    // also try commonObjs as a fallback, with a short timeout
    setTimeout(() => {
      if (done) return
      try { page.commonObjs.get(name, finish) } catch { finish(null) }
    }, 50)
    setTimeout(() => finish(null), 4000)
  })
}
async function pdfImageEntries(buf) {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise
  const out = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    let ops
    try { ops = await page.getOperatorList() } catch { continue }
    const OPS = pdfjs.OPS
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] !== OPS.paintImageXObject && ops.fnArray[i] !== OPS.paintJpegXObject) continue
      const name = ops.argsArray[i][0]
      const img = await objsGet(page, name)
      if (!img || !img.width || !img.height) continue
      try {
        const w = img.width, h = img.height
        const kind = img.kind // 1 gray, 2 rgb, 3 rgba (pdfjs ImageKind)
        let channels = kind === 1 ? 1 : kind === 3 ? 4 : 3
        let data = img.data
        if (!data) continue
        // pdfjs may hand us RGBA even for rgb sources; trust `kind`.
        const expected = w * h * channels
        if (data.length < expected) continue
        const samples = Buffer.from(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + expected) : Buffer.from(data).slice(0, expected))
        const png = encodePng(w, h, channels, samples)
        out.push({ name: `page${p}-img${out.length + 1}.png`, bytes: png, page: p, forcedMime: "image/png" })
      } catch { /* skip undecodable image */ }
    }
  }
  return out
}

// Faithful Node port of extract_pdf_markdown (extract_images.rs), used by the
// desktop read_file/preprocess_file PDF path: per-page text blocks shaped
// exactly like the Rust output ("## Page N\n\n<text>\n", blocks joined by
// "\n\n"). When mediaDir is given (the desktop does this only for files under
// <project>/raw/sources with extract_images=true), raster images meeting
// ExtractOptions::default() (min 100×100, max 500 total, skip page-covering
// images ≥90% of both page axes when the page already has ≥80 non-whitespace
// text chars) are PNG-encoded into mediaDir as img-<idx>.png with a GLOBAL
// counter and appended after their page's text as "![](<urlPrefix>/img-N.png)".
const PDF_MD_MIN_WIDTH = 100
const PDF_MD_MIN_HEIGHT = 100
const PDF_MD_MAX_IMAGES = 500
const PDF_MD_FULL_PAGE_COVERAGE = 0.90
const PDF_MD_MIN_TEXT_CHARS = 80

export async function extractPdfMarkdown(input, { mediaDir = null, urlPrefix = "" } = {}) {
  const buf = typeof input === "string" ? await fsp.readFile(input) : Buffer.from(input)
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false, verbosity: 0,
  }).promise
  const prefix = String(urlPrefix).replace(/\/+$/, "")
  let out = ""
  let idx = 0
  let totalSaved = 0
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    if (out) out += "\n\n"
    out += `## Page ${p}\n\n`
    let pageText = ""
    try {
      const tc = await page.getTextContent()
      pageText = tc.items.map((it) => it.str).join(" ")
    } catch { /* page text extraction failed: keep the heading, like the desktop */ }
    out += pageText
    out += "\n"
    if (!mediaDir) continue
    // Desktop: "no point burning pdfium cycles" when there is no destination —
    // handled by the continue above. Image walk for this page:
    const view = page.view || [0, 0, 612, 792]
    const pageW = view[2] - view[0]
    const pageH = view[3] - view[1]
    const meaningfulText = pageText.replace(/\s+/g, "").length >= PDF_MD_MIN_TEXT_CHARS
    let ops = null
    try { ops = await page.getOperatorList() } catch { ops = null }
    if (!ops) continue
    const OPS = pdfjs.OPS
    const pageImageMd = []
    for (let i = 0; i < ops.fnArray.length; i++) {
      if (ops.fnArray[i] !== OPS.paintImageXObject && ops.fnArray[i] !== OPS.paintJpegXObject) continue
      const img = await objsGet(page, ops.argsArray[i][0])
      if (!img || !img.width || !img.height || !img.data) continue
      const w = img.width
      const h = img.height
      if (w < PDF_MD_MIN_WIDTH || h < PDF_MD_MIN_HEIGHT) continue
      // should_skip_full_page_pdf_image: a raster covering most of the page is
      // skipped only when the page already carries meaningful extractable text.
      if (meaningfulText && w >= pageW * PDF_MD_FULL_PAGE_COVERAGE && h >= pageH * PDF_MD_FULL_PAGE_COVERAGE) continue
      let png = null
      try {
        const kind = img.kind // 1 gray, 2 rgb, 3 rgba (pdfjs ImageKind)
        const channels = kind === 1 ? 1 : kind === 3 ? 4 : 3
        const expected = w * h * channels
        if (img.data.length < expected) continue
        const samples = Buffer.from(img.data.buffer
          ? img.data.buffer.slice(img.data.byteOffset, img.data.byteOffset + expected)
          : Buffer.from(img.data).slice(0, expected))
        png = encodePng(w, h, channels, samples)
      } catch { continue }
      idx += 1
      const fileName = `img-${idx}.png`
      try {
        await fsp.mkdir(mediaDir, { recursive: true })
        await fsp.writeFile(path.join(mediaDir, fileName), png)
      } catch { continue }
      totalSaved += 1
      pageImageMd.push(`![](${prefix}/${fileName})`)
      if (totalSaved >= PDF_MD_MAX_IMAGES) break
    }
    if (pageImageMd.length) {
      out += "\n"
      for (const md of pageImageMd) out += md + "\n"
    }
    if (totalSaved >= PDF_MD_MAX_IMAGES) break
  }
  return out
}

// ── shared build/save ─────────────────────────────────────────────────────
function buildRecords(entries) {
  const recs = []
  const used = new Set()
  entries.forEach((e, i) => {
    const mime = e.forcedMime || mimeOf(e.name, e.bytes)
    const d = dimsOf(e.bytes) || [0, 0]
    let base = `${String(i).padStart(3, "0")}-${sanitize(e.name)}`
    let candidate = base
    let k = 2
    while (used.has(candidate)) { candidate = `${base}-${k++}` }
    used.add(candidate)
    recs.push({ index: i, mimeType: mime, page: e.page == null ? null : e.page, width: d[0], height: d[1], bytes: e.bytes, fileName: candidate, sha256: sha256hex(e.bytes) })
  })
  return recs
}

async function extractAndSave(sourcePath, destDir, relTo, extractor) {
  let entries
  try { entries = await extractor(sourcePath) } catch { return [] }
  if (!entries || !entries.length) return []
  await fsp.mkdir(destDir, { recursive: true })
  const recs = buildRecords(entries)
  const out = []
  for (const r of recs) {
    const absPath = path.join(destDir, r.fileName)
    await fsp.writeFile(absPath, r.bytes)
    const relPath = fwd(path.relative(relTo, absPath))
    out.push({ index: r.index, mimeType: r.mimeType, page: r.page, width: r.width, height: r.height, relPath, absPath: fwd(absPath), sha256: r.sha256 })
  }
  return out
}

function extractOnly(sourcePath, extractor) {
  return Promise.resolve().then(async () => {
    let entries
    try { entries = await extractor(sourcePath) } catch { return [] }
    if (!entries || !entries.length) return []
    const recs = buildRecords(entries)
    return recs.map((r) => ({ index: r.index, mimeType: r.mimeType, page: r.page, width: r.width, height: r.height, dataBase64: r.bytes.toString("base64"), sha256: r.sha256 }))
  })
}

const officeExtractor = async (sourcePath) => {
  const JSZip = (await import("jszip")).default
  const zip = await JSZip.loadAsync(await fsp.readFile(sourcePath))
  return officeMediaEntries(zip)
}
const pdfExtractor = async (sourcePath) => pdfImageEntries(await fsp.readFile(sourcePath))

// ── command handlers (names match the Rust generate_handler! list) ────────
async function extract_and_save_office_images_cmd({ sourcePath, destDir, relTo }) {
  return extractAndSave(sourcePath, destDir, relTo, officeExtractor)
}
async function extract_and_save_pdf_images_cmd({ sourcePath, destDir, relTo }) {
  return extractAndSave(sourcePath, destDir, relTo, pdfExtractor)
}
async function extract_office_images_cmd({ path: p }) { return extractOnly(p, officeExtractor) }
async function extract_pdf_images_cmd({ path: p }) { return extractOnly(p, pdfExtractor) }

export const extractImageCommands = {
  extract_pdf_images_cmd,
  extract_office_images_cmd,
  extract_and_save_pdf_images_cmd,
  extract_and_save_office_images_cmd,
}

// low-level exports for isolated testing
export const __test = { officeMediaEntries, pdfImageEntries, encodePng, dimsOf, buildRecords }
