# Owner Acceptance Checks — Index

## Purpose

This directory is the **traceable record of owner acceptance checks** for this
project; this file is its index. Whenever the owner runs a live acceptance
session against the app (manual testing of real flows — upload, chat, search,
settings, deployment behavior), the session is written up as **one report
file** in this directory and listed in the [index table](#reports-index) below,
so that what was tested, what broke, and what fixed it stays auditable after
the chat thread is gone.

Each report lives in its own file (see the [naming convention](#naming-convention));
this index holds everything else: the report outline, the writing rules, and
the chronological index of report files.

## Suggested report outline

Each report file should follow this shape (adapt section names if needed, keep
the information):

```markdown
# Owner Acceptance Report — YYYY-MM-DD · <title: what is being tested>

**Context (what was tested):**
- commit / version under test (link), worktree or deployment it ran from,
  URL/port, auth mode, data dir, provider configuration (no secrets),
  anything unusual about the environment.

**Scenarios tested:**
1. <scenario title>
   - *Description:* which flow, which inputs.
   - *Testing done:* what was exercised and observed, with concrete evidence.
   - *Verdict:* PASS / FAIL / PARTIAL.
2. …

**Problems found:**
- <problem> — severity; facts; observation; reproducible details (or a link to
  the issue carrying them). (Omit or write "none" if clean.)

**Corresponding issues / PRs:**
- issue: <link> · PR: <link> (for every problem that produced one)

**Commits:**
- tested: <sha> · fixes: <sha(s)> (linked)
```

## Rules for writing reports

1. **One session = one report file**, named per the convention below and added
   to the index table in the same change.
2. **Every scenario carries three parts**: a scenario description (which flow,
   which inputs), the testing done (what was exercised and observed, with
   concrete evidence), and a verdict — PASS, FAIL, or PARTIAL. "It worked" is
   not a scenario; "upload → queue → complete in 4m56s, pages on disk, vec
   index populated — PASS" is.
3. **Include facts, observations, and reproducible details**: concrete data
   (task/row ids, timestamps, stage percents, durations, file paths, commit
   SHAs), what was observed versus expected, and steps anyone can re-run.
   This applies to problems found as much as to scenarios.
4. **Be professional**: neutral, precise, blame-free wording; honest severity
   ratings; code defects stated separately from environmental factors.
5. **Link to the issue, PR, or commit whenever one exists.** A problem, fix, or
   tested change is referenced by its GitHub issue/PR number or commit SHA —
   never paraphrased without a link. If none exists yet, say so explicitly
   (that itself is a signal to file one).
6. **Always state the context the test ran against**: commit under test, how
   the app was deployed/booted, and relevant configuration (auth mode,
   retrieval mode, provider shape). A report without context cannot be
   re-run or trusted later.
7. **Problems get follow-up references**: if a finding produced an issue or
   fix, the report carries the link both ways (the issue should also mention
   the session).
8. **Reports are immutable**: do not rewrite an already-merged report file;
   corrections go in a dated note inside the same file or a follow-up report
   that links it. The index table may gain a corrections column entry.
9. **Clean results are recorded too** — a session that found nothing is
   evidence, not noise.

## Naming convention

Report files are named:

```
YYYY-MM-DD_<kebab-slug>.md
```

- `YYYY-MM-DD` — the session date (local), which keeps the directory and the
  index chronological by simple sort.
- Every report has a **title** naming what is being tested — a general
  statement of the change/feature/issue area under acceptance, not the session
  mechanics.
- `<kebab-slug>` — the kebab-case of that title (lowercase, spaces to `-`,
  punctuation dropped): title "Issue #14 production completeness" →
  `issue-14-production-completeness`. Two sessions on one day need distinct
  titles, hence distinct slugs.
- The index file itself is `OWNER_ACCEPTANCE.md`; report files are the only
  other files in this directory.

## Reports index

Chronological (date-first filenames sort as listed). One row per report file.

| Date | Report | File | Verdicts | Key links |
|---|---|---|---|---|
| 2026-08-05 | Issue #14 production completeness | [2026-08-05_issue-14-production-completeness.md](2026-08-05_issue-14-production-completeness.md) | 5 PASS · 1 PARTIAL · 1 FAIL | [#14](https://github.com/vinvcn/llm_wiki/issues/14) · [#32](https://github.com/vinvcn/llm_wiki/issues/32) · tested [`a42d103`](https://github.com/vinvcn/llm_wiki/commit/a42d103) |
