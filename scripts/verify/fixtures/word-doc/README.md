# Legacy Word `.doc` (OLE2) test fixtures

Real Word 97–2003 binary (`.doc`, OLE2 compound document) files used by the
standing gate `scripts/verify/verify-source-text.mjs` to prove the web
server's legacy `.doc` extraction path (`packages/server/src/commands/preprocess.js`
→ `word-extractor`) against genuine files — not synthetic ones.

## Provenance

- Source: the MIT-licensed `word-extractor` project's own test corpus,
  <https://github.com/morungos/node-word-extractor> (`__tests__/data/`),
  fetched from the `main` branch on 2026-08-05. The npm package
  (`word-extractor@1.0.4`, the exact dependency this repo ships) omits these
  fixtures, so they are vendored here.
- License: MIT (see `LICENSE-word-extractor`, © 2016-2021 Stuart Watt).
- `manifest.md` is the upstream description of each file.

## Files

| File | What it proves |
|---|---|
| `test01.doc` | revision insertions/deletions + Unicode (😀 ∀ ✻) — expected body pinned by the upstream snapshot |
| `test03.doc` | a table page; cells come out tab-separated |
| `test05.doc` | a minimal Word 97-SR2 file — expected body pinned by the upstream snapshot |
| `bigfile-01.doc` | a long, complex real-world document (insertions, deletions, hyperlinks, mixed Unicode) |
| `badfile-01-bad-header.doc` | an INVALID Word file: extraction must fail gracefully with the documented convert-first error (never crash ingest) |

Expected text assertions in the harness mirror the upstream Jest snapshots
(`__tests__/__snapshots__/*.snapx`) for the vendored files.
