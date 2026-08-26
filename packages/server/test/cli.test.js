// Faithful Node port verification for the external CLI chat transports
// (packages/server/src/cli.js — claude_cli.rs / codex_cli.rs / cli_resolver.rs).
//
// Part 1 re-runs the desktop's own Rust unit-test fixtures verbatim against
// the ported pure functions (argument vectors, timeout clamping, shell-PATH
// marker parsing, content-shaping, and the codex stdout/stderr byte-cap).
//
// Part 2 drives the REAL registry (`dispatch`) against executable mock
// `claude` / `codex` binaries on a temp PATH — the same contract the
// unmodified frontend uses: detect returns the desktop's
// {installed,version,path,error} shape; spawn pipes stream-json turns /
// prompt over stdin with the desktop's exact arg vector; each stdout line is
// broadcast as `claude-cli:{sid}` / `codex-cli:{sid}`, and a terminal
// `:done` carries {code,stderr[,stdout]}; non-zero exits relay stderr; kill
// yields {code:null}; and all four working-directory guards match the Rust
// error strings.
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  buildClaudeCliArgs,
  buildCodexCliArgs,
  codexSpawnTimeoutMinutes,
  parseShellPathOutput,
  appendCappedLine,
  contentBlocks,
  mergeSystemPreamble,
  writeToStdin,
} from "../src/cli.js"
import { dispatch } from "../src/invoke.js"

const { eventBus } = await import("../src/events/bus.js")

// ── Part 1: desktop Rust unit fixtures, ported verbatim ────────────────────

describe("claude arg builder (claude_cli.rs fixtures)", () => {
  it("does not isolate local config by default", () => {
    const args = buildClaudeCliArgs("sonnet", false)
    expect(args).toContain("--model")
    expect(args).toContain("sonnet")
    expect(args).not.toContain("--setting-sources")
    expect(args).not.toContain("--strict-mcp-config")
    expect(args).not.toContain("--mcp-config")
    expect(args).not.toContain("--disable-slash-commands")
  })

  it("can isolate user config, tools and MCP", () => {
    expect(JSON.parse('{"mcpServers":{}}').mcpServers).toEqual({})
    const args = buildClaudeCliArgs("sonnet", true)
    const pair = (a, b) => args.some((v, i) => v === a && args[i + 1] === b)
    expect(pair("--setting-sources", "project")).toBe(true)
    expect(args).toContain("--strict-mcp-config")
    expect(pair("--mcp-config", '{"mcpServers":{}}')).toBe(true)
    expect(args).toContain("--disable-slash-commands")
    expect(pair("--tools", "")).toBe(true)
    expect(args).toContain("--no-session-persistence")
    expect(pair("--prompt-suggestions", "false")).toBe(true)
  })
})

describe("codex arg builder + timeout (codex_cli.rs fixtures)", () => {
  it("does not isolate local config by default", () => {
    const args = buildCodexCliArgs("gpt-5", false)
    expect(args.slice(0, 3)).toEqual(["-a", "never", "exec"])
    expect(args).toContain("--model")
    expect(args).toContain("gpt-5")
    expect(args).not.toContain("--ignore-user-config")
    expect(args).not.toContain("--ignore-rules")
  })

  it("can isolate user config and rules", () => {
    const args = buildCodexCliArgs("gpt-5", true)
    const execPos = args.indexOf("exec")
    expect(args.indexOf("--ignore-user-config")).toBeGreaterThan(execPos)
    expect(args.indexOf("--ignore-rules")).toBeGreaterThan(execPos)
  })

  it("clamps and defaults the spawn timeout", () => {
    expect(codexSpawnTimeoutMinutes(undefined)).toBe(10)
    expect(codexSpawnTimeoutMinutes(0)).toBe(1)
    expect(codexSpawnTimeoutMinutes(42)).toBe(42)
    expect(codexSpawnTimeoutMinutes(999)).toBe(240)
  })

  it("appendCappedLine appends a newline when space remains", () => {
    const out = { text: "" }
    appendCappedLine(out, "hello", 16)
    expect(out.text).toBe("hello\n")
  })

  it("appendCappedLine never exceeds the limit", () => {
    const out = { text: "" }
    appendCappedLine(out, "abcdef", 4)
    expect(out.text).toBe("abcd")
    expect(Buffer.byteLength(out.text, "utf8")).toBe(4)
    appendCappedLine(out, "ignored", 4)
    expect(out.text).toBe("abcd")
  })

  it("appendCappedLine preserves UTF-8 boundaries", () => {
    const out = { text: "" }
    appendCappedLine(out, "é水x", 5)
    expect(out.text).toBe("é水")
    expect(Buffer.byteLength(out.text, "utf8")).toBe(5)
    expect(Buffer.from(out.text, "utf8").toString("utf8")).toBe(out.text)
  })

  it("appendCappedLine exact fit gets no newline (Rust semantics)", () => {
    const out = { text: "" }
    appendCappedLine(out, "hello", 5)
    expect(out.text).toBe("hello")
    expect(Buffer.byteLength(out.text, "utf8")).toBe(5)
  })

  it("appendCappedLine never splits a multi-byte char mid-sequence", () => {
    const out = { text: "" }
    appendCappedLine(out, "ab水c", 4)
    expect(out.text).toBe("ab\n")
    expect(Buffer.byteLength(out.text, "utf8")).toBe(3)
    expect(out.text.includes("\uFFFD")).toBe(false)
  })

  it("appendCappedLine keeps the byte count across calls (incl. the appended newline)", () => {
    const out = { text: "" }
    appendCappedLine(out, "ab", 4) // "ab\n" -> 3 bytes, room left
    appendCappedLine(out, "c", 4)  // 3+1 == 4 -> exact fit, no newline
    expect(out.text).toBe("ab\nc")
    expect(Buffer.byteLength(out.text, "utf8")).toBe(4)
    appendCappedLine(out, "more", 4) // at the cap already
    expect(out.text).toBe("ab\nc")
  })

  it("appendCappedLine caps a huge single line at exactly the limit without freezing (O(n), not O(n^2))", () => {
    const MiB = 1024 * 1024
    const out = { text: "" }
    const t0 = Date.now()
    appendCappedLine(out, "x".repeat(MiB + 16), MiB)
    const elapsed = Date.now() - t0
    expect(out.text).toBe("x".repeat(MiB))
    expect(Buffer.byteLength(out.text, "utf8")).toBe(MiB)
    expect(elapsed).toBeLessThan(5000) // the O(n^2) loop took minutes on this line
  })
})

describe("shell-PATH marker parsing (cli_resolver.rs fixtures)", () => {
  it("ignores banners", () => {
    expect(parseShellPathOutput("Welcome\n\x1ePATH=/opt/homebrew/bin:/usr/bin\x1e\nGoodbye\n"))
      .toBe("/opt/homebrew/bin:/usr/bin")
  })

  it("rejects missing or empty markers", () => {
    expect(parseShellPathOutput("PATH=/usr/bin")).toBe(null)
    expect(parseShellPathOutput("\x1ePATH=\x1e")).toBe(null)
    expect(parseShellPathOutput("\x1eOTHER=/usr/bin\x1e")).toBe(null)
  })
})

describe("content shaping (claude_cli.rs fixtures)", () => {
  it("maps frontend image blocks to the Anthropic shape", () => {
    const blocks = contentBlocks([
      { type: "text", text: "describe this" },
      { type: "image", mediaType: "image/png", dataBase64: "abc123" },
    ])
    expect(blocks).toEqual([
      { type: "text", text: "describe this" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "abc123" },
      },
    ])
  })

  it("merges the system preamble into the existing first user text block", () => {
    const blocks = [
      { type: "text", text: "Output the token" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
    ]
    const merged = mergeSystemPreamble(blocks, "System instructions")
    expect(merged).toHaveLength(2)
    expect(merged[0]).toEqual({ type: "text", text: "System instructions\n\nOutput the token" })
    expect(merged[1].type).toBe("image")
  })

  it("adds a leading text block only for an image-only turn", () => {
    const blocks = [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "abc123" } },
    ]
    const merged = mergeSystemPreamble(blocks, "System instructions")
    expect(merged).toHaveLength(2)
    expect(merged[0]).toEqual({ type: "text", text: "System instructions" })
    expect(merged[1].type).toBe("image")
  })
})

// ── Part 2: end-to-end against mock CLIs on PATH ───────────────────────────

const BIN_SH = "#!/bin/sh\n"

// Mock CLI behavior is driven by env vars (MOCK_*_OUT / ERR / EXIT / SLEEP /
// ARGS_FILE / STDIN_FILE). It records argv + stdin, replays stdout/stderr,
// and exits with the requested code.
const MOCK_CLAUDE = BIN_SH + `
set -u
[ -n "\${MOCK_CLAUDE_ARGS_FILE:-}" ] && printf '%s\\0' "$@" > "$MOCK_CLAUDE_ARGS_FILE"
[ -n "\${MOCK_CLAUDE_STDIN_FILE:-}" ] && cat > "$MOCK_CLAUDE_STDIN_FILE"
if [ -n "\${MOCK_CLAUDE_OUT:-}" ]; then
  printf '%s\\n' "$MOCK_CLAUDE_OUT" | while IFS= read -r line; do printf '%s\\n' "$line"; done
fi
if [ -n "\${MOCK_CLAUDE_ERR:-}" ]; then printf '%s\\n' "$MOCK_CLAUDE_ERR" >&2; fi
if [ -n "\${MOCK_CLAUDE_SLEEP:-}" ] && [ "\${MOCK_CLAUDE_SLEEP:-0}" != "0" ]; then
  # exec: replace the shell with sleep so SIGKILL from claude_cli_kill lands
  # on the very process holding the stdout/stderr pipes (an orphaned forked
  # sleep would keep the pipes open and stall the :done close event).
  exec sleep "\${MOCK_CLAUDE_SLEEP}"
fi
exit "\${MOCK_CLAUDE_EXIT:-0}"
`
const MOCK_CODEX = BIN_SH + `
set -u
[ -n "\${MOCK_CODEX_ARGS_FILE:-}" ] && printf '%s\\0' "$@" > "$MOCK_CODEX_ARGS_FILE"
[ -n "\${MOCK_CODEX_STDIN_FILE:-}" ] && cat > "$MOCK_CODEX_STDIN_FILE"
if [ -n "\${MOCK_CODEX_OUT:-}" ]; then
  printf '%s\\n' "$MOCK_CODEX_OUT" | while IFS= read -r line; do printf '%s\\n' "$line"; done
fi
if [ -n "\${MOCK_CODEX_ERR:-}" ]; then printf '%s\\n' "$MOCK_CODEX_ERR" >&2; fi
if [ -n "\${MOCK_CODEX_SLEEP:-}" ] && [ "\${MOCK_CODEX_SLEEP:-0}" != "0" ]; then
  # exec: replace the shell with sleep so SIGKILL from codex_cli_kill lands
  # on the very process holding the stdout/stderr pipes.
  exec sleep "\${MOCK_CODEX_SLEEP}"
fi
exit "\${MOCK_CODEX_EXIT:-0}"
`

let tmpRoot
let binDir
let projectDir
let originalPath

function collectEvents() {
  const events = []
  const unsub = eventBus.subscribe((env) => events.push(env))
  return { events, unsub }
}

function waitForType(events, type, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const hit = events.find((e) => e.type === type)
      if (hit) { clearInterval(timer); resolve(hit) }
      else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`timed out waiting for ${type}; got ${events.map((e) => e.type).join(",")}`))
      }
    }, 10)
  })
}

function readArgs(file) {
  if (!file || !fs.existsSync(file)) return []
  // printf '%s\0' emits a NUL after EVERY arg incl. a trailing one; drop
  // only that final separator so empty-string args (--tools "") survive.
  const parts = fs.readFileSync(file, "utf8").split("\0")
  if (parts[parts.length - 1] === "") parts.pop()
  return parts
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-cli-"))
  binDir = path.join(tmpRoot, "bin")
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(path.join(binDir, "claude"), MOCK_CLAUDE, "utf8")
  fs.writeFileSync(path.join(binDir, "codex"), MOCK_CODEX, "utf8")
  fs.chmodSync(path.join(binDir, "claude"), 0o755)
  fs.chmodSync(path.join(binDir, "codex"), 0o755)

  projectDir = path.join(tmpRoot, "project")
  fs.mkdirSync(path.join(projectDir, "wiki"), { recursive: true })
  fs.writeFileSync(path.join(projectDir, "wiki", "index.md"), "# Index\n", "utf8")

  originalPath = process.env.PATH
  // Prepend the mock bin dir so the mocks win over any real claude/codex.
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`
})

afterAll(() => {
  if (originalPath !== undefined) process.env.PATH = originalPath
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MOCK_")) delete process.env[key]
  }
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe("cli detect (over the real dispatch registry)", () => {
  it("claude_cli_detect returns the desktop {installed,version,path,error} shape", async () => {
    process.env.MOCK_CLAUDE_OUT = "claude version 1.2.3"
    const r = await dispatch("claude_cli_detect")
    expect(r.installed).toBe(true)
    expect(r.version).toBe("claude version 1.2.3")
    expect(r.path).toBe(path.join(binDir, "claude"))
    expect(r.error).toBe(null)
    delete process.env.MOCK_CLAUDE_OUT
  })

  it("codex_cli_detect returns the desktop detect shape", async () => {
    process.env.MOCK_CODEX_OUT = "codex version 0.9.0"
    const r = await dispatch("codex_cli_detect")
    expect(r.installed).toBe(true)
    expect(r.version).toBe("codex version 0.9.0")
    expect(r.path).toBe(path.join(binDir, "codex"))
    expect(r.error).toBe(null)
    delete process.env.MOCK_CODEX_OUT
  })

  it("relays stderr verbatim on a non-zero --version exit", async () => {
    process.env.MOCK_CLAUDE_EXIT = "3"
    process.env.MOCK_CLAUDE_ERR = "some load error"
    const r = await dispatch("claude_cli_detect")
    expect(r.installed).toBe(false)
    expect(r.error).toBe("some load error")
    expect(r.path).toBe(path.join(binDir, "claude"))
    delete process.env.MOCK_CLAUDE_EXIT
    delete process.env.MOCK_CLAUDE_ERR
  })
})

describe("claude_cli_spawn (stream-json stdin + SSE events)", () => {
  it("spawns with the desktop arg vector, folds the system preamble into the first user turn, and streams lines + :done", async () => {
    const sid = "c1"
    const argsFile = path.join(tmpRoot, `claude-${sid}.args`)
    const stdinFile = path.join(tmpRoot, `claude-${sid}.stdin`)
    process.env.MOCK_CLAUDE_ARGS_FILE = argsFile
    process.env.MOCK_CLAUDE_STDIN_FILE = stdinFile
    process.env.MOCK_CLAUDE_OUT = '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n{"type":"done"}'
    process.env.MOCK_CLAUDE_ERR = ""

    const { events, unsub } = collectEvents()
    try {
      await dispatch("claude_cli_spawn", {
        streamId: sid,
        model: "sonnet",
        isolateLocalConfig: true,
        workingDirectory: projectDir,
        messages: [
          { role: "system", content: "You are a summarizer." },
          { role: "user", content: "Summarize this." },
          { role: "assistant", content: "Sure." },
          { role: "user", content: "Go." },
        ],
      })

      const done = await waitForType(events, `claude-cli:${sid}:done`)
      expect(done.payload.code).toBe(0)
      expect(done.payload.stderr).toBe("")

      const lines = events.filter((e) => e.type === `claude-cli:${sid}`).map((e) => e.payload)
      expect(lines).toEqual([
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
        '{"type":"done"}',
      ])

      // Desktop arg vector.
      const args = readArgs(argsFile)
      expect(args).toEqual([
        "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose",
        "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--disable-slash-commands", "--tools", "", "--no-session-persistence", "--prompt-suggestions", "false",
        "--model", "sonnet",
      ])

      // stream-json stdin: system messages dropped; preamble folded into the
      // FIRST user text block; both roles serialized as block arrays.
      const stdinLines = fs.readFileSync(stdinFile, "utf8").trim().split("\n")
      expect(stdinLines).toHaveLength(3)
      const turns = stdinLines.map((l) => JSON.parse(l))
      expect(turns[0]).toEqual({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "You are a summarizer.\n\nSummarize this." }] },
      })
      expect(turns[1].message.role).toBe("assistant")
      expect(turns[1].message.content).toEqual([{ type: "text", text: "Sure." }])
      expect(turns[2].message.role).toBe("user")
      expect(turns[2].message.content).toEqual([{ type: "text", text: "Go." }])
    } finally {
      unsub()
      delete process.env.MOCK_CLAUDE_ARGS_FILE
      delete process.env.MOCK_CLAUDE_STDIN_FILE
      delete process.env.MOCK_CLAUDE_OUT
      delete process.env.MOCK_CLAUDE_ERR
    }
  })

  it("reshapes image blocks and drops them from the system preamble", async () => {
    const sid = "c2"
    const argsFile = path.join(tmpRoot, `claude-${sid}.args`)
    const stdinFile = path.join(tmpRoot, `claude-${sid}.stdin`)
    process.env.MOCK_CLAUDE_ARGS_FILE = argsFile
    process.env.MOCK_CLAUDE_STDIN_FILE = stdinFile
    process.env.MOCK_CLAUDE_OUT = '{"type":"assistant","message":{"content":[]}}'
    process.env.MOCK_CLAUDE_ERR = ""

    const { events, unsub } = collectEvents()
    try {
      await dispatch("claude_cli_spawn", {
        streamId: sid,
        model: "sonnet",
        workingDirectory: projectDir,
        messages: [
          {
            role: "system",
            content: [
              { type: "text", text: "Describe the image." },
              { type: "image", mediaType: "image/png", dataBase64: "zzz" },
            ],
          },
          {
            role: "user",
            content: [
              { type: "image", mediaType: "image/png", dataBase64: "abc123" },
            ],
          },
        ],
      })

      await waitForType(events, `claude-cli:${sid}:done`)
      const stdinRaw = fs.readFileSync(stdinFile, "utf8").trim().split("\n")
      const first = JSON.parse(stdinRaw[0])
      // Preamble is text-only (image dropped from the system message), merged
      // into the leading text block; the user image stays as an Anthropic
      // source block.
      expect(first.message.content).toEqual([
        { type: "text", text: "Describe the image." },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "abc123" },
        },
      ])
    } finally {
      unsub()
      delete process.env.MOCK_CLAUDE_ARGS_FILE
      delete process.env.MOCK_CLAUDE_STDIN_FILE
      delete process.env.MOCK_CLAUDE_OUT
      delete process.env.MOCK_CLAUDE_ERR
    }
  })

  it("relays a non-zero exit with stderr in the :done event", async () => {
    const sid = "c3"
    const stdinFile = path.join(tmpRoot, `claude-${sid}.stdin`)
    process.env.MOCK_CLAUDE_STDIN_FILE = stdinFile
    process.env.MOCK_CLAUDE_EXIT = "7"
    process.env.MOCK_CLAUDE_ERR = "boom"
    const { events, unsub } = collectEvents()
    try {
      await dispatch("claude_cli_spawn", {
        streamId: sid,
        model: "sonnet",
        workingDirectory: projectDir,
        messages: [{ role: "user", content: "Hi" }],
      })
      const done = await waitForType(events, `claude-cli:${sid}:done`)
      expect(done.payload.code).toBe(7)
      expect(done.payload.stderr).toBe("boom\n")
    } finally {
      unsub()
      delete process.env.MOCK_CLAUDE_STDIN_FILE
      delete process.env.MOCK_CLAUDE_EXIT
      delete process.env.MOCK_CLAUDE_ERR
    }
  })

  it("maps a closed stdin pipe to the desktop write error (no unhandled EPIPE)", async () => {
    // Deterministic unit pin of the premature-exit mapping: writing to the
    // stdin of an ALREADY-DEAD child always fails (the pipe read end is
    // closed), so this never races the child's exit the way a live mock can
    // — the previous end-to-end version flaked both directions under load
    // (write lands before a fast mock exits -> no rejection; mock exits
    // before the write -> rejection), depending on machine speed.
    // claude_cli_spawn / codex_cli_spawn both reject with this exact
    // "Failed to write to <label> stdin: ..." shape (Rust write_all Err).
    const { spawn } = await import("node:child_process")
    const { once } = await import("node:events")
    const dead = spawn("/bin/sh", ["-c", "exit 0"])
    await once(dead, "exit")
    await expect(writeToStdin(dead, "hi\n", "claude")).rejects.toThrow(/^Failed to write to claude stdin:/)
    await expect(writeToStdin(dead, "hi\n", "codex")).rejects.toThrow(/^Failed to write to codex stdin:/)
  })

  it("claude_cli_kill SIGKILLs the child and emits :done with code null", async () => {
    const sid = "c4"
    process.env.MOCK_CLAUDE_SLEEP = "30"
    const { events, unsub } = collectEvents()
    try {
      await dispatch("claude_cli_spawn", {
        streamId: sid,
        model: "sonnet",
        workingDirectory: projectDir,
        messages: [{ role: "user", content: "Hi" }],
      })
      // Wait until the child is registered before killing.
      await new Promise((r) => setTimeout(r, 150))
      await dispatch("claude_cli_kill", { streamId: sid })
      const done = await waitForType(events, `claude-cli:${sid}:done`)
      expect(done.payload.code).toBe(null)
    } finally {
      unsub()
      delete process.env.MOCK_CLAUDE_SLEEP
    }
  })

  it("rejects empty conversations and missing stream ids with the desktop errors", async () => {
    await expect(dispatch("claude_cli_spawn", {
      streamId: "s", model: "sonnet", workingDirectory: projectDir,
      messages: [{ role: "system", content: "only system" }],
    })).rejects.toThrow("No user/assistant messages to send to claude CLI")

    await expect(dispatch("claude_cli_spawn", {
      model: "sonnet", workingDirectory: projectDir,
      messages: [{ role: "user", content: "Hi" }],
    })).rejects.toThrow("claude_cli_spawn requires a streamId")
  })
})

describe("claude working-directory guards (desktop error strings)", () => {
  const run = (workingDirectory) => dispatch("claude_cli_spawn", {
    streamId: "wd", model: "sonnet",
    workingDirectory,
    messages: [{ role: "user", content: "Hi" }],
  })

  it("requires an active absolute project directory containing wiki/index.md", async () => {
    await expect(run(undefined)).rejects.toThrow("Claude Code CLI requires an active project working directory")
    await expect(run("   ")).rejects.toThrow("Claude Code CLI requires an active project working directory")
    await expect(run("relative/path")).rejects.toThrow("Claude Code CLI working directory must be an absolute project path")

    const missing = path.join(tmpRoot, "does-not-exist")
    await expect(run(missing)).rejects.toThrow(`Claude Code CLI working directory does not exist or cannot be read: ${missing}`)

    const fileOnly = path.join(tmpRoot, "a-file.txt")
    fs.writeFileSync(fileOnly, "x")
    await expect(run(fileOnly)).rejects.toThrow(`Claude Code CLI working directory is not a directory: ${fileOnly}`)

    const plainDir = path.join(tmpRoot, "plain")
    fs.mkdirSync(plainDir)
    await expect(run(plainDir)).rejects.toThrow(`Claude Code CLI working directory must be an LLM Wiki project containing wiki/index.md: ${plainDir}`)

    const indexIsDir = path.join(tmpRoot, "index-dir")
    fs.mkdirSync(path.join(indexIsDir, "wiki"), { recursive: true })
    fs.mkdirSync(path.join(indexIsDir, "wiki", "index.md"))
    await expect(run(indexIsDir)).rejects.toThrow(`Claude Code CLI working directory must be an LLM Wiki project containing wiki/index.md: ${indexIsDir}`)

    // The valid project path resolves to its canonical form. The mock reads
    // stdin (MOCK_CLAUDE_STDIN_FILE -> `cat`) so the awaited initial write
    // never races the mock's exit: without it the mock shell can exit before
    // the server's write callback lands, turning this assertion into a
    // load-dependent EPIPE flake (the premature-exit mapping itself is pinned
    // by its own dedicated test above).
    const stdinFile = path.join(tmpRoot, "claude-wd-ok.stdin")
    process.env.MOCK_CLAUDE_STDIN_FILE = stdinFile
    try {
      const canonical = await dispatch("claude_cli_spawn", {
        streamId: "wd-ok", model: "sonnet",
        workingDirectory: projectDir,
        messages: [{ role: "user", content: "Hi" }],
      })
      expect(canonical).toBe(null)
    } finally {
      delete process.env.MOCK_CLAUDE_STDIN_FILE
    }
  })
})

describe("codex_cli_spawn (prompt stdin + SSE events)", () => {
  it("spawns with the desktop arg vector, streams stdout lines, and reports stdout in :done", async () => {
    const sid = "x1"
    const argsFile = path.join(tmpRoot, `codex-${sid}.args`)
    const stdinFile = path.join(tmpRoot, `codex-${sid}.stdin`)
    process.env.MOCK_CODEX_ARGS_FILE = argsFile
    process.env.MOCK_CODEX_STDIN_FILE = stdinFile
    process.env.MOCK_CODEX_OUT = '{"type":"agent_message","content":"hello there"}\n{"type":"turn_complete","willContinue":false}'
    process.env.MOCK_CODEX_ERR = ""

    const { events, unsub } = collectEvents()
    try {
      await dispatch("codex_cli_spawn", {
        streamId: sid,
        model: "gpt-5",
        isolateLocalConfig: true,
        timeoutMinutes: 42,
        workingDirectory: projectDir,
        prompt: "Summarize this file.",
      })

      const done = await waitForType(events, `codex-cli:${sid}:done`)
      expect(done.payload.code).toBe(0)
      expect(done.payload.stdout).toBe('{"type":"agent_message","content":"hello there"}\n{"type":"turn_complete","willContinue":false}\n')

      const lines = events.filter((e) => e.type === `codex-cli:${sid}`).map((e) => e.payload)
      expect(lines).toEqual([
        '{"type":"agent_message","content":"hello there"}',
        '{"type":"turn_complete","willContinue":false}',
      ])

      const args = readArgs(argsFile)
      expect(args).toEqual([
        "-a", "never", "exec",
        "--ignore-user-config", "--ignore-rules",
        "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral",
        "--model", "gpt-5", "-",
      ])
      expect(fs.readFileSync(stdinFile, "utf8")).toBe("Summarize this file.")
    } finally {
      unsub()
      delete process.env.MOCK_CODEX_ARGS_FILE
      delete process.env.MOCK_CODEX_STDIN_FILE
      delete process.env.MOCK_CODEX_OUT
      delete process.env.MOCK_CODEX_ERR
    }
  })

  it("relays a non-zero exit with stderr and stdout in :done", async () => {
    const sid = "x2"
    const stdinFile = path.join(tmpRoot, `codex-${sid}.stdin`)
    process.env.MOCK_CODEX_STDIN_FILE = stdinFile
    process.env.MOCK_CODEX_EXIT = "4"
    process.env.MOCK_CODEX_ERR = "config error"
    process.env.MOCK_CODEX_OUT = "partial output"
    const { events, unsub } = collectEvents()
    try {
      await dispatch("codex_cli_spawn", {
        streamId: sid,
        model: "gpt-5",
        workingDirectory: projectDir,
        prompt: "Hi",
      })
      const done = await waitForType(events, `codex-cli:${sid}:done`)
      expect(done.payload.code).toBe(4)
      expect(done.payload.stderr).toBe("config error\n")
      expect(done.payload.stdout).toBe("partial output\n")
    } finally {
      unsub()
      delete process.env.MOCK_CODEX_STDIN_FILE
      delete process.env.MOCK_CODEX_EXIT
      delete process.env.MOCK_CODEX_ERR
      delete process.env.MOCK_CODEX_OUT
    }
  })

  it("codex_cli_kill SIGKILLs the child and emits :done with code null", async () => {
    const sid = "x3"
    process.env.MOCK_CODEX_SLEEP = "30"
    const { events, unsub } = collectEvents()
    try {
      await dispatch("codex_cli_spawn", {
        streamId: sid,
        model: "gpt-5",
        workingDirectory: projectDir,
        prompt: "Hi",
      })
      await new Promise((r) => setTimeout(r, 150))
      await dispatch("codex_cli_kill", { streamId: sid })
      const done = await waitForType(events, `codex-cli:${sid}:done`)
      expect(done.payload.code).toBe(null)
    } finally {
      unsub()
      delete process.env.MOCK_CODEX_SLEEP
    }
  })

  it("rejects an empty prompt and missing stream ids with the desktop errors", async () => {
    await expect(dispatch("codex_cli_spawn", {
      streamId: "s", model: "gpt-5", workingDirectory: projectDir, prompt: "   ",
    })).rejects.toThrow("No prompt to send to codex CLI")

    await expect(dispatch("codex_cli_spawn", {
      model: "gpt-5", workingDirectory: projectDir, prompt: "Hi",
    })).rejects.toThrow("codex_cli_spawn requires a streamId")
  })

  it("validates the working directory with the desktop error strings", async () => {
    await expect(dispatch("codex_cli_spawn", {
      streamId: "s", model: "gpt-5", workingDirectory: undefined, prompt: "Hi",
    })).rejects.toThrow("Codex CLI requires an active project working directory")
    await expect(dispatch("codex_cli_spawn", {
      streamId: "s", model: "gpt-5", workingDirectory: "rel", prompt: "Hi",
    })).rejects.toThrow("Codex CLI working directory must be an absolute project path")
    const missing = path.join(tmpRoot, "nope")
    await expect(dispatch("codex_cli_spawn", {
      streamId: "s", model: "gpt-5", workingDirectory: missing, prompt: "Hi",
    })).rejects.toThrow(`Codex CLI working directory does not exist or cannot be read: ${missing}`)
    const plain = path.join(tmpRoot, "plain2")
    fs.mkdirSync(plain)
    await expect(dispatch("codex_cli_spawn", {
      streamId: "s", model: "gpt-5", workingDirectory: plain, prompt: "Hi",
    })).rejects.toThrow(`Codex CLI working directory must be an LLM Wiki project containing wiki/index.md: ${plain}`)
  })
})
