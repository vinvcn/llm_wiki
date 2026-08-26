import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import http from "node:http"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log("  ok  -", m) } else { fail++; console.log("  FAIL-", m) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function freePort() { return new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) }) }
async function waitFor(fn, t, what) { const s = Date.now(); while (Date.now() - s < t) { try { if (await fn()) return true } catch {} await sleep(80) } throw new Error("timeout: " + what) }
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body)
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c))
      res.on("end", () => { try { resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null, raw: buf }) } catch { resolve({ status: res.statusCode, raw: buf }) } })
    })
    r.on("error", reject); if (data) r.write(data); r.end()
  })
}

// Part 1: pure-function fixtures (from runtime.rs #[test]s)
const P = await import(new URL("../../packages/server/src/shell-policy.js", import.meta.url).href)
{
  ok(P.isShellCommandApproved("echo unsafe", []) === false, "approved: empty list -> false")
  ok(P.isShellCommandApproved("echo unsafe", ["echo other"]) === false, "approved: mismatch -> false")
  ok(P.isShellCommandApproved("echo safe", ["  echo safe  "]) === true, "approved: exact match (whitespace-trimmed) -> true")
  const project = "/Users/test/Project"
  ok(P.isShellCommandAllowedWithoutPrompt("cat ppt/index.html | head -100", [], project) === true, "workspace-local: relative pipe -> auto-allow")
  ok(P.isShellCommandAllowedWithoutPrompt("grep -n data-layout /Users/test/Project/agent-workspace/ppt/index.html | head -30", [], project) === true, "workspace-local: abs agent-workspace path -> auto-allow")
  ok(P.isShellCommandAllowedWithoutPrompt("mkdir -p deck && node scripts/validate.js deck/index.html", [], project) === true, "workspace-local: mkdir && node -> auto-allow")
  ok(P.isShellCommandAllowedWithoutPrompt("echo safe", ["echo safe"], project) === true, "workspace-local: approved list -> auto-allow")
  ok(P.isShellCommandAllowedWithoutPrompt("cat /Users/test/.agents/skills/skill/SKILL.md", [], project) === false, "external: abs path outside workspace -> needs approval")
  ok(P.isShellCommandAllowedWithoutPrompt("cp ~/Desktop/file.png images/file.png", [], project) === false, "external: ~ home ref -> needs approval")
  ok(P.isShellCommandAllowedWithoutPrompt("cat ../raw/secrets.txt", [], project) === false, "external: .. traversal -> needs approval")
  ok(P.isShellCommandAllowedWithoutPrompt("curl https://example.com/file", [], project) === false, "external: curl + url -> needs approval")
  ok(P.isShellCommandAllowedWithoutPrompt("OUT=/tmp/file.html echo x", [], project) === false, "external: /tmp env assignment -> needs approval")
  const probe = "test -f .baoyu-skills/baoyu-cover-image/EXTEND.md && echo 'project'; test -f \"${XDG_CONFIG_HOME:-$HOME/.config}/baoyu-skills/baoyu-cover-image/EXTEND.md\" && echo 'xdg'"
  ok(P.isSkillPreferenceProbeCommand(probe) === true, "preference probe detected")
  ok(P.skippedSkillPreferenceProbeSummary(probe).includes("do not retry"), "probe summary says do-not-retry")
  ok(P.isSkillPreferenceProbeCommand("echo hello") === false, "non-probe command not flagged")
  ok(P.SHELL_APPROVAL_REQUIRED_OBSERVATION === "shell.exec.approval_required", "approval-required marker matches desktop")
  ok(P.shellApprovalSummary("rm -rf /").includes("The Agent needs approval before it can run this command"), "approval summary text matches desktop")
  ok(P.SHELL_REQUIRES_SKILL_ERROR.includes("at least one skill is active"), "skills-gate error text matches desktop")
}

function wantsTool(messages) { return !messages.some((m) => m.role === "tool") }

function mockHandler(reqBody, res) {
  const messages = reqBody.messages ?? []
  const isStreaming = reqBody.stream === true
  const script = mockHandler.script
  
  if (wantsTool(messages)) {
    if (isStreaming) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const chunk = (delta, finish) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`
      res.write(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "shell.exec", arguments: "" } }] }))
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: script.command }) } }] }))
      res.write(chunk({}, "tool_calls"))
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "shell.exec", arguments: JSON.stringify({ command: script.command }) } }] } }] }))
    }
  } else {
    const answer = "completed after shell step"
    if (isStreaming) {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      const chunk = (delta, finish) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish ?? null }] })}\n\n`
      for (const word of answer.split(" ")) res.write(chunk({ role: "assistant", content: word + " " }))
      res.write(chunk({}, "stop"))
      res.end("data: [DONE]\n\n")
    } else {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer } }] }))
    }
  }
}

function createMockServer(script) {
  return {
    server: null,
    port: null,
    script,
    async start() {
      this.port = await freePort()
      this.server = http.createServer(async (req, res) => {
        let body = ""
        for await (const chunk of req) body += chunk
        if (req.url === "/v1/chat/completions") {
          try { mockHandler(JSON.parse(body), res) } catch (e) { res.writeHead(500); res.end(String(e)) }
        } else { res.writeHead(404); res.end("nope") }
      })
      await new Promise((resolve) => this.server.listen(this.port, resolve))
      await sleep(100)
    },
    stop() {
      if (this.server) this.server.close()
    }
  }
}

function sseCollect(port) {
  const events = []
  const rq = http.request({ host: "127.0.0.1", port, path: "/api/events", method: "GET" }, (res) => {
    let buf = ""
    res.on("data", (c) => { buf += c.toString(); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); for (const ln of blk.split("\n")) if (ln.startsWith("data:")) { try { events.push(JSON.parse(ln.slice(5).trim())) } catch {} } } })
  })
  rq.on("error", () => {}); rq.end()
  return { events, close: () => rq.destroy() }
}

const baseReq = (over) => ({ sessionId: "s", runId: "r-" + Math.random().toString(36).slice(2), message: "run a command", history: [], mode: "standard", tools: {}, ...over })

async function runTestCase(dataDir, projectPath, skillDir, mockPort, script, command, description) {
    const mock = createMockServer(script)
  // Set the command BEFORE starting the mock
  script.command = command
  await mock.start()

  // Update store config with the mock's actual port
  const storeData = {
    llmConfig: { provider: "custom", apiKey: "k", model: "m", customEndpoint: "http://127.0.0.1:" + mock.port + "/v1", apiMode: "chat_completions" },
    projectRegistry: { "proj-1": { id: "proj-1", path: projectPath, name: "project" } },
  }
  fs.writeFileSync(path.join(dataDir, "stores", "app-state.json"), JSON.stringify(storeData, null, 2))

  const port = await freePort()
  const child = spawn(process.execPath, ["packages/server/src/index.js"], {
    cwd: REPO,
    env: { ...process.env, LLM_WIKI_PORT: String(port), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let serverLog = ""
  child.stdout.on("data", (d) => serverLog += d); child.stderr.on("data", (d) => serverLog += d)

  try {
    await waitFor(async () => (await req(port, "GET", "/api/health")).status === 200, 8000, "server health")
    console.log("server up on", port)

    // Run the test case
    const result = await description(mock, port, req, baseReq, sseCollect, waitFor, sleep)
    return result
  } catch (err) {
    fail++
    console.log("  FAIL- " + description + ": " + err.message)
    console.log("--- server log ---\n" + serverLog.slice(-3000))
  } finally {
    child.kill("SIGKILL"); mock.stop()
  }
}

async function testSkillsGate(dataDir, projectPath, skillDir, mockPort, script, port, req, baseReq, sseCollect, waitFor, sleep) {
  script.command = "echo should-not-run"
  const r = await req(port, "POST", "/api/invoke/agent_start_turn", { projectId: "proj-1", request: baseReq({ skills: [] }) })
  const ev = r.json?.toolEvents?.find((t) => t.tool === "shell.exec")
  ok(ev?.status === "failed" && /only available when at least one skill is active/.test(ev?.detail ?? ""), "skills gate rejects shell.exec (got " + JSON.stringify(ev) + ")")
}

async function testApprovalStep(dataDir, projectPath, skillDir, mockPort, script, port, req, baseReq, sseCollect, waitFor, sleep) {
  script.command = "cat /etc/hostname"
  const r = await req(port, "POST", "/api/invoke/agent_start_turn", { projectId: "proj-1", request: baseReq({ skills: ["test-skill"] }) })
  const ev = r.json?.toolEvents?.find((t) => t.tool === "shell.exec")
  ok(ev?.status === "available" && ev?.detail === "approval required: cat /etc/hostname", "approval step status=available + exact detail (got " + JSON.stringify(ev) + ")")
  ok(/The Agent needs approval before it can run this command/.test(r.json?.message ?? ""), "turn ends with the desktop approval message")
  ok(/`cat \/etc\/hostname`/.test(r.json?.message ?? ""), "approval message names the command")
}

async function testStreamingApproval(dataDir, projectPath, skillDir, mockPort, script, port, req, baseReq, sseCollect, waitFor, sleep) {
  // The desktop's actual approval contract on the streaming path
  // (runtime.rs run_agent_loop): the shell.exec approval request does NOT
  // park the run — the loop returns the `shell.exec.approval_required`
  // observation, emits MessageDelta("The Agent needs approval…") + Done,
  // and the response carries user_input_request: None. The frontend's Approve
  // button (driven by the `available`→skipped shell_exec step, detail
  // `approval required: <cmd>`) resumes a NEW turn with approvedShellCommands.
  script.command = "cat /etc/hostname"
  const sse = sseCollect(port); await sleep(300)
  const runId = baseReq({ skills: ["test-skill"] }).runId
  await req(port, "POST", "/api/invoke/agent_start_turn_stream", { projectId: "proj-1", request: baseReq({ skills: ["test-skill"], runId }) })

  await waitFor(async () => sse.events.some((e) => e.event === "agent-event" && e.payload?.runId === runId && e.payload?.event?.type === "done"), 8000, "stream done at the approval boundary")
  const evs = sse.events.filter((e) => e.event === "agent-event" && e.payload?.runId === runId).map((e) => e.payload.event)
  const toolEnd = evs.find((e) => e.type === "toolEnd" && e.tool === "shell.exec")
  ok(toolEnd?.output === "approval required: cat /etc/hostname", "stream toolEnd carries exact 'approval required:' string (got " + JSON.stringify(toolEnd?.output) + ")")
  const md = evs.find((e) => e.type === "messageDelta")
  ok(typeof md?.text === "string" && md.text.includes("The Agent needs approval before it can run this command"), "stream emits MessageDelta with the desktop approval text (stateless boundary, no parked run)")
  ok(!evs.some((e) => e.type === "userInputRequired"), "stream emits NO userInputRequired for shell approval (runtime.rs: user_input_request None)")
  const done = evs.find((e) => e.type === "done")
  ok(!!done, "stream emits done at the boundary")
  sse.close()

  // Stateless resume (the frontend's Approve button): a NEW turn carrying
  // approvedShellCommands runs the command and completes.
  const resume = await req(port, "POST", "/api/invoke/agent_start_turn", {
    projectId: "proj-1",
    request: baseReq({ skills: ["test-skill"], approvedShellCommands: ["cat /etc/hostname"], runId: baseReq({}).runId }),
  })
  const ev = resume.json?.toolEvents?.filter((t) => t.tool === "shell.exec").pop()
  ok(ev?.status === "completed", "resumed stream turn runs the approved command (status=completed, got " + JSON.stringify(ev) + ")")
  ok(/completed after shell step/.test(resume.json?.message ?? ""), "resumed turn continues to the model answer after running")
}

async function testPreApproved(dataDir, projectPath, skillDir, mockPort, script, port, req, baseReq, sseCollect, waitFor, sleep) {
  script.command = "echo approved-run"
  const r = await req(port, "POST", "/api/invoke/agent_start_turn", { projectId: "proj-1", request: baseReq({ skills: ["test-skill"], approvedShellCommands: ["echo approved-run"] }) })
  const ev = r.json?.toolEvents?.filter((t) => t.tool === "shell.exec").pop()
  ok(ev?.status === "completed", "approved command runs (status=completed, got " + JSON.stringify(ev) + ")")
  ok(/completed after shell step/.test(r.json?.message ?? ""), "turn continues to the model answer after running")
}

async function testWorkspaceScoped(dataDir, projectPath, skillDir, mockPort, script, port, req, baseReq, sseCollect, waitFor, sleep) {
  script.command = "echo workspace-ok"
  const r = await req(port, "POST", "/api/invoke/agent_start_turn", { projectId: "proj-1", request: baseReq({ skills: ["test-skill"] }) })
  const ev = r.json?.toolEvents?.filter((t) => t.tool === "shell.exec").pop()
  ok(ev?.status === "completed", "workspace-scoped command auto-allowed (got " + JSON.stringify(ev) + ")")
}

// Main
const script = { command: "" }

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lw-shell-"))
const projectPath = path.join(dataDir, "proj")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.mkdirSync(path.join(projectPath, "raw", "sources"), { recursive: true })
fs.mkdirSync(path.join(projectPath, ".llm-wiki"), { recursive: true })
fs.mkdirSync(path.join(dataDir, "stores"), { recursive: true })
const skillDir = path.join(projectPath, ".llm-wiki", "skills", "test-skill")
fs.mkdirSync(path.join(skillDir, "references"), { recursive: true })
fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: test-skill\ndescription: A test skill that runs shell commands.\n---\nUse shell.exec to run commands when needed.\n")

mockHandler.script = script

try {
  await runTestCase(dataDir, projectPath, skillDir, null, script, "skills-gate", async (mock, port, req, baseReq, sseCollect, waitFor, sleep) => {
    await testSkillsGate(dataDir, projectPath, skillDir, null, script, port, req, baseReq, sseCollect, waitFor, sleep)
  })
  await runTestCase(dataDir, projectPath, skillDir, null, script, "approval-step", async (mock, port, req, baseReq, sseCollect, waitFor, sleep) => {
    await testApprovalStep(dataDir, projectPath, skillDir, null, script, port, req, baseReq, sseCollect, waitFor, sleep)
  })
  await runTestCase(dataDir, projectPath, skillDir, null, script, "streaming-approval", async (mock, port, req, baseReq, sseCollect, waitFor, sleep) => {
    await testStreamingApproval(dataDir, projectPath, skillDir, null, script, port, req, baseReq, sseCollect, waitFor, sleep)
  })
  await runTestCase(dataDir, projectPath, skillDir, null, script, "pre-approved", async (mock, port, req, baseReq, sseCollect, waitFor, sleep) => {
    await testPreApproved(dataDir, projectPath, skillDir, null, script, port, req, baseReq, sseCollect, waitFor, sleep)
  })
  await runTestCase(dataDir, projectPath, skillDir, null, script, "workspace-scoped", async (mock, port, req, baseReq, sseCollect, waitFor, sleep) => {
    await testWorkspaceScoped(dataDir, projectPath, skillDir, null, script, port, req, baseReq, sseCollect, waitFor, sleep)
  })
} catch (err) {
  fail++
  console.log("  FAIL- harness error:", err.message)
}

console.log("\nshell-approval: " + pass + " passed, " + fail + " failed")
process.exit(fail === 0 ? 0 : 1)
