// Web shim for `@tauri-apps/plugin-http`.
//
// The desktop app uses Tauri's Rust HTTP plugin so it can set arbitrary
// headers and reach providers that omit CORS headers. The browser cannot do
// either, so cross-origin requests are forwarded through the server's
// streaming `/api/proxy` endpoint (which mirrors the plugin's purpose).
// Same-origin requests (the app's own /api/* calls) go straight through.
//
// Binary request bodies are byte-exact. The desktop plugin hands raw bytes
// to reqwest, so the shim must not decode binary bodies as text: Blob /
// ArrayBuffer / TypedArray bodies travel as base64 (`bodyBase64`) and
// FormData bodies travel as structured entries (`formEntries`) whose file
// parts are base64 — the server rebuilds the multipart request there (the
// browser-generated multipart boundary is meaningless to the server). This
// carries e.g. the MinerU PDF upload (cloud PUT + local multipart submit)
// end-to-end uncorrupted.

function headersToObject(input?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {}
  if (!input) return out
  if (input instanceof Headers) { input.forEach((v, k) => { out[k] = v }); return out }
  if (Array.isArray(input)) { for (const [k, v] of input) out[k] = v; return out }
  return { ...(input as Record<string, string>) }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

function isSameOrigin(url: string): boolean {
  if (url.startsWith("/")) return true
  try {
    if (typeof location === "undefined") return false
    return new URL(url, location.href).origin === location.origin
  } catch {
    return false
  }
}

// Same storage key as src/api/client.ts + src/web/http-api.ts. The proxy call
// is same-origin but the server enforces auth on it (token mode), so we attach
// the bearer token here just like the rest of the transport.
const TOKEN_KEY = "llm-wiki-token"
function authToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}

/** Chunked btoa so arbitrarily large byte arrays never hit arg-count limits. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
}

interface TextBodySpec { body: string }
interface BinaryBodySpec { bodyBase64: string; bodyContentType?: string }
interface FormBodySpec {
  formEntries: Array<
    | { name: string; value: string }
    | { name: string; fileName: string; contentType: string; base64: string }
  >
}
type BodySpec = TextBodySpec | BinaryBodySpec | FormBodySpec | Record<string, never>

async function encodeBody(body: BodyInit): Promise<BodySpec> {
  if (typeof body === "string") return { body }
  if (body instanceof URLSearchParams) return { body: body.toString() }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const formEntries: FormBodySpec["formEntries"] = []
    for (const [name, value] of body.entries()) {
      if (typeof Blob !== "undefined" && value instanceof Blob) {
        const fileName = typeof File !== "undefined" && value instanceof File ? value.name : name
        formEntries.push({
          name,
          fileName,
          contentType: value.type || "application/octet-stream",
          base64: await blobToBase64(value),
        })
      } else {
        formEntries.push({ name, value: String(value) })
      }
    }
    return { formEntries }
  }
  if (body instanceof ArrayBuffer) {
    return { bodyBase64: bytesToBase64(new Uint8Array(body)) }
  }
  if (ArrayBuffer.isView(body)) {
    return {
      bodyBase64: bytesToBase64(
        new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      ),
    }
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    const spec: BinaryBodySpec = { bodyBase64: await blobToBase64(body) }
    if (body.type) spec.bodyContentType = body.type
    return spec
  }
  // ReadableStream and anything exotic: best-effort text (the desktop plugin
  // would stream it raw; no current call site sends a stream cross-origin).
  return { body: await new Response(body as BodyInit).text() }
}

export const fetch: typeof globalThis.fetch = async (input, init) => {
  const url = urlOf(input)
  if (isSameOrigin(url)) return globalThis.fetch(input, init)

  const method = init?.method ?? (input instanceof Request ? input.method : "GET")
  const headers = headersToObject(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const bodySpec = init?.body == null
    ? {}
    : await encodeBody(init.body)

  const proxyHeaders: Record<string, string> = { "Content-Type": "application/json" }
  const tok = authToken()
  if (tok) proxyHeaders["Authorization"] = `Bearer ${tok}`

  return globalThis.fetch("/api/proxy", {
    method: "POST",
    headers: proxyHeaders,
    body: JSON.stringify({ url, method, headers, ...bodySpec }),
  })
}

export default fetch
