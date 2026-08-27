// Sources API router (issue #40: MCP rescan onto /api/v2).
//
// The MCP rescan tool previously hit POST /api/v1/projects/:id/sources/rescan
// (handleApiV1 → fileSyncCommands.rescan_project_files). The v2 surface
// exposes the same capability under /api/v2/projects/:id/sources/rescan so
// the MCP client can trigger a source-folder rescan against a remote/Docker
// deployment (which never mounted /api/v1).

import { Router } from "express"
import { RescanResponseSchema } from "@llm-wiki/api-types"
import { fileSyncCommands } from "../commands/fileSync.js"

const router = Router({ mergeParams: true })

// POST /api/v2/projects/:id/sources/rescan
router.post("/rescan", async (req, res, next) => {
  try {
    const r = await fileSyncCommands.rescan_project_files({
      projectId: req.projectId,
      projectPath: req.projectRoot,
    })
    const changed = Array.isArray(r?.changedTasks) ? r.changedTasks.length : 0
    const queueVersion = typeof r?.queue?.version === "number" ? r.queue.version : 0
    // Validate shape via Zod (SSOT) before responding.
    const body = RescanResponseSchema.parse({ changed, queueVersion })
    res.json(body)
  } catch (err) {
    next(err)
  }
})

export default router
