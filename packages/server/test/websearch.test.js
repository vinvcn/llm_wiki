// Web-search provider parity — faithful Node port of run_web_search + the
// per-provider clients in src-tauri/src/agent/tools.rs. The desktop supports
// firecrawl / searxng / tavily / ollama / brave / bocha / serpapi; the server
// must accept the SAME shared settings config so a provider + key configured
// on the desktop (or the web) works from either client.
//
// Brave / Bocha / Tavily / SerpApi talk to hardcoded public endpoints, so
// those tests stub global fetch and assert the exact request shape
// (URL / headers / body) + response parsing + error semantics. Firecrawl /
// Ollama / SearXNG take a configurable base URL, so those tests run against a
// real local HTTP server end-to-end.

import { describe, it, expect, afterEach, vi } from "vitest"
import http from "node:http"
import { webSearchCommands } from "../src/commands/websearch.js"

const { web_search } = webSearchCommands

let requests = []

function stubFetch(responder) {
  vi.stubGlobal("fetch", async (url, init = {}) => {
    const req = { url: String(url), init }
    requests.push(req)
    return responder ? responder(req) : new Response("{}", { status: 200 })
  })
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = ""
      req.on("data", (d) => { raw += d })
      req.on("end", async () => {
        const payload = { method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : undefined }
        try {
          const out = await handler(payload)
          res.writeHead(out.status ?? 200, { "Content-Type": "application/json" })
          res.end(JSON.stringify(out.body ?? {}))
        } catch {
          res.writeHead(500, { "Content-Type": "application/json" })
          res.end("{}")
        }
      })
    })
    srv.listen(0, "127.0.0.1", () => resolve(srv))
  })
}

const stopServer = (srv) => new Promise((r) => srv.close(r))

afterEach(() => {
  vi.unstubAllGlobals()
  requests = []
})

describe("web_search command (run_web_search port)", () => {
  it("returns [] for a blank query before any config check", async () => {
    expect(await web_search({ query: "   ", config: {} })).toEqual([])
  })

  it("throws when the provider is none / empty", async () => {
    await expect(web_search({ query: "x", config: { provider: "none" } }))
      .rejects.toThrow("Web search provider is not configured.")
    await expect(web_search({ query: "x", config: { provider: "" } }))
      .rejects.toThrow("Web search provider is not configured.")
  })

  it("rejects unknown providers with a clear error", async () => {
    await expect(web_search({ query: "x", config: { provider: "magic" } }))
      .rejects.toThrow("Web search provider 'magic' is not supported yet.")
  })

  it("lowercases and trims the provider name", async () => {
    stubFetch(() => jsonResponse({ data: [] }))
    await web_search({ query: "x", config: { provider: "  Firecrawl " } })
    expect(requests.length).toBe(1)
    expect(requests[0].url).toBe("https://api.firecrawl.dev/v2/search")
  })

  it("defaults maxResults to 10 and clamps to the provider ceiling (20)", async () => {
    stubFetch(() => jsonResponse({ data: [] }))
    await web_search({ query: "x", config: { provider: "tavily", apiKey: "k" }, maxResults: 999 })
    expect(JSON.parse(requests[0].init.body).max_results).toBe(20)
    await web_search({ query: "x", config: { provider: "tavily", apiKey: "k" } })
    expect(JSON.parse(requests[1].init.body).max_results).toBe(10)
  })

  it("lets bocha use its documented 1-50 range", async () => {
    stubFetch(() => jsonResponse({ code: 200, data: { webPages: { value: [] } } }))
    await web_search({ query: "x", config: { provider: "bocha", apiKey: "k" }, maxResults: 999 })
    expect(JSON.parse(requests[0].init.body).count).toBe(50)
  })

  it("filters out empty URLs (web_items_to_references) and reports hostname sources", async () => {
    stubFetch(() => jsonResponse({
      data: [
        { title: "a", url: "https://www.example.com/a", snippet: "s" },
        { title: "b", url: "", snippet: "s" },
      ],
    }))
    const out = await web_search({ query: "x", config: { provider: "firecrawl" } })
    expect(out).toEqual([{ title: "a", url: "https://www.example.com/a", snippet: "s", source: "example.com" }])
  })
})

describe("firecrawl (firecrawl_search port)", () => {
  it("posts to {baseUrl}/v2/search with a query + limit and no auth when key-free", async () => {
    const srv = await startServer((req) => {
      expect(req.method).toBe("POST")
      expect(req.url).toBe("/v2/search")
      expect(req.headers.accept).toBe("application/json")
      expect(req.headers.authorization).toBeUndefined()
      expect(req.body).toEqual({ query: "hello world", limit: 20 })
      return { body: { data: [] } }
    })
    try {
      const out = await web_search({
        query: "hello world",
        config: {
          provider: "firecrawl",
          providerConfigs: { firecrawl: { baseUrl: `http://127.0.0.1:${srv.address().port}` } },
        },
        maxResults: 20,
      })
      expect(out).toEqual([])
    } finally { await stopServer(srv) }
  })

  it("sends Bearer auth when a per-provider key is configured", async () => {
    const srv = await startServer((req) => {
      expect(req.headers.authorization).toBe("Bearer sk-123")
      return { body: { data: [] } }
    })
    try {
      await web_search({
        query: "x",
        config: {
          provider: "firecrawl",
          providerConfigs: { firecrawl: { baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: "sk-123" } },
        },
      })
    } finally { await stopServer(srv) }
  })

  it("defaults to the public endpoint when no baseUrl is configured", async () => {
    stubFetch(() => jsonResponse({ data: [] }))
    await web_search({ query: "x", config: { provider: "firecrawl" } })
    expect(requests[0].url).toBe("https://api.firecrawl.dev/v2/search")
  })

  it("normalizes flat and nested item containers (data / results / web)", async () => {
    stubFetch(() => jsonResponse({
      data: { web: [
        { title: "nested", url: "https://a.dev", description: "d" },
      ] },
    }))
    const out = await web_search({ query: "x", config: { provider: "firecrawl" } })
    expect(out[0].title).toBe("nested")
    expect(out[0].url).toBe("https://a.dev")
    expect(out[0].snippet).toBe("d")

    stubFetch(() => jsonResponse({ results: [{ title: "flat", url: "https://b.dev", snippet: "s" }] }))
    const flat = await web_search({ query: "x", config: { provider: "firecrawl" } })
    expect(flat[0].title).toBe("flat")
  })

  it("maps success:false with the blocked-IP wording the web client localizes", async () => {
    stubFetch(() => jsonResponse({ success: false, error: "IP address looks suspicious" }))
    await expect(web_search({ query: "x", config: { provider: "firecrawl" } }))
      .rejects.toThrow("Firecrawl anonymous search is blocked for this IP. Add a Firecrawl API key in Settings or choose another Web Search provider.")
  })

  it("reports other provider errors and HTTP failures", async () => {
    stubFetch(() => jsonResponse({ success: false, error: "boom" }))
    await expect(web_search({ query: "x", config: { provider: "firecrawl" } }))
      .rejects.toThrow("Firecrawl search failed: boom")

    stubFetch(() => jsonResponse({}, 500))
    await expect(web_search({ query: "x", config: { provider: "firecrawl" } }))
      .rejects.toThrow("Firecrawl search failed (500)")
  })

  it("reports invalid JSON with the wording the web client localizes", async () => {
    stubFetch(() => new Response("not json", { status: 200 }))
    await expect(web_search({ query: "x", config: { provider: "firecrawl" } }))
      .rejects.toThrow("Firecrawl search returned an invalid JSON response")
  })

  it("surfaces network errors", async () => {
    stubFetch(() => { throw new TypeError("fetch failed") })
    await expect(web_search({ query: "x", config: { provider: "firecrawl" } }))
      .rejects.toThrow("Network error reaching Firecrawl Search")
  })
})

describe("brave (brave_search port)", () => {
  it("GETs the exact endpoint with the subscription-token header", async () => {
    stubFetch(() => jsonResponse({ web: { results: [] } }))
    await web_search({ query: "rust lang", config: { provider: "brave", apiKey: "tok" }, maxResults: 7 })
    expect(requests[0].url).toBe("https://api.search.brave.com/res/v1/web/search?q=rust+lang&count=7")
    expect(requests[0].init.headers["X-Subscription-Token"]).toBe("tok")
    expect(requests[0].init.headers.Accept).toBe("application/json")
  })

  it("caps count at 20 even for a huge requested max", async () => {
    stubFetch(() => jsonResponse({ web: { results: [] } }))
    await web_search({ query: "x", config: { provider: "brave", apiKey: "tok" }, maxResults: 999 })
    expect(requests[0].url).toContain("count=20")
  })

  it("requires a key", async () => {
    await expect(web_search({ query: "x", config: { provider: "brave" } }))
      .rejects.toThrow("Brave web.search requires an API key in Settings.")
  })

  it("parses web.results through normalize_web_result", async () => {
    stubFetch(() => jsonResponse({ web: { results: [
      { title: "t", url: "https://x.dev", description: "d" },
    ] } }))
    const out = await web_search({ query: "x", config: { provider: "brave", apiKey: "tok" } })
    expect(out[0]).toEqual({ title: "t", url: "https://x.dev", snippet: "d", source: "x.dev" })
  })

  it("maps non-2xx and payload errors", async () => {
    stubFetch(() => jsonResponse({ message: "Unauthorized" }, 401))
    await expect(web_search({ query: "x", config: { provider: "brave", apiKey: "bad" } }))
      .rejects.toThrow(/Brave Search search failed \(401\)/)

    stubFetch(() => jsonResponse({ message: "rate limited" }, 200))
    await expect(web_search({ query: "x", config: { provider: "brave", apiKey: "bad" } }))
      .rejects.toThrow("Brave Search search failed: rate limited")
  })
})

describe("bocha (bocha_search port)", () => {
  it("POSTs the exact envelope with Bearer auth and noLimit freshness", async () => {
    stubFetch(() => jsonResponse({ code: 200, data: { webPages: { value: [] } } }))
    await web_search({ query: "中国新闻", config: { provider: "bocha", apiKey: "bk" }, maxResults: 3 })
    expect(requests[0].url).toBe("https://api.bocha.cn/v1/web-search")
    expect(requests[0].init.headers.Authorization).toBe("Bearer bk")
    const body = JSON.parse(requests[0].init.body)
    expect(body).toEqual({ query: "中国新闻", freshness: "noLimit", summary: true, count: 3 })
  })

  it("parses data.webPages.value with summary and snippet fallback", async () => {
    stubFetch(() => jsonResponse({ code: 200, data: { webPages: { value: [
      { name: "n", url: "https://c.cn", summary: "sum" },
      { name: "m", url: "https://d.cn", snippet: "snip" },
    ] } } }))
    const out = await web_search({ query: "x", config: { provider: "bocha", apiKey: "bk" } })
    expect(out[0].snippet).toBe("sum")
    expect(out[1].snippet).toBe("snip")
  })

  it("reports the Bocha code envelope when code != 200", async () => {
    stubFetch(() => jsonResponse({ code: 429, msg: "too many requests" }, 200))
    await expect(web_search({ query: "x", config: { provider: "bocha", apiKey: "bk" } }))
      .rejects.toThrow("Bocha Search failed (code 429): too many requests")
  })

  it("reports a top-level error string and non-2xx responses", async () => {
    stubFetch(() => jsonResponse({ error: "bad key" }, 200))
    await expect(web_search({ query: "x", config: { provider: "bocha", apiKey: "bk" } }))
      .rejects.toThrow("Bocha Search search failed: bad key")
    stubFetch(() => new Response("nope", { status: 502 }))
    await expect(web_search({ query: "x", config: { provider: "bocha", apiKey: "bk" } }))
      .rejects.toThrow(/Bocha Search search failed \(502\): nope/)
  })
})

describe("tavily (tavily_search port)", () => {
  it("POSTs api_key/query/max_results/search_depth/include_answer", async () => {
    stubFetch(() => jsonResponse({ results: [] }))
    await web_search({ query: "q", config: { provider: "tavily", apiKey: "tv" }, maxResults: 4 })
    expect(requests[0].url).toBe("https://api.tavily.com/search")
    expect(JSON.parse(requests[0].init.body)).toEqual({
      api_key: "tv", query: "q", max_results: 4, search_depth: "advanced", include_answer: false,
    })
  })

  it("requires a key", async () => {
    await expect(web_search({ query: "x", config: { provider: "tavily" } }))
      .rejects.toThrow("Tavily web.search requires an API key in Settings.")
  })

  it("parses results and keeps only non-empty URLs", async () => {
    stubFetch(() => jsonResponse({ results: [
      { title: "a", url: "https://t.dev", content: "c" },
      { title: "b", url: "" },
    ] }))
    const out = await web_search({ query: "x", config: { provider: "tavily", apiKey: "tv" } })
    expect(out).toHaveLength(1)
    expect(out[0].snippet).toBe("c")
  })
})

describe("serpapi (serpapi_search port)", () => {
  it("GETs the exact URL with engine/q/api_key/num and URL encoding", async () => {
    stubFetch(() => jsonResponse({ organic_results: [] }))
    await web_search({
      query: "hello world",
      config: { provider: "serpapi", apiKey: "sk", providerConfigs: { serpapi: { serpApiEngine: "google_news" } } },
      maxResults: 5,
    })
    expect(requests[0].url).toBe("https://serpapi.com/search?engine=google_news&q=hello+world&api_key=sk&num=5")
  })

  it("percent-encodes non-ASCII query bytes like the Rust url_encode", async () => {
    stubFetch(() => jsonResponse({ organic_results: [] }))
    await web_search({ query: "测试", config: { provider: "serpapi", apiKey: "sk" }, maxResults: 5 })
    expect(requests[0].url).toContain("q=%E6%B5%8B%E8%AF%95")
  })

  it("picks the first populated result section in desktop order", async () => {
    stubFetch(() => jsonResponse({ news_results: [
      { title: "n", link: "https://news.dev", snippet: "s" },
    ] }))
    const out = await web_search({ query: "x", config: { provider: "serpapi", apiKey: "sk" } })
    expect(out[0].title).toBe("n")
    expect(out[0].url).toBe("https://news.dev")
  })
})

describe("searxng (searxng_search port)", () => {
  it("normalizes the instance URL (scheme + /search) and joins categories", async () => {
    const srv = await startServer((req) => {
      expect(req.url).toBe("/search?q=query&format=json&categories=general%2Cit")
      return { body: { results: [] } }
    })
    try {
      await web_search({
        query: "query",
        config: {
          provider: "searxng",
          searXngUrl: `http://127.0.0.1:${srv.address().port}/`,
          searXngCategories: ["general", "it"],
        },
      })
    } finally { await stopServer(srv) }
  })

  it("prepends https:// and appends /search for schemeless instance URLs (normalize_searxng_url)", async () => {
    stubFetch(() => jsonResponse({ results: [] }))
    await web_search({
      query: "q",
      config: { provider: "searxng", searXngUrl: "search.example.com" },
    })
    expect(requests[0].url).toBe("https://search.example.com/search?q=q&format=json&categories=general")
  })

  it("requires an instance URL", async () => {
    await expect(web_search({ query: "x", config: { provider: "searxng" } }))
      .rejects.toThrow("SearXNG URL is required for web.search")
  })

  it("parses results and reports non-2xx with the trimmed body", async () => {
    stubFetch(() => jsonResponse({ results: [{ title: "r", url: "https://s.dev", content: "c" }] }))
    const out = await web_search({
      query: "x", config: { provider: "searxng", searXngUrl: "https://search.example.com" },
    })
    expect(out[0].title).toBe("r")

    stubFetch(() => new Response("oops".repeat(200), { status: 503 }))
    await expect(web_search({
      query: "x", config: { provider: "searxng", searXngUrl: "https://search.example.com" },
    })).rejects.toThrow(/SearXNG search failed \(503\)/)
  })
})

describe("ollama (ollama_search port)", () => {
  it("posts to {ollamaUrl}/api/web_search with Bearer auth", async () => {
    const srv = await startServer((req) => {
      expect(req.method).toBe("POST")
      expect(req.url).toBe("/api/web_search")
      expect(req.headers.authorization).toBe("Bearer ok")
      expect(req.body).toEqual({ query: "q", max_results: 2 })
      return { body: { results: [] } }
    })
    try {
      await web_search({
        query: "q",
        config: {
          provider: "ollama",
          apiKey: "ok",
          ollamaUrl: `http://127.0.0.1:${srv.address().port}`,
        },
        maxResults: 2,
      })
    } finally { await stopServer(srv) }
  })

  it("defaults to the public ollama.com endpoint", async () => {
    stubFetch(() => jsonResponse({ results: [] }))
    await web_search({ query: "q", config: { provider: "ollama", apiKey: "ok" } })
    expect(requests[0].url).toBe("https://ollama.com/api/web_search")
  })

  it("requires a key", async () => {
    await expect(web_search({ query: "q", config: { provider: "ollama" } }))
      .rejects.toThrow("Ollama web.search requires an API key in Settings.")
  })
})

describe("normalize_web_result fallbacks", () => {
  it("falls back to metadata fields and Untitled", async () => {
    stubFetch(() => jsonResponse({ data: [
      { metadata: { title: "mt", sourceURL: "https://meta.dev", description: "md" } },
      { title: "", url: "", snippet: "" },
    ] }))
    const out = await web_search({ query: "x", config: { provider: "firecrawl" } })
    expect(out[0].title).toBe("mt")
    expect(out[0].url).toBe("https://meta.dev")
    expect(out[0].snippet).toBe("md")
  })

  it("prefers top-level fields before metadata and markdown as a snippet fallback", async () => {
    stubFetch(() => jsonResponse({ data: [
      { title: "top", url: "https://t.dev", markdown: "# md", metadata: { title: "meta" } },
    ] }))
    const out = await web_search({ query: "x", config: { provider: "firecrawl" } })
    expect(out[0].title).toBe("top")
    expect(out[0].snippet).toBe("# md")
  })
})
