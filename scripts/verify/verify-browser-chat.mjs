// Headless browser CHAT + SHELL-APPROVAL gate (durable; /tmp is volatile).
//
// Proves the app's core value proposition end-to-end through the REAL browser
// UI against a mock OpenAI-compatible LLM (no real key needed):
//
//   1. chat round-trip: send a message -> backend agent streams -> wiki.search
//      tool runs server-side -> tokens stream into the bubble -> final message
//      finalizes with the mock's answer. Clicks "New Chat" and types IMMEDIATELY,
//      which pins the new-chat race: the message must land in the server session
//      the sidebar shows as active (not a throwaway local conversation a late
//      activation would strand on an empty pane);
//   2. the desktop-faithful shell-exec approval boundary (runtime.rs
//      `SHELL_APPROVAL_REQUIRED_OBSERVATION`): the mock issues `shell.exec`
//      outside the workspace -> the turn STOPS at the boundary (no
//      userInputRequired, no parked run) with the exact "The Agent needs
//      approval…" message plus an `available`->skipped shell_exec step showing
//      `approval required: <cmd>` -> the Approve button resumes a new turn with
//      approvedShellCommands -> the command really executes, the mock re-issues
//      + answers -> the turn finalizes;
//   3. shared data + issue-#26 reload auto-open: the conversation persists to
//      <project>/.llm-wiki/ (conversations.json, chats/<id>.json AND the
//      server's shared agent-sessions/<sessionId>.json, the desktop's exact
//      formats), so a chat held on the web is resumable on the desktop. With
//      the client-held file copies removed (the crash-before-auto-save-window
//      scenario) a page reload auto-opens the most recent shared server session
//      with its full transcript restored — ZERO page errors, ZERO genuine
//      console errors, ZERO failed requests (tolerating only the documented
//      optional-state reads).
//
//   node scripts/verify/verify-browser-chat.mjs

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http from "node:http"
import { createRequire } from "node:module"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const pwRequire = createRequire("/tmp/pw/package.json")
const { chromium } = pwRequire("playwright-core")

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log("  ok  -", m) } else { fail++; console.log("  FAIL-", m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function freePort() { return new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) }) }
async function waitFor(fn, t, what) { const s = Date.now(); while (Date.now() - s < t) { try { if (await fn()) return true } catch {} await sleep(100) } throw new Error(`timeout: ${what}`) }

function findChromium() {
  const base = path.join(os.homedir(), ".cache", "ms-playwright")
  const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()
  for (const d of dirs) { const exe = path.join(base, d, "chrome-linux64", "chrome"); if (fs.existsSync(exe)) return exe }
  throw new Error("no chromium binary under ~/.cache/ms-playwright")
}

// ── Mock OpenAI-compatible LLM (stateless decision per call) ──────────────
// Looks at the last user message and whatever tool results followed it:
//   - no tool result yet + "shell command" in the prompt -> issue shell.exec
//   - no tool result yet + anything else                 -> issue wiki.search
//   - last tool result starts with "approved:"           -> re-issue the same
//     command (the desktop resume contract: the model runs the approved cmd)
//   - any other tool result                              -> final answer
const SHELL_CMD = "cat /etc/hostname"
const ANSWER_QUANTUM = "The quantum page describes quantum mechanics."
const ANSWER_SHELL = "Shell step completed successfully."
const mockCalls = []          // every chat/completions request body
function decide(messages) {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") { lastUserIdx = i; break }
  const lastUser = lastUserIdx >= 0 ? String(messages[lastUserIdx].content ?? "") : ""
  const after = messages.slice(lastUserIdx + 1)
  const lastTool = [...after].reverse().find((m) => m.role === "tool")
  if (!lastTool) {
    if (/shell command/i.test(lastUser)) return { tool: "shell.exec", args: { command: SHELL_CMD } }
    return { tool: "wiki.search", args: { query: "quantum" } }
  }
  const toolContent = String(lastTool.content ?? "")
  if (toolContent.startsWith("approved:")) {
    return { tool: "shell.exec", args: { command: toolContent.slice("approved:".length).trim() } }
  }
  if (/shell command/i.test(lastUser)) return { answer: ANSWER_SHELL }
  return { answer: ANSWER_QUANTUM }
}
function mockHandler(reqBody, res) {
  mockCalls.push(reqBody)
  const d = decide(reqBody.messages ?? [])
  const stream = !!reqBody.stream
  const chunk = (delta, finish) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`
  if (d.tool) {
    const id = "call_mock_" + mockCalls.length
    if (stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.write(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id, type: "function", function: { name: d.tool, arguments: "" } }] }))
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(d.args) } }] }))
      res.write(chunk({}, "tool_calls"))
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: d.tool, arguments: JSON.stringify(d.args) } }] } }] }))
    }
  } else {
    if (stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      for (const word of d.answer.split(" ")) res.write(chunk({ role: "assistant", content: word + " " }))
      res.write(chunk({}, "stop"))
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: d.answer } }] }))
    }
  }
}

// ── Fake "desktop" project on disk ────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-chat-"))
const dataDir = path.join(tmp, "data")
const storesDir = path.join(dataDir, "stores")
fs.mkdirSync(storesDir, { recursive: true })
const projectPath = path.join(tmp, "desktop-project")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.mkdirSync(path.join(projectPath, "raw", "sources"), { recursive: true })
// A project skill so the agent skills gate lets shell.exec through (the web
// UI sends every enabled skill in auto mode).
const skillDir = path.join(projectPath, ".llm-wiki", "skills", "test-skill")
fs.mkdirSync(skillDir, { recursive: true })
fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: test-skill\ndescription: A test skill that may run shell commands.\n---\nUse shell.exec to run commands when the user asks for it.\n")
fs.writeFileSync(path.join(projectPath, "schema.md"), "# Schema\n\nEntity pages describe things.\n")
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "---\ntype: overview\ntitle: Index\n---\n# Index\n\nHome page of the wiki.\n")
fs.writeFileSync(path.join(projectPath, "wiki", "quantum.md"), "---\ntype: entity\ntitle: Quantum Mechanics\n---\n# Quantum Mechanics\n\nQuantum mechanics is the study of matter at atomic and subatomic scales.\n")

// llmConfig points the server-side agent (and the UI's config view) at the
// mock. No projectRegistry/lastProject: the UI must open it via the picker.
fs.writeFileSync(path.join(storesDir, "app-state.json"), JSON.stringify({
  llmConfig: { provider: "custom", apiKey: "test-key", model: "mock-model", customEndpoint: "http://127.0.0.1:MOCK_PORT/v1", apiMode: "chat_completions" },
}, null, 2))

const mockPort = await freePort()
const mock = http.createServer((rq, rs) => {
  let buf = ""
  rq.on("data", (c) => (buf += c))
  rq.on("end", () => {
    if (rq.method === "POST" && rq.url.includes("/chat/completions")) {
      try { mockHandler(JSON.parse(buf), rs) } catch (e) { rs.writeHead(500); rs.end(String(e)) }
    } else { rs.writeHead(404); rs.end("nope") }
  })
})
await new Promise((r) => mock.listen(mockPort, r))
// Patch the mock port into the store now that it is known.
fs.writeFileSync(path.join(storesDir, "app-state.json"), JSON.stringify({
  llmConfig: { provider: "custom", apiKey: "test-key", model: "mock-model", customEndpoint: `http://127.0.0.1:${mockPort}/v1`, apiMode: "chat_completions" },
}, null, 2))

const port = await freePort()
const child = spawn(process.execPath, ["packages/server/src/index-v2.js"], {
  cwd: REPO,
  env: { ...process.env, LLM_WIKI_AUTH_MODE: "none", LLM_WIKI_PORT: String(port), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
})
let serverLog = ""
child.stdout.on("data", (d) => (serverLog += d)); child.stderr.on("data", (d) => (serverLog += d))

let browser
try {
  await waitFor(async () => {
    const r = await new Promise((res) => { const q = http.get({ host: "127.0.0.1", port, path: "/api/health" }, (x) => res(x.statusCode)); q.on("error", () => res(0)) })
    return r === 200
  }, 8000, "server health")

  browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
  const page = await browser.newPage()

  const pageErrors = []
  const consoleErrors = []
  const badResponses = []
  const optionalReads = []
  const dialogs = []
  page.on("pageerror", (e) => pageErrors.push(String(e)))
  page.on("console", (m) => {
    if (m.type() !== "error") return
    const t = m.text()
    if (/Failed to load resource/i.test(t)) return
    consoleErrors.push(t)
  })
  page.on("requestfailed", (r) => badResponses.push(`FAILED ${r.method()} ${r.url()} :: ${r.failure()?.errorText}`))
  page.on("response", (resp) => {
    if (resp.status() < 400) return
    const req = resp.request()
    const u = req.url()
    let detail = `HTTP ${resp.status()} ${req.method()} ${u}`
    let tolerated = false
    try {
      const body = req.postDataJSON?.() ?? {}
      const p = typeof body?.path === "string" ? body.path : ""
      const cmd = u.split("/api/invoke/").pop()
      if (p.includes("/.llm-wiki/") && (cmd === "read_file" || cmd === "list_directory")) {
        tolerated = true
        detail += ` [optional-state: ${cmd} ${p.replace(projectPath, "")}]`
      }
    } catch { /* non-json body */ }
    if (tolerated) optionalReads.push(detail)
    else badResponses.push(detail)
  })
  page.on("dialog", async (d) => { dialogs.push(`${d.type()}: ${d.message()}`); try { await d.dismiss() } catch {} })

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" })
  await page.waitForSelector("button:has-text('Open Project')", { timeout: 10000 })

  // ── Open the project through the server-backed picker (proven path) ─────
  await page.click("button:has-text('Open Project')")
  await page.waitForSelector(".lw-overlay", { timeout: 5000 })
  await page.waitForSelector(".lw-list .lw-row, .lw-list .lw-empty", { timeout: 5000 })
  const base = projectPath.split("/").filter(Boolean).pop()
  let navigated = false
  for (let attempt = 0; attempt < 4 && !navigated; attempt++) {
    await page.fill(".lw-pathbar input", projectPath)
    await page.click(".lw-pathbar button.lw-btn:has-text('Go')")
    try {
      await waitFor(async () => {
        const v = await page.inputValue(".lw-pathbar input")
        const btn = await page.textContent(".lw-btn.primary")
        return v === projectPath || (btn || "").includes(base)
      }, 2500, "picker navigated")
      navigated = true
    } catch { /* retry */ }
  }
  if (!navigated) throw new Error("picker did not navigate to the project path")
  await page.waitForSelector(`.lw-btn.primary:has-text('Select')`, { timeout: 5000 })
  await page.click(".lw-btn.primary")
  await waitFor(async () => (await page.$$(".lw-overlay")).length === 0, 5000, "picker closed")
  await page.waitForSelector("text=Quantum Mechanics", { timeout: 15000 })
  ok(true, "project opened via picker; Knowledge tree rendered")

  // ── Navigate to the Chat view (icon-sidebar nav: chat is the first item,
  //    but click through the nav items defensively and detect the view by its
  //    own content — the conversation sidebar's "New Chat" button or the empty
  //    "Start a new conversation" hint).
  const chatVisible = async () => {
    if (await page.$("button:has-text('New Chat')")) return true
    const hint = await page.$("text=Start a new conversation")
    return Boolean(hint)
  }
  const navTriggers = page.locator('[data-slot="tooltip-trigger"]')
  const navCount = Math.min(await navTriggers.count(), 9) // 7 nav items + research + skills
  let chatOpen = await chatVisible()
  for (let i = 0; i < navCount && !chatOpen; i++) {
    await navTriggers.nth(i).click()
    await sleep(300)
    chatOpen = await chatVisible()
  }
  if (!chatOpen) throw new Error("chat view did not open")
  ok(true, "chat view opened")

  await page.click("button:has-text('New Chat')")
  const taSel = 'textarea[placeholder^="Type a message"]'
  await page.waitForSelector(taSel, { timeout: 5000 })

  const noStreamingCursor = () => page.waitForFunction(() => !document.body.innerText.includes("\u258A"), { timeout: 20000 })

  // ── Turn 1: plain agent chat with a wiki.search tool round-trip ─────────
  await page.fill(taSel, "What is quantum mechanics about?")
  await page.press(taSel, "Enter")
  await page.waitForSelector(`text=${ANSWER_QUANTUM}`, { timeout: 20000 })
  await noStreamingCursor()
  const bodyAfterT1 = await page.evaluate(() => document.body.innerText)
  ok(bodyAfterT1.includes("What is quantum mechanics about?"), "turn 1: user message rendered")
  ok(bodyAfterT1.includes(ANSWER_QUANTUM), "turn 1: streamed assistant answer finalized")
  const wikiSearchCalls = mockCalls.filter((c) => JSON.stringify(c).includes("wiki.search"))
  ok(wikiSearchCalls.length >= 1, `turn 1: backend agent issued wiki.search to the mock (got ${wikiSearchCalls.length} call(s))`)
  ok(mockCalls.some((c) => (c.messages ?? []).some((m) => m.role === "tool" && /quantum/i.test(String(m.content ?? "")))), "turn 1: wiki.search result was fed back to the model")

  // ── Turn 2: shell.exec -> approval BOUNDARY -> Approve -> resume ────────
  // The desktop runtime (runtime.rs) does NOT park the run: the observation
  // ends the current loop turn, the assistant message finalizes with the
  // exact "The Agent needs approval…" summary, and the `available`->skipped
  // shell_exec step drives the Approve button (this gate used to expect a
  // live userInputRequired panel + checkbox, which was never the contract).
  await page.fill(taSel, "Please run the shell command now.")
  await page.press(taSel, "Enter")
  await page.waitForSelector("text=The Agent needs approval before it can run this command", { timeout: 20000 })
  await noStreamingCursor()
  ok(true, "turn 2: turn stopped at the approval boundary and finalized")
  const approvalBody = await page.evaluate(() => document.body.innerText)
  ok(
    approvalBody.includes("The Agent needs approval before it can run this command") &&
      approvalBody.includes("Approve the command if you want the Agent to continue with this skill."),
    "turn 2: exact desktop boundary summary rendered",
  )
  ok(approvalBody.includes(SHELL_CMD), "turn 2: the exact command is shown in the boundary summary")
  ok(approvalBody.includes(`approval required: ${SHELL_CMD}`), "turn 2: skipped shell_exec step carries the `approval required:` detail")
  const approveBtn = page.locator("button:has-text('Approve command')")
  await approveBtn.waitFor({ timeout: 5000 })
  const approveText = await approveBtn.textContent()
  ok(approveText && approveText.includes(SHELL_CMD), "turn 2: Approve button shows the exact command")
  ok(!approvalBody.includes("Submit and continue"), "turn 2: no live userInputRequired panel (runtime.rs has no parked run)")
  ok(mockCalls.length === 3, `turn 2: exactly one boundary mock call so far (got ${mockCalls.length})`)

  // Approve: the button resumes a new turn with approvedShellCommands.
  await approveBtn.click()

  // The resumed turn runs: the command REALLY executes, the mock re-issues
  // it (now allowlisted), answers, and the turn finalizes.
  await page.waitForSelector(`text=${ANSWER_SHELL}`, { timeout: 20000 })
  await noStreamingCursor()
  ok(true, "turn 2: resumed turn finalized with the mock's answer after approval")
  await sleep(500)
  const postApproveBody = await page.evaluate(() => document.body.innerText)
  ok(postApproveBody.includes(SHELL_CMD), "turn 2: approved command still visible in the saved turn history")
  ok(!postApproveBody.includes("Agent stream timed out"), "turn 2: no idle-timeout error")
  const hostname = fs.readFileSync("/etc/hostname", "utf8").trim()
  const executedEvidence = mockCalls.some((c) => (c.messages ?? []).some((m) => m.role === "tool" && String(m.content ?? "").includes(hostname)))
  ok(executedEvidence, `turn 2: approved command really executed (tool result carries hostname '${hostname}')`)
  // Desktop resume contract (runtime.rs + the shared client): the resumed
  // turn re-issues the EXACT approved command as a shell.exec tool call, and
  // the executed observation (the desktop `shell.exec \`…\` exit=… stdout:`
  // summary) is fed back to the model. (There is no "approved:" marker in the
  // desktop contract — neither runtime.rs nor the shared React client ever
  // emits one; the mock's `approved:` branch above is just a generic
  // re-issue path.)
  const shellToolCalls = mockCalls.flatMap((c) =>
    (c.messages ?? []).filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls)).flatMap((m) => m.tool_calls)
  )
  const reIssued = shellToolCalls.some((tc) => {
    if (tc.function?.name !== "shell.exec") return false
    try { return JSON.parse(tc.function.arguments ?? "{}").command === SHELL_CMD } catch { return false }
  })
  ok(reIssued, "turn 2: resumed turn re-issued the exact approved command as a tool call")
  ok(mockCalls.some((c) => (c.messages ?? []).some((m) => m.role === "tool" && String(m.content ?? "").includes("shell.exec") && String(m.content ?? "").includes(SHELL_CMD))), "turn 2: model saw the executed shell.exec observation fed back")

  // ── Turn 3: shared data reached the desktop's files ──────────────────────

  // ── Shared data: the conversation reached the desktop's files ───────────
  const convFile = path.join(projectPath, ".llm-wiki", "conversations.json")
  const chatsDir = path.join(projectPath, ".llm-wiki", "chats")
  const agentSessionsDir = path.join(projectPath, ".llm-wiki", "agent-sessions")
  await waitFor(() => fs.existsSync(convFile) && fs.existsSync(chatsDir) && fs.readdirSync(chatsDir).length > 0, 15000, "chat persisted to .llm-wiki")
  // Auto-save is debounced; give the last turn a moment to flush.
  await sleep(1500)
  const chatFiles = fs.readdirSync(chatsDir).filter((f) => f.endsWith(".json"))
  let chatJson = []
  for (const f of chatFiles) {
    try { chatJson = chatJson.concat(JSON.parse(fs.readFileSync(path.join(chatsDir, f), "utf8"))) } catch {}
  }
  const texts = chatJson.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n")
  ok(chatJson.some((m) => m.role === "user" && /quantum mechanics about/.test(String(m.content))), "persisted chat has turn-1 user message")
  ok(texts.includes(ANSWER_QUANTUM), "persisted chat has turn-1 assistant answer")
  ok(texts.includes(ANSWER_SHELL), "persisted chat has turn-2 approved-run answer")
  ok(fs.existsSync(agentSessionsDir) && fs.readdirSync(agentSessionsDir).some((f) => f.endsWith(".json")), "shared agent-sessions/<sessionId>.json written (desktop format)")

  // ── Issue #26 reload auto-open (shared server sessions) ──────────────────
  // Remove the client-held conversations.json + chats/* copies (the
  // crash-before-auto-save-flush window) and reload: with no local copies,
  // the app must auto-open the most recent shared server session and restore
  // its full transcript from the server — a chat held on the web is
  // resumable on the desktop.
  const preReloadErrors = pageErrors.length
  const preReloadConsole = consoleErrors.length
  const preReloadBad = badResponses.length
  fs.rmSync(convFile, { force: true })
  fs.rmSync(chatsDir, { recursive: true, force: true })
  await page.reload({ waitUntil: "domcontentloaded" })
  // lastProject (server store) auto-opens; wait for the Knowledge tree.
  await page.waitForSelector("text=Quantum Mechanics", { timeout: 15000 })
  await sleep(500)
  let chatOpenAfterReload = await chatVisible()
  const navTriggers2 = page.locator('[data-slot="tooltip-trigger"]')
  const navCount2 = Math.min(await navTriggers2.count(), 9)
  for (let i = 0; i < navCount2 && !chatOpenAfterReload; i++) {
    await navTriggers2.nth(i).click()
    await sleep(300)
    chatOpenAfterReload = await chatVisible()
  }
  if (!chatOpenAfterReload) throw new Error("reload: chat view did not open")
  // The most recent server session must auto-open with its full transcript.
  await page.waitForSelector(`text=${ANSWER_QUANTUM}`, { timeout: 15000 })
  await page.waitForSelector(`text=${ANSWER_SHELL}`, { timeout: 15000 })
  const reloadedBody = await page.evaluate(() => document.body.innerText)
  ok(reloadedBody.includes("What is quantum mechanics about?"), "reload: turn-1 user message restored from the server")
  ok(reloadedBody.includes("Please run the shell command now."), "reload: turn-2 user message restored from the server")
  ok(reloadedBody.includes("The Agent needs approval before it can run this command"), "reload: approval-boundary summary restored from the server")
  ok(pageErrors.length === preReloadErrors, "reload: ZERO new page errors")
  ok(consoleErrors.length === preReloadConsole, "reload: ZERO new console errors")
  ok(badResponses.length === preReloadBad, "reload: ZERO new non-optional failed/4xx/5xx requests")

  // ── Cleanliness ──────────────────────────────────────────────────────────
  await sleep(500)
  ok(dialogs.length === 0, `ZERO alert/confirm dialogs (got ${dialogs.length}: ${dialogs.slice(0, 3).join(" | ")})`)
  ok(pageErrors.length === 0, `ZERO page errors (got ${pageErrors.length}: ${pageErrors.slice(0, 3).join(" | ")})`)
  ok(consoleErrors.length === 0, `ZERO console errors (got ${consoleErrors.length}: ${consoleErrors.slice(0, 3).join(" | ")})`)
  ok(badResponses.length === 0, `ZERO non-optional failed/4xx/5xx requests (got ${badResponses.length}: ${badResponses.slice(0, 4).join(" | ")})`)
  console.log(`        (${optionalReads.length} tolerated optional-state reads)`)

  if (fail > 0) {
    try { await page.screenshot({ path: "/tmp/lw-chat-fail.png", fullPage: true }); console.log("  screenshot -> /tmp/lw-chat-fail.png") } catch {}
  }
} catch (err) {
  fail++
  console.log("  FAIL- harness error:", err.message)
  console.log("--- server log ---\n" + serverLog.slice(-1500))
} finally {
  try { await browser?.close() } catch {}
  child.kill("SIGKILL")
  mock.close()
}

console.log(`\nbrowser-chat: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
