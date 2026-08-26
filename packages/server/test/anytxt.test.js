// AnyTXT connector tests — faithful port of the desktop's AnyTXT contract
// (src-tauri/src/agent/tools.rs run_anytxt_search / extract_anytxt_items /
// extract_anytxt_fragment_text / normalize_anytxt_endpoint / trim_text +
// src-tauri/src/commands/external_search.rs file_url_for_path) plus a live
// JSON-RPC round-trip against an in-process mock service. The standing gate
// scripts/verify/verify-anytxt.mjs pins the full command + agent e2e surface;
// this suite pins the pure functions and the wire-level request/error
// contract so the server test suite owns the port.

import { describe, expect, it, beforeAll, afterAll } from "vitest"
import http from "node:http"
import {
  DEFAULT_ANYTXT_LIMIT, fileUrlForPath, normalizeAnytxtEndpoint, trimText,
  extractAnytxtItems, extractAnytxtFragmentText, runAnytxtSearch,
} from "../src/anytxt.js"

describe("fileUrlForPath (external_search.rs file_url_for_path fixtures)", () => {
  it("encodes Windows drive paths (UTF-8 percent-encoding)", () => {
    expect(fileUrlForPath("C:\\docs\\煤矿 安全.pdf")).toBe("file:///C:/docs/%E7%85%A4%E7%9F%BF%20%E5%AE%89%E5%85%A8.pdf")
  })
  it("encodes POSIX absolute paths", () => {
    expect(fileUrlForPath("/Users/me/docs/a b.txt")).toBe("file:///Users/me/docs/a%20b.txt")
  })
  it("passes scheme paths (anytxt:// fids) through unchanged", () => {
    expect(fileUrlForPath("anytxt://99")).toBe("anytxt://99")
    expect(fileUrlForPath("file:///C:/x%20y.txt")).toBe("file:///C:/x%20y.txt")
  })
  it("maps UNC paths to file://host/share", () => {
    expect(fileUrlForPath("//server/share/x.txt")).toBe("file://server/share/x.txt")
  })
  it("keeps relative and empty paths as-is", () => {
    expect(fileUrlForPath("")).toBe("")
    expect(fileUrlForPath("docs/a.txt")).toBe("docs/a.txt")
  })
})

describe("normalizeAnytxtEndpoint + trimText (tools.rs)", () => {
  it("prefixes bare hosts with http:// and keeps explicit schemes", () => {
    expect(normalizeAnytxtEndpoint("127.0.0.1:9920")).toBe("http://127.0.0.1:9920")
    expect(normalizeAnytxtEndpoint("https://x:1")).toBe("https://x:1")
  })
  it("trims on character count, not bytes, with an ellipsis", () => {
    expect(trimText("abc", 5)).toBe("abc")
    expect(trimText("abcdef", 3)).toBe("abc...")
    expect(trimText("煤矿安全规程xy", 6)).toBe("煤矿安全规程...")
  })
})

describe("extractAnytxtItems (tools.rs extract_anytxt_items fixtures)", () => {
  it("maps object items, skipping empty path+snippet, basename titles, fid-only anytxt:// paths", () => {
    const items = extractAnytxtItems({ result: { items: [
      { fid: "f1", title: "T1", path: "/x/a.md", snippet: "s1" },
      { path: "", snippet: "" },
      { id: 42, name: "only-name.txt" },
      { fid: "77" },
    ] } })
    expect(items).toEqual([
      { fid: "f1", title: "T1", path: "/x/a.md", snippet: "s1" },
      { fid: "42", title: "only-name.txt", path: "only-name.txt", snippet: "" },
      { fid: "77", title: "77", path: "anytxt://77", snippet: "" },
    ])
  })
  it("zips array rows with a fields header", () => {
    const items = extractAnytxtItems({ result: { field: ["fid", "path", "snippet"], items: [
      ["9", "/y/b.txt", "row snippet"],
    ] } })
    expect(items[0]).toEqual({ fid: "9", title: "b.txt", path: "/y/b.txt", snippet: "row snippet" })
  })
  it("turns scalar records into {text} rows and accepts nested output.data + alternate field names", () => {
    expect(extractAnytxtItems({ result: { items: ["just some text"] } })).toEqual([
      { fid: "", title: "AnyTXT result", path: "", snippet: "just some text" },
    ])
    expect(extractAnytxtItems({ result: { output: { data: [{ file: "/z/c.md", summary: "alt keys" }] } } })).toEqual([
      { fid: "", title: "c.md", path: "/z/c.md", snippet: "alt keys" },
    ])
  })
})

describe("extractAnytxtFragmentText (tools.rs extract_anytxt_fragment_text fixtures)", () => {
  it("handles strings, arrays, object key priority and nested descent", () => {
    expect(extractAnytxtFragmentText("plain")).toBe("plain")
    expect(extractAnytxtFragmentText(["a", "", "b"])).toBe("a\n\nb")
    expect(extractAnytxtFragmentText({ html: "<b>x</b>" })).toBe("<b>x</b>")
    expect(extractAnytxtFragmentText({ output: { fragments: [{ text: "nested" }] } })).toBe("nested")
    expect(extractAnytxtFragmentText(null)).toBe("")
  })
})

describe("runAnytxtSearch (tools.rs run_anytxt_search wire contract)", () => {
  let server
  let baseUrl
  const seen = []
  const closedPort = () => new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let buf = ""
      req.on("data", (c) => (buf += c))
      req.on("end", () => {
        let body
        try { body = JSON.parse(buf) } catch { res.writeHead(400); res.end("bad json"); return }
        seen.push(body)
        const input = body?.params?.input ?? {}
        if (body.method === "ATRpcServer.Searcher.V1.GetResult") {
          if (input.pattern === "err500") { res.writeHead(500, { "Content-Type": "text/plain" }); res.end("boom"); return }
          if (input.pattern === "badjson") { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{not json"); return }
          if (input.pattern === "rpcerr") {
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ id: body.id, jsonrpc: "2.0", error: { code: -32000, message: "index corrupted" } }))
            return
          }
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({
            id: body.id, jsonrpc: "2.0",
            result: {
              items: [
                { fid: "f-1", title: "煤矿安全规程", path: "C:\\docs\\煤矿 安全.pdf", snippet: "original snippet one" },
                { fid: "", title: "", path: "/Users/me/docs/a b.txt", snippet: "plain snippet two" },
                { title: "no-path-no-snippet" },
              ],
            },
          }))
          return
        }
        if (body.method === "ATRpcServer.Searcher.V1.GetFragment") {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ id: body.id, jsonrpc: "2.0", result: { text: `FRAGMENT for ${input.fid} matching '${input.pattern}'` } }))
          return
        }
        res.writeHead(400); res.end("unknown method")
      })
    })
    await new Promise((r) => server.listen(0, "127.0.0.1", r))
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  afterAll(async () => { server?.close() })

  it("sends the desktop GetResult JSON-RPC body and enriches snippets via GetFragment", async () => {
    seen.length = 0
    const refs = await runAnytxtSearch("safety", { enabled: true, endpoint: baseUrl }, 20)
    expect(refs).toHaveLength(2)
    expect(refs[0]).toMatchObject({
      title: "煤矿安全规程",
      path: "file:///C:/docs/%E7%85%A4%E7%9F%BF%20%E5%AE%89%E5%85%A8.pdf",
      kind: "anytxt",
      snippet: "FRAGMENT for f-1 matching 'safety'",
    })
    expect(refs[1]).toMatchObject({ title: "a b.txt", path: "file:///Users/me/docs/a%20b.txt", snippet: "plain snippet two" })
    const getResult = seen.find((s) => s.method === "ATRpcServer.Searcher.V1.GetResult")
    expect(getResult).toBeTruthy()
    expect(getResult.id).toBe(1)
    expect(getResult.jsonrpc).toBe("2.0")
    expect(getResult.params.input).toEqual({
      pattern: "safety", filterExt: "*", lastModifyBegin: 0, lastModifyEnd: 2147483647,
      limit: "20", offset: 0, order: 0,
    })
    const frag = seen.find((s) => s.method === "ATRpcServer.Searcher.V1.GetFragment")
    expect(frag).toBeTruthy()
    expect(frag.id).toBe(2)
    expect(frag.params.input).toEqual({ fid: "f-1", pattern: "safety" })
    expect(seen.filter((s) => s.method === "ATRpcServer.Searcher.V1.GetFragment")).toHaveLength(1)
  })

  it("honors filterDir/filterExt and clamps limit to min(topK, config.limit)", async () => {
    seen.length = 0
    const refs = await runAnytxtSearch("safety", { enabled: true, endpoint: baseUrl, filterDir: "D:\\work", filterExt: "pdf", limit: 2 }, 500)
    expect(refs).toHaveLength(2)
    expect(seen.find((s) => s.method === "ATRpcServer.Searcher.V1.GetResult").params.input).toMatchObject({
      filterDir: "D:\\work", filterExt: "pdf", limit: "2",
    })
  })

  it("short-circuits empty queries and explicitly-disabled configs with no traffic", async () => {
    seen.length = 0
    expect(await runAnytxtSearch("   ", { enabled: true, endpoint: baseUrl }, 20)).toEqual([])
    expect(await runAnytxtSearch("safety", { enabled: false, endpoint: baseUrl }, 20)).toEqual([])
    expect(seen).toHaveLength(0)
  })

  it("asserts the desktop error strings for unreachable / HTTP / invalid-JSON / RPC-error services", async () => {
    const dead = await closedPort()
    await expect(runAnytxtSearch("safety", { enabled: true, endpoint: `http://127.0.0.1:${dead}` }, 20))
      .rejects.toThrow(new RegExp(`^AnyTXT search failed\\. Check that ATGUI\\.exe or the AnyTXT service is running at http://127\\.0\\.0\\.1:${dead}:`))
    await expect(runAnytxtSearch("err500", { enabled: true, endpoint: baseUrl }, 20))
      .rejects.toThrow("AnyTXT HTTP 500: boom")
    await expect(runAnytxtSearch("badjson", { enabled: true, endpoint: baseUrl }, 20))
      .rejects.toThrow("AnyTXT returned invalid JSON: {not json")
    await expect(runAnytxtSearch("rpcerr", { enabled: true, endpoint: baseUrl }, 20))
      .rejects.toThrow(/AnyTXT error: .*index corrupted/)
  })

  it("defaults endpoint / limit exactly like the desktop constants", () => {
    expect(DEFAULT_ANYTXT_LIMIT).toBe(20)
    // Without an endpoint the run still constructs the default URL and fails
    // with the desktop error (no local service on CI).
    return expect(runAnytxtSearch("x", { enabled: true }, 0)).rejects.toThrow(/running at http:\/\/127\.0\.0\.1:9920/)
  })
})
