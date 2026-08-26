// Faithful Node port of the desktop's AnyTXT Search Engine integration.
//
// Sources of truth (unchanged desktop code):
//   - src-tauri/src/agent/tools.rs  -> run_anytxt_search, extract_anytxt_items,
//     first_anytxt_array, first_anytxt_fields, normalize_anytxt_record,
//     string_field, get_anytxt_fragment, extract_anytxt_fragment_text,
//     normalize_anytxt_endpoint, trim_text
//   - src-tauri/src/commands/external_search.rs -> file_url_for_path,
//     encode_file_url_path, percent_encode_file_segment
//
// The server runs on the host, so it talks to the local AnyTXT Search Engine
// (ATGUI.exe / anytxt service) over its JSON-RPC protocol exactly like the
// desktop: `ATRpcServer.Searcher.V1.GetResult` for the search and
// `ATRpcServer.Searcher.V1.GetFragment` to enrich each fid-bearing hit with
// its matching fragment. Error strings and return shapes match the Rust
// code so the unmodified React frontend works against either backend.

const DEFAULT_ANYTXT_ENDPOINT = "http://127.0.0.1:9920"
export const DEFAULT_ANYTXT_LIMIT = 20
// Desktop ANYTXT_LAST_MODIFY_END: i64 = 2_147_483_647 ("all time").
const ANYTXT_LAST_MODIFY_END = 2147483647
const WEB_SEARCH_TIMEOUT_MS = 30_000

// ── file URL encoding (external_search.rs) ──────────────────────────────────
function percentEncodeFileSegment(segment) {
  let out = ""
  for (const byte of Buffer.from(segment, "utf-8")) {
    if (
      (byte >= 0x41 && byte <= 0x5a) || // A-Z
      (byte >= 0x61 && byte <= 0x7a) || // a-z
      (byte >= 0x30 && byte <= 0x39) || // 0-9
      byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e || byte === 0x3a // - . _ ~ :
    ) {
      out += String.fromCharCode(byte)
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    }
  }
  return out
}

function encodeFileUrlPath(path) {
  return path.split("/").map(percentEncodeFileSegment).join("/")
}

// Desktop file_url_for_path: normalize separators, pass scheme/anytxt:// and
// empty paths through, map UNC -> file://host/share and drive/absolute paths
// -> file:/// encoded URLs.
export function fileUrlForPath(path) {
  const normalized = String(path ?? "").replace(/\\/g, "/")
  if (normalized === "" || normalized.includes("://")) return normalized
  if (normalized.startsWith("//")) return `file:${normalized}`
  if (
    normalized.length >= 3
    && normalized.charCodeAt(1) === 0x3a // ':'
    && normalized.charCodeAt(2) === 0x2f // '/'
    && /[a-zA-Z]/.test(normalized[0])
  ) {
    return `file:///${encodeFileUrlPath(normalized)}`
  }
  if (normalized.startsWith("/")) return `file://${encodeFileUrlPath(normalized)}`
  return normalized
}

// ── small helpers (tools.rs) ────────────────────────────────────────────────
export function trimText(value, maxChars) {
  const text = String(value)
  const chars = [...text]
  if (chars.length <= maxChars) return text
  return `${chars.slice(0, maxChars).join("")}...`
}

export function normalizeAnytxtEndpoint(value) {
  const text = String(value ?? "")
  if (text.startsWith("http://") || text.startsWith("https://")) return text
  return `http://${text}`
}

function valueAtPath(value, path) {
  let current = value
  for (const key of path) {
    if (current == null || typeof current !== "object" || Array.isArray(current)) return undefined
    current = current[key]
  }
  return current
}

function firstAnyTxtArray(value, paths) {
  for (const path of paths) {
    const candidate = valueAtPath(value, path)
    if (Array.isArray(candidate)) return candidate
  }
  return null
}

function firstAnyTxtFields(value, paths) {
  for (const path of paths) {
    const candidate = valueAtPath(value, path)
    if (!Array.isArray(candidate)) continue
    const fields = candidate.filter((item) => typeof item === "string")
    if (fields.length > 0) return fields
  }
  return null
}

// Desktop string_field: first matching key wins; strings are trimmed (and
// skipped when empty), integral numbers stringify.
function stringField(record, keys) {
  for (const key of keys) {
    const value = record?.[key]
    if (value === undefined || value === null) continue
    if (typeof value === "string") {
      const trimmed = value.trim()
      if (trimmed !== "") return trimmed
      continue
    }
    if (typeof value === "number" && Number.isInteger(value)) return String(value)
  }
  return ""
}

function normalizeAnyTxtRecord(item, fields) {
  if (item !== null && typeof item === "object" && !Array.isArray(item)) return { ...item }
  if (Array.isArray(item) && fields.length > 0) {
    const record = {}
    fields.forEach((key, index) => { record[key] = item[index] })
    return record
  }
  return { text: item }
}

function anytxtBasename(path) {
  const parts = String(path ?? "").split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ""
}

// Desktop extract_anytxt_items: picks the first array at any of the known
// result paths, optionally zips field-header rows, and normalizes each record
// to {fid, title, path, snippet}. Items with an empty path AND empty snippet
// are dropped; fid-only items become addressable via `anytxt://<fid>`.
export function extractAnytxtItems(value) {
  const paths = [
    [], ["items"], ["files"], ["results"], ["list"], ["value"], ["data"], ["output"],
    ["output", "items"], ["output", "files"], ["output", "results"], ["output", "list"],
    ["output", "value"], ["output", "data"],
    ["data", "items"], ["data", "files"], ["data", "results"], ["data", "list"],
    ["data", "value"], ["data", "output"],
    ["data", "output", "items"], ["data", "output", "files"], ["data", "output", "results"],
    ["data", "output", "list"], ["data", "output", "value"],
  ]
  const fieldPaths = [
    ["field"], ["fields"], ["output", "field"], ["output", "fields"],
    ["data", "field"], ["data", "fields"], ["data", "output", "field"], ["data", "output", "fields"],
  ]
  const result = value !== null && typeof value === "object" && value.result !== undefined ? value.result : value
  const candidates = firstAnyTxtArray(result, paths) ?? []
  const fields = firstAnyTxtFields(result, fieldPaths) ?? []
  const items = []
  for (const raw of candidates) {
    const record = normalizeAnyTxtRecord(raw, fields)
    const fid = stringField(record, ["fid", "id", "fileId", "file_id"])
    const rawPath = stringField(record, ["path", "file", "filePath", "file_path", "fullPath", "full_path", "filename", "fileName", "name"])
    const path = rawPath === "" && fid !== "" ? `anytxt://${fid}` : rawPath
    let title = stringField(record, ["title", "name", "fileName", "filename"])
    if (title === "") {
      const base = anytxtBasename(path)
      title = base !== "" ? base : "AnyTXT result"
    }
    const snippet = stringField(record, ["snippet", "fragment", "content", "contents", "text", "summary", "highlight", "hitText", "hit_text"])
    if (path === "" && snippet === "") continue
    items.push({ fid, title, path, snippet })
  }
  return items
}

// Desktop extract_anytxt_fragment_text: string -> itself; array -> join
// non-empty children with blank lines; object -> first of
// text/fragment/content/snippet/html, else recurse into
// output/result/data/fragments/items/list.
export function extractAnytxtFragmentText(value) {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value
      .map(extractAnytxtFragmentText)
      .filter((item) => item.trim() !== "")
      .join("\n\n")
  }
  if (value === null || typeof value !== "object") return ""
  for (const key of ["text", "fragment", "content", "snippet", "html"]) {
    const text = value[key]
    if (typeof text === "string") return text
  }
  for (const key of ["output", "result", "data", "fragments", "items", "list"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const text = extractAnytxtFragmentText(value[key])
      if (text.trim() !== "") return text
    }
  }
  return ""
}

// ── JSON-RPC plumbing (tools.rs get_anytxt_fragment / run_anytxt_search) ────
// `anytxtFetch` performs the POST and returns {status, text} or
// {networkError} WITHOUT formatting errors: each caller composes the exact
// desktop error strings itself.
async function anytxtFetch(endpoint, body) {
  let response
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
    })
  } catch (err) {
    return { networkError: err?.cause?.message ?? err?.message ?? String(err) }
  }
  const status = response.status
  const text = await response.text().catch(() => "")
  return { status, text }
}

function rpcResult({ networkError, status, text }, messages) {
  if (networkError !== undefined) return { error: new Error(`${messages.network}: ${networkError}`) }
  if (status < 200 || status >= 300) return { error: new Error(`${messages.http}${status}: ${trimText(text, 300)}`) }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { error: new Error(`${messages.json}${trimText(text, 300)}`) }
  }
  if (parsed && parsed.error !== undefined && parsed.error !== null) {
    return { error: new Error(`${messages.rpc}${trimText(JSON.stringify(parsed.error), 300)}`) }
  }
  return { parsed }
}

async function getAnyTxtFragment(endpoint, fid, pattern) {
  const raw = await anytxtFetch(endpoint, {
    id: 2,
    jsonrpc: "2.0",
    method: "ATRpcServer.Searcher.V1.GetFragment",
    params: { input: { fid, pattern } },
  })
  const resolved = rpcResult(raw, {
    network: "AnyTXT fragment failed",
    http: "AnyTXT fragment HTTP ",
    json: "AnyTXT fragment returned invalid JSON: ",
    rpc: "AnyTXT fragment error: ",
  })
  if (resolved.error) throw resolved.error
  return extractAnytxtFragmentText(resolved.parsed?.result ?? null)
}

// Desktop run_anytxt_search(query, config, top_k) -> Vec<AgentReference>.
// Returns the desktop reference shape ({title, path, kind:"anytxt",
// snippet?, score, knowledgeContext}); the command / agent tool adapters map
// it to their own wire shapes.
export async function runAnytxtSearch(query, config, topK) {
  const trimmedQuery = String(query ?? "").trim()
  if (trimmedQuery === "") return []
  const cfg = config ?? {}
  if (cfg.enabled === false) return []
  const rawEndpoint = String(cfg.endpoint && cfg.endpoint.trim() ? cfg.endpoint : DEFAULT_ANYTXT_ENDPOINT)
    .trim()
    .replace(/\/+$/, "")
  const endpoint = normalizeAnytxtEndpoint(rawEndpoint)
  const requested = Number.isFinite(Number(topK)) ? Math.trunc(Number(topK)) : DEFAULT_ANYTXT_LIMIT
  const clampedTopK = Math.min(100, Math.max(1, requested))
  const configLimit = Number.isFinite(Number(cfg.limit)) ? Math.trunc(Number(cfg.limit)) : DEFAULT_ANYTXT_LIMIT
  const limit = Math.min(clampedTopK, Math.min(100, Math.max(1, configLimit)))
  const pattern = trimmedQuery
  const filterDir = String(cfg.filterDir ?? "").trim()
  const filterExt = String(cfg.filterExt && cfg.filterExt.trim() ? cfg.filterExt : "*")
  const input = {
    pattern,
    filterExt,
    lastModifyBegin: 0,
    lastModifyEnd: ANYTXT_LAST_MODIFY_END,
    limit: String(limit),
    offset: 0,
    order: 0,
  }
  if (filterDir !== "") input.filterDir = filterDir
  const raw = await anytxtFetch(endpoint, {
    id: 1,
    jsonrpc: "2.0",
    method: "ATRpcServer.Searcher.V1.GetResult",
    params: { input },
  })
  const resolved = rpcResult(raw, {
    network: `AnyTXT search failed. Check that ATGUI.exe or the AnyTXT service is running at ${endpoint}`,
    http: "AnyTXT HTTP ",
    json: "AnyTXT returned invalid JSON: ",
    rpc: "AnyTXT error: ",
  })
  if (resolved.error) throw resolved.error

  const references = []
  for (const item of extractAnytxtItems(resolved.parsed).slice(0, limit)) {
    let fragment = ""
    if (item.fid.trim() !== "") {
      try {
        fragment = await getAnyTxtFragment(endpoint, item.fid, pattern)
      } catch {
        fragment = "" // desktop: fragment failure degrades to the item snippet
      }
    }
    const candidate = trimText(fragment.trim() !== "" ? fragment : item.snippet, 1200)
    const snippet = candidate.trim() !== "" ? candidate : undefined
    const reference = {
      title: item.title,
      path: fileUrlForPath(item.path),
      kind: "anytxt",
      score: null,
      knowledgeContext: null,
    }
    if (snippet !== undefined) reference.snippet = snippet
    references.push(reference)
  }
  return references
}
