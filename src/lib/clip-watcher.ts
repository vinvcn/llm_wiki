import { useWikiStore } from "@/stores/wiki-store"
import { useServerIngestStore } from "@/stores/server-ingest-store"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { refreshProjectFileTree } from "@/lib/project-file-tree-refresh"
import { getRelativePath } from "@/lib/path-utils"
import { clipServerStatus } from "@/commands/fs"

const POLL_INTERVAL = 3000 // Check every 3 seconds
let intervalId: ReturnType<typeof setInterval> | null = null

/**
 * Start polling the clip server for new web clips.
 * When a clip is detected, triggers auto-ingest and refreshes the file tree.
 *
 * The clip server is the Chrome-extension companion on :19827. The desktop
 * app always spawns it; in the browser web build the BACKEND server hosts the
 * same protocol (packages/server/src/clip-server.js), so web users get clips
 * too. In the web build we first wait for the companion to report
 * "running" (we own the port) or "port_conflict" (the desktop app owns it —
 * something still speaks the protocol) before polling, so a server without
 * the listener produces no connection-refused noise.
 */
export function startClipWatcher() {
  if (intervalId) return // Already running
  const isWeb = Boolean((globalThis as { __LLM_WIKI_WEB__?: boolean }).__LLM_WIKI_WEB__)
  let armed = !isWeb // desktop: poll unconditionally (companion starts with the app)

  intervalId = setInterval(async () => {
    if (!armed) {
      try {
        const status = await clipServerStatus()
        if (status === "running" || status === "port_conflict") {
          armed = true
        } else if (status !== "starting") {
          stopClipWatcher() // "error" or anything else: give up quietly
          return
        }
      } catch {
        // Server not reachable yet — retry next tick
      }
      if (!armed) return
    }

    try {
      const res = await fetch("http://127.0.0.1:19827/clips/pending", { method: "GET" })
      const data = await res.json()

      if (!data.ok || !data.clips || data.clips.length === 0) return

      const store = useWikiStore.getState()
      const project = store.project

      for (const clip of data.clips) {
        const clipProjectPath: string = clip.projectPath
        const clipFilePath: string = clip.filePath

        // Refresh file tree if clip is for current project
        if (project && clipProjectPath === project.path) {
          await refreshProjectFileTree(project.path, { projectId: project.id })

          // Enqueue (not auto-ingest directly) so the task lands in the
          // server's persisted ingest queue, shows up in the activity panel,
          // and survives a UI refresh. Server-side ingest owns the run
          // (issue #14 P0 stage 9); the enqueue-by-path route takes a
          // project-relative path.
          if (hasUsableLlm(store.llmConfig)) {
            void useServerIngestStore.getState().enqueue(getRelativePath(clipFilePath, project.path))
          }
        }
      }
    } catch {
      // Server not running or network error — silently ignore
    }
  }, POLL_INTERVAL)
}

export function stopClipWatcher() {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}
