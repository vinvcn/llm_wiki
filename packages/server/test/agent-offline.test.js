// Offline agent degradation tests (agent-legacy.js — the desktop runtime.rs
// branch that runs when the resolved chat config is NOT usable for backend
// HTTP). The turn never calls an LLM and never surfaces a provider/network
// error: it runs the deterministic router + retrieval pipeline and answers
// with the retrieval summary (ok:true). This suite pins:
//   - the pure router/answer helpers (routeQuery, shouldPlanToolsWithModel,
//     buildRetrievalAnswer, collapseWhitespace) + provider.rs
//     is_usable_for_backend_http semantics;
//   - the real non-stream path (agentStartTurn) with a fresh store (no
//     llmConfig) and with a claude-code CLI provider (normalizeEndpoint would
//     otherwise throw "requires the desktop app"): exact desktop answer text,
//     wiki reference, toolEvents with mode/hits detail, events vector
//     (toolStart / referenceAdded / toolEnd / done), ZERO llm-call hits;
//   - the streaming path (agentStartTurnStream): SSE sequence
//     toolStart -> referenceAdded -> toolEnd -> done, no messageDelta/error,
//     done.text carries the retrieval answer;
//   - router gating: no tools -> exact desktop fallback string; skill active
//     -> router-intent fallback + skills.load toolEnd; shell.exec via
//     request.shellCommand -> unapproved/approved desktop contracts;
//   - a USABLE config still runs the real loop (regression guard).

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
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

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-agent-offline-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const PROJECT_UUID = "offline-proj-uuid"
const PROJECT_PATH = path.join(DATA_DIR, "offline-proj")
const STORE_FILE = path.join(DATA_DIR, "stores", "app-state.json")

function writeStore(extra = {}) {
  mkdirSync(path.dirname(STORE_FILE), { recursive: true })
  writeFileSync(STORE_FILE, JSON.stringify({
    projectRegistry: { [PROJECT_UUID]: { id: PROJECT_UUID, path: PROJECT_PATH } },
    lastProject: { id: PROJECT_UUID, path: PROJECT_PATH },
    ...extra,
  }, null, 2))
}

beforeAll(() => {
  mkdirSync(path.join(PROJECT_PATH, "wiki"), { recursive: true })
  mkdirSync(path.join(PROJECT_PATH, "raw", "sources"), { recursive: true })
  mkdirSync(path.join(PROJECT_PATH, ".llm-wiki", "skills", "greeter"), { recursive: true })
  writeFileSync(path.join(PROJECT_PATH, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n")
  writeFileSync(path.join(PROJECT_PATH, "wiki", "alpha.md"),
    "---\ntype: entity\ntitle: Alpha\n---\n# Alpha\n\nAlpha is the first concept of this wiki. It links to [[beta]].\n")
  writeFileSync(path.join(PROJECT_PATH, "wiki", "beta.md"),
    "---\ntype: entity\ntitle: Beta\n---\n# Beta\n\nBeta follows alpha.\n")
  writeFileSync(path.join(PROJECT_PATH, "raw", "sources", "notes.md"),
    "---\ntitle: Notes\n---\nAlpha appears in the raw source notes too.\n")
  writeFileSync(path.join(PROJECT_PATH, ".llm-wiki", "skills", "greeter", "SKILL.md"),
    "---\nname: greeter\ndescription: A tiny test skill.\n---\nSay hello.\n")
  writeStore({}) // fresh: no llmConfig at all
})

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

beforeEach(() => {
  streamCallMock.mockReset()
  blockingCallMock.mockReset()
})

const { agentStartTurnStream, agentStartTurn } = await import("../src/agent.js")
const { eventBus } = await import("../src/events/bus.js")
const { routeQuery, shouldPlanToolsWithModel, buildRetrievalAnswer, collapseWhitespace } =
  await import("../src/agent-legacy.js")
const { isUsableForBackendHttp } = await import("../src/llm-resolve.js")

function watchEvents(sessionId) {
  const agentEvents = []
  let resolveDone
  const donePromise = new Promise((resolve) => { resolveDone = resolve })
  const unsub = eventBus.subscribe((env) => {
    if (env.type !== "agent-event") return
    const p = env.payload ?? {}
    if (p.sessionId !== sessionId) return
    agentEvents.push(p)
    if (p.event?.type === "done") resolveDone()
  })
  return {
    agentEvents,
    async waitDone(timeoutMs = 5000) {
      await Promise.race([
        donePromise,
        new Promise((_, rej) => setTimeout(
          () => rej(new Error(`timed out waiting for done (got ${agentEvents.length} frames)`)),
          timeoutMs,
        )),
      ])
      unsub()
    },
    unsub,
  }
}

const baseReq = (message, extra = {}) => ({
  message,
  sessionId: "off-s1",
  runId: "off-r1",
  persistSession: false,
  mode: "standard",
  tools: { wiki: true, web: false, anytxt: false },
  ...extra,
})

describe("agent-legacy router + answer helpers", () => {
  it("collapse_whitespace", () => {
    expect(collapseWhitespace("  a\n b\t c  ")).toBe("a b c")
    expect(collapseWhitespace("")).toBe("")
  })

  it("route_query intent classification (Rust fixtures)", () => {
    expect(routeQuery("hi there", "standard", {}).intent).toBe("conversation")
    expect(routeQuery("search the web for news", "standard", {}).intent).toBe("external_search")
    expect(routeQuery("show me the graph relationships", "standard", {}).intent).toBe("graph")
    expect(routeQuery("read the raw source file", "standard", {}).intent).toBe("raw_source_search")
    expect(routeQuery("write to wiki a new page", "standard", {}).intent).toBe("write")
    expect(routeQuery("what is alpha?", "standard", {}).intent).toBe("ambiguous")
    // intent is conservative: it never enables wiki search by itself
    expect(routeQuery("what is alpha?", "standard", {}).shouldSearchWiki).toBe(false)
    expect(routeQuery("hello", "standard", { web: true }).shouldHintWeb).toBe(true)
    expect(routeQuery("hello", "standard", { anytxt: true }).shouldHintAnytxt).toBe(true)
  })

  it("should_plan_tools_with_model", () => {
    expect(shouldPlanToolsWithModel("", "standard", { wiki: true }, false)).toBe(false)
    expect(shouldPlanToolsWithModel("hello", "fast", { wiki: true }, false)).toBe(false)
    expect(shouldPlanToolsWithModel("hello", "standard", { wiki: false, web: true }, false)).toBe(true)
    expect(shouldPlanToolsWithModel("hello", "standard", { wiki: false, web: false }, true)).toBe(true)
    expect(shouldPlanToolsWithModel("hello", "standard", { wiki: false, web: false }, false)).toBe(false)
  })

  it("build_retrieval_answer found/not-found shapes", () => {
    const got = buildRetrievalAnswer("What is alpha?", [
      { title: "Alpha", path: "wiki/alpha.md", snippet: "  Alpha   is   first " },
    ])
    expect(got).toContain('I searched the current LLM Wiki project for "What is alpha?" and found 1 relevant page(s):')
    expect(got).toContain("1. Alpha (wiki/alpha.md)")
    expect(got).toContain("Alpha is first")
    expect(buildRetrievalAnswer("nope", [])).toBe(
      'I searched the current LLM Wiki project for "nope" but did not find matching wiki pages.')
  })
})

describe("isUsableForBackendHttp (provider.rs parity)", () => {
  it("HTTP providers need model + credential", () => {
    expect(isUsableForBackendHttp({ provider: "openai", model: "gpt-4o", apiKey: "sk-x" })).toBe(true)
    expect(isUsableForBackendHttp({ provider: "openai", model: "", apiKey: "sk-x" })).toBe(false)
    expect(isUsableForBackendHttp({ provider: "openai", model: "gpt-4o", apiKey: "" })).toBe(false)
    expect(isUsableForBackendHttp({ provider: "anthropic", model: "claude", apiKey: "x" })).toBe(true)
    expect(isUsableForBackendHttp({ provider: "ollama", model: "llama3", ollamaUrl: "http://localhost:11434" })).toBe(true)
    expect(isUsableForBackendHttp({ provider: "ollama", model: "llama3", ollamaUrl: "" })).toBe(false)
    expect(isUsableForBackendHttp({ provider: "custom", model: "m", customEndpoint: "http://127.0.0.1:1/v1" })).toBe(true)
    expect(isUsableForBackendHttp({ provider: "custom", model: "m", customEndpoint: "" })).toBe(false)
  })

  it("CLI providers / unknown / empty config are NOT usable (offline branch)", () => {
    expect(isUsableForBackendHttp({ provider: "claude-code", model: "x" })).toBe(false)
    expect(isUsableForBackendHttp({ provider: "codex-cli", model: "x" })).toBe(false)
    expect(isUsableForBackendHttp({})).toBe(false)
    expect(isUsableForBackendHttp(null)).toBe(false)
    expect(isUsableForBackendHttp({ provider: "weird" })).toBe(false)
  })
})

describe("offline turn: fresh store (no llmConfig)", () => {
  it("non-stream: retrieval answer + toolEvents + events, zero LLM calls", async () => {
    await writeStore({})
    const resp = await agentStartTurn({ projectId: PROJECT_UUID, request: baseReq("What is alpha?") })
    expect(resp.message).toMatch(/^I searched the current LLM Wiki project for "What is alpha\?" and found/)
    expect(resp.references.some((r) => r.path === "wiki/alpha.md")).toBe(true)
    const te = resp.toolEvents ?? []
    expect(te.some((e) => e.tool === "wiki.search" && e.status === "started" && e.detail === "What is alpha?")).toBe(true)
    expect(te.some((e) => e.tool === "wiki.search" && e.status === "completed" && /result\(s\), mode=/.test(e.detail ?? ""))).toBe(true)
    expect(te.some((e) => e.tool === "web.search" && e.status === "available")).toBe(false) // web disabled
    const ev = resp.events ?? []
    expect(ev.some((e) => e.type === "toolStart" && e.tool === "wiki.search")).toBe(true)
    expect(ev.some((e) => e.type === "referenceAdded")).toBe(true)
    expect(ev.some((e) => e.type === "toolEnd" && e.tool === "wiki.search")).toBe(true)
    expect(ev[ev.length - 1]?.type).toBe("done")
    expect(ev.some((e) => e.type === "messageDelta")).toBe(false)
    expect(streamCallMock).not.toHaveBeenCalled()
    expect(blockingCallMock).not.toHaveBeenCalled()
  })

  it("streaming: SSE sequence toolStart -> referenceAdded -> toolEnd -> done, no deltas/errors", async () => {
    await writeStore({})
    const watcher = watchEvents("off-stream")
    const runId = await agentStartTurnStream({
      projectId: PROJECT_UUID,
      request: baseReq("What is alpha?", { sessionId: "off-stream", runId: "off-stream-r1" }),
    })
    expect(runId).toBe("off-stream-r1")
    await watcher.waitDone()
    const evs = watcher.agentEvents.map((p) => p.event)
    const types = evs.map((e) => e.type)
    expect(types[0]).toBe("toolStart")
    expect(types[1]).toBe("referenceAdded")
    expect(types).toContain("toolEnd")
    expect(types[types.length - 1]).toBe("done")
    expect(types).not.toContain("error")
    expect(types).not.toContain("messageDelta")
    const done = evs.find((e) => e.type === "done")
    expect(done.text).toContain("relevant page(s)")
    expect(Array.isArray(done.references) && done.references.length > 0).toBe(true)
    expect(streamCallMock).not.toHaveBeenCalled()
  })
})

describe("offline turn: unusable configs degrade gracefully", () => {
  it("openai without a key: retrieval answer, no LLM call", async () => {
    await writeStore({ llmConfig: { provider: "openai", apiKey: "", model: "gpt-4o", ollamaUrl: "", customEndpoint: "" } })
    const resp = await agentStartTurn({ projectId: PROJECT_UUID, request: baseReq("What is alpha?") })
    expect(resp.message).toContain("relevant page(s)")
    expect(blockingCallMock).not.toHaveBeenCalled()
  })

  it("claude-code CLI provider: graceful (no 'requires the desktop app' error)", async () => {
    await writeStore({ llmConfig: { provider: "claude-code", apiKey: "", model: "claude-sonnet-4-6", ollamaUrl: "", customEndpoint: "" } })
    const resp = await agentStartTurn({ projectId: PROJECT_UUID, request: baseReq("What is alpha?") })
    expect(resp.message).toContain("relevant page(s)")
    expect(resp.message + "").not.toContain("requires the desktop app")
  })

  it("routing preset resolving to codex-cli: graceful", async () => {
    await writeStore({
      llmConfig: { provider: "openai", apiKey: "sk-real", model: "gpt-4o", ollamaUrl: "", customEndpoint: "" },
      taskModelRouting: { chatPresetId: "codex-cli", ingestPresetId: null },
    })
    const resp = await agentStartTurn({ projectId: PROJECT_UUID, request: baseReq("What is alpha?") })
    expect(resp.message).toContain("relevant page(s)")
    expect(blockingCallMock).not.toHaveBeenCalled()
  })
})

describe("offline router gating + shell.exec via request.shellCommand", () => {
  it("no tools: exact desktop fallback string", async () => {
    await writeStore({})
    const resp = await agentStartTurn({ projectId: PROJECT_UUID,
      request: baseReq("hello", { sessionId: "off-g1", runId: "off-g1-r", tools: { wiki: false, web: false, anytxt: false } }) })
    expect(resp.message).toBe("No Agent tools were enabled for this request. Enable wiki, web, or AnyTXT tools to let the backend Agent retrieve supporting context.")
  })

  it("skill active: router-intent fallback + skills.load toolEnd (no toolStart)", async () => {
    await writeStore({})
    const resp = await agentStartTurn({ projectId: PROJECT_UUID,
      request: baseReq("hello", { sessionId: "off-g2", runId: "off-g2-r", skills: ["greeter"], skillMode: "explicit" }) })
    expect(resp.message).toBe("Router intent=conversation did not require immediate wiki.search for this turn.")
    const te = resp.toolEvents ?? []
    expect(te.some((e) => e.tool === "skills.load" && e.status === "completed" && e.detail === "1 skill(s) selected")).toBe(true)
    const ev = resp.events ?? []
    expect(ev.some((e) => e.type === "toolEnd" && e.tool === "skills.load")).toBe(true)
    expect(ev.some((e) => e.type === "toolStart" && e.tool === "skills.load")).toBe(false)
  })

  it("shell.exec unapproved: exact desktop not-run string", async () => {
    await writeStore({})
    const resp = await agentStartTurn({ projectId: PROJECT_UUID,
      request: baseReq("run it", { sessionId: "off-g3", runId: "off-g3-r", skills: ["greeter"], shellCommand: "echo offline-hello" }) })
    expect(resp.message).toContain(
      "shell.exec was requested by an active skill but was not run because the command has not been approved: `echo offline-hello`.")
  })

  it("shell.exec approved: runs with the agent-workspace cwd + desktop summary", async () => {
    await writeStore({})
    const resp = await agentStartTurn({ projectId: PROJECT_UUID,
      request: baseReq("run it", {
        sessionId: "off-g4", runId: "off-g4-r", skills: ["greeter"],
        shellCommand: "echo offline-hello", approvedShellCommands: ["echo offline-hello"],
      }) })
    expect(resp.message).toContain(
      "shell.exec `echo offline-hello` exit=Some(0) timedOut=false\nstdout:\noffline-hello\n\nstderr:\n")
    expect(existsSync(path.join(PROJECT_PATH, "agent-workspace"))).toBe(true)
    expect((resp.toolEvents ?? []).some((e) => e.tool === "shell.exec" && e.status === "completed" && e.detail === "exit=Some(0)")).toBe(true)
  })
})

describe("regression guard: usable config still runs the LLM loop", () => {
  it("custom provider without a key runs the online loop", async () => {
    await writeStore({ llmConfig: { provider: "custom", apiKey: "", model: "mock-model", customEndpoint: "http://127.0.0.1:9/v1", apiMode: "chat_completions" } })
    blockingCallMock.mockResolvedValue({ content: "MOCK_LLM_ANSWER", toolCalls: [] })
    const resp = await agentStartTurn({ projectId: PROJECT_UUID, request: baseReq("anything") })
    expect(resp.message).toBe("MOCK_LLM_ANSWER")
    expect(blockingCallMock).toHaveBeenCalledTimes(1)
  })
})
