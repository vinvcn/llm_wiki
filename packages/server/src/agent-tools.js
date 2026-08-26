import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { searchCommands } from "./commands/search.js"
import { webSearchCommands } from "./commands/websearch.js"
import { runAnytxtSearch } from "./anytxt.js"
import { recordFileVersion } from "./commands/fileHistory.js"
import { searchGraph } from "./graph.js"
import { listAvailableSkills, readActiveSkillFile } from "./skills.js"
import { readPreprocessedCache } from "./commands/preprocess.js"
import { isShellCommandAllowedWithoutPrompt, shellApprovalSummary } from "./shell-policy.js"

// Agent tool specs + executors (Node port of the desktop agent's tool set in
// src-tauri/src/agent/tools.rs). Each executor returns
// { observation, references?, fileChanges? }. The runtime emits the matching
// SSE events (toolStart/toolEnd/referenceAdded/fileChanged) the UI expects.

const fwd = (p) => p.split(path.sep).join("/")
const clip = (s, n = 4000) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "\n…[truncated]" : s }
const SHELL_EXEC_TIMEOUT_SECS = 30
const MAX_SHELL_OUTPUT_CHARS = 20000

function rel(projectPath, p) { return fwd(path.relative(projectPath, p)) }

const STOP = new Set(["the","is","a","an","of","to","in","on","for","and","or","with","by","as","it","be","are","was","were"])
function tokens(q) {
  return [...new Set((q || "").toLowerCase().split(/[\s,。.!?;:()""''\-_/]+/).filter((t) => t.length > 1 && !STOP.has(t)))]
}

function walk(dir, out, pred) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out, pred)
    else if (pred(e, full)) out.push(full)
  }
}

const SPECS = {
  "wiki.search": { description: "Search the generated wiki pages using the project's retrieval mode (keyword, vector, or hybrid). Returns matching pages with snippets.", parameters: { type: "object", properties: { query: { type: "string" }, top_k: { type: "integer" } }, required: ["query"] } },
  "wiki.read_page": { description: "Read the full content of a wiki page by project-relative path (e.g. wiki/concepts/foo.md).", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  "source.search": { description: "Search the imported raw source documents (raw/sources) by keyword.", parameters: { type: "object", properties: { query: { type: "string" }, top_k: { type: "integer" } }, required: ["query"] } },
  "graph.search": { description: "Search the knowledge graph for pages related to a query.", parameters: { type: "object", properties: { query: { type: "string" }, top_k: { type: "integer" } }, required: ["query"] } },
  "web.search": { description: "Search the public web using the configured provider.", parameters: { type: "object", properties: { query: { type: "string" }, max_results: { type: "integer" } }, required: ["query"] } },
  "anytxt.search": { description: "Search local indexed documents via AnyTXT (if configured).", parameters: { type: "object", properties: { query: { type: "string" }, max_results: { type: "integer" } }, required: ["query"] } },
  "wiki.write_page": { description: "Create or overwrite a wiki page. path is project-relative under wiki/.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  "workspace.write_file": { description: "Write a generated output file under agent-workspace/.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  "workspace.append_file": { description: "Append text to a generated output file under agent-workspace/.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  "shell.exec": { description: "Run a shell command on the server host (gated; requires approval/enablement).", parameters: { type: "object", properties: { command: { type: "string" }, timeoutSeconds: { type: "integer", minimum: 1, maximum: 30 } }, required: ["command"] } },
  "skills.load": { description: "Load instruction-only project skills from .llm-wiki/skills.", parameters: { type: "object", properties: {} } },
  "skill.read_file": { description: "Read a text reference file from an active skill directory by relative path.", parameters: { type: "object", properties: { skill: { type: "string", description: "Optional active skill name; required when multiple skills are active." }, path: { type: "string", description: "Relative path inside the active skill directory, such as references/types.md." } }, required: ["path"] } },
  "user.ask": { description: "Pause and show the user a structured form with single-choice, multi-choice, text, textarea, or confirmation fields when an active skill needs user input.", parameters: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, fields: { type: "array", items: { type: "object", properties: { id: { type: "string" }, type: { type: "string", enum: ["single", "multi", "text", "textarea", "confirm"] }, label: { type: "string" }, description: { type: "string" }, placeholder: { type: "string" }, options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" }, description: { type: "string" }, recommended: { type: "boolean" } } } }, defaultValue: {} }, required: ["label"] } } }, required: ["fields"] } },
  "llm.generate": { description: "Run a one-shot LLM generation with a prompt (no tools).", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
  "deep_research.run": { description: "Collect broader external/local evidence for deep research turns before synthesis.", parameters: { type: "object", properties: { query: { type: "string" }, sources: { type: "array", items: { enum: ["web", "anytxt", "wiki", "source"] } } }, required: ["query"] } },
}

function specList(names) {
  return names.map((n) => ({ name: n, description: SPECS[n].description, parameters: SPECS[n].parameters }))
}

async function wikiSearch(input, ctx) {
  const topK = input.top_k ?? ctx.topK ?? 5
  // Retrieval parity with the search UI (issue #14): honor the global
  // wikiSearchMode and the configured embedding provider instead of running
  // keyword-only.
  const embCfg = ctx.store?.embeddingConfig
  const res = await searchCommands.search_project({
    projectPath: ctx.projectPath, query: input.query, topK, includeContent: ctx.includeContent,
    embeddingConfig: embCfg && embCfg.enabled ? embCfg : null,
    wikiSearchMode: ctx.store?.wikiSearchMode ?? null,
  })
  const references = res.results.map((r) => ({ title: r.title, path: r.path, kind: "wiki", snippet: r.snippet, score: r.score }))
  const observation = res.results.length
    ? res.results.map((r) => `- ${r.title} (${r.path}): ${r.snippet}`).join("\n")
    : "No wiki pages matched the query."
  return { observation, references }
}

async function wikiReadPage(input, ctx) {
  const p = path.isAbsolute(input.path) ? input.path : path.join(ctx.projectPath, input.path.replace(/^\/+/, ""))
  if (!p.startsWith(path.join(ctx.projectPath, "wiki"))) throw new Error("wiki.read_page path must be under wiki/")
  const content = await fsp.readFile(p, "utf-8")
  return { observation: clip(content, 12000) }
}

// Faithful port of tools.rs search_sources: text formats are read directly,
// binary formats (pdf/doc/docx/pptx/xls/xlsx/odt/ods/odp/epub/mobi) match
// ONLY through a fresh preprocess cache, hidden paths are skipped, files are
// capped at MAX_SOURCE_SEARCH_FILES, snippets mirror snippet_around_byte, and
// top_k clamps to 1..10. The full query is matched first, then the derived
// query terms (2+ chars, split on whitespace ,，;；:：, stopwords dropped).
const SOURCE_TEXT_EXTS = new Set(["md", "markdown", "org", "txt", "json", "csv", "tsv", "yaml", "yml", "xml", "html"])
const SOURCE_BINARY_EXTS = new Set(["pdf", "doc", "docx", "pptx", "xls", "xlsx", "odt", "ods", "odp", "epub", "mobi"])
const MAX_SOURCE_SEARCH_FILES = 10_000
const MAX_SOURCE_SNIPPET_CHARS = 500
const SOURCE_STOPWORDS = new Set(["raw", "source", "sources", "file", "files", "原始资料", "原始文件", "源文件"])

function sourceQueryTerms(query) {
  return query
    .split(/[\s,，;；:：]+/)
    .map((t) => t.trim())
    .filter((t) => [...t].length >= 2)
    .filter((t) => !SOURCE_STOPWORDS.has(t))
}

// tools.rs snippet_around_byte: center the snippet on the first match,
// 500 chars, "..." ellipses at either end, whitespace collapsed.
function snippetAroundByte(content, matchCodeUnitIdx) {
  const charIdx = Math.min([...content].length, [...content.slice(0, Math.max(0, matchCodeUnitIdx))].length)
  const start = Math.max(0, charIdx - Math.floor(MAX_SOURCE_SNIPPET_CHARS / 2))
  let snippet = [...content].slice(start, start + MAX_SOURCE_SNIPPET_CHARS).join("")
  if (start > 0) snippet = "..." + snippet
  if ([...content].length > start + MAX_SOURCE_SNIPPET_CHARS) snippet = snippet + "..."
  return snippet.split(/\s+/).join(" ")
}

/**
 * search_sources port (tools.rs) exposed for direct harness use and reused by
 * the agent loop executor: text formats are read directly, binary formats
 * match ONLY through the fresh preprocess cache (read_cache), hidden paths
 * are skipped at every level, the whole query is tried before the derived
 * terms, files are capped at MAX_SOURCE_SEARCH_FILES, top_k clamps to 1..10,
 * and snippets mirror snippet_around_byte.
 */
export async function searchSources(projectPath, query, topK) {
  const q = String(query ?? "").trim()
  if (q === "") throw new Error("source.search query is required")
  const root = path.join(projectPath, "raw", "sources")
  const lowerQuery = q.toLowerCase()
  const terms = sourceQueryTerms(lowerQuery)

  const refs = []
  let seenFiles = 0
  let stop = false
  const dirs = [root]
  const limit = Math.min(Math.max(Math.floor(topK ?? 5), 1), 10)
  while (dirs.length && !stop) {
    const dir = dirs.pop()
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { dirs.push(full); continue }
      seenFiles += 1
      if (seenFiles > MAX_SOURCE_SEARCH_FILES) { stop = true; break }
      const ext = path.extname(e.name).slice(1).toLowerCase()
      let content
      if (SOURCE_TEXT_EXTS.has(ext)) {
        try { content = await fsp.readFile(full, "utf-8") } catch { continue }
      } else if (SOURCE_BINARY_EXTS.has(ext)) {
        // Binaries match ONLY through a fresh preprocess cache (read_cache).
        content = await readPreprocessedCache(full)
        if (content === null) continue
      } else {
        continue
      }
      const lower = content.toLowerCase()
      const matched = [lowerQuery, ...terms].find((term) => lower.includes(term))
      if (matched === undefined) continue
      refs.push({
        title: e.name,
        path: rel(projectPath, full),
        kind: "source",
        snippet: snippetAroundByte(content, lower.indexOf(matched)),
      })
      if (refs.length >= limit) { stop = true; break }
    }
  }
  return refs
}

async function sourceSearch(input, ctx) {
  const refs = await searchSources(ctx.projectPath, input.query, input.topK ?? input.top_k ?? ctx.topK ?? 5)
  const observation = refs.length
    ? refs.map((r) => `- ${r.path}: ${r.snippet}`).join("\n")
    : "No source documents matched."
  return { observation, references: refs }
}


async function graphSearch(input, ctx) {
  const topK = input.top_k ?? ctx.topK ?? 5
  const refs = searchGraph(ctx.projectPath, input.query, topK)
  const observation = refs.length
    ? refs.map((r) => `- ${r.title} (${r.path}): ${r.snippet}`).join("\n")
    : "No graph results for the query."
  const references = refs.map((r) => ({
    title: r.title, path: r.path, kind: "graph", snippet: r.snippet, score: r.score,
    knowledgeContext: r.knowledgeContext,
  }))
  return { observation, references }
}

async function webSearch(input, ctx) {
  const config = ctx.store.searchApiConfig ?? ctx.store.searchConfig ?? {}
  const results = await webSearchCommands.web_search({ query: input.query, config, maxResults: input.max_results ?? 5 })
  const references = results.map((r) => ({ title: r.title, path: r.url, kind: "web", snippet: r.snippet, url: r.url }))
  return { observation: results.length ? results.map((r) => `- ${r.title}: ${r.snippet} (${r.url})`).join("\n") : "No web results.", references }
}

async function anytxtSearch(input, ctx) {
  // Desktop load_agent_runtime_config: the AnyTxtConfig lives at
  // store.searchApiConfig.anyTxt (shared plugin-store file) — not a top-level
  // store key. The loop executor / offline retrieval path both pass the raw
  // parsed store as ctx.store, so an out-of-band desktop edit is picked up on
  // the next turn with no restart.
  const config = ctx.store?.searchApiConfig?.anyTxt ?? {}
  const topK = input.max_results ?? input.top_k ?? ctx.topK ?? 5
  const refs = await runAnytxtSearch(input.query, config, topK)
  const references = refs.map((r) => ({ title: r.title, path: r.path, kind: "anytxt", snippet: r.snippet }))
  const observation = references.length
    ? references.map((r) => `- ${r.title}: ${r.snippet ?? ""}`).join("\n")
    : "No AnyTXT results."
  return { observation, references }
}

async function writeUnder(projectPath, relPath, content, mode, toolName) {
  const target = path.join(projectPath, relPath.replace(/^\/+/, ""))
  if (!target.startsWith(projectPath + path.sep) && target !== projectPath) throw new Error("Write target escapes the project")
  const existedBefore = fs.existsSync(target)
  const previousContent = existedBefore ? await fsp.readFile(target, "utf-8").catch(() => null) : null
  await fsp.mkdir(path.dirname(target), { recursive: true })
  if (mode === "append" && existedBefore) await fsp.appendFile(target, content, "utf-8")
  else { recordFileVersion(target, "baseline", `before.agent.${toolName}`); await fsp.writeFile(target, content, "utf-8") }
  recordFileVersion(target, "agent", `agent.${toolName}`)
  return { existedBefore, previousContent, target }
}

async function wikiWritePage(input, ctx) {
  let relPath = input.path.replace(/^\/+/, "")
  if (!relPath.startsWith("wiki/")) relPath = `wiki/${relPath}`
  const { existedBefore, previousContent, target } = await writeUnder(ctx.projectPath, relPath, input.content, "write", "wiki_write")
  return {
    observation: `Wrote wiki page ${rel(ctx.projectPath, target)} (${input.content.length} chars).`,
    fileChanges: [{ path: rel(ctx.projectPath, target), tool: "wiki.write_page", existedBefore, previousContent }],
  }
}

async function workspaceWrite(input, ctx, append) {
  let relPath = input.path.replace(/^\/+/, "")
  if (!relPath.startsWith("agent-workspace/")) relPath = `agent-workspace/${relPath}`
  const { existedBefore, previousContent, target } = await writeUnder(ctx.projectPath, relPath, input.content, append ? "append" : "write", append ? "workspace_append" : "workspace_write")
  const rpath = rel(ctx.projectPath, target)
  return {
    observation: `${append ? "Appended to" : "Wrote"} ${rpath}.`,
    references: [{ title: path.basename(target), path: rpath, kind: "workspace", snippet: "" }],
    fileChanges: [{ path: rpath, tool: append ? "workspace.append_file" : "workspace.write_file", existedBefore, previousContent }],
  }
}

async function shellExec(input, ctx) {
  // Runs an ALLOWED shell command on the server host. The agent loop (agent.js)
  // performs the desktop's full pre-check before reaching here (skills gate,
  // preference-probe skip, and the per-command approval policy in
  // shell-policy.js — a 1:1 port of runtime.rs). This defensive gate guarantees
  // a command is never executed unless it is approved or workspace-scoped, even
  // if shell.exec is ever invoked outside the loop.
  const command = String(input?.command ?? input?.query ?? "").trim()
  if (!command) throw new Error("shell.exec requires command")
  const envAllowed = process.env.LLM_WIKI_ALLOW_SHELL === "1"
  if (!envAllowed && !isShellCommandAllowedWithoutPrompt(command, ctx?.approvedShellCommands, ctx?.projectPath)) {
    return { observation: `approval required: ${command}`, approvalRequired: true, approvalSummary: shellApprovalSummary(command) }
  }
  // tools.rs run_shell_exec port: /bin/sh -c in <project>/agent-workspace with
  // a sanitized env, timeoutSeconds clamped 1..30 (default 30), stdout/stderr
  // bounded to MAX_SHELL_OUTPUT_CHARS per stream; the model observation is
  // runtime.rs's exact summary (the same string the offline/legacy path uses).
  let timeoutSeconds = Number(input?.timeoutSeconds ?? input?.timeout_seconds ?? SHELL_EXEC_TIMEOUT_SECS)
  if (!Number.isFinite(timeoutSeconds)) timeoutSeconds = SHELL_EXEC_TIMEOUT_SECS
  timeoutSeconds = Math.min(SHELL_EXEC_TIMEOUT_SECS, Math.max(1, Math.floor(timeoutSeconds)))
  const projectPath = ctx?.projectPath
  const workspace = projectPath ? path.join(projectPath, "agent-workspace") : undefined
  if (workspace) fs.mkdirSync(workspace, { recursive: true })
  const KEEP = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]
  const env = {}
  for (const k of KEEP) if (process.env[k] !== undefined) env[k] = process.env[k]
  const { spawn } = await import("node:child_process")
  const out = await new Promise((resolve) => {
    let child
    try { child = spawn("sh", ["-c", command], { cwd: workspace, env }) }
    catch (e) { resolve({ error: `shell.exec failed to start: ${e.message}` }); return }
    let stdout = "", stderr = "", settled = false, timedOut = false
    const cap = (buf, chunk) => (buf.length >= MAX_SHELL_OUTPUT_CHARS ? buf : buf + String(chunk).slice(0, MAX_SHELL_OUTPUT_CHARS - buf.length))
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL") } catch { /* already gone */ } }, timeoutSeconds * 1000)
    timer.unref?.()
    child.stdout?.on("data", (d) => { stdout = cap(stdout, d) })
    child.stderr?.on("data", (d) => { stderr = cap(stderr, d) })
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
  if (out.timedOut) out.stderr = `${out.stderr ? out.stderr + "\n" : ""}Command timed out after ${timeoutSeconds}s`
  const exitDebug = out.exitCode === null ? "None" : `Some(${out.exitCode})`
  const observation = `shell.exec \`${command}\` exit=${exitDebug} timedOut=${out.timedOut}\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`
  return { observation }
}


async function skillsLoad(_input, ctx) {
  const avail = listAvailableSkills(ctx.projectPath)
  if (!avail.length) return { observation: "No agent skills are available." }
  const observation = avail.map((s) => `- ${s.id} (${s.source}): ${s.description}`).join("\n")
  return { observation }
}
async function skillReadFile(input, ctx) {
  // Faithful port of read_active_skill_file: requires an active skill, resolves
  // the target strictly inside the skill directory, and returns the desktop's
  // "read {skill}:{path}\n{content}" summary shape (runtime.rs
  // record_loop_tool_success) with whitespace collapsed to 4k chars.
  const result = readActiveSkillFile(ctx.skills ?? [], input)
  const content = String(result.content ?? "").trim().replace(/\s+/g, " ").slice(0, 4000)
  return { observation: `read ${result.skill}:${result.path}\n${content}` }
}

async function llmGenerate(input, ctx) {
  const { blockingCall } = await import("./llm-call.js")
  const { normalizeEndpoint } = await import("./llm-resolve.js")
  const ep = normalizeEndpoint(ctx.llmConfig)
  const r = await blockingCall({ ...ep, messages: [{ role: "user", content: input.prompt }], signal: ctx.signal })
  return { observation: clip(r.content, 8000) }
}

async function deepResearch(input, _ctx) {
  // Registry-level executor (mirrors tools.rs): deep_research.run is
  // orchestrated by the agent runtime itself, so a direct registry call
  // simply returns the coordination marker. The loop executor never reaches
  // this — it rejects the tool beforehand (see LOOP_TOOL_REJECTIONS).
  const query = typeof input.query === "string" ? input.query.trim() : ""
  if (!query) throw new Error("deep_research.run requires query")
  return { observation: JSON.stringify({ query, status: "orchestrated_by_agent_runtime" }) }
}

// Tools the loop executor refuses to run, mirroring the desktop's per-tool
// permission gate (runtime.rs execute_agent_loop_tool). deep_research.run is
// runtime-orchestrated: the runtime emits its start/end events around the
// retrieval phase; the model must use the concrete search tools directly.
export const LOOP_TOOL_REJECTIONS = {
  "deep_research.run": "deep_research.run is not available in the loop executor; use web.search, anytxt.search, source.search, and wiki.search directly",
}

const EXEC = {
  "wiki.search": wikiSearch, "wiki.read_page": wikiReadPage, "source.search": sourceSearch,
  "graph.search": graphSearch, "web.search": webSearch, "anytxt.search": anytxtSearch,
  "wiki.write_page": wikiWritePage,
  "workspace.write_file": (i, c) => workspaceWrite(i, c, false),
  "workspace.append_file": (i, c) => workspaceWrite(i, c, true),
  "shell.exec": shellExec, "skills.load": skillsLoad, "skill.read_file": skillReadFile,
  "llm.generate": llmGenerate, "deep_research.run": deepResearch,
}

/** Decide which tools to expose for a request, mirroring the desktop gating. */
export function toolsForRequest(request, mode, skillsActive = false) {
  const names = ["wiki.search", "wiki.read_page", "source.search", "graph.search"]
  if (request.tools?.web) names.push("web.search")
  if (request.tools?.anytxt) names.push("anytxt.search")
  if (mode !== "fast") names.push("wiki.write_page", "workspace.write_file", "workspace.append_file", "shell.exec")
  names.push("skills.load", "skill.read_file")
  // user.ask mirrors the desktop loop prompt: offered only when a skill is
  // active for the turn (runtime.rs lists it in the available-tools block
  // under `if !skills.is_empty()`).
  if (skillsActive) names.push("user.ask")
  names.push("llm.generate")
  // NOTE: deep_research.run is deliberately NOT offered to the model. Like
  // the desktop runtime, it is orchestrated by the runtime itself (see
  // agent.js) and the loop executor rejects model-issued calls for it.
  return names
}

export function buildToolSpecs(names) { return specList(names) }
export async function runTool(name, input, ctx) {
  const fn = EXEC[name]
  if (!fn) throw new Error(`Unknown Agent tool: ${name}`)
  return await fn(input ?? {}, ctx)
}
