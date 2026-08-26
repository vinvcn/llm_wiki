// Web shim for @tauri-apps/plugin-http: cross-origin requests are forwarded
// through POST /api/proxy with a structured body envelope. Binary bodies
// (ArrayBuffer / TypedArray / Blob) must travel byte-exact as bodyBase64 and
// FormData must travel as formEntries — the text-only path would corrupt the
// MinerU cloud PDF PUT / local multipart submit. Same-origin requests bypass
// the proxy entirely.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import proxyFetch, { fetch as namedFetch } from "./http"

const fetchMock = vi.fn()
const okResponse = () => ({ ok: true, status: 200 } as Response)

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(okResponse())
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function lastProxyCall(): { url: unknown; opts: RequestInit } {
  const call = fetchMock.mock.calls.find(([u]) => u === "/api/proxy")
  if (!call) throw new Error("no /api/proxy call made")
  return { url: call[0], opts: call[1] as RequestInit }
}

describe("web http shim — /api/proxy body envelope", () => {
  it("forwards string bodies verbatim", async () => {
    await namedFetch("https://provider.example/v1/chat", {
      method: "POST",
      headers: { Authorization: "Bearer x" },
      body: JSON.stringify({ model: "m" }),
    })
    const { opts } = lastProxyCall()
    const spec = JSON.parse(String(opts.body))
    expect(spec).toEqual({
      url: "https://provider.example/v1/chat",
      method: "POST",
      headers: { Authorization: "Bearer x" },
      body: JSON.stringify({ model: "m" }),
    })
  })

  it("sends URLSearchParams as a plain text body", async () => {
    await namedFetch("https://provider.example/form", { method: "POST", body: new URLSearchParams({ a: "1", b: "2" }) })
    const spec = JSON.parse(String(lastProxyCall().opts.body))
    expect(spec.body).toBe("a=1&b=2")
  })

  it("sends an ArrayBuffer body byte-exact as bodyBase64 (no UTF-8 mangling)", async () => {
    const bytes = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80, 0xfe, 0xa5, 0xc3, 0x25, 0x45, 0x4f, 0x46])
    await namedFetch("https://upload.example/put.pdf", { method: "PUT", body: bytes.buffer as ArrayBuffer })
    const spec = JSON.parse(String(lastProxyCall().opts.body))
    expect(spec.body).toBeUndefined()
    expect(spec.bodyBase64).toBe(Buffer.from(bytes).toString("base64"))
    const decoded = Uint8Array.from(Buffer.from(spec.bodyBase64, "base64"))
    expect(decoded).toEqual(bytes)
  })

  it("sends a TypedArray view honoring byteOffset/byteLength", async () => {
    const backing = Uint8Array.from([9, 9, 1, 2, 3, 9])
    const view = new Uint8Array(backing.buffer, 2, 3)
    await namedFetch("https://upload.example/put", { method: "PUT", body: view })
    const spec = JSON.parse(String(lastProxyCall().opts.body))
    expect(Uint8Array.from(Buffer.from(spec.bodyBase64, "base64"))).toEqual(Uint8Array.from([1, 2, 3]))
  })

  it("sends Blob bodies with bodyContentType from the Blob type", async () => {
    await namedFetch("https://upload.example/put.pdf", {
      method: "PUT",
      body: new Blob([new Uint8Array([0, 1, 255])], { type: "application/pdf" }),
    })
    const spec = JSON.parse(String(lastProxyCall().opts.body))
    expect(spec.bodyBase64).toBe(Buffer.from([0, 1, 255]).toString("base64"))
    expect(spec.bodyContentType).toBe("application/pdf")
  })

  it("sends FormData as formEntries with base64 file parts", async () => {
    const form = new FormData()
    form.append("backend", "hybrid-engine")
    form.append("files", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff])], "sample.pdf", { type: "application/pdf" }))
    await namedFetch("https://local-mineru/tasks", { method: "POST", body: form })
    const spec = JSON.parse(String(lastProxyCall().opts.body))
    expect(spec.body).toBeUndefined()
    expect(spec.bodyBase64).toBeUndefined()
    expect(spec.formEntries).toEqual([
      { name: "backend", value: "hybrid-engine" },
      { name: "files", fileName: "sample.pdf", contentType: "application/pdf", base64: Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff]).toString("base64") },
    ])
  })

  it("attaches the bearer token like the rest of the transport", async () => {
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "llm-wiki-token" ? "tok-123" : null) })
    await namedFetch("https://provider.example/v1/chat", { method: "POST", body: "{}" })
    const { opts } = lastProxyCall()
    expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer tok-123")
  })

  it("bypasses the proxy for same-origin requests", async () => {
    await namedFetch("/api/invoke/open_project", { method: "POST", body: "{}" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe("/api/invoke/open_project")
  })

  it("default export and named export are the same function", () => {
    expect(namedFetch).toBe(proxyFetch)
  })
})
