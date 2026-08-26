// Faithful Node port of the desktop's AgentSessionStore unit fixtures
// (src-tauri/src/agent/session.rs tests): append_turn tracks recent messages,
// missing sessions read empty, turns persist to the project state dir, ids
// are isolated per project, path-traversal ids are rejected, and
// list_sessions returns persisted sessions newest-first. The on-disk shape is
// the desktop's exact serde camelCase AgentSession so both clients read the
// same files.
import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  appendTurn, recentMessages, listSessions, sessionFilePath, sanitizeSessionId,
} from "../src/agent-sessions.js"

const tmpRoots = []
function tempProject(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `llm-wiki-agent-session-${name}-`))
  tmpRoots.push(root)
  return root
}
afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe("agent session store (session.rs port)", () => {
  it("append_turn tracks recent messages", () => {
    const project = tempProject("recent")
    appendTurn({ projectPath: project, projectId: "p1", sessionId: "s1", user: "hello", assistant: "hi" })
    appendTurn({ projectPath: project, projectId: "p1", sessionId: "s1", user: "question", assistant: "answer" })

    const messages = recentMessages({ projectPath: project, sessionId: "s1", limit: 3 })
    expect(messages).toHaveLength(3)
    expect(messages[0].content).toBe("hi")
    expect(messages[1].role).toBe("user")
    expect(messages[2].content).toBe("answer")
  })

  it("recent_messages returns empty for a missing session", () => {
    const project = tempProject("missing")
    expect(recentMessages({ projectPath: project, sessionId: "missing", limit: 10 })).toEqual([])
  })

  it("append_turn persists the session to the project state dir", () => {
    const project = tempProject("persist")
    appendTurn({ projectPath: project, projectId: "p1", sessionId: "s.persist", user: "hello", assistant: "hi" })

    // A fresh store (no cache in the port — every read is a disk read) sees it.
    const messages = recentMessages({ projectPath: project, sessionId: "s.persist", limit: 10 })
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe("hello")
    expect(fs.existsSync(path.join(project, ".llm-wiki", "agent-sessions", "s.persist.json"))).toBe(true)

    // On-disk shape is the desktop's exact serde camelCase AgentSession.
    const raw = JSON.parse(fs.readFileSync(path.join(project, ".llm-wiki", "agent-sessions", "s.persist.json"), "utf-8"))
    expect(Object.keys(raw).sort()).toEqual(["messages", "projectId", "sessionId", "updatedAt"].sort())
    expect(raw.sessionId).toBe("s.persist")
    expect(raw.projectId).toBe("p1")
    expect(raw.messages).toEqual([
      { role: "user", content: "hello", timestamp: raw.messages[0].timestamp },
      { role: "assistant", content: "hi", timestamp: raw.messages[1].timestamp },
    ])
    expect(raw.messages[0].timestamp).toBe(raw.messages[1].timestamp)
    expect(raw.updatedAt).toBe(raw.messages[0].timestamp)
  })

  it("a desktop-written session file is read unchanged (shared on-disk format)", () => {
    const project = tempProject("desktop")
    const file = path.join(project, ".llm-wiki", "agent-sessions", "s1.json")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      sessionId: "s1",
      projectId: "p1",
      messages: [
        { role: "user", content: "desktop question", timestamp: 111 },
        { role: "assistant", content: "desktop answer", timestamp: 222 },
      ],
      updatedAt: 333,
    }, null, 2), "utf-8")

    expect(recentMessages({ projectPath: project, sessionId: "s1", limit: 10 })).toEqual([
      { role: "user", content: "desktop question", timestamp: 111 },
      { role: "assistant", content: "desktop answer", timestamp: 222 },
    ])
    // A web append continues the SAME file rather than replacing it.
    appendTurn({ projectPath: project, projectId: "p1", sessionId: "s1", user: "web question", assistant: "web answer", now: 444 })
    const messages = recentMessages({ projectPath: project, sessionId: "s1", limit: 10 })
    expect(messages).toHaveLength(4)
    expect(messages[3].content).toBe("web answer")
  })

  it("same session id is isolated per project", () => {
    const projectA = tempProject("isolate-a")
    const projectB = tempProject("isolate-b")
    appendTurn({ projectPath: projectA, projectId: "p1", sessionId: "same", user: "hello a", assistant: "answer a" })
    appendTurn({ projectPath: projectB, projectId: "p2", sessionId: "same", user: "hello b", assistant: "answer b" })

    const a = recentMessages({ projectPath: projectA, sessionId: "same", limit: 10 })
    const b = recentMessages({ projectPath: projectB, sessionId: "same", limit: 10 })
    expect(a).toEqual([
      { role: "user", content: "hello a", timestamp: a[0].timestamp },
      { role: "assistant", content: "answer a", timestamp: a[1].timestamp },
    ])
    expect(b).toEqual([
      { role: "user", content: "hello b", timestamp: b[0].timestamp },
      { role: "assistant", content: "answer b", timestamp: b[1].timestamp },
    ])
  })

  it("session ids reject path traversal", () => {
    const project = tempProject("traversal")
    expect(sessionFilePath(project, "../secret")).toBeNull()
    expect(sessionFilePath(project, "safe-id")).toBe(path.join(project, ".llm-wiki", "agent-sessions", "safe-id.json"))
    expect(sanitizeSessionId("a b/c")).toBeNull() // '/' rejected like the Rust guard
    expect(sanitizeSessionId("a b")).toBe("a_b") // spaces become '_'
  })

  it("list_sessions returns persisted sessions newest first", () => {
    const project = tempProject("list")
    appendTurn({ projectPath: project, projectId: "p1", sessionId: "s1", user: "one", assistant: "a", now: 1000 })
    appendTurn({ projectPath: project, projectId: "p1", sessionId: "s2", user: "two", assistant: "b", now: 2000 })

    const sessions = listSessions(project)
    expect(sessions.map((s) => s.sessionId)).toEqual(["s2", "s1"])
    expect(sessions[0]).toMatchObject({ projectId: "p1", updatedAt: 2000 })
    expect(sessions[1]).toMatchObject({ projectId: "p1", updatedAt: 1000 })
    // Missing dir -> empty (the desktop's read_dir Err case).
    expect(listSessions(tempProject("no-dir"))).toEqual([])
  })

  it("trims the oldest messages beyond MAX_SESSION_MESSAGES (40) from the front", () => {
    const project = tempProject("trim")
    for (let i = 0; i < 45; i += 1) {
      appendTurn({ projectPath: project, projectId: "p1", sessionId: "s1", user: `u${i}`, assistant: `a${i}`, now: i })
    }
    const messages = recentMessages({ projectPath: project, sessionId: "s1", limit: 200 })
    expect(messages).toHaveLength(40)
    expect(messages[0]).toEqual({ role: "user", content: "u25", timestamp: 25 })
    expect(messages[39]).toEqual({ role: "assistant", content: "a44", timestamp: 44 })
  })
})
