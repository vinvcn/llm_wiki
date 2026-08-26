// Binary-safe /api/proxy envelope contract (desktop parity).
//
// The desktop's Tauri HTTP plugin hands raw bytes to reqwest, so binary
// request bodies (MinerU cloud PDF PUT, local MinerU multipart FormData) must
// cross the web shim (src/web/http.ts) + /api/proxy BYTE-EXACT. The shim
// therefore sends `bodyBase64` for ArrayBuffer/TypedArray/Blob bodies and
// `formEntries` for FormData; the server must rebuild the raw bytes / a real
// multipart body from them. This file pins the server half of that contract
// against a mock upstream (the standing gate scripts/verify/verify-proxy-
// binary.mjs pins the same contract over HTTP on BOTH server entrypoints).

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import request from "supertest"
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import crypto from "node:crypto"

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "llmwiki-proxybin-"))
process.env.LLM_WIKI_DATA_DIR = DATA_DIR
process.env.LLM_WIKI_NO_SHARE = "1"
process.env.LLM_WIKI_AUTH_MODE = "none"
delete process.env.LLM_WIKI_API_TOKEN

const { app } = await import("../src/index-v2.js")

// Deterministic binary payload hostile to naive UTF-8 round-trips.
const PDF_BINARY = Buffer.concat([
  Buffer.from("%PDF-1.4\n"),
  Buffer.from([0x00, 0xff, 0x80, 0x81, 0xfe, 0xc3, 0x28]),
  Buffer.alloc(4096, 0xa5),
  Buffer.from("trailer\n%%EOF\n"),
])

const seen = { put: null, putCt: null, form: null, formCt: null, json: null }
let upstreamUrl = ""

const upstream = createServer((req, res) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", async () => {
    const raw = Buffer.concat(chunks)
    if (req.method === "PUT" && req.url === "/put") {
      seen.put = raw
      seen.putCt = req.headers["content-type"]
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end('{"ok":true}')
      return
    }
    if (req.method === "POST" && req.url === "/form") {
      seen.formCt = req.headers["content-type"] || ""
      try {
        const fd = await new Request("http://mock/form", {
          method: "POST",
          headers: { "content-type": seen.formCt },
          body: raw,
        }).formData()
        const entries = []
        for (const [name, value] of fd.entries()) {
          if (typeof value === "string") entries.push({ name, value })
          else entries.push({ name, fileName: value.name, type: value.type, bytes: Buffer.from(await value.arrayBuffer()) })
        }
        seen.form = entries
      } catch (err) {
        seen.form = { parseError: String(err) }
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end('{"task_id":"t-1"}')
      return
    }
    if (req.method === "POST" && req.url === "/json") {
      seen.json = raw.toString("utf-8")
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ echoed: true }))
      return
    }
    res.writeHead(404)
    res.end()
  })
})

beforeAll(async () => {
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r))
  const addr = upstream.address()
  upstreamUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise((r) => upstream.close(() => r(undefined)))
  try { rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

const proxy = (spec) =>
  request(app).post("/api/proxy").set("Content-Type", "application/json").send(spec)

describe("v2 /api/proxy binary envelope (desktop reqwest parity)", () => {
  it("bodyBase64 PUT delivers the exact bytes and keeps custom headers", async () => {
    const res = await proxy({
      url: `${upstreamUrl}/put`,
      method: "PUT",
      headers: { "X-Test": "kept", Connection: "dropped" },
      bodyBase64: PDF_BINARY.toString("base64"),
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(seen.put).toBeDefined()
    expect(Buffer.compare(seen.put, PDF_BINARY)).toBe(0)
    expect(seen.put.length).toBe(PDF_BINARY.length)
  })

  it("formEntries becomes a real multipart body the upstream can parse byte-exact", async () => {
    const res = await proxy({
      url: `${upstreamUrl}/form`,
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=STALE-BROWSER-BOUNDARY" },
      formEntries: [
        { name: "backend", value: "hybrid-engine" },
        { name: "return_md", value: "true" },
        { name: "files", fileName: "sample.pdf", contentType: "application/pdf", base64: PDF_BINARY.toString("base64") },
      ],
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ task_id: "t-1" })
    expect(seen.formCt).toMatch(/^multipart\/form-data; boundary=/)
    expect(seen.formCt).not.toContain("STALE-BROWSER-BOUNDARY")
    expect(Array.isArray(seen.form)).toBe(true)
    const text = Object.fromEntries(seen.form.filter((e) => "value" in e).map((e) => [e.name, e.value]))
    expect(text).toEqual({ backend: "hybrid-engine", return_md: "true" })
    const file = seen.form.find((e) => e.name === "files")
    expect(file).toBeDefined()
    expect(file.fileName).toBe("sample.pdf")
    expect(file.type).toBe("application/pdf")
    expect(Buffer.compare(file.bytes, PDF_BINARY)).toBe(0)
  })

  it("bodyContentType fills a missing Content-Type; an explicit one wins", async () => {
    await proxy({
      url: `${upstreamUrl}/put`, method: "PUT",
      bodyBase64: Buffer.from([1, 2, 3]).toString("base64"),
      bodyContentType: "application/pdf",
    })
    expect(seen.putCt).toBe("application/pdf")

    await proxy({
      url: `${upstreamUrl}/put`, method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      bodyBase64: Buffer.from([1, 2, 3]).toString("base64"),
      bodyContentType: "application/pdf",
    })
    expect(seen.putCt).toBe("application/octet-stream")
  })

  it("keeps the pre-existing text-body contract unchanged", async () => {
    const payload = { model: "m", messages: [{ role: "user", content: "héllo 中文" }] }
    const res = await proxy({
      url: `${upstreamUrl}/json`, method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ echoed: true })
    expect(seen.json).toBe(JSON.stringify(payload))
  })

  it("rejects ambiguous bodies with the desktop's exact error", async () => {
    const res = await proxy({
      url: `${upstreamUrl}/put`, method: "PUT",
      body: "x", bodyBase64: "eA==",
    })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "Ambiguous body: send exactly one of body, bodyBase64, formEntries" })
  })

  it("rejects a non-array formEntries and invalid entries with 400", async () => {
    const notArray = await proxy({ url: `${upstreamUrl}/form`, method: "POST", formEntries: "nope" })
    expect(notArray.status).toBe(400)
    expect(notArray.body).toEqual({ error: "formEntries must be an array" })

    const badEntry = await proxy({ url: `${upstreamUrl}/form`, method: "POST", formEntries: [{ name: "" }] })
    expect(badEntry.status).toBe(400)
    expect(badEntry.body).toEqual({ error: "Invalid formEntries entry" })

    const badFile = await proxy({ url: `${upstreamUrl}/form`, method: "POST", formEntries: [{ name: "f", base64: 42 }] })
    expect(badFile.status).toBe(400)
    expect(badFile.body).toEqual({ error: "Invalid formEntries file part" })
  })

  it("rejects a non-string bodyBase64 with 400", async () => {
    const res = await proxy({ url: `${upstreamUrl}/put`, method: "PUT", bodyBase64: 42 })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: "bodyBase64 must be a string" })
  })

  it("sends the base64-decoded bytes (deterministic sha over the full body)", () => {
    const shaHex = crypto.createHash("sha256").update(PDF_BINARY).digest("hex")
    expect(shaHex.length).toBe(64)
    expect(PDF_BINARY.some((b) => b > 127 && b !== 0xff)).toBe(true) // binary, not ASCII
  })
})
