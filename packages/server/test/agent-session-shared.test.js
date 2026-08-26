// Cross-client chat context + session sharing (the "one backend, one user
// data" promise for chats):
//   - the web runtime honors an explicit client history (historyExplicit)
//     verbatim, like the desktop runtime — so continuing a conversation
//     created on the desktop (whose history lives in conversations.json)
//     keeps its context instead of an empty per-server store;
//   - requests WITHOUT explicit history hydrate the last 12 turns from the
//     SHARED .llm-wiki/agent-sessions/<sessionId>.json store in the
//     desktop's exact serde shape;
//   - successful turns append to that store when persistSession !== false
//     (the desktop default true), so /api/v1/chat (MCP + external agent
//     skill) sessions resume on either backend;
//   - /api/v1/chat cancel resolves the project and cancels by session like
//     the desktop's handle_cancel_chat;
//   - agent_get_session / agent_list_sessions read the shared store with the
//     desktop's arg names and return shapes.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest"
import request from "supertest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const { llmCalls } = vi.hoisted(() => ({ llmCalls: [] }))

vi.mock("../src/llm-call.js", () => ({
  streamCall: async function* (opts) {
    llmCalls.push(opts)
    yield { type: "delta", text: "Mocked stream answer" }
    yield { type: "finish" }
  },
  blockingCall: async (opts) => {
    llmCalls.push(opts)
    return { content: "Mocked chat answer", toolCalls: [] }
  },
}))

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-sesshared-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
process.env.LLM_WIKI_API_TOKEN = ""

const PROJECT_UUID = "shared-proj-uuid"
const PROJECT_PATH = path.join(DATA_DIR, "shared-proj")

beforeAll(() => {
  mkdirSync(path.join(PROJECT_PATH, ".llm-wiki"), { recursive: true })
  mkdirSync(path.join(PROJECT_PATH, "wiki"), { recursive: true })
  writeFileSync(path.join(PROJECT_PATH, "wiki", "index.md"), "# Home\n")
  mkdirSync(path.join(DATA_DIR, "stores"), { recursive: true })
  writeFileSync(path.join(DATA_DIR, "stores", "app-state.json"), JSON.stringify({
    projectRegistry: { [PROJECT_UUID]: { id: PROJECT_UUID, path: PROJECT_PATH } },
    recentProjects: [{ id: PROJECT_UUID, path: PROJECT_PATH }],
    lastProject: { id: PROJECT_UUID, path: PROJECT_PATH },
    llmConfig: { provider: "openai", apiKey: "sk-test", model: "gpt-4o-mini" },
    // Agent chat (/api/v1/projects/:id/chat + cancel) always requires a
    // REAL token (desktop is_agent_chat_request + is_token_authorized), even
    // when allowUnauthenticated opens the rest of the API.
    apiConfig: { allowUnauthenticated: true, token: "shared-chat-token" },
  }))
})

afterAll(() => {
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

const { app } = await import("../src/index-v2.js")
const { agentStartTurn, agentGetSession, agentListSessions } = await import("../src/agent.js")
const { recentMessages } = await import("../src/agent-sessions.js")

const AGENT_DIR = path.join(PROJECT_PATH, ".llm-wiki", "agent-sessions")

function writeDesktopSession(sessionId, turns, updatedAtBase = 1000) {
  // Write a session file byte-shaped like the desktop's serde AgentSession.
  const messages = []
  turns.forEach(([user, assistant], i) => {
    const t = updatedAtBase + i * 100
    messages.push({ role: "user", content: user, timestamp: t })
    messages.push({ role: "assistant", content: assistant, timestamp: t })
  })
  const file = path.join(AGENT_DIR, `${sessionId}.json`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({
    sessionId, projectId: PROJECT_UUID, messages, updatedAt: updatedAtBase + turns.length * 100,
  }, null, 2), "utf-8")
  return messages
}

function turnRequest(sessionId, message, extra = {}) {
  return {
    message, sessionId,
    runId: `run-${Math.random().toString(36).slice(2)}`,
    mode: "standard", tools: { wiki: false, web: false, anytxt: false },
    topK: 5, includeContent: false, skills: [],
    ...extra,
  }
}

describe("cross-client chat context sourcing", () => {
  it("explicit client history wins verbatim over stale session-store/SQLite data", async () => {
    const sessionId = "conv-explicit"
    // The session store + SQLite both carry DIFFERENT old messages.
    writeDesktopSession(sessionId, [["desktop old q", "desktop old a"]])
    await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest(sessionId, "NEW message", { historyExplicit: true }),
    })
    await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest(sessionId, "NEW message", { historyExplicit: true, history: [] }),
    })
    const explicitCall = llmCalls[llmCalls.length - 1]
    // historyExplicit: true + empty history -> brand new conversation: the
    // model must NOT see the stale session-store messages.
    expect(explicitCall.messages.map((m) => m.role)).toEqual(["system", "user"])
    expect(explicitCall.messages[1].content).toBe("NEW message")
  })

  it("hydrates the last 12 MESSAGES from the shared desktop session file when no history is sent", async () => {
    llmCalls.length = 0
    const sessionId = "conv-hydrate"
    const turns = []
    for (let i = 0; i < 14; i += 1) turns.push([`desktop q${i}`, `desktop a${i}`])
    writeDesktopSession(sessionId, turns)

    await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest(sessionId, "Web follow-up"),
    })
    const sent = llmCalls[0].messages
    // Desktop contract: the last 12 MESSAGES (6 exchanges) feed the model —
    // the Rust command wrappers pass limit 12 to recent_messages.
    const prior = sent.slice(1, -1)
    expect(prior).toHaveLength(12)
    expect(prior[0].content).toBe("desktop q8")
    expect(prior[prior.length - 1].content).toBe("desktop a13")
    expect(sent[sent.length - 1].content).toBe("Web follow-up")
  })

  it("successful turns append to the shared session file (desktop append_turn)", async () => {
    llmCalls.length = 0
    const sessionId = "conv-append"
    await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest(sessionId, "Web question"),
    })
    const messages = recentMessages({ projectPath: PROJECT_PATH, sessionId, limit: 100 })
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Web question"],
      ["assistant", "Mocked chat answer"],
    ])
    const raw = JSON.parse(require("node:fs").readFileSync(path.join(AGENT_DIR, `${sessionId}.json`), "utf-8"))
    expect(raw.projectId).toBe(PROJECT_UUID)
    expect(raw.sessionId).toBe(sessionId)
    expect(raw.messages[0].timestamp).toBe(raw.messages[1].timestamp)
    expect(raw.updatedAt).toBe(raw.messages[0].timestamp)
  })

  it("persistSession:false skips the shared session-store append", async () => {
    llmCalls.length = 0
    const sessionId = "conv-noappend"
    await agentStartTurn({
      projectId: PROJECT_UUID,
      request: turnRequest(sessionId, "No persist", { persistSession: false }),
    })
    expect(recentMessages({ projectPath: PROJECT_PATH, sessionId, limit: 100 })).toEqual([])
    expect(require("node:fs").existsSync(path.join(AGENT_DIR, `${sessionId}.json`))).toBe(false)
  })
})

describe("/api/v1/chat (MCP + external agent skill, handle_chat port)", () => {
  it("hydrates the shared session file and appends the turn on persistSession default", async () => {
    llmCalls.length = 0
    const sessionId = "mcp-s1"
    writeDesktopSession(sessionId, [["desktop q", "desktop a"]])

    const res = await request(app)
      .post("/api/v1/projects/current/chat")
      .set("x-llm-wiki-token", "shared-chat-token")
      .send({ message: "Web API question", sessionId })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.sessionId).toBe(sessionId)
    expect(res.body.message).toEqual({ role: "assistant", content: "Mocked chat answer" })
    expect(res.body.usage).toEqual({ referenceCount: 0, toolEventCount: 0 })

    // The model saw the desktop turn (hydrated from the shared file)…
    const sent = llmCalls[0].messages
    expect(sent.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"])
    expect(sent[1].content).toBe("desktop q")
    // …and the completed exchange landed back in the SAME file.
    const messages = recentMessages({ projectPath: PROJECT_PATH, sessionId, limit: 100 })
    expect(messages.map((m) => m.content)).toEqual(["desktop q", "desktop a", "Web API question", "Mocked chat answer"])
  })

  it("does not append when persistSession is false", async () => {
    llmCalls.length = 0
    const sessionId = "mcp-nopersist"
    writeDesktopSession(sessionId, [["q", "a"]])
    const res = await request(app)
      .post("/api/v1/projects/current/chat")
      .set("x-llm-wiki-token", "shared-chat-token")
      .send({ message: "x", sessionId, persistSession: false })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(recentMessages({ projectPath: PROJECT_PATH, sessionId, limit: 100 })).toHaveLength(2)
  })

  it("returns api_<uuid> session ids for callers that send none", async () => {
    llmCalls.length = 0
    const res = await request(app)
      .post("/api/v1/projects/current/chat")
      .set("x-llm-wiki-token", "shared-chat-token")
      .send({ message: "no session id" })
    expect(res.status).toBe(200)
    expect(String(res.body.sessionId).startsWith("api_")).toBe(true)
  })

  it("cancel resolves the project and cancels by session (handle_cancel_chat port)", async () => {
    // No active run for this session -> registry returns false, not an error.
    const res = await request(app)
      .post("/api/v1/projects/current/chat/mcp-s1/cancel")
      .set("x-llm-wiki-token", "shared-chat-token")
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, sessionId: "mcp-s1", cancelled: false })
  })
})

describe("agent_get_session / agent_list_sessions (desktop contract)", () => {
  it("agent_get_session reads the last N messages of the shared store", async () => {
    const sessionId = "get-s1"
    writeDesktopSession(sessionId, [["q1", "a1"], ["q2", "a2"]])
    const messages = await agentGetSession({ projectId: PROJECT_UUID, sessionId, limit: 1 })
    expect(messages).toEqual([{ role: "assistant", content: "a2", timestamp: 1100 }])
    const big = await agentGetSession({ projectId: PROJECT_UUID, sessionId })
    expect(big).toHaveLength(4)
    // Clamped like the Rust command (limit.clamp(1, 200)).
    const clamped = await agentGetSession({ projectId: PROJECT_UUID, sessionId, limit: 0 })
    expect(clamped).toHaveLength(1)
  })

  it("agent_list_sessions returns shared sessions newest first", async () => {
    const sessions = await agentListSessions({ projectId: PROJECT_UUID })
    const ids = sessions.map((s) => s.sessionId)
    // conv-append was written most recently in this file's flow.
    expect(ids).toContain("conv-append")
    expect(ids.indexOf("conv-append")).toBeLessThan(ids.indexOf("get-s1"))
    expect(sessions.find((s) => s.sessionId === "get-s1")).toMatchObject({
      projectId: PROJECT_UUID,
    })
  })
})
