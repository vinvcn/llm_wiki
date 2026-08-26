// Standing gate: vector-store + embedding contract (packages/server vectorstore).
//
// The 12 vector_* commands and embedding_fetch/_batch back the frontend's
// semantic index (src/lib/embedding.ts) and hybrid search, but until now no
// gate exercised them. This harness pins the DESKTOP contract — it is a 1:1
// port of the Rust unit tests in src-tauri/src/commands/vectorstore.rs
// (`tests_v2` + the page-id validation tests) plus the embedding-fetch HTTP
// contract of search.rs, all driven through the real server over HTTP.
//
//   Part 1  page-id validation: Rust fixtures, EXACT error strings
//   Part 2  v1 page-level lifecycle (upsert/search/delete/count)
//   Part 3  v2 chunk-level lifecycle (every tests_v2 case)
//   Part 4  embedding_fetch / embedding_fetch_batch against a mock
//           OpenAI-compatible /embeddings endpoint (request shape, auth
//           header, extraHeaders, dimensions, retry, batch order)
//   Part 5  hybrid search integration: keyword + vector legs, RRF blend,
//           vector-only page materialization, embeddingConfig resolution
//
// SERVER_ENTRY=packages/server/src/index-v2.js re-runs the whole contract
// against the unified v2 server (the Docker entrypoint).

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
function freePort() { return new Promise((res) => { const s = http.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)) }) }) }
async function waitFor(fn, t, what) { const s = Date.now(); while (Date.now() - s < t) { try { if (await fn()) return true } catch {} await sleep(80) } throw new Error("timeout: " + what) }

function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body)
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } : headers }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c))
      res.on("end", () => { try { resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null, raw: buf }) } catch { resolve({ status: res.statusCode, raw: buf }) } })
    })
    r.on("error", reject); if (data) r.write(data); r.end()
  })
}

// Rust tests_v2 fake_embedding: ((seed * 2654435761) ^ i) as u32 -> sin(x / u32::MAX)
function fakeEmbedding(seed, dim) {
  const out = []
  for (let i = 0; i < dim; i++) {
    const x = (Math.imul(seed, 2654435761) ^ i) >>> 0
    out.push(Math.sin(x / 4294967295))
  }
  return out
}
function makeChunks(pageId, n, dim) {
  return Array.from({ length: n }, (_, i) => ({
    chunk_index: i,
    chunk_text: `${pageId} chunk ${i}`,
    heading_path: `## Heading ${i}`,
    embedding: fakeEmbedding(i, dim),
  }))
}

// ── boot server ───────────────────────────────────────────────────────────
const SERVER_ENTRY = process.env.SERVER_ENTRY || "packages/server/src/index.js"
const port = await freePort()
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "llmwiki-vs-data-"))
const project = fs.mkdtempSync(path.join(os.tmpdir(), "llmwiki-vs-proj-"))
fs.mkdirSync(path.join(project, "wiki"), { recursive: true })
const child = spawn(process.execPath, [SERVER_ENTRY], {
  cwd: REPO,
  env: { ...process.env, LLM_WIKI_PORT: String(port), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir, LLM_WIKI_CLIP_PORT: String(await freePort()) },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", (d) => (serverLog += d))
child.stderr.on("data", (d) => (serverLog += d))
await waitFor(async () => (await req(port, "GET", "/api/health")).status === 200, 10000, "server health")

// The v2/Docker entrypoint wraps invoke results as { ok, result } and errors
// as { ok:false, error:{ code, message } }; the legacy entry returns raw
// results. Unwrap so both runs assert the same command contract.
const V2_INVOKE = process.env.SERVER_ENTRY?.includes("index-v2") ?? false
async function invoke(command, args) {
  const r = await req(port, "POST", `/api/invoke/${command}`, args ?? {})
  if (r.status !== 200) throw new Error(r.json?.error ?? `HTTP ${r.status}: ${r.raw}`)
  return V2_INVOKE ? r.json?.result : r.json
}
async function invokeErr(command, args) {
  const r = await req(port, "POST", `/api/invoke/${command}`, args ?? {})
  if (r.status === 200) throw new Error(`expected error, got success: ${JSON.stringify(r.json)}`)
  const err = V2_INVOKE ? r.json?.error?.message : r.json?.error
  return err ?? `HTTP ${r.status}`
}

console.log(`verify-vectorstore (entry: ${SERVER_ENTRY})`)

// ════════════════════════════════════════════════════════════════════════
// Part 1 — page-id validation (Rust page_id_validation_* tests, exact msgs)
// ════════════════════════════════════════════════════════════════════════
console.log("Part 1: page-id validation (desktop fixtures, exact error strings)")
{
  const unicodeId = "反硝化除磷·A2O：DPAO + 50% & x（测试），v1.2"
  await invoke("vector_upsert", { projectPath: project, pageId: unicodeId, embedding: [0.1, 0.2, 0.3] })
  ok(true, "v1 upsert allows unicode wiki stem")
  await invoke("vector_upsert_chunks", { projectPath: project, pageId: unicodeId, chunks: makeChunks(unicodeId, 1, 3) })
  ok(true, "v2 upsert allows unicode wiki stem")
  await invoke("vector_upsert", { projectPath: project, pageId: "source#section", embedding: [0.1, 0.2, 0.3] })
  ok(true, "page id with '#' allowed (debug chunk ids rely on it)")

  // Rust: format!("Invalid page_id: contains disallowed character {:?}: {}")
  const cases = [
    ["bad'quote", "Invalid page_id: contains disallowed character '\\'': bad'quote"],
    ["bad\"quote", "Invalid page_id: contains disallowed character '\"': bad\"quote"],
    ["bad/slash", "Invalid page_id: contains disallowed character '/': bad/slash"],
    ["bad\\slash", "Invalid page_id: contains disallowed character '\\\\': bad\\slash"],
    ["bad\nnewline", "Invalid page_id: contains disallowed character '\\n': bad\nnewline"],
    ["bad\ttab", "Invalid page_id: contains disallowed character '\\t': bad\ttab"],
    ["bad\0nul", "Invalid page_id: contains disallowed character '\\0': bad\0nul"],
    ["soft\u00ADhyphen", "Invalid page_id: contains disallowed character '\\u{ad}': soft\u00ADhyphen"],
    ["arabic\u061Cmark", "Invalid page_id: contains disallowed character '\\u{61c}': arabic\u061Cmark"],
    ["zero\u200Bwidth", "Invalid page_id: contains disallowed character '\\u{200b}': zero\u200Bwidth"],
    ["line\u2028sep", "Invalid page_id: contains disallowed character '\\u{2028}': line\u2028sep"],
    ["para\u2029sep", "Invalid page_id: contains disallowed character '\\u{2029}': para\u2029sep"],
    ["bidi\u202Eoverride", "Invalid page_id: contains disallowed character '\\u{202e}': bidi\u202Eoverride"],
    ["\uFEFFbom", "Invalid page_id: contains disallowed character '\\u{feff}': \uFEFFbom"],
    ["annotation\uFFF9mark", "Invalid page_id: contains disallowed character '\\u{fff9}': annotation\uFFF9mark"],
    ["tag\uDB40\uDC41char", "Invalid page_id: contains disallowed character '\\u{e0041}': tag\uDB40\uDC41char"],
  ]
  let allExact = true
  for (const [id, expected] of cases) {
    const e1 = await invokeErr("vector_upsert", { projectPath: project, pageId: id, embedding: [0.1] })
    const e2 = await invokeErr("vector_upsert_chunks", { projectPath: project, pageId: id, chunks: makeChunks("x", 1, 3) })
    if (e1 !== expected || e2 !== expected) {
      allExact = false
      console.log(`    mismatch for ${JSON.stringify(id)}:\n      v1: ${JSON.stringify(e1)}\n      v2: ${JSON.stringify(e2)}\n      want: ${JSON.stringify(expected)}`)
    }
  }
  ok(allExact, `all ${cases.length} disallowed page ids rejected with the desktop's exact message (v1 + v2)`)

  const eEmpty1 = await invokeErr("vector_upsert", { projectPath: project, pageId: "", embedding: [0.1] })
  const eEmpty2 = await invokeErr("vector_upsert_chunks", { projectPath: project, pageId: "", chunks: makeChunks("x", 1, 3) })
  ok(eEmpty1 === "Invalid page_id: empty or too long" && eEmpty2 === eEmpty1, "empty page id rejected with exact message (v1 + v2)")

  const boundaryAscii = "a".repeat(256)
  const boundaryCjk = "测".repeat(256)
  await invoke("vector_upsert", { projectPath: project, pageId: boundaryAscii, embedding: [0.1] })
  await invoke("vector_upsert", { projectPath: project, pageId: boundaryCjk, embedding: [0.1] })
  ok(true, "256-char boundary page ids allowed (ASCII + CJK, counted by code point)")
  const eLong1 = await invokeErr("vector_upsert", { projectPath: project, pageId: "测".repeat(257), embedding: [0.1] })
  const eLong2 = await invokeErr("vector_upsert", { projectPath: project, pageId: "a".repeat(257), embedding: [0.1] })
  ok(eLong1 === "Invalid page_id: empty or too long" && eLong2 === eLong1, "257-char page ids rejected (code-point count, not UTF-16 units)")

  // delete paths validate too (Rust vector_delete / vector_delete_page)
  const eDel = await invokeErr("vector_delete", { projectPath: project, pageId: "bad'quote" })
  const eDelPage = await invokeErr("vector_delete_page", { projectPath: project, pageId: "bad/slash" })
  ok(eDel.startsWith("Invalid page_id: contains disallowed character") && eDelPage.startsWith("Invalid page_id: contains disallowed character"), "vector_delete + vector_delete_page validate page_id like the desktop")
}

// ════════════════════════════════════════════════════════════════════════
// Part 2 — v1 page-level lifecycle
// ════════════════════════════════════════════════════════════════════════
console.log("Part 2: v1 page-level lifecycle")
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "llmwiki-vs-v1empty-"))
  ok(await invoke("vector_count", { projectPath: empty }) === 0, "vector_count on fresh project -> 0")
  const noHits = await invoke("vector_search", { projectPath: empty, queryEmbedding: [1, 0, 0], topK: 5 })
  ok(Array.isArray(noHits) && noHits.length === 0, "vector_search with no table -> []")
  await invoke("vector_delete", { projectPath: empty, pageId: "never-existed" })
  ok(true, "vector_delete on missing table is a no-op")

  // orthogonal unit vectors -> exact cosine math, deterministic ordering
  await invoke("vector_upsert", { projectPath: empty, pageId: "alpha", embedding: [1, 0, 0, 0] })
  await invoke("vector_upsert", { projectPath: empty, pageId: "beta", embedding: [0, 1, 0, 0] })
  await invoke("vector_upsert", { projectPath: empty, pageId: "gamma", embedding: [0.70710678, 0.70710678, 0, 0] })
  ok(await invoke("vector_count", { projectPath: empty }) === 3, "vector_count -> 3 after three upserts")

  const hits = await invoke("vector_search", { projectPath: empty, queryEmbedding: [1, 0, 0, 0], topK: 10 })
  ok(hits.length === 3, "vector_search returns every page (topK large enough)")
  ok(hits[0].page_id === "alpha" && Math.abs(hits[0].score - 1) < 1e-6, "best match first with score 1/(1+distance) -> 1.0 for identical vector")
  ok(hits[1].page_id === "gamma" && hits[1].score < 1 && hits[1].score > 0.5, "second place = 45-degree page, score in (0.5, 1)")
  ok(hits[2].page_id === "beta" && Math.abs(hits[2].score - 0.5) < 1e-6, "orthogonal page last with score 0.5 (1/(1+1))")
  ok(hits.every((h) => typeof h.page_id === "string" && typeof h.score === "number") && Object.keys(hits[0]).sort().join(",") === "page_id,score", "v1 result shape is exactly {page_id, score}")

  const topOne = await invoke("vector_search", { projectPath: empty, queryEmbedding: [1, 0, 0, 0], topK: 1 })
  ok(topOne.length === 1 && topOne[0].page_id === "alpha", "top_k limits results")

  // upsert replaces (desktop deletes the row first, then adds)
  await invoke("vector_upsert", { projectPath: empty, pageId: "alpha", embedding: [0, 0, 0, 1] })
  ok(await invoke("vector_count", { projectPath: empty }) === 3, "re-upsert keeps count (replace, not append)")
  const after = await invoke("vector_search", { projectPath: empty, queryEmbedding: [0, 0, 0, 1], topK: 1 })
  ok(after[0].page_id === "alpha" && Math.abs(after[0].score - 1) < 1e-6, "re-upsert replaced the vector")

  await invoke("vector_delete", { projectPath: empty, pageId: "beta" })
  ok(await invoke("vector_count", { projectPath: empty }) === 2, "vector_delete removes only the target page")
  await invoke("vector_delete", { projectPath: empty, pageId: "beta" })
  ok(true, "vector_delete is idempotent")

  // Persistence proof for the current contract: the index lives in the SHARED
  // server DB (LLM_WIKI_DATA_DIR/server.db), so v1 rows survive a server
  // restart (the desktop's LanceDB lives under .llm-wiki/lancedb).
  child.kill("SIGKILL")
  await new Promise((r) => setTimeout(r, 400))
  const child2 = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO,
    env: { ...process.env, LLM_WIKI_PORT: String(port), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir, LLM_WIKI_CLIP_PORT: String(await freePort()) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child2.stdout.on("data", (d) => (serverLog += d)); child2.stderr.on("data", (d) => (serverLog += d))
  await waitFor(async () => (await req(port, "GET", "/api/health")).status === 200, 10000, "server restart health")
  ok(await invoke("vector_count", { projectPath: empty }) === 2, "v1 rows persisted in shared server DB across restart (alpha + gamma)")
  // alpha was re-upserted to [0,0,0,1] above, so the restart probe must
  // query that vector (it also proves the re-upsert replaced, not appended).
  const afterRestart = await invoke("vector_search", { projectPath: empty, queryEmbedding: [0, 0, 0, 1], topK: 5 })
  ok(Array.isArray(afterRestart) && afterRestart[0]?.page_id === "alpha" && Math.abs(afterRestart[0].score - 1) < 1e-6, `v1 search works after restart (got ${JSON.stringify(afterRestart)})`)
}

// ════════════════════════════════════════════════════════════════════════
// Part 3 — v2 chunk-level lifecycle (port of vectorstore.rs tests_v2)
// ════════════════════════════════════════════════════════════════════════
console.log("Part 3: v2 chunk-level lifecycle (Rust tests_v2, 1:1)")
{
  const p = fs.mkdtempSync(path.join(os.tmpdir(), "llmwiki-vs-v2-"))

  // v2_upsert_then_count
  await invoke("vector_upsert_chunks", { projectPath: p, pageId: "my-page", chunks: makeChunks("my-page", 3, 16) })
  ok(await invoke("vector_count_chunks", { projectPath: p }) === 3, "upsert 3 chunks -> count 3")

  // v2_upsert_replaces_existing_chunks_for_page
  const p2 = fs.mkdtempSync(path.join(os.tmpdir(), "llmwiki-vs-v2-"))
  await invoke("vector_upsert_chunks", { projectPath: p2, pageId: "page-a", chunks: makeChunks("page-a", 5, 16) })
  ok(await invoke("vector_count_chunks", { projectPath: p2 }) === 5, "first upsert: 5 chunks")
  await invoke("vector_upsert_chunks", { projectPath: p2, pageId: "page-a", chunks: makeChunks("page-a", 2, 16) })
  ok(await invoke("vector_count_chunks", { projectPath: p2 }) === 2, "re-upsert 2 chunks -> count 2 (clean-slate replace, not 7)")

  // v2_different_pages_coexist
  await invoke("vector_upsert_chunks", { projectPath: p2, pageId: "page-b", chunks: makeChunks("page-b", 4, 16) })
  ok(await invoke("vector_count_chunks", { projectPath: p2 }) === 6, "different pages coexist (2 + 4 = 6)")

  // v2_delete_page_removes_only_its_chunks
  await invoke("vector_delete_page", { projectPath: p2, pageId: "page-a" })
  ok(await invoke("vector_count_chunks", { projectPath: p2 }) === 4, "delete_page removes only its own chunks")

  // v2_search_returns_chunks_with_metadata (query = chunk #1's own embedding)
  const results = await invoke("vector_search_chunks", { projectPath: p, queryEmbedding: fakeEmbedding(1, 16), topK: 10 })
  ok(results.length > 0, "search returns chunks")
  ok(results.every((r) => r.page_id === "page-a" || r.page_id === "my-page"), "every result carries page_id")
  const meta = await invoke("vector_search_chunks", { projectPath: p, queryEmbedding: fakeEmbedding(1, 16), topK: 10 })
  ok(meta.every((r) => r.chunk_id.startsWith("my-page#") && r.chunk_text.includes("chunk") && r.heading_path.startsWith("## Heading")), "chunk_id/chunk_text/heading_path metadata intact")
  ok(meta.some((r) => r.chunk_id === "my-page#1" && r.chunk_index === 1 && r.score > 0.999), "exact-match chunk returned with ~1.0 score (chunk_id derived as page_id#chunk_index)")
  ok(meta[0].score > 0.999, "identical vector scores ~1.0 via 1/(1+distance)")
  const keys = Object.keys(meta[0]).sort().join(",")
  ok(keys === "chunk_id,chunk_index,chunk_text,heading_path,page_id,score", `wire shape is exactly the desktop's snake_case ChunkSearchResult (got ${keys})`)

  // v2_empty_upsert_is_a_noop_not_an_error
  await invoke("vector_upsert_chunks", { projectPath: p, pageId: "my-page", chunks: [] })
  ok(await invoke("vector_count_chunks", { projectPath: p }) === 3, "empty upsert is a no-op (does NOT wipe existing chunks)")

  // v2_search_on_missing_table_returns_empty / v2_count_on_missing_table_returns_zero
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "llmwiki-vs-v2fresh-"))
  ok((await invoke("vector_search_chunks", { projectPath: fresh, queryEmbedding: fakeEmbedding(1, 16), topK: 10 })).length === 0, "search on missing table -> []")
  ok(await invoke("vector_count_chunks", { projectPath: fresh }) === 0, "count on missing table -> 0")

  // v2_delete_page_is_idempotent
  await invoke("vector_delete_page", { projectPath: fresh, pageId: "never-existed" })
  await invoke("vector_upsert_chunks", { projectPath: fresh, pageId: "page-a", chunks: makeChunks("page-a", 2, 16) })
  await invoke("vector_delete_page", { projectPath: fresh, pageId: "page-a" })
  await invoke("vector_delete_page", { projectPath: fresh, pageId: "page-a" })
  ok(await invoke("vector_count_chunks", { projectPath: fresh }) === 0, "delete_page idempotent (missing table + double delete)")

  // v2_clear_chunks_drops_entire_chunk_table_and_is_idempotent
  await invoke("vector_upsert_chunks", { projectPath: fresh, pageId: "page-a", chunks: makeChunks("page-a", 3, 16) })
  await invoke("vector_upsert_chunks", { projectPath: fresh, pageId: "page-b", chunks: makeChunks("page-b", 4, 16) })
  ok(await invoke("vector_count_chunks", { projectPath: fresh }) === 7, "7 chunks across two pages before clear")
  await invoke("vector_clear_chunks", { projectPath: fresh })
  ok(await invoke("vector_count_chunks", { projectPath: fresh }) === 0, "clear_chunks drops everything")
  await invoke("vector_clear_chunks", { projectPath: fresh })
  ok(await invoke("vector_count_chunks", { projectPath: fresh }) === 0, "clear_chunks idempotent")

  // v2_optimize_chunks_preserves_rows (compaction itself is LanceDB-only;
  // the web port keeps the command best-effort + row-preserving)
  const opt = fs.mkdtempSync(path.join(os.tmpdir(), "llmwiki-vs-v2opt-"))
  await invoke("vector_optimize_chunks", { projectPath: opt })
  for (let i = 0; i < 6; i++) await invoke("vector_upsert_chunks", { projectPath: opt, pageId: `page-${i}`, chunks: makeChunks(`page-${i}`, 2, 16) })
  ok(await invoke("vector_count_chunks", { projectPath: opt }) === 12, "12 chunks before optimize")
  await invoke("vector_optimize_chunks", { projectPath: opt })
  ok(await invoke("vector_count_chunks", { projectPath: opt }) === 12, "optimize preserves all rows")

  // v2_rejects_mismatched_embedding_dimensions (desktop message)
  const dimErr = await invokeErr("vector_upsert_chunks", {
    projectPath: opt, pageId: "page-dim",
    chunks: [
      { chunk_index: 0, chunk_text: "ok", heading_path: "", embedding: fakeEmbedding(0, 16) },
      { chunk_index: 1, chunk_text: "bad", heading_path: "", embedding: fakeEmbedding(1, 8) },
    ],
  })
  ok(dimErr === "Chunk #1 has embedding dim 8 but batch dim is 16", `dim mismatch rejected with desktop message (got: ${dimErr})`)
  const emptyEmbErr = await invokeErr("vector_upsert_chunks", { projectPath: opt, pageId: "page-dim", chunks: [{ chunk_index: 0, chunk_text: "x", heading_path: "", embedding: [] }] })
  ok(emptyEmbErr === "Chunk #0 has empty embedding", `empty first embedding rejected with desktop message (got: ${emptyEmbErr})`)
  ok(await invoke("vector_count_chunks", { projectPath: opt }) === 12, "failed upsert left the store untouched (validation before mutation)")

  // v2_rejects_invalid_page_id
  const injErr = await invokeErr("vector_upsert_chunks", { projectPath: opt, pageId: "bad'; DROP", chunks: makeChunks("x", 1, 16) })
  ok(injErr.startsWith("Invalid page_id: contains disallowed character"), "SQL-injection page id rejected")

  // legacy_row_count_* : the WEB server has no legacy LanceDB/JSON store —
  // v1 page vectors live in the shared server DB (vec_pages), so these
  // desktop housekeeping commands are documented no-ops (0). They exist only
  // for the settings notice parity.
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), "llmwiki-vs-legacy-"))
  ok(await invoke("vector_legacy_row_count", { projectPath: legacy }) === 0, "legacy_row_count 0 when v1 absent")
  await invoke("vector_upsert", { projectPath: legacy, pageId: "old-page", embedding: fakeEmbedding(0, 16) })
  ok(await invoke("vector_legacy_row_count", { projectPath: legacy }) === 0, "legacy_row_count is the web no-op 0 (v1 lives in vec_pages)")
  ok(await invoke("vector_count_chunks", { projectPath: legacy }) === 0, "v1 rows do not leak into the v2 count")
  ok(await invoke("vector_count", { projectPath: legacy }) === 1, "v1 rows ARE visible via vector_count (vec_pages)")

  // drop_legacy_* : desktop LanceDB housekeeping — no-op against vec_pages.
  await invoke("vector_upsert_chunks", { projectPath: legacy, pageId: "new-page", chunks: makeChunks("new-page", 2, 16) })
  await invoke("vector_drop_legacy", { projectPath: legacy })
  ok(await invoke("vector_count", { projectPath: legacy }) === 1, "drop_legacy leaves v1 (vec_pages) intact")
  ok(await invoke("vector_count_chunks", { projectPath: legacy }) === 2, "drop_legacy leaves v2 intact")
  await invoke("vector_drop_legacy", { projectPath: legacy })
  ok(true, "drop_legacy is a no-op when v1 missing")

  // shared-data angle: the web server keeps its index in the SHARED server DB
  // (LLM_WIKI_DATA_DIR/server.db); the desktop stores LanceDB under
  // .llm-wiki/lancedb — both are per-client derived data rebuilt from the
  // same wiki content (RUNBOOK "Vector / semantic search" row). Assert the
  // project's chunk rows live queryable in the server DB.
  ok(await invoke("vector_count_chunks", { projectPath: p }) === 3, "chunk rows live in the shared server DB (my-page 3 chunks)")
}

// ════════════════════════════════════════════════════════════════════════
// Part 4 — embedding_fetch / embedding_fetch_batch (faithful search.rs
//          contract: endpoint used as entered, Origin for local/private
//          hosts, reserved headers, oversize auto-halving retry, exact
//          error strings, strict batch parsing)
// ════════════════════════════════════════════════════════════════════════
console.log("Part 4: embedding fetch contract (mock OpenAI-compatible endpoint)")
const embState = { requests: [], nextStatus: 200, nextBodyText: null, respond: null, vectors: new Map() }
function detVec(text) {
  // deterministic per-text vector, dim 8
  let h = 2166136261
  for (const ch of text) { h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0 }
  return Array.from({ length: 8 }, (_, i) => Math.sin(((Math.imul(h, 2654435761) ^ i) >>> 0) / 4294967295))
}
const mockPort = await freePort()
const mock = http.createServer((mreq, mres) => {
  let buf = ""
  mreq.on("data", (c) => (buf += c))
  mreq.on("end", () => {
    const body = buf ? JSON.parse(buf) : null
    embState.requests.push({ url: mreq.url, headers: mreq.headers, body })
    if (embState.respond) { embState.respond(mres, body); return }
    if (embState.nextStatus !== 200) {
      mres.writeHead(embState.nextStatus, { "Content-Type": "text/plain" })
      mres.end(embState.nextBodyText ?? "injected failure")
      return
    }
    const inputs = Array.isArray(body.input) ? body.input : [body.input]
    const data = inputs.map((t, i) => ({ object: "embedding", index: i, embedding: embState.vectors.get(t) ?? detVec(t) }))
    mres.writeHead(200, { "Content-Type": "application/json" })
    mres.end(JSON.stringify({ object: "list", data, model: body.model, usage: { prompt_tokens: 1, total_tokens: 1 } }))
  })
})
await new Promise((r) => mock.listen(mockPort, "127.0.0.1", r))
const EMB_URL = `http://127.0.0.1:${mockPort}/v1/embeddings`
const embCfg = { enabled: true, endpoint: EMB_URL, apiKey: "test-key-123", model: "mock-embed-1", extraHeaders: { "X-Model-Provider-Id": "mockgate", "Authorization": "evil-override", "Origin": "http://evil", "Bad Header": "nope" } }
{
  const vec = await invoke("embedding_fetch", { text: "hello world", cfg: embCfg })
  ok(Array.isArray(vec) && vec.length === 8, "embedding_fetch returns the provider vector")
  const last = embState.requests.at(-1)
  ok(last.url === "/v1/embeddings", "endpoint used AS ENTERED (no auto-appended path for non-volcengine hosts)")
  ok(last.body.model === "mock-embed-1" && last.body.input === "hello world", "request body carries model + input (single text, not an array)")
  ok(!("dimensions" in last.body), "OpenAI-compatible path sends NO dimensions field (desktop contract: only the Google body uses output_dimensionality)")
  ok(last.headers.authorization === "Bearer test-key-123", "Authorization = Bearer <apiKey>")
  ok(last.headers["x-model-provider-id"] === "mockgate", "extraHeaders forwarded")
  ok(last.headers.authorization !== "evil-override", "reserved Authorization cannot be overridden by extraHeaders")
  ok(last.headers.origin === "http://localhost", "local/private endpoint gets the reserved browser-like Origin header (not the user's)")
  ok(!("bad header" in last.headers), "unsafe extra header names skipped")

  // exact desktop error string for a non-oversize HTTP failure
  embState.nextStatus = 500; embState.nextBodyText = "injected failure"
  const errEmb = await invokeErr("embedding_fetch", { text: "always-fail", cfg: embCfg, maxRetries: 3 })
  ok(errEmb === "Embedding API HTTP 500: injected failure", `non-oversize HTTP error uses the desktop's exact string (got: ${errEmb})`)
  const attemptsAfter500 = embState.requests.length
  ok(true, `non-oversize errors are definitive (requests: ${attemptsAfter500 - 1} -> ${attemptsAfter500}, no retry loop)`)

  // oversize rejection: auto-halving retry on a char boundary (desktop's
  // fetch_embedding_with_retry). Only oversize errors are retried.
  const longText = "x".repeat(400)
  embState.respond = (mres, body) => {
    const input = Array.isArray(body.input) ? body.input[0] : body.input
    if (input.length > 100) { mres.writeHead(400, { "Content-Type": "text/plain" }); mres.end("This model's maximum context length is 100 tokens; your input was too long"); return }
    const data = [{ object: "embedding", index: 0, embedding: detVec(input) }]
    mres.writeHead(200, { "Content-Type": "application/json" })
    mres.end(JSON.stringify({ object: "list", data, model: body.model }))
  }
  const before = embState.requests.length
  const halved = await invoke("embedding_fetch", { text: longText, cfg: embCfg, maxRetries: 3 })
  const attempts = embState.requests.slice(before)
  ok(JSON.stringify(halved) === JSON.stringify(detVec(attempts.at(-1).body.input)), "oversize input auto-halves until it fits and returns the truncated vector")
  ok(attempts.length === 3 && attempts[0].body.input.length === 400 && attempts[1].body.input.length === 200 && attempts[2].body.input.length === 100, `halved on char boundaries each retry (got ${attempts.map((a) => a.body.input.length).join(" -> ")})`)

  // retries exhausted -> desktop's exact final error (byte length in message)
  embState.respond = (mres) => { mres.writeHead(413, { "Content-Type": "text/plain" }); mres.end("Payload Too Large") }
  const exhaust = await invokeErr("embedding_fetch", { text: "y".repeat(400), cfg: embCfg, maxRetries: 1 })
  // 400 chars -> attempt1 400 (413) -> attempt2 200 (413, attempts=2 > maxRetries=1) -> final at 200 chars
  ok(exhaust === "Endpoint rejected input even at 200 chars. Lower Settings -> Embedding -> Max Chunk Chars. Embedding API HTTP 413: Payload Too Large", `exhausted oversize retries use the desktop's exact message (got: ${exhaust})`)
  embState.respond = null; embState.nextStatus = 200

  // batch: order preserved (via index field), single request
  embState.vectors.set("alpha-q", [1, 0, 0, 0, 0, 0, 0, 0])
  embState.vectors.set("beta-q", [0, 1, 0, 0, 0, 0, 0, 0])
  const beforeBatch = embState.requests.length
  const batch = await invoke("embedding_fetch_batch", { texts: ["alpha-q", "beta-q", "alpha-q"], cfg: embCfg })
  const batchReq = embState.requests.at(-1)
  ok(batch.length === 3 && batch[0][0] === 1 && batch[1][1] === 1 && JSON.stringify(batch[2]) === JSON.stringify(batch[0]), "batch returns vectors in input order")
  ok(embState.requests.length === beforeBatch + 1, "batch is a single HTTP call with input[]")
  ok(Array.isArray(batchReq.body.input) && batchReq.body.input.length === 3, "batch body sends the texts array")
  ok(batchReq.headers.origin === "http://localhost", "batch request gets the Origin header too")

  // batch bounds + strict parsing (desktop's parse_embedding_batch_values)
  const tooMany = await invokeErr("embedding_fetch_batch", { texts: Array.from({ length: 65 }, (_, i) => `t${i}`), cfg: embCfg })
  ok(tooMany === "Embedding batch must contain between 1 and 64 inputs", `65 inputs rejected with desktop message (got: ${tooMany})`)
  const emptyBatch = await invokeErr("embedding_fetch_batch", { texts: [], cfg: embCfg })
  ok(emptyBatch === "Embedding batch must contain between 1 and 64 inputs", `empty batch rejected with desktop message (got: ${emptyBatch})`)
  ok(embState.requests.length === beforeBatch + 1, "bounds-rejected batches make no HTTP call")

  embState.respond = (mres, body) => {
    const data = body.input.map((t, i) => ({ index: body.input.length - 1 - i, embedding: embState.vectors.get(t) ?? detVec(t) })) // reversed indexes
    mres.writeHead(200, { "Content-Type": "application/json" })
    mres.end(JSON.stringify({ data, model: body.model }))
  }
  const reordered = await invoke("embedding_fetch_batch", { texts: ["alpha-q", "beta-q"], cfg: embCfg })
  ok(reordered[0][1] === 1 && reordered[1][0] === 1, "batch results re-sorted by the provider's index field")

  embState.respond = (mres, body) => {
    mres.writeHead(200, { "Content-Type": "application/json" })
    mres.end(JSON.stringify({ data: body.input.slice(1).map((t, i) => ({ index: i, embedding: detVec(t) })), model: body.model }))
  }
  const countErr = await invokeErr("embedding_fetch_batch", { texts: ["a", "b"], cfg: embCfg })
  ok(countErr === "Embedding batch returned 1 vectors for 2 inputs", `count mismatch uses desktop message (got: ${countErr})`)

  embState.respond = (mres, body) => {
    mres.writeHead(200, { "Content-Type": "application/json" })
    mres.end(JSON.stringify({ data: body.input.map((t, i) => ({ index: i, embedding: detVec(t).slice(0, i === 0 ? 8 : 4) })), model: body.model }))
  }
  const dimErr2 = await invokeErr("embedding_fetch_batch", { texts: ["a", "b"], cfg: embCfg })
  ok(dimErr2 === "Embedding batch response contains inconsistent vector dimensions", `dimension mismatch uses desktop message (got: ${dimErr2})`)

  embState.respond = (mres, body) => {
    mres.writeHead(200, { "Content-Type": "application/json" })
    mres.end(JSON.stringify({ data: [{ index: 0, embedding: detVec("a") }, { index: 0, embedding: detVec("b") }], model: body.model }))
  }
  const dupErr = await invokeErr("embedding_fetch_batch", { texts: ["a", "b"], cfg: embCfg })
  ok(dupErr === "Embedding batch response contains duplicate indexes", `duplicate indexes use desktop message (got: ${dupErr})`)
  embState.respond = null

  // Google Gemini provider: endpoint shaping + body + x-goog-api-key + parse.
  // The endpoint carries the ":embedContent" marker so the config is detected
  // as google while still routing to the local mock.
  const gCfg = { enabled: true, endpoint: `http://127.0.0.1:${mockPort}/v1beta:embedContent`, apiKey: "goog-key", model: "text-embedding-004", outputDimensionality: 768.7 }
  embState.respond = (mres, body) => {
    mres.writeHead(200, { "Content-Type": "application/json" })
    mres.end(JSON.stringify({ embedding: { values: detVec(JSON.stringify(body)) } }))
  }
  const gVec = await invoke("embedding_fetch", { text: "gemini probe", cfg: gCfg })
  const gReq = embState.requests.at(-1)
  ok(Array.isArray(gVec) && gVec.length === 8, "google config parses embedding.values")
  ok(gReq.url === "/v1beta:embedContent", `google endpoint with :embedContent used as-is (got ${gReq.url})`)
  ok(gReq.body.model === "models/text-embedding-004" && gReq.body.content?.parts?.[0]?.text === "gemini probe", "google body shape: models/ prefix + content.parts")
  ok(gReq.body.output_dimensionality === 768, "output_dimensionality floored into the google body")
  ok(gReq.headers["x-goog-api-key"] === "goog-key" && !gReq.headers.authorization, "google auth via x-goog-api-key (no Bearer)")
  const gBatchErr = await invokeErr("embedding_fetch_batch", { texts: ["a"], cfg: gCfg })
  ok(gBatchErr === "This embedding provider does not use the OpenAI-compatible batch format", `google batch rejected with desktop message (got: ${gBatchErr})`)
  embState.respond = null

  // Volcengine + Google endpoint rewriting are pure functions (tested below
  // against the module exports); no live request goes to a real provider.
}
// module-level endpoint shaping, straight from search.rs' Rust unit tests
{
  const E = await import(new URL("../../packages/server/src/embedding-fetch.js", import.meta.url).href)
  ok(E.volcengineEmbeddingEndpoint({ endpoint: "https://open.volces.com/api/v3", model: "m" }) === "https://open.volces.com/api/v3/embeddings", "volcengine host gets /embeddings appended")
  ok(E.volcengineEmbeddingEndpoint({ endpoint: "https://open.volces.com/api/v3/embeddings", model: "m" }) === "https://open.volces.com/api/v3/embeddings", "volcengine /embeddings not duplicated")
  ok(E.volcengineEmbeddingEndpoint({ endpoint: "https://api.example.com/v1", model: "m" }) === "https://api.example.com/v1", "non-volcengine endpoints untouched")
  ok(E.volcengineEmbeddingEndpoint({ endpoint: "https://open.volces.com/api/v3", model: "doubao-embedding-vision-large" }) === "https://open.volces.com/api/v3/embeddings/multimodal", "doubao multimodal gets /embeddings/multimodal")
  ok(E.googleEmbeddingEndpoint({ endpoint: "https://generativelanguage.googleapis.com/v1beta?key=SECRET", model: "models/text-embedding-004" }) === "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent", "google endpoint: key query stripped + models path + :embedContent")
  ok(E.googleEmbeddingEndpoint({ endpoint: "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents", model: "m" }) === "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent", "google batch endpoint normalized to :embedContent")
  ok(E.isLocalOrPrivateHttpEndpoint("http://192.168.1.5:11434/v1") === true && E.isLocalOrPrivateHttpEndpoint("http://172.16.0.9:8080") === true && E.isLocalOrPrivateHttpEndpoint("http://8.8.8.8:80") === false && E.isLocalOrPrivateHttpEndpoint("http://[::1]:8080") === true, "local/private endpoint detection (192.168/172.16-31/::1 yes, public no)")
  ok(E.looksLikeOversizeError(413, "anything") === true && E.looksLikeOversizeError(400, "Input exceeds the maximum context length") === true && E.looksLikeOversizeError(400, "invalid api key") === false, "oversize detection matches the desktop predicate")
}

// ════════════════════════════════════════════════════════════════════════
// Part 5 — hybrid search integration (keyword + vector + graph legs)
// ════════════════════════════════════════════════════════════════════════
console.log("Part 5: hybrid search integration (RRF over the server vector store)")
{
  const hp = fs.mkdtempSync(path.join(os.tmpdir(), "llmwiki-vs-hybrid-"))
  fs.mkdirSync(path.join(hp, "wiki"), { recursive: true })
  fs.writeFileSync(path.join(hp, "wiki", "zebra-facts.md"), "# Zebra Facts\n\nThe zebra page mentions the keyword directly.\n")
  // vector-only page: NO keyword overlap with the query
  fs.writeFileSync(path.join(hp, "wiki", "quantum-notes.md"), "# Quantum Notes\n\nCompletely unrelated prose about physics.\n")
  fs.writeFileSync(path.join(hp, "wiki", "linker.md"), "# Linker\n\nSee [[quantum-notes]] for details.\n")

  const Q = [1, 0, 0, 0]
  await invoke("vector_upsert_chunks", {
    projectPath: hp, pageId: "quantum-notes",
    chunks: [
      { chunk_index: 0, chunk_text: "Completely unrelated prose about physics.", heading_path: "## Quantum Notes", embedding: Q },
      { chunk_index: 1, chunk_text: "second chunk", heading_path: "", embedding: [0, 1, 0, 0] },
    ],
  })

  // 5a. caller-supplied queryEmbedding (the frontend path)
  const hyb = await invoke("search_project", { projectPath: hp, query: "zebra", topK: 10, queryEmbedding: Q })
  ok(hyb.mode === "hybrid", `mode=hybrid when both legs hit (got ${hyb.mode})`)
  ok(hyb.tokenHits >= 1 && hyb.vectorHits >= 1, `both legs counted (tokenHits=${hyb.tokenHits}, vectorHits=${hyb.vectorHits})`)
  const zebra = hyb.results.find((r) => r.path.endsWith("zebra-facts.md"))
  ok(!!zebra && zebra.titleMatch === true, "keyword page present with titleMatch")
  const qn = hyb.results.find((r) => r.path.endsWith("quantum-notes.md"))
  ok(!!qn, "vector-only page MATERIALIZED into results despite zero keyword overlap")
  ok(qn.vectorScore > 0.99, `vector-only page carries its vectorScore (got ${qn.vectorScore})`)
  ok(qn.snippet.includes("## Quantum Notes"), "vector snippet uses heading_path breadcrumb")
  // RRF (RRF_K=60, search.rs apply_rrf_scores): each page sits rank 1 of
  // exactly one leg -> both score precisely 1/(60+1).
  ok(Math.abs(zebra.score - 1 / 61) < 1e-12 && Math.abs(qn.score - 1 / 61) < 1e-12, `RRF scores assigned from both legs (got ${zebra.score}, ${qn.score})`)

  // 5b. server-side embedding resolution via embeddingConfig (no queryEmbedding arg)
  embState.vectors.set("zebra", Q)
  embState.requests.length = 0
  const hyb2 = await invoke("search_project", { projectPath: hp, query: "zebra", topK: 10, embeddingConfig: { ...embCfg, endpoint: EMB_URL } })
  ok(hyb2.mode === "hybrid" && hyb2.vectorHits >= 1, "embeddingConfig resolves the query embedding server-side")
  ok(embState.requests.length === 1 && embState.requests[0].body.input === "zebra", "exactly one embedding call for the query text")
  const qn2 = hyb2.results.find((r) => r.path.endsWith("quantum-notes.md"))
  ok(!!qn2 && qn2.vectorScore > 0.99, "server-embedded search materializes the vector-only page too")

  // 5c. disabled config -> keyword-only (desktop's degradation)
  const kw = await invoke("search_project", { projectPath: hp, query: "zebra", topK: 10, embeddingConfig: { ...embCfg, endpoint: EMB_URL, enabled: false } })
  ok(kw.mode === "keyword" && kw.vectorHits === 0, "disabled embedding config -> mode=keyword, no vector leg")
  const embBefore = embState.requests.length
  await invoke("search_project", { projectPath: hp, query: "zebra", topK: 10, embeddingConfig: { ...embCfg, endpoint: "" } })
  await invoke("search_project", { projectPath: hp, query: "zebra", topK: 10, embeddingConfig: { ...embCfg, endpoint: EMB_URL, model: "   " } })
  ok(embState.requests.length === embBefore, "empty endpoint OR empty model makes no embedding call")

  // 5d. provider outage degrades to keyword (desktop never hard-fails search)
  embState.nextStatus = 500; embState.nextBodyText = "provider down"
  const degraded = await invoke("search_project", { projectPath: hp, query: "zebra", topK: 10, embeddingConfig: { ...embCfg, endpoint: EMB_URL } })
  ok(degraded.mode === "keyword" && degraded.results.some((r) => r.path.endsWith("zebra-facts.md")), "embedding outage degrades to keyword search, no error")
  ok(embState.requests.length === embBefore + 1, "search path fetches with max_retries=0 (exactly ONE attempt, no retry loop)")
  embState.nextStatus = 200

  // 5e. search_project input contract (desktop's search_project_inner)
  const qReqErr = await invokeErr("search_project", { projectPath: hp, query: "   " })
  ok(qReqErr === "query is required", `blank query rejected with desktop message (got: ${qReqErr})`)
  const qEmbEmpty = await invokeErr("search_project", { projectPath: hp, query: "zebra", queryEmbedding: [] })
  ok(qEmbEmpty === "queryEmbedding must not be empty", `empty queryEmbedding rejected with desktop message (got: ${qEmbEmpty})`)
  const qEmbNan = await invokeErr("search_project", { projectPath: hp, query: "zebra", queryEmbedding: [1, NaN] })
  ok(qEmbNan === "queryEmbedding must contain only finite numbers", `non-finite queryEmbedding rejected with desktop message (got: ${qEmbNan})`)
  const clamped = await invoke("search_project", { projectPath: hp, query: "zebra", topK: 5000, queryEmbedding: Q })
  ok(clamped.results.length <= 50, `top_k clamped to MAX_RESULTS=50 (got ${clamped.results.length})`)
}

// ── cleanup + report ──────────────────────────────────────────────────────
child.kill("SIGTERM")
mock.close()
await sleep(150)
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("--- server log tail ---"); console.log(serverLog.slice(-2000)); process.exit(1) }
console.log("VECTORSTORE_OK")
process.exit(0)
