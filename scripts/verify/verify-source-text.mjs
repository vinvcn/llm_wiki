// Source-text extraction + preprocessing-cache acceptance harness.
// Verifies the web server honors the desktop's binary-source contract so ONE
// project behaves the same on both clients (shared-data promise):
//
//   node scripts/verify/verify-source-text.mjs
//   SERVER_ENTRY=packages/server/src/index-v2.js node scripts/verify/verify-source-text.mjs
//
// A. read_file (desktop fs.rs read_file port):
//    - fresh preprocessing cache short-circuits every format
//    - PDF/DOCX/Org are extracted to text (real fixtures, pdfjs + zip/xml)
//    - image/media/legacy-doc placeholders, exact missing-file error
// A2. legacy OLE2 .doc (REAL Word 97–2003 fixtures, vendored MIT corpus):
//    - exact bodies (upstream snapshots), table + complex docs, graceful
//      convert-first error for invalid files, cache write/short-circuit,
//      source.search over the fresh .doc cache
// B. preprocess_file (desktop fs.rs preprocess_file port):
//    - extracts binary formats and WRITES <dir>/.cache/<name>.txt
//    - "no preprocessing needed" sentinel for everything else (never throws)
//    - the cache write emits NO project://files-changed (app-write-ignore)
// C. agent source.search (tools.rs search_sources 1:1 port):
//    - binaries matched through the FRESH cache only (stale cache ignored)
//    - org/yaml/tsv/markdown coverage, hidden-path skip, empty-query error,
//      top_k clamp
// D. agent loop integration: a mock-LLM turn issuing source.search returns
//    the binary's cached text as a `source` reference.

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http from "node:http"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log("  ok  -", m) } else { fail++; console.log("  FAIL-", m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
}
async function waitFor(fn, t, what) {
  const start = Date.now()
  while (Date.now() - start < t) { try { if (await fn()) return true } catch {} await sleep(80) }
  throw new Error(`timeout waiting for ${what}`)
}
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body)
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c))
      res.on("end", () => { try { resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }) } catch { resolve({ status: res.statusCode, raw: buf }) } })
    })
    r.on("error", reject); if (data) r.write(data); r.end()
  })
}

// The v2/Docker entrypoint wraps invoke results as { ok, result } (and errors
// as 200 { ok:false, error:{ message } }); the legacy entry returns the raw
// result / 500 { error }. Unwrap so both runs assert the same contract (same
// pattern as verify-filesync-shared.mjs / verify-vectorstore.mjs).
const V2_INVOKE = process.env.SERVER_ENTRY?.includes("index-v2") ?? false
const unv = (j) => (V2_INVOKE ? j?.result : j)
// Error envelopes: legacy 500 { error: "..." }; v2 200 { ok:false, error:{ message } }
// or 400 { error: { message } }. Extract the message string from any of them.
const errText = (r) => {
  const e = r.json?.error
  if (e == null) return JSON.stringify(r.json ?? r.raw)
  return typeof e === "string" ? e : (e.message ?? JSON.stringify(e))
}
function isErr(r) {
  if (V2_INVOKE) return (r.status === 200 && r.json?.ok === false) || r.status >= 400
  return r.status !== 200
}
// SSE event stream: the legacy entry serves /api/events; the v2 entry serves
// /api/v2/events (same bus).
const EVENTS_PATH = process.env.SERVER_ENTRY?.includes("index-v2") ? "/api/v2/events" : "/api/events"

// ── fixtures: a REAL minimal PDF (extractable via pdfjs) + REAL DOCX ──────
function buildPdf(text) {
  const objs = []
  objs[1] = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
  objs[2] = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
  objs[3] = "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n"
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  objs[4] = `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`
  objs[5] = "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  for (let i = 1; i <= 5; i++) { offsets[i] = pdf.length; pdf += objs[i] }
  const xrefPos = pdf.length
  pdf += "xref\n0 6\n0000000000 65535 f \n" + offsets.slice(1).map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return pdf
}
async function buildDocx(text) {
  const JSZip = (await import("jszip")).default
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
</w:document>`)
  return await zip.generateAsync({ type: "nodebuffer" })
}
// 1×1 transparent PNG
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-srctext-"))
const projectPath = path.join(tmp, "project")
const srcDir = path.join(projectPath, "raw", "sources")
fs.mkdirSync(path.join(srcDir, ".cache"), { recursive: true })
fs.mkdirSync(path.join(srcDir, "sub"), { recursive: true })
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n")

const PDF_TEXT = "Hello PdfWiki Extraction"
const DOCX_TEXT = "Hello DocxWiki Extraction"
fs.writeFileSync(path.join(srcDir, "probe.pdf"), buildPdf(PDF_TEXT))
fs.writeFileSync(path.join(srcDir, "probe.docx"), await buildDocx(DOCX_TEXT))
fs.writeFileSync(path.join(srcDir, "notes.org"), "* Policy\nExact org wording about quotas")
fs.writeFileSync(path.join(srcDir, "plain.md"), "plain markdown body")
fs.writeFileSync(path.join(srcDir, "data.yaml"), "key: yamlconfig wording here")
fs.writeFileSync(path.join(srcDir, "table.tsv"), "a\tb\ntsvrow wording here")
fs.writeFileSync(path.join(srcDir, "extra.markdown"), "markdown ext wording here")
fs.writeFileSync(path.join(srcDir, "sub", "deep.md"), "nested deep wording here")
fs.writeFileSync(path.join(srcDir, "pixel.png"), PNG_1X1)
fs.writeFileSync(path.join(srcDir, "movie.mp4"), Buffer.alloc(2 * 1024 * 1024)) // 2.0 MB
fs.writeFileSync(path.join(srcDir, "legacy.ppt"), "old powerpoint bytes")
// binary with a fresh cache (searchable) and one with a STALE cache (not)
fs.writeFileSync(path.join(srcDir, "regulation.pdf"), "%PDF placeholder")
fs.writeFileSync(path.join(srcDir, ".cache", "regulation.pdf.txt"), "Exact cached regulation wording")
fs.writeFileSync(path.join(srcDir, ".cache", "stale.pdf.txt"), "stale cached wording xyzzstale")
fs.writeFileSync(path.join(srcDir, "stale.pdf"), "%PDF placeholder")
{
  const nowSec = Math.floor(Date.now() / 1000)
  fs.utimesSync(path.join(srcDir, ".cache", "stale.pdf.txt"), nowSec - 60, nowSec - 60)
  fs.utimesSync(path.join(srcDir, "stale.pdf"), nowSec, nowSec)
}
fs.writeFileSync(path.join(srcDir, ".hidden-secret.md"), "xyzzhiddenunique here")
fs.writeFileSync(path.join(srcDir, ".cache", "inner.txt"), "xyzzinnerunique here")

// ── mock LLM: issues one source.search tool call, then answers ────────────
const TOOL_CALL_ID = "call_mock_src_1"
function wantsTool(messages) { return !messages.some((m) => m.role === "tool") }
function mockHandler(reqBody, res) {
  const messages = reqBody.messages ?? []
  const stream = !!reqBody.stream
  const tool = { id: TOOL_CALL_ID, type: "function", function: { name: "source.search", arguments: JSON.stringify({ query: "cached regulation" }) } }
  if (wantsTool(messages)) {
    if (stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const chunk = (delta, finish) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`
      res.write(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: tool.id, type: "function", function: { name: tool.function.name, arguments: "" } }] }))
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: tool.function.arguments } }] }))
      res.write(chunk({}, "tool_calls"))
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [tool] } }] }))
    }
  } else {
    const answer = "The regulation source says what it says."
    if (stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const chunk = (delta, finish) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`
      for (const w of answer.split(" ")) res.write(chunk({ role: "assistant", content: w + " " }))
      res.write(chunk({}, "stop"))
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer } }] }))
    }
  }
}
const mockPort = await freePort()
const mock = http.createServer((rq, rs) => {
  let buf = ""
  rq.on("data", (c) => (buf += c))
  rq.on("end", () => {
    if (rq.method === "POST" && rq.url.includes("/chat/completions")) {
      try { mockHandler(JSON.parse(buf), rs) } catch (e) { rs.writeHead(500); rs.end(String(e)) }
    } else { rs.writeHead(404); rs.end("nope") }
  })
})
await new Promise((r) => mock.listen(mockPort, r))

// ── server under test ─────────────────────────────────────────────────────
const dataDir = path.join(tmp, "data")
const storesDir = path.join(dataDir, "stores")
fs.mkdirSync(storesDir, { recursive: true })
const storeData = {
  llmConfig: { provider: "custom", apiKey: "test-key", model: "mock-model", customEndpoint: `http://127.0.0.1:${mockPort}/v1`, apiMode: "chat_completions" },
  projectRegistry: { "proj-src": { id: "proj-src", path: projectPath, name: "project" } },
  lastProject: { id: "proj-src", path: projectPath },
}
fs.writeFileSync(path.join(storesDir, "app-state.json"), JSON.stringify(storeData, null, 2))

const SERVER_ENTRY = process.env.SERVER_ENTRY || "packages/server/src/index.js"
const port = await freePort()
const clipPort = await freePort()
const child = spawn(process.execPath, [SERVER_ENTRY], {
  cwd: REPO,
  env: { ...process.env, LLM_WIKI_PORT: String(port), LLM_WIKI_CLIP_PORT: String(clipPort), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", (d) => (serverLog += d)); child.stderr.on("data", (d) => (serverLog += d))

const invoke = async (cmd, body) => await req(port, "POST", `/api/invoke/${cmd}`, body)

try {
  await waitFor(async () => (await req(port, "GET", "/api/health")).status === 200, 15000, "server health")

  console.log("A. read_file binary/cache contract")
  let r = await invoke("read_file", { path: path.join(srcDir, "probe.pdf") })
  ok(r.status === 200 && typeof unv(r.json) === "string" && unv(r.json).startsWith("## Page 1") && unv(r.json).includes(PDF_TEXT), "read_file extracts PDF text (per-page markdown)")
  r = await invoke("read_file", { path: path.join(srcDir, "probe.docx"), extractImages: false })
  ok(r.status === 200 && unv(r.json) === DOCX_TEXT, "read_file extracts DOCX text")
  r = await invoke("read_file", { path: path.join(srcDir, "notes.org") })
  ok(r.status === 200 && /^# Policy/m.test(unv(r.json)) && unv(r.json).includes("Exact org wording about quotas"), "read_file converts Org to markdown")
  r = await invoke("read_file", { path: path.join(srcDir, "plain.md") })
  ok(r.status === 200 && unv(r.json) === "plain markdown body", "read_file reads plain text unchanged")
  r = await invoke("read_file", { path: path.join(srcDir, "pixel.png") })
  ok(r.status === 200 && /^\[Image: pixel\.png \(\d+\.\d KB\)\]$/.test(unv(r.json)), `read_file image placeholder (${JSON.stringify(unv(r.json))})`)
  r = await invoke("read_file", { path: path.join(srcDir, "movie.mp4") })
  ok(r.status === 200 && /^\[Media: movie\.mp4 \(2\.0 MB\)\]$/.test(unv(r.json)), `read_file media placeholder (${JSON.stringify(unv(r.json))})`)
  r = await invoke("read_file", { path: path.join(srcDir, "legacy.ppt") })
  ok(r.status === 200 && unv(r.json) === "[Document: legacy.ppt — text extraction not supported for .ppt format]", "read_file legacy-doc placeholder")
  r = await invoke("read_file", { path: path.join(srcDir, "missing.txt") })
  ok(isErr(r) && errText(r).includes(`File does not exist: '${path.join(srcDir, "missing.txt")}'`), "read_file exact missing-file error")

  // cache short-circuit: a FRESH cache wins over extraction for ANY format
  const cacheDir = path.join(srcDir, ".cache")
  const pdfCache = path.join(cacheDir, "probe.pdf.txt")
  fs.writeFileSync(pdfCache, "CUSTOM CACHED PDF TEXT")
  r = await invoke("read_file", { path: path.join(srcDir, "probe.pdf") })
  ok(r.status === 200 && unv(r.json) === "CUSTOM CACHED PDF TEXT", "read_file short-circuits on fresh cache")
  // stale cache: original strictly newer -> extraction again
  const nowSec = Math.floor(Date.now() / 1000)
  fs.utimesSync(pdfCache, nowSec - 60, nowSec - 60)
  fs.utimesSync(path.join(srcDir, "probe.pdf"), nowSec, nowSec)
  r = await invoke("read_file", { path: path.join(srcDir, "probe.pdf") })
  ok(r.status === 200 && typeof unv(r.json) === "string" && unv(r.json).includes(PDF_TEXT), "read_file ignores stale cache")

  console.log("A2. legacy OLE2 .doc (real Word 97–2003 fixtures)")
  // Real Word binaries vendored from the MIT-licensed word-extractor test
  // corpus (scripts/verify/fixtures/word-doc/README.md). Expected bodies are
  // pinned by the upstream Jest snapshots for those files.
  const DOC_FIXTURES = path.join(REPO, "scripts/verify/fixtures/word-doc")
  for (const f of ["test01.doc", "test03.doc", "test05.doc", "bigfile-01.doc", "badfile-01-bad-header.doc"]) {
    fs.copyFileSync(path.join(DOC_FIXTURES, f), path.join(srcDir, f))
  }
  const DOC05_BODY = "This is a simple file created with Word 97-SR2."
  const DOC01_BODY = "A second test of reviewing, but with Unicode characters in to see if character offsets get broken. \u{1F600} \u2200\n\nThis is a test of reviewing\n\nThis text has been inserted, \u273Band should be included"
  r = await invoke("read_file", { path: path.join(srcDir, "test05.doc") })
  ok(r.status === 200 && unv(r.json) === DOC05_BODY, `read_file extracts Word 97 .doc body exactly (${JSON.stringify(unv(r.json))})`)
  r = await invoke("read_file", { path: path.join(srcDir, "test01.doc") })
  ok(r.status === 200 && unv(r.json) === DOC01_BODY, "read_file extracts .doc revisions + Unicode (😀 ∀ ✻) exactly")
  r = await invoke("read_file", { path: path.join(srcDir, "test03.doc") })
  ok(r.status === 200 && typeof unv(r.json) === "string"
    && unv(r.json).startsWith("Each license name is hyperlinked to its location.")
    && unv(r.json).includes("License\tGPL v3.0\tLGPL v3.0\tBSD\tMIT (X11)\tApache v2.0"), "read_file extracts .doc table (tab-separated cells)")
  r = await invoke("read_file", { path: path.join(srcDir, "bigfile-01.doc") })
  ok(r.status === 200 && typeof unv(r.json) === "string" && unv(r.json).startsWith("BlogCFC\n\nWelcome to BlogCFC") && unv(r.json).length > 30000, `read_file extracts complex real-world .doc (${typeof unv(r.json) === "string" ? unv(r.json).length : "?"} chars)`)
  r = await invoke("read_file", { path: path.join(srcDir, "badfile-01-bad-header.doc") })
  ok(isErr(r) && errText(r).includes("Legacy .doc extraction failed:") && errText(r).includes("Re-save as .docx"), "read_file invalid .doc degrades to the documented convert-first error")
  r = await invoke("preprocess_file", { path: path.join(srcDir, "test03.doc") })
  ok(r.status === 200 && typeof unv(r.json) === "string" && unv(r.json).startsWith("Each license name is hyperlinked"), "preprocess_file extracts .doc")
  const docCache = path.join(cacheDir, "test03.doc.txt")
  ok(fs.existsSync(docCache) && fs.readFileSync(docCache, "utf-8").startsWith("Each license name is hyperlinked"), "preprocess_file wrote .cache/test03.doc.txt (desktop-shared cache format)")
  fs.copyFileSync(path.join(DOC_FIXTURES, "test05.doc"), path.join(srcDir, "test05-cached.doc"))
  fs.writeFileSync(path.join(cacheDir, "test05-cached.doc.txt"), "CUSTOM CACHED DOC TEXT")
  r = await invoke("read_file", { path: path.join(srcDir, "test05-cached.doc") })
  ok(r.status === 200 && unv(r.json) === "CUSTOM CACHED DOC TEXT", "read_file short-circuits .doc on fresh cache")
  {
    const { searchSources: searchDocSources } = await import(path.join(REPO, "packages/server/src/agent-tools.js"))
    const docRefs = await searchDocSources(projectPath, "hyperlinked to its location", 5)
    ok(docRefs.some((x) => x.path === "raw/sources/test03.doc" && (x.snippet ?? "").includes("hyperlinked")), "source.search matches .doc binaries via fresh cache")
  }

  console.log("B. preprocess_file cache contract")
  r = await invoke("preprocess_file", { path: path.join(srcDir, "probe.docx") })
  ok(r.status === 200 && unv(r.json) === DOCX_TEXT, "preprocess_file extracts DOCX")
  const docxCache = path.join(cacheDir, "probe.docx.txt")
  ok(fs.existsSync(docxCache) && fs.readFileSync(docxCache, "utf-8") === DOCX_TEXT, "preprocess_file wrote .cache/<name>.txt")
  r = await invoke("preprocess_file", { path: path.join(srcDir, "plain.md") })
  ok(r.status === 200 && unv(r.json) === "no preprocessing needed", "preprocess_file sentinel for text formats")
  fs.writeFileSync(path.join(srcDir, "archive.zip"), "PK fake zip")
  r = await invoke("preprocess_file", { path: path.join(srcDir, "archive.zip") })
  ok(r.status === 200 && unv(r.json) === "no preprocessing needed", "preprocess_file sentinel for unknown binary (no throw)")

  // the cache write must NOT surface as an external file change
  await invoke("start_project_file_watcher", { projectPath })
  const events = []
  const sseReq = http.request({ host: "127.0.0.1", port, path: EVENTS_PATH, method: "GET" }, (res) => {
    let buf = ""
    res.on("data", (c) => {
      buf += c.toString()
      let idx
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2)
        let ev = null, data = ""
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim()
          else if (line.startsWith("data:")) data += line.slice(5).trim()
        }
        if (ev && data) { try { events.push({ ev, data: JSON.parse(data) }) } catch { events.push({ ev, data }) } }
      }
    })
  })
  sseReq.end()
  await sleep(300)
  await invoke("preprocess_file", { path: path.join(srcDir, "probe.pdf") })
  await sleep(1200)
  const fcEvents = events.filter((e) => e.ev === "project://files-changed")
  ok(fcEvents.length === 0, `no files-changed event for cache write (got ${fcEvents.length})`)
  sseReq.destroy()

  console.log("C. agent source.search (search_sources port)")
  const { searchSources } = await import(path.join(REPO, "packages/server/src/agent-tools.js"))
  let refs = await searchSources(projectPath, "org wording", 5)
  ok(refs.some((x) => x.path === "raw/sources/notes.org"), "source.search matches org files")
  refs = await searchSources(projectPath, "cached regulation", 5)
  const pdfRef = refs.find((x) => x.path === "raw/sources/regulation.pdf")
  ok(!!pdfRef && pdfRef.kind === "source" && pdfRef.snippet.includes("cached regulation"), "source.search matches binaries via fresh cache")
  refs = await searchSources(projectPath, "xyzzstale", 5)
  ok(refs.length === 0, "source.search ignores stale cache")
  refs = await searchSources(projectPath, "xyzzhiddenunique", 5)
  ok(refs.length === 0, "source.search skips hidden files")
  refs = await searchSources(projectPath, "xyzzinnerunique", 5)
  ok(refs.length === 0, "source.search skips .cache contents")
  refs = await searchSources(projectPath, "yamlconfig", 5)
  ok(refs.some((x) => x.path === "raw/sources/data.yaml"), "source.search matches yaml")
  refs = await searchSources(projectPath, "tsvrow", 5)
  ok(refs.some((x) => x.path === "raw/sources/table.tsv"), "source.search matches tsv")
  refs = await searchSources(projectPath, "markdown ext", 5)
  ok(refs.some((x) => x.path === "raw/sources/extra.markdown"), "source.search matches .markdown")
  refs = await searchSources(projectPath, "nested deep", 5)
  ok(refs.some((x) => x.path === "raw/sources/sub/deep.md"), "source.search recurses into subdirs")
  let err = null
  try { await searchSources(projectPath, "   ", 5) } catch (e) { err = e }
  ok(err?.message === "source.search query is required", "source.search empty-query error string")
  refs = await searchSources(projectPath, "wording", 50)
  ok(refs.length <= 10, "source.search top_k clamped to 10")

  console.log("D. agent loop integration (mock LLM issues source.search)")
  r = await invoke("agent_start_turn", { projectId: "proj-src", request: { message: "what does the regulation say?", sessionId: "sess-src-1", runId: "run-src-1", mode: "standard", tools: { wiki: true } } })
  const resp = unv(r.json) ?? {}
  const srcRefs = resp.references ?? []
  ok(r.status === 200 && resp.sessionId === "sess-src-1" && typeof resp.message === "string" && resp.message.length > 0, `BackendAgentResponse shape (status ${r.status}, sessionId ${JSON.stringify(resp.sessionId)})`)
  ok(Array.isArray(resp.toolEvents) && resp.toolEvents.some((t) => t.tool === "source.search" && t.status === "completed"), "toolEvents has completed source.search")
  ok(srcRefs.some((x) => x.kind === "source" && x.path === "raw/sources/regulation.pdf" && (x.snippet ?? "").includes("cached regulation")), "agent turn carries the binary source reference")

} catch (e) {
  fail++
  console.log("FAIL - harness error:", e.message)
  console.log(serverLog.slice(-2000))
} finally {
  child.kill("SIGKILL")
  mock.close()
}

console.log(`\nsource-text: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
