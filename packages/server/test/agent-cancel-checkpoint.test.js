// Agent-loop cancellation checkpoint tests (runtime.rs + cancel.rs contract).
//
// The run registry is keyed `projectId::sessionId::runId` (the desktop
// AgentCancellationRegistry port, session-scoped cancel), so the loop's
// cancellation checkpoints must consult the CURRENT run's token — never a
// bare-runId lookup that can no longer match (that bug left every checkpoint
// dead: a cancelled run kept issuing LLM calls and executing tools).
//
// The Rust runtime stops a turn promptly but cannot force-kill in-flight
// Tokio work; it checks the cancellation token at every await point with a
// `biased` select (stream deltas, blocking generate, tool execution). The
// mocks here deliberately DO NOT honor the abort signal, so the ONLY thing
// that can stop the loop is a checkpoint — proving the checkpoints are real,
// not the abort plumbing.
//
// Covered:
//   - stream: cancel while the run is parked on the NEXT LLM call; the first
//     post-cancel delta is dropped and the turn ends with the desktop's
//     "Agent run cancelled" error (no messageDelta, no assistant persist).
//   - non-stream: same, but parked on blockingCall; the returned content is
//     discarded at the post-call checkpoint instead of becoming the answer.
//   - cancel between the LLM tool_call and the executor: the tool does NOT
//     run (wiki.write_page writes no file) — the runtime stops the turn
//     before any side effect, like execute_tool_with_cancellation's bias.
//   - session-scoped cancel (no runId) resolves every active run of the
//     session via the registry prefix, exactly like handle_cancel_chat.

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

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-cancel-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const PROJECT_UUID = "cancel-checkpoint-proj"
const PROJECT_PATH = path.join(DATA_DIR, "cancel-checkpoint-proj")

beforeAll(() => {
  mkdirSync(path.join(PROJECT_PATH, "wiki"), { recursive: true })
  mkdirSync(path.join(PROJECT_PATH, "raw", "sources"), { recursive: true })
  writeFileSync(path.join(PROJECT_PATH, "wiki", "index.md"), "# Index\n")
  mkdirSync(path.join(DATA_DIR, "stores"), { recursive: true })
  writeFileSync(path.join(DATA_DIR, "stores", "app-state.json"), JSON.stringify({
    projectRegistry: { [PROJECT_UUID]: { id: PROJECT_UUID, path: PROJECT_PATH } },
    llmConfig: { provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" },
  }))
})

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

beforeEach(() => {
  streamCallMock.mockReset()
  blockingCallMock.mockReset()
})

const { agentStartTurnStream, agentStartTurn, agentCancelTurn } = await import("../src/agent.js")
const { eventBus } = await import("../src/events/bus.js")
const { listMessages, ensureSession } = await import("../src/store/chat-sessions.js")
const { ensureProjectRow } = await import("../src/store/projects.js")

const projectRowId = ensureProjectRow({ uuid: PROJECT_UUID, path: PROJECT_PATH }).id

const SESSION_ID = "cancel-checkpoint-session"
const RUN_ID = "run-cancel-checkpoint"

// Collects every agent-event frame for a run; resolves when the frame's
// runId is done/error (the first terminal frame wins).
function watchRun(runId) {
  const frames = []
  let resolveTerminal
  const terminalPromise = new Promise((resolve) => { resolveTerminal = resolve })
  const unsub = eventBus.subscribe((env) => {
    if (env.type !== "agent-event") return
    const p = env.payload ?? {}
    if (p.runId !== runId) return
    frames.push(p)
    if (p.event?.type === "done" || p.event?.type === "error") resolveTerminal()
  })
  return {
    frames,
    async waitTerminal(timeoutMs = 6000) {
      await Promise.race([
        terminalPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error("timed out waiting for terminal frame")), timeoutMs)),
      ])
      unsub()
    },
  }
}

async function until(fn, timeoutMs = 6000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time")
    await new Promise((r) => setTimeout(r, 10))
  }
}

function baseRequest(overrides = {}) {
  return {
    message: "run it",
    sessionId: SESSION_ID,
    runId: RUN_ID,
    mode: "standard",
    tools: { wiki: true, web: false, anytxt: false },
    topK: 5,
    includeContent: false,
    skills: [],
    historyExplicit: true,
    history: [],
    ...overrides,
  }
}

describe("agent cancel checkpoints (runtime.rs / cancel.rs)", () => {
  it("stream: cancel while parked on the next LLM call stops at the per-event checkpoint", async () => {
    let releaseSecond
    const gate = new Promise((resolve) => { releaseSecond = resolve })
    // Call 1: fires a read-only tool so a second LLM iteration happens.
    streamCallMock.mockImplementationOnce(async function* () {
      yield { type: "tool_call", id: "call_1", name: "wiki.read_page", args: { path: "wiki/index.md" } }
      yield { type: "finish" }
    })
    // Call 2: parks on the gate, then yields a delta that must be dropped.
    streamCallMock.mockImplementationOnce(async function* () {
      await gate
      yield { type: "delta", text: "post-cancel delta must not land" }
      yield { type: "finish" }
    })

    const watcher = watchRun(RUN_ID)
    await agentStartTurnStream({ projectId: PROJECT_UUID, request: baseRequest() })

    await until(() => streamCallMock.mock.calls.length === 2)
    // Session-scoped cancel: registry prefix match, no runId (handle_cancel_chat path).
    const cancelled = await agentCancelTurn({ projectId: PROJECT_UUID, sessionId: SESSION_ID })
    expect(cancelled).toBe(true)
    releaseSecond()
    await watcher.waitTerminal()

    const errors = watcher.frames.filter((f) => f.event?.type === "error")
    expect(errors).toHaveLength(1)
    expect(errors[0].event.message).toBe("Agent run cancelled")
    // The post-cancel delta never became a messageDelta / answer.
    const deltas = watcher.frames.filter((f) => f.event?.type === "messageDelta" && f.event.text === "post-cancel delta must not land")
    expect(deltas).toHaveLength(0)
    const done = watcher.frames.filter((f) => f.event?.type === "done")
    expect(done).toHaveLength(1)
    expect(done[0].event.text ?? "").not.toContain("post-cancel delta")
    // No further LLM call after the checkpoint.
    expect(streamCallMock.mock.calls.length).toBe(2)
    // A cancelled turn persists no assistant row (RUNBOOK contract).
    const session = ensureSession(projectRowId, SESSION_ID, {})
    const msgs = listMessages(session.id)
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(0)
  })

  it("non-stream: cancel while parked on blockingCall discards the returned answer", async () => {
    let releaseSecond
    const gate = new Promise((resolve) => { releaseSecond = resolve })
    blockingCallMock.mockImplementationOnce(async () => ({ content: "", toolCalls: [{ id: "c1", name: "wiki.read_page", args: { path: "wiki/index.md" } }] }))
    blockingCallMock.mockImplementationOnce(async () => {
      await gate
      return { content: "post-cancel answer must not land", toolCalls: [] }
    })

    const runPromise = agentStartTurn({ projectId: PROJECT_UUID, request: baseRequest() })
    await until(() => blockingCallMock.mock.calls.length === 2)
    const cancelled = await agentCancelTurn({ projectId: PROJECT_UUID, sessionId: SESSION_ID })
    expect(cancelled).toBe(true)
    releaseSecond()
    await expect(runPromise).rejects.toThrow("Agent run cancelled")
    expect(blockingCallMock.mock.calls.length).toBe(2)
  })

  it("cancel between the LLM tool_call and the executor prevents the tool side effect", async () => {
    const target = path.join(PROJECT_PATH, "wiki", "cancel-target.md")
    if (existsSync(target)) { /* fresh project, should not exist */ }
    let releaseTool
    const gate = new Promise((resolve) => { releaseTool = resolve })
    // The generator yields a write_page tool_call, then parks before ending
    // (the loop is still consuming the stream while we cancel).
    streamCallMock.mockImplementationOnce(async function* () {
      yield { type: "tool_call", id: "call_w", name: "wiki.write_page", args: { path: "wiki/cancel-target.md", content: "should not be written" } }
      await gate
      yield { type: "finish" }
    })

    const watcher = watchRun(RUN_ID)
    await agentStartTurnStream({ projectId: PROJECT_UUID, request: baseRequest() })
    await until(() => streamCallMock.mock.calls.length === 1)
    const cancelled = await agentCancelTurn({ projectId: PROJECT_UUID, sessionId: SESSION_ID })
    expect(cancelled).toBe(true)
    releaseTool()
    await watcher.waitTerminal()

    const errors = watcher.frames.filter((f) => f.event?.type === "error")
    expect(errors).toHaveLength(1)
    expect(errors[0].event.message).toBe("Agent run cancelled")
    // The tool never ran: no file side effect, no toolEnd event.
    expect(existsSync(target)).toBe(false)
    expect(watcher.frames.filter((f) => f.event?.type === "toolEnd")).toHaveLength(0)
  })
})
