import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { readStore } from "./store.js"
import { searchCommands } from "./commands/search.js"
import { buildSnapshot } from "./graph.js"
import { fileSyncCommands } from "./commands/fileSync.js"
import { agentStartTurn, agentCancelTurn } from "./agent.js"
import { recentMessages } from "./agent-sessions.js"

// Server port of the desktop's external REST API (src-tauri/src/api_server.rs)
// so the bundled MCP server (mcp-server/src/api-client.ts) and the advertised
// external agent skill talk to the WEB backend unchanged — i.e. "one backend"
// for the user AND their agents. Response envelopes, the public-path guard,
// traversal-safe joins, and auth all mirror the Rust source so the MCP client's
// parsers (requireObject + field reads) succeed byte-for-byte.
//
// Auth is read from the SAME shared store the desktop uses (apiConfig.token) or
// LLM_WIKI_API_TOKEN, so a token set in the desktop's Settings is enforced here
// too. Accepted via ?token=, header x-llm-wiki-token, or Authorization: Bearer.

import { constantTimeEq } from "./lib/crypto-utils.js"

// Mirror env!("CARGO_PKG_VERSION") in api_server.rs: the desktop reports the
// app version in /api/v1/health; the web server reports the server package
// version (identical in-repo).
const SERVER_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version

const fwd = (p) => p.split(path.sep).join("/")
const normPath = (p) => fwd(p).replace(/\\/g, "/")
function fmType(content) {
  const m = /^---\n[\s\S]*?\n---/.exec(String(content || ""))
  if (!m) return ""
  const t = /^type:\s*["']?([^"'\n]+?)\s*["']?\s*$/m.exec(m[0])
  return t ? t[1].trim().toLowerCase() : ""
}

// ── auth (mirror api_server.rs) ───────────────────────────────────────────
export function apiAuth(store) {
  const envT = (process.env.LLM_WIKI_API_TOKEN || "").trim()
  const cfg = (store && store.apiConfig) || {}
  const storeT = typeof cfg.token === "string" ? cfg.token.trim() : ""
  const token = envT || storeT
  const source = envT ? "env" : (storeT ? "store" : "none")
  const allowUnauth = cfg.allowUnauthenticated === true
  const enabled = cfg.enabled !== false
  // api_server.rs: api_mcp_enabled / api_allow_lan_access read the store booleans
  // with unwrap_or(false) — the same shared store must yield the same contract
  // on the desktop and the web (the MCP stdio server self-disables on
  // health.mcpEnabled === false, exactly like the desktop).
  const mcpEnabled = cfg.mcpEnabled === true
  const allowLanAccess = cfg.allowLanAccess === true
  return { token, source, allowUnauth, authRequired: !allowUnauth, authConfigured: !!token, enabled, mcpEnabled, allowLanAccess }
}
// Desktop api_server.rs::is_token_authorized — an actual token must match;
// allowUnauthenticated is NOT consulted here (used for the agent-chat gate).
function tokenMatches(store, headers, searchParams) {
  const a = apiAuth(store)
  if (!a.token) return false
  const qtok = searchParams.get("token")
  if (qtok && constantTimeEq(qtok, a.token)) return true
  const x = headers["x-llm-wiki-token"]
  if (typeof x === "string" && constantTimeEq(x, a.token)) return true
  const auth = headers["authorization"]
  if (typeof auth === "string" && auth.startsWith("Bearer ") && constantTimeEq(auth.slice(7), a.token)) return true
  return false
}
function isAuthorized(store, headers, searchParams) {
  const a = apiAuth(store)
  if (!a.authRequired) return true
  return tokenMatches(store, headers, searchParams)
}
// Desktop api_server.rs::is_agent_chat_request — POST chat + POST chat/cancel
// always require a real token, even when the rest of the API is open.
function isAgentChatRequest(method, segs) {
  return method === "POST" && (
    segs.length === 3 && segs[0] === "projects" && segs[2] === "chat"
  ) || (segs.length === 5 && segs[0] === "projects" && segs[2] === "chat" && segs[4] === "cancel")
}

// ── public-path guard + safe join (mirror is_public_project_rel/safe_join) ─
function isPublicRel(rel) {
  const r = normPath(rel).replace(/^\/+/, "")
  if (r.split("/").some((p) => p === "" || p.startsWith("."))) return false
  const l = r.toLowerCase()
  return l === "purpose.md" || l === "schema.md" || l.startsWith("wiki/") || l.startsWith("raw/sources/")
}
const TEXT_EXTS = new Set(["md","mdx","txt","csv","json","yaml","yml","xml","html","htm","rtf","log"])
function isTextRel(rel) { return TEXT_EXTS.has((path.extname(rel).slice(1) || "").toLowerCase()) }
function safeJoin(projectPath, rel) {
  const r = String(rel || "").replace(/^\/+/, "")
  const rp = path.normalize(r)
  if (path.isAbsolute(rp) || rp.split(path.sep).some((c) => c === "..")) throw new Error("Path traversal is not allowed")
  const joined = path.join(projectPath, rp)
  const rootCanon = fs.realpathSync(projectPath)
  if (fs.existsSync(joined)) {
    const jc = fs.realpathSync(joined)
    if (jc !== rootCanon && !jc.startsWith(rootCanon + path.sep)) throw new Error("Resolved path escapes the project directory")
    return jc
  }
  const parent = path.dirname(joined)
  if (fs.existsSync(parent)) {
    const pc = fs.realpathSync(parent)
    if (pc !== rootCanon && !pc.startsWith(rootCanon + path.sep)) throw new Error("Resolved parent escapes the project directory")
  }
  return joined
}

// ── project resolution (mirror load_projects / resolve_project) ────────────
function readProjectIdOnDisk(p) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(p, ".llm-wiki", "project.json"), "utf-8"))
    return typeof j?.id === "string" && j.id ? j.id : null
  } catch { return null }
}
function projectNameFromPath(p) { return path.basename(p.replace(/\/+$/, "")) || "Unknown" }
function loadProjects(store) {
  const reg = (store && store.projectRegistry) || {}
  const recents = Array.isArray(store?.recentProjects) ? store.recentProjects : []
  const lastPath = normPath(store?.lastProject?.path || "")
  const byPath = new Map()
  for (const [id, v] of Object.entries(reg)) {
    const p = normPath(v?.path || "")
    if (!p) continue
    byPath.set(p, { id, name: typeof v?.name === "string" && v.name ? v.name : projectNameFromPath(p), path: p, current: p === lastPath })
  }
  for (const v of recents) {
    const p = normPath(v?.path || "")
    if (!p || byPath.has(p)) continue
    const id = (typeof v?.id === "string" && v.id) ? v.id : (readProjectIdOnDisk(p) || p)
    byPath.set(p, { id, name: typeof v?.name === "string" && v.name ? v.name : projectNameFromPath(p), path: p, current: p === lastPath })
  }
  return [...byPath.values()]
}
function resolveProject(store, id) {
  const projects = loadProjects(store)
  if (id === "current") {
    const cur = projects.find((p) => p.current) || (projects.length === 1 ? projects[0] : null)
    if (!cur) throw Object.assign(new Error("No current project. Open a project first."), { status: 404 })
    return cur
  }
  let found = projects.find((p) => p.id === id)
  if (!found) found = projects.find((p) => normPath(p.path) === normPath(id))
  if (!found) {
    const reg = (store && store.projectRegistry) || {}
    if (reg[id]?.path) found = { id, name: reg[id].name || projectNameFromPath(reg[id].path), path: normPath(reg[id].path), current: normPath(reg[id].path) === normPath(store?.lastProject?.path || "") }
  }
  if (!found) throw Object.assign(new Error(`Unknown project: ${id}`), { status: 404 })
  return found
}

// ── files ──────────────────────────────────────────────────────────────────
function walkPublic(dir, relBase, recursive, counter, maxFiles, truncated) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of entries) {
    if (e.name.startsWith(".")) continue
    if (counter.n >= maxFiles) { truncated.v = true; break }
    const full = path.join(dir, e.name)
    const rel = relBase ? `${relBase}/${e.name}` : e.name
    const isDir = e.isDirectory()
    const node = { name: e.name, path: fwd(rel), isDir }
    if (isDir) {
      if (recursive) node.children = walkPublic(full, rel, true, counter, maxFiles, truncated)
      else node.children = []
    } else {
      counter.n++
    }
    out.push(node)
  }
  return out
}
function listFiles(projectPath, root, recursive, maxFiles) {
  const roots = root === "sources" ? ["raw/sources"] : root === "all" ? ["wiki", "raw/sources"] : ["wiki"]
  const counter = { n: 0 }
  const truncated = { v: false }
  const files = []
  for (const r of roots) {
    const abs = path.join(projectPath, r)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue
    if (recursive) {
      const kids = walkPublic(abs, r, true, counter, maxFiles, truncated)
      files.push({ name: path.basename(r === "raw/sources" ? "sources" : r), path: fwd(r), isDir: true, children: kids })
    } else {
      files.push(...walkPublic(abs, r, false, counter, maxFiles, truncated))
    }
    if (truncated.v) break
  }
  return { files, truncated: truncated.v }
}

// ── reviews — faithful port of api_server.rs (parse_review_query /
//    load_review_items / sanitize_review_item / merge_sanitized_review /
//    patch_review_item / resolve_review_items). Review ids are stable FNV-1a
//    hashes of `type::normalizedTitle` (review_id_for_parts), so the same
//    item gets the SAME id on the desktop and the web (and through the MCP
//    client) — the shared-data promise for `.llm-wiki/review.json`. ─────────
const DEFAULT_MAX_REVIEWS = 200   // api_server.rs DEFAULT_MAX_REVIEWS
const HARD_MAX_REVIEWS = 1000     // api_server.rs HARD_MAX_REVIEWS

function normalizeReviewTitle(title) {
  const trimmed = String(title || "").trimStart()
  const lower = trimmed.toLowerCase()
  let rest = trimmed
  for (const prefix of [
    "missing page", "missing-page", "missingpage",
    "duplicate page", "duplicate-page", "duplicatepage",
    "possible duplicate", "possible-duplicate", "possibleduplicate",
    "缺失页面", "缺少页面", "重复页面", "疑似重复",
  ]) {
    if (!lower.startsWith(prefix)) continue
    const suffix = trimmed.slice(prefix.length)
    if (!suffix.length) continue
    const delimiter = suffix[0]
    if (delimiter === ":" || delimiter === "：") {
      rest = suffix.slice(1).trimStart()
      break
    }
  }
  return rest.split(/\s+/).filter(Boolean).join(" ").toLowerCase()
}

// review_id_for_parts: FNV-1a/32 over the UTF-16 code units (the exact
// sequence Rust `str::encode_utf16` yields — surrogate pairs for astral
// chars, which JS charCodeAt iteration already produces).
function reviewIdForParts(itemType, title) {
  const key = `${itemType}::${normalizeReviewTitle(title)}`
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `review-${h.toString(16).padStart(8, "0")}`
}

function stableReviewId(item) {
  if (!item || typeof item.type !== "string" || typeof item.title !== "string") return undefined
  return reviewIdForParts(item.type, item.title)
}

function reviewIdMatches(item, requestedId) {
  return item?.id === requestedId || stableReviewId(item) === requestedId
}

function parseReviewQuery(queryString) {
  const params = new URLSearchParams(queryString || "")
  let status
  switch (params.get("status") ?? "unresolved") {
    case "unresolved":
    case "pending":
      status = "unresolved"
      break
    case "resolved":
      status = "resolved"
      break
    case "all":
      status = "all"
      break
    default:
      throw new Error(`Invalid review status '${params.get("status")}'. Expected unresolved, resolved, or all`)
  }
  const itemType = (params.get("type") ?? "").trim() || undefined
  let limit = DEFAULT_MAX_REVIEWS
  const rawLimit = params.get("limit")
  if (rawLimit != null && /^\d+$/.test(rawLimit)) limit = Number(rawLimit)
  limit = Math.min(HARD_MAX_REVIEWS, Math.max(1, limit))
  return { status, itemType, limit }
}

function sanitizeReviewItem(item) {
  const out = {}
  if (!item || typeof item !== "object" || Array.isArray(item)) return out
  const stable = stableReviewId(item)
  if (stable) out.id = stable
  else if (typeof item.id === "string") out.id = item.id
  for (const key of ["type", "title", "description", "sourcePath"]) {
    if (typeof item[key] === "string") out[key] = item[key]
  }
  for (const key of ["affectedPages", "searchQueries"]) {
    if (Array.isArray(item[key])) out[key] = item[key].filter((v) => typeof v === "string")
  }
  if (Array.isArray(item.options)) {
    const options = []
    for (const option of item.options) {
      if (!option || typeof option !== "object" || Array.isArray(option)) continue
      const sanitized = {}
      if (typeof option.label === "string") sanitized.label = option.label
      if (typeof option.action === "string") sanitized.action = option.action
      if (Object.keys(sanitized).length) options.push(sanitized)
    }
    out.options = options
  }
  if (typeof item.resolved === "boolean") out.resolved = item.resolved
  if (typeof item.resolvedAction === "string") out.resolvedAction = item.resolvedAction
  if (typeof item.createdAt === "number" && Number.isFinite(item.createdAt)) out.createdAt = item.createdAt
  return out
}

function mergeSanitizedReview(existing, incoming) {
  existing.resolved = (existing.resolved === true) || (incoming.resolved === true)
  if (existing.resolved && !("resolvedAction" in existing) && typeof incoming.resolvedAction === "string") {
    existing.resolvedAction = incoming.resolvedAction
  }
  for (const key of ["description", "sourcePath"]) {
    const existingEmpty = typeof existing[key] !== "string" || existing[key].length === 0
    if (existingEmpty && typeof incoming[key] === "string") existing[key] = incoming[key]
  }
  mergeStringArrayField(existing, incoming, "affectedPages")
  mergeStringArrayField(existing, incoming, "searchQueries")
  mergeReviewOptionsField(existing, incoming)
  if (typeof incoming.createdAt === "number") {
    const existingCreated = typeof existing.createdAt === "number" ? existing.createdAt : incoming.createdAt
    existing.createdAt = Math.min(existingCreated, incoming.createdAt)
  }
}

function mergeStringArrayField(existing, incoming, key) {
  const values = Array.isArray(existing[key])
    ? existing[key].filter((v) => typeof v === "string")
    : []
  const incomingValues = Array.isArray(incoming[key]) ? incoming[key] : []
  for (const value of incomingValues) {
    if (typeof value !== "string") continue
    if (!values.includes(value)) values.push(value)
  }
  if (values.length) existing[key] = values
}

function mergeReviewOptionsField(existing, incoming) {
  const options = Array.isArray(existing.options) ? existing.options : []
  const incomingOptions = Array.isArray(incoming.options) ? incoming.options : []
  for (const option of incomingOptions) {
    const action = option?.action
    const alreadyPresent = typeof action === "string" && options.some((o) => o?.action === action)
    if (typeof action === "string" && !alreadyPresent) options.push(option)
  }
  if (options.length) existing.options = options
}

function loadReviewItems(projectPath, query) {
  const file = path.join(projectPath, ".llm-wiki", "review.json")
  let raw
  try { raw = fs.readFileSync(file, "utf-8") } catch (e) {
    if (e.code === "ENOENT") return []
    throw new Error(`Failed to read review state: ${e.message}`)
  }
  let parsed
  try { parsed = JSON.parse(raw) } catch (e) { throw new Error(`Invalid review state JSON: ${e.message}`) }
  if (!Array.isArray(parsed)) throw new Error("Invalid review state JSON: expected an array")
  const normalized = []
  const indexById = new Map()
  for (const item of parsed) {
    const sanitized = sanitizeReviewItem(item)
    const id = typeof sanitized.id === "string" ? sanitized.id : null
    if (id) {
      const existingIdx = indexById.get(id)
      if (existingIdx !== undefined) {
        mergeSanitizedReview(normalized[existingIdx], sanitized)
        continue
      }
      indexById.set(id, normalized.length)
    }
    normalized.push(sanitized)
  }
  const reviews = []
  for (const item of normalized) {
    const resolved = item.resolved === true
    if (query.status === "unresolved" && resolved) continue
    if (query.status === "resolved" && !resolved) continue
    if (query.itemType !== undefined && item.type !== query.itemType) continue
    if (reviews.length >= query.limit) break
    reviews.push(item)
  }
  return reviews
}

// Raw-array write helpers for PATCH / resolve — they operate on the RAW
// parsed array (not loadReviewItems, which sanitizes and would strip unknown
// fields like internalSecret on write-back).
function readRawReviewArray(projectPath) {
  const file = path.join(projectPath, ".llm-wiki", "review.json")
  let raw
  try { raw = fs.readFileSync(file, "utf-8") } catch (e) {
    if (e.code === "ENOENT") return null
    throw new Error(`Failed to read review state: ${e.message}`)
  }
  try { return JSON.parse(raw) } catch (e) { throw new Error(`Invalid review state JSON: ${e.message}`) }
}

function writeRawReviewArray(projectPath, parsed) {
  const file = path.join(projectPath, ".llm-wiki", "review.json")
  let serialized
  try { serialized = JSON.stringify(parsed, null, 2) } catch (e) { throw new Error(`Failed to serialize review state: ${e.message}`) }
  fs.writeFileSync(file, serialized)
}

function applyResolution(item, resolved, action) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return
  item.resolved = resolved
  if (!resolved) delete item.resolvedAction
  else if (typeof action === "string") item.resolvedAction = action
}

function patchReviewItem(projectPath, reviewId, resolved, action) {
  const parsed = readRawReviewArray(projectPath)
  if (parsed === null) return false
  if (!Array.isArray(parsed)) throw new Error("Invalid review state JSON: expected an array")
  let found = false
  for (const item of parsed) {
    if (!reviewIdMatches(item, reviewId)) continue
    applyResolution(item, resolved, action)
    const stable = stableReviewId(item)
    if (stable) item.id = stable
    found = true
  }
  if (!found) return false
  writeRawReviewArray(projectPath, parsed)
  return true
}

function resolveReviewItems(projectPath, ids, action) {
  const parsed = readRawReviewArray(projectPath)
  if (parsed === null) return [[], ids.slice()]
  if (!Array.isArray(parsed)) throw new Error("Invalid review state JSON: expected an array")
  const found = new Set()
  for (const item of parsed) {
    const rawId = typeof item?.id === "string" ? item.id : null
    const stable = stableReviewId(item)
    const requestedId = ids.find((id) => rawId === id || stable === id)
    if (requestedId === undefined) continue
    applyResolution(item, true, action)
    if (stable) item.id = stable
    found.add(requestedId)
  }
  if (found.size) writeRawReviewArray(projectPath, parsed)
  const resolved = ids.filter((id) => found.has(id))
  const notFound = ids.filter((id) => !found.has(id))
  return [resolved, notFound]
}

// ── graph (from graph.js snapshot) ─────────────────────────────────────────
function buildGraph(projectPath, { q, nodeType, limit }) {
  const { pages, adjacency } = buildSnapshot(projectPath, null)
  let nodes = pages.map((p) => {
    const deg = (adjacency.get(p.path)?.size) || 0
    return { id: fwd(p.path), label: p.title || p.stem, nodeType: (fmType(p.content) || p.type || "other"), path: fwd(p.path), linkCount: deg, weight: 1 }
  })
  const edgeSet = new Set()
  const edges = []
  for (const [a, set] of adjacency) {
    for (const b of set) {
      const key = a < b ? `${a}|${b}` : `${b}|${a}`
      if (edgeSet.has(key)) continue
      edgeSet.add(key)
      edges.push({ source: fwd(a), target: fwd(b), weight: 1 })
    }
  }
  if (nodeType) { const t = String(nodeType).toLowerCase(); nodes = nodes.filter((n) => String(n.nodeType).toLowerCase() === t) }
  if (q) { const ql = String(q).toLowerCase(); nodes = nodes.filter((n) => n.label.toLowerCase().includes(ql) || n.id.toLowerCase().includes(ql)) }
  const keep = new Set(nodes.map((n) => n.id))
  const fEdges = edges.filter((e) => keep.has(e.source) && keep.has(e.target))
  if (typeof limit === "number" && limit >= 0) nodes = nodes.slice(0, limit)
  return { nodes, edges: fEdges }
}

// ── handler entry ──────────────────────────────────────────────────────────
export async function handleApiV1(ctx) {
  const { method, pathname, searchParams, headers, body, sendJson } = ctx
  if (!pathname.startsWith("/api/v1/")) return false
  const segs = pathname.slice("/api/v1/".length).split("/").filter(Boolean).map((s) => decodeURIComponent(s))
  const store = readStore("app-state.json")
  const a = apiAuth(store)
  const ok = (obj) => sendJson(200, { ok: true, ...obj })
  const err = (status, msg) => sendJson(status, { ok: false, error: msg })

  // Order mirrors api_server.rs::handle_request exactly:
  //   1. /health stays reachable (any method) even when the API is disabled.
  if (segs[0] === "health") {
    return ok({
      status: "ok", // web-server liveness string (pinned by the MCP gate)
      version: SERVER_VERSION,
      authRequired: a.authRequired,
      authConfigured: a.authConfigured,
      tokenSource: a.source,
      enabled: a.enabled,
      mcpEnabled: a.mcpEnabled,
      allowUnauthenticated: a.allowUnauth,
      allowLanAccess: a.allowLanAccess,
      agent: { chat: true, streaming: false },
    }), true
  }
  //   2. Kill-switch: the user disabled the API in Settings → API + MCP.
  //      Returned BEFORE auth so a disabled API 503s even with a valid
  //      token (desktop: "temporarily unavailable" beats "Unauthorized").
  if (!a.enabled) return err(503, "API server is disabled in Settings → API Server"), true
  //   3. Agent chat always requires a real token (desktop is_agent_chat_request
  //      + is_token_authorized), even in unauthenticated mode.
  if (isAgentChatRequest(method, segs) && !tokenMatches(store, headers, searchParams)) return err(401, "Unauthorized"), true
  //   4. General auth (allowUnauthenticated honored here).
  if (!isAuthorized(store, headers, searchParams)) return err(401, "Unauthorized"), true
  //   5. Method gate (desktop: only GET/POST/PATCH are dispatched).
  if (!(method === "GET" || method === "POST" || method === "PATCH")) return err(405, "Method not allowed"), true

  try {
    if (method === "GET" && segs[0] === "projects" && segs.length === 1) {
      const projects = loadProjects(store)
      return ok({ projects, currentProject: projects.find((p) => p.current) || null }), true
    }
    if (segs[0] === "projects" && segs.length >= 2) {
      const pid = segs[1]
      const project = resolveProject(store, pid)
      const rest = segs.slice(2)
      if (method === "GET" && rest[0] === "files" && rest.length === 1) {
        const root = searchParams.get("root") || "wiki"
        const recursive = searchParams.get("recursive") !== "false"
        const maxFiles = Math.max(1, Math.min(50000, Number(searchParams.get("maxFiles")) || 5000))
        const { files, truncated } = listFiles(project.path, root, recursive, maxFiles)
        return ok({ files, truncated }), true
      }
      if (method === "GET" && rest[0] === "files" && rest[1] === "content") {
        const rel = searchParams.get("path") || ""
        if (!isPublicRel(rel)) return err(403, "Path is not public"), true
        if (!isTextRel(rel)) return err(400, "Only text files can be read through the API"), true
        let abs
        try { abs = safeJoin(project.path, rel) } catch (e) { return err(400, e.message), true }
        let content
        try { content = fs.readFileSync(abs, "utf-8") } catch { return err(404, "File not found"), true }
        return ok({ path: rel, content }), true
      }
      if (method === "GET" && rest[0] === "reviews" && rest.length === 1) {
        let query
        try { query = parseReviewQuery(searchParams.toString()) }
        catch (e) { return err(400, e instanceof Error ? e.message : String(e)), true }
        let reviews
        try { reviews = loadReviewItems(project.path, query) }
        catch (e) { return err(500, e instanceof Error ? e.message : String(e)), true }
        return ok({ projectId: project.id, status: query.status, count: reviews.length, reviews }), true
      }
      if (method === "PATCH" && rest[0] === "reviews" && rest.length === 2) {
        // handle_patch_review: empty body resolves (resolved defaults to true).
        const reviewId = decodeURIComponent(rest[1])
        let patch = { resolved: undefined, action: undefined }
        if (body && String(body).trim()) {
          let parsed
          try { parsed = JSON.parse(body) } catch (e) { return err(400, `Invalid request body: ${e.message}`), true }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return err(400, "Invalid request body: expected an object"), true
          if ("resolved" in parsed && typeof parsed.resolved !== "boolean") return err(400, `Invalid request body: \`resolved\` must be a boolean`), true
          if ("action" in parsed && typeof parsed.action !== "string") return err(400, `Invalid request body: \`action\` must be a string`), true
          patch = { resolved: parsed.resolved, action: parsed.action }
        }
        const resolved = patch.resolved === undefined ? true : patch.resolved
        let patched
        try { patched = patchReviewItem(project.path, reviewId, resolved, patch.action) }
        catch (e) { return err(500, e instanceof Error ? e.message : String(e)), true }
        if (!patched) return err(404, `Review item '${reviewId}' not found`), true
        return ok({ projectId: project.id, reviewId, resolved }), true
      }
      if (method === "POST" && rest[0] === "reviews" && rest[1] === "resolve" && rest.length === 2) {
        // handle_bulk_resolve_reviews: partial success is normal (200 + notFound).
        let parsed
        try { parsed = body && String(body).trim() ? JSON.parse(body) : {} }
        catch (e) { return err(400, `Invalid request body: ${e.message}`), true }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("ids" in parsed)) {
          return err(400, "Invalid request body: missing field `ids`"), true
        }
        if (!Array.isArray(parsed.ids)) return err(400, "Invalid request body: `ids` must be an array"), true
        if (parsed.ids.length === 0) return err(400, "ids must be a non-empty array"), true
        if (!parsed.ids.every((id) => typeof id === "string")) return err(400, "Invalid request body: `ids` must contain only strings"), true
        if ("action" in parsed && typeof parsed.action !== "string") return err(400, "Invalid request body: `action` must be a string"), true
        let resolvedArr, notFoundArr
        try { [resolvedArr, notFoundArr] = resolveReviewItems(project.path, parsed.ids, parsed.action) }
        catch (e) { return err(500, e instanceof Error ? e.message : String(e)), true }
        return ok({ projectId: project.id, resolved: resolvedArr, notFound: notFoundArr, count: resolvedArr.length }), true
      }
      if (method === "POST" && rest[0] === "search" && rest.length === 1) {
        // handle_search: serde-style strict parse, query required, then the
        // shared hybrid engine (search_project's validation carries the exact
        // queryEmbedding error strings from resolve_query_embedding).
        let b
        try { b = body && String(body).trim() ? JSON.parse(body) : {} }
        catch (e) { return err(400, `Invalid JSON: ${e.message}`), true }
        if (!b || typeof b !== "object" || Array.isArray(b) || typeof b.query !== "string") {
          return err(400, "Invalid JSON: missing field `query`"), true
        }
        if ("topK" in b && (typeof b.topK !== "number" || !Number.isInteger(b.topK) || b.topK < 0)) {
          return err(400, "Invalid JSON: invalid type for `topK`"), true
        }
        const embCfg = store?.embeddingConfig
        let r
        try {
          r = await searchCommands.search_project({
            projectPath: project.path, query: b.query,
            topK: b.topK === undefined ? 10 : b.topK,
            includeContent: b.includeContent === true,
            queryEmbedding: Array.isArray(b.queryEmbedding) ? b.queryEmbedding : null,
            embeddingConfig: embCfg && embCfg.enabled ? embCfg : null,
            wikiSearchMode: store?.wikiSearchMode ?? null,
          })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg === "query is required" || msg.startsWith("queryEmbedding")) return err(400, msg), true
          return err(500, msg), true
        }
        return ok({
          projectId: project.id,
          mode: r.mode,
          note: "Search uses the shared backend hybrid retrieval service, combining keyword, vector, and one-hop knowledge-graph candidates. When embeddingConfig is enabled, the API automatically includes LanceDB vector results; clients may also pass queryEmbedding explicitly.",
          tokenHits: r.tokenHits, vectorHits: r.vectorHits, graphHits: r.graphHits,
          results: r.results,
          ...(r.vectorUnavailableReason ? { vectorUnavailableReason: r.vectorUnavailableReason } : {}),
        }), true
      }
      if (method === "POST" && rest[0] === "chat" && rest.length === 1) {
        // handle_chat: strict serde-style parse, then the runtime's
        // "message is required" guard; provider/network failures map to 502.
        let b
        try { b = body && String(body).trim() ? JSON.parse(body) : {} }
        catch (e) { return err(400, `Invalid JSON: ${e.message}`), true }
        if (!b || typeof b !== "object" || Array.isArray(b) || typeof b.message !== "string") {
          return err(400, "Invalid JSON: missing field `message`"), true
        }
        if (!b.message.trim()) return err(400, "message is required"), true
        // Desktop handle_chat defaults: api_<uuid> sessions, run_<uuid> runs.
        const sessionId = (typeof b?.sessionId === "string" && b.sessionId.trim()) ? b.sessionId.trim() : `api_${crypto.randomUUID()}`
        const runId = (typeof b?.runId === "string" && b.runId.trim()) ? b.runId.trim() : `run_${crypto.randomUUID()}`
        const historyExplicit = b?.historyExplicit === true
        const clientHistory = Array.isArray(b?.history) ? b.history : []
        // Desktop handle_chat: when the caller sent no history (and did not
        // mark one explicit), hydrate the last 12 MESSAGES from the SHARED
        // on-disk AgentSessionStore (.llm-wiki/agent-sessions/<id>.json), so
        // a session started through the desktop's API/MCP surface (or this
        // one) resumes with the same context on either backend.
        const history = (clientHistory.length > 0 || historyExplicit)
          ? clientHistory
          : recentMessages({ projectPath: project.path, sessionId, limit: 12 })
              .map((m) => ({ role: m.role, content: m.content }))
        const request = {
          message: String(b?.message ?? ""), sessionId, runId,
          mode: b?.mode || "standard", retrievalMode: "standard",
          tools: b?.tools && typeof b.tools === "object" ? { wiki: b.tools.wiki !== false, web: !!b.tools.web, anytxt: !!b.tools.anytxt } : { wiki: true, web: false, anytxt: false },
          topK: Number(b?.topK) || 5, includeContent: b?.includeContent === true,
          skills: Array.isArray(b?.skills) ? b.skills : [], history, historyExplicit,
          // Desktop default_true — the runtime appends the completed turn to
          // the shared session store unless the caller opts out.
          persistSession: b?.persistSession !== false,
        }
        let resp
        try { resp = await agentStartTurn({ projectId: project.id, request }) }
        catch (e) {
          // Desktop handle_chat error mapping: "message is required" is 400,
          // a cancelled turn is 499, everything else (provider/network) is 502.
          const msg = e instanceof Error ? e.message : String(e)
          if (msg === "message is required") return err(400, msg), true
          if (msg === "Agent run cancelled" || /cancelled|abort/i.test(msg)) return err(499, "Agent turn cancelled"), true
          return err(502, msg), true
        }
        const content = typeof resp.message === "string" ? resp.message : (resp.message?.content ?? "")
        const refs = resp.references || []
        const te = resp.toolEvents || []
        // The desktop envelope exposes the turn's AgentEvent vector (redacted);
        // the runtime collects it for non-stream turns (agentStartTurn).
        const evs = Array.isArray(resp.events) ? resp.events : []
        return ok({ projectId: project.id, sessionId: resp.sessionId || sessionId, mode: resp.mode || request.mode, message: { role: "assistant", content }, references: refs, toolEvents: te, events: evs, usage: { referenceCount: refs.length, toolEventCount: te.length } }), true
      }
      if (method === "POST" && rest[0] === "chat" && rest.length === 3 && rest[2] === "cancel") {
        // Desktop handle_cancel_chat: resolve the project, then cancel every
        // active run for that session (registry cancel with run_id=None).
        const sid = rest[1]
        let cancelled = false
        try { cancelled = await agentCancelTurn({ projectId: project.id, sessionId: sid }) } catch { /* best effort */ }
        return ok({ sessionId: sid, cancelled }), true
      }
      if (method === "GET" && rest[0] === "graph") {
        const g = buildGraph(project.path, { q: searchParams.get("q") || undefined, nodeType: searchParams.get("nodeType") || undefined, limit: searchParams.has("limit") ? Number(searchParams.get("limit")) : undefined })
        return ok({ projectId: project.id, nodes: g.nodes, edges: g.edges }), true
      }
      if (method === "POST" && rest[0] === "sources" && rest[1] === "rescan") {
        const r = await fileSyncCommands.rescan_project_files({ projectId: project.id, projectPath: project.path })
        return ok({ projectId: project.id, result: { changed: (r.changedTasks || []).length, queueVersion: r.queue?.version ?? 0 } }), true
      }
    }
    return err(404, "Not found"), true
  } catch (e) {
    const status = (e && typeof e.status === "number") ? e.status : 500
    return err(status, e instanceof Error ? e.message : String(e)), true
  }
}

