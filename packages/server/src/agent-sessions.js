// Faithful Node port of the desktop's agent session store
// (src-tauri/src/agent/session.rs: AgentSessionStore). Sessions live on disk
// in the project's `.llm-wiki/agent-sessions/<sessionId>.json` files in the
// desktop's exact serde shape ({sessionId, projectId,
// messages: [{role, content, timestamp}], updatedAt}), so the web server and
// the desktop read/write the SAME files: a chat started on one client (UI
// streaming turns, `/api/v1/chat`, MCP) resumes with the same context on the
// other — the "one backend, one user data" promise. No in-memory cache: every
// read is a fresh disk read (the desktop bounds only its in-memory cache, the
// files themselves stay authoritative), so an out-of-band desktop write is
// visible to the web server on the next access with no restart.
//
// Contract details ported verbatim from session.rs:
//   - append_turn: load-or-default, push user + assistant with the same
//     `now` timestamp, trim the oldest messages beyond MAX_SESSION_MESSAGES
//     (40) from the FRONT, bump updatedAt, write pretty JSON.
//   - recent_messages: last `limit` messages, [] for a missing session.
//   - list_sessions: every *.json in the dir, newest updatedAt first (then
//     newest sessionId first, Rust's BTreeMap tie-break).
//   - sanitize_session_id: trim; reject empty / '/' / '\\' / '..' / >128
//     chars; non [A-Za-z0-9._-] chars become '_' (path-traversal guard).

import fs from "node:fs"
import path from "node:path"

const MAX_SESSION_MESSAGES = 40

export function sanitizeSessionId(sessionId) {
  const trimmed = String(sessionId ?? "").trim()
  if (
    !trimmed || trimmed.includes("/") || trimmed.includes("\\")
    || trimmed.includes("..") || trimmed.length > 128
  ) {
    return null
  }
  return [...trimmed].map((ch) => (/[A-Za-z0-9_.-]/.test(ch) ? ch : "_")).join("")
}

export function sessionFilePath(projectPath, sessionId) {
  const id = sanitizeSessionId(sessionId)
  if (!id) return null
  return path.join(projectPath, ".llm-wiki", "agent-sessions", `${id}.json`)
}

function loadSession(projectPath, sessionId) {
  const file = sessionFilePath(projectPath, sessionId)
  if (!file) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"))
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) return null
    return parsed
  } catch {
    return null
  }
}

function saveSession(projectPath, session) {
  const file = sessionFilePath(projectPath, session.sessionId)
  if (!file) throw new Error("Invalid Agent session id")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // serde_json::to_string_pretty — exact desktop layout, no trailing newline.
  fs.writeFileSync(file, `${JSON.stringify(session, null, 2)}`, "utf-8")
}

function normalizeMessage(m) {
  return {
    role: typeof m?.role === "string" ? m.role : "",
    content: typeof m?.content === "string" ? m.content : "",
    timestamp: typeof m?.timestamp === "number" ? m.timestamp : 0,
  }
}

/** Port of AgentSessionStore::append_turn. Returns the saved session. */
export function appendTurn({ projectPath, projectId, sessionId, user, assistant, now = Date.now() }) {
  const existing = loadSession(projectPath, sessionId)
  const session = existing ?? { sessionId: "", projectId: "", messages: [], updatedAt: 0 }
  session.sessionId = String(sessionId ?? "")
  session.projectId = String(projectId ?? "")
  session.messages.push({ role: "user", content: String(user ?? ""), timestamp: now })
  session.messages.push({ role: "assistant", content: String(assistant ?? ""), timestamp: now })
  if (session.messages.length > MAX_SESSION_MESSAGES) {
    session.messages = session.messages.slice(session.messages.length - MAX_SESSION_MESSAGES)
  }
  session.updatedAt = now
  saveSession(projectPath, session)
  return session
}

/** Web extension mirroring SQLite dropLastExchange (issue #21):
 * remove the trailing assistant message (if any) and the preceding user
 * message from the shared session file, so a regenerated turn never feeds
 * the model the answer being replaced. The desktop has no server-side
 * regenerate (its client re-sends history), so this stays a web-only helper
 * over the same on-disk files. */
export function dropLastExchange({ projectPath, sessionId }) {
  const session = loadSession(projectPath, sessionId)
  if (!session) return
  let idx = session.messages.length - 1
  if (idx >= 0 && session.messages[idx].role === "assistant") {
    session.messages.pop()
    idx -= 1
  }
  if (idx >= 0 && session.messages[idx].role === "user") session.messages.pop()
  saveSession(projectPath, session)
}

/** Port of AgentSessionStore::recent_messages — last `limit` messages. */
export function recentMessages({ projectPath, sessionId, limit }) {
  const session = loadSession(projectPath, sessionId)
  if (!session) return []
  const n = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  const start = Math.max(0, session.messages.length - n)
  return session.messages.slice(start).map(normalizeMessage)
}

/** Port of AgentSessionStore::list_sessions — newest updatedAt first. */
export function listSessions(projectPath) {
  const dir = path.join(projectPath, ".llm-wiki", "agent-sessions")
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const sessions = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, e.name), "utf-8"))
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.messages)) continue
    sessions.push({
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : e.name.slice(0, -5),
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
      messages: parsed.messages.map(normalizeMessage),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    })
  }
  // Rust: b.updated_at.cmp(&a.updated_at).then_with(|| b.session_id.cmp(&a.session_id))
  sessions.sort((a, b) =>
    (b.updatedAt - a.updatedAt)
    || (a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0),
  )
  return sessions
}
