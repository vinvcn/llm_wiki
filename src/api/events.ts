// SSE event stream — GET /api/v2/events
//
// The server broadcasts every event as a default `message` carrying a JSON
// envelope `{ event, payload }` (see packages/server/src/api/events.js). This
// module wraps EventSource with JSON parsing, token auth (via query param,
// since EventSource cannot set headers), and auto-reconnect with backoff.
//
// ONE shared connection, not one per caller. Every `connectEvents` caller
// (the global sse-sync dispatcher plus each mounted DropZone in the Sources
// view) subscribes to the same EventSource; the stream opens with the first
// listener and closes only when the LAST listener disconnects. Besides
// avoiding duplicate streams to the same endpoint, this removes the
// `GET /api/v2/events net::ERR_ABORTED` failed request the browser logged
// whenever a per-view connection was closed on unmount (Sources view mount
// → unmount) — the Sources view now rides the global stream.

import { getBaseUrl, getToken } from "./client"

/** A parsed server-sent event envelope. */
export interface ServerEvent {
  event: string
  payload: unknown
}

export type EventListener = (evt: ServerEvent) => void

export interface ConnectOptions {
  onError?: (err: Event) => void
  onOpen?: () => void
  /** Max reconnect delay in ms (default 30000). */
  maxBackoff?: number
}

interface SharedListener {
  onEvent: EventListener
  onOpen?: () => void
  onError?: (err: Event) => void
  maxBackoff: number
}

/** Active listeners. A listener is removed the first time its disconnect()
 *  runs (guarded by the closed flag — double-disconnect is a no-op). */
const listeners = new Set<SharedListener>()
let sharedSource: EventSource | null = null
let sharedAttempts = 0
let sharedTimer: ReturnType<typeof setTimeout> | null = null

const DEFAULT_MAX_BACKOFF = 30_000

function sharedMaxBackoff(): number {
  let max = DEFAULT_MAX_BACKOFF
  for (const l of listeners) max = Math.max(max, l.maxBackoff)
  return max
}

/** Open the shared stream if no connection or pending reconnect exists. */
function ensureSharedOpen(): void {
  if (sharedSource || sharedTimer || listeners.size === 0) return
  const es = new EventSource(buildEventsUrl())
  sharedSource = es

  es.onopen = () => {
    sharedAttempts = 0
    for (const l of listeners) {
      try { l.onOpen?.() } catch { /* a listener must not break the stream */ }
    }
  }

  es.onmessage = (msg: MessageEvent) => {
    const parsed = tryParse(msg.data)
    if (!parsed) return
    for (const l of listeners) {
      try { l.onEvent(parsed) } catch { /* per-listener isolation */ }
    }
  }

  es.onerror = (err: Event) => {
    for (const l of listeners) {
      try { l.onError?.(err) } catch { /* a listener must not break the stream */ }
    }
    es.close()
    sharedSource = null
    scheduleSharedReconnect()
  }
}

/** Backoff reconnect while at least one listener remains. */
function scheduleSharedReconnect(): void {
  if (sharedTimer || listeners.size === 0) return
  // Exponential backoff: 1s, 2s, 4s, … capped at the largest maxBackoff.
  const delay = Math.min(1000 * 2 ** sharedAttempts, sharedMaxBackoff())
  sharedAttempts += 1
  sharedTimer = setTimeout(() => {
    sharedTimer = null
    ensureSharedOpen()
  }, delay)
}

/** Close the shared stream once the last listener disconnects. */
function maybeCloseShared(): void {
  if (listeners.size > 0) return
  if (sharedTimer !== null) {
    clearTimeout(sharedTimer)
    sharedTimer = null
  }
  if (sharedSource) {
    sharedSource.close()
    sharedSource = null
  }
}

/**
 * Subscribe to the shared SSE stream. Invokes `onEvent` for every parsed
 * envelope until the returned `disconnect()` runs (double-disconnect is a
 * no-op). The underlying EventSource is shared with every other subscriber:
 * it opens with the first listener and closes when the last one leaves.
 */
export function connectEvents(onEvent: EventListener, opts: ConnectOptions = {}): () => void {
  const listener: SharedListener = {
    onEvent,
    onOpen: opts.onOpen,
    onError: opts.onError,
    maxBackoff: opts.maxBackoff ?? DEFAULT_MAX_BACKOFF,
  }
  listeners.add(listener)
  ensureSharedOpen()

  let closed = false
  return () => {
    if (closed) return
    closed = true
    listeners.delete(listener)
    maybeCloseShared()
  }
}

function buildEventsUrl(): string {
  const base = `${getBaseUrl()}/api/v2/events`
  const token = getToken()
  // EventSource cannot set Authorization headers; pass the token as a query
  // param when auth is present. The server accepts ?token= for SSE.
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

function tryParse(data: string): ServerEvent | null {
  try {
    const parsed = JSON.parse(data) as Partial<ServerEvent>
    if (parsed && typeof parsed === "object" && typeof parsed.event === "string") {
      return { event: parsed.event, payload: parsed.payload ?? null }
    }
    return null
  } catch {
    return null
  }
}
