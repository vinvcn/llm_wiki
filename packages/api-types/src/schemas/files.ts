import { z } from "zod"

export const FileTreeQuerySchema = z.object({
  path: z.string().optional().default(""),
  includeHidden: z.coerce.boolean().optional().default(false),
  maxDepth: z.coerce.number().int().min(1).max(30).optional().default(30),
})

export const FileContentQuerySchema = z.object({
  path: z.string().min(1),
})

export const FileUploadBodySchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(["utf-8", "base64"]).optional().default("utf-8"),
})

export const FileDownloadQuerySchema = z.object({
  path: z.string().min(1),
})

export const FileRawQuerySchema = z.object({
  path: z.string().min(1),
})

// ── MCP file listing (issue #40: thin-client, replaces /api/v1 files) ───────
// The MCP server previously hit GET /api/v1/projects/:id/files?root=&recursive&
// maxFiles= which listed the public wiki/sources trees. The v2 tree endpoint
// (GET /files/tree) is the SPA's view-driven API (absolute paths, depth
// limited). This endpoint preserves the MCP-friendly shape (project-relative
// paths, root/sources/all, truncation) under v2 so the MCP client can be a
// native v2 client without a v1 shim.

export const FileListQuerySchema = z.object({
  root: z.enum(["wiki", "sources", "all"]).optional().default("wiki"),
  recursive: z.coerce.boolean().optional().default(true),
  maxFiles: z.coerce.number().int().min(1).max(50000).optional().default(5000),
})

export const FileNodeSchema: z.ZodType<{ name: string; path: string; isDir: boolean; children?: Array<{ name: string; path: string; isDir: boolean; children?: unknown }> }> = z.object({
  name: z.string(),
  path: z.string(),
  isDir: z.boolean(),
  children: z.array(z.lazy(() => FileNodeSchema)).optional(),
})

export const FileListResponseSchema = z.object({
  files: z.array(FileNodeSchema),
  truncated: z.boolean(),
})

// ── Chunked upload protocol (issue #14 P2, Decision 15, §4.8) ─────────────
// Large files (>10MB) take the charter's chunked protocol under the files
// router: init → per-chunk octet-stream PUTs → complete. Charter shapes are
// kept verbatim ({uploadId}, {received}, {path, size}).

export const ChunkedUploadInitBodySchema = z.object({
  fileName: z.string().min(1),
  fileSize: z.number().int().positive(),
  destPath: z.string().min(1),
})

export const ChunkedUploadInitResponseSchema = z.object({
  uploadId: z.string(),
})

export const ChunkedUploadChunkQuerySchema = z.object({
  offset: z.coerce.number().int().min(0),
})

export const ChunkedUploadChunkResponseSchema = z.object({
  received: z.number().int().min(0),
})

export const ChunkedUploadCompleteResponseSchema = z.object({
  path: z.string(),
  size: z.number().int().min(0),
})

export type FileTreeQuery = z.infer<typeof FileTreeQuerySchema>
export type FileContentQuery = z.infer<typeof FileContentQuerySchema>
export type FileUploadBody = z.infer<typeof FileUploadBodySchema>
export type FileDownloadQuery = z.infer<typeof FileDownloadQuerySchema>
export type FileRawQuery = z.infer<typeof FileRawQuerySchema>
export type FileListQuery = z.infer<typeof FileListQuerySchema>
export type FileListResponse = z.infer<typeof FileListResponseSchema>
export type ChunkedUploadInitBody = z.infer<typeof ChunkedUploadInitBodySchema>
export type ChunkedUploadInitResponse = z.infer<typeof ChunkedUploadInitResponseSchema>
export type ChunkedUploadChunkQuery = z.infer<typeof ChunkedUploadChunkQuerySchema>
export type ChunkedUploadChunkResponse = z.infer<typeof ChunkedUploadChunkResponseSchema>
export type ChunkedUploadCompleteResponse = z.infer<typeof ChunkedUploadCompleteResponseSchema>
