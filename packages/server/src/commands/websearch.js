import { fileUrlForPath, runAnytxtSearch, DEFAULT_ANYTXT_LIMIT } from "../anytxt.js"

// Server-side web search providers — faithful Node port of the desktop's
// run_web_search + per-provider clients in src-tauri/src/agent/tools.rs
// (firecrawl / searxng / tavily / ollama / brave / bocha / serpapi) plus the
// AnyTXT JSON-RPC connector (anytxt.js = run_anytxt_search + the
// GetResult/GetFragment protocol from tools.rs). Running the HTTP calls on
// the server avoids browser CORS restrictions entirely, and because the
// server reads the SAME shared plugin-store config the desktop uses, a
// provider + key configured on the desktop works from the web client
// unchanged (and vice versa).
//
// The port mirrors the Rust contract: WebSearchConfig.resolved() (per-provider
// overrides win over the top-level fields), web_search_result_limit (1..20 for
// every provider except bocha's documented 1..50), the exact provider wire
// shapes (URLs, auth headers, JSON bodies), normalize_web_result field
// fallbacks, and the error semantics (missing-key message, HTTP-status +
// trimmed body, payload error mapping, `success:false` for Firecrawl).

const WEB_SEARCH_TIMEOUT_MS = 30_000 // Rust WEB_SEARCH_TIMEOUT_SECS = 30
const DEFAULT_FIRECRAWL_URL = "https://api.firecrawl.dev"
const DEFAULT_OLLAMA_URL = "https://ollama.com"

function hostnameLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, "") } catch { return "web" }
}

// Rust trim_text: character-count cap with a "..." suffix.
function trimText(value, maxChars) {
  const chars = [...String(value)]
  if (chars.length <= maxChars) return chars.join("")
  return chars.slice(0, maxChars).join("") + "..."
}

// Rust url_encode: percent-encode every byte outside the RFC 3986 unreserved
// set; spaces become "+" like the Rust implementation.
function urlEncode(value) {
  let out = ""
  for (const char of String(value)) {
    const code = char.codePointAt(0)
    if (
      (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A) ||
      (code >= 0x30 && code <= 0x39) || char === "-" || char === "_" ||
      char === "." || char === "~"
    ) {
      out += char
    } else if (char === " ") {
      out += "+"
    } else {
      for (const byte of Buffer.from(char, "utf8")) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
      }
    }
  }
  return out
}

function str(value) {
  return typeof value === "string" ? value : undefined
}

// WebSearchConfig::resolved() — the active provider's override (when present)
// wins over the top-level fields, provider_configs is passed through.
function resolveConfig(config) {
  const provider = String(config?.provider ?? "").trim().toLowerCase()
  const override = config?.providerConfigs?.[provider]

  const pick = (key, alias) => override?.[key] ?? config?.[alias ?? key]
  return {
    provider,
    apiKey: override?.apiKey ?? config?.apiKey ?? "",
    ollamaUrl: pick("ollamaUrl"),
    searXngUrl: pick("searXngUrl"),
    searXngCategories: pick("searXngCategories"),
    serpApiEngine: pick("serpApiEngine"),
    providerConfigs: config?.providerConfigs ?? undefined,
  }
}

// required_api_key() — reads the RESOLVED config's apiKey (override first).
function requiredApiKey(config, provider) {
  const key = String(config.apiKey ?? "").trim()
  if (!key) return { error: `${provider} web.search requires an API key in Settings.` }
  return { key }
}

function fetchWithTimeout(url, init) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS) })
}

// parse_web_json_response() — HTTP status + trimmed body, invalid JSON,
// top-level `error` string, then provider-specific payload errors.
async function parseWebJsonResponse(res, provider, parse) {
  const status = res.status
  const text = await res.text().catch((err) => {
    throw new Error(`Failed to read ${provider} response: ${err.message}`)
  })
  if (!res.ok) {
    throw new Error(`${provider} search failed (${status}): ${trimText(text, 300)}`)
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${provider} returned invalid JSON: ${trimText(text, 300)}`)
  }
  const error = str(value?.error)
  if (error !== undefined) throw new Error(`${provider} search failed: ${error}`)
  const payloadError = providerPayloadError(provider, value)
  if (payloadError) throw new Error(payloadError)
  return parse(value)
}

// provider_payload_error() — Bocha's `code` envelope and Brave's error
// `message` when the `web` section is missing.
function providerPayloadError(provider, value) {
  if (provider === "Bocha Search") {
    const code = typeof value?.code === "number" ? value.code : 0
    if (code !== 200) {
      const message = str(value?.msg)?.trim() || "unknown API error"
      return `${provider} failed (code ${code}): ${message}`
    }
  }
  if (provider === "Brave Search" && value?.web === undefined) {
    const message = str(value?.message)
    if (message !== undefined) return `${provider} search failed: ${message}`
  }
  return null
}

// normalize_web_result() — field fallbacks for every supported provider.
function normalizeWebResult(value) {
  const item = value && typeof value === "object" ? value : {}
  const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {}
  const title = str(item.title) ?? str(metadata.title) ?? "Untitled"
  const url = str(item.url) ?? str(item.link) ?? str(metadata.sourceURL) ??
    str(metadata.url) ?? str(item.original) ?? str(item.thumbnail) ?? ""
  const snippet = str(item.snippet) ?? str(item.content) ?? str(item.description) ??
    str(metadata.description) ?? str(item.summary) ?? str(item.markdown) ?? ""
  return { title, url, snippet }
}

// extract_web_items() + extract_nested_web_items() (Firecrawl).
function extractWebItems(value, keys) {
  for (const key of keys) {
    const candidate = value?.[key]
    if (candidate === undefined || candidate === null) continue
    if (Array.isArray(candidate)) return candidate
    const nested = extractNestedWebItems(candidate)
    if (nested) return nested
  }
  return []
}

function extractNestedWebItems(value) {
  if (!value || typeof value !== "object") return undefined
  for (const key of ["web", "results", "items"]) {
    if (Array.isArray(value[key])) return value[key]
  }
  return undefined
}

// friendly_firecrawl_error() — the web client localizes the blocked-IP case
// (`settings.sections.webSearch.firecrawlIpBlocked`), so keep that phrasing.
function friendlyFirecrawlError(error) {
  if (String(error).toLowerCase().includes("ip address looks suspicious")) {
    return "Firecrawl anonymous search is blocked for this IP. Add a Firecrawl API key in Settings or choose another Web Search provider."
  }
  return `Firecrawl search failed: ${error}`
}

async function firecrawlSearch(query, config, maxResults) {
  const override = config.providerConfigs?.firecrawl
  const baseURL = (str(override?.baseUrl)?.trim() || DEFAULT_FIRECRAWL_URL).replace(/\/+$/, "")
  const headers = { Accept: "application/json" }
  const key = str(override?.apiKey)?.trim() ?? ""
  if (key) headers.Authorization = `Bearer ${key}`
  let res
  try {
    res = await fetchWithTimeout(`${baseURL}/v2/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, limit: maxResults }),
    })
  } catch (err) {
    throw new Error(`Network error reaching Firecrawl Search: ${err.message}`)
  }
  const status = res.status
  const text = await res.text().catch((err) => {
    throw new Error(`Failed to read Firecrawl response: ${err.message}`)
  })
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`Firecrawl search returned an invalid JSON response: ${trimText(text, 300)}`)
  }
  if (!res.ok || parsed?.success === false) {
    const message = str(parsed?.error)
      ? friendlyFirecrawlError(parsed.error)
      : `Firecrawl search failed (${status})`
    throw new Error(message)
  }
  return extractWebItems(parsed, ["data", "results"]).map(normalizeWebResult)
}

// normalize_searxng_url() — default scheme + /search suffix.
function normalizeSearxngUrl(value) {
  const trimmed = String(value).trim().replace(/\/+$/, "")
  if (!trimmed) return ""
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  return url.endsWith("/search") ? url : `${url}/search`
}

async function searxngSearch(query, config, maxResults) {
  const base = str(config.searXngUrl)?.trim()
  if (!base) throw new Error("SearXNG URL is required for web.search")
  const url = normalizeSearxngUrl(base) +
    `?q=${urlEncode(query)}&format=json&categories=${urlEncode((config.searXngCategories ?? ["general"]).join(","))}`
  let res
  try {
    res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } })
  } catch (err) {
    throw new Error(`Network error reaching SearXNG: ${err.message}`)
  }
  const status = res.status
  const text = await res.text().catch((err) => {
    throw new Error(`Failed to read SearXNG response: ${err.message}`)
  })
  if (!res.ok) throw new Error(`SearXNG search failed (${status}): ${trimText(text, 300)}`)
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`SearXNG returned invalid JSON: ${trimText(text, 300)}`)
  }
  return (Array.isArray(parsed?.results) ? parsed.results : []).slice(0, maxResults).map(normalizeWebResult)
}

async function tavilySearch(query, config, maxResults) {
  const { key, error } = requiredApiKey(config, "Tavily")
  if (error) throw new Error(error)
  let res
  try {
    res = await fetchWithTimeout("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: maxResults,
        search_depth: "advanced",
        include_answer: false,
      }),
    })
  } catch (err) {
    throw new Error(`Network error reaching Tavily: ${err.message}`)
  }
  return parseWebJsonResponse(res, "Tavily", (value) =>
    (Array.isArray(value?.results) ? value.results : []).map(normalizeWebResult))
}

async function ollamaSearch(query, config, maxResults) {
  const { key, error } = requiredApiKey(config, "Ollama")
  if (error) throw new Error(error)
  const base = (str(config.ollamaUrl)?.trim() || DEFAULT_OLLAMA_URL).replace(/\/+$/, "")
  let res
  try {
    res = await fetchWithTimeout(`${base}/api/web_search`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ query, max_results: maxResults }),
    })
  } catch (err) {
    throw new Error(`Network error reaching Ollama Web Search: ${err.message}`)
  }
  return parseWebJsonResponse(res, "Ollama Web Search", (value) =>
    (Array.isArray(value?.results) ? value.results : []).map(normalizeWebResult))
}

async function braveSearch(query, config, maxResults) {
  const { key, error } = requiredApiKey(config, "Brave")
  if (error) throw new Error(error)
  const url = `https://api.search.brave.com/res/v1/web/search?q=${urlEncode(query)}&count=${Math.min(maxResults, 20)}`
  let res
  try {
    res = await fetchWithTimeout(url, {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
    })
  } catch (err) {
    throw new Error(`Network error reaching Brave Search: ${err.message}`)
  }
  return parseWebJsonResponse(res, "Brave Search", (value) =>
    (Array.isArray(value?.web?.results) ? value.web.results : []).map(normalizeWebResult))
}

async function bochaSearch(query, config, maxResults) {
  const { key, error } = requiredApiKey(config, "Bocha")
  if (error) throw new Error(error)
  let res
  try {
    res = await fetchWithTimeout("https://api.bocha.cn/v1/web-search", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query,
        freshness: "noLimit",
        summary: true,
        count: Math.min(Math.max(1, maxResults), 50),
      }),
    })
  } catch (err) {
    throw new Error(`Network error reaching Bocha Search: ${err.message}`)
  }
  return parseWebJsonResponse(res, "Bocha Search", parseBochaResults)
}

// parse_bocha_results() — data.webPages.value with name / url / summary, and
// snippet as the fallback for summary.
function parseBochaResults(value) {
  const pages = value?.data?.webPages?.value
  if (!Array.isArray(pages)) return []
  return pages.map((item) => ({
    title: str(item?.name) ?? "Untitled",
    url: str(item?.url) ?? "",
    snippet: str(item?.summary) ?? str(item?.snippet) ?? "",
  }))
}

async function serpApiSearch(query, config, maxResults) {
  const { key, error } = requiredApiKey(config, "SerpApi")
  if (error) throw new Error(error)
  const engine = str(config.serpApiEngine) ?? "google"
  const url = `https://serpapi.com/search?engine=${urlEncode(engine)}&q=${urlEncode(query)}&api_key=${urlEncode(key)}&num=${maxResults}`
  let res
  try {
    res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } })
  } catch (err) {
    throw new Error(`Network error reaching SerpApi: ${err.message}`)
  }
  return parseWebJsonResponse(res, "SerpApi", (value) => {
    for (const keyName of [
      "organic_results", "news_results", "images_results",
      "video_results", "videos_results", "shopping_results",
    ]) {
      if (Array.isArray(value?.[keyName])) return value[keyName].map(normalizeWebResult)
    }
    return []
  })
}

// run_web_search() — the desktop's entry point: empty query → Ok([]), config /
// provider validation, web_search_result_limit (bocha 1..50, everyone else
// 1..20), the provider switch, and the empty-url + max_results filtering from
// web_items_to_references. Returns the ExternalSearchResult wire shape the
// frontend consumes ({title,url,snippet,source}).
async function webSearch({ query, config, maxResults }) {
  const trimmedQuery = String(query ?? "").trim()
  if (!trimmedQuery) return []
  const resolved = resolveConfig(config)
  const provider = resolved.provider
  if (!provider || provider === "none") {
    throw new Error("Web search provider is not configured.")
  }
  const requested = Math.max(1, maxResults ?? 10)
  const limit = Math.min(requested, provider === "bocha" ? 50 : 20)
  let raw
  switch (provider) {
    case "firecrawl": raw = await firecrawlSearch(trimmedQuery, resolved, limit); break
    case "searxng": raw = await searxngSearch(trimmedQuery, resolved, limit); break
    case "tavily": raw = await tavilySearch(trimmedQuery, resolved, limit); break
    case "ollama": raw = await ollamaSearch(trimmedQuery, resolved, limit); break
    case "brave": raw = await braveSearch(trimmedQuery, resolved, limit); break
    case "bocha": raw = await bochaSearch(trimmedQuery, resolved, limit); break
    case "serpapi": raw = await serpApiSearch(trimmedQuery, resolved, limit); break
    default:
      throw new Error(`Web search provider '${provider}' is not supported yet.`)
  }
  return raw
    .slice(0, limit)
    .filter((item) => String(item.url ?? "").trim() !== "")
    .map((item) => ({
      title: item.title ?? "",
      url: item.url ?? "",
      snippet: item.snippet ?? "",
      source: hostnameLabel(item.url ?? ""),
    }))
}

// Desktop anytxt_search command (src-tauri/src/commands/external_search.rs):
// run_anytxt_search(query, config, max_results.unwrap_or(20)) then map each
// AgentReference to the ExternalSearchResult wire shape {title, url, snippet,
// source: "AnyTXT"} (url = file_url_for_path — idempotent here because the
// reference path is already a file:// URL).
async function anytxtSearch({ query, config, maxResults, max_results }) {
  const refs = await runAnytxtSearch(query, config ?? {}, maxResults ?? max_results ?? DEFAULT_ANYTXT_LIMIT)
  return refs.map((r) => ({
    title: r.title,
    url: fileUrlForPath(r.path),
    snippet: r.snippet ?? "",
    source: "AnyTXT",
  }))
}

export const webSearchCommands = {
  web_search: webSearch,
  anytxt_search: anytxtSearch,
}
