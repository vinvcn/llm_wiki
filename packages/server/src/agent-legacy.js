// Faithful port of the desktop agent's OFFLINE contract: the branch of
// runtime.rs `run_once_with_cancel_and_events` that runs when the resolved
// LLM config is NOT usable for backend HTTP (missing API key or model, or a
// CLI-only provider such as claude-code/codex-cli). The desktop never calls
// an LLM in that case and never surfaces a provider/network error: it runs a
// deterministic router + retrieval pipeline and returns the retrieval summary
// as the assistant message (ok:true). This module reproduces that branch 1:1
// (with an empty model plan, the only possibility offline) so the web agent
// degrades exactly like the desktop for the same shared-store config — most
// visibly on a fresh install where no provider key is configured yet.
//
// Desktop sources ported here:
//   - src-tauri/src/agent/router.rs            route_query
//   - src-tauri/src/agent/runtime.rs           legacy retrieval branch,
//                                              should_plan_tools_with_model,
//                                              should_fallback_wiki_search,
//                                              build_retrieval_answer,
//                                              is_shell_command_approved
//   - src-tauri/src/agent/context.rs           collapse_whitespace
//   - src-tauri/src/agent/tools.rs             read_wiki_page, run_shell_exec

import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { searchCommands } from "./commands/search.js"
import { runTool } from "./agent-tools.js"
import { isSkillPreferenceProbeCommand, skippedSkillPreferenceProbeSummary } from "./shell-policy.js"

export const DEFAULT_CHAT_SEARCH_RESULTS = 5
export const MAX_CHAT_SEARCH_RESULTS = 10

const MAX_READ_PAGE_BYTES = 2 * 1024 * 1024
const SHELL_EXEC_TIMEOUT_SECS = 30
const MAX_SHELL_COMMAND_CHARS = 4000
const MAX_SHELL_OUTPUT_CHARS = 20000

const errText = (e) => (e instanceof Error ? e.message : String(e))
const containsAny = (value, needles) => needles.some((n) => value.includes(n))

export const collapseWhitespace = (value) => String(value).split(/\s+/).filter(Boolean).join(" ")

// Port of router.rs route_query. Intent classification is intentionally
// conservative: it never turns wiki retrieval on from message shape; tool
// execution is decided by the model planner (unavailable offline) with the
// runtime fallback applied by the caller.
export function routeQuery(message, mode, tools) {
  const lower = message.toLowerCase()
  const trimmed = message.trim()
  const explicitWeb = containsAny(lower, [
    "web search", "search the web", "internet", "online", "latest", "today",
    "新闻", "联网", "网上", "最新",
  ])
  const explicitRaw = containsAny(lower, ["raw source", "source file", "原始资料", "原始文件", "源文件"])
  const explicitGraph = containsAny(lower, ["graph", "relationship", "知识图谱", "关系图"])
  const explicitWrite = containsAny(lower, ["write to wiki", "create page", "写入", "创建页面"])
  const conversational = trimmed.length < 32
    && containsAny(lower, ["hi", "hello", "thanks", "谢谢", "你好", "好的", "ok"])

  const intent = explicitWrite ? "write"
    : explicitGraph ? "graph"
    : explicitRaw ? "raw_source_search"
    : explicitWeb ? "external_search"
    : conversational ? "conversation"
    : "ambiguous"

  return {
    intent,
    shouldSearchWiki: false,
    shouldHintWeb: tools.web,
    shouldHintAnytxt: tools.anytxt,
    shouldIncludeSources: explicitRaw || mode === "deep",
    rationale: intent === "external_search"
      ? "User appears to request current/external information."
      : intent === "conversation"
        ? "Short conversational turn; avoid unnecessary retrieval."
        : intent === "raw_source_search"
          ? "User explicitly referenced raw/source material."
          : intent === "graph"
            ? "User asks about graph/relationships."
            : intent === "write"
              ? "User asks to create or update wiki content."
              : "Ambiguous request; let the tool planner decide whether retrieval is useful.",
  }
}

// runtime.rs should_plan_tools_with_model.
export function shouldPlanToolsWithModel(message, mode, tools, skillsEnabled) {
  if (mode === "fast") return false
  const hasAvailableTool = tools.wiki || tools.web || tools.anytxt || skillsEnabled
  return message.trim() !== "" && hasAvailableTool
}

// runtime.rs build_retrieval_answer.
export function buildRetrievalAnswer(query, references) {
  if (!references.length) {
    return `I searched the current LLM Wiki project for "${query}" but did not find matching wiki pages.`
  }
  let out = `I searched the current LLM Wiki project for "${query}" and found ${references.length} relevant page(s):`
  references.slice(0, MAX_CHAT_SEARCH_RESULTS).forEach((reference, idx) => {
    out += `\n${idx + 1}. ${reference.title} (${reference.path})`
    if (reference.snippet != null) out += `\n   ${collapseWhitespace(reference.snippet)}`
  })
  return out
}

// tools.rs read_wiki_page (guard + size cap; raw content otherwise).
function readWikiPage(projectPath, relPath) {
  const rel = String(relPath ?? "").replace(/\\/g, "/").replace(/^\/+/, "")
  if (rel.includes("..") || !rel.toLowerCase().startsWith("wiki/")) {
    throw new Error("wiki.read_page path must stay under wiki/")
  }
  const p = path.join(projectPath, rel)
  const st = fs.statSync(p)
  if (!st.isFile()) throw new Error("wiki.read_page path is not a file")
  if (st.size > MAX_READ_PAGE_BYTES) throw new Error("wiki.read_page file is too large")
  return fs.readFileSync(p, "utf-8")
}

function limitChars(s, max) {
  const arr = [...String(s)]
  return arr.length > max ? arr.slice(0, max).join("") + "…" : String(s)
}

// tools.rs run_shell_exec: /bin/sh -c <cmd>, cwd = agent-workspace, minimized
// env (env_clear + keep-list), 30s timeout, bounded stdout/stderr. Only
// reachable offline via an EXACT user-approved command (same trust boundary
// as the desktop legacy branch — request.approvedShellCommands).
async function runShellExec(projectPath, command, timeoutSecs) {
  const cmd = String(command).trim()
  if (!cmd) throw new Error("shell.exec command is empty")
  if ([...cmd].length > MAX_SHELL_COMMAND_CHARS) throw new Error("shell.exec command is too long")
  let isDir = false
  try { isDir = fs.statSync(projectPath).isDirectory() } catch { /* below */ }
  if (!isDir) throw new Error("shell.exec project directory is not available")
  const workspace = path.join(projectPath, "agent-workspace")
  fs.mkdirSync(workspace, { recursive: true })
  const KEEP = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]
  const env = {}
  for (const k of KEEP) if (process.env[k] !== undefined) env[k] = process.env[k]
  const out = await new Promise((resolve) => {
    let child
    try { child = spawn("/bin/sh", ["-c", cmd], { cwd: workspace, env }) }
    catch (e) { resolve({ error: `shell.exec failed to start: ${e.message}` }); return }
    let stdout = "", stderr = "", settled = false, timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL") } catch { /* already gone */ } }, timeoutSecs * 1000)
    timer.unref?.()
    child.stdout?.on("data", (d) => { stdout += d.toString() })
    child.stderr?.on("data", (d) => { stderr += d.toString() })
    child.on("error", (e) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      resolve({ error: `shell.exec failed to start: ${e.message}` })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      resolve({ exitCode: timedOut ? null : code, timedOut, stdout, stderr })
    })
  })
  if (out.error) throw new Error(out.error)
  let stderr = limitChars(out.stderr, MAX_SHELL_OUTPUT_CHARS)
  if (out.timedOut) stderr = `${stderr ? stderr + "\n" : ""}Command timed out after ${timeoutSecs}s`
  return {
    command: cmd,
    exitCode: out.exitCode,
    stdout: limitChars(out.stdout, MAX_SHELL_OUTPUT_CHARS),
    stderr,
    timedOut: out.timedOut,
  }
}

// runtime.rs is_shell_command_approved: exact trimmed match only (the legacy
// branch never applies the workspace-scope auto-allow).
function isShellCommandApproved(command, approved) {
  const c = String(command).trim()
  return c !== "" && Array.isArray(approved) && approved.some((a) => String(a).trim() === c)
}

/**
 * Run the desktop's offline turn. Called by agent.js runLoop when the
 * resolved chat config fails isUsableForBackendHttp. Returns the same result
 * shape runLoop returns: { finalText, references, toolEvents, events }.
 *
 * @param {object} opts
 * @param {object} opts.request        AgentChatRequest (camelCase, desktop shape)
 * @param {string} opts.projectPath
 * @param {object} opts.store          shared app-state snapshot
 * @param {Array}  opts.skills         loaded AgentSkill[] (loadProjectSkills)
 * @param {(payload: object) => void} opts.emit   SSE emit (agent-event)
 * @param {() => void} opts.checkCancelled        throws "Agent run cancelled"
 */
export async function runLegacyRetrievalPath({ request, projectPath, store, skills, emit, checkCancelled }) {
  const toolEvents = []
  const events = []
  const references = []
  const retrievalParts = []
  const pushEv = (payload) => { events.push(payload); emit(payload) }
  const pushRef = (ref) => { references.push(ref); pushEv({ type: "referenceAdded", reference: ref }) }
  const pushTool = (tool, status, detail) => { toolEvents.push({ tool, status, detail, timestamp: Date.now() }) }

  const message = String(request.message ?? "").trim()
  if (!message) throw new Error("message is required")
  const mode = request.mode || "standard"
  const tools = {
    wiki: request.tools?.wiki !== false,
    web: !!request.tools?.web,
    anytxt: !!request.tools?.anytxt,
  }
  const retrievalMode = request.retrievalMode || "standard"
  const rawTopK = typeof request.topK === "number" && Number.isFinite(request.topK)
    ? Math.floor(request.topK) : DEFAULT_CHAT_SEARCH_RESULTS
  const topK = Math.min(Math.max(rawTopK, 1), MAX_CHAT_SEARCH_RESULTS)
  const includeContent = request.includeContent === true

  // Desktop emits skills.load once up front when the REQUEST carries skill
  // names (toolEvent completed + toolEnd; no toolStart event).
  const requestedSkills = Array.isArray(request.skills) ? request.skills : []
  if (requestedSkills.length) {
    const detail = `${skills.length} skill(s) ${(request.skillMode || "auto") === "explicit" ? "selected" : "available"}`
    pushTool("skills.load", "completed", detail)
    pushEv({ type: "toolEnd", tool: "skills.load", output: detail })
  }

  // "available" hints are tool_events only on the desktop (no SSE events).
  if (tools.web && retrievalMode !== "faithful") {
    pushTool("web.search", "available", "Web search is enabled for this turn. Router decides whether to execute it immediately.")
  }
  if (tools.anytxt && retrievalMode !== "faithful") {
    pushTool("anytxt.search", "available", "AnyTXT search is enabled for this turn. Router decides whether to execute it immediately.")
  }

  const router = routeQuery(message, mode, tools)
  checkCancelled()

  // Offline the model planner cannot run (no usable config), so
  // planner_unavailable_or_failed == should_plan_tools_with_model and the
  // runtime fallback decides wiki retrieval (should_fallback_wiki_search).
  const plannerUnavailable = shouldPlanToolsWithModel(message, mode, tools, skills.length > 0)
  const fallbackWikiSearch = plannerUnavailable && tools.wiki && skills.length === 0
  const shouldSearchWiki = router.shouldSearchWiki || fallbackWikiSearch
  const shouldIncludeSources = router.shouldIncludeSources
  const shouldSearchGraph = router.intent === "graph"
  const shouldRunWeb = tools.web && (router.intent === "external_search" || mode === "deep")
  const shouldRunAnytxt = tools.anytxt && (shouldIncludeSources || mode === "deep")
  const deepResearch = mode === "deep" && (shouldRunWeb || shouldRunAnytxt || shouldIncludeSources)

  // Offline the model plan is empty, so a shell call can only come from the
  // request itself (trusted-user field) and only when a skill is active.
  const shellCommand = skills.length ? String(request.shellCommand ?? "").trim() : ""
  if (shellCommand) {
    checkCancelled()
    if (isSkillPreferenceProbeCommand(shellCommand)) {
      const detail = skippedSkillPreferenceProbeSummary(shellCommand)
      pushTool("shell.exec", "completed", "skipped optional skill preference probe")
      pushEv({ type: "toolStart", tool: "shell.exec", input: shellCommand })
      pushEv({ type: "toolEnd", tool: "shell.exec", output: detail })
      retrievalParts.push(detail)
    } else if (!isShellCommandApproved(shellCommand, request.approvedShellCommands)) {
      const detail = `approval required: ${shellCommand}`
      pushEv({ type: "toolStart", tool: "shell.exec", input: shellCommand })
      pushTool("shell.exec", "available", detail)
      pushEv({ type: "toolEnd", tool: "shell.exec", output: detail })
      retrievalParts.push(`shell.exec was requested by an active skill but was not run because the command has not been approved: \`${shellCommand}\`.`)
    } else {
      pushTool("shell.exec", "started", shellCommand)
      pushEv({ type: "toolStart", tool: "shell.exec", input: shellCommand })
      try {
        const output = await runShellExec(projectPath, shellCommand, SHELL_EXEC_TIMEOUT_SECS)
        checkCancelled()
        const exitDebug = output.exitCode === null ? "None" : `Some(${output.exitCode})`
        retrievalParts.push(`shell.exec \`${output.command}\` exit=${exitDebug} timedOut=${output.timedOut}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`)
        pushTool("shell.exec", "completed", `exit=${exitDebug}`)
        pushEv({ type: "toolEnd", tool: "shell.exec", output: `exit=${exitDebug}` })
      } catch (err) {
        pushTool("shell.exec", "failed", errText(err))
        pushEv({ type: "toolEnd", tool: "shell.exec", output: `failed: ${errText(err)}` })
      }
    }
  }

  if (deepResearch) {
    pushTool("deep_research.run", "started", message)
    pushEv({ type: "toolStart", tool: "deep_research.run", input: message })
  }

  const toolCtx = { projectPath, store, topK, includeContent, skills, approvedShellCommands: [], signal: undefined }

  if (shouldSearchWiki) {
    checkCancelled()
    pushTool("wiki.search", "started", message)
    pushEv({ type: "toolStart", tool: "wiki.search", input: message })
    try {
      const res = await searchCommands.search_project({ projectPath, query: message, topK, includeContent })
      checkCancelled()
      const refs = (res.results ?? []).map((r) => ({ title: r.title, path: r.path, kind: "wiki", snippet: r.snippet, score: r.score }))
      for (const ref of refs) pushRef(ref)
      const count = refs.length
      pushTool("wiki.search", "completed", `${count} result(s), mode=${res.mode}, tokenHits=${res.tokenHits}, vectorHits=${res.vectorHits}, graphHits=${res.graphHits}`)
      pushEv({ type: "toolEnd", tool: "wiki.search", output: `${count} result(s)` })
      retrievalParts.push(buildRetrievalAnswer(message, references))
      // Deep mode additionally reads excerpts from up to 2 wiki hits.
      if (mode === "deep" && references.length) {
        const excerpts = []
        for (const ref of references.filter((r) => r.kind === "wiki").slice(0, 2)) {
          try {
            const content = readWikiPage(projectPath, ref.path)
            excerpts.push(`Excerpt from ${ref.path}:\n${collapseWhitespace(content).slice(0, 2000)}`)
          } catch { /* unreadable pages are skipped (desktop filter_map(ok)) */ }
        }
        if (excerpts.length) {
          pushTool("wiki.read_page", "completed", `${excerpts.length} excerpt(s)`)
          pushEv({ type: "toolEnd", tool: "wiki.read_page", output: `${excerpts.length} excerpt(s)` })
          retrievalParts.push(excerpts.join("\n\n"))
        }
      }
    } catch (err) {
      pushTool("wiki.search", "failed", errText(err))
      pushEv({ type: "toolEnd", tool: "wiki.search", output: `failed: ${errText(err)}` })
    }
  } else if (tools.wiki) {
    retrievalParts.push(`Router intent=${router.intent} did not require immediate wiki.search for this turn.`)
  }

  if (shouldIncludeSources) {
    checkCancelled()
    pushTool("source.search", "started", message)
    pushEv({ type: "toolStart", tool: "source.search", input: message })
    try {
      const { references: sourceRefs } = await runTool("source.search", { query: message, top_k: topK }, toolCtx)
      for (const ref of sourceRefs ?? []) pushRef(ref)
      const count = (sourceRefs ?? []).length
      pushTool("source.search", "completed", `${count} result(s)`)
      pushEv({ type: "toolEnd", tool: "source.search", output: `${count} result(s)` })
    } catch (err) {
      pushTool("source.search", "failed", errText(err))
      pushEv({ type: "toolEnd", tool: "source.search", output: `failed: ${errText(err)}` })
    }
  }

  if (shouldSearchGraph) {
    checkCancelled()
    pushTool("graph.search", "started", message)
    pushEv({ type: "toolStart", tool: "graph.search", input: message })
    try {
      const { references: graphRefs } = await runTool("graph.search", { query: message, top_k: topK }, toolCtx)
      for (const ref of graphRefs ?? []) pushRef(ref)
      const count = (graphRefs ?? []).length
      pushTool("graph.search", "completed", `${count} result(s)`)
      pushEv({ type: "toolEnd", tool: "graph.search", output: `${count} result(s)` })
    } catch (err) {
      pushTool("graph.search", "failed", errText(err))
      pushEv({ type: "toolEnd", tool: "graph.search", output: `failed: ${errText(err)}` })
    }
  }

  if (shouldRunWeb) {
    checkCancelled()
    pushTool("web.search", "started", message)
    pushEv({ type: "toolStart", tool: "web.search", input: message })
    try {
      const { references: webRefs } = await runTool("web.search", { query: message, top_k: topK, max_results: topK }, toolCtx)
      checkCancelled()
      for (const ref of webRefs ?? []) pushRef(ref)
      const count = (webRefs ?? []).length
      pushTool("web.search", "completed", `${count} result(s)`)
      pushEv({ type: "toolEnd", tool: "web.search", output: `${count} result(s)` })
    } catch (err) {
      pushTool("web.search", "failed", errText(err))
      pushEv({ type: "toolEnd", tool: "web.search", output: `failed: ${errText(err)}` })
    }
  }

  if (shouldRunAnytxt) {
    checkCancelled()
    pushTool("anytxt.search", "started", message)
    pushEv({ type: "toolStart", tool: "anytxt.search", input: message })
    try {
      const { references: anytxtRefs } = await runTool("anytxt.search", { query: message, top_k: topK, max_results: topK }, toolCtx)
      checkCancelled()
      for (const ref of anytxtRefs ?? []) pushRef(ref)
      const count = (anytxtRefs ?? []).length
      pushTool("anytxt.search", "completed", `${count} result(s)`)
      pushEv({ type: "toolEnd", tool: "anytxt.search", output: `${count} result(s)` })
    } catch (err) {
      pushTool("anytxt.search", "failed", errText(err))
      pushEv({ type: "toolEnd", tool: "anytxt.search", output: `failed: ${errText(err)}` })
    }
  }

  if (deepResearch) {
    const detail = `${references.length} reference(s)`
    pushTool("deep_research.run", "completed", detail)
    pushEv({ type: "toolEnd", tool: "deep_research.run", output: detail })
  }

  if (!retrievalParts.length) {
    if (!tools.wiki && !tools.web && !tools.anytxt) {
      retrievalParts.push("No Agent tools were enabled for this request. Enable wiki, web, or AnyTXT tools to let the backend Agent retrieve supporting context.")
    } else {
      retrievalParts.push("No Agent tools ran before generation. Available tools were exposed as model hints.")
    }
  }

  // No usable LLM: the desktop answers with the retrieval summary itself.
  // No messageDelta events are emitted (deltas only come from LLM streaming);
  // the wrappers carry finalText in the done event / response message.
  return { finalText: retrievalParts.join("\n\n"), references, toolEvents, events }
}
