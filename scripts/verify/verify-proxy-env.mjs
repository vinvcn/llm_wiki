// Outbound HTTP proxy acceptance harness (faithful port of the desktop's
// proxy.rs contract + live traffic proof).
//
// Part A ports EVERY unit test in src-tauri/src/proxy.rs `mod tests` against
// packages/server/src/proxy-env.js (env-var application, summary strings,
// redaction, store parsing, camelCase field, NO_PROXY matching).
//
// Part B proves real traffic through a live forward proxy against the actual
// server (index.js): boot-time application from the shared store, the
// set_proxy_env live toggle (on/off/bypass), NO_PROXY bypass for loopback,
// the /api/proxy route, HTTPS-over-CONNECT, web_search, and error semantics
// of set_proxy_env / set_close_behavior.
//
//   node scripts/verify/verify-proxy-env.mjs

import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http from "node:http"
import https from "node:https"
import net from "node:net"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log("  ok  -", m) } else { fail++; console.log("  FAIL-", m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
}
async function waitFor(fn, t, what) {
  const start = Date.now()
  while (Date.now() - start < t) { try { if (await fn()) return true } catch {} await sleep(80) }
  throw new Error(`timeout waiting for ${what}`)
}
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body)
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c))
      res.on("end", () => { try { resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }) } catch { resolve({ status: res.statusCode, raw: buf }) } })
    })
    r.on("error", reject); if (data) r.write(data); r.end()
  })
}

// The v2/Docker entrypoint wraps invoke results as { ok, result } and command
// errors as 400 { code, message, details }; the legacy entry returns the raw
// result and 500 { error }. Unwrap so both runs assert the same contract
// (same pattern as verify-filesync-shared.mjs / verify-vectorstore.mjs).
const V2_INVOKE = process.env.SERVER_ENTRY?.includes("index-v2") ?? false
const unv = (j) => (V2_INVOKE ? j?.result : j)
const errMsg = (r) => (V2_INVOKE ? (r.json?.error?.message ?? "") : (r.json?.error ?? ""))
const errStatus = V2_INVOKE ? 400 : 500

// ════════════════════════════ PART A — unit fixtures ═══════════════════════
// Imported after setting an isolated data dir so config.js resolves away from
// the real home dir (no side effects either way, but keep it hermetic).
const unitTmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-proxy-unit-"))
process.env.LLM_WIKI_DATA_DIR = path.join(unitTmp, "data")
process.env.LLM_WIKI_NO_SHARE = "1"

const {
  applyProxyEnv, redactUrl, readProxyConfigFromStore, normalizeProxyConfig,
  shouldBypass, DEFAULT_BYPASS_LIST,
} = await import(path.join(REPO, "packages/server/src/proxy-env.js"))

console.log("part A — proxy.rs unit fixtures (faithful port)")

// env isolation helper, mirroring proxy.rs `isolated()`
function isolated(fn) {
  const snap = { h: process.env.HTTP_PROXY, s: process.env.HTTPS_PROXY, n: process.env.NO_PROXY }
  delete process.env.HTTP_PROXY; delete process.env.HTTPS_PROXY; delete process.env.NO_PROXY
  try { fn() } finally {
    for (const [k, v] of [["HTTP_PROXY", snap.h], ["HTTPS_PROXY", snap.s], ["NO_PROXY", snap.n]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
}

// disabled_sets_no_env
isolated(() => {
  const s = applyProxyEnv({ enabled: false, url: "http://x:1", bypassLocal: true })
  ok(s.includes("disabled"), `disabled config returns '${s}'`)
  ok(process.env.HTTP_PROXY === undefined && process.env.HTTPS_PROXY === undefined, "disabled config sets no env")
})

// enabled_sets_both_proxy_envs
isolated(() => {
  applyProxyEnv({ enabled: true, url: "http://127.0.0.1:7890", bypassLocal: true })
  ok(process.env.HTTP_PROXY === "http://127.0.0.1:7890", "HTTP_PROXY set")
  ok(process.env.HTTPS_PROXY === "http://127.0.0.1:7890", "HTTPS_PROXY set")
  const n = process.env.NO_PROXY ?? ""
  ok(n.includes("localhost") && n.includes("127.0.0.0/8") && n.includes("192.168.0.0/16"), "NO_PROXY is the desktop's default bypass list")
  ok(n === DEFAULT_BYPASS_LIST, "DEFAULT_BYPASS_LIST is byte-identical to the desktop")
})

// bypass_local_off_clears_no_proxy
isolated(() => {
  process.env.NO_PROXY = "stale-value"
  applyProxyEnv({ enabled: true, url: "http://x:1", bypassLocal: false })
  ok(process.env.NO_PROXY === undefined, "bypass off clears a stale NO_PROXY")
})

// rejects_unsupported_schemes
isolated(() => {
  const s = applyProxyEnv({ enabled: true, url: "socks5://x:1", bypassLocal: true })
  ok(process.env.HTTP_PROXY === undefined, "socks5 scheme is not applied")
  ok(s === "disabled (unsupported scheme: socks5://x:1)", `unsupported-scheme summary exact (got '${s}')`)
})

// rejects_empty_url
isolated(() => {
  const s = applyProxyEnv({ enabled: true, url: "   ", bypassLocal: true })
  ok(process.env.HTTP_PROXY === undefined, "empty url is not applied")
  ok(s === "disabled (empty url)", `empty-url summary exact (got '${s}')`)
})

// disable_after_enable_clears_previously_set_env_vars
isolated(() => {
  applyProxyEnv({ enabled: true, url: "http://127.0.0.1:7890", bypassLocal: true })
  ok(process.env.HTTP_PROXY === "http://127.0.0.1:7890", "enabled first")
  const s = applyProxyEnv({ enabled: false, url: "http://127.0.0.1:7890", bypassLocal: true })
  ok(s === "disabled", "disable summary exact")
  ok(process.env.HTTP_PROXY === undefined && process.env.HTTPS_PROXY === undefined && process.env.NO_PROXY === undefined, "disable actively clears all three vars")
})

// unsupported_scheme_after_enable_clears_env
isolated(() => {
  applyProxyEnv({ enabled: true, url: "http://127.0.0.1:7890", bypassLocal: true })
  applyProxyEnv({ enabled: true, url: "socks5://x:1", bypassLocal: true })
  ok(process.env.HTTP_PROXY === undefined, "switching to an unsupported scheme clears env")
})

// https_proxy_url_is_supported
isolated(() => {
  applyProxyEnv({ enabled: true, url: "https://proxy.corp:443", bypassLocal: false })
  ok(process.env.HTTPS_PROXY === "https://proxy.corp:443", "https proxy url is supported")
})

// redacts_basic_auth_credentials_in_url (all 5 desktop fixtures)
ok(redactUrl("http://user:pass@proxy.corp:8080") === "http://***@proxy.corp:8080", "redact user:pass")
ok(redactUrl("http://user:pass@proxy.corp:8080/some@path") === "http://***@proxy.corp:8080/some@path", "redact keeps @ in path")
ok(redactUrl("http://user@proxy.corp:8080") === "http://***@proxy.corp:8080", "redact username-only")
ok(redactUrl("http://proxy.corp:8080") === "http://proxy.corp:8080", "redact passes through credential-less")
ok(redactUrl("garbage") === "garbage", "redact survives garbage")

// apply_proxy_env_summary_does_not_leak_password
isolated(() => {
  const summary = applyProxyEnv({ enabled: true, url: "http://secretuser:secretpass@proxy.corp:8080", bypassLocal: true })
  ok(!summary.includes("secretpass") && !summary.includes("secretuser"), "summary leaks no credentials")
  ok(summary.includes("***") && summary.includes("proxy.corp:8080"), "summary redacts but keeps host")
  ok(summary === "enabled (http://***@proxy.corp:8080, bypass_local=true)", `enabled summary exact (got '${summary}')`)
})

// default_trait_matches_serde_missing_field_semantics
{
  const d = normalizeProxyConfig({})
  ok(d.enabled === false && d.url === "" && d.bypassLocal === true, "missing fields take serde defaults (bypassLocal=true)")
}

// parses_camelcase_bypassLocal_field
{
  const c = normalizeProxyConfig(JSON.parse('{"enabled": true, "url": "http://x:1", "bypassLocal": false}'))
  ok(c.enabled === true && c.url === "http://x:1" && c.bypassLocal === false, "camelCase bypassLocal parsed")
}

// missing_proxyConfig_returns_none / parses_proxy_config_from_store_file / ignores_store_file_with_no_proxy_section
{
  ok(readProxyConfigFromStore(path.join(unitTmp, "missing.json")) === null, "missing store file -> null")
  const f1 = path.join(unitTmp, "app-state-1.json")
  fs.writeFileSync(f1, '{"proxyConfig": {"enabled": true, "url": "http://x:1", "bypassLocal": true}}')
  const cfg = readProxyConfigFromStore(f1)
  ok(cfg && cfg.enabled === true && cfg.url === "http://x:1", "proxyConfig parsed from store file")
  const f2 = path.join(unitTmp, "app-state-2.json")
  fs.writeFileSync(f2, '{"otherKey": "value"}')
  ok(readProxyConfigFromStore(f2) === null, "store file without proxyConfig -> null")
  const f3 = path.join(unitTmp, "app-state-3.json")
  fs.writeFileSync(f3, '{"proxyConfig": {"enabled": "yes"}}')
  ok(readProxyConfigFromStore(f3) === null, "invalid proxyConfig types -> null (serde failure)")
}

// NO_PROXY matching semantics (reqwest-style for the desktop default list)
isolated(() => {
  process.env.NO_PROXY = DEFAULT_BYPASS_LIST
  ok(shouldBypass("http://127.0.0.1:8080/v1") === true, "127.0.0.1 bypassed via 127.0.0.0/8")
  ok(shouldBypass("http://localhost:9920/") === true, "localhost bypassed exactly")
  ok(shouldBypass("http://10.1.2.3/x") === true, "10.0.0.0/8 bypassed")
  ok(shouldBypass("http://172.16.9.9/x") === true, "172.16.0.0/12 bypassed")
  ok(shouldBypass("http://172.32.0.1/x") === false, "172.32.x NOT in 172.16.0.0/12")
  ok(shouldBypass("http://192.168.1.5/x") === true, "192.168.0.0/16 bypassed")
  ok(shouldBypass("http://printer.local/ipp") === true, "*.local suffix bypassed")
  ok(shouldBypass("http://a.b.local/x") === true, "*.local matches deep subdomains")
  ok(shouldBypass("https://api.openai.com/v1") === false, "public host NOT bypassed")
  process.env.NO_PROXY = ""
  ok(shouldBypass("http://127.0.0.1:8080/") === false, "empty NO_PROXY bypasses nothing")
  delete process.env.NO_PROXY
  ok(shouldBypass("http://127.0.0.1:8080/") === false, "unset NO_PROXY bypasses nothing")
  process.env.NO_PROXY = "*"
  ok(shouldBypass("https://example.com/") === true, "NO_PROXY=* bypasses everything")
  process.env.NO_PROXY = ".corp"
  ok(shouldBypass("https://api.corp/x") === true && shouldBypass("https://corp/x") === false, ".suffix matches subdomains only")
})

// ════════════════════════ PART B — live traffic via proxy ═══════════════════
console.log("part B — live traffic through a real forward proxy")

// ── forward proxy (counts absolute-form forwards + CONNECT tunnels) ───────
// undici 8.x's ProxyAgent CONNECT-tunnels https targets but sends plain-http
// targets in absolute-form (older undici CONNECTed everything); the proxy
// records and byte-counts BOTH so the traffic-through-proxy assertions hold
// on the installed undici.
const proxyStats = { absolute: [], connects: [], bytes: 0 }
const proxyPort = await freePort()
const proxyServer = http.createServer((cReq, cRes) => {
  const target = new URL(cReq.url)
  proxyStats.absolute.push(`${target.hostname}:${target.port || 80}`)
  const headers = { ...cReq.headers }
  delete headers["proxy-connection"]
  const up = http.request({
    host: target.hostname, port: target.port || 80,
    method: cReq.method, path: target.pathname + target.search, headers,
  }, (upRes) => {
    cRes.writeHead(upRes.statusCode, upRes.headers)
    upRes.on("data", (c) => (proxyStats.bytes += c.length))
    upRes.pipe(cRes)
  })
  up.on("error", (e) => { if (!cRes.headersSent) cRes.writeHead(502); cRes.end(String(e)) })
  cReq.on("data", (c) => (proxyStats.bytes += c.length))
  cReq.pipe(up)
})
proxyServer.on("connect", (req, clientSocket, head) => {
  proxyStats.connects.push(req.url)
  const [host, portStr] = req.url.split(":")
  const up = net.connect(Number(portStr) || 443, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    if (head.length) up.write(head)
    // Count bytes in both directions: undici REUSES established tunnels for
    // repeat requests to the same origin (keep-alive), so traffic-through-
    // proxy must be asserted on bytes, not on fresh CONNECTs.
    up.on("data", (c) => (proxyStats.bytes += c.length))
    clientSocket.on("data", (c) => (proxyStats.bytes += c.length))
    up.pipe(clientSocket)
    clientSocket.pipe(up)
  })
  up.on("error", () => clientSocket.destroy())
  clientSocket.on("error", () => up.destroy())
})
await new Promise((r) => proxyServer.listen(proxyPort, "127.0.0.1", r))

// ── mock upstream (LLM + hello + searxng) ─────────────────────────────────
const upStats = { llm: 0, hello: 0, search: 0 }
const upPort = await freePort()
const upstream = http.createServer((rq, rs) => {
  let buf = ""; rq.on("data", (c) => (buf += c))
  rq.on("end", () => {
    if (rq.method === "POST" && rq.url.includes("/chat/completions")) {
      upStats.llm++
      rs.writeHead(200, { "Content-Type": "application/json" })
      rs.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Proxy-verified answer." } }] }))
    } else if (rq.url.startsWith("/hello")) {
      upStats.hello++
      rs.writeHead(200, { "Content-Type": "application/json" })
      rs.end(JSON.stringify({ hello: "world" }))
    } else if (rq.url.startsWith("/search")) {
      upStats.search++
      rs.writeHead(200, { "Content-Type": "application/json" })
      rs.end(JSON.stringify({ results: [{ title: "Proxied result", url: "http://example.com/x", content: "snippet" }] }))
    } else { rs.writeHead(404); rs.end("nope") }
  })
})
await new Promise((r) => upstream.listen(upPort, "127.0.0.1", r))

// ── HTTPS upstream behind CONNECT (self-signed) ───────────────────────────
const certDir = path.join(unitTmp, "certs")
fs.mkdirSync(certDir, { recursive: true })
const oss = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", path.join(certDir, "key.pem"), "-out", path.join(certDir, "cert.pem"), "-days", "2", "-nodes", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "pipe" })
if (oss.status !== 0) throw new Error(`openssl failed: ${oss.stderr}`)
const tlsPort = await freePort()
const tlsStats = { secure: 0 }
const tlsUpstream = https.createServer({
  key: fs.readFileSync(path.join(certDir, "key.pem")),
  cert: fs.readFileSync(path.join(certDir, "cert.pem")),
}, (rq, rs) => {
  tlsStats.secure++
  rs.writeHead(200, { "Content-Type": "application/json" })
  rs.end(JSON.stringify({ secure: true }))
})
await new Promise((r) => tlsUpstream.listen(tlsPort, "127.0.0.1", r))

// ── wiki server with proxyConfig ALREADY in the shared store (boot apply) ─
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-proxy-live-"))
const dataDir = path.join(tmp, "data")
const storesDir = path.join(dataDir, "stores")
fs.mkdirSync(storesDir, { recursive: true })
const projectPath = path.join(tmp, "project")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n")

const storeData = {
  llmConfig: { provider: "custom", apiKey: "test-key", model: "mock-model", customEndpoint: `http://127.0.0.1:${upPort}/v1`, apiMode: "chat_completions" },
  proxyConfig: { enabled: true, url: `http://127.0.0.1:${proxyPort}`, bypassLocal: false },
  projectRegistry: { "proj-1": { id: "proj-1", path: projectPath, name: "project" } },
  lastProject: { id: "proj-1", path: projectPath },
}
fs.writeFileSync(path.join(storesDir, "app-state.json"), JSON.stringify(storeData, null, 2))

const port = await freePort()
// SERVER_ENTRY=packages/server/src/index-v2.js re-runs the whole contract
// against the Docker/v2 entry point (same startup hook + command registry).
const SERVER_ENTRY = process.env.SERVER_ENTRY || "packages/server/src/index.js"
const child = spawn(process.execPath, [SERVER_ENTRY], {
  cwd: REPO,
  env: {
    ...process.env,
    LLM_WIKI_PORT: String(port), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir,
    NODE_TLS_REJECT_UNAUTHORIZED: "0", // self-signed CONNECT upstream (test only)
    HTTP_PROXY: "", HTTPS_PROXY: "", NO_PROXY: "", // harness env must not leak in
  },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", (d) => (serverLog += d))
child.stderr.on("data", (d) => (serverLog += d))

async function agentTurn(runId) {
  return req(port, "POST", "/api/invoke/agent_start_turn", {
    projectId: "proj-1",
    request: { sessionId: `sess-${runId}`, runId, message: "hello", history: [], mode: "standard", tools: {}, topK: 3 },
  })
}

try {
  await waitFor(async () => (await req(port, "GET", "/api/health")).status === 200, 8000, "server health")

  // 1. boot-time application from the shared store (desktop setup-hook parity)
  ok(serverLog.includes(`[proxy] reading from ${path.join(storesDir, "app-state.json")}`), "boot log reads the active store file")
  ok(serverLog.includes(`[proxy] enabled (http://127.0.0.1:${proxyPort}, bypass_local=false)`), "boot log shows the exact desktop summary")
  {
    const r = await agentTurn("run-boot")
    ok(r.status === 200 && /Proxy-verified answer/.test(unv(r.json)?.message ?? ""), `agent turn through the proxy works (got ${r.status})`)
    ok(upStats.llm >= 1, "mock LLM upstream received the request")
    const proxiedVia = proxyStats.connects.includes(`127.0.0.1:${upPort}`) || proxyStats.absolute.includes(`127.0.0.1:${upPort}`)
    ok(proxiedVia, `LLM request went THROUGH the proxy (CONNECT ${proxyStats.connects.join(", ") || "none"}; absolute ${proxyStats.absolute.join(", ") || "none"})`)
  }

  // 2. live disable via set_proxy_env (desktop's exact summary string)
  {
    const before = proxyStats.bytes
    const d = await req(port, "POST", "/api/invoke/set_proxy_env", { config: { enabled: false, url: `http://127.0.0.1:${proxyPort}`, bypassLocal: false } })
    ok(d.status === 200 && unv(d.json) === "disabled", `set_proxy_env disabled returns exact summary (got ${JSON.stringify(unv(d.json))})`)
    const r = await agentTurn("run-disabled")
    ok(r.status === 200 && /Proxy-verified answer/.test(unv(r.json)?.message ?? ""), "agent turn works direct after disable")
    await sleep(150) // allow any stray tunnel bytes to arrive before asserting silence
    ok(proxyStats.bytes === before, `disabled: proxy saw NO new traffic (${before} == ${proxyStats.bytes} bytes)`)
  }

  // 3. live re-enable with bypassLocal=true -> loopback target bypasses (NO_PROXY)
  {
    const before = proxyStats.bytes
    const e = await req(port, "POST", "/api/invoke/set_proxy_env", { config: { enabled: true, url: `http://127.0.0.1:${proxyPort}`, bypassLocal: true } })
    ok(e.status === 200 && unv(e.json) === `enabled (http://127.0.0.1:${proxyPort}, bypass_local=true)`, "bypass-on summary exact")
    const r = await agentTurn("run-bypass")
    ok(r.status === 200, "agent turn works with bypass on")
    await sleep(150)
    ok(proxyStats.bytes === before, `127.0.0.1 matched 127.0.0.0/8 and BYPASSED the proxy (${before} == ${proxyStats.bytes} bytes)`)
  }

  // 4. live re-enable with bypassLocal=false -> proxied again
  {
    const before = proxyStats.bytes
    const e = await req(port, "POST", "/api/invoke/set_proxy_env", { config: { enabled: true, url: `http://127.0.0.1:${proxyPort}`, bypassLocal: false } })
    ok(e.status === 200 && unv(e.json) === `enabled (http://127.0.0.1:${proxyPort}, bypass_local=false)`, "bypass-off summary exact")
    const r = await agentTurn("run-proxied-again")
    ok(r.status === 200, "agent turn works after re-enable")
    ok(proxyStats.bytes > before, `re-enabled: LLM traffic flowed through the proxy again (${before} -> ${proxyStats.bytes} bytes; tunnel reused)`)
  }

  // 5. /api/proxy route (the browser's LLM path) honors the proxy too
  {
    const before = proxyStats.bytes
    const p = await req(port, "POST", "/api/proxy", { url: `http://127.0.0.1:${upPort}/hello`, method: "GET" })
    ok(p.status === 200 && p.json?.hello === "world", "/api/proxy streams the upstream body back")
    ok(upStats.hello === 1, "upstream /hello answered exactly once")
    ok(proxyStats.bytes > before, `/api/proxy request flowed through the proxy (${before} -> ${proxyStats.bytes} bytes)`)
  }

  // 6. HTTPS target -> CONNECT tunnel through the proxy
  {
    const before = proxyStats.bytes
    const t = await req(port, "POST", "/api/proxy", { url: `https://127.0.0.1:${tlsPort}/secure`, method: "GET" })
    ok(t.status === 200 && t.json?.secure === true, "https upstream reachable through CONNECT tunnel")
    ok(proxyStats.connects.includes(`127.0.0.1:${tlsPort}`) && proxyStats.bytes > before && tlsStats.secure >= 1, `proxy tunneled to the TLS upstream (CONNECT list: ${proxyStats.connects.join(", ")})`)
  }

  // 7. web_search (SearXNG) honors the proxy
  {
    const before = proxyStats.bytes
    const w = await req(port, "POST", "/api/invoke/web_search", {
      query: "proxy test", maxResults: 3,
      config: { provider: "searxng", providerConfigs: { searxng: { searXngUrl: `http://127.0.0.1:${upPort}`, searXngCategories: ["general"] } } },
    })
    const wRes = unv(w.json)
    ok(w.status === 200 && Array.isArray(wRes) && wRes[0]?.title === "Proxied result", `web_search returns the upstream's results (got ${w.status} ${JSON.stringify(wRes)?.slice(0, 120)})`)
    ok(upStats.search === 1, "upstream /search answered exactly once")
    ok(proxyStats.bytes > before, `web_search flowed through the proxy (${before} -> ${proxyStats.bytes} bytes)`)
  }

  // 8. error semantics over HTTP
  {
    const bad = await req(port, "POST", "/api/invoke/set_proxy_env", { config: { enabled: "yes" } })
    ok(bad.status === errStatus && /Invalid proxy config/.test(errMsg(bad)), `invalid config errors (got ${bad.status} ${JSON.stringify(errMsg(bad))})`)
    const cb1 = await req(port, "POST", "/api/invoke/set_close_behavior", { value: "minimize" })
    ok(cb1.status === 200 && unv(cb1.json) === "minimize", `set_close_behavior returns normalized value (got ${JSON.stringify(unv(cb1.json))})`)
    const cb2 = await req(port, "POST", "/api/invoke/set_close_behavior", { value: "bogus" })
    ok(cb2.status === errStatus && /Invalid close behavior: bogus/.test(errMsg(cb2)), `invalid close behavior errors exactly (got ${JSON.stringify(errMsg(cb2))})`)
  }
} finally {
  try { child.kill("SIGKILL") } catch {}
  try { proxyServer.close() } catch {}
  try { upstream.close() } catch {}
  try { tlsUpstream.close() } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(unitTmp, { recursive: true, force: true }) } catch {}
}

console.log(`\nproxy-env: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
