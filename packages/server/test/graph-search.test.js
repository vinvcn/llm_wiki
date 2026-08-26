// graph.search + graph-boosted search-blend tests.
//
// searchGraph is the server port of the desktop's agent tool
// (src-tauri/src/agent/tools.rs::search_graph). The first suite ports the
// desktop's own unit-test fixture verbatim
// (search_graph_returns_relationship_references); the remaining suites cover
// the boundary cases and the search-result blending used by search_project
// (blend_graph_results).

import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { searchGraph, blendGraphResults } from "../src/graph.js"

const cleanups = []
function makeProject() {
  const root = mkdtempSync(path.join(tmpdir(), "llm-wiki-graph-test-"))
  cleanups.push(root)
  return root
}
function writeWiki(root, rel, content) {
  const full = path.join(root, "wiki", rel)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
}
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("searchGraph (search_graph_returns_relationship_references)", () => {
  it("returns the matched entity plus direct wikilink neighbors (Rust fixture)", () => {
    const root = makeProject()
    writeWiki(root, "concepts/agent.md",
      "---\ntitle: Agent Graph\n---\n# Agent Graph\n\nLinks to [[Tool Registry]] and [[Context Builder]].")
    writeWiki(root, "concepts/tool-registry.md",
      "---\ntitle: Tool Registry\n---\n# Tool Registry\n\nTool definitions.")
    writeWiki(root, "concepts/context-builder.md",
      "---\ntitle: Context Builder\n---\n# Context Builder\n\nContext assembly.")
    writeWiki(root, "concepts/unrelated.md",
      "---\ntitle: Unrelated Hub\n---\n# Unrelated Hub\n\n[[Missing A]] [[Missing B]] [[Missing C]].")

    const refs = searchGraph(root, "Agent Graph", 5)
    expect(refs).toHaveLength(3)
    expect(refs[0].title).toBe("Agent Graph")
    expect(refs[0].snippet).toContain("matched entity")
    expect(refs.slice(1).every((r) => r.kind === "graph" && r.snippet.includes("direct neighbor"))).toBe(true)
    expect(refs.map((r) => r.title)).toEqual(expect.arrayContaining(["Tool Registry", "Context Builder"]))
    expect(refs.map((r) => r.title)).not.toContain("Unrelated Hub")
    // knowledge_context is present on every reference (desktop AgentReference).
    for (const ref of refs) {
      expect(ref.knowledgeContext).toEqual({
        relatedTo: [],
        tags: [],
        outgoingLinks: expect.any(Array),
        backlinks: expect.any(Array),
        linkCount: expect.any(Number),
      })
    }
  })

  it("returns [] for an empty query", () => {
    const root = makeProject()
    writeWiki(root, "a.md", "# A\n")
    expect(searchGraph(root, "   ", 5)).toEqual([])
  })

  it("returns [] when no page matches the query", () => {
    const root = makeProject()
    writeWiki(root, "a.md", "# Alpha\n\n[[Beta]]")
    writeWiki(root, "b.md", "# Beta\n")
    expect(searchGraph(root, "zzz no match", 5)).toEqual([])
  })

  it("clamps top_k to the desktop's 1..10 range", () => {
    const root = makeProject()
    for (let i = 0; i < 12; i++) writeWiki(root, `p${i}.md`, `# P${i}\n\ncommonterm`)
    // "commonterm" matches all 12 pages → k=99 clamps to 10.
    expect(searchGraph(root, "commonterm", 99)).toHaveLength(10)
    // "P11" matches a single page (the "11" term is unique) → k=0 clamps to 1.
    expect(searchGraph(root, "P11", 0)).toHaveLength(1)
  })
})

describe("blendGraphResults (blend_graph_results)", () => {
  it("synthesizes 'Graph neighbor of …' results when a ranked page links to others", () => {
    const ranked = [{ path: "wiki/a.md", title: "Alpha", snippet: "alpha text", titleMatch: true, score: 9 }]
    const graphPages = [
      { path: "wiki/a.md", title: "Alpha", links: ["Beta"], content: "# Alpha\n" },
      { path: "wiki/b.md", title: "Beta", links: [], content: "# Beta\n" },
      { path: "wiki/c.md", title: "Gamma", links: [], content: "# Gamma\n" },
    ]
    const { results, graphHits } = blendGraphResults(ranked, graphPages, 5, 0)
    expect(graphHits).toBe(1)
    expect(results.map((r) => r.title)).toEqual(["Alpha", "Beta"])
    const beta = results.find((r) => r.title === "Beta")
    expect(beta.snippet).toBe("Graph neighbor of Alpha")
    expect(beta.titleMatch).toBe(false)
    expect(beta.graphRelatedTo).toEqual(["Alpha"])
  })

  it("marks an already-ranked result past the limit with graphRelatedTo", () => {
    // limit=2 seeds a,b; c is ranked #3 but is also a direct neighbor of a so
    // it becomes a graph candidate and keeps its keyword snippet (the
    // existing.has(p) branch in blend_graph_results).
    const ranked = [
      { path: "wiki/a.md", title: "Alpha", snippet: "a", titleMatch: true, score: 9 },
      { path: "wiki/b.md", title: "Beta", snippet: "b", titleMatch: true, score: 8 },
      { path: "wiki/c.md", title: "Gamma", snippet: "c", titleMatch: true, score: 7 },
    ]
    const graphPages = [
      { path: "wiki/a.md", title: "Alpha", links: ["Gamma"], content: "# Alpha\n" },
      { path: "wiki/b.md", title: "Beta", links: [], content: "# Beta\n" },
      { path: "wiki/c.md", title: "Gamma", links: [], content: "# Gamma\n" },
    ]
    const { results, graphHits } = blendGraphResults(ranked, graphPages, 2, 0)
    expect(graphHits).toBe(1)
    const gamma = results.find((r) => r.title === "Gamma")
    expect(gamma).toBeDefined()
    expect(gamma.snippet).toBe("c") // keyword snippet preserved
    expect(gamma.graphRelatedTo).toEqual(["Alpha"])
  })

  it("passes through unchanged when there are no graph candidates", () => {
    const ranked = [{ path: "wiki/a.md", title: "Alpha", snippet: "alpha", titleMatch: true, score: 9 }]
    const graphPages = [
      { path: "wiki/a.md", title: "Alpha", links: [], content: "# Alpha\n" },
      { path: "wiki/b.md", title: "Beta", links: [], content: "# Beta\n" },
    ]
    const { results, graphHits } = blendGraphResults(ranked, graphPages, 5, 0)
    expect(graphHits).toBe(0)
    expect(results).toEqual(ranked)
  })

  it("passes through unchanged when there are no graph pages at all", () => {
    const ranked = [{ path: "wiki/a.md", title: "Alpha", snippet: "alpha", titleMatch: true, score: 9 }]
    const { results, graphHits } = blendGraphResults(ranked, [], 5)
    expect(graphHits).toBe(0)
    expect(results).toEqual(ranked)
  })
})
