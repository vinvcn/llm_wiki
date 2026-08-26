// Chrome Web Clipper companion listener — a faithful port of the desktop's
// src-tauri/src/clip_server.rs (+ the CORS rules of src-tauri/src/cors.rs and
// the token auth of src-tauri/src/api_server.rs).
//
// The desktop app runs a tiny HTTP server on port 19827 that the LLM Wiki
// Chrome extension (extension/) talks to: it lists projects, receives clipped
// pages, writes them to <project>/raw/sources/<slug>-<date>.md, and hands the
// pending clips to the app frontend (which polls /clips/pending and enqueues
// ingest). The web server runs on the SAME host as the user's projects, so it
// hosts this exact protocol too — the unmodified extension works against
// either backend, and web-mode users get the clipper as well.
//
// Faithful details kept from the Rust source:
//   - PORT 19827 (override with LLM_WIKI_CLIP_PORT, e.g. for tests; the
//     extension's settings accept a custom server origin the same way)
//   - bind retries: 3 attempts, 2s apart; then status "port_conflict" and NO
//     further retries (needs user action — e.g. the desktop app owns the port)
//   - crash restarts: up to 10, 5s apart
//   - daemon status machine: starting → running | port_conflict | error
//   - exact route set + response shapes/status codes (incl. 404 body)
//   - CORS: only the narrow allow-listed browser origins (chrome-extension://,
//     moz-extension://, localhost/127.0.0.1/[::1] http only, tauri origins)
//   - auth: loopback callers bypass; any other caller must present the API
//     token (LLM_WIKI_API_TOKEN or the shared store's apiConfig.token) via
//     Authorization: Bearer or x-llm-wiki-token — no token configured means
//     non-loopback requests are rejected, exactly like the desktop
//   - clip file naming: slug (alphanumeric/space/dash, whitespace-joined,
//     lowercased, 50 chars) + -YYYYMMDD, unique via -2, -3, ... suffix
//   - clip markdown frontmatter byte-for-byte (type: clip, origin: web-clip)

import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { HOST } from "./config.js"
import { readStore } from "./store.js"
import { apiAuth } from "./api-v1.js"

export const CLIP_PORT = Number(process.env.LLM_WIKI_CLIP_PORT || 19827)
const MAX_BIND_RETRIES = 3
const MAX_RESTART_RETRIES = 10
const BIND_RETRY_DELAY_MS = 2000
const RESTART_DELAY_MS = 5000
const VERSION = "0.1.0"
const MAX_BODY_BYTES = 64 * 1024 * 1024 // infra guard only (extension caps at 1M chars)

// ── daemon state (mirror of the Rust statics) ─────────────────────────────
let currentProject = ""                 // CURRENT_PROJECT
let allProjects = []                    // ALL_PROJECTS: [{name, path}]
let pendingClips = []                   // PENDING_CLIPS: [{projectPath, filePath}]
let daemonStatus = 0                    // 0=starting, 1=running, 2=port_conflict, 3=error
let restartCount = 0
let server = null
let stopped = false

/** Daemon status as the desktop reports it: starting|running|port_conflict|error */
export function getClipStatus() {
  switch (daemonStatus) {
    case 0: return "starting"
    case 1: return "running"
    case 2: return "port_conflict"
    default: return "error"
  }
}

export function stopClipServer() {
  stopped = true
  if (server) { try { server.close() } catch { /* ignore */ } server = null }
}

// ── CORS (mirror cors.rs) ─────────────────────────────────────────────────
function isAllowedBrowserOrigin(origin) {
  return origin.startsWith("chrome-extension://")
    || origin.startsWith("moz-extension://")
    || origin === "http://localhost"
    || origin.startsWith("http://localhost:")
    || origin === "http://127.0.0.1"
    || origin.startsWith("http://127.0.0.1:")
    || origin === "http://[::1]"
    || origin.startsWith("http://[::1]:")
    || origin === "tauri://localhost"
    || origin === "http://tauri.localhost"
    || origin === "https://tauri.localhost"
}

function corsHeaders(origin, allowHeaders) {
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": allowHeaders,
    "Content-Type": "application/json",
  }
  if (origin && isAllowedBrowserOrigin(origin)) {
    h["Access-Control-Allow-Origin"] = origin
    h["Vary"] = "Origin"
    h["Access-Control-Allow-Private-Network"] = "true"
  }
  return h
}

const CLIP_ALLOW_HEADERS = "Content-Type, Authorization, X-LLM-Wiki-Token"

// ── auth (mirror clip_server.rs request_is_loopback/request_is_authorized) ─
function isLoopback(req) {
  const a = req.socket.remoteAddress
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1"
}

function constantTimeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b))
  if (A.length !== B.length) return false
  let d = 0
  for (let i = 0; i < A.length; i++) d |= A[i] ^ B[i]
  return d === 0
}

// The desktop calls is_token_authorized(app, "", headers) for clip requests:
// headers only (no ?token= query), and NO token configured ⇒ never authorized.
function requestIsAuthorized(req) {
  let store = {}
  try { store = readStore() || {} } catch { store = {} }
  const { token } = apiAuth(store)
  if (!token) return false
  const x = req.headers["x-llm-wiki-token"]
  if (typeof x === "string" && constantTimeEq(x, token)) return true
  const auth = req.headers["authorization"]
  if (typeof auth === "string" && auth.startsWith("Bearer ") && constantTimeEq(auth.slice(7), token)) return true
  return false
}

// ── body reading ──────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (c) => {
      size += c.length
      if (size > MAX_BODY_BYTES) { reject(new Error("Request body too large")); req.destroy(); return }
      chunks.push(c)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
    req.on("error", reject)
  })
}

// ── handlers (mirror handle_set_project / handle_clip) ────────────────────
function handleSetProject(body) {
  let parsed
  try { parsed = JSON.parse(body) }
  catch (e) { return JSON.stringify({ ok: false, error: `Invalid JSON: ${e.message}` }) }
  if (typeof parsed.path !== "string") return JSON.stringify({ ok: false, error: "path field is required" })
  // Normalize to forward slashes on ingress (desktop does the same).
  currentProject = parsed.path.replace(/\\/g, "/")
  return JSON.stringify({ ok: true })
}

function slugify(title) {
  const raw = [...String(title)]
    .map((c) => (/^[\p{L}\p{N}]$/u.test(c) || c === " " || c === "-" ? c : " "))
    .join("")
  const joined = raw.trim().split(/\s+/).filter(Boolean).join("-").toLowerCase()
  return [...joined].slice(0, 50).join("")
}

function localDateParts() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, "0")
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    dateCompact: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
  }
}

function handleClip(body) {
  let parsed
  try { parsed = JSON.parse(body) }
  catch (e) { return JSON.stringify({ ok: false, error: `Invalid JSON: ${e.message}` }) }

  const title = typeof parsed.title === "string" ? parsed.title : "Untitled"
  const url = typeof parsed.url === "string" ? parsed.url : ""
  const content = typeof parsed.content === "string" ? parsed.content : ""

  // Use projectPath from request body, or fall back to globally-set project.
  const fromBody = typeof parsed.projectPath === "string" ? parsed.projectPath : ""
  const projectPath = (fromBody === "" ? currentProject : fromBody).replace(/\\/g, "/")
  if (projectPath === "") {
    return JSON.stringify({ ok: false, error: "projectPath is required (set via POST /project or include in request body)" })
  }
  if (content === "") {
    return JSON.stringify({ ok: false, error: "content is required" })
  }

  const { date, dateCompact } = localDateParts()
  const slug = slugify(title)
  const baseName = `${slug}-${dateCompact}`
  const dirPath = path.join(projectPath, "raw", "sources")

  try { fs.mkdirSync(dirPath, { recursive: true }) }
  catch (e) { return JSON.stringify({ ok: false, error: `Failed to create directory: ${e.message}` }) }

  // Find unique filename (counter starts at 2, exactly like the desktop).
  let filePath = path.join(dirPath, `${baseName}.md`)
  let counter = 2
  while (fs.existsSync(filePath)) {
    filePath = path.join(dirPath, `${baseName}-${counter}.md`)
    counter += 1
  }

  const esc = (s) => s.replace(/"/g, '\\"')
  const markdown =
    `---\ntype: clip\ntitle: "${esc(title)}"\nurl: "${esc(url)}"\nclipped: ${date}\n` +
    `origin: web-clip\nsources: []\ntags: [web-clip]\n---\n\n# ${title}\n\nSource: ${url}\n\n${content}\n`

  try { fs.writeFileSync(filePath, markdown) }
  catch (e) { return JSON.stringify({ ok: false, error: `Failed to write file: ${e.message}` }) }

  // Relative path (strip_prefix semantics: fall back to the full path).
  const filePathFwd = filePath.split(path.sep).join("/")
  let relativePath = filePathFwd
  try {
    const rel = path.relative(projectPath, filePath)
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) relativePath = rel.split(path.sep).join("/")
  } catch { /* keep full path */ }

  pendingClips.push({ projectPath, filePath: filePathFwd })

  return JSON.stringify({ ok: true, path: relativePath })
}

// ── request loop ──────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const origin = req.headers["origin"]
  const cors = corsHeaders(origin, CLIP_ALLOW_HEADERS)
  const respond = (status, body, extra) => {
    res.writeHead(status, { ...cors, ...(extra || {}) })
    res.end(body)
  }

  // CORS preflight (answered before auth, like the desktop).
  if (req.method === "OPTIONS") {
    respond(204, "", { "Access-Control-Max-Age": "600" })
    return
  }

  // Loopback callers preserve the pre-LAN behavior; any other caller must use
  // the same API token as the main API (see the Rust comment on this guard).
  if (!isLoopback(req) && !requestIsAuthorized(req)) {
    respond(401, JSON.stringify({ ok: false, error: "Missing or invalid API token" }))
    return
  }

  // The desktop matches the exact request URL (path + query), so "/status?x"
  // is a 404 there too. Node's req.url is the same request-target string.
  const url = req.url
  const key = `${req.method} ${url}`

  try {
    switch (key) {
      case "GET /status":
        respond(200, JSON.stringify({ ok: true, version: VERSION }))
        return
      case "GET /project":
        respond(200, JSON.stringify({ ok: true, path: currentProject }))
        return
      case "POST /project": {
        let body
        try { body = await readBody(req) }
        catch (e) { respond(400, JSON.stringify({ ok: false, error: `Failed to read body: ${e.message}` })); return }
        const result = handleSetProject(body)
        respond(result.includes('"ok":true') ? 200 : 400, result)
        return
      }
      case "GET /projects": {
        const items = allProjects.map((p) => ({ name: p.name, path: p.path, current: p.path === currentProject }))
        respond(200, JSON.stringify({ ok: true, projects: items }))
        return
      }
      case "POST /projects": {
        let body
        try { body = await readBody(req) } catch { body = null }
        if (body !== null) {
          try {
            const parsed = JSON.parse(body)
            if (Array.isArray(parsed.projects)) {
              const next = []
              for (const item of parsed.projects) {
                const name = typeof item?.name === "string" ? item.name : ""
                const p = typeof item?.path === "string" ? item.path : ""
                if (p !== "") next.push({ name, path: p })
              }
              allProjects = next
            }
          } catch { /* invalid body: still ok:true, exactly like the desktop */ }
        }
        respond(200, JSON.stringify({ ok: true }))
        return
      }
      case "GET /clips/pending": {
        const clips = pendingClips
        pendingClips = []
        respond(200, JSON.stringify({ ok: true, clips }))
        return
      }
      case "POST /clip": {
        let body
        try { body = await readBody(req) }
        catch (e) { respond(400, JSON.stringify({ ok: false, error: `Failed to read body: ${e.message}` })); return }
        const result = handleClip(body)
        respond(result.includes('"ok":true') ? 200 : 500, result)
        return
      }
      default:
        respond(404, JSON.stringify({ ok: false, error: "Not found" }))
    }
  } catch (e) {
    respond(500, JSON.stringify({ ok: false, error: `Internal error: ${e.message}` }))
  }
}

// ── lifecycle (mirror the bind-retry + restart loop) ──────────────────────
function tryStart() {
  if (stopped) return
  daemonStatus = 0 // starting

  const attempt = (n) => {
    if (stopped) return
    const candidate = http.createServer((req, res) => { handleRequest(req, res) })
    let bound = false
    candidate.on("error", (err) => {
      if (candidate !== server && bound) return // superseded listener
      if (!bound) {
        // Bind failure path: retry, then park as port_conflict (Rust: no
        // retry on port conflict — needs user action).
        if (n < MAX_BIND_RETRIES) {
          setTimeout(() => attempt(n + 1), BIND_RETRY_DELAY_MS)
        } else {
          console.error(`[Clip Server] Address ${HOST}:${CLIP_PORT} unavailable after ${MAX_BIND_RETRIES} attempts: ${err.message}`)
          daemonStatus = 2 // port_conflict
          server = null
        }
        return
      }
      // Crash path (the tiny_http request loop exiting): restart with backoff.
      daemonStatus = 3 // error
      server = null
      if (restartCount >= MAX_RESTART_RETRIES) {
        console.error(`[Clip Server] Exceeded max restarts (${MAX_RESTART_RETRIES}). Giving up.`)
        return
      }
      restartCount += 1
      console.error(`[Clip Server] Crashed. Restarting in ${RESTART_DELAY_MS / 1000}s (attempt ${restartCount}/${MAX_RESTART_RETRIES})`)
      setTimeout(tryStart, RESTART_DELAY_MS)
    })
    candidate.listen(CLIP_PORT, HOST, () => {
      if (stopped) { candidate.close(); return }
      bound = true
      server = candidate
      daemonStatus = 1 // running
      console.log(`[Clip Server] Listening on http://${HOST}:${CLIP_PORT}`)
    })
  }
  attempt(1)
}

export function startClipServer() {
  stopped = false
  tryStart()
}
