// Tests for the SQLite-backed vector store (issue #14 gap).
//
// Covers: extension load, migration 012, upsert/search round-trip with score
// transform, project isolation, page replace/delete/clear semantics,
// dimension-change recreate, validation errors, and graceful degradation when
// sqlite-vec is unavailable.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Config reads LLM_WIKI_DATA_DIR at module load — set it before importing db.
process.env.LLM_WIKI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-vec-test-"))

const { getDb, isVecAvailable } = await import("../src/store/db.js")
const { vectorCommands, vectorIndexHealth } = await import("../src/commands/vectorstore.js")

// Open the DB (runs migrations + loads the sqlite-vec extension) before the
// describe.skipIf guards evaluate.
getDb()

function makeProject(id) {
  const dir = mkdtempSync(path.join(tmpdir(), "llmwiki-vec-proj-"))
  mkdirSync(path.join(dir, ".llm-wiki"), { recursive: true })
  writeFileSync(path.join(dir, ".llm-wiki", "project.json"), JSON.stringify({ id }))
  return dir
}

const unit = (x) => {
  // unit-normalize a 4-d vector so cosine comparisons are exact
  const n = Math.sqrt(x.reduce((s, v) => s + v * v, 0))
  return x.map((v) => v / n)
}
const V = {
  a: unit([1, 0, 0, 0]),
  b: unit([0, 1, 0, 0]),
  c: unit([0.9, 0.1, 0, 0]), // close to a
  d: unit([0, 0, 1, 0]),
}

const cleanups = []

describe.skipIf(!isVecAvailable())("vectorstore (sqlite-vec)", () => {
  beforeAll(() => { getDb() })
  afterAll(() => {
    for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
    rmSync(process.env.LLM_WIKI_DATA_DIR, { recursive: true, force: true })
  })

  it("migration 012 applied: vec_meta exists, placeholder vec_chunks dropped", () => {
    const db = getDb()
    const meta = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'vec_meta'`).get()
    expect(meta).toBeTruthy()
    // The lazy vec0 table does not exist before the first upsert.
    const chunks = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'vec_chunks'`).get()
    expect(chunks).toBeUndefined()
    const applied = db.prepare(`SELECT name FROM _migrations WHERE name = '012_vec_chunks_vec0'`).get()
    expect(applied).toBeTruthy()
  })

  it("upsert + search round-trip: nearest chunk first, fields populated", async () => {
    const proj = makeProject("vec-rt-project")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj,
      pageId: "Page One",
      chunks: [
        { chunk_index: 0, chunk_text: "alpha text", heading_path: "H1 > H2", embedding: V.a },
        { chunk_index: 1, chunk_text: "beta text", heading_path: "H1", embedding: V.b },
      ],
    })

    const hits = await vectorCommands.vector_search_chunks({
      projectPath: proj, queryEmbedding: V.a, topK: 5,
    })
    expect(hits.length).toBe(2)
    expect(hits[0].chunk_id).toBe("Page One#0")
    expect(hits[0].chunk_text).toBe("alpha text")
    expect(hits[0].heading_path).toBe("H1 > H2")
    expect(hits[0].chunk_index).toBe(0)
    expect(hits[0].score).toBeCloseTo(1, 5) // distance 0 → 1/(1+0)
    expect(hits[1].chunk_id).toBe("Page One#1")
    // score transform: score = 1 / (1 + distance), distance = 1 - cosine
    expect(hits[1].score).toBeCloseTo(1 / (1 + 1), 5)
  })

  it("ranks by cosine similarity (near vector beats orthogonal)", async () => {
    const proj = makeProject("vec-rank-project")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj,
      pageId: "RankPage",
      chunks: [
        { chunk_index: 0, chunk_text: "far", heading_path: "", embedding: V.d },
        { chunk_index: 1, chunk_text: "near", heading_path: "", embedding: V.c },
      ],
    })
    const hits = await vectorCommands.vector_search_chunks({
      projectPath: proj, queryEmbedding: V.a, topK: 2,
    })
    expect(hits[0].chunk_text).toBe("near")
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
  })

  it("isolates projects by project.json id", async () => {
    const projA = makeProject("vec-iso-A")
    const projB = makeProject("vec-iso-B")
    cleanups.push(projA, projB)
    await vectorCommands.vector_upsert_chunks({
      projectPath: projA, pageId: "P",
      chunks: [{ chunk_index: 0, chunk_text: "A only", heading_path: "", embedding: V.a }],
    })
    await vectorCommands.vector_upsert_chunks({
      projectPath: projB, pageId: "P",
      chunks: [{ chunk_index: 0, chunk_text: "B only", heading_path: "", embedding: V.b }],
    })
    const hitsA = await vectorCommands.vector_search_chunks({ projectPath: projA, queryEmbedding: V.a })
    const hitsB = await vectorCommands.vector_search_chunks({ projectPath: projB, queryEmbedding: V.a })
    expect(hitsA.map((h) => h.chunk_text)).toEqual(["A only"])
    expect(hitsB.map((h) => h.chunk_text)).toEqual(["B only"])
    expect(await vectorCommands.vector_count_chunks({ projectPath: projA })).toBe(1)
    expect(await vectorCommands.vector_count_chunks({ projectPath: projB })).toBe(1)
  })

  it("re-upserting a page replaces its chunks (no duplicates)", async () => {
    const proj = makeProject("vec-replace-project")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "Page",
      chunks: [
        { chunk_index: 0, chunk_text: "old-0", heading_path: "", embedding: V.a },
        { chunk_index: 1, chunk_text: "old-1", heading_path: "", embedding: V.b },
      ],
    })
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "Page",
      chunks: [{ chunk_index: 0, chunk_text: "new-0", heading_path: "", embedding: V.c }],
    })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(1)
    const hits = await vectorCommands.vector_search_chunks({ projectPath: proj, queryEmbedding: V.a })
    expect(hits.length).toBe(1)
    expect(hits[0].chunk_text).toBe("new-0")
  })

  it("delete_page removes one page; clear_chunks removes the project's rows", async () => {
    const proj = makeProject("vec-delete-project")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "Keep",
      chunks: [{ chunk_index: 0, chunk_text: "keep", heading_path: "", embedding: V.a }],
    })
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "Gone",
      chunks: [{ chunk_index: 0, chunk_text: "gone", heading_path: "", embedding: V.b }],
    })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(2)
    await vectorCommands.vector_delete_page({ projectPath: proj, pageId: "Gone" })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(1)
    await vectorCommands.vector_clear_chunks({ projectPath: proj })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(0)
  })

  it("dimension change recreates the table (stale rows dropped, old-dim queries empty)", async () => {
    const proj = makeProject("vec-dim-project")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "P4",
      chunks: [{ chunk_index: 0, chunk_text: "dim4", heading_path: "", embedding: V.a }],
    })
    const dim8 = [0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0]
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "P8",
      chunks: [{ chunk_index: 0, chunk_text: "dim8", heading_path: "", embedding: dim8 }],
    })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(1)
    // Old-dim query cannot match the new table: graceful empty result.
    expect(await vectorCommands.vector_search_chunks({ projectPath: proj, queryEmbedding: V.a })).toEqual([])
    const hits = await vectorCommands.vector_search_chunks({ projectPath: proj, queryEmbedding: dim8 })
    expect(hits.map((h) => h.chunk_text)).toEqual(["dim8"])
    const db = getDb()
    expect(db.prepare(`SELECT dim FROM vec_meta WHERE id = 1`).get().dim).toBe(8)
  })

  it("topK limits results", async () => {
    const proj = makeProject("vec-topk-project")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "Many",
      chunks: [V.a, V.b, V.d].map((embedding, i) => ({
        chunk_index: i, chunk_text: `c${i}`, heading_path: "", embedding,
      })),
    })
    const hits = await vectorCommands.vector_search_chunks({ projectPath: proj, queryEmbedding: V.a, topK: 2 })
    expect(hits.length).toBe(2)
  })

  it("rejects invalid embeddings and page ids", async () => {
    const proj = makeProject("vec-invalid-project")
    cleanups.push(proj)
    await expect(vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "P",
      chunks: [{ chunk_index: 0, chunk_text: "x", heading_path: "", embedding: [] }],
    })).rejects.toThrow(/embedding/i)
    await expect(vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "P",
      chunks: [
        { chunk_index: 0, chunk_text: "x", heading_path: "", embedding: V.a },
        { chunk_index: 1, chunk_text: "y", heading_path: "", embedding: [1, 0] },
      ],
    })).rejects.toThrow("Chunk #1 has embedding dim 2 but batch dim is 4")
    await expect(vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "bad/page", chunks: [],
    })).rejects.toThrow(/page_id/i) // pageId validated before the empty-chunks no-op
    await expect(vectorCommands.vector_delete_page({ projectPath: proj, pageId: "bad/slash" }))
      .rejects.toThrow(/page_id/i)
    await expect(vectorCommands.vector_search_chunks({ projectPath: proj, queryEmbedding: [NaN, 1] }))
      .rejects.toThrow(/embedding/i)
  })

  it("parity no-ops keep the desktop contract", async () => {
    expect(await vectorCommands.vector_optimize_chunks()).toBeNull()
    expect(await vectorCommands.vector_legacy_row_count()).toBe(0)
    expect(await vectorCommands.vector_drop_legacy()).toBeNull()
  })

  it("degrades gracefully when sqlite-vec is unavailable", async () => {
    const dbMod = await import("../src/store/db.js")
    const spy = vi.spyOn(dbMod, "isVecAvailable").mockReturnValue(false)
    try {
      const proj = makeProject("vec-degraded-project")
      cleanups.push(proj)
      // Writes no-op (no throw), reads return empty, count is 0.
      await expect(vectorCommands.vector_upsert_chunks({
        projectPath: proj, pageId: "P",
        chunks: [{ chunk_index: 0, chunk_text: "x", heading_path: "", embedding: V.a }],
      })).resolves.toBeUndefined()
      expect(await vectorCommands.vector_search_chunks({ projectPath: proj, queryEmbedding: V.a })).toEqual([])
      expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(0)
      await expect(vectorCommands.vector_delete_page({ projectPath: proj, pageId: "P" })).resolves.toBeUndefined()
      await expect(vectorCommands.vector_clear_chunks({ projectPath: proj })).resolves.toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  // ── review-fix regressions (PR #27) ────────────────────────────────────

  it("fractional topK does not throw (LIMIT binds must be integers)", async () => {
    const proj = makeProject("vec-frack-project")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "F",
      chunks: [{ chunk_index: 0, chunk_text: "frack", heading_path: "", embedding: V.a }],
    })
    const hits = await vectorCommands.vector_search_chunks({ projectPath: proj, queryEmbedding: V.a, topK: 2.5 })
    expect(hits.length).toBe(1)
  })

  it("delete_project removes rows under both the uuid key and the path key", async () => {
    const proj = makeProject("vec-dp-project")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "P",
      chunks: [{ chunk_index: 0, chunk_text: "dp-uuid", heading_path: "", embedding: V.a }],
    })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(1)
    await vectorCommands.vector_delete_project({ projectPath: proj, projectUuid: "vec-dp-project" })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(0)

    // Path-keyed project (no project.json): rows were written under the path key.
    const bare = mkdtempSync(path.join(tmpdir(), "llmwiki-vec-bare-"))
    cleanups.push(bare)
    await vectorCommands.vector_upsert_chunks({
      projectPath: bare, pageId: "P",
      chunks: [{ chunk_index: 0, chunk_text: "dp-path", heading_path: "", embedding: V.b }],
    })
    expect(await vectorCommands.vector_count_chunks({ projectPath: bare })).toBe(1)
    await vectorCommands.vector_delete_project({ projectPath: bare })
    expect(await vectorCommands.vector_count_chunks({ projectPath: bare })).toBe(0)
  })

  it("projectKey self-heals when project.json appears later (stranded rows dropped)", async () => {
    const proj = mkdtempSync(path.join(tmpdir(), "llmwiki-vec-flip-"))
    cleanups.push(proj)
    mkdirSync(path.join(proj, ".llm-wiki"), { recursive: true })
    // No project.json yet → rows are keyed by the normalized path.
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "P",
      chunks: [{ chunk_index: 0, chunk_text: "flip-before", heading_path: "", embedding: V.a }],
    })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(1)
    // The client's ensureProjectId writes project.json on first open → identity
    // flips to the uuid; stranded path-key rows must be dropped, not leaked.
    writeFileSync(path.join(proj, ".llm-wiki", "project.json"), JSON.stringify({ id: "vec-flip-uuid" }))
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(0)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "P",
      chunks: [{ chunk_index: 0, chunk_text: "flip-after", heading_path: "", embedding: V.a }],
    })
    const db = getDb()
    const rows = db.prepare(`SELECT project_id, chunk_text FROM vec_chunks`).all()
      .filter((r) => r.chunk_text === "flip-before" || r.chunk_text === "flip-after")
    expect(rows).toEqual([{ project_id: "vec-flip-uuid", chunk_text: "flip-after" }])
  })

  it("v1 upsert + search round-trip: nearest page first, {page_id, score} shape", async () => {
    const proj = makeProject("vec-v1-rt")
    cleanups.push(proj)
    await vectorCommands.vector_upsert({ projectPath: proj, pageId: "Alpha", embedding: V.a })
    await vectorCommands.vector_upsert({ projectPath: proj, pageId: "Beta", embedding: V.b })
    await vectorCommands.vector_upsert({ projectPath: proj, pageId: "Gamma", embedding: V.c }) // close to a

    const hits = await vectorCommands.vector_search({ projectPath: proj, queryEmbedding: V.a, topK: 5 })
    expect(hits.length).toBe(3)
    expect(hits[0]).toEqual({ page_id: "Alpha", score: 1 })
    // Gamma = unit([0.9, 0.1, 0, 0]) → cosine(a, Gamma) = 0.9 / sqrt(0.82).
    // Stored embeddings are float32, so compare with a tolerance.
    expect(hits[1].page_id).toBe("Gamma")
    expect(hits[1].score).toBeCloseTo(1 / (1 + (1 - 0.9 / Math.sqrt(0.82))), 5)
    expect(hits[2].page_id).toBe("Beta")
    expect(await vectorCommands.vector_count({ projectPath: proj })).toBe(3)
  })

  it("v1 upsert is delete-then-add (replace semantics)", async () => {
    const proj = makeProject("vec-v1-replace")
    cleanups.push(proj)
    await vectorCommands.vector_upsert({ projectPath: proj, pageId: "P", embedding: V.a })
    await vectorCommands.vector_upsert({ projectPath: proj, pageId: "P", embedding: V.b })
    expect(await vectorCommands.vector_count({ projectPath: proj })).toBe(1)
    const hits = await vectorCommands.vector_search({ projectPath: proj, queryEmbedding: V.b, topK: 5 })
    expect(hits[0]).toEqual({ page_id: "P", score: 1 })
  })

  it("v1 search returns [] and count 0 / delete no-ops before any upsert", async () => {
    const proj = makeProject("vec-v1-empty")
    cleanups.push(proj)
    expect(await vectorCommands.vector_search({ projectPath: proj, queryEmbedding: V.a, topK: 5 })).toEqual([])
    expect(await vectorCommands.vector_count({ projectPath: proj })).toBe(0)
    await vectorCommands.vector_delete({ projectPath: proj, pageId: "Missing" }) // must not throw
    await vectorCommands.vector_upsert({ projectPath: proj, pageId: "P", embedding: V.a })
    await vectorCommands.vector_delete({ projectPath: proj, pageId: "P" })
    expect(await vectorCommands.vector_count({ projectPath: proj })).toBe(0)
  })

  it("v1 commands are project-isolated and accept snake_case Rust arg names", async () => {
    const p1 = makeProject("vec-v1-iso-1")
    const p2 = makeProject("vec-v1-iso-2")
    cleanups.push(p1, p2)
    await vectorCommands.vector_upsert({
      project_path: p1, page_id: "甲", embedding: V.a,
    })
    await vectorCommands.vector_upsert({
      project_path: p2, page_id: "乙", embedding: V.b,
    })
    expect(await vectorCommands.vector_count({ project_path: p2 })).toBe(1)
    const hits = await vectorCommands.vector_search({
      project_path: p2, query_embedding: V.a, top_k: 5,
    })
    // p2 only contains 乙; searching with 甲's vector still returns 乙 (no leakage)
    expect(hits.map((h) => h.page_id)).toEqual(["乙"])
    expect(hits[0].page_id).toBe("乙")
  })

  it("v1 validates page_id and embedding like the chunk store", async () => {
    const proj = makeProject("vec-v1-valid")
    cleanups.push(proj)
    await expect(vectorCommands.vector_upsert({ projectPath: proj, pageId: "", embedding: V.a }))
      .rejects.toThrow("Invalid page_id: empty or too long")
    await expect(vectorCommands.vector_upsert({ projectPath: proj, pageId: "a/b", embedding: V.a }))
      .rejects.toThrow("Invalid page_id: contains disallowed character")
    await expect(vectorCommands.vector_search({ projectPath: proj, queryEmbedding: [], topK: 5 }))
      .rejects.toThrow("Invalid embedding: expected non-empty array of finite numbers")
    await expect(vectorCommands.vector_upsert({ projectPath: proj, pageId: "ok", embedding: [1, "x"] }))
      .rejects.toThrow("Invalid embedding: expected non-empty array of finite numbers")
  })

  it("v1 search guards against provider dimension change (returns [] not garbage)", async () => {
    const proj = makeProject("vec-v1-dim")
    cleanups.push(proj)
    await vectorCommands.vector_upsert({ projectPath: proj, pageId: "P", embedding: V.a })
    expect(await vectorCommands.vector_search({ projectPath: proj, queryEmbedding: [0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0], topK: 5 }))
      .toEqual([])
  })

  // ── Rust vectorstore.rs tests_v2 fixtures (ported verbatim) ─────────────
  // The desktop's own unit tests: page_id validation (unicode stems allowed,
  // every format/invisible footgun rejected, 256-char boundary incl. CJK),
  // chunk dim/empty-embedding error semantics, idempotent deletes, and the
  // empty-chunks no-op that preserves previously-indexed rows.

  it("port: page_id_validation_allows_unicode_wiki_stems", async () => {
    const proj = makeProject("vec-rust-unicode")
    cleanups.push(proj)
    const stem = "反硝化除磷·A2O：DPAO + 50% & x（测试），v1.2"
    await expect(vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: stem,
      chunks: [{ chunk_index: 0, chunk_text: "ok", heading_path: "", embedding: V.a }],
    })).resolves.toBeUndefined()
    await expect(vectorCommands.vector_upsert({ projectPath: proj, pageId: stem, embedding: V.a }))
      .resolves.toBeUndefined()
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(1)
    expect(await vectorCommands.vector_count({ projectPath: proj })).toBe(1)
  })

  it("port: page_id_validation_rejects_filter_and_path_footguns", async () => {
    const proj = makeProject("vec-rust-footguns")
    cleanups.push(proj)
    const footguns = [
      "bad'quote",
      'bad"quote',
      "bad/slash",
      "bad\\slash",
      "bad\nnewline",
      "bad\ttab",
      "bad\0nul",
      "soft\u00ADhyphen",
      "arabic\u061Cmark",
      "zero\u200Bwidth",
      "line\u2028sep",
      "para\u2029sep",
      "bidi\u202Eoverride",
      "\uFEFFbom",
      "annotation\uFFF9mark",
      "tag\u{E0041}char",
    ]
    // v1 page-level validation (Rust validate_page_id)
    for (const pid of footguns) {
      await expect(vectorCommands.vector_upsert({ projectPath: proj, pageId: pid, embedding: V.a }))
        .rejects.toThrow("Invalid page_id: contains disallowed character")
    }
    // v2 chunk-level validation (Rust validate_page_id_for_v2)
    for (const pid of footguns) {
      await expect(vectorCommands.vector_upsert_chunks({
        projectPath: proj, pageId: pid,
        chunks: [{ chunk_index: 0, chunk_text: "x", heading_path: "", embedding: V.a }],
      })).rejects.toThrow("Invalid page_id: contains disallowed character")
    }
    // The message carries the Rust {:?} char debug repr of the offending char.
    await expect(vectorCommands.vector_upsert({
      projectPath: proj, pageId: "soft\u00ADhyphen", embedding: V.a,
    })).rejects.toThrow("contains disallowed character '\\u{ad}': soft\u00ADhyphen")
    await expect(vectorCommands.vector_upsert({
      projectPath: proj, pageId: "zero\u200Bwidth", embedding: V.a,
    })).rejects.toThrow("contains disallowed character '\\u{200b}': zero\u200Bwidth")
    await expect(vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "bad\0nul",
      chunks: [{ chunk_index: 0, chunk_text: "x", heading_path: "", embedding: V.a }],
    })).rejects.toThrow("contains disallowed character '\\0'")
  })

  it("port: page_id_validation_rejects_empty_and_overlong_ids (char count, not UTF-16 units)", async () => {
    const proj = makeProject("vec-rust-boundary")
    cleanups.push(proj)
    const chunks = [{ chunk_index: 0, chunk_text: "x", heading_path: "", embedding: V.a }]
    await expect(vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "", chunks,
    })).rejects.toThrow("Invalid page_id: empty or too long")

    // 256 chars is fine — ASCII, CJK, and astral (emoji = 2 UTF-16 units but
    // 1 Rust char).
    for (const pid of ["a".repeat(256), "测".repeat(256), "🚀".repeat(256)]) {
      await expect(vectorCommands.vector_upsert_chunks({
        projectPath: proj, pageId: pid, chunks,
      })).resolves.toBeUndefined()
    }
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(3)

    // 257 chars is rejected for all three.
    for (const pid of ["a".repeat(257), "测".repeat(257), "🚀".repeat(257)]) {
      await expect(vectorCommands.vector_upsert_chunks({
        projectPath: proj, pageId: pid, chunks,
      })).rejects.toThrow("Invalid page_id: empty or too long")
    }
  })

  it("port: page_id_validation_allows_hash_in_debug_chunk_ids", async () => {
    const proj = makeProject("vec-rust-hash")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "source#section",
      chunks: [{ chunk_index: 0, chunk_text: "hash ok", heading_path: "", embedding: V.a }],
    })
    const hits = await vectorCommands.vector_search_chunks({ projectPath: proj, queryEmbedding: V.a })
    expect(hits[0].chunk_id).toBe("source#section#0")
  })

  it("port: v2_rejects_mismatched_embedding_dimensions", async () => {
    const proj = makeProject("vec-rust-dim")
    cleanups.push(proj)
    const bad = [
      { chunk_index: 0, chunk_text: "ok", heading_path: "", embedding: V.a }, // dim 4
      { chunk_index: 1, chunk_text: "bad", heading_path: "", embedding: [1, 0] }, // dim 2
    ]
    await expect(vectorCommands.vector_upsert_chunks({ projectPath: proj, pageId: "page-a", chunks: bad }))
      .rejects.toThrow("Chunk #1 has embedding dim 2 but batch dim is 4")
  })

  it("port: v2_rejects_empty_first_embedding", async () => {
    const proj = makeProject("vec-rust-empty-emb")
    cleanups.push(proj)
    await expect(vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "page-a",
      chunks: [{ chunk_index: 0, chunk_text: "x", heading_path: "", embedding: [] }],
    })).rejects.toThrow("Chunk #0 has empty embedding")
  })

  it("port: v2_empty_upsert_is_a_noop_not_an_error", async () => {
    const proj = makeProject("vec-rust-empty-upsert")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "page-a",
      chunks: [
        { chunk_index: 0, chunk_text: "keep-0", heading_path: "", embedding: V.a },
        { chunk_index: 1, chunk_text: "keep-1", heading_path: "", embedding: V.b },
      ],
    })
    // Upserting [] is Ok(()) and must NOT wipe the page's existing rows.
    await expect(vectorCommands.vector_upsert_chunks({ projectPath: proj, pageId: "page-a", chunks: [] }))
      .resolves.toBeUndefined()
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(2)
  })

  it("port: v2_delete_page_is_idempotent", async () => {
    const proj = makeProject("vec-rust-idempotent")
    cleanups.push(proj)
    // Delete on missing table: ok.
    await expect(vectorCommands.vector_delete_page({ projectPath: proj, pageId: "never-existed" }))
      .resolves.toBeUndefined()
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "page-a",
      chunks: [{ chunk_index: 0, chunk_text: "x", heading_path: "", embedding: V.a }],
    })
    await expect(vectorCommands.vector_delete_page({ projectPath: proj, pageId: "page-a" }))
      .resolves.toBeUndefined()
    await expect(vectorCommands.vector_delete_page({ projectPath: proj, pageId: "page-a" }))
      .resolves.toBeUndefined()
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(0)
  })

  it("port: v2_search/count on missing table return [] / 0", async () => {
    const proj = makeProject("vec-rust-missing")
    cleanups.push(proj)
    expect(await vectorCommands.vector_search_chunks({ projectPath: proj, queryEmbedding: V.a, topK: 10 }))
      .toEqual([])
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(0)
  })

  it("port: v2_rejects_invalid_page_id (SQL-injection footgun)", async () => {
    const proj = makeProject("vec-rust-inject")
    cleanups.push(proj)
    await expect(vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "bad'; DROP",
      chunks: [{ chunk_index: 0, chunk_text: "x", heading_path: "", embedding: V.a }],
    })).rejects.toThrow("Invalid page_id: contains disallowed character '\\''")
  })

  it("port: v2_clear_chunks_drops_entire_chunk_table_and_is_idempotent", async () => {
    const proj = makeProject("vec-rust-clear")
    cleanups.push(proj)
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "a",
      chunks: [{ chunk_index: 0, chunk_text: "a0", heading_path: "", embedding: V.a }],
    })
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "b",
      chunks: [{ chunk_index: 0, chunk_text: "b0", heading_path: "", embedding: V.b }],
    })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(2)
    await vectorCommands.vector_clear_chunks({ projectPath: proj })
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(0)
    await vectorCommands.vector_clear_chunks({ projectPath: proj }) // idempotent
    expect(await vectorCommands.vector_count_chunks({ projectPath: proj })).toBe(0)
  })

  it("vectorIndexHealth reports usable / empty / dim_mismatch", async () => {
    const proj = makeProject("vec-health-project")
    cleanups.push(proj)
    expect(vectorIndexHealth({ projectPath: proj, queryEmbedding: V.a })).toBe("empty")
    await vectorCommands.vector_upsert_chunks({
      projectPath: proj, pageId: "H",
      chunks: [{ chunk_index: 0, chunk_text: "health", heading_path: "", embedding: V.a }],
    })
    expect(vectorIndexHealth({ projectPath: proj, queryEmbedding: V.a })).toBeNull()
    expect(vectorIndexHealth({ projectPath: proj, queryEmbedding: [0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0] }))
      .toBe("dim_mismatch")
  })
})

describe.skipIf(isVecAvailable())("vectorstore (no sqlite-vec binary)", () => {
  it("still exports the full command surface", () => {
    expect(Object.keys(vectorCommands)).toEqual(expect.arrayContaining([
      "vector_upsert_chunks", "vector_search_chunks", "vector_delete_page",
      "vector_count_chunks", "vector_clear_chunks",
    ]))
  })
})
