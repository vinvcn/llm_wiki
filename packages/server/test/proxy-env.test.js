// Proxy plumbing tests — faithful port of the desktop's Rust unit tests
// (src-tauri/src/proxy.rs): disabled_sets_no_env, enabled_sets_both_proxy_envs,
// bypass_local_off_clears_no_proxy, rejects_unsupported_schemes,
// rejects_empty_url, https_proxy_url_is_supported,
// redacts_basic_auth_credentials_in_url,
// apply_proxy_env_summary_does_not_leak_password,
// default_trait_matches_serde_missing_field_semantics,
// parses_camelcase_bypassLocal_field, read_proxy_config_from_store — plus
// runtime coverage of the undici global dispatcher (requests actually route
// through a mock proxy, NO_PROXY CIDR bypass, Proxy-Authorization from URL
// userinfo, CONNECT for https targets, enable→disable toggle).

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import http from "node:http"
import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_BYPASS_LIST, applyProxyEnv, applyProxyFromStore, hostMatchesNoProxy,
  normalizeProxyConfig, parseProxyConfig, readProxyConfigFromStore, redactUrl,
  shouldBypass,
} from "../src/proxy-env.js"

const PROJECT = "/Users/test/Project"

function snapshotEnv() {
  return {
    http: process.env.HTTP_PROXY,
    https: process.env.HTTPS_PROXY,
    no: process.env.NO_PROXY,
  }
}

function restoreEnv(snap) {
  for (const [k, v] of Object.entries({ HTTP_PROXY: snap.http, HTTPS_PROXY: snap.https, NO_PROXY: snap.no })) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

let envSnap = null
beforeEach(() => { envSnap = snapshotEnv() })
afterEach(() => {
  // Always end enabled: false so the global dispatcher returns to direct
  // and the env vars are cleared — never leak proxy state into other tests
  // in this file (vitest isolates files, but stay clean regardless).
  applyProxyEnv({ enabled: false, url: "", bypassLocal: true })
  restoreEnv(envSnap)
})

describe("applyProxyEnv summary strings + env (proxy.rs fixtures)", () => {
  it("disabled_sets_no_env: returns disabled and clears both proxy vars", () => {
    const s = applyProxyEnv({ enabled: false, url: "http://x:1", bypassLocal: true })
    expect(s).toContain("disabled")
    expect(process.env.HTTP_PROXY).toBeUndefined()
    expect(process.env.HTTPS_PROXY).toBeUndefined()
    expect(process.env.NO_PROXY).toBeUndefined()
  })

  it("disabled also clears a previously-set proxy (toggle-off regression)", () => {
    applyProxyEnv({ enabled: true, url: "http://127.0.0.1:7890", bypassLocal: true })
    expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890")
    const s = applyProxyEnv({ enabled: false, url: "http://127.0.0.1:7890", bypassLocal: true })
    expect(s).toBe("disabled")
    expect(process.env.HTTP_PROXY).toBeUndefined()
    expect(process.env.NO_PROXY).toBeUndefined()
  })

  it("enabled_sets_both_proxy_envs with the exact summary", () => {
    const s = applyProxyEnv({ enabled: true, url: "http://127.0.0.1:7890", bypassLocal: true })
    expect(s).toBe("enabled (http://127.0.0.1:7890, bypass_local=true)")
    expect(process.env.HTTP_PROXY).toBe("http://127.0.0.1:7890")
    expect(process.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890")
    const noProxy = process.env.NO_PROXY
    expect(noProxy).toContain("localhost")
    expect(noProxy).toContain("127.0.0.0/8")
    expect(noProxy).toContain("192.168.0.0/16")
  })

  it("bypass_local_off_clears_no_proxy (stale value must not leak)", () => {
    process.env.NO_PROXY = "stale-value"
    const s = applyProxyEnv({ enabled: true, url: "http://x:1", bypassLocal: false })
    expect(s).toBe("enabled (http://x:1, bypass_local=false)")
    expect(process.env.HTTP_PROXY).toBe("http://x:1")
    expect(process.env.NO_PROXY).toBeUndefined()
  })

  it("rejects_unsupported_schemes (socks5 treated as disabled)", () => {
    const s = applyProxyEnv({ enabled: true, url: "socks5://x:1", bypassLocal: true })
    expect(s).toBe("disabled (unsupported scheme: socks5://x:1)")
    expect(process.env.HTTP_PROXY).toBeUndefined()
  })

  it("rejects_empty_url", () => {
    const s = applyProxyEnv({ enabled: true, url: "   ", bypassLocal: true })
    expect(s).toBe("disabled (empty url)")
    expect(process.env.HTTP_PROXY).toBeUndefined()
  })

  it("https_proxy_url_is_supported", () => {
    applyProxyEnv({ enabled: true, url: "https://proxy.corp:443", bypassLocal: false })
    expect(process.env.HTTPS_PROXY).toBe("https://proxy.corp:443")
    expect(process.env.NO_PROXY).toBeUndefined()
  })
})

describe("redactUrl (proxy.rs redacts_basic_auth_credentials_in_url)", () => {
  it("redacts user:pass userinfo", () => {
    expect(redactUrl("http://user:pass@proxy.corp:8080")).toBe("http://***@proxy.corp:8080")
  })
  it("keeps an @ inside the path untouched", () => {
    expect(redactUrl("http://user:pass@proxy.corp:8080/some@path")).toBe("http://***@proxy.corp:8080/some@path")
  })
  it("redacts username-only userinfo", () => {
    expect(redactUrl("http://user@proxy.corp:8080")).toBe("http://***@proxy.corp:8080")
  })
  it("passes URLs without credentials through", () => {
    expect(redactUrl("http://proxy.corp:8080")).toBe("http://proxy.corp:8080")
  })
  it("does not crash on scheme-less garbage", () => {
    expect(redactUrl("garbage")).toBe("garbage")
  })
})

describe("applyProxyEnv summary never leaks the password", () => {
  it("proxy.rs apply_proxy_env_summary_does_not_leak_password", () => {
    const s = applyProxyEnv({ enabled: true, url: "http://secretuser:secretpass@proxy.corp:8080", bypassLocal: true })
    expect(s).not.toContain("secretpass")
    expect(s).not.toContain("secretuser")
    expect(s).toContain("***")
    expect(s).toContain("proxy.corp:8080")
  })
})

describe("parseProxyConfig (serde defaults)", () => {
  it("default_trait_matches_serde_missing_field_semantics: missing key = bypass on, proxy off", () => {
    const cfg = parseProxyConfig({})
    expect(cfg.enabled).toBe(false)
    expect(cfg.url).toBe("")
    expect(cfg.bypassLocal).toBe(true)
  })
  it("parses_camelcase_bypassLocal_field", () => {
    const cfg = parseProxyConfig({ enabled: true, url: "http://x:1", bypassLocal: false })
    expect(cfg.enabled).toBe(true)
    expect(cfg.url).toBe("http://x:1")
    expect(cfg.bypassLocal).toBe(false)
  })
  it("ignores non-object input", () => {
    expect(parseProxyConfig(undefined).bypassLocal).toBe(true)
    expect(parseProxyConfig(null).enabled).toBe(false)
    expect(parseProxyConfig("x").enabled).toBe(false)
  })
})

describe("normalizeProxyConfig (strict serde-style deserializer)", () => {
  it("missing fields take serde defaults (bypass_local=true)", () => {
    const d = normalizeProxyConfig({})
    expect(d).toEqual({ enabled: false, url: "", bypassLocal: true })
  })
  it("parses the camelCase bypassLocal field", () => {
    const c = normalizeProxyConfig(JSON.parse('{"enabled": true, "url": "http://x:1", "bypassLocal": false}'))
    expect(c).toEqual({ enabled: true, url: "http://x:1", bypassLocal: false })
  })
  it("rejects wrong-typed fields exactly like serde from_value", () => {
    expect(() => normalizeProxyConfig({ enabled: "yes" })).toThrow(/Invalid proxy config: enabled must be a boolean/)
    expect(() => normalizeProxyConfig({ url: 123 })).toThrow(/Invalid proxy config: url must be a string/)
    expect(() => normalizeProxyConfig({ bypassLocal: "yes" })).toThrow(/Invalid proxy config: bypassLocal must be a boolean/)
    expect(() => normalizeProxyConfig(null)).toThrow(/Invalid proxy config/)
    expect(() => normalizeProxyConfig(["x"])).toThrow(/Invalid proxy config/)
  })
  it("parseProxyConfig leniently degrades wrong-typed input to serde defaults", () => {
    expect(parseProxyConfig({ enabled: "yes" })).toEqual({ enabled: false, url: "", bypassLocal: true })
  })
})

describe("readProxyConfigFromStore (proxy.rs read_proxy_config_from_store)", () => {
  let dir = null
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-proxy-read-")) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it("missing store file -> null", () => {
    expect(readProxyConfigFromStore(path.join(dir, "missing.json"))).toBeNull()
  })
  it("parses proxyConfig from a store file", () => {
    const f = path.join(dir, "app-state.json")
    fs.writeFileSync(f, '{"proxyConfig": {"enabled": true, "url": "http://x:1", "bypassLocal": true}}')
    expect(readProxyConfigFromStore(f)).toEqual({ enabled: true, url: "http://x:1", bypassLocal: true })
  })
  it("store file without proxyConfig -> null", () => {
    const f = path.join(dir, "app-state.json")
    fs.writeFileSync(f, '{"otherKey": "value"}')
    expect(readProxyConfigFromStore(f)).toBeNull()
  })
  it("serde-invalid proxyConfig types -> null", () => {
    const f = path.join(dir, "app-state.json")
    fs.writeFileSync(f, '{"proxyConfig": {"enabled": "yes"}}')
    expect(readProxyConfigFromStore(f)).toBeNull()
  })
  it("unparseable json -> null", () => {
    const f = path.join(dir, "app-state.json")
    fs.writeFileSync(f, "{not json")
    expect(readProxyConfigFromStore(f)).toBeNull()
  })
  it("null proxyConfig value -> null (Some(Null) fails serde)", () => {
    const f = path.join(dir, "app-state.json")
    fs.writeFileSync(f, '{"proxyConfig": null}')
    expect(readProxyConfigFromStore(f)).toBeNull()
  })
})

describe("shouldBypass (reqwest NO_PROXY env semantics)", () => {
  const snap = { v: process.env.NO_PROXY }
  afterEach(() => {
    if (snap.v === undefined) delete process.env.NO_PROXY
    else process.env.NO_PROXY = snap.v
  })
  it("matches the desktop default bypass list", () => {
    process.env.NO_PROXY = DEFAULT_BYPASS_LIST
    expect(shouldBypass("http://127.0.0.1:8080/v1")).toBe(true)
    expect(shouldBypass("http://localhost:9920/")).toBe(true)
    expect(shouldBypass("http://10.1.2.3/x")).toBe(true)
    expect(shouldBypass("http://172.16.9.9/x")).toBe(true)
    expect(shouldBypass("http://192.168.1.5/x")).toBe(true)
    expect(shouldBypass("http://printer.local/ipp")).toBe(true)
    expect(shouldBypass("https://api.openai.com/v1")).toBe(false)
  })
  it("empty or unset NO_PROXY bypasses nothing", () => {
    process.env.NO_PROXY = ""
    expect(shouldBypass("http://127.0.0.1:8080/")).toBe(false)
    delete process.env.NO_PROXY
    expect(shouldBypass("http://127.0.0.1:8080/")).toBe(false)
  })
  it("NO_PROXY=* bypasses everything", () => {
    process.env.NO_PROXY = "*"
    expect(shouldBypass("https://example.com/")).toBe(true)
  })
  it(".suffix matches subdomains only", () => {
    process.env.NO_PROXY = ".corp"
    expect(shouldBypass("https://api.corp/x")).toBe(true)
    expect(shouldBypass("https://corp/x")).toBe(false)
  })
  it("unparseable url is never bypassed", () => {
    process.env.NO_PROXY = "*"
    expect(shouldBypass("not a url")).toBe(false)
  })
})

describe("hostMatchesNoProxy (reqwest NO_PROXY semantics)", () => {
  it("exact hostname matches", () => {
    expect(hostMatchesNoProxy("localhost", DEFAULT_BYPASS_LIST)).toBe(true)
    expect(hostMatchesNoProxy("myhost", "myhost")).toBe(true)
    expect(hostMatchesNoProxy("myhost2", "myhost")).toBe(false)
  })
  it("127.0.0.0/8 CIDR matches loopback and 127.x.x.x", () => {
    expect(hostMatchesNoProxy("127.0.0.1", DEFAULT_BYPASS_LIST)).toBe(true)
    expect(hostMatchesNoProxy("127.99.1.2", DEFAULT_BYPASS_LIST)).toBe(true)
    expect(hostMatchesNoProxy("128.0.0.1", DEFAULT_BYPASS_LIST)).toBe(false)
  })
  it("RFC1918 CIDR blocks", () => {
    expect(hostMatchesNoProxy("10.1.2.3", DEFAULT_BYPASS_LIST)).toBe(true)
    expect(hostMatchesNoProxy("172.16.0.1", DEFAULT_BYPASS_LIST)).toBe(true)
    expect(hostMatchesNoProxy("172.31.255.255", DEFAULT_BYPASS_LIST)).toBe(true)
    expect(hostMatchesNoProxy("172.32.0.1", DEFAULT_BYPASS_LIST)).toBe(false)
    expect(hostMatchesNoProxy("192.168.1.1", DEFAULT_BYPASS_LIST)).toBe(true)
    expect(hostMatchesNoProxy("192.169.0.1", DEFAULT_BYPASS_LIST)).toBe(false)
  })
  it("*.suffix wildcard", () => {
    expect(hostMatchesNoProxy("printer.local", DEFAULT_BYPASS_LIST)).toBe(true)
    expect(hostMatchesNoProxy("other.local", DEFAULT_BYPASS_LIST)).toBe(true)
    expect(hostMatchesNoProxy("local", DEFAULT_BYPASS_LIST)).toBe(false)
    expect(hostMatchesNoProxy("example.com", DEFAULT_BYPASS_LIST)).toBe(false)
  })
  it(".suffix matches subdomains only (reqwest)", () => {
    expect(hostMatchesNoProxy("api.corp", ".corp")).toBe(true)
    expect(hostMatchesNoProxy("a.b.corp", ".corp")).toBe(true)
    expect(hostMatchesNoProxy("corp", ".corp")).toBe(false)
  })
  it("NO_PROXY=* bypasses everything", () => {
    expect(hostMatchesNoProxy("example.com", "*")).toBe(true)
    expect(hostMatchesNoProxy("127.0.0.1", "*")).toBe(true)
  })
  it("case-insensitive and trailing-dot tolerant", () => {
    expect(hostMatchesNoProxy("LOCALHOST", DEFAULT_BYPASS_LIST)).toBe(true)
    expect(hostMatchesNoProxy("printer.local.", DEFAULT_BYPASS_LIST)).toBe(true)
  })
  it("empty list matches nothing", () => {
    expect(hostMatchesNoProxy("example.com", "")).toBe(false)
    expect(hostMatchesNoProxy("localhost", null)).toBe(false)
  })
})

// ── applyProxyFromStore (proxy.rs read_proxy_config_from_store) ──────────
describe("applyProxyFromStore (shared app-state.json)", () => {
  let dir = null
  let prevStore = null
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-proxy-store-"))
    prevStore = process.env.LLM_WIKI_STORE_FILE
  })
  afterEach(() => {
    if (prevStore === undefined) delete process.env.LLM_WIKI_STORE_FILE
    else process.env.LLM_WIKI_STORE_FILE = prevStore
    fs.rmSync(dir, { recursive: true, force: true })
  })
  it("parses proxy config from the store file", () => {
    const file = path.join(dir, "app-state.json")
    fs.writeFileSync(file, JSON.stringify({ proxyConfig: { enabled: true, url: "http://x:1", bypassLocal: true } }))
    process.env.LLM_WIKI_STORE_FILE = file
    const s = applyProxyFromStore()
    expect(s).toBe("enabled (http://x:1, bypass_local=true)")
    expect(process.env.HTTP_PROXY).toBe("http://x:1")
  })
  it("missing proxyConfig returns null (no proxy)", () => {
    const file = path.join(dir, "app-state.json")
    fs.writeFileSync(file, JSON.stringify({ otherKey: "value" }))
    process.env.LLM_WIKI_STORE_FILE = file
    expect(applyProxyFromStore()).toBeNull()
    expect(process.env.HTTP_PROXY).toBeUndefined()
  })
  it("missing store file returns null without throwing", () => {
    process.env.LLM_WIKI_STORE_FILE = path.join(dir, "missing.json")
    expect(applyProxyFromStore()).toBeNull()
  })
})
// NOTE: `resolveProxyStorePath` (the boot-log path) is covered end-to-end by
// scripts/verify/verify-proxy-env.mjs Part B, which asserts the exact
// `[proxy] reading from <path>` log line for both server entries — a unit
// test against the store's cached explicit-file resolution would be
// order-dependent (store.js pins the first explicit file per process).

// ── runtime routing through a real mock proxy ────────────────────────────
describe("global fetch routing through the proxy (undici dispatcher)", () => {
  let proxy = null
  let upstream = null
  let seen = []

  beforeEach(async () => {
    seen = []
    proxy = net.createServer((socket) => {
      let buf = ""
      let responded = false
      socket.on("data", (chunk) => {
        buf += chunk.toString("latin1")
        if (responded || !buf.includes("\r\n")) return
        responded = true
        const firstLine = buf.slice(0, buf.indexOf("\r\n"))
        const [method, target] = firstLine.split(" ")
        const authLine = buf.split("\r\n").find((l) => l.toLowerCase().startsWith("proxy-authorization:"))
        seen.push({ kind: "proxy", method, url: target, proxyAuth: authLine ? authLine.split(":")[1]?.trim() : null })
        if (method === "CONNECT") {
          socket.write("HTTP/1.1 200 Connection established\r\n\r\n")
          // Tear down after a beat — there is no real TLS upstream.
          setImmediate(() => socket.destroy())
          return
        }
        const body = JSON.stringify({ proxied: true, target })
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
          Buffer.byteLength(body) + "\r\nConnection: close\r\n\r\n" + body,
        )
      })
      socket.on("error", () => {})
    })
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r))
    upstream = http.createServer((req, res) => {
      seen.push({ kind: "direct", url: req.url })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ direct: true, target: req.url }))
    })
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r))
  })
  afterEach(async () => {
    applyProxyEnv({ enabled: false, url: "", bypassLocal: true })
    await new Promise((r) => { try { proxy.close(r) } catch { r() } })
    await new Promise((r) => { try { upstream.close(r) } catch { r() } })
  })

  const proxyUrl = () => `http://127.0.0.1:${proxy.address().port}`
  const upstreamUrl = () => `http://127.0.0.1:${upstream.address().port}`

  it("routes through the proxy when bypass is off (absolute-form)", async () => {
    applyProxyEnv({ enabled: true, url: proxyUrl(), bypassLocal: false })
    const res = await fetch(`${upstreamUrl()}/hello`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.proxied).toBe(true)
    expect(seen.find((e) => e.kind === "proxy" && e.url.endsWith("/hello"))).toBeTruthy()
    expect(seen.find((e) => e.kind === "direct")).toBeUndefined()
  })

  it("bypasses the proxy for local addresses when bypass_local is on", async () => {
    applyProxyEnv({ enabled: true, url: proxyUrl(), bypassLocal: true })
    const res = await fetch(`${upstreamUrl()}/local`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.direct).toBe(true)
    expect(seen.find((e) => e.kind === "proxy")).toBeUndefined()
  })

  it("sends Proxy-Authorization from URL userinfo", async () => {
    applyProxyEnv({ enabled: true, url: `http://user:secret@127.0.0.1:${proxy.address().port}`, bypassLocal: false })
    const res = await fetch(`${upstreamUrl()}/auth`)
    await res.text()
    const entry = seen.find((e) => e.kind === "proxy" && e.url.endsWith("/auth"))
    expect(entry.proxyAuth).toBe("Basic " + Buffer.from("user:secret").toString("base64"))
  })

  it("issues CONNECT for an https target through the proxy", async () => {
    applyProxyEnv({ enabled: true, url: proxyUrl(), bypassLocal: false })
    // The mock proxy answers CONNECT 200 and pipes; the TLS handshake then
    // fails (no real upstream TLS) — that is fine, we only assert the proxy
    // received the CONNECT for the right authority.
    await fetch("https://example.com/test").catch(() => {})
    const conn = seen.find((e) => e.kind === "proxy" && e.method === "CONNECT")
    expect(conn).toBeTruthy()
    expect(conn.url).toBe("example.com:443")
  })

  it("disabled config returns to direct routing immediately", async () => {
    applyProxyEnv({ enabled: true, url: proxyUrl(), bypassLocal: false })
    await fetch(`${upstreamUrl()}/pre`).catch(() => {})
    applyProxyEnv({ enabled: false, url: "", bypassLocal: true })
    const res = await fetch(`${upstreamUrl()}/post`)
    const body = await res.json()
    expect(body.direct).toBe(true)
  })
})
