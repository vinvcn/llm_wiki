---
name: ship-loop
description: Drive a change to shipped through two nested gates — an inner implement↔review loop, then a real-user-validation gate that rolls back to implement on failure — recording each gate as a GitHub comment and opening/updating the PR in step 1, not at the end. Fans out subagents at every stage (parallel implementation, a planning agent, a Playwright fleet of one-agent-per-scenario, parallel review axes). Use when the user says "ship loop", "run the loop", "implement and validate", "validate it like a real user", or asks to build/fix a feature and prove it works in the real app before shipping.
argument-hint: "What feature/fix should the loop ship? (optional: scope or acceptance criteria)"
---

# Ship Loop

Two nested loops, each stage ending in a **gate** — a binary pass/fail that
decides where control flows next. A change ships only when it clears both.

```
  0. PLAN ──► ┌──────────── INNER LOOP (tight) ────────────┐
  validation  │                                            │
  plan, once; │   1. IMPLEMENT ──────► 2. REVIEW           │
  re-eval'd   │     ▲ open/update PR,     │                │
  at each     │     │ commit + push       │ review gate    │
  validation  │     │                     ▼                │
  gate        │     └────── fail ──── pass ──► to step 3   │
              └────────────────────────────────────────────┘
                                        │
                                        ▼
                              3. USER-VALIDATE (run the plan)
                                        │ validation gate
                              fail ─────┤───── pass
                                │                │
                     (→ back to IMPLEMENT)       ▼
                                            4. SHIP
```

**Transitions (the whole contract):**
- review **fail** → IMPLEMENT
- review **pass** → USER-VALIDATE
- validation **fail** → IMPLEMENT (re-enter the inner loop)
- validation **pass** → SHIP

**Two rules that never change:**
- **The PR is live from step 1.** Implement opens or updates the PR and commits
  + pushes *every* iteration — work is never held locally until the end.
- **Every gate is a GitHub comment.** The plan, each review result, each
  validation result, and the ship note are posted to the PR, so the record of
  why it shipped lives on the PR, not in chat. Comment shapes in
  [`COMMENTS.md`](COMMENTS.md).

Use subagents wherever a stage can fan out — that is the point of this workflow.

---

## 0. Plan the validation (once; re-evaluate at every validation gate)

Author the real-user scenario set **before any code**, ideally with a dedicated
planning subagent that reads the ticket/diff + the feature's user-facing surface
and returns the scenario list. Planning up front is what stops a fan-out from
testing one flow twice and missing another.

A plan is a list of **user journeys, not assertions**. Each scenario names:
- its **route/entry point**;
- the **steps** a real user takes (happy path, a touched/regression flow, and at
  least one error/edge path across the set);
- the **observable outcome** that proves success — DOM text, a created artifact,
  a network response — the things an agent can actually assert on (not pixels).

Scenarios are **deduped**: each owns one distinct user goal.

**Post the plan as a GitHub comment** on the PR (shape in [`COMMENTS.md`](COMMENTS.md)).

**Completion criterion:** every user-facing behavior the change introduces or
touches is covered by exactly one scenario, and the plan is posted. This step
re-runs (as a *re-evaluation*, not a rewrite) each time control returns to the
validation gate — see step 3.

## 1. Implement (open/update PR · commit · push)

Make the change. Prefer invoking `/implement` (uses `/tdd` at pre-agreed seams;
typechecks and runs targeted tests as it goes).

Then, **in this step, every iteration**:
- if no PR exists for this branch, **open it** (draft is fine) with enough
  context to review against — what/why, the ticket link, how to test;
- if addressing review or validation findings, **post a comment** mapping each
  finding to its fix (shape in [`COMMENTS.md`](COMMENTS.md));
- **commit and push.** The PR reflects the latest state before review starts.

Fan out independent pieces (separate files/subsystems, or a find-then-transform
sweep) as subagents via `Agent`/`Workflow`; use `isolation: "worktree"` only when
agents mutate files in parallel and would conflict.

**Completion criterion:** the change is committed and pushed, the PR exists and
is current, and typecheck + the relevant test files pass. A green build is the
*floor*, not the gate.

## 2. Review (inner gate)

Run both, in parallel where possible:
- `/code-review` — runs its **Standards** and **Spec** axes as parallel
  subagents; aggregate without merging the axes.
- `/open-code-review-delegate` — `ocr delegate preview` → `ocr delegate rule` →
  review each file against its rules → classify by severity.

For a large diff, split the review across subagents by concern, security-critical
paths first (auth, proxy/SSRF, shell/command injection, path traversal,
subprocess spawning). Verify each non-trivial finding adversarially before
treating it as real.

**Post the review result as a GitHub comment** — findings by severity and the
gate verdict (shape in [`COMMENTS.md`](COMMENTS.md)).

**Gate (binary):**
- **pass** = no critical/high findings → advance to step 3. Record medium/low as
  follow-up tickets, not blockers, unless cheap to fix now.
- **fail** = any critical/high → return to step 1 and fix.

**Completion criterion:** the review comment is posted and states pass or fail.

## 3. User-validate (outer gate)

**Re-evaluate the plan first.** For the changes introduced since the last
validation, confirm the step-0 plan still covers them: add scenarios for new
surface, drop any now-irrelevant, leave the rest. Post the re-evaluation as a
comment (delta from the prior plan, or "unchanged").

Then run it. **Build/reuse a Playwright harness** that:
- launches an **isolated app instance per scenario** (own port + data dir) so
  scenarios never clobber each other's state;
- drives a **headless browser**;
- collects evidence the model can read — **DOM text, `page.on('console')`,
  `page.on('response')`, dialog events** (assert on these, not screenshots — the
  model sees no pixels);
- uses a **mock LLM provider** (a tiny OpenAI-compatible server returning canned
  chat + deterministic embeddings) so scenarios run without real API keys.

**Fan out one subagent per scenario** — hand each agent exactly one scenario from
the (re-evaluated) plan; letting agents pick their own is how two end up on the
same flow. Each returns a structured verdict: `pass | fail`, steps taken,
evidence (console errors, failed responses, unexpected DOM).

Triage: separate genuine bugs (verify against the code before filing) from
harness artifacts (e.g. a view needing a manual refresh). **Post the validation
result as a GitHub comment** — per-scenario verdicts + evidence (shape in
[`COMMENTS.md`](COMMENTS.md)).

**Gate (binary):**
- **pass** = every scenario passed → advance to step 4.
- **fail** = any genuine failure → return to step 1 (re-enter the inner loop).

**Completion criterion:** the validation comment is posted, every scenario has a
verdict, and the gate states pass or fail.

## 4. Ship

Reached only when both gates have passed in sequence.
- mark the PR ready (if it was draft) and confirm the **CI gate is green** — a CI
  failure re-enters at step 1;
- **post a ship comment** summarizing the gates it cleared and any deferred
  follow-ups (ticket links).

Never push to main, force-push, or merge — those are the user's calls.

**Completion criterion:** CI is green and the ship comment is posted.

---

## Notes

- **Why two loops.** "Tests pass" and "review clean" both ≠ "works for a user."
  The validation gate has caught bugs unit tests and review missed (a dialog that
  silently disabled a button; an auth mode that locked users out). Review is the
  *tight* inner loop because it's cheap; validation is the *outer* gate because
  it's expensive — you only pay for the fleet once review already passes.
- **Cost scales with risk.** A one-line fix needs one scenario and a light
  review; a migration needs a full fleet and split-axis review. Scale the fan-out
  to the blast radius of the change.
- **Artifacts over chat.** Genuine bugs and deferred medium/low findings become
  GitHub issues with reproduction steps, referenced from the PR comments — the
  PR is the record of why it shipped.
