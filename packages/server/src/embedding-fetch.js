// Faithful Node port of the embedding layer of src-tauri/src/commands/search.rs:
// fetch_embedding_once / fetch_embedding_with_retry / fetch_embedding_batch,
// the provider special cases (Google Gemini, Doubao multimodal, Volcengine
// endpoint rewriting), the local/private Origin header, the reserved-header
// rules, the oversize auto-halving retry, and every error string. Error
// messages are byte-identical to the desktop so the frontend's
// `lastEmbeddingError` surfaces the same text on both backends.

// The current server routes every outbound fetch through the global undici
// dispatcher installed by proxy-env.js (setGlobalDispatcher), so plain
// `fetch` already honors the configured forward proxy — no dedicated client.
// Read globalThis.fetch AT CALL TIME so tests (embed.test.js) can swap it.
function outboundFetch(...args) {
  return globalThis.fetch(...args)
}

const SEARCH_EMBEDDING_TIMEOUT_SECS = 8

// ── oversize detection (desktop's looks_like_oversize_error) ──────────────
export function looksLikeOversizeError(status, body) {
  if (status === 413) return true
  const lower = String(body).toLowerCase()
  return (
    lower.includes("too long") ||
    lower.includes("maximum context") ||
    lower.includes("max_tokens") ||
    lower.includes("max tokens") ||
    lower.includes("context length") ||
    lower.includes("token limit") ||
    lower.includes("exceeds") ||
    lower.includes("input length")
  )
}

// Halve by Unicode code points, keeping at least one char. Returns the new
// text, or null when nothing can be removed (Rust: bool out-param).
export function halveTextOnCharBoundary(text) {
  const chars = [...text]
  if (chars.length <= 1) return null
  const keep = Math.max(1, Math.floor(chars.length / 2))
  return chars.slice(0, keep).join("")
}

// ── header policy (is_safe_extra_header_name / is_reserved_extra_header_name) ─
const SAFE_HEADER_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
export function isSafeExtraHeaderName(name) {
  return name.length > 0 && SAFE_HEADER_RE.test(name)
}
const RESERVED_HEADERS = new Set([
  "authorization", "content-type", "host", "content-length", "origin", "x-goog-api-key",
])
export function isReservedExtraHeaderName(name) {
  return RESERVED_HEADERS.has(name.trim().toLowerCase())
}

// ── provider detection ────────────────────────────────────────────────────
export function isGoogleEmbeddingConfig(cfg) {
  const endpoint = String(cfg.endpoint || "").toLowerCase()
  return endpoint.includes("generativelanguage.googleapis.com") || endpoint.includes(":embedcontent")
}
export function isDoubaoMultimodalEmbeddingConfig(cfg) {
  return String(cfg.model || "").trim().toLowerCase().includes("doubao-embedding-vision")
}

export function isLocalOrPrivateHttpEndpoint(endpoint) {
  let url
  try { url = new URL(endpoint) } catch { return false }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  let host = url.hostname
  if (!host) return false
  host = host.replace(/^\[+|\]+$/g, "").toLowerCase()
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true
  const parts = host.split(".")
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return false
  const o = parts.map((p) => Number(p))
  if (o.some((v) => v > 255)) return false
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || o[0] === 127
}

export function isVolcengineEmbeddingEndpoint(endpoint) {
  let host = null
  try { host = new URL(endpoint).hostname?.toLowerCase() ?? null } catch { host = null }
  if (host == null) {
    const trimmed = String(endpoint).trim()
    const rest = trimmed.includes("://") ? trimmed.split("://").slice(1).join("://") : trimmed
    host = (rest.split(/[/?#]/)[0] ?? "").toLowerCase()
  }
  host = host.toLowerCase()
  return host === "volces.com" || host.endsWith(".volces.com") || host.includes("volcengine")
}

// ── endpoint shaping (append_endpoint_path + friends) ─────────────────────
export function appendEndpointPath(endpoint, targetSuffix) {
  const suffix = targetSuffix.replace(/^\/+/, "")
  let url = null
  try { url = new URL(endpoint) } catch { url = null }
  if (url) {
    const path = url.pathname.replace(/\/+$/, "")
    const lowerPath = path.toLowerCase()
    const lowerSuffix = `/${suffix.toLowerCase()}`
    if (lowerPath.endsWith(lowerSuffix)) {
      url.pathname = path === "" ? "/" : path
      return url.toString()
    }
    if (lowerPath.endsWith("/embeddings/multimodal") && lowerSuffix === "/embeddings") {
      const base = path.replace(/\/multimodal+$/, "")
      url.pathname = base === "" ? "/" : base
      return url.toString()
    }
    if (lowerPath.endsWith("/embeddings") && lowerSuffix === "/embeddings/multimodal") {
      url.pathname = `${path}/multimodal`
      return url.toString()
    }
    url.pathname = `${path}/${suffix}`.split("//").join("/")
    return url.toString()
  }
  const qIdx = endpoint.indexOf("?")
  const base = qIdx >= 0 ? endpoint.slice(0, qIdx) : endpoint
  const query = qIdx >= 0 ? endpoint.slice(qIdx + 1) : ""
  const trimmed = base.replace(/\/+$/, "")
  const lower = trimmed.toLowerCase()
  const lowerSuffix = `/${suffix.toLowerCase()}`
  let next
  if (lower.endsWith(lowerSuffix)) next = trimmed
  else if (lower.endsWith("/embeddings/multimodal") && lowerSuffix === "/embeddings") next = trimmed.replace(/\/multimodal+$/, "")
  else if (lower.endsWith("/embeddings") && lowerSuffix === "/embeddings/multimodal") next = `${trimmed}/multimodal`
  else next = `${trimmed}/${suffix}`
  return query === "" ? next : `${next}?${query}`
}

export function volcengineEmbeddingEndpoint(cfg) {
  const raw = String(cfg.endpoint || "").trim()
  if (!isVolcengineEmbeddingEndpoint(raw)) return raw
  const suffix = isDoubaoMultimodalEmbeddingConfig(cfg) ? "/embeddings/multimodal" : "/embeddings"
  return appendEndpointPath(raw, suffix)
}

export function stripGoogleApiKeyQuery(endpoint) {
  if (!endpoint.includes("?")) return endpoint
  try {
    const url = new URL(endpoint)
    const kept = []
    for (const [k, v] of url.searchParams.entries()) {
      if (k.toLowerCase() !== "key") kept.push([k, v])
    }
    url.search = ""
    for (const [k, v] of kept) url.searchParams.append(k, v)
    return url.toString().replace(/\?$/, "")
  } catch {
    const [base, query] = endpoint.split("?")
    const kept = (query || "").split("&").filter((pair) => {
      const k = pair.includes("=") ? pair.slice(0, pair.indexOf("=")) : pair
      return k.toLowerCase() !== "key"
    })
    return kept.length === 0 ? base : `${base}?${kept.join("&")}`
  }
}

export function googleEmbeddingEndpoint(cfg) {
  let raw = stripGoogleApiKeyQuery(String(cfg.endpoint || "").trim()).replace(/\/+$/, "")
  if (raw.toLowerCase().includes(":batchembedcontents")) {
    return raw.replace(/:batchEmbedContents/g, ":embedContent").replace(/:batchembedcontents/g, ":embedContent")
  }
  if (raw.toLowerCase().includes(":embedcontent")) return raw
  const model = String(cfg.model || "").trim().replace(/^models\//, "")
  if (raw.toLowerCase().includes("/models/")) return `${raw}:embedContent`
  return `${raw}/models/${model}:embedContent`
}

export function googleEmbeddingBody(model, text, outputDimensionality) {
  const trimmed = String(model || "").trim()
  const modelPath = trimmed.startsWith("models/") ? trimmed : `models/${trimmed}`
  const body = { model: modelPath, content: { parts: [{ text }] } }
  const dim = Number(outputDimensionality)
  if (outputDimensionality != null && Number.isFinite(dim) && dim >= 1) {
    body.output_dimensionality = Math.floor(dim)
  }
  return body
}

export function doubaoMultimodalEmbeddingBody(model, text) {
  return { model, encoding_format: "float", input: [{ type: "text", text }] }
}

// ── response parsing (parse_embedding_values / parse_embedding_batch_values) ─
function parseEmbeddingValues(data, isGoogle, isDoubaoMultimodal) {
  let values
  if (isGoogle) values = data?.embedding?.values
  else if (isDoubaoMultimodal) values = data?.data?.embedding
  else values = data?.data?.[0]?.embedding
  if (!Array.isArray(values)) throw new Error("Embedding response missing vector")
  const out = []
  for (const value of values) {
    const n = typeof value === "number" ? value : NaN
    if (typeof value !== "number") throw new Error("Embedding response contains non-number values")
    if (!Number.isFinite(n)) throw new Error("Embedding response contains non-finite values")
    out.push(n)
  }
  if (out.length === 0) throw new Error("Embedding response vector is empty")
  return out
}

function parseEmbeddingBatchValues(data, expected) {
  const entries = data?.data
  if (!Array.isArray(entries)) throw new Error("Embedding batch response missing data array")
  if (entries.length !== expected) throw new Error(`Embedding batch returned ${entries.length} vectors for ${expected} inputs`)
  const indexed = []
  entries.forEach((entry, position) => {
    const rawIndex = entry?.index
    const index = Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : position
    if (index >= expected) throw new Error("Embedding batch response contains an out-of-range index")
    const values = entry?.embedding
    if (!Array.isArray(values)) throw new Error("Embedding batch response missing vector")
    const vector = []
    for (const value of values) {
      if (typeof value !== "number") throw new Error("Embedding batch response contains non-number values")
      if (!Number.isFinite(value)) throw new Error("Embedding batch response contains non-finite values")
      vector.push(value)
    }
    if (vector.length === 0) throw new Error("Embedding batch response vector is empty")
    indexed.push([index, vector])
  })
  indexed.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < indexed.length; i++) {
    if (indexed[i - 1][0] === indexed[i][0]) throw new Error("Embedding batch response contains duplicate indexes")
  }
  const dimension = indexed.length ? indexed[0][1].length : 0
  if (indexed.some(([, v]) => v.length !== dimension)) throw new Error("Embedding batch response contains inconsistent vector dimensions")
  return indexed.map(([, v]) => v)
}

// ── request assembly ──────────────────────────────────────────────────────
function embeddingHeaders(cfg, isGoogle, endpoint) {
  const headers = { "Content-Type": "application/json" }
  // Browser-based local model servers often require a browser-like Origin.
  // Reserved, so user-supplied extra headers cannot override it.
  if (isLocalOrPrivateHttpEndpoint(endpoint)) headers["Origin"] = "http://localhost"
  const key = String(cfg.apiKey || "").trim()
  if (key) {
    if (isGoogle) headers["x-goog-api-key"] = key
    else headers["Authorization"] = `Bearer ${key}`
  }
  for (const [rawName, rawValue] of Object.entries(cfg.extraHeaders || {})) {
    const name = String(rawName).trim()
    const value = String(rawValue).trim()
    if (!name || !value) continue
    if (!isSafeExtraHeaderName(name)) continue
    if (isReservedExtraHeaderName(name)) continue
    headers[name] = value
  }
  return headers
}

const preview200 = (text) => [...String(text)].slice(0, 200).join("")

async function postEmbedding(endpoint, headers, body) {
  let res
  try {
    res = await outboundFetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEARCH_EMBEDDING_TIMEOUT_SECS * 1000),
    })
  } catch (e) {
    throw new EmbeddingError("other", `Embedding request failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  let text
  try { text = await res.text() } catch (e) {
    throw new EmbeddingError("other", `Embedding response read failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  return { status: res.status, text }
}

class EmbeddingError extends Error {
  constructor(kind, message) { super(message); this.kind = kind }
}

// fetch_embedding_once — returns a vector or throws EmbeddingError(kind).
async function fetchEmbeddingOnce(text, cfg) {
  const isGoogle = isGoogleEmbeddingConfig(cfg)
  const isDoubaoMultimodal = isDoubaoMultimodalEmbeddingConfig(cfg)
  const endpoint = isGoogle ? googleEmbeddingEndpoint(cfg) : volcengineEmbeddingEndpoint(cfg)
  const headers = embeddingHeaders(cfg, isGoogle, endpoint)
  let body
  if (isGoogle) body = googleEmbeddingBody(cfg.model, text, cfg.outputDimensionality)
  else if (isDoubaoMultimodal) body = doubaoMultimodalEmbeddingBody(cfg.model, text)
  else body = { model: cfg.model, input: text }

  const { status, text: respText } = await postEmbedding(endpoint, headers, body)
  if (status < 200 || status >= 300) {
    const preview = preview200(respText)
    const message = `Embedding API HTTP ${status}: ${preview}`
    throw new EmbeddingError(looksLikeOversizeError(status, respText) ? "oversize" : "other", message)
  }
  let data
  try { data = JSON.parse(respText) } catch (e) {
    throw new EmbeddingError("other", `Embedding response parse failed: ${e instanceof Error ? e.message : String(e)}: ${preview200(respText)}`)
  }
  try {
    return parseEmbeddingValues(data, isGoogle, isDoubaoMultimodal)
  } catch (e) {
    throw new EmbeddingError("other", e.message)
  }
}

// fetch_embedding_with_retry — ONLY oversize rejections are retried, by
// halving the text on a char boundary; every other error is definitive.
export async function fetchEmbeddingWithRetry(text, cfg, maxRetries) {
  let current = String(text)
  let attempts = 0
  for (;;) {
    attempts += 1
    try {
      return await fetchEmbeddingOnce(current, cfg)
    } catch (e) {
      if (e instanceof EmbeddingError && e.kind === "oversize") {
        const halved = Buffer.byteLength(current, "utf8") > 64 ? halveTextOnCharBoundary(current) : null
        if (attempts <= maxRetries && halved != null) {
          current = halved
          continue
        }
        throw new Error(
          `Endpoint rejected input even at ${Buffer.byteLength(current, "utf8")} chars. Lower Settings -> Embedding -> Max Chunk Chars. ${e.message}`,
        )
      }
      throw new Error(e.message)
    }
  }
}

// fetch_embedding_batch — OpenAI-compatible batch format only.
export async function fetchEmbeddingBatch(texts, cfg) {
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > 64) {
    throw new Error("Embedding batch must contain between 1 and 64 inputs")
  }
  if (isGoogleEmbeddingConfig(cfg) || isDoubaoMultimodalEmbeddingConfig(cfg)) {
    throw new Error("This embedding provider does not use the OpenAI-compatible batch format")
  }
  const endpoint = volcengineEmbeddingEndpoint(cfg)
  const headers = embeddingHeaders(cfg, false, endpoint)
  let res
  try {
    res = await outboundFetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model, input: texts }),
      signal: AbortSignal.timeout(SEARCH_EMBEDDING_TIMEOUT_SECS * 1000),
    })
  } catch (e) {
    throw new Error(`Embedding batch request failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  let respText
  try { respText = await res.text() } catch (e) {
    throw new Error(`Embedding batch response read failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Embedding batch API HTTP ${res.status}: ${preview200(respText)}`)
  }
  let data
  try { data = JSON.parse(respText) } catch (e) {
    throw new Error(`Embedding batch response parse failed: ${e instanceof Error ? e.message : String(e)}: ${preview200(respText)}`)
  }
  return parseEmbeddingBatchValues(data, texts.length)
}
