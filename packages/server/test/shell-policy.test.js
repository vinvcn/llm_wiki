// shell.exec approval-policy tests — faithful port of the desktop's Rust unit
// tests (src-tauri/src/agent/runtime.rs): shell_commands_require_exact_approval,
// workspace_local_shell_commands_do_not_require_manual_approval,
// external_shell_commands_still_require_manual_approval,
// skill_preference_probe_commands_are_not_sent_to_shell_approval, and
// shell_approval_observation_ends_current_loop_turn — plus coverage of the
// ported helpers (tokenizer, path normalization, external-location detection).

import { describe, it, expect } from "vitest"
import {
  AGENT_WORKSPACE_DIR, SHELL_APPROVAL_REQUIRED_OBSERVATION, SHELL_REQUIRES_SKILL_ERROR,
  agentWorkspaceDisplay, isShellCommandApproved, isShellAbsolutePath,
  normalizeShellPathForCompare, shellCommandTokens, shellTokenMentionsExternalLocation,
  isShellCommandScopedToAgentWorkspace, isShellCommandAllowedWithoutPrompt,
  isSkillPreferenceProbeCommand, skippedSkillPreferenceProbeSummary, shellApprovalSummary,
} from "../src/shell-policy.js"

const PROJECT = "/Users/test/Project" // same fixture project as the Rust tests

describe("isShellCommandApproved (runtime.rs shell_commands_require_exact_approval)", () => {
  it("rejects an empty approval list", () => {
    expect(isShellCommandApproved("echo unsafe", [])).toBe(false)
  })
  it("rejects a non-matching approval entry", () => {
    expect(isShellCommandApproved("echo unsafe", ["echo other"])).toBe(false)
  })
  it("accepts an exact match after trimming whitespace", () => {
    expect(isShellCommandApproved("echo safe", ["  echo safe  "])).toBe(true)
  })
  it("rejects empty commands", () => {
    expect(isShellCommandApproved("   ", ["   "])).toBe(false)
  })
})

describe("isShellCommandAllowedWithoutPrompt (runtime.rs workspace_local_…)", () => {
  it("allows relative reads piped to head", () => {
    expect(isShellCommandAllowedWithoutPrompt("cat ppt/index.html | head -100", [], PROJECT)).toBe(true)
  })
  it("allows absolute paths inside the agent workspace", () => {
    expect(isShellCommandAllowedWithoutPrompt(
      "grep -n data-layout /Users/test/Project/agent-workspace/ppt/index.html | head -30", [], PROJECT)).toBe(true)
  })
  it("allows compound workspace-local commands", () => {
    expect(isShellCommandAllowedWithoutPrompt(
      "mkdir -p deck && node scripts/validate.js deck/index.html", [], PROJECT)).toBe(true)
  })
  it("allows exactly approved commands", () => {
    expect(isShellCommandAllowedWithoutPrompt("echo safe", ["echo safe"], PROJECT)).toBe(true)
  })
})

describe("isShellCommandAllowedWithoutPrompt (runtime.rs external_shell_commands_…)", () => {
  it("rejects reads outside the project (absolute home path)", () => {
    expect(isShellCommandAllowedWithoutPrompt("cat /Users/test/.agents/skills/skill/SKILL.md", [], PROJECT)).toBe(false)
  })
  it("rejects tilde sources", () => {
    expect(isShellCommandAllowedWithoutPrompt("cp ~/Desktop/file.png images/file.png", [], PROJECT)).toBe(false)
  })
  it("rejects parent-directory traversal", () => {
    expect(isShellCommandAllowedWithoutPrompt("cat ../raw/secrets.txt", [], PROJECT)).toBe(false)
  })
  it("rejects network fetches", () => {
    expect(isShellCommandAllowedWithoutPrompt("curl https://example.com/file", [], PROJECT)).toBe(false)
  })
  it("rejects $TMP env-var targets", () => {
    expect(isShellCommandAllowedWithoutPrompt("OUT=/tmp/file.html echo x", [], PROJECT)).toBe(false)
  })
})

describe("workspace scoping guards (runtime.rs is_shell_command_scoped_to_agent_workspace)", () => {
  it("rejects wget/scp/ssh and URL schemes", () => {
    for (const cmd of [
      "wget https://example.com/x", "scp user@host:/etc/passwd .", "ssh user@host ls",
      "open http://localhost:19828", "open ftp://host/file", "open sftp://host/file",
    ]) {
      expect(isShellCommandScopedToAgentWorkspace(cmd, PROJECT)).toBe(false)
    }
  })
  it("rejects command substitution and backticks", () => {
    expect(isShellCommandScopedToAgentWorkspace("echo $(cat /etc/passwd)", PROJECT)).toBe(false)
    expect(isShellCommandScopedToAgentWorkspace("echo `whoami`", PROJECT)).toBe(false)
  })
  it("rejects $HOME/${HOME}/%USERPROFILE%/%HOMEPATH% and XDG vars", () => {
    for (const cmd of [
      "cat $HOME/.ssh/id_rsa", "cat ${HOME}/notes.md", "type %USERPROFILE%\\notes.txt",
      "type %HOMEPATH%\\notes.txt", "ls $XDG_CONFIG_HOME", "ls ${XDG_DATA_HOME}/x",
    ]) {
      expect(isShellCommandScopedToAgentWorkspace(cmd, PROJECT)).toBe(false)
    }
  })
  it("rejects $TMP/$TEMP targets", () => {
    expect(isShellCommandScopedToAgentWorkspace("echo x > $TMP/out.txt", PROJECT)).toBe(false)
    expect(isShellCommandScopedToAgentWorkspace("echo x > ${TEMP}/out.txt", PROJECT)).toBe(false)
  })
  it("rejects embedded /../ traversal", () => {
    expect(isShellCommandScopedToAgentWorkspace("cat a/b/../../etc/passwd", PROJECT)).toBe(false)
    expect(isShellCommandScopedToAgentWorkspace("cat foo/..", PROJECT)).toBe(false)
  })
  it("allows plain workspace-relative work", () => {
    expect(isShellCommandScopedToAgentWorkspace("ls agent-workspace", PROJECT)).toBe(true)
    expect(isShellCommandScopedToAgentWorkspace("node scripts/build.js", PROJECT)).toBe(true)
  })
  it("rejects empty commands", () => {
    expect(isShellCommandScopedToAgentWorkspace("   ", PROJECT)).toBe(false)
  })
})

describe("shellCommandTokens (runtime.rs shell_command_tokens)", () => {
  it("splits on whitespace and metacharacters", () => {
    expect(shellCommandTokens("cat a.txt | head -10; echo done && (ls)")).toEqual(
      ["cat", "a.txt", "head", "-10", "echo", "done", "ls"])
  })
  it("keeps quoted contents literally and drops the quotes", () => {
    expect(shellCommandTokens(`echo "hello world" 'a b'`)).toEqual(["echo", "hello world", "a b"])
  })
  it("returns [] for empty input", () => {
    expect(shellCommandTokens("")).toEqual([])
  })
})

describe("path helpers (runtime.rs is_shell_absolute_path / normalize_shell_path_for_compare)", () => {
  it("detects POSIX, UNC, and Windows drive paths", () => {
    expect(isShellAbsolutePath("/etc/passwd")).toBe(true)
    expect(isShellAbsolutePath("\\\\server\\share")).toBe(true)
    expect(isShellAbsolutePath("C:\\Users\\x")).toBe(true)
    expect(isShellAbsolutePath("relative/path")).toBe(false)
    expect(isShellAbsolutePath("")).toBe(false)
  })
  it("normalizes quotes, separators, trailing slashes, case", () => {
    expect(normalizeShellPathForCompare("'/Users/Test/Project/agent-workspace/'")).toBe(
      "/users/test/project/agent-workspace")
    expect(normalizeShellPathForCompare('"C:\\Proj\\AW\\"')).toBe("c:/proj/aw")
  })
  it("agentWorkspaceDisplay joins the workspace dir", () => {
    expect(agentWorkspaceDisplay("/p")).toBe(`/p/${AGENT_WORKSPACE_DIR}`)
  })
})

describe("shellTokenMentionsExternalLocation (split_once('=') + quoting)", () => {
  const ws = normalizeShellPathForCompare(agentWorkspaceDisplay(PROJECT))
  const proj = normalizeShellPathForCompare(PROJECT)
  it("accepts workspace paths incl. VAR= forms", () => {
    expect(shellTokenMentionsExternalLocation(`${PROJECT}/agent-workspace/out.html`, ws, proj)).toBe(false)
    expect(shellTokenMentionsExternalLocation(`OUT=${PROJECT}/agent-workspace/out.html`, ws, proj)).toBe(false)
  })
  it("rejects external paths incl. VAR= forms and quoted values", () => {
    expect(shellTokenMentionsExternalLocation("/etc/passwd", ws, proj)).toBe(true)
    expect(shellTokenMentionsExternalLocation("OUT=/tmp/file.html", ws, proj)).toBe(true)
    expect(shellTokenMentionsExternalLocation("'~/x'", ws, proj)).toBe(true)
  })
  it("ignores empty tokens", () => {
    expect(shellTokenMentionsExternalLocation("", ws, proj)).toBe(false)
  })
})

describe("skill preference probe (runtime.rs skill_preference_probe_commands_…)", () => {
  const PROBE = "test -f .baoyu-skills/baoyu-cover-image/EXTEND.md && echo 'project'; test -f \"${XDG_CONFIG_HOME:-$HOME/.config}/baoyu-skills/baoyu-cover-image/EXTEND.md\" && echo 'xdg'"
  it("detects the desktop's exact probe fixture", () => {
    expect(isSkillPreferenceProbeCommand(PROBE)).toBe(true)
  })
  it("detects test-path variants", () => {
    expect(isSkillPreferenceProbeCommand("test-path .baoyu-skills/x/EXTEND.md")).toBe(true)
  })
  it("does not flag unrelated commands", () => {
    expect(isSkillPreferenceProbeCommand("cat EXTEND.md")).toBe(false)
    expect(isSkillPreferenceProbeCommand("test -f other/file.md")).toBe(false)
  })
  it("skip summary tells the model not to retry", () => {
    const summary = skippedSkillPreferenceProbeSummary(PROBE)
    expect(summary).toContain("do not retry")
    expect(summary).toContain(PROBE)
  })
})

describe("approval boundary constants (runtime.rs SHELL_APPROVAL_REQUIRED_OBSERVATION)", () => {
  it("exposes the marker string", () => {
    expect(SHELL_APPROVAL_REQUIRED_OBSERVATION).toBe("shell.exec.approval_required")
  })
  it("approval summary names the command and asks for approval", () => {
    const s = shellApprovalSummary("rm -rf /")
    expect(s).toContain("The Agent needs approval before it can run this command:")
    expect(s).toContain("`rm -rf /`")
  })
  it("skills-gate rejection message matches the desktop", () => {
    expect(SHELL_REQUIRES_SKILL_ERROR).toBe(
      "shell.exec is only available when at least one skill is active for this turn")
  })
})
