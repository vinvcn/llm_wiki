import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// Server port of src-tauri/src/agent/skills.rs: scan SKILL.md folders, load
// requested skills, and render the planner-context block the model sees. The
// scan roots are identical to the desktop (project `.llm-wiki/skills` plus the
// user's `~/.claude|~/.codex|~/.agents/skills`), so the web client's Settings
// → Skills tab and the agent's injected instructions match the desktop
// exactly for the same on-disk skills (shared user data).

const MAX_SKILL_FILE_BYTES = 64000
const MAX_SKILL_SCAN_DEPTH = 8
const MAX_SKILL_REFERENCE_BYTES = 256 * 1024

const fwd = (p) => p.split(path.sep).join("/")

const RESERVED = new Set([
  "CON","PRN","AUX","NUL",
  ...Array.from({length:9},(_,i)=>`COM${i+1}`),
  ...Array.from({length:9},(_,i)=>`LPT${i+1}`),
])

function isPortableSkillName(value) {
  if (value.endsWith(" ") || value.endsWith(".")) return false
  for (const ch of value) {
    const c = ch.codePointAt(0)
    if ("<>:\"|?*".includes(ch) || c <= 0x1f) return false
  }
  const stem = (value.split(".")[0] ?? value).replace(/ +$/,"").toUpperCase()
  return !RESERVED.has(stem)
}

export function normalizeSkillName(value) {
  const t = String(value ?? "").trim()
  if (!t || t.includes("/") || t.includes("\\") || t.includes("..")) return null
  if (!isPortableSkillName(t)) return null
  return t
}

function splitFrontmatter(raw) {
  let s = String(raw)
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  if (!s.startsWith("---\n")) return [null, s]
  const rest = s.slice(4)
  const end = rest.indexOf("\n---")
  if (end < 0) return [null, s]
  const fm = rest.slice(0, end)
  let after = rest.slice(end + "\n---".length)
  if (after.startsWith("\n")) after = after.slice(1)
  return [fm, after]
}

function yamlStringField(fm, key) {
  const prefix = `${key}:`
  for (const line of fm.split("\n")) {
    const t = line.trim()
    if (!t.startsWith(prefix)) continue
    let v = t.slice(prefix.length).trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1)
    if (v) return v
  }
  return null
}

function isSymlink(p) { try { return fs.lstatSync(p).isSymbolicLink() } catch { return false } }

function loadSkillFile(filePath, fallbackName) {
  let st
  try { st = fs.lstatSync(filePath) } catch { throw new Error("Skill not found") }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_SKILL_FILE_BYTES) {
    throw new Error("Skill file is not readable or is too large")
  }
  const raw = fs.readFileSync(filePath, "utf-8")
  const [fm, after] = splitFrontmatter(raw)
  const name = (fm && yamlStringField(fm, "name")) || fallbackName
  const description = (fm && yamlStringField(fm, "description")) || ""
  if (!description.trim()) throw new Error("Skill description is required")
  const instructions = after.trim()
  if (!instructions) throw new Error("Skill instructions are empty")
  return {
    name, description, instructions,
    baseDir: fwd(path.dirname(filePath)),
    location: fwd(filePath),
  }
}

function findSkillMainFile(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
  const hit = entries.find((e) => e.name.toLowerCase() === "skill.md")
  return hit ? path.join(dir, hit.name) : null
}

function loadSkillDirectory(dir, fallbackName) {
  let st
  try { st = fs.lstatSync(dir) } catch { throw new Error("Skill folder not found") }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("Skill folder is not readable")
  const main = findSkillMainFile(dir) || path.join(dir, "SKILL.md")
  return loadSkillFile(main, fallbackName)
}

function loadSkillPath(p, fallbackName) {
  if (path.basename(p).toLowerCase() === "skill.md") {
    const parent = path.dirname(p)
    if (!parent) throw new Error("Skill file has no parent directory")
    return loadSkillDirectory(parent, fallbackName)
  }
  return loadSkillFile(p, fallbackName)
}

function isHiddenOrUnsafeSkillDir(p) {
  const name = path.basename(p)
  return name.startsWith(".") || name === "node_modules" || normalizeSkillName(name) == null
}

function discoverCandidates(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > MAX_SKILL_SCAN_DEPTH) return
    let st
    try { st = fs.lstatSync(dir) } catch { return }
    if (st.isSymbolicLink() || !st.isDirectory()) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => (path.join(dir, a.name) < path.join(dir, b.name) ? -1 : 1))
    for (const e of entries) {
      const full = path.join(dir, e.name)
      let m
      try { m = fs.lstatSync(full) } catch { continue }
      if (m.isSymbolicLink()) continue
      if (m.isFile()) {
        if (e.name.toLowerCase() === "skill.md") {
          const id = normalizeSkillName(path.basename(dir))
          if (id) out.push({ id, path: full })
          continue
        }
        if (path.extname(e.name).toLowerCase() === ".md") {
          // Rust uses file_stem(), which strips the final extension
          // REGARDLESS of case ("Reviewer.MD" -> "Reviewer"); Node's
          // basename(name, ".md") suffix match is case-sensitive and would
          // yield "Reviewer.MD" instead.
          const stem = e.name.slice(0, e.name.length - path.extname(e.name).length)
          const id = normalizeSkillName(stem)
          if (id) out.push({ id, path: full })
        }
        continue
      }
      if (m.isDirectory()) {
        if (isHiddenOrUnsafeSkillDir(full)) continue
        walk(full, depth + 1)
      }
    }
  }
  walk(root, 0)
  return out
}

export function skillRoots(projectPath) {
  const roots = [{ path: path.join(projectPath, ".llm-wiki", "skills"), source: "project" }]
  const home = os.homedir()
  if (home) {
    roots.push({ path: path.join(home, ".claude", "skills"), source: "claude" })
    roots.push({ path: path.join(home, ".codex", "skills"), source: "codex" })
    roots.push({ path: path.join(home, ".agents", "skills"), source: "agents" })
  }
  return roots
}

function loadOneSkill(root, name) {
  const single = path.join(root, `${name}.md`)
  try { return loadSkillFile(single, name) } catch { /* try dir */ }
  try { return loadSkillDirectory(path.join(root, name), name) } catch { /* try discover */ }
  const cand = discoverCandidates(root).find((c) => c.id === name)
  if (!cand) return null
  try { return loadSkillPath(cand.path, name) } catch { return null }
}

export function listAvailableSkills(projectPath) {
  const map = new Map()
  for (const root of skillRoots(projectPath)) {
    for (const cand of discoverCandidates(root.path)) {
      if (map.has(cand.id)) continue
      let skill
      try { skill = loadSkillPath(cand.path, cand.id) } catch { continue }
      map.set(cand.id, { id: cand.id, name: skill.name, description: skill.description, source: root.source })
    }
  }
  return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function loadProjectSkills(projectPath, requested) {
  if (!Array.isArray(requested) || requested.length === 0) return []
  const roots = skillRoots(projectPath)
  const names = [...new Set(requested.map(normalizeSkillName).filter(Boolean))].sort()
  const out = []
  for (const name of names) {
    for (const root of roots) {
      const skill = loadOneSkill(root.path, name)
      if (skill) { out.push(skill); break }
    }
  }
  return out
}

// ── planner-context rendering (mirrors render_skill_planner_context) ──────
function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
}
function trimChars(s, n) { const a = [...String(s)]; return a.length > n ? a.slice(0, n).join("") : String(s) }

export function renderSkillPlannerContext(skills, skillMode) {
  if (!skills || skills.length === 0) return "None"
  let out = ""
  if ((skillMode || "auto") === "explicit") {
    out += "The following skills were explicitly selected by the user for this turn.\n"
    for (const skill of skills.slice(0, 8)) {
      const baseDir = escapeXml(skill.baseDir)
      const instructions = escapeXml(trimChars(skill.instructions.trim(), 1200))
      out += `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.location)}">\nReferences are relative to ${baseDir}.\n\n${instructions}\n</skill>\n`
    }
  } else {
    out += "The following enabled skills are optional. Use them only if they match the request. Inspect a SKILL.md location only after deciding the skill is relevant.\n"
    out += "<available_skills>\n"
    for (const skill of skills.slice(0, 12)) {
      out += "  <skill>\n"
      out += `    <name>${escapeXml(skill.name)}</name>\n`
      out += `    <description>${escapeXml(skill.description.trim())}</description>\n`
      out += `    <location>${escapeXml(skill.location)}</location>\n`
      out += "  </skill>\n"
    }
    out += "</available_skills>\n"
  }
  return trimChars(out, 8000)
}

// ── skill.read_file reference resolution (faithful port of
// read_active_skill_file + resolve_skill_read_target in runtime.rs) ────────
// The desktop tool reads ONLY inside an active skill's directory. Resolution
// follows the Rust steps exactly: an explicit `skill` arg (or a single active
// skill otherwise); absolute paths must canonicalize inside a skill base;
// unique-existing relative paths; <skill>/<rel> or <skill>:<rel> prefixes;
// then the raw path against the selected skill. Safe relative paths only, and
// canonical containment blocks symlinks that escape the skill directory.

function isWithin(target, base) {
  if (target === base) return true
  return target.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
}

function skillNameLike(value) {
  const v = String(value ?? "").trim()
  if (!v || !v.includes("-")) return false
  return [...v].every((ch) => /[A-Za-z0-9_-]/.test(ch))
}

function skillMatchesRequestedName(skill, requested) {
  const requestedLower = String(requested ?? "").toLowerCase()
  if (String(skill.name ?? "").toLowerCase() === requestedLower) return true
  const folderMatches = (p) => {
    const name = path.basename(String(p ?? ""))
    const nameLower = name.toLowerCase()
    return nameLower === requestedLower || nameLower.endsWith(`-${requestedLower}`)
  }
  return folderMatches(skill.baseDir) || folderMatches(path.dirname(skill.location ?? ""))
}

function selectActiveSkillForRead(skills, requested) {
  const trimmed = String(requested ?? "").trim()
  if (!trimmed) {
    if (skills.length === 1) return skills[0]
    throw new Error("skill.read_file requires skill when multiple skills are active")
  }
  const skill = skills.find((candidate) => skillMatchesRequestedName(candidate, trimmed))
  if (!skill) throw new Error(`Active skill not found: ${trimmed}`)
  return skill
}

function isSafeRelativeSkillPath(value) {
  const s = String(value)
  if (!s || path.isAbsolute(s)) return false
  // Rust: every component must be Normal or CurDir — no "..", no parent/root.
  return s.split(/[\\/]+/).filter(Boolean).every((part) => part !== "..")
}

function normalizeRequestedPathForSkill(skill, requestedPath) {
  const raw = String(requestedPath ?? "")
  if (path.isAbsolute(raw)) {
    let target
    try { target = fs.realpathSync(raw) } catch (e) { throw new Error(`Failed to resolve skill file: ${e.message}`) }
    let base
    try { base = fs.realpathSync(skill.baseDir) } catch (e) { throw new Error(`Failed to resolve skill directory: ${e.message}`) }
    if (!isWithin(target, base)) {
      throw new Error("skill.read_file absolute path does not belong to requested skill")
    }
    return path.relative(base, target).split(path.sep).join("/")
  }
  const normalized = raw.trim().replaceAll("\\", "/")
  const slash = normalized.indexOf("/")
  if (slash > 0) {
    const prefix = normalized.slice(0, slash)
    const rest = normalized.slice(slash + 1)
    if (skillMatchesRequestedName(skill, prefix)) return rest
    if (skillNameLike(prefix)) throw new Error("skill.read_file path prefix does not match requested skill")
  }
  const colon = normalized.indexOf(":")
  if (colon > 0) {
    const prefix = normalized.slice(0, colon)
    const rest = normalized.slice(colon + 1).replace(/^\/+/, "")
    if (skillMatchesRequestedName(skill, prefix)) return rest
    if (skillNameLike(prefix)) throw new Error("skill.read_file path prefix does not match requested skill")
  }
  return raw
}

function resolveAbsoluteSkillPath(skills, requestedPath) {
  const raw = String(requestedPath ?? "")
  if (!path.isAbsolute(raw)) return null
  let target
  try { target = fs.realpathSync(raw) } catch (e) { throw new Error(`Failed to resolve skill file: ${e.message}`) }
  for (const skill of skills) {
    let base
    try { base = fs.realpathSync(skill.baseDir) } catch (e) { throw new Error(`Failed to resolve skill directory: ${e.message}`) }
    if (isWithin(target, base)) {
      const rel = path.relative(base, target).split(path.sep).join("/")
      if (rel) return { skill, relativePath: rel }
    }
  }
  return null
}

function splitSkillPathPrefix(normalized) {
  const colon = normalized.indexOf(":")
  if (colon > 0) {
    const prefix = normalized.slice(0, colon)
    if (skillNameLike(prefix)) return [prefix, normalized.slice(colon + 1).replace(/^\/+/, "")]
  }
  const slash = normalized.indexOf("/")
  if (slash > 0) return [normalized.slice(0, slash), normalized.slice(slash + 1)]
  return null
}

function resolvePrefixedSkillPath(skills, requestedPath) {
  const normalized = String(requestedPath ?? "").trim().replaceAll("\\", "/")
  const split = splitSkillPathPrefix(normalized)
  if (!split) return null
  const [prefix, rest] = split
  if (!rest.trim()) return null
  const matched = skills.filter((skill) =>
    skillMatchesRequestedName(skill, prefix) && fs.existsSync(path.join(skill.baseDir, rest)))
  if (matched.length === 1) return { skill: matched[0], relativePath: rest }
  if (matched.length === 0) return null
  throw new Error(`skill.read_file prefix is ambiguous: ${prefix}`)
}

function resolveUniqueExistingSkillPath(skills, requestedPath) {
  if (!isSafeRelativeSkillPath(requestedPath)) return null
  const matches = []
  for (const skill of skills) {
    const base = path.resolve(skill.baseDir)
    const candidate = path.resolve(base, requestedPath)
    if (!fs.existsSync(candidate)) continue
    let baseCanon, candCanon
    try { baseCanon = fs.realpathSync(base) } catch (e) { throw new Error(`Failed to resolve skill directory: ${e.message}`) }
    try { candCanon = fs.realpathSync(candidate) } catch (e) { throw new Error(`Failed to resolve skill file: ${e.message}`) }
    if (isWithin(candCanon, baseCanon)) matches.push(skill)
  }
  if (matches.length === 1) return { skill: matches[0], relativePath: requestedPath }
  if (matches.length === 0) return null
  throw new Error(`skill.read_file path is ambiguous: ${requestedPath}`)
}

function resolveSkillReadTarget(skills, requestedSkill, requestedPath) {
  const requested = String(requestedSkill ?? "").trim()
  if (requested) {
    const skill = selectActiveSkillForRead(skills, requested)
    return { skill, relativePath: normalizeRequestedPathForSkill(skill, requestedPath) }
  }
  const absolute = resolveAbsoluteSkillPath(skills, requestedPath)
  if (absolute) return absolute
  const unique = resolveUniqueExistingSkillPath(skills, requestedPath)
  if (unique) return unique
  const prefixed = resolvePrefixedSkillPath(skills, requestedPath)
  if (prefixed) return prefixed
  const skill = selectActiveSkillForRead(skills, null)
  return { skill, relativePath: String(requestedPath ?? "") }
}

export function readActiveSkillFile(skills, input = {}) {
  if (!Array.isArray(skills) || skills.length === 0) {
    throw new Error("skill.read_file requires an active skill")
  }
  const requestedPath = String(input?.path ?? "").trim()
  if (!requestedPath) throw new Error("skill.read_file requires path")
  const { skill, relativePath } = resolveSkillReadTarget(skills, input?.skill, requestedPath)
  if (!isSafeRelativeSkillPath(relativePath)) {
    throw new Error("skill.read_file path must be a safe relative path inside the skill directory")
  }
  let baseCanon
  try { baseCanon = fs.realpathSync(path.resolve(skill.baseDir)) } catch (e) { throw new Error(`Failed to resolve skill directory: ${e.message}`) }
  const targetCanon = (() => {
    try { return fs.realpathSync(path.resolve(skill.baseDir, relativePath)) } catch (e) { throw new Error(`Failed to resolve skill file: ${e.message}`) }
  })()
  if (!isWithin(targetCanon, baseCanon)) {
    throw new Error("skill.read_file cannot read outside the active skill directory")
  }
  const meta = fs.lstatSync(targetCanon)
  if (meta.isSymbolicLink() || !meta.isFile()) {
    throw new Error("skill.read_file target is not a regular file")
  }
  if (meta.size > MAX_SKILL_REFERENCE_BYTES) {
    throw new Error(`skill.read_file target is too large (max ${MAX_SKILL_REFERENCE_BYTES} bytes)`)
  }
  const content = fs.readFileSync(targetCanon, "utf-8")
  return { skill: skill.name, path: relativePath, content }
}

export { MAX_SKILL_REFERENCE_BYTES }
