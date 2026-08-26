import fs from "node:fs"
import path from "node:path"
import { getDb, isVecAvailable } from "../store/db.js"

// SQLite-backed vector store (issue #14 gap). Replaces the former
// vectorstore.json file store: chunk embeddings live in a sqlite-vec vec0
// virtual table (cosine distance) in the server database, keyed by a stable
// project id. Same invoke contract and score transform as before —
// score = 1 / (1 + distance) — so RRF blending downstream is unchanged.
//
// Graceful degradation: on platforms where the sqlite-vec extension cannot
// load (no prebuilt binary), writes no-op with a warning and searches return
// empty results; callers fall back to keyword retrieval. Requests never fail.
//
// The vec0 table is created lazily (not in a numbered migration) because its
// embedding column type — FLOAT[dim] — depends on the configured embedding
// provider's dimensionality. If the provider changes dimension, the table is
// dropped and recreated; embeddings are regenerated on the next ingest.

const fwd = (p) => p.split(path.sep).join("/")

// ── project identity ──────────────────────────────────────────────────────
// Stable project key: the UUID persisted in .llm-wiki/project.json, falling
// back to the normalized path for directories that lack one.
//
// Cache discipline: a UUID resolution is stable and cached; a path fallback is
// NOT trusted across calls — .llm-wiki/project.json may appear later (the
// client's ensureProjectId writes it on first open), and caching the fallback
// would strand already-written rows under the path key forever. When the
// identity flips from path to UUID, rows stored under the old path key are
// unreachable — drop them best-effort so the shared table can't accumulate
// orphans.
const projectKeyCache = new Map() // pathKey -> { key, fromFile }
function projectKey(projectPath) {
  const pathKey = fwd(projectPath)
  const cached = projectKeyCache.get(pathKey)
  if (cached && cached.fromFile) return cached.key
  let fileKey = null
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(projectPath, ".llm-wiki", "project.json"), "utf-8"))
    if (meta && typeof meta.id === "string" && meta.id.length > 0) fileKey = meta.id
  } catch { /* no project.json → path key */ }
  if (fileKey) {
    if (cached && cached.key !== fileKey) {
      try {
        if (isVecAvailable()) {
          const db = getDb()
          if (vecTableExists(db)) {
            db.prepare(`DELETE FROM vec_chunks WHERE project_id = ?`).run(cached.key)
          }
        }
      } catch { /* cleanup must never break key resolution */ }
    }
    projectKeyCache.set(pathKey, { key: fileKey, fromFile: true })
    return fileKey
  }
  projectKeyCache.set(pathKey, { key: pathKey, fromFile: false })
  return pathKey
}

const MAX_PAGE_ID_CHARS = 256

// Rust's char::is_control() is Unicode general category Cc: the C0 controls
// U+0000–U+001F plus the C1 controls U+007F–U+009F.
function isControlCharCode(cp) {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)
}

// 1:1 port of vectorstore.rs's is_disallowed_page_id_char(c: char). The Rust
// side rejects quotes/separators (interpolated into LanceDB filters and debug
// chunk ids) and every format/invisible character, so visually identical ids
// cannot differ only by soft hyphen, zero-width, bidi, tag, or separator
// characters.
function isDisallowedPageIdChar(ch) {
  const cp = ch.codePointAt(0)
  if (isControlCharCode(cp)) return true
  return (
    cp === 0x2f /* / */ || cp === 0x5c /* \\ */ ||
    cp === 0x27 /* ' */ || cp === 0x22 /* " */ ||
    cp === 0x00ad /* soft hyphen */ || cp === 0x061c /* arabic letter mark */ ||
    (cp >= 0x200b && cp <= 0x200f) || /* zero-width space / ZWNJ / ZWJ / LRM / RLM */
    (cp >= 0x2028 && cp <= 0x202e) || /* line/para separator + bidi */
    (cp >= 0x2060 && cp <= 0x206f) || /* word joiner + invisible operators */
    cp === 0xfeff /* BOM */ ||
    (cp >= 0xfff9 && cp <= 0xfffb) || /* interlinear annotations */
    (cp >= 0xe0000 && cp <= 0xe007f) /* tags */
  )
}

// Rust's `{:?}` for a char, as used in the disallowed-character error message:
// printable ASCII renders quoted ('/'), quotes/backslash and named control
// escapes render escaped, everything else renders as '\u{<lowercase hex>}'
// (char::escape_debug — only these categories can reach this branch, so the
// mapping is exhaustive enough for the contract).
function rustCharDebug(ch) {
  if (ch === "'") return "'\\''"
  if (ch === "\\") return "'\\\\'"
  if (ch === "\0") return "'\\0'"
  if (ch === "\n") return "'\\n'"
  if (ch === "\r") return "'\\r'"
  if (ch === "\t") return "'\\t'"
  const cp = ch.codePointAt(0)
  if (cp >= 0x20 && cp <= 0x7e) return `'${ch}'`
  return `'\\u{${cp.toString(16)}}'`
}

// Rust's validate_page_id_common: rejects empty ids and ids over
// MAX_PAGE_ID_CHARS characters (counting Unicode scalar values — one char per
// code point, not per UTF-16 code unit), then any disallowed character.
function validatePageId(pageId) {
  if (!pageId || typeof pageId !== "string" || pageId.length === 0) {
    throw new Error("Invalid page_id: empty or too long")
  }
  let charCount = 0
  for (const ch of pageId) {
    charCount += 1
    if (charCount > MAX_PAGE_ID_CHARS) {
      throw new Error("Invalid page_id: empty or too long")
    }
    if (isDisallowedPageIdChar(ch)) {
      throw new Error(`Invalid page_id: contains disallowed character ${rustCharDebug(ch)}: ${pageId}`)
    }
  }
}

function validateVector(v) {
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new Error("Invalid embedding: expected non-empty array of finite numbers")
  }
}

// ── vec0 table management ─────────────────────────────────────────────────
let vecTableDim = 0 // dim the live vec_chunks table was created for (0 = none)

function vecTableExists(db) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE name = 'vec_chunks'`).get()
}

/**
 * Ensure the vec0 table exists for the given embedding dimension. Drops and
 * recreates it when the dimension changes (provider switch). Returns false
 * when sqlite-vec is unavailable.
 */
function ensureVecTable(dim) {
  if (!isVecAvailable()) return false
  if (vecTableDim === dim) return true
  const db = getDb()
  const meta = db.prepare(`SELECT dim FROM vec_meta WHERE id = 1`).get()
  if (meta && meta.dim === dim && vecTableExists(db)) {
    vecTableDim = dim
    return true
  }
  db.exec(`DROP TABLE IF EXISTS vec_chunks`)
  db.exec(`
    CREATE VIRTUAL TABLE vec_chunks USING vec0(
      chunk_id TEXT PRIMARY KEY,
      project_id TEXT,
      page_id TEXT,
      chunk_index INTEGER,
      chunk_text TEXT,
      heading_path TEXT,
      embedding FLOAT[${dim}] distance_metric=cosine
    )
  `)
  db.prepare(`
    INSERT INTO vec_meta (id, dim, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET dim = excluded.dim, updated_at = excluded.updated_at
  `).run(dim, Date.now())
  vecTableDim = dim
  return true
}

let degradedWarned = false
function warnDegraded(op) {
  if (degradedWarned) return
  degradedWarned = true
  console.warn(`[vectorstore] sqlite-vec unavailable — ${op} skipped; keyword-only retrieval`)
}

// ── chunk-level vector commands (v2) ──────────────────────────────────────
export async function vectorUpsertChunks({ projectPath, pageId, chunks }) {
  validatePageId(pageId)
  if (!chunks || chunks.length === 0) return
  if (!isVecAvailable()) { warnDegraded("vector_upsert_chunks"); return }
  // Rust: dim = chunks[0].embedding.len(); a missing/empty first embedding is
  // the explicit "Chunk #0 has empty embedding" error.
  const first = chunks[0]
  if (!Array.isArray(first?.embedding) || first.embedding.length === 0) {
    throw new Error("Chunk #0 has empty embedding")
  }
  const dim = first.embedding.length
  // Rust's make_batch_v2: every later chunk must match the batch dim, with the
  // exact per-chunk error (a later empty embedding reports dim 0 here — the
  // "empty embedding" string is reserved for chunk index 0, matching Rust).
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i]
    const len = Array.isArray(c?.embedding) ? c.embedding.length : 0
    if (len !== dim) {
      throw new Error(`Chunk #${c?.chunk_index ?? i} has embedding dim ${len} but batch dim is ${dim}`)
    }
  }
  // Web hardening only: Rust receives f32 through serde (JSON cannot carry
  // NaN/Infinity), so validate finite numbers at the client-trust boundary.
  for (const c of chunks) validateVector(c.embedding)
  if (!ensureVecTable(dim)) return
  const db = getDb()
  const pid = projectKey(projectPath)
  const del = db.prepare(`DELETE FROM vec_chunks WHERE project_id = ? AND page_id = ?`)
  // CAST: better-sqlite3 binds JS numbers as REAL; vec0 metadata columns are
  // strict about storage class, so chunk_index must be coerced to INTEGER.
  const ins = db.prepare(`
    INSERT INTO vec_chunks (chunk_id, project_id, page_id, chunk_index, chunk_text, heading_path, embedding)
    VALUES (?, ?, ?, CAST(? AS INTEGER), ?, ?, ?)
  `)
  const tx = db.transaction(() => {
    del.run(pid, pageId)
    for (const c of chunks) {
      ins.run(
        // PK is project-scoped: the table is shared across projects, while the
        // legacy JSON store was per-project (so "pageId#idx" was unique there).
        `${pid}:${pageId}#${c.chunk_index}`,
        pid,
        pageId,
        c.chunk_index,
        c.chunk_text ?? "",
        c.heading_path ?? "",
        JSON.stringify(c.embedding),
      )
    }
  })
  tx()
}

async function vectorSearchChunks({ projectPath, queryEmbedding, topK = 10 }) {
  if (!isVecAvailable()) return []
  validateVector(queryEmbedding)
  const db = getDb()
  if (!vecTableExists(db)) return []
  const meta = db.prepare(`SELECT dim FROM vec_meta WHERE id = 1`).get()
  // Query embedded by a different provider than the stored chunks: no
  // meaningful comparison — return nothing rather than garbage ranks.
  if (!meta || meta.dim !== queryEmbedding.length) return []
  // LIMIT binds must be integers: a fractional topK would make SQLite throw
  // "datatype mismatch", surfacing as a silently-dropped vector leg upstream.
  const limit = Math.max(1, Math.floor(Number(topK) || 10))
  const rows = db.prepare(`
    SELECT page_id || '#' || chunk_index AS chunk_id,
           page_id, chunk_index, chunk_text, heading_path, distance
    FROM vec_chunks
    WHERE embedding MATCH ? AND project_id = ?
    ORDER BY distance
    LIMIT ?
  `).all(JSON.stringify(queryEmbedding), projectKey(projectPath), limit)
  return rows.map((r) => ({
    chunk_id: r.chunk_id,
    page_id: r.page_id,
    chunk_index: r.chunk_index,
    chunk_text: r.chunk_text,
    heading_path: r.heading_path,
    score: 1 / (1 + r.distance),
  }))
}

export async function vectorDeletePage({ projectPath, pageId }) {
  validatePageId(pageId)
  if (!isVecAvailable()) return
  const db = getDb()
  if (!vecTableExists(db)) return
  db.prepare(`DELETE FROM vec_chunks WHERE project_id = ? AND page_id = ?`)
    .run(projectKey(projectPath), pageId)
}

async function vectorCountChunks({ projectPath }) {
  if (!isVecAvailable()) return 0
  const db = getDb()
  if (!vecTableExists(db)) return 0
  return db.prepare(`SELECT COUNT(*) AS n FROM vec_chunks WHERE project_id = ?`)
    .get(projectKey(projectPath)).n
}

async function vectorClearChunks({ projectPath }) {
  if (!isVecAvailable()) return
  const db = getDb()
  if (!vecTableExists(db)) return
  db.prepare(`DELETE FROM vec_chunks WHERE project_id = ?`).run(projectKey(projectPath))
}

/**
 * Best-effort vector cleanup when a project row is deleted. Removes chunks
 * stored under both the UUID key and the normalized-path key (older rows may
 * have been written before .llm-wiki/project.json existed). Never throws —
 * project deletion must not fail because of vector housekeeping.
 */
async function vectorDeleteProject({ projectPath, projectUuid }) {
  if (!isVecAvailable()) return
  const db = getDb()
  if (!vecTableExists(db)) return
  const keys = new Set()
  if (projectPath) keys.add(projectKey(projectPath))
  if (projectUuid) keys.add(projectUuid)
  const del = db.prepare(`DELETE FROM vec_chunks WHERE project_id = ?`)
  for (const key of keys) del.run(key)
  if (projectPath) projectKeyCache.delete(fwd(projectPath))
}

/**
 * Index health probe used by search before running the vector leg. Returns
 * null when the index is usable for this query, "empty" when the project has
 * no rows, or "dim_mismatch" when the stored chunks' dimension differs from
 * the query embedding's dimension (provider switch without re-index). A
 * "dim_mismatch" verdict means MATCH would throw, and an "empty" verdict means
 * the vector leg contributes nothing — both must degrade to keyword search
 * with a reason instead of returning a silent zero-result response.
 * Not exposed through the invoke bridge (not in vectorCommands).
 */
export function vectorIndexHealth({ projectPath, queryEmbedding }) {
  if (!isVecAvailable()) return "empty"
  const db = getDb()
  if (!vecTableExists(db)) return "empty"
  const meta = db.prepare(`SELECT dim FROM vec_meta WHERE id = 1`).get()
  if (Array.isArray(queryEmbedding) && (!meta || meta.dim !== queryEmbedding.length)) return "dim_mismatch"
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM vec_chunks WHERE project_id = ?`)
    .get(projectKey(projectPath))
  return n > 0 ? null : "empty"
}

// ── page-level vector commands (v1, legacy) ────────────────────────────────
// Port of the desktop's pre-0.3.11 `wiki_vectors` LanceDB table contract
// (src-tauri/src/commands/vectorstore.rs): one row per page, cosine distance,
// score = 1 / (1 + distance), `vector_upsert` does delete-then-add, and
// `vector_search` / `vector_delete` / `vector_count` degrade to [] / no-op / 0
// when the table does not exist. Rows live in a project-scoped vec0 table
// (`vec_pages`) in the same shared server database as vec_chunks, keyed by a
// stable project id. Accepts both the Rust snake_case arg names and the web
// client's camelCase convention.

let pageVecTableDim = 0 // dim the live vec_pages table was created for (0 = none)

function pageVecTableExists(db) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE name = 'vec_pages'`).get()
}

/**
 * Ensure the legacy page-level vec0 table exists for the given embedding
 * dimension. Mirrors ensureVecTable but uses its own vec_meta row (id = 2) so
 * a page-level dimension change never clobbers the chunk table (and vice
 * versa). Returns false when sqlite-vec is unavailable.
 */
function ensurePageVecTable(dim) {
  if (!isVecAvailable()) return false
  if (pageVecTableDim === dim) return true
  const db = getDb()
  // vec_meta is CHECK-constrained to id = 1 (chunk dim), so the page-level
  // dim tracks its own single-row meta table, created lazily.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vec_pages_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      dim INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  const meta = db.prepare(`SELECT dim FROM vec_pages_meta WHERE id = 1`).get()
  if (meta && meta.dim === dim && pageVecTableExists(db)) {
    pageVecTableDim = dim
    return true
  }
  db.exec(`DROP TABLE IF EXISTS vec_pages`)
  db.exec(`
    CREATE VIRTUAL TABLE vec_pages USING vec0(
      page_key TEXT PRIMARY KEY,
      project_id TEXT,
      page_id TEXT,
      embedding FLOAT[${dim}] distance_metric=cosine
    )
  `)
  db.prepare(`
    INSERT INTO vec_pages_meta (id, dim, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET dim = excluded.dim, updated_at = excluded.updated_at
  `).run(dim, Date.now())
  pageVecTableDim = dim
  return true
}

export async function vectorUpsert({ projectPath, project_path, pageId, page_id, embedding }) {
  const pid = pageId ?? page_id
  validatePageId(pid)
  validateVector(embedding)
  if (!isVecAvailable()) { warnDegraded("vector_upsert"); return }
  if (!ensurePageVecTable(embedding.length)) return
  const db = getDb()
  const key = projectKey(projectPath ?? project_path)
  const del = db.prepare(`DELETE FROM vec_pages WHERE project_id = ? AND page_id = ?`)
  const ins = db.prepare(`
    INSERT INTO vec_pages (page_key, project_id, page_id, embedding)
    VALUES (?, ?, ?, ?)
  `)
  const tx = db.transaction(() => {
    del.run(key, pid)
    ins.run(`${key}:${pid}`, key, pid, JSON.stringify(embedding))
  })
  tx()
}

export async function vectorSearch({ projectPath, project_path, queryEmbedding, query_embedding, topK, top_k }) {
  const q = queryEmbedding ?? query_embedding
  const k = topK ?? top_k
  if (!isVecAvailable()) return []
  validateVector(q)
  const db = getDb()
  if (!pageVecTableExists(db)) return []
  const meta = db.prepare(`SELECT dim FROM vec_pages_meta WHERE id = 1`).get()
  // Query embedded by a different provider than the stored pages: no
  // meaningful comparison — return nothing rather than garbage ranks.
  if (!meta || meta.dim !== q.length) return []
  const limit = Math.max(1, Math.floor(Number(k) || 10))
  const rows = db.prepare(`
    SELECT page_id, distance
    FROM vec_pages
    WHERE embedding MATCH ? AND project_id = ?
    ORDER BY distance
    LIMIT ?
  `).all(JSON.stringify(q), projectKey(projectPath ?? project_path), limit)
  return rows.map((r) => ({ page_id: r.page_id, score: 1 / (1 + r.distance) }))
}

export async function vectorDelete({ projectPath, project_path, pageId, page_id }) {
  const pid = pageId ?? page_id
  validatePageId(pid)
  if (!isVecAvailable()) return
  const db = getDb()
  if (!pageVecTableExists(db)) return
  db.prepare(`DELETE FROM vec_pages WHERE project_id = ? AND page_id = ?`)
    .run(projectKey(projectPath ?? project_path), pid)
}

export async function vectorCount({ projectPath, project_path }) {
  if (!isVecAvailable()) return 0
  const db = getDb()
  if (!pageVecTableExists(db)) return 0
  return db.prepare(`SELECT COUNT(*) AS n FROM vec_pages WHERE project_id = ?`)
    .get(projectKey(projectPath ?? project_path)).n
}

// No-ops kept for contract parity with the desktop (LanceDB housekeeping and
// legacy-store notice in settings).
async function vectorOptimizeChunks() { return null }
async function vectorLegacyRowCount() { return 0 }
async function vectorDropLegacy() { return null }

export const vectorCommands = {
  // Legacy v1 page-level commands (Rust contract port).
  vector_upsert: vectorUpsert,
  vector_search: vectorSearch,
  vector_delete: vectorDelete,
  vector_count: vectorCount,
  vector_upsert_chunks: vectorUpsertChunks,
  vector_search_chunks: vectorSearchChunks,
  vector_delete_page: vectorDeletePage,
  vector_delete_project: vectorDeleteProject,
  vector_count_chunks: vectorCountChunks,
  vector_clear_chunks: vectorClearChunks,
  vector_optimize_chunks: vectorOptimizeChunks,
  vector_legacy_row_count: vectorLegacyRowCount,
  vector_drop_legacy: vectorDropLegacy,
}
