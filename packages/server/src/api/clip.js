// Clip API router (issue #40: browser clipper onto /api/v2).
//
// The browser clipper previously talked to the separate clip companion on
// :19827 (clip-server.js / clip_server.rs, bare routes /clip and /projects).
// After the thin-client migration it talks to the main v2 API on the same
// origin/port as the SPA (index-v2.js), so remote/Docker deployments work
// with a single origin. This router exposes POST /api/v2/projects/:id/clip
// — write a clipped page to raw/sources/<slug>-<date>.md and enqueue ingest.
//
// The file-naming and frontmatter match the clip-server byte-for-byte (slug
// 50 chars, lowercased alphanumeric/space/dash → dash-joined, date compact
// YYYYMMDD, unique via -2, -3, …, frontmatter type: clip, origin: web-clip).

import { Router } from "express"
import fs from "node:fs"
import path from "node:path"
import { validate } from "../middleware/validate.js"
import { ClipRequestSchema } from "@llm-wiki/api-types"
import { enqueueIngestTask } from "../store/ingest-queue.js"
import { kickIngestOrchestrator } from "../ingest/orchestrator.js"
import { emit } from "../events.js"
import { EventTypes } from "../events/bus.js"

const router = Router({ mergeParams: true })

function slugify(title) {
  const raw = [...String(title)]
    .map((c) => (/^[\p{L}\p{N}]$/u.test(c) || c === " " || c === "-" ? c : " "))
    .join("")
  const joined = raw.trim().split(/\s+/).filter(Boolean).join("-").toLowerCase()
  return [...joined].slice(0, 50).join("")
}

function localDateParts() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, "0")
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    dateCompact: `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
  }
}

// POST /api/v2/projects/:id/clip
router.post("/", validate({ body: ClipRequestSchema }), async (req, res, next) => {
  try {
    const { title, url, content } = req.validated.body

    const { date, dateCompact } = localDateParts()
    const slug = slugify(title)
    const baseName = `${slug}-${dateCompact}`
    const dirPath = path.join(req.projectRoot, "raw", "sources")

    try {
      fs.mkdirSync(dirPath, { recursive: true })
    } catch (e) {
      throw new Error(`Failed to create directory: ${e.message}`)
    }

    let filePath = path.join(dirPath, `${baseName}.md`)
    let counter = 2
    while (fs.existsSync(filePath)) {
      filePath = path.join(dirPath, `${baseName}-${counter}.md`)
      counter += 1
    }

    const esc = (s) => s.replace(/"/g, '\\"')
    const markdown =
      `---\ntype: clip\ntitle: "${esc(title)}"\nurl: "${esc(url)}"\nclipped: ${date}\n` +
      `origin: web-clip\nsources: []\ntags: [web-clip]\n---\n\n# ${title}\n\nSource: ${url}\n\n${content}\n`

    try {
      fs.writeFileSync(filePath, markdown, "utf-8")
    } catch (e) {
      throw new Error(`Failed to write file: ${e.message}`)
    }

    const relativePath = path.relative(req.projectRoot, filePath).split(path.sep).join("/")
    const size = Buffer.byteLength(markdown, "utf-8")

    // Emit file:created for the raw source (mirrors ingest upload route).
    emit(EventTypes.FILE_CREATED, {
      projectId: req.projectId,
      path: relativePath,
      size,
    })

    // Enqueue for ingest (dedup is not needed: clip filenames are unique via
    // date+slug+counter, but findLive check is cheap and safe).
    const taskId = enqueueIngestTask(req.project.id, filePath)
    emit("ingest:queued", {
      projectId: req.project.id,
      taskId,
      filePath,
      fileName: path.basename(filePath),
    })
    try {
      kickIngestOrchestrator()
    } catch { /* orchestrator may not be started in tests */ }

    res.status(201).json({ path: relativePath, size, taskId })
  } catch (err) {
    next(err)
  }
})

export default router
