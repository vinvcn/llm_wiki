import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const listeners: Record<string, (event: { payload?: unknown }) => void> = {}
  return {
    listen: vi.fn(async (event: string, cb: (event: { payload?: unknown }) => void) => {
      listeners[event] = cb
      return vi.fn(() => {
        delete listeners[event]
      })
    }),
    emit: (event: string, payload?: unknown) => listeners[event]?.({ payload }),
    refreshProjectFileTree: vi.fn(async () => undefined),
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => undefined),
    createDirectory: vi.fn(async () => undefined),
    listDirectory: vi.fn(async () => []),
  }
})

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}))

vi.mock("@/lib/project-file-tree-refresh", () => ({
  refreshProjectFileTree: mocks.refreshProjectFileTree,
}))

vi.mock("@/commands/fs", () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  createDirectory: mocks.createDirectory,
  listDirectory: mocks.listDirectory,
}))

import { subscribeExternalProjectChanges } from "./external-project-changes"
import { useWikiStore } from "@/stores/wiki-store"
import { useReviewStore } from "@/stores/review-store"
import type { ReviewItem } from "@/stores/review-store"

const PROJECT_ID = "proj-1"
const PROJECT_PATH = "/tmp/wiki-project"

const EXTERNAL_ITEMS: ReviewItem[] = [
  {
    id: "review-ext",
    type: "suggestion",
    title: "External review",
    description: "Written by the other client",
    options: [],
    resolved: false,
    createdAt: 1785900000000,
  },
]

async function waitFor(fn: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error("timed out waiting for condition")
}

beforeEach(() => {
  mocks.readFile.mockReset()
  mocks.readFile.mockResolvedValue("")
  mocks.refreshProjectFileTree.mockClear()
  useWikiStore.setState({
    project: { id: PROJECT_ID, name: "Wiki Project", path: PROJECT_PATH },
  })
  useReviewStore.setState({ items: [] })
})

describe("subscribeExternalProjectChanges — live review sync (issue #13 item 3)", () => {
  it("reloads review items when the payload includes .llm-wiki/review.json", async () => {
    useReviewStore.setState({
      items: [{ id: "old", type: "confirm", title: "Stale", description: "d",
        options: [], resolved: false, createdAt: 1 }],
    })
    mocks.readFile.mockResolvedValue(JSON.stringify(EXTERNAL_ITEMS))

    await subscribeExternalProjectChanges()
    mocks.emit("project://files-changed", {
      projectId: PROJECT_ID,
      paths: [".llm-wiki/review.json", "wiki/other.md"],
    })

    // ids are content-stable (normalizeReviewItems remaps them on load), so
    // assert on the title: the on-disk state replaced the stale item.
    await waitFor(() => useReviewStore.getState().items.some((i) => i.title === "External review"))
    expect(useReviewStore.getState().items.map((i) => i.title)).toEqual(["External review"])
    // readFile was asked for the project-relative review state path.
    expect(mocks.readFile).toHaveBeenCalledWith(`${PROJECT_PATH}/.llm-wiki/review.json`)
  })

  it("does NOT touch the review store for events without the review state path", async () => {
    useReviewStore.setState({
      items: [{ id: "keep", type: "confirm", title: "Keep", description: "d",
        options: [], resolved: false, createdAt: 1 }],
    })
    await subscribeExternalProjectChanges()
    mocks.emit("project://files-changed", { projectId: PROJECT_ID, paths: ["wiki/a.md"] })

    await new Promise((r) => setTimeout(r, 50))
    expect(useReviewStore.getState().items.map((i) => i.id)).toEqual(["keep"])
    expect(mocks.readFile).not.toHaveBeenCalled()
  })

  it("ignores events for a different project", async () => {
    useReviewStore.setState({
      items: [{ id: "keep", type: "confirm", title: "Keep", description: "d",
        options: [], resolved: false, createdAt: 1 }],
    })
    mocks.readFile.mockResolvedValue(JSON.stringify(EXTERNAL_ITEMS))
    await subscribeExternalProjectChanges()
    mocks.emit("project://files-changed", {
      projectId: "other-project",
      paths: [".llm-wiki/review.json"],
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(useReviewStore.getState().items.map((i) => i.id)).toEqual(["keep"])
  })

  it("still refreshes the file tree on the event (existing behavior)", async () => {
    await subscribeExternalProjectChanges()
    mocks.emit("project://files-changed", { projectId: PROJECT_ID, paths: ["wiki/index.md"] })
    await new Promise((r) => setTimeout(r, 50))
    expect(mocks.refreshProjectFileTree).toHaveBeenCalled()
  })
})
