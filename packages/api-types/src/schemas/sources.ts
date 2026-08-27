// Zod schemas for source watching / rescan (issue #40).
//
// The MCP rescan tool previously hit POST /api/v1/projects/:id/sources/rescan
// (handleApiV1 → fileSyncCommands.rescan_project_files). The v2 surface
// exposes the same capability under /api/v2/projects/:id/sources/rescan.

import { z } from "zod"

export const RescanResponseSchema = z.object({
  changed: z.number().int().min(0),
  queueVersion: z.number().int().min(0),
})

export type RescanResponse = z.infer<typeof RescanResponseSchema>
