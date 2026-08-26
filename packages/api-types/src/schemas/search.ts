import { z } from "zod"

/** Global retrieval mode (app-state.json key `wikiSearchMode`). */
export const WikiSearchModeSchema = z.enum(["keyword", "vector", "hybrid"])
export type WikiSearchMode = z.infer<typeof WikiSearchModeSchema>

export const SearchRequestSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().min(1).max(100).optional().default(20),
  includeContent: z.boolean().optional().default(false),
})

/** A markdown image reference rendered in a search hit (server `extractImages`). */
export const SearchResultImageSchema = z.object({
  url: z.string(),
  alt: z.string(),
})
export type SearchResultImage = z.infer<typeof SearchResultImageSchema>

// Issue #38: this schema must describe the LIVE payload from the
// `search_project` command (packages/server/src/commands/search.js) exactly.
// Both search legs emit `{ path, title, snippet, titleMatch, score, images }
// (+ content when includeContent)`, and RRF blending adds `vectorScore` to
// every vector-ranked row — if a field is missing here, zod's default object
// parse silently strips it and z.infer omits it at the type level too.
export const SearchResultSchema = z.object({
  path: z.string(),
  title: z.string(),
  score: z.number(),
  snippet: z.string().optional(),
  titleMatch: z.boolean(),
  images: z.array(SearchResultImageSchema),
  vectorScore: z.number().optional(),
  content: z.string().optional(),
})

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  mode: z.string(),
  tokenHits: z.number(),
  vectorHits: z.number(),
  graphHits: z.number(),
  // Present when a vector leg was requested (vector/hybrid mode) but could
  // not run — no embedding provider, sqlite-vec unavailable, embed request
  // failed. The response still succeeds, degraded to keyword results.
  vectorUnavailableReason: z.string().optional(),
})

export type SearchRequest = z.infer<typeof SearchRequestSchema>
export type SearchResult = z.infer<typeof SearchResultSchema>
export type SearchResponse = z.infer<typeof SearchResponseSchema>
