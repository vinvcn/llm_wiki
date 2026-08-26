// Issue #38 — SearchResultSchema must describe the live search payload.
//
// The SSOT used to declare only `{ path, score, snippet?, content? }`, so
// zod's default object parse silently stripped `title`, `titleMatch`,
// `images` and `vectorScore` from real search responses (and z.infer omitted
// them at the type level). These tests round-trip the REAL `search_project`
// command output through the schema — keyword leg, and the vector-blended
// leg when sqlite-vec is available — and assert zero field loss, so the
// published contract stays honest (same zero-drift spirit as #20 / #24).

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

process.env.LLM_WIKI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-search-ssot-"))
process.env.LLM_WIKI_NO_SHARE = "1" // never touch a real desktop app-state.json

const { SearchResponseSchema, SearchResultImageSchema } = await import("@llm-wiki/api-types")
const { getDb, isVecAvailable } = await import("../src/store/db.js")
const { searchCommands } = await import("../src/commands/search.js")
const { vectorCommands } = await import("../src/commands/vectorstore.js")

getDb() // run migrations + load sqlite-vec before isVecAvailable evaluates

const unit = (x) => {
  const n = Math.sqrt(x.reduce((s, v) => s + v * v, 0))
  return x.map((v) => v / n)
}
const NEAR = unit([0.99, 0.1, 0, 0]) // Alpha chunk — close to the query direction
const EMB_CFG = { enabled: true, endpoint: "http://unused.local", model: "test" }

let project
const cleanups = []

function seedWiki() {
  project = mkdtempSync(path.join(tmpdir(), "llmwiki-search-ssot-proj-"))
  cleanups.push(project)
  mkdirSync(path.join(project, ".llm-wiki"), { recursive: true })
  mkdirSync(path.join(project, "wiki"), { recursive: true })
  writeFileSync(path.join(project, ".llm-wiki", "project.json"), JSON.stringify({ id: "search-ssot-project" }))
  writeFileSync(
    path.join(project, "wiki", "Alpha.md"),
    "# Alpha\n\nzebra stripes are visually unique patterns\n\n![zebra](zebra.png)\n",
  )
  writeFileSync(
    path.join(project, "wiki", "Beta.md"),
    "# Beta\n\nquantum fields permeate spacetime\n",
  )
}

/** The exact envelope the v2 search route serializes (api/search.js). */
function envelope(r) {
  return {
    results: r.results,
    mode: r.mode,
    tokenHits: r.tokenHits,
    vectorHits: r.vectorHits,
    graphHits: r.graphHits,
    ...(r.vectorUnavailableReason ? { vectorUnavailableReason: r.vectorUnavailableReason } : {}),
  }
}

describe("issue #38 — SearchResultSchema matches the live search payload", () => {
  beforeAll(seedWiki)
  afterAll(() => {
    for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
    rmSync(process.env.LLM_WIKI_DATA_DIR, { recursive: true, force: true })
  })

  it("the reported repro no longer strips title/titleMatch/images", () => {
    const live = {
      results: [{
        path: "wiki/x.md", title: "X", snippet: "s", titleMatch: true,
        score: 1, images: [{ url: "a.png", alt: "" }], vectorScore: 0.9,
      }],
      mode: "hybrid", tokenHits: 1, vectorHits: 1, graphHits: 0,
    }
    const parsed = SearchResponseSchema.parse(live)
    expect(parsed.results[0]).toEqual(live.results[0])
    expect(parsed.results[0].vectorScore).toBe(0.9)
  })

  it("SearchResultImageSchema accepts the server's {url, alt} image shape", () => {
    const img = SearchResultImageSchema.parse({ url: "zebra.png", alt: "zebra" })
    expect(img).toEqual({ url: "zebra.png", alt: "zebra" })
  })

  it("real keyword-leg results keep title/titleMatch/images through the schema", async () => {
    // Title match: the query appears in the page title.
    const r = await searchCommands.search_project({
      projectPath: project, query: "alpha", wikiSearchMode: "keyword", embeddingConfig: null,
    })
    expect(r.tokenHits).toBeGreaterThan(0)
    const parsed = SearchResponseSchema.parse(envelope(r))
    expect(parsed.results.length).toBeGreaterThan(0)
    const hit = parsed.results.find((x) => x.path.endsWith("Alpha.md"))
    expect(hit).toBeDefined()
    expect(hit.title).toBe("Alpha")
    expect(hit.titleMatch).toBe(true)
    expect(hit.images).toContainEqual({ url: "zebra.png", alt: "zebra" })
    expect(typeof hit.snippet).toBe("string") // always present at runtime
    expect(typeof hit.score).toBe("number")
    expect(parsed.mode).toBe("keyword")
    expect(parsed.vectorHits).toBe(0)

    // Body-only match: titleMatch stays a boolean (false here), proving the
    // field survives parsing as the real server emitted it.
    const r2 = await searchCommands.search_project({
      projectPath: project, query: "zebra", wikiSearchMode: "keyword", embeddingConfig: null,
    })
    const parsed2 = SearchResponseSchema.parse(envelope(r2))
    const bodyHit = parsed2.results.find((x) => x.path.endsWith("Alpha.md"))
    expect(bodyHit).toBeDefined()
    expect(bodyHit.titleMatch).toBe(false)
  })

  it("vector-blended results keep vectorScore when the vector leg runs", async () => {
    if (!isVecAvailable()) return // graceful on hosts without the sqlite-vec extension
    await vectorCommands.vector_upsert_chunks({
      projectPath: project, pageId: "Alpha",
      chunks: [{ chunk_index: 0, chunk_text: "zebra stripes section", heading_path: "Alpha", embedding: NEAR }],
    })
    const r = await searchCommands.search_project({
      projectPath: project, query: "xylophone concerto", wikiSearchMode: "hybrid",
      queryEmbedding: NEAR, embeddingConfig: EMB_CFG,
    })
    expect(r.vectorHits).toBeGreaterThan(0)
    const parsed = SearchResponseSchema.parse(envelope(r))
    const withVec = parsed.results.filter((x) => x.vectorScore != null)
    expect(withVec.length).toBeGreaterThan(0)
    expect(typeof withVec[0].vectorScore).toBe("number")
    // vectorScore survives the round-trip unchanged (RRF overwrites score,
    // not vectorScore)
    const rawWithVec = r.results.filter((x) => x.vectorScore != null)
    expect(withVec.map((x) => x.vectorScore)).toEqual(rawWithVec.map((x) => x.vectorScore))
  })
})
