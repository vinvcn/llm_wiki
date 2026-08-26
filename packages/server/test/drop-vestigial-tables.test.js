// Issue #39: the server never wrote the `reviews` / `graph_nodes` /
// `graph_edges` SQLite tables. Reviews are file-backed
// (`.llm-wiki/review.json`) and the knowledge graph is rebuilt on demand from
// `wiki/*.md` (PUSH1 G13), so the tables were schema-only — zero rows in
// every observed database, no code touching them outside their CREATE
// statements. Migration 015 drops them idempotently so the schema stops
// advertising stores whose truth lives elsewhere (which invites split-truth
// writes). This suite pins the FRESH-INSTALL path: migrations 006/008 create
// the tables, then 015 must remove them (tables present at drop time, FK
// graph_edges → graph_nodes intact) while every serving table survives.

import { describe, it, expect, afterAll } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Config reads LLM_WIKI_DATA_DIR at module load — set it before importing db.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-drop-vestigial-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR

const { getDb } = await import("../src/store/db.js")

const tableNames = (db) =>
  db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((r) => r.name)

describe("migration 015: drop vestigial tables (fresh install)", () => {
  afterAll(() => {
    try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
  })

  it("records 015 and ends without reviews / graph_nodes / graph_edges", () => {
    const db = getDb()
    const applied = db
      .prepare(`SELECT name FROM _migrations WHERE name = '015_drop_vestigial_tables'`)
      .get()
    expect(applied).toBeTruthy()

    const names = tableNames(db)
    expect(names).not.toContain("reviews")
    expect(names).not.toContain("graph_nodes")
    expect(names).not.toContain("graph_edges")
  })

  it("keeps every serving table (including the ones 006/008 were adjacent to)", () => {
    const names = tableNames(getDb())
    for (const keep of [
      "projects", "ingest_queue", "chat_sessions", "chat_messages", "vec_meta",
    ]) {
      expect(names).toContain(keep)
    }
  })

  it("leaves no dangling FK references to the dropped tables in the schema", () => {
    const db = getDb()
    const ddl = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL`)
      .all()
      .map((r) => r.sql)
      .join("\n")
    expect(ddl).not.toMatch(/graph_nodes|graph_edges|reviews/)
  })
})
