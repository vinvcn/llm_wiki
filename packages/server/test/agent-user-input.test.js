// Agent-loop user.ask integration tests (runtime.rs run_agent_loop contract).
//
// The model may pause a turn with a structured form:
//   - a VALID user.ask emits `userInputRequired` + `done` and ends the turn
//     with the form description as the message text (stream and non-stream);
//   - an INVALID schema is rejected back to the model with the desktop's
//     exact error (record_loop_tool_rejection) and the loop retries;
//   - the boundary persists NO assistant row (the resume turn carries the
//     answers as a plain user message — desktop stateless resume);
//   - user.ask is offered to the model only when a skill is active for the
//     turn (the desktop lists it in the available-tools block under skills);
//   - the AskUserQuestion alias is honored at dispatch time.
//
// llm-call.js is mocked (scriptable streamCall/blockingCall) so no real LLM
// is touched; everything else is the real code path.

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

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-user-input-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const PROJECT_UUID = "user-input-proj-uuid"
const PROJECT_PATH = path.join(DATA_DIR, "user-input-proj")
const SKILL_NAME = "deck-builder"

beforeAll(() => {
  mkdirSync(path.join(PROJECT_PATH, "wiki"), { recursive: true })
  mkdirSync(path.join(PROJECT_PATH, "raw", "sources"), { recursive: true })
  writeFileSync(path.join(PROJECT_PATH, "wiki", "index.md"), "# Index\n")
  // A project skill so skillsActive=true (user.ask is skills-gated like the
  // desktop's available-tools block).
  mkdirSync(path.join(PROJECT_PATH, ".llm-wiki", "skills", SKILL_NAME), { recursive: true })
  writeFileSync(
    path.join(PROJECT_PATH, ".llm-wiki", "skills", SKILL_NAME, "SKILL.md"),
    "---\nname: Deck Builder\ndescription: Build slide decks; asks the user for style choices first.\n---\n\nAsk the user for the palette before generating.\n",
  )
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

const { agentStartTurnStream, agentStartTurn } = await import("../src/agent.js")
const { eventBus } = await import("../src/events/bus.js")
const { listMessages, ensureSession } = await import("../src/store/chat-sessions.js")
const { ensureProjectRow } = await import("../src/store/projects.js")
const { toolsForRequest } = await import("../src/agent-tools.js")

const projectRowId = ensureProjectRow({ uuid: PROJECT_UUID, path: PROJECT_PATH }).id

function watchSession(sessionId) {
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
        new Promise((_, rej) => setTimeout(() => rej(new Error("timed out waiting for done frame")), timeoutMs)),
      ])
      unsub()
    },
  }
}

const VALID_FORM = {
  title: "Cover setup",
  description: "Choose the deck style before I generate it.",
  fields: [
    {
      id: "palette", type: "single", label: "Palette",
      options: [{ label: "Auto", value: "auto", recommended: true }, { label: "Dark", value: "dark" }],
      defaultValue: "auto",
    },
    { id: "watermark", type: "text", label: "Watermark", placeholder: "Optional" },
  ],
}

function turnRequest(sessionId, runId, message, overrides = {}) {
  return {
    message,
    sessionId,
    runId,
    mode: "standard",
    tools: { wiki: true, web: false, anytxt: false },
    topK: 5,
    includeContent: false,
    skills: [SKILL_NAME],
    skillMode: "explicit",
    resume: false,
    ...overrides,
  }
}

describe("agent user.ask boundary (runtime.rs contract)", () => {
  it("stream: valid user.ask emits userInputRequired + done and persists no assistant row", async () => {
    streamCallMock.mockImplementationOnce(async function* () {
      yield { type: "tool_call", id: "call_ask_1", name: "user.ask", args: VALID_FORM }
      yield { type: "finish" }
    })
    const sessionId = "sess-ui-stream"
    const watcher = watchSession(sessionId)
    const runId = await agentStartTurnStream({
      projectId: PROJECT_UUID,
      request: turnRequest(sessionId, "run-ui-stream", "Make me a deck"),
    })
    expect(typeof runId).toBe("string")
    await watcher.waitDone()
    const types = watcher.agentEvents.map((p) => p.event.type)
    // skills.load start/end (skills active) then userInputRequired then done.
    // NO messageDelta: the owning tab renders the intro from the request.
    expect(types).toContain("userInputRequired")
    expect(types[types.length - 1]).toBe("done")
    expect(types).not.toContain("messageDelta")
    const ui = watcher.agentEvents.find((p) => p.event.type === "userInputRequired").event
    expect(ui.request.title).toBe("Cover setup")
    expect(ui.request.description).toBe("Choose the deck style before I generate it.")
    expect(ui.request.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(ui.request.fields.length).toBe(2)
    expect(ui.request.fields[0]).toMatchObject({
      id: "palette", type: "single", label: "Palette", defaultValue: "auto",
      options: [
        { label: "Auto", value: "auto", recommended: true },
        { label: "Dark", value: "dark" },
      ],
    })
    const done = watcher.agentEvents.at(-1).event
    // done carries the form description as the turn text (desktop answer =
    // request_form.description); duals as chat:done for previewing tabs.
    expect(done.text).toBe("Choose the deck style before I generate it.")
    // The boundary persists only the user row — no assistant scaffolding.
    const messages = listMessages(sessionId)
    expect(messages.length).toBe(1)
    expect(messages[0].role).toBe("user")
  })

  it("non-stream: response carries userInputRequest + description message", async () => {
    blockingCallMock.mockResolvedValueOnce({ content: "", toolCalls: [{ id: "call_ask_2", name: "user.ask", args: VALID_FORM }] })
    const sessionId = "sess-ui-block"
    const res = await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest(sessionId, "run-ui-block", "Make me a deck"),
    })
    expect(res.sessionId).toBe(sessionId)
    expect(res.message).toBe("Choose the deck style before I generate it.")
    expect(res.userInputRequest).toBeTruthy()
    expect(res.userInputRequest.fields.length).toBe(2)
    expect(res.userInputRequest.fields[1]).toMatchObject({ id: "watermark", type: "text", label: "Watermark" })
    // Desktop AgentChatResponse.events parity: the turn's event vector rides
    // the non-stream response (the local HTTP API /chat envelope exposes it).
    const evTypes = (res.events ?? []).map((e) => e.type)
    expect(evTypes).toContain("userInputRequired")
    expect(evTypes[evTypes.length - 1]).toBe("done")
    expect(evTypes).toContain("toolStart") // skills.load bracket
    expect(evTypes).not.toContain("messageDelta") // sink-only in the desktop vector
    const uiEv = res.events.find((e) => e.type === "userInputRequired")
    expect(uiEv.request.requestId).toBe(res.userInputRequest.requestId)
    // No form -> no userInputRequest key at all (serde skip_serializing_if).
    blockingCallMock.mockResolvedValueOnce({ content: "Plain answer", toolCalls: [] })
    const res2 = await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest("sess-ui-block2", "run-ui-block2", "hello"),
    })
    expect("userInputRequest" in res2).toBe(false)
    expect(res2.message).toBe("Plain answer")
  })

  it("non-stream: fallback message when the form has no description", async () => {
    const { description, ...noDesc } = VALID_FORM
    blockingCallMock.mockResolvedValueOnce({ content: "", toolCalls: [{ id: "call_ask_3", name: "user.ask", args: noDesc }] })
    const res = await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest("sess-ui-nodesc", "run-ui-nodesc", "Make me a deck"),
    })
    // The form itself carries the desktop default description, and the turn
    // answer = request_form.description (runtime.rs), so BOTH are the
    // "so the Agent can continue." line.
    expect(res.userInputRequest.description)
      .toBe("Please provide the requested information so the Agent can continue.")
    expect(res.message).toBe("Please provide the requested information so the Agent can continue.")
  })

  it("non-stream: runtime fallback message when description cleans to empty", async () => {
    // description present but sanitized away ("<>") -> the form omits it and
    // the turn answer falls back to the desktop's "to continue." line.
    blockingCallMock.mockResolvedValueOnce({
      content: "",
      toolCalls: [{ id: "call_ask_4", name: "user.ask", args: { description: "<>", fields: [{ type: "text", label: "T" }] } }],
    })
    const res = await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest("sess-ui-emptydesc", "run-ui-emptydesc", "Make me a deck"),
    })
    expect("description" in res.userInputRequest).toBe(false)
    expect(res.message).toBe("Please provide the requested information to continue.")
  })

  it("invalid schema -> rejection round-trip -> corrected form (record_loop_tool_rejection)", async () => {
    // Turn 1: empty fields (invalid). Turn 2 (after the rejected tool
    // observation): a corrected, valid form.
    blockingCallMock
      .mockResolvedValueOnce({ content: "", toolCalls: [{ id: "call_bad", name: "user.ask", args: { fields: [] } }] })
      .mockResolvedValueOnce({ content: "", toolCalls: [{ id: "call_good", name: "user.ask", args: VALID_FORM }] })
    const sessionId = "sess-ui-retry"
    const res = await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest(sessionId, "run-ui-retry", "Make me a deck"),
    })
    expect(blockingCallMock).toHaveBeenCalledTimes(2)
    // The second model call received the desktop's exact rejection observation.
    const secondCallMessages = blockingCallMock.mock.calls[1][0].messages
    const toolMsg = secondCallMessages.filter((m) => m.role === "tool").at(-1)
    expect(toolMsg.content).toBe(
      "rejected: user.ask requires at least one valid field. Return a corrected user.ask schema or answer without asking.",
    )
    // Failed toolEvent recorded (AgentToolEvent status "failed", detail = error).
    const failed = res.toolEvents.filter((t) => t.tool === "user.ask" && t.status === "failed")
    expect(failed.length).toBe(1)
    expect(failed[0].detail).toBe(
      "user.ask requires at least one valid field. Return a corrected user.ask schema or answer without asking.",
    )
    // The corrected form ends the turn.
    expect(res.userInputRequest.title).toBe("Cover setup")
    // No assistant row persisted at the boundary.
    expect(listMessages(sessionId).every((m) => m.role === "user")).toBe(true)
  })

  it("honors the AskUserQuestion alias at dispatch time", async () => {
    blockingCallMock.mockResolvedValueOnce({
      content: "",
      toolCalls: [{
        id: "call_alias", name: "AskUserQuestion",
        args: { questions: [{ id: "palette", question: "Palette?", options: [{ label: "Auto", value: "auto" }] }] },
      }],
    })
    const res = await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest("sess-ui-alias", "run-ui-alias", "deck"),
    })
    expect(res.userInputRequest.fields[0].id).toBe("palette")
    expect(res.userInputRequest.fields[0].type).toBe("single")
  })
})

describe("events vector redaction (redact_for_external_api)", () => {
  it("fileChanged events drop previousContent in the collected vector", async () => {
    blockingCallMock
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ id: "call_w1", name: "workspace.write_file", args: { path: "note.md", content: "v1" } }],
      })
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ id: "call_w2", name: "workspace.write_file", args: { path: "note.md", content: "v2" } }],
      })
      .mockResolvedValueOnce({ content: "Wrote the note.", toolCalls: [] })
    const res = await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest("sess-ui-redact", "run-ui-redact", "write a note"),
    })
    const fc = (res.events ?? []).filter((e) => e.type === "fileChanged")
    expect(fc.length).toBe(2)
    // Second write overwrites: the runtime KNOWS the previous content, but the
    // collected (external-API) event must redact the rollback snapshot.
    expect(fc.every((e) => !("previousContent" in e))).toBe(true)
    expect(fc[1]).toMatchObject({ path: "agent-workspace/note.md", tool: "workspace.write_file", existedBefore: true })
  })
})

describe("user.ask offering is skills-gated (desktop available-tools block)", () => {
  it("toolsForRequest offers user.ask only when skills are active", () => {
    const req = { tools: {} }
    expect(toolsForRequest(req, "standard", false)).not.toContain("user.ask")
    expect(toolsForRequest(req, "standard", true)).toContain("user.ask")
    expect(toolsForRequest(req, "deep", true)).toContain("user.ask")
  })

  it("the model's tool specs omit user.ask on skill-less turns", async () => {
    blockingCallMock.mockResolvedValueOnce({ content: "No skills here.", toolCalls: [] })
    await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest("sess-ui-noskill", "run-ui-noskill", "hello", { skills: [], skillMode: "auto" }),
    })
    const specs = blockingCallMock.mock.calls[0][0].tools
    expect(Array.isArray(specs)).toBe(true)
    expect(specs.map((s) => s.name)).not.toContain("user.ask")
    expect(specs.map((s) => s.name)).toContain("wiki.search")
  })
})
