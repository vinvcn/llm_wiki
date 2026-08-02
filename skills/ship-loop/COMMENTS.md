# GitHub Comment Shapes

Templates for the PR comments each gate posts. Keep them short and factual —
they are the durable record of *why* the change shipped. Post with
`gh pr comment <n> --body "…"`. Replace `<n>` with the PR number (open the PR in
step 0 if it doesn't exist yet).

## Step 0 — Validation plan

```markdown
## User-validation plan

Scenarios to prove this works for a real user (re-evaluated at each validation gate):

1. **<journey name>** — route: `<entry point>`
   steps: <what the user does>
   proves success when: <observable DOM text / console message / network response / dialog event>
2. …

Coverage: happy path ✅ · touched flows ✅ · error/edge path ✅
```

On **re-evaluation** (step 4), post the delta instead of the full list:
`Added: <n> (<why>). Dropped: <n> (<why>). Unchanged: <n>.` — or "Plan unchanged."

## Step 1 — Addressing findings (only when fixing review/validation findings)

```markdown
## Addressing findings

| Finding | Severity | Fix |
|---|---|---|
| <one-line finding> | high | <commit / what changed> |
| … | | |

Pushed as <commit-sha(s)>.
```

## Step 2 — Review result

```markdown
## Code review — <PASS | FAIL>

- Standards axis: <n findings, most severe>
- Spec axis: <n findings, most severe>
- Critical/High: <list, or "none">
- Medium/Low (deferred → <ticket>): <list, or "none">

Gate: <PASS — advancing to CI | FAIL — returning to implement>.
```

## Step 3 — CI result

```markdown
## CI — <PASS | FAIL>

<CI summary: checks run, green/red>.

Gate: <PASS — advancing to user validation | FAIL — returning to implement>.
```

## Step 4 — Validation result

```markdown
## User validation — <PASS | FAIL>

| Scenario | Verdict | Evidence |
|---|---|---|
| <journey name> | ✅ pass | <key DOM text / response> |
| <journey name> | ❌ fail | <console error / failed response / unexpected DOM> |

Genuine failures (verified against code): <list, or "none">
Harness artifacts (not bugs): <list, or "none">

Gate: <PASS — advancing to ship | FAIL — returning to implement>.
```

## Step 5 — Ship

```markdown
## Shipped ✅

Cleared: review gate (PASS) → CI gate (PASS) → user-validation gate (PASS, <n>/<n> scenarios).
Deferred follow-ups: <ticket links, or "none">.
```
