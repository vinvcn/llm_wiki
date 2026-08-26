// Issue #39 upgrade path: an EXISTING database that already ran migrations
// 001–014 (and therefore still carries the schema-only `reviews`,
// `graph_nodes`, `graph_edges` tables) must apply migration 015 on next boot
// and end without them. The seed below reproduces the pre-015 shape — the
// three tables with the exact DDL from migrations 006/008, and a
// `_migrations` ledger claiming 001–014 applied — so the migration runner
// executes ONLY 015 (the drop must also succeed with the
// graph_edges → graph_nodes foreign key intact and foreign_keys=ON).

import { describe, it, expect, afterAll } from "vitest"
import { mkdtempSync, rmSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import Database from "better-sqlite3"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-drop-vestigial-upg-"))
mkdirSync(DATA_DIR, { recursive: true })
process.env.LLM_WIKI_DATA_DIR = DATA_DIR

const PRE_015_MIGRATIONS = [
  "001_users", "002_settings", "003_projects", "004_chat_sessions",
  "005_chat_messages", "006_reviews", "007_ingest_queue",
  "008_graph_nodes_edges", "009_vec_chunks", "010_chat_sessions_uuid",
  "011_projects_uuid", "012_vec_chunks_vec0", "013_ingest_queue_lifecycle",
  "014_ingest_heartbeat",
]

// Seed the pre-015 database BEFORE importing db.js (config reads DATA_DIR at
// module load).
{
  const db = new Database(path.join(DATA_DIR, "server.db"))
  db.exec(`
    CREATE TABLE _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    )
  `)
  const insert = db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)")
  for (const name of PRE_015_MIGRATIONS) insert.run(name, Date.now())
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'other',
      link_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      UNIQUE (project_id, path),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_edges (
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      PRIMARY KEY (source_id, target_id),
      FOREIGN KEY (source_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
    )
  `)
  db.close()
}

const { getDb } = await import("../src/store/db.js")

const tableNames = (db) =>
  db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map((r) => r.name)

describe("migration 015 on an existing pre-015 database", () => {
  afterAll(() => {
    try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
  })

  it("applies only 015 and drops the three vestigial tables", () => {
    const db = getDb()
    const applied = db
      .prepare(`SELECT name FROM _migrations`)
      .all()
      .map((r) => r.name)
    expect(applied).toContain("015_drop_vestigial_tables")
    // The pre-015 ledger is untouched (no re-run of earlier migrations).
    for (const name of PRE_015_MIGRATIONS) {
      expect(applied).toContain(name)
    }
    const names = tableNames(db)
    expect(names).not.toContain("reviews")
    expect(names).not.toContain("graph_nodes")
    expect(names).not.toContain("graph_edges")
  })

  it("drops the migration 008 indexes and the autoincrement bookkeeping with them", () => {
    const db = getDb()
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`)
      .all()
      .map((r) => r.name)
    expect(indexes).not.toContain("idx_graph_edges_target")
    expect(indexes).not.toContain("idx_graph_nodes_project")
    // Dropped AUTOINCREMENT tables leave sqlite_sequence rows behind unless
    // the table drop removes them (SQLite does) — assert no stale rows.
    const seq = db.prepare(`SELECT name FROM sqlite_sequence`).all().map((r) => r.name)
    expect(seq).not.toContain("reviews")
    expect(seq).not.toContain("graph_nodes")
  })
})
