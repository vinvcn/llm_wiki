#!/usr/bin/env bash
# Standing acceptance gates for the llm_wiki web↔desktop parity work.
#
# This suite is the DURABLE home of the gate harnesses (they used to live in
# /tmp only; /tmp is volatile between runs). Run:  bash scripts/verify/gates.sh
# The /tmp/gates.sh wrapper simply execs this file. Every gate must pass and
# the suite must always end GATES_OK; treating the green set as a regression
# unless a changed harness passes is a regression.

set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERIFY="$REPO/scripts/verify"
cd "$REPO" || exit 1

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RST=$'\033[0m'
PASS=0; FAIL=0; SKIPPED=0
LAST=()

step() { echo; echo "===== $* ====="; }

run_gate() {
  local name="$1"; shift
  local file="$VERIFY/$name.mjs"
  if [ ! -f "$file" ] && [ -f "/tmp/$name.mjs" ]; then file="/tmp/$name.mjs"; fi
  if [ ! -f "$file" ]; then echo "  ${YEL}SKIP${RST} - $name (harness missing)" ; SKIPPED=$((SKIPPED+1)); LAST+=("$name:SKIP(missing harness)"); return 0; fi
  echo "  · $name"
  local out
  out=$(node "$file" "$@" 2>&1)
  local rc=$?
  if [ $rc -eq 0 ]; then
    PASS=$((PASS+1)); echo "  ${GRN}OK${RST}   - $name"; LAST+=("$name:PASS")
    echo "$out" | grep -E "passed|ok  -" | tail -2 | sed 's/^/         /'
  else
    FAIL=$((FAIL+1)); echo "  ${RED}FAIL${RST} - $name"; LAST+=("$name:FAIL")
    echo "$out" | tail -12 | sed 's/^/         /'
  fi
}

skip_gate() {
  local name="$1"; shift
  local why="$1"
  SKIPPED=$((SKIPPED+1)); LAST+=("$name:SKIP($why)")
  echo "  ${YEL}SKIP${RST} - $name  — $why"
}

# ── 1. Static gates ─────────────────────────────────────────────────────────
step "node --check every packages/server/src/**/*.js"
while IFS= read -r f; do
  node --check "$f" || { echo "  ${RED}FAIL${RST} - node --check $f"; FAIL=$((FAIL+1)); }
done < <(find packages/server/src -name "*.js" -type f | sort)
PASS=$((PASS+1)); LAST+=("node --check:PASS")
echo "  ${GRN}OK${RST}   - node --check $(find packages/server/src -name '*.js' | wc -l) files"

step "npx tsc --build"
if npx tsc --build >/tmp/gates-tsc.log 2>&1; then PASS=$((PASS+1)); LAST+=("tsc:PASS"); echo "  ${GRN}OK${RST}   - tsc --build"
else FAIL=$((FAIL+1)); LAST+=("tsc:FAIL"); echo "  ${RED}FAIL${RST} - tsc --build"; tail -20 /tmp/gates-tsc.log | sed 's/^/    /'; fi

step "npm test -w @llm-wiki/server"
if npm test -w @llm-wiki/server >/tmp/gates-server.log 2>&1; then PASS=$((PASS+1)); LAST+=("server-tests:PASS"); tail -2 /tmp/gates-server.log | sed 's/^/  /'; echo "  ${GRN}OK${RST}   - server tests"
else FAIL=$((FAIL+1)); LAST+=("server-tests:FAIL"); echo "  ${RED}FAIL${RST} - server tests"; tail -25 /tmp/gates-server.log | sed 's/^/    /'; fi

step "npm run test:mocks"
if npm run test:mocks >/tmp/gates-mocks.log 2>&1; then PASS=$((PASS+1)); LAST+=("mocks:PASS"); tail -2 /tmp/gates-mocks.log | sed 's/^/  /'; echo "  ${GRN}OK${RST}   - frontend mock tests"
else FAIL=$((FAIL+1)); LAST+=("mocks:FAIL"); echo "  ${RED}FAIL${RST} - mock tests"; tail -25 /tmp/gates-mocks.log | sed 's/^/    /'; fi

step "npm run build:web"
if npm run build:web >/tmp/gates-build.log 2>&1; then PASS=$((PASS+1)); LAST+=("build:web:PASS"); echo "  ${GRN}OK${RST}   - dist-web built"
else FAIL=$((FAIL+1)); LAST+=("build:web:FAIL"); echo "  ${RED}FAIL${RST} - build:web"; tail -25 /tmp/gates-build.log | sed 's/^/    /'; fi

# ── 2. Shared-data / file-sync (both server entrypoints) ────────────────────
step "Shared-data + source-snapshot/queue interop (desktop contract)"
run_gate verify-filesync-shared
SERVER_ENTRY=packages/server/src/index-v2.js run_gate verify-filesync-shared

step "Source-text + preprocessing-cache parity (desktop fs.rs read_file / preprocess_file contract)"
run_gate verify-source-text
SERVER_ENTRY=packages/server/src/index-v2.js run_gate verify-source-text

# ── 3. Agent harnesses (mock OpenAI-compatible LLM, no real key) ────────────
step "Agent runtime contracts"
run_gate verify-agent
run_gate verify-agent-sessions
run_gate verify-shell-approval
run_gate verify-user-ask
run_gate verify-agent-offline

# ── 4. Headless browser gates (Chromium via playwright-core) ────────────────
step "Headless browser gates"
run_gate verify-browser-boot
run_gate verify-browser-e2e
run_gate verify-browser-ingest
run_gate verify-browser-chat
run_gate verify-browser-research
run_gate verify-clip-server

# ── 5. Vector / embedding parity (both entrypoints) ─────────────────────────
step "Vector store + embedding-fetch + hybrid search"
run_gate verify-vectorstore

# ── 6. Parity-surface invariants (the continuation greps, mechanized) + pure ─
# ──    command parity harnesses ──────────────────────────────────────────────
step "Parity-surface static invariants (no throwing stubs / Rust+frontend command coverage / web-shim aliases)"
run_gate verify-surface-parity

step "Command parity harnesses"
run_gate verify-opener
run_gate verify-anytxt
run_gate verify-cli-transports
run_gate verify-websearch
SERVER_ENTRY=packages/server/src/index-v2.js run_gate verify-websearch

step "Port-conflict boot diagnostics (both entries)"
run_gate verify-port-conflict

# ── 6b. Outbound proxy parity (desktop proxy.rs contract, both entries) ────
step "Proxy env parity (proxy.rs contract, both entries)"
run_gate verify-proxy-env
SERVER_ENTRY=packages/server/src/index-v2.js run_gate verify-proxy-env

step "Proxy binary body envelope (bodyBase64 / formEntries / byte-exact, both entries)"
run_gate verify-proxy-binary
SERVER_ENTRY=packages/server/src/index-v2.js run_gate verify-proxy-binary

# ── 6c. External REST API contract (api_server.rs, legacy index.js entry) ──
step "V1 external REST API contract (desktop api_server.rs)"
run_gate verify-api-v1

step "MCP-client interop (bundled mcp-server over stdio, real client, both entries)"
run_gate verify-mcp-interop
SERVER_ENTRY=packages/server/src/index-v2.js run_gate verify-mcp-interop

# ── 7. Browser feature e2e gates + v2 surface sanity (shipped entry) ────────
step "Browser feature e2e gates + v2 surface sanity (shipped entry)"
run_gate verify-browser-mineru
run_gate verify-scheduled-import
run_gate verify-v2-server

step "Ingest liveness heartbeat (issue #32, shipped v2 entry)"
run_gate verify-ingest-heartbeat

# ── 8. Report ───────────────────────────────────────────────────────────────
echo
echo "──────────────────────────────────────────────"
for l in "${LAST[@]}"; do echo "  $l"; done
echo "──────────────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  echo "${GRN}GATES_OK${RST} (${PASS} passed, ${SKIPPED} skipped, 0 failed)"
  exit 0
else
  echo "${RED}GATES_FAILED${RST} (${PASS} passed, ${SKIPPED} skipped, ${FAIL} failed)"
  exit 1
fi
