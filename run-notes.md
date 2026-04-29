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

## 2026-04-29 — run 20260429-191328 — archived pages abort

**Run:** 1 updated, 5 errors, aborted. All errors identical.

**Error:** `validation_error: Can't edit block that is archived. You must unarchive the block before editing.`

**Root cause:** `notion.blocks.children.list` returns archived (trashed) child_page blocks in its results without filtering. Phase 1 found these pages by title match and stored their IDs as valid targets. Phase 2 tried to write to them → 400 validation_error. Pages were manually deleted in Notion between runs.

**Suspicion false positive:** WAF suspicion rules also fired on these pages (shell-pipe, SQL keyword content patterns) but were unrelated to the actual error — the real cause was the archived block state.

**Fix applied (d58490c → next commit):**
- `listChildPages`: filter out blocks where `block.archived === true` — archived pages are now invisible to the script; Phase 1 will treat them as non-existent and create fresh ones.
- Suspicion checks: suppressed when error is a Notion `validation_error` code (not WAF-related) — reduces noise and surfaces the actual Notion message instead.

**Pattern to watch:** If many files fail with `validation_error` and `aborted: true`, check for manually-deleted Notion pages. After the fix, those files will be re-created on the next run.
