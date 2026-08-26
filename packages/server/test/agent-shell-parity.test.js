// Agent-loop shell.exec parity + boundary-persistence integration tests
// (runtime.rs execute_agent_loop_tool / lib.rs append_turn contract).
//
//   - an unapproved shell.exec stops the turn at the desktop approval
//     boundary (exact "The Agent needs approval…" text, `approval required:`
//     toolEnd, NO userInputRequired) and — exactly like the desktop's
//     unconditional AgentSessionStore::append_turn in lib.rs — PERSISTS the
//     boundary exchange (user message → approval text) to BOTH the web's
//     SQLite chat_messages and the shared .llm-wiki/agent-sessions file, so a
//     reload / cross-client hydrate restores the full transcript;
//   - a resumed turn (approvedShellCommands) re-runs the exact command in
//     <project>/agent-workspace with a sanitized env and feeds the model the
//     desktop's exact summary
//     (`shell.exec \`cmd\` exit=Some(0) timedOut=false\nstdout:\n…\nstderr:\n…`),
//     then appends its own exchange beneath the boundary row;
//   - the stream/SSE contract is untouched: toolStart → toolEnd
//     (`approval required: <cmd>`) → messageDelta (approval text) → done,
//     with no userInputRequired frame.
//
// llm-call.js is mocked (scriptable streamCall/blockingCall) so no real LLM
// is touched; everything else is the real code path.
//
// The user.ask boundary keeps its own (opposite) contract — it persists NO
// assistant scaffold row (pinned by agent-user-input.test.js + verify-user-ask).

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
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

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-shell-parity-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN
delete process.env.LLM_WIKI_ALLOW_SHELL

const PROJECT_UUID = "shell-parity-proj-uuid"
const PROJECT_PATH = path.join(DATA_DIR, "shell-parity-proj")
const SKILL_NAME = "ops-skill"
const SHELL_CMD = "cat /etc/hostname"
const HOSTNAME = readFileSync("/etc/hostname", "utf8").trim()

beforeAll(() => {
  mkdirSync(path.join(PROJECT_PATH, "wiki"), { recursive: true })
  mkdirSync(path.join(PROJECT_PATH, "raw", "sources"), { recursive: true })
  writeFileSync(path.join(PROJECT_PATH, "wiki", "index.md"), "# Index\n")
  mkdirSync(path.join(PROJECT_PATH, ".llm-wiki", "skills", SKILL_NAME), { recursive: true })
  writeFileSync(
    path.join(PROJECT_PATH, ".llm-wiki", "skills", SKILL_NAME, "SKILL.md"),
    "---\nname: Ops Skill\ndescription: Runs shell commands when asked.\n---\n\nUse shell.exec to run commands the user asks for.\n",
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
const { recentMessages } = await import("../src/agent-sessions.js")
const { runTool } = await import("../src/agent-tools.js")

ensureProjectRow({ uuid: PROJECT_UUID, path: PROJECT_PATH })

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
    async waitDone(timeoutMs = 8000) {
      await Promise.race([
        donePromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error("timed out waiting for done frame")), timeoutMs)),
      ])
      unsub()
    },
  }
}

function shellToolCall(id, command = SHELL_CMD) {
  return { type: "tool_call", id, name: "shell.exec", args: { command } }
}

describe("agent shell.exec parity (runtime.rs contract)", () => {
  it("stream: unapproved shell.exec stops at the desktop boundary and persists the exchange (SQLite + shared file)", async () => {
    streamCallMock.mockImplementationOnce(async function* () {
      yield shellToolCall("call_shell_1")
      yield { type: "finish" }
    })
    const sessionId = "sess-shell-boundary"
    const watcher = watchSession(sessionId)
    const runId = await agentStartTurnStream({
      projectId: PROJECT_UUID,
      request: {
        message: "Please run the shell command now.",
        sessionId,
        runId: "run-shell-boundary",
        mode: "standard",
        tools: { wiki: true, web: false, anytxt: false },
        topK: 5,
        includeContent: false,
        skills: [SKILL_NAME],
        skillMode: "explicit",
        resume: false,
      },
    })
    expect(typeof runId).toBe("string")
    await watcher.waitDone()

    const evs = watcher.agentEvents.map((p) => p.event)
    const toolEnd = evs.find((e) => e.type === "toolEnd" && e.tool === "shell.exec")
    expect(toolEnd?.output).toBe(`approval required: ${SHELL_CMD}`)
    const md = evs.find((e) => e.type === "messageDelta")
    expect(md?.text).toContain("The Agent needs approval before it can run this command")
    expect(md?.text).toContain(`\`${SHELL_CMD}\``)
    expect(evs.some((e) => e.type === "userInputRequired")).toBe(false)
    expect(evs.at(-1)?.type).toBe("done")

    // Desktop append_turn parity: the boundary exchange IS persisted — SQLite
    // (what the open web UI restores from after a reload) and the shared
    // .llm-wiki/agent-sessions file (what cross-client hydrates read).
    const sqlite = listMessages(sessionId)
    expect(sqlite.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(sqlite[0].content).toBe("Please run the shell command now.")
    expect(sqlite[1].content).toContain("The Agent needs approval before it can run this command")

    const shared = recentMessages({ projectPath: PROJECT_PATH, sessionId, limit: 100 })
    expect(shared.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(shared[0].content).toBe("Please run the shell command now.")
    expect(shared[1].content).toContain("The Agent needs approval before it can run this command")
  })

  it("stream: resume with approvedShellCommands re-runs the exact command in agent-workspace and feeds back the desktop summary", async () => {
    // Boundary turn (same flow as above), then the resumed turn with approval.
    streamCallMock.mockImplementationOnce(async function* () {
      yield shellToolCall("call_shell_2a")
      yield { type: "finish" }
    })
    const sessionId = "sess-shell-resume"
    const watcher = watchSession(sessionId)
    await agentStartTurnStream({
      projectId: PROJECT_UUID,
      request: {
        message: "Please run the shell command now.",
        sessionId,
        runId: "run-shell-resume-a",
        mode: "standard",
        tools: { wiki: true, web: false, anytxt: false },
        topK: 5,
        includeContent: false,
        skills: [SKILL_NAME],
        skillMode: "explicit",
        resume: false,
      },
    })
    await watcher.waitDone()

    // Resumed turn: first a tool_call (approved → executes), then the answer.
    streamCallMock.mockImplementationOnce(async function* () {
      yield shellToolCall("call_shell_2b")
      yield { type: "finish" }
    })
    streamCallMock.mockImplementationOnce(async function* () {
      yield { type: "delta", text: "Shell step completed successfully." }
      yield { type: "finish" }
    })
    const watcher2 = watchSession(sessionId)
    const resumeRunId = await agentStartTurnStream({
      projectId: PROJECT_UUID,
      request: {
        message: "Continue the same Agent task. The user approved the pending shell command; execute only that approved command first, then continue from its result.",
        sessionId,
        runId: "run-shell-resume-b",
        mode: "standard",
        tools: { wiki: true, web: false, anytxt: false },
        topK: 5,
        includeContent: false,
        skills: [SKILL_NAME],
        skillMode: "explicit",
        resume: true,
        approvedShellCommands: [SHELL_CMD],
      },
    })
    expect(typeof resumeRunId).toBe("string")
    await watcher2.waitDone()

    const evs2 = watcher2.agentEvents.map((p) => p.event)
    const shellEnd = evs2.find((e) => e.type === "toolEnd" && e.tool === "shell.exec")
    // Approved: the loop emits toolEnd with the observation (which starts with
    // the desktop summary, not "approval required:").
    expect(shellEnd?.output).toContain("shell.exec `" + SHELL_CMD + "` exit=Some(0) timedOut=false")
    expect(evs2.some((e) => e.type === "messageDelta" && e.text.includes("Shell step completed successfully."))).toBe(true)

    // The model's SECOND call saw the executed observation in the desktop
    // summary format (stdout carries the real hostname).
    const calls = streamCallMock.mock.calls
    const secondCallMessages = calls[1]?.[0]?.messages ?? []
    const toolMsg = secondCallMessages.find((m) => m.role === "tool")
    expect(toolMsg?.content).toContain(`shell.exec \`${SHELL_CMD}\` exit=Some(0) timedOut=false`)
    expect(toolMsg?.content).toContain(`stdout:\n${HOSTNAME}`)

    // The command truly ran inside <project>/agent-workspace (tools.rs cwd).
    const restored = recentMessages({ projectPath: PROJECT_PATH, sessionId, limit: 100 })
    expect(restored.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"])
    expect(restored[1].content).toContain("The Agent needs approval before it can run this command")
    expect(restored[3].content).toBe("Shell step completed successfully.")

    const sqlite = listMessages(sessionId)
    // resume=true re-sends the same user message (already persisted at the
    // boundary), so the answer appends directly under the boundary row —
    // mirroring the client-held conversations.json row order.
    expect(sqlite.map((m) => m.role)).toEqual(["user", "assistant", "assistant"])
    expect(sqlite[2].content).toBe("Shell step completed successfully.")
  })

  it("runTool shell.exec: desktop observation summary + agent-workspace cwd + sanitized env", async () => {
    const marker = "ws-marker-" + Date.now()
    const res = await runTool(
      "shell.exec",
      { command: `echo ${marker} > marker.txt` },
      { projectPath: PROJECT_PATH, approvedShellCommands: [`echo ${marker} > marker.txt`] },
    )
    expect(res.observation).toMatch(new RegExp(`^shell.exec \`echo ${marker} > marker\\.txt\` exit=Some\\(0\\) timedOut=false\\nstdout:\\n\\nstderr:\\n$`))
    // cwd is <project>/agent-workspace (tools.rs run_shell_exec port): the
    // redirected file landed there, not in the server's cwd.
    const written = readFileSync(path.join(PROJECT_PATH, "agent-workspace", "marker.txt"), "utf8")
    expect(written.trim()).toBe(marker)
  })
})
