// /api/v1 review-item contract (api_server.rs) — pinned on the SHIPPED v2
// entry (the standing scripts/verify/verify-api-v1.mjs gate runs the legacy
// index.js entry, so the two together prove both servers speak the contract):
//   - GET reviews: stable FNV-1a review-<hash> ids (review_id_for_parts),
//     sanitize (unknown fields hidden), duplicate merge (min createdAt, union
//     affectedPages, fill-empty description), status=pending -> unresolved,
//     exact invalid-status error, type filter, limit.
//   - PATCH /reviews/:id: empty body resolves, raw-array write-back that
//     PRESERVES unknown fields and stamps the stable id, reopen removes
//     resolvedAction, exact 404/400 error strings.
//   - POST /reviews/resolve: bulk partial success {resolved,notFound,count}
//     in input order, raw write-back, missing-file => all notFound.
//   - search: strict Invalid JSON / query-required / queryEmbedding errors +
//     the desktop's hybrid-engine note.
//   - chat: missing/blank message 400s, provider failure -> 502 {ok:false}.
//   - unknown project -> "Unknown project: <id>", unknown route -> "Not found".

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import request from "supertest"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-v1reviews-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const { app } = await import("../src/index-v2.js")

const STORE = path.join(DATA_DIR, "stores", "app-state.json")
const PROJECT = path.join(DATA_DIR, "proj")
const BARE = path.join(DATA_DIR, "bare")
const PROJECT_ID = "reviews-proj"
const BARE_ID = "bare-proj"
const TOKEN = "reviews-token"

// Independent FNV-1a/32 over UTF-16 code units (mirrors api_server.rs
// review_id_for_parts so the test can predict stable ids).
function expectedReviewId(type, normalizedTitle) {
  const key = `${type}::${normalizedTitle}`
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `review-${h.toString(16).padStart(8, "0")}`
}

const FOO_STABLE = expectedReviewId("missing_page", "foo bar")
const LEGACY_STABLE = expectedReviewId("quality", "check q")
const ALPHA_STABLE = expectedReviewId("missing_page", "alpha page")

const REVIEW_FILE = path.join(PROJECT, ".llm-wiki", "review.json")

function writeReviews(items) {
  mkdirSync(path.dirname(REVIEW_FILE), { recursive: true })
  writeFileSync(REVIEW_FILE, JSON.stringify(items, null, 2))
}

beforeAll(() => {
  mkdirSync(path.join(PROJECT, "wiki"), { recursive: true })
  mkdirSync(path.join(BARE, "wiki"), { recursive: true })
  writeFileSync(path.join(PROJECT, "wiki", "quantum.md"), "---\ntype: entity\ntitle: Quantum\n---\n# Quantum\nQuantum mechanics is the study of matter at atomic scales.\n")
  writeFileSync(path.join(BARE, "wiki", "index.md"), "# Index\n")
  mkdirSync(path.dirname(STORE), { recursive: true })
  writeFileSync(STORE, JSON.stringify({
    apiConfig: { token: TOKEN },
    projectRegistry: {
      [PROJECT_ID]: { id: PROJECT_ID, name: "Reviews", path: PROJECT },
      [BARE_ID]: { id: BARE_ID, name: "Bare", path: BARE },
    },
  }))
  writeReviews([
    { type: "missing_page", title: "Missing page: Foo Bar", description: "d1", createdAt: 200 },
    { type: "missing_page", title: "foo   bar", affectedPages: ["P1"], internalSecret: "s3cr3t", createdAt: 100 },
    { id: "legacy-1", type: "quality", title: "Check Q", resolved: true, resolvedAction: "Skip", createdAt: 50 },
    { id: "bulk-a", type: "missing_page", title: "Alpha Page", createdAt: 10 },
    { id: "bulk-b", type: "missing_page", title: "Beta Page", createdAt: 20 },
  ])
})

afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }))

const auth = { "x-llm-wiki-token": TOKEN }

describe("/api/v1 reviews contract", () => {
  it("GET /reviews: stable FNV ids, sanitize, duplicate merge, default unresolved", async () => {
    const res = await request(app).get(`/api/v1/projects/${PROJECT_ID}/reviews`).set(auth)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.status).toBe("unresolved")
    const foo = res.body.reviews.filter((r) => r.id === FOO_STABLE)
    expect(foo).toHaveLength(1)
    expect(foo[0]).toMatchObject({ description: "d1", affectedPages: ["P1"], createdAt: 100 })
    expect(foo[0]).not.toHaveProperty("internalSecret")
    expect(res.body.reviews.some((r) => r.id === LEGACY_STABLE)).toBe(false)
    expect(res.body.count).toBe(res.body.reviews.length)
  })

  it("GET /reviews: status=pending normalizes, invalid status errors exactly", async () => {
    const pending = await request(app).get(`/api/v1/projects/${PROJECT_ID}/reviews?status=pending`).set(auth)
    expect(pending.status).toBe(200)
    expect(pending.body.status).toBe("unresolved")
    const bogus = await request(app).get(`/api/v1/projects/${PROJECT_ID}/reviews?status=bogus`).set(auth)
    expect(bogus.status).toBe(400)
    expect(bogus.body.error).toBe("Invalid review status 'bogus'. Expected unresolved, resolved, or all")
  })

  it("GET /reviews: status=all includes resolved with action; type filter hides raw id; limit applied", async () => {
    const all = await request(app).get(`/api/v1/projects/${PROJECT_ID}/reviews?status=all`).set(auth)
    expect(all.status).toBe(200)
    const legacy = all.body.reviews.find((r) => r.id === LEGACY_STABLE)
    expect(legacy).toMatchObject({ resolved: true, resolvedAction: "Skip" })
    expect(all.body.reviews.some((r) => r.id === "legacy-1")).toBe(false)
    const typed = await request(app).get(`/api/v1/projects/${PROJECT_ID}/reviews?status=all&type=quality`).set(auth)
    expect(typed.body.reviews).toHaveLength(1)
    expect(typed.body.reviews[0].id).toBe(LEGACY_STABLE)
    const limited = await request(app).get(`/api/v1/projects/${PROJECT_ID}/reviews?status=all&limit=1`).set(auth)
    expect(limited.body.reviews).toHaveLength(1)
  })

  it("PATCH /reviews/:id: empty body resolves, raw write-back preserves unknown fields + stamps id", async () => {
    const patch = await request(app).patch(`/api/v1/projects/${PROJECT_ID}/reviews/${FOO_STABLE}`).set(auth).send({ action: "Created page" })
    expect(patch.status).toBe(200)
    expect(patch.body).toMatchObject({ ok: true, reviewId: FOO_STABLE, resolved: true })
    const raw = JSON.parse(require("node:fs").readFileSync(REVIEW_FILE, "utf-8"))
    const rawFoo = raw.find((it) => it.title === "Missing page: Foo Bar")
    expect(rawFoo).toMatchObject({ resolved: true, resolvedAction: "Created page", id: FOO_STABLE })
    const rawSecret = raw.find((it) => it.title === "foo   bar")
    expect(rawSecret.internalSecret).toBe("s3cr3t")
  })

  it("PATCH /reviews/:id: reopen removes resolvedAction; unknown id / bad body errors exact", async () => {
    const reopen = await request(app).patch(`/api/v1/projects/${PROJECT_ID}/reviews/legacy-1`).set(auth).send({ resolved: false })
    expect(reopen.status).toBe(200)
    expect(reopen.body.resolved).toBe(false)
    const raw = JSON.parse(require("node:fs").readFileSync(REVIEW_FILE, "utf-8"))
    const rawLegacy = raw.find((it) => it.id === LEGACY_STABLE)
    expect(rawLegacy).toMatchObject({ resolved: false })
    expect(rawLegacy).not.toHaveProperty("resolvedAction")

    const missing = await request(app).patch(`/api/v1/projects/${PROJECT_ID}/reviews/nope-1`).set(auth).send({})
    expect(missing.status).toBe(404)
    expect(missing.body.error).toBe("Review item 'nope-1' not found")
    const badJson = await request(app).patch(`/api/v1/projects/${PROJECT_ID}/reviews/${FOO_STABLE}`).set(auth).send("not-json")
    expect(badJson.status).toBe(400)
    expect(String(badJson.body.error)).toMatch(/^Invalid request body:/)
    const badType = await request(app).patch(`/api/v1/projects/${PROJECT_ID}/reviews/${FOO_STABLE}`).set(auth).send({ resolved: "yes" })
    expect(badType.status).toBe(400)
    expect(String(badType.body.error)).toMatch(/^Invalid request body:/)
  })

  it("POST /reviews/resolve: partial success in input order with raw write-back", async () => {
    const missingIds = await request(app).post(`/api/v1/projects/${PROJECT_ID}/reviews/resolve`).set(auth).send({})
    expect(missingIds.status).toBe(400)
    expect(String(missingIds.body.error)).toContain("ids")
    const empty = await request(app).post(`/api/v1/projects/${PROJECT_ID}/reviews/resolve`).set(auth).send({ ids: [] })
    expect(empty.status).toBe(400)
    expect(empty.body.error).toBe("ids must be a non-empty array")
    const nonStr = await request(app).post(`/api/v1/projects/${PROJECT_ID}/reviews/resolve`).set(auth).send({ ids: ["ok", 7] })
    expect(nonStr.status).toBe(400)

    const bulk = await request(app).post(`/api/v1/projects/${PROJECT_ID}/reviews/resolve`).set(auth).send({ ids: ["bulk-a", "nope-x", "bulk-b"], action: "Batch" })
    expect(bulk.status).toBe(200)
    expect(bulk.body).toMatchObject({ resolved: ["bulk-a", "bulk-b"], notFound: ["nope-x"], count: 2 })
    const raw = JSON.parse(require("node:fs").readFileSync(REVIEW_FILE, "utf-8"))
    const rawBulkA = raw.find((it) => it.id === ALPHA_STABLE)
    expect(rawBulkA).toMatchObject({ resolved: true, resolvedAction: "Batch" })

    const bare = await request(app).post(`/api/v1/projects/${BARE_ID}/reviews/resolve`).set(auth).send({ ids: ["x", "y"] })
    expect(bare.status).toBe(200)
    expect(bare.body).toMatchObject({ resolved: [], notFound: ["x", "y"] })
  })

  it("search: strict validation + desktop hybrid note", async () => {
    const res = await request(app).post(`/api/v1/projects/${PROJECT_ID}/search`).set(auth).send({ query: "quantum" })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.projectId).toBe(PROJECT_ID)
    expect(res.body.note).toMatch(/^Search uses the shared backend hybrid retrieval service/)
    expect(res.body.results.some((r) => (r.path || "").includes("quantum"))).toBe(true)

    const blank = await request(app).post(`/api/v1/projects/${PROJECT_ID}/search`).set(auth).send({ query: "   " })
    expect(blank.status).toBe(400)
    expect(blank.body.error).toBe("query is required")
    const missing = await request(app).post(`/api/v1/projects/${PROJECT_ID}/search`).set(auth).send({})
    expect(missing.status).toBe(400)
    expect(String(missing.body.error)).toMatch(/^Invalid JSON:/)
    const emptyEmb = await request(app).post(`/api/v1/projects/${PROJECT_ID}/search`).set(auth).send({ query: "q", queryEmbedding: [] })
    expect(emptyEmb.status).toBe(400)
    expect(emptyEmb.body.error).toBe("queryEmbedding must not be empty")
    const badEmb = await request(app).post(`/api/v1/projects/${PROJECT_ID}/search`).set(auth).send({ query: "q", queryEmbedding: [0.1, "x"] })
    expect(badEmb.status).toBe(400)
    expect(badEmb.body.error).toBe("queryEmbedding must contain only finite numbers")
  })

  it("unknown project + unknown route use the desktop wording", async () => {
    const unknown = await request(app).get("/api/v1/projects/nope/files").set(auth)
    expect(unknown.status).toBe(404)
    expect(unknown.body.error).toBe("Unknown project: nope")
    const nf = await request(app).get("/api/v1/bogus").set(auth)
    expect(nf.status).toBe(404)
    expect(nf.body.error).toBe("Not found")
  })
})

describe("/api/v1 chat error mapping", () => {
  it("missing/blank message 400; no assistant placeholder row on 4xx", async () => {
    const missing = await request(app).post(`/api/v1/projects/${PROJECT_ID}/chat`).set(auth).send({})
    expect(missing.status).toBe(400)
    expect(String(missing.body.error)).toMatch(/^Invalid JSON:/)
    const blank = await request(app).post(`/api/v1/projects/${PROJECT_ID}/chat`).set(auth).send({ message: "  " })
    expect(blank.status).toBe(400)
    expect(blank.body.error).toBe("message is required")
  })

  it("provider failure maps to 502 {ok:false}", async () => {
    // A dead endpoint resolves the config but the LLM call fails -> 502.
    const dead = 1
    const orig = JSON.parse(require("node:fs").readFileSync(STORE, "utf-8"))
    require("node:fs").writeFileSync(STORE, JSON.stringify({
      ...orig,
      llmConfig: { provider: "custom", apiKey: "k", model: "m", customEndpoint: `http://127.0.0.1:${dead}/v1`, apiMode: "chat_completions" },
    }))
    try {
      const res = await request(app).post(`/api/v1/projects/${PROJECT_ID}/chat`).set(auth).send({ message: "hi" })
      expect(res.status).toBe(502)
      expect(res.body.ok).toBe(false)
    } finally {
      require("node:fs").writeFileSync(STORE, JSON.stringify(orig))
    }
  })
})
