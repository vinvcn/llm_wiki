// Global outbound HTTP proxy plumbing — Node port of src-tauri/src/proxy.rs.
//
// The desktop reads the user-set proxy config out of the same plugin-store
// (`app-state.json`, key `proxyConfig`) the frontend writes, and translates
// it into HTTP_PROXY / HTTPS_PROXY / NO_PROXY environment variables that
// reqwest picks up on client construction. The web server runs on the host,
// so it does the same thing — and because Node's fetch (undici) does NOT
// read env vars (unlike reqwest), it ALSO installs a global undici
// dispatcher that routes every outbound `fetch()` through the configured
// proxy, honoring the same NO_PROXY bypass rules. That covers the server's
// own outbound calls (LLM / embedding / web-search providers) AND `/api/proxy`
// (the browser client's cross-origin shim), so "Settings → Network" behaves
// identically on both clients. Spawned child processes (the claude/codex CLI
// transports) inherit the env vars and honor the proxy too, exactly like
// children of the desktop app.
//
// Summary-string / env semantics are a 1:1 port of `apply_proxy_env`
// (including the redact-before-log contract); see the unit tests.

import fs from "node:fs"
import { Agent, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici"
import { resolveStorePath } from "./store.js"
import { SHARED_STORE_NAME } from "./config.js"

export const DEFAULT_BYPASS_LIST =
  "localhost,127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,*.local"

// ── serde defaults (src-tauri/src/proxy.rs ProxyConfig) ──────────────────
// `bypass_local` defaults to TRUE for a missing key (serde
// `default = "default_true"`), which differs from Rust's derive(Default).
// `normalizeProxyConfig` is the STRICT deserializer: a present-but-wrong-typed
// field throws (exactly like serde_json from_value), so the store reader can
// swallow the failure into "no proxy" and the command layer can surface it as
// `Invalid proxy config: ...` (the desktop's command-arg deserialization
// error). `parseProxyConfig` is the lenient projection `applyProxyEnv` uses —
// any non-object or type mismatch degrades to the serde defaults, so an
// already-validated config can never throw at apply time.
export function normalizeProxyConfig(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid proxy config: expected an object")
  }
  const { enabled, url, bypassLocal } = value
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new TypeError("Invalid proxy config: enabled must be a boolean")
  }
  if (url !== undefined && typeof url !== "string") {
    throw new TypeError("Invalid proxy config: url must be a string")
  }
  if (bypassLocal !== undefined && typeof bypassLocal !== "boolean") {
    throw new TypeError("Invalid proxy config: bypassLocal must be a boolean")
  }
  return {
    enabled: enabled === true,
    url: typeof url === "string" ? url : "",
    bypassLocal: bypassLocal !== false, // missing key = true (serde default_true)
  }
}

export function parseProxyConfig(value) {
  try {
    return normalizeProxyConfig(value)
  } catch {
    return { enabled: false, url: "", bypassLocal: true }
  }
}

/** Strip embedded basic-auth credentials from a URL before logging.
 *  `http://user:pass@host:port` → `http://***@host:port` — 1:1 port of
 *  `redact_url` (userinfo is up to the first '@' BEFORE the first '/'). */
export function redactUrl(url) {
  const schemeEnd = url.indexOf("://")
  if (schemeEnd < 0) return url
  const afterScheme = url.slice(schemeEnd + 3)
  const pathStart = afterScheme.indexOf("/") === -1 ? afterScheme.length : afterScheme.indexOf("/")
  const userinfoEnd = afterScheme.slice(0, pathStart).indexOf("@")
  if (userinfoEnd < 0) return url
  return url.slice(0, schemeEnd + 3) + "***" + afterScheme.slice(userinfoEnd)
}

// ── NO_PROXY matching (reqwest semantics: hostnames, IP literals, CIDR
//    blocks, `*.suffix` wildcards — see src/lib/proxy-config.ts) ──────────
function isIPv4(s) {
  const parts = s.split(".")
  if (parts.length !== 4) return false
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false
    const n = Number(p)
    return n >= 0 && n <= 255
  })
}

function ipv4ToInt(s) {
  return s.split(".").reduce((acc, p) => ((acc << 8) | Number(p)) >>> 0, 0) >>> 0
}

function ipInCidr(host, ip, bits) {
  if (!isIPv4(host) || !isIPv4(ip) || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((ipv4ToInt(host) & mask) >>> 0) === ((ipv4ToInt(ip) & mask) >>> 0)
}

/** Does `hostname` match any entry of a comma-separated NO_PROXY list? */
export function hostMatchesNoProxy(hostname, noProxyList) {
  const host = String(hostname ?? "").toLowerCase().replace(/\.$/, "")
  if (!host) return false
  for (const raw of String(noProxyList ?? "").split(",")) {
    const entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === "*") return true // NO_PROXY=* bypasses everything
    if (entry === host) return true
    if (entry.startsWith(".") && host.endsWith(entry)) return true // .suffix matches subdomains only
    if (entry.startsWith("*.") && host.endsWith(entry.slice(1))) return true
    if (entry.includes("/")) {
      const [ip, bitsRaw] = entry.split("/", 2)
      if (ipInCidr(host, ip, Number(bitsRaw))) return true
      continue
    }
    if (isIPv4(entry) && entry === host) return true
  }
  return false
}

/** Does the FULL URL bypass the proxy per the current NO_PROXY env list?
 *  (reqwest's per-client env read; Node's fetch has no built-in equivalent,
 *  so the dispatcher below consults this on every request.) */
export function shouldBypass(url) {
  let host = ""
  try { host = new URL(String(url)).hostname } catch { return false }
  return hostMatchesNoProxy(host, process.env.NO_PROXY ?? "")
}

// ── global undici dispatcher wiring ───────────────────────────────────────
// Node's fetch does not read HTTP_PROXY/HTTPS_PROXY env vars, so a plain
// env set is not enough (unlike reqwest). We install a dispatcher that
// routes each request through a ProxyAgent unless the target matches
// NO_PROXY. The concurrency note from proxy.rs applies the same way:
// swapping the global dispatcher can race with an in-flight fetch, and the
// worst case is one request reading the previous setting — acceptable for a
// user-initiated toggle.
const DEFAULT_DISPATCHER = getGlobalDispatcher()
let activeSelector = null

class ProxySelectingAgent extends Agent {
  constructor(proxyUrl) {
    super()
    this.proxyAgent = new ProxyAgent(proxyUrl)
  }

  dispatch(opts, handler) {
    try {
      const origin = new URL(String(opts.origin))
      if (shouldBypass(origin.href)) {
        return super.dispatch(opts, handler)
      }
    } catch { /* unparseable origin → treat as remote, use the proxy */ }
    return this.proxyAgent.dispatch(opts, handler)
  }

  // close/destroy deliberately not overridden: fetch never closes the
  // global dispatcher, and delegating destroy to both agents at once caused
  // unbounded recursion inside undici. The old selector is simply dropped
  // on toggle (its keep-alive sockets time out on their own).
}

function installProxy(proxyUrl) {
  activeSelector = new ProxySelectingAgent(proxyUrl)
  setGlobalDispatcher(activeSelector)
}

function clearProxyDispatcher() {
  if (activeSelector) {
    // Detach first, then drop the reference — in-flight fetches finish on
    // the old dispatcher, keep-alive sockets time out on their own.
    setGlobalDispatcher(DEFAULT_DISPATCHER)
    activeSelector = null
  } else if (getGlobalDispatcher() !== DEFAULT_DISPATCHER) {
    setGlobalDispatcher(DEFAULT_DISPATCHER)
  }
}

// ── apply_proxy_env (1:1 port) ────────────────────────────────────────────
/** Apply a proxy config: set the env vars children inherit, install the
 *  undici dispatcher for this process's own fetch calls, and return the
 *  desktop's exact human-readable summary. Every "disabled" path clears
 *  all three env vars AND the dispatcher, so toggling the proxy off after
 *  it was on can never leave the previous values routing. */
export function applyProxyEnv(config) {
  const { enabled, url: rawUrl, bypassLocal } = parseProxyConfig(config)
  const url = rawUrl.trim()
  const invalidScheme = !url.startsWith("http://") && !url.startsWith("https://")

  if (!enabled || url === "" || invalidScheme) {
    clearProxyDispatcher()
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.NO_PROXY
    if (!enabled) return "disabled"
    if (url === "") return "disabled (empty url)"
    return `disabled (unsupported scheme: ${redactUrl(url)})`
  }

  process.env.HTTP_PROXY = url
  process.env.HTTPS_PROXY = url
  if (bypassLocal) process.env.NO_PROXY = DEFAULT_BYPASS_LIST
  else delete process.env.NO_PROXY
  try {
    installProxy(url)
  } catch {
    // Node-only edge: the URL passes the scheme check but ProxyAgent still
    // refuses it (e.g. `http://` with no host). Rust can defer parsing to
    // reqwest so it never fails here; degrade to disabled rather than
    // throwing (the desktop contract is that set_proxy_env never errors).
    clearProxyDispatcher()
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    delete process.env.NO_PROXY
    return `disabled (invalid proxy url: ${redactUrl(url)})`
  }
  return `enabled (${redactUrl(url)}, bypass_local=${bypassLocal})`
}

/** Read `proxyConfig` out of a plugin-store file (src-tauri/src/proxy.rs
 *  `read_proxy_config_from_store`): missing / unparseable file, missing key,
 *  or serde-invalid config all map to null ("no proxy"). */
export function readProxyConfigFromStore(storePath) {
  let content
  try { content = fs.readFileSync(storePath, "utf-8") } catch { return null }
  let json
  try { json = JSON.parse(content) } catch { return null }
  if (!json || typeof json !== "object" || Array.isArray(json)) return null
  if (!Object.prototype.hasOwnProperty.call(json, "proxyConfig")) return null
  try { return normalizeProxyConfig(json.proxyConfig) } catch { return null }
}

/** Resolve the on-disk plugin-store file the proxy config is read from —
 *  the same shared-store discovery the /api/store endpoints use, so the
 *  boot log names the exact file in play. */
export function resolveProxyStorePath() {
  return resolveStorePath(SHARED_STORE_NAME)
}

/** Apply the proxy config from the shared plugin-store (the Rust setup
 *  hook's `read_proxy_config_from_store` + `apply_proxy_env`). Returns the
 *  summary string, or null when the store has no proxyConfig key (or the
 *  file cannot be read). */
export function applyProxyFromStore() {
  const cfg = readProxyConfigFromStore(resolveProxyStorePath())
  if (cfg === null) return null
  return applyProxyEnv(cfg)
}
