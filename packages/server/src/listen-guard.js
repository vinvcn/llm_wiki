// listen-guard.js — main-listener bind-failure diagnostics.
//
// The supported topology is SAME HOST: the web server runs where the user's
// projects live, often while the DESKTOP app is open. The desktop always owns
// :19828 (its built-in REST API, src-tauri/src/api_server.rs) and :19827
// (clipper companion), so a bind failure on the web server's default port IS
// the expected state in that topology and must be a fast, actionable exit —
// never a raw crash trace (legacy http.createServer without an 'error'
// listener throws "Unhandled 'error' event") and never a zombie process that
// prints the success banner while the port is owned by someone else (Express
// 5 delivers bind errors to the listen CALLBACK, which a callback that
// ignores its first argument silently swallows).

import fs from "node:fs"

let exited = false

function displayHost(host) {
  return host === "0.0.0.0" ? "localhost" : host
}

/**
 * Human diagnosis for a listen failure. `ctx` = { port, host, entry } (the
 * entry name is part of the caller context; the message is entry-agnostic).
 * Error-code branches mirror what an operator can actually do about each
 * failure class; unknown errors preserve the original message.
 */
export function bindFailureMessage(err, { port, host }) {
  const code = err && err.code
  const address = `http://${displayHost(host)}:${port}`
  if (code === "EADDRINUSE") {
    return [
      `✖ could not bind ${address} — address already in use (EADDRINUSE)`,
      ``,
      `  Most likely cause: the DESKTOP app is running and already owns this port`,
      `  (the desktop's built-in REST API binds :19828 while the app is open).`,
      ``,
      `  Run the web server on a different port and open that URL in the browser:`,
      `    LLM_WIKI_PORT=${port + 1} npm start`,
      ``,
      `  If MCP / agent tools point at this server, update them to the new base URL:`,
      `    LLM_WIKI_API_BASE_URL=http://127.0.0.1:${port + 1}`,
    ].join("\n")
  }
  if (code === "EACCES") {
    return [
      `✖ could not bind ${address} — permission denied (EACCES)`,
      ``,
      `  Ports below 1024 need elevated privileges. Pick a port above 1024:`,
      `    LLM_WIKI_PORT=${port > 1024 ? port + 1 : "19828"} npm start`,
    ].join("\n")
  }
  if (code === "EADDRNOTAVAIL") {
    return [
      `✖ could not bind ${address} — address not available (EADDRNOTAVAIL)`,
      ``,
      `  The bind host is not usable on this machine. Set LLM_WIKI_HOST to an`,
      `  address that exists (e.g. 127.0.0.1, 0.0.0.0, or the machine's LAN IP).`,
    ].join("\n")
  }
  return `✖ could not bind ${address} — ${err && err.message ? err.message : String(err)}`
}

/**
 * Print the diagnosis and exit(1). Idempotent: the same bind error can be
 * delivered more than once (Express 5 can surface it via the listen callback
 * AND the http.Server 'error' event), and the diagnosis must be printed EXACTLY
 * once. Uses fs.writeSync so the message survives the immediate process.exit
 * (async stream flushes are not guaranteed to drain before exit).
 */
export function exitOnBindFailure(err, ctx) {
  if (exited) return
  exited = true
  fs.writeSync(2, `\n${bindFailureMessage(err, ctx)}\n\n`)
  process.exit(1)
}
