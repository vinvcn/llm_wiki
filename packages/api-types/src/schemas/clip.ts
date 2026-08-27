// Zod schemas for the browser clipper (issue #40).
//
// The clipper previously talked to the separate clip companion on :19827
// (clip-server.js / clip_server.rs). After the thin-client migration it
// talks to the main v2 API on the same origin/port as the SPA (index-v2.js),
// so remote/Docker deployments work with a single origin.

import { z } from "zod"

export const ClipRequestSchema = z.object({
  title: z.string().min(1),
  url: z.string().min(1),
  content: z.string().min(1),
})

export const ClipResponseSchema = z.object({
  path: z.string(),
  size: z.number().int().min(0),
  taskId: z.number().int().optional(),
})

export type ClipRequest = z.infer<typeof ClipRequestSchema>
export type ClipResponse = z.infer<typeof ClipResponseSchema>
