// Claude Code CLI + Codex CLI transport acceptance harness.
//
// The web server runs on the user's host, so — exactly like the desktop —
// it spawns the locally-installed `claude` / `codex` binaries as chat
// backends (packages/server/src/cli.js, a faithful port of
// src-tauri/src/commands/claude_cli.rs, codex_cli.rs, cli_resolver.rs).
// This harness proves the port against the DESKTOP'S OWN contract:
//
//  PART 1 — pure unit fixtures replaying the Rust #[cfg(test)] assertions
//           (arg vectors incl. isolation flags, ISOLATED_MCP_CONFIG, codex
//           timeout clamps, frontend image-block -> Anthropic-shape mapping,
//           system-preamble merge rules, login-shell PATH marker parsing).
//  PART 2 — integration: boot the real server twice with FAKE `claude` /
//           `codex` executables on PATH (never the user's real CLIs — the
//           asserted detect.path proves the fake was used) and drive
//           detect / spawn / kill over /api/invoke, asserting the exact SSE
//           stream (`claude-cli:{id}` line events -> `:done {code,stderr}`)
//           and what the server wrote to the CLI's stdin/argv (system
//           preamble folded into the first user turn, block-array content,
//           raw codex prompt), plus every working-directory / not-found /
//           empty-prompt error string verbatim from the Rust source.
//
//   node scripts/verify/verify-cli-transports.mjs

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

function freePort() {
  return new Promise((res) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })
}
async function waitFor(fn, t, what) {
  const start = Date.now()
  while (Date.now() - start < t) { try { if (await fn()) return true } catch {} await sleep(60) }
  throw new Error(`timeout waiting for ${what}`)
}
function req(port, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body)
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c))
      res.on("end", () => { try { resolve({ status: res.statusCode, json: buf ? JSON.parse(buf) : null }) } catch { resolve({ status: res.statusCode, raw: buf }) } })
    })
    r.on("error", reject); if (data) r.write(data); r.end()
  })
}

// ════════════════════════════════════════════════════════════════════════
// PART 1 — pure unit fixtures (the desktop's own Rust test assertions)
// ════════════════════════════════════════════════════════════════════════
const {
  buildClaudeCliArgs, buildCodexCliArgs, codexSpawnTimeoutMinutes,
  contentBlocks, mergeSystemPreamble, parseShellPathOutput,
} = await import(path.join(REPO, "packages/server/src/cli.js"))

console.log("part 1: pure contract fixtures (Rust #[cfg(test)] replay)")
{
  const ISOLATED_MCP_CONFIG = '{"mcpServers":{}}'

  // claude_args_do_not_isolate_local_config_by_default
  const a0 = buildClaudeCliArgs("sonnet", false)
  ok(JSON.stringify(a0) === JSON.stringify([
    "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--model", "sonnet",
  ]), `claude default args exact (got ${JSON.stringify(a0)})`)
  ok(!a0.includes("--setting-sources") && !a0.includes("--strict-mcp-config") && !a0.includes("--mcp-config") && !a0.includes("--disable-slash-commands"), "claude default args carry no isolation flags")

  // claude_args_can_isolate_user_config_tools_and_mcp
  const a1 = buildClaudeCliArgs("sonnet", true)
  const pair = (args, flag) => { const i = args.indexOf(flag); return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined }
  ok(pair(a1, "--setting-sources") === "project", "claude isolate: --setting-sources project")
  ok(a1.includes("--strict-mcp-config"), "claude isolate: --strict-mcp-config")
  ok(pair(a1, "--mcp-config") === ISOLATED_MCP_CONFIG, "claude isolate: --mcp-config is exactly {\"mcpServers\":{}}")
  ok(JSON.parse(ISOLATED_MCP_CONFIG).mcpServers && Object.keys(JSON.parse(ISOLATED_MCP_CONFIG).mcpServers).length === 0, "ISOLATED_MCP_CONFIG parses to empty mcpServers object")
  ok(a1.includes("--disable-slash-commands"), "claude isolate: --disable-slash-commands")
  ok(pair(a1, "--tools") === "", "claude isolate: --tools empty-string")
  ok(a1.includes("--no-session-persistence"), "claude isolate: --no-session-persistence")
  ok(pair(a1, "--prompt-suggestions") === "false", "claude isolate: --prompt-suggestions false")
  ok(pair(a1, "--model") === "sonnet" && a1[a1.length - 1] === "sonnet", "claude isolate: --model last")

  // codex_args_do_not_isolate_local_config_by_default
  const c0 = buildCodexCliArgs("gpt-5", false)
  ok(JSON.stringify(c0) === JSON.stringify([
    "-a", "never", "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--model", "gpt-5", "-",
  ]), `codex default args exact (got ${JSON.stringify(c0)})`)
  ok(!c0.includes("--ignore-user-config") && !c0.includes("--ignore-rules"), "codex default args carry no isolation flags")

  // codex_args_can_isolate_user_config_and_rules (both AFTER `exec`)
  const c1 = buildCodexCliArgs("gpt-5", true)
  const execPos = c1.indexOf("exec")
  ok(execPos >= 0 && c1.indexOf("--ignore-user-config") > execPos && c1.indexOf("--ignore-rules") > execPos, "codex isolate: --ignore-user-config + --ignore-rules after exec")

  // codex_spawn_timeout_minutes_defaults_and_clamps
  ok(codexSpawnTimeoutMinutes(undefined) === 10, "codex timeout default 10")
  ok(codexSpawnTimeoutMinutes(0) === 1, "codex timeout clamps 0 -> 1")
  ok(codexSpawnTimeoutMinutes(42) === 42, "codex timeout passes 42 through")
  ok(codexSpawnTimeoutMinutes(999) === 240, "codex timeout clamps 999 -> 240")

  // claude_content_blocks_maps_frontend_image_blocks_to_anthropic_shape
  const blocks = contentBlocks([
    { type: "text", text: "describe this" },
    { type: "image", mediaType: "image/png", dataBase64: "abc123" },
  ])
  ok(JSON.stringify(blocks) === JSON.stringify([
    { type: "text", text: "describe this" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
  ]), "contentBlocks maps frontend image blocks to Anthropic source shape")
  ok(JSON.stringify(contentBlocks("plain string")) === JSON.stringify([{ type: "text", text: "plain string" }]), "contentBlocks wraps a plain string into one text block")

  // system_preamble_merges_into_existing_user_text_block
  const merged = mergeSystemPreamble([
    { type: "text", text: "Output the token" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
  ], "System instructions")
  ok(merged.length === 2 && merged[0].text === "System instructions\n\nOutput the token" && merged[1].type === "image", "preamble merges into the first existing text block")

  // system_preamble_adds_text_block_only_for_image_only_turn
  const mergedImg = mergeSystemPreamble([
    { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
  ], "System instructions")
  ok(mergedImg.length === 2 && mergedImg[0].type === "text" && mergedImg[0].text === "System instructions" && mergedImg[1].type === "image", "image-only turn gets a leading preamble text block")

  // login-shell PATH marker parsing (cli_resolver.rs PRINTF_CMD contract)
  ok(parseShellPathOutput("\x1ePATH=/a:/b\x1e\n") === "/a:/b", "parseShellPathOutput extracts the marker-delimited PATH")
  ok(parseShellPathOutput("bash: some rc banner\n\x1ePATH=/x\x1e\n") === "/x", "parseShellPathOutput ignores rc banners before the marker")
  ok(parseShellPathOutput("no marker here\n") === null, "parseShellPathOutput returns null without a marker")
}

// ════════════════════════════════════════════════════════════════════════
// PART 2 — integration: real server + FAKE claude/codex on PATH
// ════════════════════════════════════════════════════════════════════════
console.log("part 2: integration with fake CLIs over /api/invoke + SSE")

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lw-cli-"))
const fakeBin = path.join(tmp, "bin")
fs.mkdirSync(fakeBin)
const projectPath = path.join(tmp, "project")
fs.mkdirSync(path.join(projectPath, "wiki"), { recursive: true })
fs.writeFileSync(path.join(projectPath, "wiki", "index.md"), "# Index\n")
const notProjectDir = path.join(tmp, "not-a-project")
fs.mkdirSync(notProjectDir, { recursive: true })
const notProjectFile = path.join(tmp, "just-a-file")
fs.writeFileSync(notProjectFile, "not a directory")

// The fake CLIs switch behavior on the --model value (so one server can
// exercise every mode): ok (default) | fail | hang | big.
// Every invocation records its argv (claude.args.N / codex.args.N) and, for
// spawns, its stdin (claude.stdin.N / codex.stdin.N), N = call ordinal.
fs.writeFileSync(path.join(fakeBin, "claude"), `#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
n=$(cat "$DIR/claude.count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$DIR/claude.count"
printf '%s\\n' "$@" > "$DIR/claude.args.$n"
if [ "\${1:-}" = "--version" ]; then echo "9.9.9-fake-claude"; exit 0; fi
cat > "$DIR/claude.stdin.$n"
model=""; prev=""
for a in "$@"; do if [ "$prev" = "--model" ]; then model="$a"; fi; prev="$a"; done
case "$model" in
  fail) echo "Unauthenticated: please run /login" >&2; exit 2 ;;
  hang) exec sleep 30 ;;
  *)
    echo '{"type":"system","subtype":"init","session_id":"fake-session"}'
    echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello from fake claude"}]}}'
    echo '{"type":"result","subtype":"success","result":"Hello from fake claude"}'
    exit 0 ;;
esac
`)
fs.writeFileSync(path.join(fakeBin, "codex"), `#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
n=$(cat "$DIR/codex.count" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$DIR/codex.count"
printf '%s\\n' "$@" > "$DIR/codex.args.$n"
if [ "\${1:-}" = "--version" ]; then echo "9.9.9-fake-codex"; exit 0; fi
cat > "$DIR/codex.stdin.$n"
model=""; prev=""
for a in "$@"; do if [ "$prev" = "--model" ]; then model="$a"; fi; prev="$a"; done
case "$model" in
  fail) echo "codex fake failure: bad model" >&2; exit 3 ;;
  hang) exec sleep 30 ;;
  big)  head -c $((1024 * 1024 + 16)) /dev/zero | tr '\\0' 'x'; echo; exit 0 ;;
  *)
    echo '{"type":"item.completed","item":{"type":"agent_message","text":"codex ok line one"}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}'
    exit 0 ;;
esac
`)
fs.chmodSync(path.join(fakeBin, "claude"), 0o755)
fs.chmodSync(path.join(fakeBin, "codex"), 0o755)

const callOrdinal = (cli) => {
  const f = path.join(fakeBin, `${cli}.count`)
  return fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8").trim()) : 0
}

function sseCollect(port) {
  const events = []
  const rq = http.request({ host: "127.0.0.1", port, path: "/api/events", method: "GET" }, (res) => {
    let buf = ""
    res.on("data", (c) => {
      buf += c.toString(); let idx
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2)
        for (const line of block.split("\n")) if (line.startsWith("data:")) { try { events.push(JSON.parse(line.slice(5).trim())) } catch {} }
      }
    })
  })
  rq.on("error", () => {}); rq.end()
  return { events, close: () => rq.destroy() }
}

async function startServer(env) {
  const port = await freePort()
  const child = spawn(process.execPath, ["packages/server/src/index.js"], {
    cwd: REPO,
    env: { ...process.env, LLM_WIKI_PORT: String(port), LLM_WIKI_NO_SHARE: "1", LLM_WIKI_DATA_DIR: path.join(tmp, `data-${port}`), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let serverLog = ""
  child.stdout.on("data", (d) => (serverLog += d)); child.stderr.on("data", (d) => (serverLog += d))
  await waitFor(async () => (await req(port, "GET", "/api/health")).status === 200, 8000, `server health (${port})`)
  return { port, child, getLog: () => serverLog }
}

const waitDone = (sse, topic, ms = 10000) => waitFor(
  () => sse.events.some((e) => e.event === `${topic}:done`), ms, `${topic}:done`,
).then(() => sse.events.find((e) => e.event === `${topic}:done`).payload)

// ── Server A: fake CLIs first on PATH ────────────────────────────────────
const srvA = await startServer({ PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` })
const A = srvA.port
console.log("server A (fake CLIs) on", A)

try {
  const sse = sseCollect(A)
  await sleep(200)

  // detect — installed, exact version, path proves the FAKE is used
  {
    const r = await req(A, "POST", "/api/invoke/claude_cli_detect", {})
    const d = r.json
    ok(r.status === 200 && d.installed === true, `claude_cli_detect installed (got ${JSON.stringify(d)})`)
    ok(d.version === "9.9.9-fake-claude", `claude detect version from fake --version (got ${d.version})`)
    ok(d.path === path.join(fakeBin, "claude"), `claude detect path is the fake binary (got ${d.path})`)
    ok(d.error === null, "claude detect error is null")
  }
  {
    const r = await req(A, "POST", "/api/invoke/codex_cli_detect", {})
    const d = r.json
    ok(r.status === 200 && d.installed === true && d.version === "9.9.9-fake-codex" && d.path === path.join(fakeBin, "codex") && d.error === null,
      `codex_cli_detect installed with fake version/path (got ${JSON.stringify(d)})`)
  }

  // claude spawn — system preamble fold + image reshape + multi-turn stdin
  {
    const before = callOrdinal("claude")
    const streamId = "s-claude-ok"
    const r = await req(A, "POST", "/api/invoke/claude_cli_spawn", {
      streamId, model: "ok",
      messages: [
        { role: "system", content: "Sys A" },
        { role: "system", content: [{ type: "text", text: "Sys B" }, { type: "image", mediaType: "image/png", dataBase64: "zzz" }] },
        { role: "user", content: [{ type: "text", text: "describe this" }, { type: "image", mediaType: "image/png", dataBase64: "abc123" }] },
        { role: "assistant", content: "prior answer" },
        { role: "user", content: "follow up" },
      ],
      isolateLocalConfig: false, workingDirectory: projectPath,
    })
    ok(r.status === 200 && r.json === null, `claude_cli_spawn accepted (got ${r.status} ${JSON.stringify(r.json)})`)
    const done = await waitDone(sse, `claude-cli:${streamId}`)
    ok(done.code === 0, `claude done code 0 (got ${JSON.stringify(done.code)})`)
    ok(done.stderr === "", `claude done stderr empty (got ${JSON.stringify(done.stderr)})`)
    const lines = sse.events.filter((e) => e.event === `claude-cli:${streamId}`).map((e) => e.payload)
    ok(lines.length === 3 && lines.every((l) => typeof l === "string"), `claude streamed 3 raw string lines (got ${lines.length})`)
    ok(lines.some((l) => l.includes('"subtype":"init"')) && lines.some((l) => l.includes("Hello from fake claude")) && lines.some((l) => l.includes('"type":"result"')), "claude lines carry init/assistant/result stream-json events")
    ok(sse.events.some((e) => e.event === `claude-cli:${streamId}:done`), "claude :done event observed on the SSE bus")

    const n = callOrdinal("claude")
    ok(n === before + 1, "exactly one fake-claude invocation for the spawn")
    const argv = fs.readFileSync(path.join(fakeBin, `claude.args.${n}`), "utf8").trim().split("\n")
    ok(JSON.stringify(argv) === JSON.stringify(["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--model", "ok"]), `claude argv exact (got ${JSON.stringify(argv)})`)
    const stdinLines = fs.readFileSync(path.join(fakeBin, `claude.stdin.${n}`), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    ok(stdinLines.length === 3, `3 stream-json stdin turns: system folded, 2 system msgs dropped from turns (got ${stdinLines.length})`)
    const t1 = stdinLines[0]
    ok(t1.type === "user" && t1.message.role === "user", "turn 1 is a user event")
    ok(t1.message.content[0].text === "Sys A\n\nSys B\n\ndescribe this", `preamble (both system msgs, images dropped) folded into first user text block (got ${JSON.stringify(t1.message.content[0])})`)
    ok(JSON.stringify(t1.message.content[1]) === JSON.stringify({ type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } }), "turn 1 image block reshaped to Anthropic source shape")
    const t2 = stdinLines[1]
    ok(t2.type === "assistant" && JSON.stringify(t2.message.content) === JSON.stringify([{ type: "text", text: "prior answer" }]), "assistant turn normalized to block array (content MUST be blocks)")
    const t3 = stdinLines[2]
    ok(t3.type === "user" && JSON.stringify(t3.message.content) === JSON.stringify([{ type: "text", text: "follow up" }]), "second user turn gets NO preamble")
  }

  // claude spawn — isolation arg vector end-to-end
  {
    const before = callOrdinal("claude")
    const streamId = "s-claude-iso"
    const r = await req(A, "POST", "/api/invoke/claude_cli_spawn", {
      streamId, model: "ok", messages: [{ role: "user", content: "hi" }],
      isolateLocalConfig: true, workingDirectory: projectPath,
    })
    ok(r.status === 200, "claude isolate spawn accepted")
    await waitDone(sse, `claude-cli:${streamId}`)
    const argv = fs.readFileSync(path.join(fakeBin, `claude.args.${before + 1}`), "utf8").trim().split("\n")
    ok(JSON.stringify(argv) === JSON.stringify([
      "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
      "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--disable-slash-commands", "--tools", "", "--no-session-persistence", "--prompt-suggestions", "false",
      "--model", "ok",
    ]), `claude isolation argv exact (got ${JSON.stringify(argv)})`)
  }

  // claude spawn — non-zero exit ships {code, stderr}
  {
    const streamId = "s-claude-fail"
    const r = await req(A, "POST", "/api/invoke/claude_cli_spawn", {
      streamId, model: "fail", messages: [{ role: "user", content: "hi" }],
      isolateLocalConfig: false, workingDirectory: projectPath,
    })
    ok(r.status === 200, "claude fail-mode spawn accepted")
    const done = await waitDone(sse, `claude-cli:${streamId}`)
    ok(done.code === 2, `claude fail done code 2 (got ${JSON.stringify(done.code)})`)
    ok(/Unauthenticated: please run \/login/.test(done.stderr), `claude fail done stderr carries the CLI diagnostic (got ${JSON.stringify(done.stderr)})`)
  }

  // claude kill — SIGKILL the parked child, done reports code null
  {
    const streamId = "s-claude-hang"
    const r = await req(A, "POST", "/api/invoke/claude_cli_spawn", {
      streamId, model: "hang", messages: [{ role: "user", content: "hi" }],
      isolateLocalConfig: false, workingDirectory: projectPath,
    })
    ok(r.status === 200, "claude hang-mode spawn accepted")
    await sleep(300)
    const k = await req(A, "POST", "/api/invoke/claude_cli_kill", { streamId })
    ok(k.status === 200 && k.json === null, "claude_cli_kill returns cleanly")
    const done = await waitDone(sse, `claude-cli:${streamId}`)
    ok(done.code === null, `killed claude done code is null (got ${JSON.stringify(done.code)})`)
    const k2 = await req(A, "POST", "/api/invoke/claude_cli_kill", { streamId: "never-existed" })
    ok(k2.status === 200 && k2.json === null, "claude_cli_kill is a no-op for unknown stream ids")
  }

  // claude spawn — error semantics (verbatim Rust strings + check order)
  {
    const cases = [
      [{ streamId: "x", model: "ok", messages: [{ role: "system", content: "only system" }], workingDirectory: undefined },
        "No user/assistant messages to send to claude CLI",
        "system-only history rejected BEFORE the working-dir check (Rust order)"],
      [{ streamId: "x", model: "ok", messages: [{ role: "user", content: "hi" }], workingDirectory: undefined },
        "Claude Code CLI requires an active project working directory", "missing working directory"],
      [{ streamId: "x", model: "ok", messages: [{ role: "user", content: "hi" }], workingDirectory: "   " },
        "Claude Code CLI requires an active project working directory", "blank working directory"],
      [{ streamId: "x", model: "ok", messages: [{ role: "user", content: "hi" }], workingDirectory: "relative/project" },
        "Claude Code CLI working directory must be an absolute project path", "relative working directory"],
      [{ streamId: "x", model: "ok", messages: [{ role: "user", content: "hi" }], workingDirectory: path.join(tmp, "missing-dir") },
        `Claude Code CLI working directory does not exist or cannot be read: ${path.join(tmp, "missing-dir")}`, "missing directory"],
      [{ streamId: "x", model: "ok", messages: [{ role: "user", content: "hi" }], workingDirectory: notProjectFile },
        `Claude Code CLI working directory is not a directory: ${notProjectFile}`, "file instead of directory"],
      [{ streamId: "x", model: "ok", messages: [{ role: "user", content: "hi" }], workingDirectory: notProjectDir },
        `Claude Code CLI working directory must be an LLM Wiki project containing wiki/index.md: ${notProjectDir}`, "directory without wiki/index.md"],
    ]
    for (const [args, msg, label] of cases) {
      const r = await req(A, "POST", "/api/invoke/claude_cli_spawn", args)
      ok(r.status === 500 && r.json?.error === msg, `claude spawn error: ${label} (got ${JSON.stringify(r.json?.error)})`)
    }
  }

  // codex spawn — raw prompt on stdin, exact argv, {code, stderr, stdout}
  {
    const before = callOrdinal("codex")
    const streamId = "s-codex-ok"
    const prompt = "Hello codex\nsecond line"
    const r = await req(A, "POST", "/api/invoke/codex_cli_spawn", {
      streamId, model: "ok", prompt, isolateLocalConfig: false, workingDirectory: projectPath,
    })
    ok(r.status === 200 && r.json === null, `codex_cli_spawn accepted (got ${r.status} ${JSON.stringify(r.json)})`)
    const done = await waitDone(sse, `codex-cli:${streamId}`)
    ok(done.code === 0 && done.stderr === "", `codex done code 0, empty stderr (got ${JSON.stringify({ code: done.code, stderr: done.stderr })})`)
    ok(done.stdout === JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex ok line one" } }) + "\n" + JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }) + "\n", `codex done stdout is the capped line-join (got ${JSON.stringify(done.stdout)})`)
    const lines = sse.events.filter((e) => e.event === `codex-cli:${streamId}`).map((e) => e.payload)
    ok(lines.length === 2 && lines[0].includes("item.completed") && lines[1].includes("turn.completed"), "codex streamed both stdout lines as raw strings")
    const n = callOrdinal("codex")
    ok(n === before + 1, "exactly one fake-codex invocation for the spawn")
    const argv = fs.readFileSync(path.join(fakeBin, `codex.args.${n}`), "utf8").trim().split("\n")
    ok(JSON.stringify(argv) === JSON.stringify(["-a", "never", "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--model", "ok", "-"]), `codex argv exact (got ${JSON.stringify(argv)})`)
    const stdin = fs.readFileSync(path.join(fakeBin, `codex.stdin.${n}`), "utf8")
    ok(stdin === prompt, `codex stdin is the RAW prompt, no newline added (got ${JSON.stringify(stdin)})`)
  }

  // codex spawn — isolation flags end-to-end
  {
    const before = callOrdinal("codex")
    const streamId = "s-codex-iso"
    const r = await req(A, "POST", "/api/invoke/codex_cli_spawn", {
      streamId, model: "ok", prompt: "hi", isolateLocalConfig: true, workingDirectory: projectPath,
    })
    ok(r.status === 200, "codex isolate spawn accepted")
    await waitDone(sse, `codex-cli:${streamId}`)
    const argv = fs.readFileSync(path.join(fakeBin, `codex.args.${before + 1}`), "utf8").trim().split("\n")
    ok(JSON.stringify(argv) === JSON.stringify(["-a", "never", "exec", "--ignore-user-config", "--ignore-rules", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--model", "ok", "-"]), `codex isolation argv exact (got ${JSON.stringify(argv)})`)
  }

  // codex spawn — non-zero exit
  {
    const streamId = "s-codex-fail"
    const r = await req(A, "POST", "/api/invoke/codex_cli_spawn", {
      streamId, model: "fail", prompt: "hi", isolateLocalConfig: false, workingDirectory: projectPath,
    })
    ok(r.status === 200, "codex fail-mode spawn accepted")
    const done = await waitDone(sse, `codex-cli:${streamId}`)
    ok(done.code === 3, `codex fail done code 3 (got ${JSON.stringify(done.code)})`)
    ok(/codex fake failure: bad model/.test(done.stderr), `codex fail stderr carries the diagnostic (got ${JSON.stringify(done.stderr)})`)
  }

  // codex kill
  {
    const streamId = "s-codex-hang"
    const r = await req(A, "POST", "/api/invoke/codex_cli_spawn", {
      streamId, model: "hang", prompt: "hi", isolateLocalConfig: false, workingDirectory: projectPath,
    })
    ok(r.status === 200, "codex hang-mode spawn accepted")
    await sleep(300)
    const k = await req(A, "POST", "/api/invoke/codex_cli_kill", { streamId })
    ok(k.status === 200 && k.json === null, "codex_cli_kill returns cleanly")
    const done = await waitDone(sse, `codex-cli:${streamId}`)
    ok(done.code === null, `killed codex done code is null (got ${JSON.stringify(done.code)})`)
  }

  // codex spawn — stdout cap: one 1MiB+16 line -> exactly 1MiB kept + marker
  {
    const streamId = "s-codex-big"
    const r = await req(A, "POST", "/api/invoke/codex_cli_spawn", {
      streamId, model: "big", prompt: "hi", isolateLocalConfig: false, workingDirectory: projectPath,
    })
    ok(r.status === 200, "codex big-mode spawn accepted")
    const done = await waitDone(sse, `codex-cli:${streamId}`, 20000)
    const MiB = 1024 * 1024
    ok(done.stdout === "x".repeat(MiB) + "\n[stdout truncated]", `codex stdout capped at exactly 1MiB + truncation marker (len ${done.stdout?.length})`)
  }

  // codex spawn — error semantics
  {
    const cases = [
      [{ streamId: "x", model: "ok", prompt: "", workingDirectory: projectPath }, "No prompt to send to codex CLI", "empty prompt"],
      [{ streamId: "x", model: "ok", prompt: "   ", workingDirectory: projectPath }, "No prompt to send to codex CLI", "whitespace-only prompt"],
      [{ streamId: "x", model: "ok", prompt: "hi", workingDirectory: undefined }, "Codex CLI requires an active project working directory", "missing working directory"],
      [{ streamId: "x", model: "ok", prompt: "hi", workingDirectory: "rel" }, "Codex CLI working directory must be an absolute project path", "relative working directory"],
      [{ streamId: "x", model: "ok", prompt: "hi", workingDirectory: notProjectDir }, `Codex CLI working directory must be an LLM Wiki project containing wiki/index.md: ${notProjectDir}`, "directory without wiki/index.md"],
    ]
    for (const [args, msg, label] of cases) {
      const r = await req(A, "POST", "/api/invoke/codex_cli_spawn", args)
      ok(r.status === 500 && r.json?.error === msg, `codex spawn error: ${label} (got ${JSON.stringify(r.json?.error)})`)
    }
  }
  sse.close()
} finally {
  srvA.child.kill("SIGKILL")
}

// ── Server B: scrubbed PATH -> faithful "not installed" detection ────────
// /bin/sh as SHELL keeps the login-shell PATH probe free of version-manager
// dirs, so `claude`/`codex` are genuinely unresolvable (they ARE installed
// on some hosts — e.g. via nvm — and must never be spawned by this harness).
{
  const srvB = await startServer({ PATH: "/usr/bin:/bin", SHELL: "/bin/sh" })
  const B = srvB.port
  console.log("server B (no CLIs) on", B)
  try {
    const r1 = await req(B, "POST", "/api/invoke/claude_cli_detect", {})
    const d1 = r1.json
    ok(r1.status === 200 && d1.installed === false && d1.version === null && d1.path === null && d1.error === "`claude` not found on PATH",
      `claude detect on scrubbed PATH: not installed + exact error (got ${JSON.stringify(d1)})`)
    const r2 = await req(B, "POST", "/api/invoke/codex_cli_detect", {})
    const d2 = r2.json
    ok(r2.status === 200 && d2.installed === false && d2.error === "`codex` not found on PATH",
      `codex detect on scrubbed PATH: not installed + exact error (got ${JSON.stringify(d2)})`)
    const r3 = await req(B, "POST", "/api/invoke/claude_cli_spawn", {
      streamId: "s-nf", model: "ok", messages: [{ role: "user", content: "hi" }], workingDirectory: projectPath,
    })
    ok(r3.status === 500 && r3.json?.error === "`claude` not found on PATH",
      `claude spawn without the binary propagates the exact not-found error (got ${JSON.stringify(r3.json?.error)})`)
    const r4 = await req(B, "POST", "/api/invoke/codex_cli_spawn", {
      streamId: "s-nf2", model: "ok", prompt: "hi", workingDirectory: projectPath,
    })
    ok(r4.status === 500 && r4.json?.error === "`codex` not found on PATH",
      `codex spawn without the binary propagates the exact not-found error (got ${JSON.stringify(r4.json?.error)})`)
  } finally {
    srvB.child.kill("SIGKILL")
  }
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\ncli-transports: ${pass}/${pass + fail} passed${fail ? ` (${fail} FAILED)` : ""}`)
process.exit(fail ? 1 : 0)
