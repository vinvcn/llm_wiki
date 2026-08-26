// Commands whose desktop meaning does not exist in the browser. Every one of
// them no-ops safely or returns an honest status string so the web client
// degrades gracefully — there are NO throwing stubs in this file. NOTE: the
// vector store, project archive export/import, wiki-index rebuild, the
// chat-agent runtime, the local CLI chat transports (claude-code / codex-cli)
// and the outbound network proxy (set_proxy_env) are all implemented
// server-side now (see vectorstore.js / maintenance.js / agent.js / ../cli.js
// / ../proxy-env.js — the server runs on the host, so it does exactly what
// the desktop process does). What remains here as a genuine web-mode
// limitation is only the OS-window/companion surface: `set_close_behavior`
// validates + echoes the value with the desktop's exact error semantics but
// cannot intercept a browser tab's own close, plus the Chrome-clipper status
// and the API-server status strings.

import fs from "node:fs"
import path from "node:path"
import { applyProxyEnv, normalizeProxyConfig } from "../proxy-env.js"
import { getClipStatus } from "../clip-server.js"


// ── mcp_server_entry_path (faithful port of src-tauri/src/lib.rs) ─────────
// The desktop resolves the bundled MCP stdio server entry
// (`mcp-server/dist/src/index.js`) relative to the app repo, the cwd, and
// the process dirs, and returns the first existing file (canonicalized) or
// throws a build hint. The web server runs on the host, so it resolves the
// exact same candidates and returns the same path/error — the user can point
// their MCP client at one entry regardless of which client they use.
const MCP_RELATIVE = path.join("mcp-server", "dist", "src", "index.js")

/** Resolve `mcp-server/dist/src/index.js` under each base's repo-chain
 *  (base, base/.., base/../..) — mirrors `push_repo_candidates`. Returns the
 *  canonical absolute path of the first existing file, or null. */
export function resolveMcpEntryPath(candidateBases) {
  const candidates = []
  const pushRepoCandidates = (base) => {
    candidates.push(path.join(base, MCP_RELATIVE))
    candidates.push(path.join(base, "..", MCP_RELATIVE))
    candidates.push(path.join(base, "..", "..", MCP_RELATIVE))
  }
  for (const base of candidateBases) pushRepoCandidates(path.resolve(String(base)))
  for (const candidate of candidates) {
    let st
    try { st = fs.statSync(candidate) } catch { continue }
    if (st.isFile()) {
      try { return fs.realpathSync(candidate) } catch { return candidate }
    }
  }
  return null
}

/** Throw-wrapper used by the command; exported so the error branch is
 *  testable with an arbitrary base set. */
export function mcpServerEntryPathFromBases(bases) {
  const found = resolveMcpEntryPath(bases)
  if (found) return found
  throw new Error("MCP server entry was not found. Run `npm run mcp:build` from the LLM Wiki repository, then reopen Settings.")
}

function mcpServerEntryPath() {
  // Candidates mirror lib.rs: the app/repo dir chain (the server package is
  // the analog of CARGO_MANIFEST_DIR — base/.. reaches the repo root) and the
  // launch cwd. Tauri resource/exe-dir candidates have no Node equivalent.
  return mcpServerEntryPathFromBases([path.resolve(import.meta.dirname, ".."), process.cwd()])
}


// ── Desktop shell / status ────────────────────────────────────────────────
const shellCommands = {
  // Faithful port of the desktop's set_proxy_env (src-tauri/src/lib.rs +
  // src-tauri/src/proxy.rs): the command argument is deserialized STRICTLY
  // (serde ProxyConfig), so a wrong-typed field fails the invoke exactly like
  // the desktop's command-arg deserialization error; a valid config sets
  // HTTP_PROXY/HTTPS_PROXY/NO_PROXY and installs the global undici
  // dispatcher so every server outbound call (and /api/proxy) routes through
  // the configured proxy with the desktop's exact summary-string contract.
  set_proxy_env: (args) => {
    const config = normalizeProxyConfig(args && args.config)
    const summary = applyProxyEnv(config)
    // Desktop lib.rs eprintlns the live-update summary on every toggle.
    console.log(`[proxy] live update: ${summary}`)
    return summary
  },
  // Faithful port of the desktop's set_close_behavior: normalize the value
  // (ask|minimize|exit) and return it, or error with the desktop's exact
  // string. The browser cannot hook its own window close, so the value is
  // validated + echoed without any OS effect — still, an unmodified React
  // frontend that reads the return value sees the desktop contract.
  set_close_behavior: (args) => {
    const value = String((args && args.value) ?? "")
    if (value !== "ask" && value !== "minimize" && value !== "exit") {
      throw new Error(`Invalid close behavior: ${value}`)
    }
    return value
  },
  clip_server_status: () => getClipStatus(),
  // The web server IS the local HTTP API server (same process), and the
  // frontend's status line switches on the desktop's exact vocabulary
  // ("running"/"starting"/"port_conflict"/"error") — so when this command is
  // reachable the honest desktop-faithful value is "running".
  api_server_status: () => "running",
  api_server_reload_config: () => "ok",
  mcp_server_entry_path: mcpServerEntryPath,
}

export const miscCommands = {
  ...shellCommands,
}
