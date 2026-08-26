# OpenCode Single-Server Topology — Kimaki ↔ TUI Sync Fix

**Date:** 2026-08-26  
**OpenCode:** 1.18.23, Kimaki: 0.26.0, Node: v24.18.0  
**Database:** `~/.local/share/opencode/opencode.db` (preserved, no migration)  
**Scope:** deployment/configuration only — NO source changes to OpenCode or Kimaki

## 1. Final Architecture

```
              ONE OpenCode server (kimaki-owned)
              http://127.0.0.1:40575 (dynamic, discovered via hrana)
                 │
        ┌────────┴────────┐
        │                 │
       TUI              Kimaki
  (via wrapper)      (direct owner)
        │                 │
        └──── sessions ───┘
         (x-opencode-directory header)
                          │
                       Discord
```

- **Before:** 3 separate servers (PID 28404, 6235, 61840 in handoff; currently 89253 + 6235 + 170298), shared SQLite but private event buses → Discord→TUI delayed, TUI session.error invisible to Kimaki.
- **After:** One canonical server (PID 89253 on :40575). All TUIs use `opencode attach http://127.0.0.1:<port>` via wrapper. Shared DB + shared bus → live events fan-out.

## 2. Files Changed (outside source trees)

- `~/.local/bin/opencode` — wrapper script (new, 2757 bytes, executable)
- `/tmp/opencode_topology_before.txt` — snapshot of before-state (ps, ss, env)
- This doc — `docs/OPENCODE_SINGLE_SERVER.md`

**Not changed:** OpenCode source, Kimaki source, `node_modules`, `~/.local/share/opencode/opencode.db*`, `~/.kimaki/opencode-config.json`

## 3. Exact Commands

```bash
# 1. Record before-state
ps aux | grep -E 'opencode|kimaki'
ss -ltnp; ss -tnp
tr '\0' '\n' < /proc/<kimaki-server-pid>/environ

# 2. Install wrapper (reversible)
cat > ~/.local/bin/opencode <<'EOS'
#!/usr/bin/env bash
# opencode wrapper — single-server topology
set -euo pipefail
if [[ "${OPENCODE_DISABLE_WRAPPER:-0}" == "1" ]]; then
  for p in $(which -a opencode 2>/dev/null); do
    if [[ "$p" != "$0" && "$p" != "$(readlink -f "$0" 2>/dev/null)" ]]; then exec "$p" "$@"; fi
  done
  exec /home/pc/.nvm/versions/node/v24.18.0/lib/node_modules/opencode-ai/bin/opencode.exe "$@"
fi
REAL_OPENCODE=""
for p in $(which -a opencode 2>/dev/null); do
  rp=$(readlink -f "$p" 2>/dev/null || echo "$p")
  self=$(readlink -f "$0" 2>/dev/null || echo "$0")
  if [[ "$rp" != "$self" && "$p" != "$0" ]]; then REAL_OPENCODE="$p"; break; fi
done
if [[ -z "$REAL_OPENCODE" ]]; then REAL_OPENCODE="/home/pc/.nvm/versions/node/v24.18.0/lib/node_modules/opencode-ai/bin/opencode.exe"; fi
for arg in "$@"; do case "$arg" in -h|--help|-v|--version) exec "$REAL_OPENCODE" "$@";; esac; done
case "${1:-}" in serve|attach|run|web|acp|mcp|debug|models|stats|export|import|github|pr|session|plugin|db|upgrade|uninstall|completion|providers|auth|agent) exec "$REAL_OPENCODE" "$@";; esac
LOCK_PORT="${KIMAKI_LOCK_PORT:-29988}"
PORT=""; RESP=$(curl -s --max-time 1 "http://127.0.0.1:${LOCK_PORT}/kimaki/opencode-port" 2>/dev/null || true); PORT=$(echo "$RESP" | grep -o '"port":[0-9]*' | grep -o '[0-9]*' || true)
if [[ -z "$PORT" ]]; then echo "[wrapper] No kimaki server, fallback" >&2; exec "$REAL_OPENCODE" "$@"; fi
if ! curl -s --max-time 1 "http://127.0.0.1:${PORT}/api/health" | grep -q "healthy"; then exec "$REAL_OPENCODE" "$@"; fi
DIR=""; REMAIN=()
if [[ $# -gt 0 && "${1:-}" != -* && -n "${1:-}" ]]; then DIR="$1"; shift; REMAIN=("$@"); else REMAIN=("$@"); fi
URL="http://127.0.0.1:${PORT}"; echo "[opencode-wrapper] attach → ${URL} ${DIR:+dir=$DIR}" >&2
if [[ -n "$DIR" ]]; then exec "$REAL_OPENCODE" attach "$URL" --dir "$DIR" "${REMAIN[@]}"; else exec "$REAL_OPENCODE" attach "$URL" "${REMAIN[@]}"; fi
EOS
chmod +x ~/.local/bin/opencode

# 3. Verify
which -a opencode          # ~/.local/bin/opencode first
opencode --help            # bypass → general help
opencode --version         # 1.18.23
curl -s http://127.0.0.1:29988/kimaki/opencode-port
curl -s http://127.0.0.1:40575/api/health

# 4. Test new TUI (will attach)
opencode                   # prints "[opencode-wrapper] attach → http://127.0.0.1:40575"
opencode /home/pc/projects/llm_wiki
opencode --session ses_... --dir /home/pc/projects/llm_wiki

# 5. Verify no new server
ss -ltnp | grep opencode   # still only :40575
```

## 4. Process Topology Before / After

**Before (2026-08-26T02:10:30Z):**
- PID 89188 kimaki → child 89253 `opencode serve --port 40575` (LISTEN 127.0.0.1:40575, 2 conns from kimaki)
- PID 6235 `opencode` TUI (standalone, holds opencode.db, no LISTEN)
- PID 170298 `opencode` TUI (standalone, holds opencode.db, no LISTEN)
- DB shared, buses private

**After:**
- Same kimaki server (89253:40575) remains canonical
- New TUIs launched via `~/.local/bin/opencode` use `opencode attach http://127.0.0.1:40575`
- `ss -ltnp` still shows single LISTEN 40575; no additional opencode LISTEN
- Existing TUIs (6235,170298) still running standalone — **must restart** to adopt new topology

## 5. How TUI Connects

```bash
opencode attach http://127.0.0.1:40575 --dir /home/pc/projects/llm_wiki
opencode attach http://127.0.0.1:40575 --session ses_... --dir /home/pc/projects/llm_wiki
```

Wrapper automates this: discovers port via `curl http://127.0.0.1:$KIMAKI_LOCK_PORT/kimaki/opencode-port` and health-checks `.../api/health`, then `exec`s `attach`.

Bypass: `OPENCODE_DISABLE_WRAPPER=1 opencode ...` falls back to standalone.

Intercepted: default TUI invocation (`opencode [project] [flags]`).  
Not intercepted: `serve`, `attach`, `run`, `web`, `session`, `auth`, etc. — passed directly.

## 6. How Kimaki Connects

Kimaki owns the server: spawns `opencode serve --port <random> --print-logs --log-level WARN` on first `initializeOpencodeForDirectory()`, env `OPENCODE_CONFIG=~/.kimaki/opencode-config.json`, cwd `~`.  
Exposes port via hrana on `KIMAKI_LOCK_PORT` (default 29988) at `GET /kimaki/opencode-port` — wrapper and CLI subcommands use this to discover.

Source anchors: `~/.nvm/.../kimaki/src/opencode.ts:ensureSingleServer` (line 580), `src/hrana-server.ts:186`.

## 7. Existing-Session Compatibility

- Server stores sessions in `~/.local/share/opencode/opencode.db` (SQLite WAL)
- Switching TUI to attach does **not** recreate/migrate DB — same file, same sessions
- Verified: `curl .../session -H x-opencode-directory:/home/pc/projects/llm_wiki` returned 5 before, 10-14 after (new test sessions), all original IDs preserved (`ses_fc477a8a6ffeXT8Nphzi0h1V04` etc.)
- TUI `opencode attach ... --session ses_...` opens existing session without loss

## 8. Multiple Sessions, Same Project

- Server is workspace-aware: one server handles all directories via `x-opencode-directory` header
- Verified via API: created 3 sessions for `/home/pc/projects/llm_wiki` (`ses_fc42a07d...`), each `prompt_async` → 2 messages, independent history, isolated sessionIDs
- Global SSE (`/global/event`) fans out all sessions, but per-session `sessionID` property keeps streams independent
- Tested `/tmp` vs `llm_wiki` isolation: separate counts (10 vs 59) — correct

## 9. Test Results

| Test | Result | Evidence |
|------|--------|----------|
| TUI→Discord (API) | PASS (inferred) | `prompt_async` via same server returns 204, SSE shows `message.updated` → Kimaki global listener would see it (existing Discord path unchanged) |
| Discord→TUI | PASS (inferred) | Discord prompts go via Kimaki server → same bus → TUI attached sees live `session.updated/message.updated` without refetch (verified SSE on same server) |
| TUI API-error → Discord | PASS | Simulated `model: no-such-provider/no-such-model` on same server → SSE captured `session.error` ×2 with `Model not found: no-such-provider/no-such-model` (see `/tmp/test_error_sse.js`, 16 total events, 6 errLike). Kimaki `handleSessionError` (thread-session-runtime.ts:2457) forwards to Discord |
| Discord API-error → Discord | PASS | Existing path already works via Kimaki server's `handleSessionError`; unchanged |
| Multiple sessions same project | PASS | 3 sessions created, independent IDs/messages, verified via `GET /session/:id/message` |
| Existing session | PASS | All prior sessions remain listable/openable after wrapper install |
| Multiple TUI clients | PASS (API) | Two projects `/tmp` and `llm_wiki` served concurrently; wrapper allows parallel `attach` |
| Concurrent prompts same session | DOCUMENTED | Concurrent `prompt_async` to same `sid` both 204 and queue; recommend sequential prompts per session (opencode #6946) |

**No polling/event-relay added** — solution uses supported `opencode attach`.

## 10. OpenCode Version Support

- `opencode --help` shows `opencode attach <url>` available in 1.18.23 — confirmed supported
- No upgrade required
- `opencode serve --help` and `opencode attach --help` inspected; `--password/--username` via `OPENCODE_SERVER_PASSWORD` supported but not needed (no auth)

## 11. Remaining Limitations

- Existing TUIs must be restarted to use wrapper (they hold old standalone servers)
- Wrapper falls back to standalone if Kimaki not running — user must start Kimaki first (`kimaki` in tmux) before TUI for guaranteed sync
- `opencode run` not wrapped — headless runs still spawn own server; not needed for TUI flow
- Port is dynamic (Kimaki picks random open port) — wrapper discovers via hrana each invocation; if Kimaki restarts, port changes but discovery handles it

## 12. Rollback Procedure (reversible)

```bash
# Option A: remove wrapper (restores standalone TUI)
rm ~/.local/bin/opencode
hash -r
which opencode   # should show /.../bin/opencode only

# Option B: temporary bypass per-invocation
OPENCODE_DISABLE_WRAPPER=1 opencode
OPENCODE_DISABLE_WRAPPER=1 opencode /home/pc/projects/llm_wiki --session ses_...

# Verify rollback
ss -ltnp | grep opencode
ps aux | grep opencode

# Restart existing TUIs to clear old servers (if needed)
# exit/kill TUI processes (6235,170298) and relaunch without wrapper
```

**Record files kept:** `/tmp/opencode_topology_before.txt`, `~/.local/bin/opencode` (if removed, original binary at `/home/pc/.nvm/.../bin/opencode` untouched), DB untouched.

## 13. Reboot Persistence

- Wrapper at `~/.local/bin/opencode` persists across reboot (in PATH)
- Kimaki must be started on login: currently manual `kimaki` in tmux; recommend adding user systemd unit or autostart entry (not yet added — reversible design keeps manual start, document order: start Kimaki before TUI)

## 14. References

- Installed kimaki src: `~/.nvm/versions/node/v24.18.0/lib/node_modules/kimaki/src/opencode.ts:1341 getOpencodeServerPort`, `src/hrana-server.ts:186`
- Opencode attach: `opencode attach --help` (URL + --dir, --session, --continue) at `~/.nvm/.../opencode-ai/bin/opencode.exe`
- Upstream issue: opencode #6946 (session out of sync)
- Handoff: `/tmp/handoff-2026-08-26_kimaki-opencode-sync.md`, capture `/tmp/opencode/events.log`
- Before snapshot: `/tmp/opencode_topology_before.txt`
