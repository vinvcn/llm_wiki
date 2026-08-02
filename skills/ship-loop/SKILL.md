---
name: ship-loop
description: Drive a change to shipped through three gates — an inner implement↔review loop, a CI gate, and a real-user-validation gate, each rolling back to implement on failure — recording each gate as a GitHub comment and opening the PR in step 0, not at the end. Fans out subagents at every stage (parallel implementation, a planning agent, a Playwright fleet of one-agent-per-scenario, parallel review axes). Use when the user says "ship loop", "run the loop", "implement and validate", "validate it like a real user", or asks to build/fix a feature and prove it works in the real app before shipping.
argument-hint: "What feature/fix should the loop ship? (optional: scope or acceptance criteria)"
---

# Ship Loop

Two nested loops plus a CI gate. Three stages end in a **gate** — a binary
pass/fail that decides where control flows next. A change ships only when it
clears all three: review, CI, and validation. The two cheap gates (review, CI)
run before the expensive validation fleet.

```
  0. PLAN ──► ┌──────────── INNER LOOP (tight) ────────────┐
  validation  │                                            │
  plan, once; │   1. IMPLEMENT ──────► 2. REVIEW           │
  re-eval'd   │     open/update PR,       │                │
  at each     │     commit + push         │ review gate    │
  validation  │     ▲                     ▼                │
  gate        │     └────── fail ──── pass ──► to step 3   │
              └────────────────────────────────────────────┘
                                        │
                                        ▼
                                      3. CI GATE
                                  fail ───┤─── pass
                                    │           │
                         (→ back to IMPLEMENT)  ▼
                              4. USER-VALIDATE (run the plan)
                                        │ validation gate
                              fail ─────┤───── pass
                                │                │
                     (→ back to IMPLEMENT)       ▼
                                              5. SHIP
```

**Transitions (the whole contract):**
- review **fail** → IMPLEMENT
- review **pass** → CI
- CI **fail** → IMPLEMENT (re-enter the inner loop)
- CI **pass** → USER-VALIDATE
- validation **fail** → IMPLEMENT (re-enter the inner loop)
- validation **pass** → SHIP

**Two rules that never change:**
- **The PR is live from step 0.** The PR is opened in step 0 and updated (commit
  + push) every iteration — work is never held locally until the end.
- **Every gate is a GitHub comment.** The plan, each review result, each CI
  result, each validation result, and the ship note are posted to the PR, so the
  record of why it shipped lives on the PR, not in chat. Comment shapes in
  [`COMMENTS.md`](COMMENTS.md).

---

## 0. Plan the validation (and open the PR)

Author the real-user scenario set **before any code**, ideally with a dedicated
planning subagent that reads the ticket/diff + the feature's user-facing surface
and returns the scenario list. Planning up front is what stops a fan-out from
testing one flow twice and missing another.

A plan is a list of **user journeys, not assertions**. Each scenario names:
- its **route/entry point**;
- the **steps** a real user takes — the set as a whole covers the happy path, the
  flows the change touches, and at least one error/edge path;
- the **observable outcome** that proves success, drawn from the evidence the
  harness collects in step 4 (DOM text, console messages, network responses,
  dialog events) — never pixels.

Scenarios are **deduped**: each owns one distinct user goal.

Then **open the PR** if it doesn't exist (draft is fine — what/why, ticket link,
how to test) and **post the plan as a GitHub comment** on it (shape in
[`COMMENTS.md`](COMMENTS.md)).

**Completion criterion:** every user-facing behavior the change introduces or
touches is covered by exactly one scenario, the PR exists, and the plan is
posted. The plan is re-evaluated each time control returns to the validation
gate (step 4 owns that re-evaluation).

## 1. Implement (commit · push · keep the PR current)

Implement the change (use `/tdd` at seams you and the user agreed to test-first;
typecheck and run targeted tests as you go).

Then, **every iteration**:
- **update the PR** opened in step 0 if the change needs its context refreshed;
- if addressing review or validation findings, **post a comment** mapping each
  finding to its fix (shape in [`COMMENTS.md`](COMMENTS.md));
- **commit and push.** The PR reflects the latest state before review starts.

Fan out independent pieces (separate files or subsystems, or a repeated
edit applied across many files) as parallel subagents via the `Agent` tool; use
`isolation: "worktree"` only when agents mutate files in parallel and would
conflict.

**Completion criterion:** the change is committed and pushed, the PR is current,
and typecheck + the relevant test files pass. A green build is the *floor*, not
the gate.

## 2. Review (inner gate)

Run both, in parallel where possible:
- `/code-review` — runs its **Standards** and **Spec** axes as parallel
  subagents; aggregate without merging the axes.
- `/open-code-review-delegate` — `ocr delegate preview` → `ocr delegate rule` →
  review each file against its rules → classify by severity.

For a large diff, split the review across subagents by concern, security-critical
paths first (auth, proxy/SSRF, shell/command injection, path traversal,
subprocess spawning). Verify each finding that isn't obviously a false positive
adversarially before treating it as real.

**Post the review result as a GitHub comment** — findings by severity and the
gate verdict (shape in [`COMMENTS.md`](COMMENTS.md)).

**Gate (binary):**
- **pass** = no critical/high findings → advance to step 3. Record medium/low as
  follow-up tickets, not blockers — fix one inline only if it's a one-line change.
- **fail** = any critical/high → return to step 1 and fix.

**Completion criterion:** the review comment is posted and states pass or fail.

## 3. CI gate

Mark the PR ready (if it was draft) and confirm the **CI gate is green**.

**Post the CI result as a GitHub comment** — green/red summary and the gate
verdict (shape in [`COMMENTS.md`](COMMENTS.md)).

**Gate (binary):**
- **pass** = CI green → advance to step 4.
- **fail** = CI red → return to step 1 and fix.

**Completion criterion:** the CI comment is posted and CI is green.

## 4. User-validate (outer gate)

**Re-evaluate the plan first.** For the changes introduced since the last
validation, confirm the step-0 plan still covers them: add scenarios for new
surface, drop any now-irrelevant, leave the rest. Post the re-evaluation as a
comment (delta from the prior plan, or "Plan unchanged").

**Build/reuse a Playwright harness** that:
- launches an **isolated app instance per scenario** (own port + data dir) so
  scenarios never clobber each other's state;
- drives a **headless browser**;
- collects the evidence the plan's outcomes are written against — **DOM text,
  `page.on('console')`, `page.on('response')`, dialog events** (assert on these;
  the model sees no pixels, so never screenshots);
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
- **pass** = every scenario passed → advance to step 5.
- **fail** = any genuine failure → return to step 1 (re-enter the inner loop).

**Completion criterion:** the validation comment is posted, every scenario has a
verdict, and the gate states pass or fail.

## 5. Ship

Reached only when all three gates have passed in sequence. **Post a ship
comment** summarizing the gates it cleared and any deferred follow-ups (ticket
links).

Never push to main, force-push, or merge — those are the user's calls.

**Completion criterion:** the ship comment is posted.

---

## Related Skills

This workflow invokes or extends the following skills:

- **`/implement`** — this workflow extends `/implement`'s loop (implement → code-review → commit) by adding validation and CI gates. Step 1 does the same work `/implement` would, but the ship-loop controls when it runs and what gates it must clear.
- **`/tdd`** — step 1 invokes this at pre-agreed seams to write tests before implementation.
- **`/code-review`** — step 2 runs this to execute the Standards + Spec axes review as parallel subagents.
- **`/open-code-review-delegate`** — step 2 runs this for OCR rule-based review (preview → rule → review each file against its rules).

If `/tdd`, `/code-review`, or `/open-code-review-delegate` are unavailable, the corresponding step degrades (implement without test-first; review without one or both axes).

---

## Notes

- **Why two loops.** "Tests pass" and "review clean" both ≠ "works for a user."
  The validation gate has caught bugs unit tests and review missed (a dialog that
  silently disabled a button; an auth mode that locked users out). Review is the
  *tight* inner loop because it's cheap; CI is also cheap and runs right after
  the loop exits; validation is the *outer* gate because it's expensive — you
  only pay for the fleet once review and CI already pass.
- **Cost scales with risk.** A one-line fix needs one scenario and a light
  review; a migration needs a full fleet and split-axis review. Scale the fan-out
  to the blast radius of the change.
- **Artifacts over chat.** Genuine bugs and deferred medium/low findings become
  GitHub issues with reproduction steps, referenced from the PR comments.
