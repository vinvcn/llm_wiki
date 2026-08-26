// Raw file streaming for the web client (GET /api/raw?path=<abs>).
//
// Faithful port of the legacy server's streamRawFile (packages/server/src/
// index.js) — same MIME map, same headers, same 400/404 semantics. The web
// client's `convertFileSrc` shim (src/web/core.ts → src/web/http-api.ts
// rawFileUrl) points <img>/<audio>/<video>/<a> tags at this endpoint, so
// wiki-page images, file previews, and the opener's browser-tab fallback all
// render through it. Without it the shipped web build shows broken images on
// any page that references project files (e.g. the media written by the
// embedded-image extraction pipeline).

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

// Same table as the legacy server's static/raw handler.
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".map": "application/json", ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".pdf": "application/pdf",
  ".wasm": "application/wasm",
}

/**
 * Express handler: stream the file at `?path=` with the legacy semantics.
 *   - empty path or path containing NUL → 400 "Bad path"
 *   - missing file                      → 404 "Not found"
 *   - directory                         → 400 "Is a directory"
 *   - otherwise                         → 200, correct Content-Type/Length,
 *                                         CORS open, private 1h cache.
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
export async function streamRawFile(req, res) {
  const rawPath = typeof req.query.path === "string" ? req.query.path : ""
  if (!rawPath || rawPath.includes("\0")) { res.status(400).type("txt").send("Bad path"); return }
  let stat
  try { stat = await fsp.stat(rawPath) } catch { res.status(404).type("txt").send("Not found"); return }
  if (stat.isDirectory()) { res.status(400).type("txt").send("Is a directory"); return }
  const ext = path.extname(rawPath).toLowerCase()
  res.status(200).set({
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": String(stat.size),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "private, max-age=3600",
  })
  fs.createReadStream(rawPath).pipe(res)
}
