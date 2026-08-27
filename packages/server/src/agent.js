import { readStore } from "./store.js"
import { emit } from "./events.js"
import { EventTypes } from "./events/bus.js"
import { resolveChatConfig, normalizeEndpoint, isUsableForBackendHttp } from "./llm-resolve.js"
import { runLegacyRetrievalPath } from "./agent-legacy.js"
import { streamCall, blockingCall } from "./llm-call.js"
import { toolsForRequest, buildToolSpecs, runTool, LOOP_TOOL_REJECTIONS } from "./agent-tools.js"
import {
  isShellCommandAllowedWithoutPrompt, isSkillPreferenceProbeCommand,
  skippedSkillPreferenceProbeSummary, shellApprovalSummary, SHELL_REQUIRES_SKILL_ERROR,
} from "./shell-policy.js"
import { isUserAskTool, sanitizeUserInputRequest, userAskAnswer } from "./user-input.js"
import { loadProjectSkills, renderSkillPlannerContext, listAvailableSkills } from "./skills.js"
import { ensureProjectRow, getProject, getProjectByUuid } from "./store/projects.js"
import {
  ensureSession, listMessages, appendMessage, dropLastExchange,
} from "./store/chat-sessions.js"
import { appendTurn, recentMessages, dropLastExchange as dropSharedLastExchange, listSessions as listAgentSessionFiles } from "./agent-sessions.js"

// Node port of the desktop Rust chat-agent runtime (src-tauri/src/agent).
// Runs the model<->tool loop server-side, calling the configured LLM directly
// and streaming `agent-event` payloads over SSE in the exact shape the React
// chat panel parses (see BackendAgentEventPayload in chat-panel.tsx).
//
// Issue #21: sessions and messages persist in SQLite (chat_sessions /
// chat_messages) — the web server's own record. Since the "one backend, one
// user data" goal, model CONTEXT is sourced from the SHARED, cross-client
// record exactly like the desktop runtime (src-tauri/src/lib.rs command
// wrappers + api_server.rs handle_chat):
//   - an explicit client history (the React app's conversations.json
//     round-trip, historyExplicit: true) wins verbatim — the same contract the
//     desktop UI uses; continuing a conversation started on the other client
//     keeps its full context instead of an empty per-server store;
//   - otherwise the last 12 turns hydrate from the shared on-disk session
//     store (.llm-wiki/agent-sessions/<sessionId>.json, desktop AgentSession
//     serde format — see agent-sessions.js), and SQLite remains the fallback
//     for legacy web-only sessions;
//   - on successful completion the exchange also APPENDS to the shared
//     session store when persistSession !== false (the desktop default), so
//     API/MCP callers on either client resume the same context.
// SQLite continues to record each completed message (user at turn start,
// assistant at turn finish — never per streamed delta).

const EVENT = "agent-event"
const MAX_ITER = 8
// How many prior messages the loop feeds the model when the request does not
// say (client setting maxHistoryMessages is passed as request.historyLimit).
const DEFAULT_HISTORY_LIMIT = 20
// Desktop AgentCancellationRegistry port (src-tauri/src/agent/cancel.rs):
// runs are keyed `projectId::sessionId::runId` (slash-normalized), and
// cancellation matches an exact run key or the whole session prefix.
const runs = new Map()          // "projectId::sessionId::runId" -> { abort, cancelled }
function normalizeRunKeyPart(value) {
  return String(value ?? "").replace(/[\\/]/g, "_")
}
function runKey(projectId, sessionId, runId) {
  return `${normalizeRunKeyPart(projectId)}::${normalizeRunKeyPart(sessionId)}::${normalizeRunKeyPart(runId)}`
}
function sessionKeyPrefix(projectId, sessionId) {
  return `${normalizeRunKeyPart(projectId)}::${normalizeRunKeyPart(sessionId)}::`
}

const fwd = (p) => p.split(path.sep).join("/")
import path from "node:path"

function projectPathFor(store, projectId) {
  const reg = store.projectRegistry ?? {}
  const entry = reg[projectId]
  if (entry?.path) return entry.path
  // Fallback: lastProject / a registry value match by id anywhere
  if (store.lastProject?.id === projectId && store.lastProject?.path) return store.lastProject.path
  const any = Object.values(reg).find((e) => e?.id === projectId)
  if (any?.path) return any.path
  // v2 projects (POST /api/v2/projects) are stored in the `projects` table
  // but not in the shared store's projectRegistry (desktop registry). Fall
  // back to the DB so chat works for those projects (issue #40: MCP sync
  // chat against a remote v2 deployment).
  try {
    if (/^\d+$/.test(String(projectId))) {
      const row = getProject(Number.parseInt(String(projectId), 10))
      if (row?.path) return row.path
    }
    const byUuid = getProjectByUuid(String(projectId))
    if (byUuid?.path) return byUuid.path
  } catch { /* DB fallback is best-effort */ }
  return null
}

function emitEvent(sessionId, runId, event, projectId = null) {
  emit(EVENT, { sessionId, runId, event })
  // SSE taxonomy dual emission (plans/sse-taxonomy.md stage 5): the charter
  // chat:* frames ride the wire alongside agent-event (which stays
  // byte-identical for the active tab's chat panel). Attribution rides in the
  // payload — the emit() bridge keeps the envelope projectId null.
  // messageDelta/toolStart/toolEnd/done map to chat:delta/toolStart/toolEnd/
  // done; error, referenceAdded and fileChanged have NO charter equivalent
  // and stay agent-event-only, as does the error site's companion done here
  // (it carries no text). The error site ADDS a terminal chat:done dual in
  // agentStartTurnStream's catch (failed: "Error: <message>"; cancelled:
  // empty content) so previewing tabs can leave streaming state. done duals
  // only when it carries the turn's accumulated text, so chat:done content
  // can finalize a tab that missed the deltas.
  if (projectId == null || !event) return
  if (event.type === "messageDelta") {
    emit(EventTypes.CHAT_DELTA, { sessionId, runId, projectId, text: event.text })
  } else if (event.type === "toolStart") {
    emit(EventTypes.CHAT_TOOL_START, { sessionId, runId, projectId, tool: event.tool, input: event.input })
  } else if (event.type === "toolEnd") {
    emit(EventTypes.CHAT_TOOL_END, { sessionId, runId, projectId, tool: event.tool, output: event.output })
  } else if (event.type === "done" && typeof event.text === "string") {
    emit(EventTypes.CHAT_DONE, { sessionId, runId, projectId, content: event.text, references: event.references ?? [] })
  }
}

// Desktop AgentEvent::Done serialization for the collected events vector.
function collectEventDone(eventsOut, sessionId) {
  eventsOut.push({ type: "done", sessionId })
}

const SYSTEM_PROMPT = `You are the LLM Wiki research assistant. You help the user understand and build their personal knowledge base (a wiki compiled from imported source documents).
You have tools to search the wiki (wiki.search), read wiki pages (wiki.read_page), search raw sources (source.search), search the web (web.search), and write wiki pages or workspace outputs.
Workflow: search/read to gather evidence, then answer grounded in what you found. When you write or update wiki pages, use wiki.write_page with valid YAML frontmatter.
Be concise and cite the pages/sources you used. The system automatically attaches references from your tool results to your answer.`

function buildMessages(request, history) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }]
  const prior = Array.isArray(history) ? history : []
  for (const m of prior) {
    if (m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content })
    }
  }
  const images = Array.isArray(request.images) ? request.images.filter((i) => i?.dataBase64) : []
  if (images.length) {
    const content = [{ type: "text", text: request.message || "" }]
    for (const img of images) content.push({ type: "image", mediaType: img.mediaType || "image/png", data: img.dataBase64 })
    messages.push({ role: "user", content })
  } else {
    messages.push({ role: "user", content: request.message || "" })
  }
  return messages
}

async function executeToolCall(tc, ctx, emitRef, emitFile) {
  // For shell.exec, surface the command on toolStart so the running step shows it.
  const startInput = tc.name === "shell.exec" ? String(tc.args?.command ?? tc.args?.query ?? "") : undefined
  const startEvent = { type: "toolStart", tool: tc.name, input: startInput }
  ctx.collectEvent?.(startEvent)
  emitEvent(ctx.sessionId, ctx.runId, startEvent, ctx.projectId)
  let observation, references = [], fileChanges = []
  let failed = false
  let approvalRequired = false
  let approvalSummary = null
  let detail = null
  const rejection = LOOP_TOOL_REJECTIONS[tc.name]
  if (rejection) {
    failed = true
    detail = rejection
    observation = `rejected: ${rejection}`
  } else {
    try {
      const result = await runTool(tc.name, tc.args, ctx)
      observation = result.observation ?? ""
      references = result.references ?? []
      fileChanges = result.fileChanges ?? []
      approvalRequired = !!result.approvalRequired
      approvalSummary = result.approvalSummary ?? null
    } catch (err) {
      failed = true
      observation = `failed: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  for (const ref of references) emitRef(ref)
  for (const fc of fileChanges) emitFile(fc)
  // Approval boundary: pass the EXACT "approval required: <cmd>" string through
  // UNTRUNCATED as the SSE toolEnd output — the frontend derives status
  // "available"->"skipped" from that prefix and slices the command off it.
  const out = approvalRequired
    ? observation
    : (failed ? observation : (observation.length > 300 ? observation.slice(0, 300) + "…" : observation))
  const endEvent = { type: "toolEnd", tool: tc.name, output: (failed || approvalRequired) ? observation : out }
  ctx.collectEvent?.(endEvent)
  emitEvent(ctx.sessionId, ctx.runId, endEvent, ctx.projectId)
  return { observation, references, failed, approvalRequired, approvalSummary, detail: detail ?? out }
}

function dedupRefs(list) {
  const seen = new Set(); const out = []
  for (const r of list) {
    const key = `${r.kind ?? "wiki"}:${(r.path ?? r.url ?? "").toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key); out.push(r)
  }
  return out
}

async function runLoop({ request, projectId, stream, onDelta, attribution = null, cancelToken = null }) {
  const store = readStore("app-state.json")
  const projectPath = projectPathFor(store, projectId)
  if (!projectPath) throw new Error(`Unknown project: ${projectId}`)
  // Issue #21: persistence. Resolve/create the projects row (chat_sessions'
  // FK target) and the session row, record the user message before the loop
  // runs. `resume` marks an approval-boundary re-send whose user message was
  // already persisted.
  const projectRow = ensureProjectRow({ uuid: projectId, path: projectPath })
  // Surface the numeric projects-row id to the caller even when the loop
  // throws: the error/cancel terminal chat:done dual (below) needs it for
  // attribution, and this is the earliest point it exists.
  if (attribution) attribution.projectRowId = projectRow.id
  const session = ensureSession(projectRow.id, request.sessionId, {
    title: (request.message || "").trim().slice(0, 50) || undefined,
  })
  // Regenerate replaces the last exchange: drop the persisted pair BEFORE
  // loading history, so the model never sees the answer being replaced, and
  // the re-persisted user message + fresh answer below take their place.
  if (request.regenerate) {
    dropLastExchange(session.id)
    dropSharedLastExchange({ projectPath, sessionId: request.sessionId })
  }
  const historyLimit = Number.isInteger(request.historyLimit) ? request.historyLimit : DEFAULT_HISTORY_LIMIT
  // Cross-client context sourcing (desktop contract — lib.rs + handle_chat):
  // an explicit client history wins verbatim; otherwise hydrate the last 12
  // MESSAGES from the shared on-disk session store (the Rust commands pass
  // limit 12 to recent_messages — 12 messages, i.e. 6 exchanges); SQLite
  // remains the fallback for legacy web-only sessions (issue #21).
  let priorMessages
  const explicitHistory = request.historyExplicit === true
  const clientHistory = Array.isArray(request.history) ? request.history : []
  if (explicitHistory || clientHistory.length > 0) {
    priorMessages = clientHistory
  } else {
    // Desktop hardcodes the 12-MESSAGE hydrate; the web additionally
    // respects the user's historyLimit (context-window setting) when provided.
    const limit = Math.min(12, historyLimit)
    const shared = recentMessages({ projectPath, sessionId: request.sessionId, limit })
    if (shared.length > 0) {
      priorMessages = shared.map((m) => ({ role: m.role, content: m.content }))
    } else {
      priorMessages = listMessages(session.id).slice(-historyLimit)
    }
  }
  if (!request.resume) {
    appendMessage(session.id, "user", request.message || "")
  }
  // Desktop AgentChatResponse.events: every agent event this turn produces is
  // also collected for the non-stream response (the local HTTP API /chat
  // envelope exposes them, redacted via redact_for_external_api). MessageDelta
  // is sink-only in the desktop's non-stream vector (runtime.rs gates every
  // final-answer MessageDelta emission on event_sink.is_some(); handle_chat
  // passes sink None), so it is not collected.
  const eventsOut = []
  const collectEvent = (event) => {
    if (!event || event.type === "messageDelta" || event.type === "error" || event.type === "done") return
    if (event.type === "fileChanged") {
      const { previousContent, ...rest } = event // rollback snapshot is desktop-internal
      eventsOut.push(rest)
      return
    }
    eventsOut.push(event)
  }
  const runEmit = (event) => {
    collectEvent(event)
    emitEvent(request.sessionId, request.runId, event, projectRow.id)
  }
  const llmConfig = resolveChatConfig(store)
  // Desktop contract (runtime.rs run_once_with_cancel_and_events): when the
  // resolved chat config is NOT usable for backend HTTP (missing API key or
  // model, or a CLI-only provider such as claude-code/codex-cli), the turn
  // never calls an LLM and never surfaces a provider/network error — it runs
  // the deterministic router + retrieval pipeline and answers with the
  // retrieval summary (ok:true). Faithful port in agent-legacy.js
  // (provider.rs is_usable_for_backend_http).
  if (!isUsableForBackendHttp(llmConfig)) {
    const skills = loadProjectSkills(projectPath, request.skills)
    const { finalText, references, toolEvents } = await runLegacyRetrievalPath({
      request, projectPath, store, skills,
      emit: (payload) => runEmit(payload),
      checkCancelled: () => {
        if (runs.get(runKey(projectId, request.sessionId, request.runId))?.cancelled) {
          throw new Error("Agent run cancelled")
        }
      },
    })
    // Same completion persistence as a normal turn: the user message was
    // recorded above; the retrieval answer is the assistant message, and it
    // appends to the shared cross-client session store unless the caller
    // opted out (persistSession !== false — the desktop default).
    if (finalText) {
      appendMessage(session.id, "assistant", finalText, references)
      if (request.persistSession !== false) {
        appendTurn({
          projectPath,
          projectId,
          sessionId: request.sessionId,
          user: request.message || "",
          assistant: finalText,
        })
      }
    }
    collectEventDone(eventsOut, request.sessionId)
    return {
      finalText, references, toolEvents, events: eventsOut,
      projectRowId: projectRow.id, userInputRequest: null,
    }
  }
  const ep = normalizeEndpoint(llmConfig)
  const mode = request.mode || "standard"
  const skills = loadProjectSkills(projectPath, request.skills)
  const toolNames = toolsForRequest(request, mode, skills.length > 0)
  const tools = buildToolSpecs(toolNames)
  const messages = buildMessages(request, priorMessages)
  if (skills.length) {
    const skillBlock = renderSkillPlannerContext(skills, request.skillMode || "auto")
    messages[0] = { ...messages[0], content: `${messages[0].content}\n\n## Skills\n${skillBlock}` }
    // Mirror the desktop's startup skills.load tool event for the activity panel.
    const detail = `${skills.length} skill(s) ${(request.skillMode || "auto") === "explicit" ? "selected" : "available"}`
    runEmit({ type: "toolStart", tool: "skills.load" })
    runEmit({ type: "toolEnd", tool: "skills.load", output: detail })
  }

  const ctxBase = {
    // projectId is the NUMERIC projects-row id (chat:* attribution, stage 5)
    // — not the UUID the run was started with.
    sessionId: request.sessionId, runId: request.runId, projectId: projectRow.id,
    projectPath, store, llmConfig,
    topK: request.topK ?? 5, includeContent: !!request.includeContent, skills,
    approvedShellCommands: Array.isArray(request.approvedShellCommands) ? request.approvedShellCommands : [],
    signal: cancelToken?.abort?.signal
      ?? runs.get(runKey(projectId, request.sessionId, request.runId))?.abort?.signal,
    collectEvent,
  }
  const allRefs = []
  const toolEvents = []
  // Runtime-orchestrated Deep Research (mirrors runtime.rs): in deep mode,
  // when at least one retrieval channel is active, bracket the retrieval
  // phase with deep_research.run start/end events. The tool is never offered
  // to the model (see toolsForRequest); deep mode does NOT force web search
  // on — web.search stays gated by request.tools.web.
  const retrievalChannelActive = request.tools?.web || request.tools?.anytxt
    || toolNames.includes("wiki.search") || toolNames.includes("source.search")
  const deepResearch = mode === "deep" && !!retrievalChannelActive
  const message = request.message || ""
  if (deepResearch) {
    toolEvents.push({ tool: "deep_research.run", status: "started", detail: message, timestamp: Date.now() })
    runEmit({ type: "toolStart", tool: "deep_research.run", input: message })
  }
  const emitRef = (ref) => { allRefs.push(ref); runEmit({ type: "referenceAdded", reference: ref }) }
  const emitFile = (fc) => runEmit({ type: "fileChanged", path: fc.path, tool: fc.tool, existedBefore: fc.existedBefore, previousContent: fc.previousContent })

  let finalText = ""
  let stoppedAtApproval = false
  let stoppedAtUserInput = false
  let userInputForm = null
  const cancelCheckpoint = () => {
    // Desktop AgentCancellationToken checkpoint (cancel.rs is_cancelled →
    // "Agent turn cancelled"; this codebase's established Node message is
    // "Agent run cancelled", normalized by agentStartTurnStream's catch).
    // The registry is keyed `projectId::sessionId::runId` (session-scoped
    // cancel), so the token captured for THIS run is authoritative — a bare
    // runId lookup can never match the composite key and would make every
    // checkpoint dead code.
    if (cancelToken?.cancelled) throw new Error("Agent run cancelled")
  }
  for (let iter = 0; iter < MAX_ITER; iter++) {
    cancelCheckpoint()
    const ctx = { ...ctxBase }
    let turnText = ""
    const turnToolCalls = []
    if (stream) {
      for await (const ev of streamCall({ ...ep, messages, tools, signal: ctx.signal })) {
        // Per-event checkpoint (runtime.rs generate_with_cancellation_stream
        // biases every await point toward cancellation): the first event
        // observed after a cancel stops the turn immediately, even when a
        // provider/mock ignores the abort signal.
        cancelCheckpoint()
        if (ev.type === "delta") { turnText += ev.text; onDelta?.(ev.text); emitEvent(request.sessionId, request.runId, { type: "messageDelta", text: ev.text }, projectRow.id) }
        else if (ev.type === "tool_call") turnToolCalls.push(ev)
      }
    } else {
      const r = await blockingCall({ ...ep, messages, tools, signal: ctx.signal })
      turnText = r.content || ""
      if (turnText) { onDelta?.(turnText); emitEvent(request.sessionId, request.runId, { type: "messageDelta", text: turnText }, projectRow.id) }
      turnToolCalls.push(...r.toolCalls)
    }
    // Post-call checkpoint (runtime.rs generate_with_cancellation /
    // generate_with_cancellation_stream bias): a cancel that landed while the
    // LLM call was in flight discards the returned content/tool calls instead
    // of letting them become the answer or run tools.
    cancelCheckpoint()
    if (turnToolCalls.length === 0) { finalText = turnText; break }
    // assistant turn with tool calls
    messages.push({ role: "assistant", content: turnText || null, toolCalls: turnToolCalls })
    let approvalBoundary = false
    let approvalMessage = ""
    for (const tc of turnToolCalls) {
      // Pre-execution checkpoint (runtime.rs execute_tool_with_cancellation
      // biased toward cancellation): a run cancelled after the LLM offered a
      // tool call must NOT execute it — no shell command, no file write.
      cancelCheckpoint()
      // Desktop-faithful user.ask handling (runtime.rs run_agent_loop): the
      // model pauses the turn to show the user a structured form. Handled
      // BEFORE the generic executor, exactly like the desktop's dispatch
      // order. An invalid schema is rejected back to the model
      // (record_loop_tool_rejection) so it can retry with a corrected form.
      if (isUserAskTool(tc.name)) {
        let form
        try {
          form = sanitizeUserInputRequest(tc.args ?? {})
        } catch (err) {
          const rejection = `${err.message}. Return a corrected user.ask schema or answer without asking.`
          toolEvents.push({ tool: "user.ask", status: "failed", detail: rejection, timestamp: Date.now() })
          runEmit({ type: "toolEnd", tool: "user.ask", output: `rejected: ${rejection}` })
          messages.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: `rejected: ${rejection}` })
          continue
        }
        userInputForm = form
        break
      }
      // Desktop-faithful shell.exec pre-checks (runtime.rs execute_agent_loop_tool),
      // done BEFORE the generic started/exec path so the emitted events match the
      // desktop exactly (no spurious "started" event for rejected/probe cases).
      if (tc.name === "shell.exec") {
        const command = String(tc.args?.command ?? tc.args?.query ?? "").trim()
        // (1) skills gate: shell.exec is rejected unless a skill is active for this turn.
        if (skills.length === 0) {
          const err = SHELL_REQUIRES_SKILL_ERROR
          toolEvents.push({ tool: "shell.exec", status: "failed", detail: err, timestamp: Date.now() })
          runEmit({ type: "toolEnd", tool: "shell.exec", output: `rejected: ${err}` })
          messages.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: `rejected: ${err}` })
          continue
        }
        // (2) skill preference probe: skipped, never sent to shell approval.
        if (isSkillPreferenceProbeCommand(command)) {
          const summary = skippedSkillPreferenceProbeSummary(command)
          runEmit({ type: "toolStart", tool: "shell.exec", input: command })
          toolEvents.push({ tool: "shell.exec", status: "completed", detail: "skipped optional skill preference probe", timestamp: Date.now() })
          runEmit({ type: "toolEnd", tool: "shell.exec", output: summary })
          messages.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: summary })
          continue
        }
        // (3) per-command approval policy: env escape hatch OR allowlist/workspace-scope.
        const envAllowed = process.env.LLM_WIKI_ALLOW_SHELL === "1"
        if (!envAllowed && !isShellCommandAllowedWithoutPrompt(command, ctxBase.approvedShellCommands, projectPath)) {
          runEmit({ type: "toolStart", tool: "shell.exec", input: command })
          toolEvents.push({ tool: "shell.exec", status: "available", detail: `approval required: ${command}`, timestamp: Date.now() })
          runEmit({ type: "toolEnd", tool: "shell.exec", output: `approval required: ${command}` })
          approvalMessage = shellApprovalSummary(command)
          approvalBoundary = true
          break
        }
        // else: allowed without prompt -> fall through to the generic run path.
      }
      toolEvents.push({ tool: tc.name, status: "started", timestamp: Date.now() })
      const { observation, references, failed, approvalRequired, approvalSummary, detail } = await executeToolCall(tc, ctx, emitRef, emitFile)
      const bad = failed || (observation.startsWith("failed:") || observation.startsWith("rejected:"))
      if (approvalRequired) {
        // Defensive path: shell.exec reached the executor unapproved. Same shape as (3).
        toolEvents.push({ tool: tc.name, status: "available", detail: observation, timestamp: Date.now() })
        messages.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: observation })
        approvalMessage = approvalSummary || observation
        approvalBoundary = true
        break
      }
      toolEvents.push({ tool: tc.name, status: references.length || !bad ? "completed" : "failed", detail, timestamp: Date.now() })
      messages.push({ role: "tool", toolCallId: tc.id, name: tc.name, content: observation })
    }
    if (userInputForm) {
      // User-input boundary (stateless resume, mirroring the desktop): emit
      // UserInputRequired + Done and end the turn with the form description
      // as the message text (runtime.rs: answer = request_form.description,
      // falling back to the "Please provide..." line). No messageDelta — the
      // owning tab renders the intro from the request itself. The frontend's
      // UserInputRequestPanel collects the answers and re-sends them as a
      // plain follow-up message.
      runEmit({ type: "userInputRequired", request: userInputForm })
      finalText = userAskAnswer(userInputForm)
      stoppedAtUserInput = true
      break
    }
    if (approvalBoundary) {
      // Stop the turn at the approval boundary (stateless resume: the frontend
      // re-sends with approvedShellCommands). Emit the desktop's exact approval
      // text as the final message; the Approve button is driven by the
      // "available"->skipped shell_exec step (detail "approval required: <cmd>").
      if (stream) emitEvent(request.sessionId, request.runId, { type: "messageDelta", text: approvalMessage }, projectRow.id)
      finalText = approvalMessage
      stoppedAtApproval = true
      break
    }
    // loop again for the model to answer
  }

  const finalReferences = dedupRefs(allRefs)
  if (deepResearch) {
    const detail = `${finalReferences.length} reference(s)`
    toolEvents.push({ tool: "deep_research.run", status: "completed", detail, timestamp: Date.now() })
    runEmit({ type: "toolEnd", tool: "deep_research.run", output: detail })
  }
  // Issue #21: persist the completed assistant message (with its references).
  // Runs that throw or are cancelled before this point leave only the user
  // message persisted — the assistant turn never completed.
  //
  // Shell-approval boundary turns persist their exchange (user message →
  // "The Agent needs approval…" text) EXACTLY like the desktop: lib.rs's
  // command wrappers call AgentSessionStore::append_turn unconditionally for
  // every successful AgentChatResponse, including one that stopped at
  // SHELL_APPROVAL_REQUIRED_OBSERVATION — so the shared session file (and the
  // web's SQLite record, which the open UI restores from on reload) carries
  // the full boundary transcript across clients. The resumed turn (with
  // approvedShellCommands) appends its own exchange beneath it, matching the
  // desktop's row order. user.ask boundaries still persist nothing: the form
  // description is UI scaffolding (its client appends the REAL answer once
  // submitted), and verify-user-ask pins that "no assistant scaffold row"
  // contract.
  if (finalText && !stoppedAtUserInput) {
    appendMessage(session.id, "assistant", finalText, finalReferences)
    // Shared cross-client record (desktop append_turn contract): completed
    // turns — and shell-approval boundary stops — append to
    // .llm-wiki/agent-sessions/<sessionId>.json unless the caller opted out
    // (persistSession: false — the desktop default is true). API/MCP callers
    // resuming this session on EITHER client hydrate their context from the
    // same file.
    if (request.persistSession !== false) {
      appendTurn({
        projectPath,
        projectId,
        sessionId: request.sessionId,
        user: request.message || "",
        assistant: finalText,
      })
    }
  }
  collectEventDone(eventsOut, request.sessionId)
  // Numeric projects-table id (chat:* taxonomy attribution, stage 5). The
  // caller only knows the project UUID; the row is resolved above.
  return { finalText, references: finalReferences, toolEvents, events: eventsOut, projectRowId: projectRow.id, userInputRequest: stoppedAtUserInput ? userInputForm : null }
}

export async function agentStartTurnStream({ projectId, request }) {
  // Desktop defaults (lib.rs): ui_<uuid> session ids, run_<uuid> run ids.
  const sessionId = (request.sessionId && String(request.sessionId).trim())
    ? String(request.sessionId).trim() : `ui_${crypto.randomUUID()}`
  const runId = (request.runId && String(request.runId).trim())
    ? String(request.runId).trim() : `run_${crypto.randomUUID()}`
  const req = { ...request, sessionId, runId }
  const abort = new AbortController()
  const key = runKey(projectId, sessionId, runId)
  runs.set(key, { abort, cancelled: false })
  // Holder so the catch below knows the numeric projects-row id even when
  // runLoop throws (terminal chat:done dual attribution).
  const attribution = {}
  // Run asynchronously; the invoke returns the runId immediately and the UI
  // awaits the "done" event on the SSE stream.
  void (async () => {
    try {
      const { finalText, references, projectRowId } = await runLoop({ request: req, projectId, stream: true, attribution, cancelToken: runs.get(key) })
      // The done agent-event carries the turn's accumulated text; emitEvent
      // duals it as chat:done (taxonomy stage 5) so a tab that missed the
      // deltas can finalize.
      emitEvent(sessionId, runId, { type: "done", text: finalText, references }, projectRowId)
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err)
      // A run cancelled mid-fetch surfaces as a bare AbortError from the
      // HTTP layer ("This operation was aborted"); the desktop reports the
      // cancellation itself ("Agent run cancelled", the same message the
      // loop's cancellation checkpoints throw). Normalize so the chat panel
      // sees one contract regardless of where the abort landed.
      const cancelled = runs.get(key)?.cancelled === true || /abort|cancel/i.test(rawMessage)
      const message = cancelled ? "Agent run cancelled" : rawMessage
      // Error site: error frames (and the companion textless done) have no
      // charter equivalent — they stay agent-event-only.
      emitEvent(sessionId, runId, { type: "error", message })
      emitEvent(sessionId, runId, { type: "done" })
      // But a tab previewing this run via chat:* frames has no agent-event
      // consumer — without a terminal dual its isStreaming stays true forever
      // and every send path is locked (review fix). Dual a terminal chat:done
      // mirroring the owning tab's catch-path outcome: cancelled runs end
      // silently (empty content ⇒ sse-sync resets the stream without adding a
      // message, parity with the owning tab's abort-like setStreaming(false));
      // failed runs finalize with the same "Error: <message>" text the owning
      // tab renders. Direct emit so the agent-event stream stays
      // byte-identical (emitEvent would add an extra done agent-event).
      const projectRowId = attribution.projectRowId ?? null
      if (projectRowId != null) {
        emit(EventTypes.CHAT_DONE, {
          sessionId,
          runId,
          projectId: projectRowId,
          content: cancelled ? "" : `Error: ${message}`,
          references: [],
        })
      }
    } finally {
      runs.delete(key)
    }
  })()
  return runId
}

export async function agentStartTurn({ projectId, request }) {
  // Desktop defaults (lib.rs): ui_<uuid> session ids, run_<uuid> run ids.
  const sessionId = (request.sessionId && String(request.sessionId).trim())
    ? String(request.sessionId).trim() : `ui_${crypto.randomUUID()}`
  const runId = (request.runId && String(request.runId).trim())
    ? String(request.runId).trim() : `run_${crypto.randomUUID()}`
  const req = { ...request, sessionId, runId }
  const abort = new AbortController()
  const key = runKey(projectId, sessionId, runId)
  runs.set(key, { abort, cancelled: false })
  try {
    const { finalText, references, toolEvents, events, userInputRequest } = await runLoop({ request: req, projectId, stream: false, cancelToken: runs.get(key) })
    return {
      sessionId, mode: request.mode, message: finalText, references, toolEvents,
      ...(Array.isArray(events) && events.length ? { events } : {}),
      ...(userInputRequest ? { userInputRequest } : {}),
    }
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err)
    const cancelled = runs.get(key)?.cancelled === true || /abort|cancel/i.test(rawMessage)
    throw cancelled ? new Error("Agent run cancelled") : err
  } finally {
    runs.delete(key)
  }
}

// Desktop AgentCancellationRegistry::cancel (src-tauri/src/agent/cancel.rs):
// exact-run-key match when a runId is given (also honors the legacy web
// runId-only lookup), otherwise the whole session prefix for a project.
export async function agentCancelTurn(args = {}) {
  const projectId = args?.projectId
  const sessionId = args?.sessionId
  const runId = args?.runId ?? args?.requestId
  const targets = []
  for (const { 0: key, 1: entry } of runs) targets.push({ key, entry })
  let entry = null
  if (runId) {
    const normalized = normalizeRunKeyPart(runId)
    if (projectId != null || sessionId != null) {
      entry = runs.get(runKey(projectId, sessionId, runId)) ?? null
    }
    if (!entry) {
      entry = targets.find(({ key: k }) => k.endsWith(`::${normalized}`))?.entry ?? null
    }
  } else if (projectId != null && sessionId != null) {
    const prefix = sessionKeyPrefix(projectId, sessionId)
    entry = targets.find(({ key: k }) => k.startsWith(prefix))?.entry ?? null
  }
  if (!entry) return false
  entry.cancelled = true
  try { entry.abort.abort() } catch { /* noop */ }
  return true
}

// Desktop agent_get_session (lib.rs): read the last `limit` messages of an
// Agent session from the SHARED on-disk store — the same files the desktop
// writes, so either backend sees the same conversation. Default limit 40,
// clamped 1..200 like the Rust command.
export async function agentGetSession(args = {}) {
  const { projectId, sessionId, limit } = args
  if (!projectId || !sessionId) return null
  const store = readStore("app-state.json")
  const projectPath = projectPathFor(store, projectId)
  if (!projectPath) throw new Error(`Unknown project: ${projectId}`)
  const n = Number.isInteger(limit) ? Math.min(200, Math.max(1, limit)) : 40
  return recentMessages({ projectPath, sessionId, limit: n })
}

// Desktop agent_list_sessions (lib.rs): list the project's Agent session
// files (shared store), newest first.
export async function agentListSessions(args = {}) {
  const projectId = args?.projectId
  if (!projectId) return []
  const store = readStore("app-state.json")
  const projectPath = projectPathFor(store, projectId)
  if (!projectPath) throw new Error(`Unknown project: ${projectId}`)
  return listAgentSessionFiles(projectPath)
}
export async function agentListSkills(args = {}) { return listAvailableSkills(args.projectPath ?? "") }

export const agentCommands = {
  agent_start_turn: (a) => agentStartTurn(a),
  agent_start_turn_stream: (a) => agentStartTurnStream(a),
  agent_cancel_turn: (a) => agentCancelTurn(a),
  agent_get_session: (a) => agentGetSession(a),
  agent_list_sessions: (a) => agentListSessions(a),
  agent_list_skills: (a) => agentListSkills(a),
}
