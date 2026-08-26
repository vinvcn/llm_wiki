// connectEvents shares ONE SSE connection across every subscriber.
//
// Regression: each DropZone instance (Sources view) used to open its own
// EventSource to /api/v2/events and close it on unmount — every Sources-view
// visit logged `GET /api/v2/events net::ERR_ABORTED` (browser aborts the
// in-flight request when EventSource.close() runs). Listeners must now ride
// the same global stream: the connection opens with the first subscriber,
// closes only when the last one disconnects, and reconnects (backoff) while
// any subscriber remains.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Minimal EventSource stand-in: records every opened connection so tests can
// assert sharing, drive open/message/error, and observe close().
class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  onopen: (() => void) | null = null
  onmessage: ((msg: { data: string }) => void) | null = null
  onerror: ((err: Event) => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  close(): void {
    this.closed = true
  }

  emitOpen(): void {
    this.onopen?.()
  }

  emitMessage(event: string, payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ event, payload }) })
  }

  emitError(): void {
    this.onerror?.(new Event("error"))
  }
}

type EventsModule = typeof import("@/api/events")

let mod: EventsModule

beforeEach(async () => {
  vi.resetModules()
  vi.useRealTimers()
  FakeEventSource.instances = []
  vi.stubGlobal("EventSource", FakeEventSource)
  mod = await import("@/api/events")
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("connectEvents shared stream", () => {
  it("opens ONE EventSource for multiple subscribers", () => {
    const a = vi.fn()
    const b = vi.fn()
    const disconnectA = mod.connectEvents(a)
    const disconnectB = mod.connectEvents(b)

    expect(FakeEventSource.instances).toHaveLength(1)
    FakeEventSource.instances[0].emitMessage("ingest:progress", { projectId: 1 })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    disconnectA()
    disconnectB()
  })

  it("disconnecting one subscriber keeps the shared stream open", () => {
    const a = vi.fn()
    const b = vi.fn()
    const disconnectA = mod.connectEvents(a)
    mod.connectEvents(b)
    const shared = FakeEventSource.instances[0]

    disconnectA()
    expect(shared.closed).toBe(false)
    shared.emitMessage("ingest:complete", { taskId: 7 })
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })

  it("closes the stream only when the LAST subscriber disconnects", () => {
    const disconnectA = mod.connectEvents(() => {})
    const disconnectB = mod.connectEvents(() => {})
    const shared = FakeEventSource.instances[0]

    disconnectA()
    expect(shared.closed).toBe(false)
    disconnectB()
    expect(shared.closed).toBe(true)
  })

  it("fires onOpen for every subscriber when the stream opens", () => {
    const openA = vi.fn()
    const openB = vi.fn()
    mod.connectEvents(() => {}, { onOpen: openA })
    mod.connectEvents(() => {}, { onOpen: openB })

    FakeEventSource.instances[0].emitOpen()
    expect(openA).toHaveBeenCalledTimes(1)
    expect(openB).toHaveBeenCalledTimes(1)
  })

  it("reconnects with backoff while subscribers remain", () => {
    vi.useFakeTimers()
    const errA = vi.fn()
    const errB = vi.fn()
    const disconnectA = mod.connectEvents(() => {}, { onError: errA })
    mod.connectEvents(() => {}, { onError: errB })

    FakeEventSource.instances[0].emitError()
    expect(errA).toHaveBeenCalledTimes(1)
    expect(errB).toHaveBeenCalledTimes(1)
    expect(FakeEventSource.instances[0].closed).toBe(true)

    vi.advanceTimersByTime(1000)
    expect(FakeEventSource.instances).toHaveLength(2)

    disconnectA()
  })

  it("cancels the pending reconnect when the last subscriber leaves", () => {
    vi.useFakeTimers()
    const disconnectA = mod.connectEvents(() => {})
    const disconnectB = mod.connectEvents(() => {})

    FakeEventSource.instances[0].emitError()
    // All subscribers disconnect before the 1s backoff elapses.
    disconnectA()
    disconnectB()
    // The second disconnect is the last one: closes the stream + cancels
    // the timer, so no reconnection is attempted.
    vi.advanceTimersByTime(5000)
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it("double-disconnect is a no-op", () => {
    const disconnectA = mod.connectEvents(() => {})
    const disconnectB = mod.connectEvents(() => {})
    const shared = FakeEventSource.instances[0]

    disconnectA()
    disconnectA()
    expect(shared.closed).toBe(false)
    disconnectB()
    expect(shared.closed).toBe(true)
  })

  it("an exceptions thrown by one listener do not break dispatch to others", () => {
    const bad = vi.fn(() => {
      throw new Error("listener blew up")
    })
    const good = vi.fn()
    mod.connectEvents(bad)
    mod.connectEvents(good)

    FakeEventSource.instances[0].emitMessage("ping", { n: 1 })
    expect(good).toHaveBeenCalledTimes(1)
    expect(bad).toHaveBeenCalledTimes(1)
  })
})
