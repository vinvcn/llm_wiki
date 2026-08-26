// End-to-end verification of the Agent `graph.search` tool and the
// graph-boosted search blending through the REAL server surfaces
// (priority-2 parity item: "graph.search + graph-boosted search").
//
// graph.js's searchGraph/blendGraphResults are unit-tested in
// graph-search.test.js; this suite proves the WIRING:
//   - a scripted mock LLM issues a graph.search tool call during a real
//     agentStartTurnStream turn; the real tool executor runs the wiki
//     neighbor expansion and the turn emits the desktop's exact event
//     sequence (toolStart -> referenceAdded x2 -> toolEnd -> messageDelta
//     -> done), the references carry the desktop AgentReference serde
//     shape (kind "graph", camelCase knowledgeContext), and the follow-up
//     LLM request receives the tool observation;
//   - the same for the non-stream path (agentStartTurn): BackendAgentResponse
//     with message / references / toolEvents and no messageDelta events;
//   - searchCommands.search_project blends keyword + graph on a wiki whose
//     pages link to each other: mode "hybrid", graphHits > 0, and a
//     synthesized "Graph neighbor of …" result (blend_graph_results wired
//     into the real command path the search UI, v1/v2 routes and agent
//     wiki.search all use).
//
// llm-call.js is mocked (scriptable streamCall/blockingCall) so no real LLM
// is touched; the graph executor and search command run the real code paths.

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const { streamCallMock, blockingCallMock } = vi.hoisted(() => ({
  streamCallMock: vi.fn(),
  blockingCallMock: vi.fn(),
}))

vi.mock("../src/llm-call.js", () => ({
  streamCall: (...args) => streamCallMock(...args),
  blockingCall: (...args) => blockingCallMock(...args),
}))

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-graph-tool-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1" // never touch a real desktop app-state.json
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const PROJECT_UUID = "graph-tool-proj-uuid"
const PROJECT_PATH = path.join(DATA_DIR, "graph-tool-proj")
const cleanups = [DATA_DIR]

function writeWiki(rel, content) {
  const full = path.join(PROJECT_PATH, "wiki", rel)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
}

beforeAll(() => {
  mkdirSync(path.join(PROJECT_PATH, "raw", "sources"), { recursive: true })
  // Attention links to Transformer; the graph.search tool must return both
  // the matched entity and the direct neighbor with the desktop reference shape.
  // Query terms appear in exactly ONE page: "attention" only in attention.md
  // (the link text `[[Transformer]]` is content, so transformer.md deliberately
  // avoids every query term below) — the graph tool must then report one
  // matched entity + one direct neighbor, never two matched entities.
  writeWiki("concepts/attention.md",
    "# Attention\n\nSalient tokens get weighted connections.\n\nRelated: [[Transformer]]\n")
  writeWiki("concepts/transformer.md",
    "# Transformer\n\nEncoder-decoder blocks stack layers.\n")
  mkdirSync(path.join(DATA_DIR, "stores"), { recursive: true })
  writeFileSync(path.join(DATA_DIR, "stores", "app-state.json"), JSON.stringify({
    projectRegistry: {
      [PROJECT_UUID]: { id: PROJECT_UUID, path: PROJECT_PATH },
    },
    llmConfig: { provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" },
  }))
})

afterAll(() => {
  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* noop */ }
  }
})

beforeEach(() => {
  streamCallMock.mockReset()
  blockingCallMock.mockReset()
})

const { agentStartTurnStream, agentStartTurn } = await import("../src/agent.js")
const { eventBus } = await import("../src/events/bus.js")
const { ensureProjectRow } = await import("../src/store/projects.js")

beforeAll(() => {
  // Materialize the projects-table row the same way the first turn does; the
  // chat:* dual frames attribute their payloads with it.
  ensureProjectRow({ uuid: PROJECT_UUID, path: PROJECT_PATH })
})

function turnRequest(sessionId, runId, message) {
  return {
    message,
    sessionId,
    runId,
    mode: "standard",
    tools: { wiki: false, web: false, anytxt: false },
    topK: 5,
    includeContent: false,
    skills: [],
    resume: false,
  }
}

function watchAgentEvents(sessionId) {
  const frames = []
  let resolveDone
  const donePromise = new Promise((resolve) => { resolveDone = resolve })
  const unsub = eventBus.subscribe((env) => {
    if (env.type !== "agent-event") return
    const p = env.payload ?? {}
    if (p.sessionId !== sessionId) return
    frames.push(p)
    if (p.event?.type === "done") resolveDone()
  })
  return {
    frames,
    async waitDone(timeoutMs = 6000) {
      await Promise.race([
        donePromise,
        new Promise((_, rej) => setTimeout(
          () => rej(new Error(`timed out waiting for done (got ${frames.length} frames)`)),
          timeoutMs,
        )),
      ])
      unsub()
    },
    unsub,
  }
}

function eventsOf(watcher, type) {
  return watcher.frames.filter((f) => f.event?.type === type).map((f) => f.event)
}

describe("agent graph.search tool (streaming turn, desktop event contract)", () => {
  it("emits toolStart -> referenceAdded x2 -> toolEnd -> messageDelta -> done with desktop AgentReference shapes", async () => {
    streamCallMock
      .mockImplementationOnce(async function* () {
        yield { type: "tool_call", id: "call_g1", name: "graph.search", args: { query: "Attention", top_k: 5 } }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "delta", text: "The graph links " }
        yield { type: "delta", text: "Transformer." }
        yield { type: "finish" }
      })

    const sessionId = "conv_graph_stream"
    const runId = "run-graph-stream"
    const watcher = watchAgentEvents(sessionId)
    try {
      const returned = await agentStartTurnStream({
        projectId: PROJECT_UUID,
        request: turnRequest(sessionId, runId, "Use the graph to find what relates to Attention"),
      })
      expect(returned).toBe(runId)
      await watcher.waitDone()

      expect(watcher.frames.map((f) => f.event.type)).toEqual([
        "toolStart", "referenceAdded", "referenceAdded", "toolEnd",
        "messageDelta", "messageDelta", "done",
      ])
      for (const frame of watcher.frames) {
        expect(frame.sessionId).toBe(sessionId)
        expect(frame.runId).toBe(runId)
      }

      const starts = eventsOf(watcher, "toolStart")
      expect(starts).toHaveLength(1)
      expect(starts[0].tool).toBe("graph.search")

      const refs = eventsOf(watcher, "referenceAdded").map((e) => e.reference)
      expect(refs).toHaveLength(2)
      const matched = refs.find((r) => r.snippet?.includes("matched entity"))
      const neighbor = refs.find((r) => r.snippet?.includes("direct neighbor"))
      expect(matched?.title).toBe("Attention")
      expect(neighbor?.title).toBe("Transformer")
      for (const ref of refs) {
        // Desktop AgentReference serde shape (kind "graph" + camelCase knowledgeContext).
        expect(ref.kind).toBe("graph")
        expect(ref.path).toContain("wiki/concepts/")
        expect(typeof ref.score).toBe("number")
        expect(ref.knowledgeContext).toMatchObject({
          relatedTo: expect.any(Array),
          tags: expect.any(Array),
          outgoingLinks: expect.any(Array),
          backlinks: expect.any(Array),
          linkCount: expect.any(Number),
        })
      }

      const ends = eventsOf(watcher, "toolEnd")
      expect(ends).toHaveLength(1)
      expect(ends[0].tool).toBe("graph.search")
      expect(ends[0].output).toContain("matched entity")
      expect(ends[0].output).toContain("Transformer")

      const deltas = eventsOf(watcher, "messageDelta")
      expect(deltas.map((d) => d.text)).toEqual(["The graph links ", "Transformer."])

      const done = eventsOf(watcher, "done")
      expect(done[0].text).toBe("The graph links Transformer.")
      expect(done[0].references).toHaveLength(2)
    } finally {
      watcher.unsub()
    }
  })

  it("feeds the graph.search observation back into the follow-up LLM request (tool result round-trip)", async () => {
    streamCallMock
      .mockImplementationOnce(async function* () {
        yield { type: "tool_call", id: "call_g1b", name: "graph.search", args: { query: "layers", top_k: 3 } }
      })
      .mockImplementationOnce(async function* () {
        yield { type: "delta", text: "Found it." }
        yield { type: "finish" }
      })

    const sessionId = "conv_graph_roundtrip"
    const runId = "run-graph-roundtrip"
    const watcher = watchAgentEvents(sessionId)
    try {
      await agentStartTurnStream({
        projectId: PROJECT_UUID,
        request: turnRequest(sessionId, runId, "Use graph"),
      })
      await watcher.waitDone()
    } finally {
      watcher.unsub()
    }

    expect(streamCallMock).toHaveBeenCalledTimes(2)
    const followUp = streamCallMock.mock.calls[1][0]
    const toolMsg = followUp.messages.find((m) => m.role === "tool")
    expect(toolMsg).toBeTruthy()
    expect(toolMsg.name).toBe("graph.search")
    expect(String(toolMsg.content)).toContain("matched entity")
    expect(String(toolMsg.content)).toContain("direct neighbor")
  })
})

describe("agent graph.search tool (non-stream turn, BackendAgentResponse)", () => {
  it("returns the message, desktop-shaped references, toolEvents — and no messageDelta events", async () => {
    blockingCallMock
      .mockImplementationOnce(async () => ({
        content: null,
        toolCalls: [{ id: "call_g2", name: "graph.search", args: { query: "layers", top_k: 3 } }],
      }))
      .mockImplementationOnce(async () => ({ content: "Transformer is the neighbor.", toolCalls: [] }))

    const sessionId = "conv_graph_blocking"
    const runId = "run-graph-blocking"
    const watcher = watchAgentEvents(sessionId)
    let result
    try {
      result = await agentStartTurn({
        projectId: PROJECT_UUID,
        request: turnRequest(sessionId, runId, "Use graph blocking"),
      })
    } finally {
      watcher.unsub()
    }

    expect(result.message).toBe("Transformer is the neighbor.")
    expect(result.references).toHaveLength(2)
    const matched = result.references.find((r) => r.snippet?.includes("matched entity"))
    const neighbor = result.references.find((r) => r.snippet?.includes("direct neighbor"))
    expect(matched?.title).toBe("Transformer")
    expect(neighbor?.title).toBe("Attention")
    for (const ref of result.references) {
      expect(ref.kind).toBe("graph")
      expect(ref.knowledgeContext).toBeTruthy()
      expect(typeof ref.score).toBe("number")
    }
    expect(result.toolEvents.some((t) => t.tool === "graph.search" && t.status === "completed")).toBe(true)
    const evTypes = (result.events ?? []).map((e) => e.type)
    expect(evTypes).toContain("toolStart")
    expect(evTypes).toContain("referenceAdded")
    expect(evTypes).toContain("toolEnd")
    expect(evTypes).not.toContain("messageDelta")
  })
})

// ── graph-boosted search through the real search_project command ──────────
describe("graph-boosted search via searchCommands.search_project", () => {
  it("returns mode hybrid, graphHits > 0 and a synthesized 'Graph neighbor of …' result", async () => {
    const project = mkdtempSync(path.join(tmpdir(), "llmwiki-graph-blend-proj-"))
    cleanups.push(project)
    mkdirSync(path.join(project, "wiki"), { recursive: true })
    writeFileSync(path.join(project, "wiki", "Alpha.md"),
      "# Alpha\n\nzebra stripes are visually unique patterns\n\nRelated: [[Beta]]\n")
    writeFileSync(path.join(project, "wiki", "Beta.md"),
      "# Beta\n\nquantum fields permeate spacetime\n")

    const { searchCommands } = await import("../src/commands/search.js")
    const r = await searchCommands.search_project({
      projectPath: project,
      query: "alpha",
      topK: 5,
      wikiSearchMode: "keyword", // no vector leg: the blend is keyword + graph
    })

    expect(r.graphHits).toBe(1)
    expect(r.mode).toBe("hybrid")
    const alpha = r.results.find((x) => x.title === "Alpha")
    const beta = r.results.find((x) => x.title === "Beta")
    expect(alpha).toBeTruthy()
    expect(beta).toBeTruthy()
    expect(beta.snippet).toBe("Graph neighbor of Alpha")
    expect(beta.titleMatch).toBe(false)
    expect(beta.graphRelatedTo).toEqual(["Alpha"])
    // The ranked page stays first; the synthesized neighbor follows.
    expect(r.results[0].title).toBe("Alpha")
  })
})
