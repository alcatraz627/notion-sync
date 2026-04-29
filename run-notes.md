# Run Notes — notion-sync

Append-only log of notable findings from real sync runs. Each entry documents a pattern, fix, or observation that helps diagnose future runs. Kept here so Claude can read it alongside `runs.jsonl` for context.

---

## How to use

Ask Claude: "Check the latest run in runs.jsonl and add any findings to run-notes.md."

Claude should:
1. `tail -n 1 runs.jsonl | python3 -m json.tool` to read the latest run
2. Check `stats.errors`, `error_summary`, and `sections` for failures
3. Cross-reference `suspicions` fields for WAF / size / content issues
4. Append a dated entry below if anything notable was found

---

<!-- entries below, newest first -->

## 2026-04-29 — run 20260429-205535 — archived ancestor cascade (194 errors)

**Run:** 2 updated, 15 created, 194 errors, not aborted (abort disabled). 1 timeout.

**Error:** `validation_error: Can't edit page on block with an archived ancestor. You must unarchive the ancestor before editing page.`

**Root cause:** Distinct from the previous "archived block" error. Here, a *parent section page* (e.g. `boring-technical-stuff/frontend`) was archived/trashed in Notion. Phase 1 still successfully created child pages under it (Notion allows creating children under archived parents), but Phase 2 write calls to those children fail with "archived ancestor".

**Previous fix was incomplete:** The unarchive-and-retry in `writeFileContent` called `pages.update(archived: false)` on the *leaf page* (the file being written). For the ancestor case the leaf itself is fine — it's a parent section that needs unarchiving, not the leaf.

**Fix applied (eb8c36c → next commit):**
- Detect "ancestor" in the error message to distinguish from leaf-archived case.
- For ancestor case: traverse up `relPath`'s directory segments, look up each section page ID in `pageIdMap` (via `dir/_index.md` keys), and unarchive all of them before retrying.
- After full Notion wipe and fresh sync this won't occur immediately, but will recur if any section page is manually trashed between runs.

**Pattern to watch:** If many sibling files under a folder all fail with `archived ancestor` (not just one), suspect the parent section page is trashed. Check Notion trash for the folder-level page, restore it, or let the auto-unarchive handle it on next run.

## 2026-04-29 — run 20260429-191328 — archived pages abort

**Run:** 1 updated, 5 errors, aborted. All errors identical.

**Error:** `validation_error: Can't edit block that is archived. You must unarchive the block before editing.`

**Root cause:** `notion.blocks.children.list` returns archived (trashed) child_page blocks in its results without filtering. Phase 1 found these pages by title match and stored their IDs as valid targets. Phase 2 tried to write to them → 400 validation_error. Pages were manually deleted in Notion between runs.

**Suspicion false positive:** WAF suspicion rules also fired on these pages (shell-pipe, SQL keyword content patterns) but were unrelated to the actual error — the real cause was the archived block state.

**Fix applied (d58490c → next commit):**
- `listChildPages`: filter out blocks where `block.archived === true` — archived pages are now invisible to the script; Phase 1 will treat them as non-existent and create fresh ones.
- Suspicion checks: suppressed when error is a Notion `validation_error` code (not WAF-related) — reduces noise and surfaces the actual Notion message instead.

**Pattern to watch:** If many files fail with `validation_error` and `aborted: true`, check for manually-deleted Notion pages. After the fix, those files will be re-created on the next run.
