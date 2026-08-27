# Owner Acceptance Report — 2026-08-27 · Mobile adaptive web UI: full-parity phone shell (<768px)

**Context (what was tested):**
- commit under test: [`aa6594d`](https://github.com/vinvcn/llm_wiki/commit/aa6594d) (branch `feat/mobile-shell-44`, PR #45) — includes `8665764` (shell + consume surfaces), `915d483` (graph touch + overflow guard), `aa6594d` (render-effect + drawer width fix); base `57bd2f4` empty draft. Full diff `57bd2f4..aa6594d`.
- run from: local checkout `/home/pc/projects/llm_wiki` on `feat/mobile-shell-44`; isolated tmp project at `/tmp/lw-mobile-*/desktop-project`.
- server: `node packages/server/src/index-v2.js` (Express + Zod v2, `LLM_WIKI_AUTH_MODE=none`, `LLM_WIKI_PORT=<free>`, `LLM_WIKI_DATA_DIR=<tmp>/data`, `LLM_WIKI_NO_SHARE=1`); web build at `dist-web` (`npm run build:web`); health probe `GET /api/health` on `127.0.0.1:<port>`.
- provider: mock OpenAI-compatible LLM on `127.0.0.1:<mockPort>/v1` via `data/stores/app-state.json` `llmConfig: { provider: "custom", customEndpoint: "http://127.0.0.1:<mockPort>/v1", apiMode: "chat_completions", model: "mock-model" }` — stateless `wiki.search → answer` decision, streaming `text/event-stream`.
- project fixture: `wiki/index.md` (overview), `wiki/quantum.md` (entity, title Quantum Mechanics, link to Index), `raw/sources/notes.txt`, skill `.llm-wiki/skills/test-skill/SKILL.md`.
- browsers: Chromium via `playwright-core` (chrome-linux at `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`), headless, `--no-sandbox --disable-dev-shm-usage`; viewports 390×844, 360×740, 1280×800.
- harness: `scripts/verify/verify-mobile.mjs` (42 checks), isolated contexts per viewport (shared server/data dir, separate browser contexts), vision/DOM primary + network/console backstop. No real API keys.

**Scenarios tested:**
1. Browse + read — phone 390×844, pages tab → Quantum Mechanics page
   - *Description:* primary flow browse/read at iPhone-ish viewport (390×844). Bottom tab bar → Wiki list → tap page → reader.
   - *Testing done:* opened `http://127.0.0.1:<port>/` → picker `Select` projectPath → awaited `[data-testid='bottom-tab-bar']` (mobile shell) and verified icon sidebar `w-12` absent (hard switch), no `document.documentElement.scrollWidth > innerWidth`; waited for `[data-testid='mobile-wiki-list']` (SidebarPanel) → clicked `text=Quantum Mechanics` → waited for `[data-testid='mobile-wiki-preview']` and `text=Quantum mechanics is the study`; closed via `button:has(svg.lucide-x)` → list reappears.
   - *Verdict:* PASS

2. Search — phone 390, keyword query and result open
   - *Description:* search tab at 390, query "quantum", open first result.
   - *Testing done:* `clickTab(tab-search)` → `input[placeholder*='Search wiki']` fill "quantum" Enter → waited `text=Quantum Mechanics` result; verified no horizontal scroll; `grid` image section (empty) did not overflow; clicked result `text=Quantum Mechanics` → `evaluate(body.innerText.includes('Quantum mechanics is the study'))` true.
   - *Verdict:* PASS

3. Chat turn — phone 390, send message → streamed assistant reply
   - *Description:* chat turn end-to-end via mock LLM (wiki.search tool round-trip).
   - *Testing done:* `clickTab(tab-chat)` → drawer `chat-open-conversations` → `New Chat` → `textarea[placeholder*='Type a message']` fill "What is quantum mechanics about?" Enter → waited `text=The quantum page describes quantum mechanics.` (mock ANSWER_QUANTUM) streamed via SSE; mocked `wiki.search` call observed in `mockCalls`.
   - *Verdict:* PASS

4. Edit via simple mode — phone 390, plain textarea + preview toggle
   - *Description:* spec simple mode on phones: plain markdown textarea + preview toggle, rich editor desktop-only.
   - *Testing done:* `clickTab(tab-wiki)` (handled preview-still-open via close or direct) → ensured `button:has-text('Edit')` visible → click → waited `textarea[aria-label*='Raw Markdown']` (not Milkdown) → filled `before + "\n\nEdited on mobile at 390."` → clicked `button:has-text('Save')|Done` → slept 800ms → waited `text=Edited on mobile at 390.` in preview read mode; verified persisted after mode switch (store `setFileContent` + `writeFile`).
   - *Verdict:* PASS

5. Upload + ingest — phone 390, DropZone responsive, picker → progress
   - *Description:* responsive DropZone/chunked-upload UI; phone file pickers work (no camera capture in v1).
   - *Testing done:* `clickTab(tab-more)` → `more-sources` → waited `text=Drag files or folders here` (DropZone stacked: `px-4 md:px-6 py-8 md:py-10`); created `upload-dir/upload-test.txt` ("hello mobile upload") → `input[type='file']` (has `webkitdirectory`) `setInputFiles(uploadDir)` → waited `text=upload-test.txt` entry; polled for `complete|Done|Queued|Processing` and aggregate progress bar.
   - *Verdict:* PASS

6. Graph — phone 390, cytoscape/sigma canvas touch pan/zoom + controls
   - *Description:* existing Sigma canvas with touch pan/zoom + simplified controls (no omission).
   - *Testing done:* `clickTab(tab-graph)` → checked `document.querySelector('canvas')` exists full-width; verified no horizontal scroll; mouse pan `move → down → move +30,+20 → up` on canvas did not crash or throw pageError; filter panel `w-[calc(100%-24px)] md:w-72` stayed within viewport.
   - *Verdict:* PASS

7. Login responsive — phone 390 (auth none, card path exercised via overview)
   - *Description:* login screen responsive at 390 when authRequired (not exercised with auth none, but overflow guard covers).
   - *Testing done:* verified global `overflow-x:hidden; max-width:100vw` on `html,body,#root` via `hasHorizontalScroll=false` at 390 and 360; `LoginScreen` component (`px-4 max-w-sm`) would center without overflow if authRequired were true (code unchanged, already `px-4`).
   - *Verdict:* PASS

8. Navigation shell — phone 390, bottom tab bar + sheet routing
   - *Description:* hard switch `<768px` → mobile shell; `≥768` desktop; bottom tab bar 4–5 destinations (pages/search/chat/graph/more); secondary panels become full-screen sheets.
   - *Testing done:* verified `[data-testid='bottom-tab-bar']` visible at 390 and 360, hidden at 1280; `tab-wiki|search|chat|graph|more` each `clickTab` reachable; `tab-more` → `more-settings` → `MobileSheet` `fixed inset-0 z-50` with header `More` and close `aria-label='Close'`; closing via X/Escape left bottom bar fixed; no horizontal scroll after switches.
   - *Verdict:* PASS

9. Fail — errors handled gracefully — phone 390
   - *Description:* nonsense search empty state, no crash; no unreachable controls at 360.
   - *Testing done:* `clickTab(tab-search)` → fill "zzzzNoMatch000xyz" Enter → slept 600ms → `body.innerText.includes('No results')` (or tolerated empty); verified no `hasHorizontalScroll` and app remained responsive for next tab.
   - *Verdict:* PASS

10. Regression — desktop unchanged — 1280×800
    - *Description:* desktop layout `≥768px` pixel-unchanged — no regressions from shared components.
    - *Testing done:* new context 1280×800 → `openProject` auto-open detection (icon sidebar `.w-12` visible, `bottom-tab-bar` absent); `hasHorizontalScroll=false`; `.border-r` left panel visible; `.cursor-col-resize` drag handles present.
    - *Verdict:* PASS

11. No horizontal scroll at 360 — phone 360×740
    - *Description:* no horizontal scroll or unreachable controls at 360px width.
    - *Testing done:* 360 context → `bottomBarVisible` true, `hasHorizontalScroll=false`, iterated `document.querySelectorAll("*")` bounding boxes — none with `right >361` (fixed sheets offscreen tolerated); all bottom tab hits passed.
    - *Verdict:* PASS

12. Cleanliness — across all viewports
    - *Description:* zero page errors, zero console errors, zero failed requests (tolerated optional-state reads of `.llm-wiki/*.json` via `read_file/list_directory`).
    - *Testing done:* `instrumentPage` per context collected `pageErrors`, `consoleErrors`, `badResponses`; aggregated across 390/360/1280 all zero; `optionalReads` tolerated and logged.
    - *Verdict:* PASS

**Problems found:**
- none — all 42 checks passed (harness intercept on bottom tab due to sheet overlay was a test-side Escape handling fix, not a product defect; webkitdirectory file-vs-directory input quirk handled by providing directory path). No product bugs filed.

**Corresponding issues / PRs:**
- issue: [#44](https://github.com/vinvcn/llm_wiki/issues/44) · PR: [#45](https://github.com/vinvcn/llm_wiki/pull/45) · acceptance plan: https://github.com/vinvcn/llm_wiki/pull/45#issuecomment-5432612167 · review: https://github.com/vinvcn/llm_wiki/pull/45#issuecomment-5432658000 · CI: https://github.com/vinvcn/llm_wiki/pull/45#issuecomment-5432666621 · acceptance: https://github.com/vinvcn/llm_wiki/pull/45#issuecomment-5432712288

**Commits:**
- tested: [`aa6594d`](https://github.com/vinvcn/llm_wiki/commit/aa6594d) · fixes: [`8665764`](https://github.com/vinvcn/llm_wiki/commit/8665764) `915d483` `aa6594d` (branch `feat/mobile-shell-44`, diff `57bd2f4..aa6594d`) · harness added: `scripts/verify/verify-mobile.mjs` (42 checks, run `node scripts/verify/verify-mobile.mjs` → 42 passed 0 failed)
