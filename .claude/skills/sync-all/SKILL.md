---
name: sync-all
description: Run the full notion-sync pipeline (push + dashboards + prune dry-run), diagnose errors, retry transient failures, and produce a summary report. The end-to-end orchestrator for "make Notion match local docs and tell me what happened."
triggers:
  - phrase:sync everything
  - phrase:full sync
  - phrase:notion sync run
  - tool:run.sh
  - skill:sync-all
tier: 2
category: features
related: [PIPELINE.md, SUSPICION-RULES.md, RCA-ARCHIVED-PAGES.md, run-notes.md]
updated: 2026-05-02
---

# /sync-all — orchestrate full notion-sync run + diagnose + report

Runs the entire notion-sync pipeline end-to-end, examines failures against the
suspicion-rules catalog, retries transient errors once, and renders a gum-styled
summary the user can read in 10 seconds.

This skill is **opinionated about cost** — it consults `runs.jsonl` instead of
rerunning anything that already succeeded. It NEVER calls `prune --apply`,
NEVER calls `prune-images --apply`, and NEVER pushes to git on its own.

---

## Phase 0 — Pre-flight (~5 sec)

Before doing any work, verify the environment:

1. **CWD check.** Confirm we're at the notion-sync repo root (look for `index.ts`,
   `run.sh`, and `package.json` with `"name": "notion-sync"`). If not, abort with
   a clear message — never sync from a wrong directory.
2. **`.env` present.** Confirm `.env` exists and contains `NOTION_TOKEN` and
   `NOTION_ROOT_PAGE_ID`. If missing, point at `SETUP.md` and stop.
3. **Working tree status.** `git status --short` — note any uncommitted changes
   to `index.ts`, `*.ts`, or `*.sh` so the report can flag "syncing with
   uncommitted code changes" if applicable.
4. **Stale lock check.** If `.notion-cache.json` mtime > 7 days, mention it in
   the report — move detection in Phase 1 will be using stale cache.

If any check fails, stop and report. Do NOT proceed.

---

## Phase 1 — Run the pipeline (~10-15 min on full docs)

Execute `bash run.sh bring-up` in the **background** with a tee'd log:

```bash
bash run.sh bring-up 2>&1 | tee /tmp/sync-all-bringup.log
```

Use `Bash` with `run_in_background: true` so the user sees status as it
arrives. Then arm a `Monitor` on the log file with this filter (matches every
terminal state, not just the happy path — silence ≠ success):

```bash
tail -F /tmp/sync-all-bringup.log 2>/dev/null \
  | grep -E --line-buffered "▶ |✓ |✗ |Error|error:|FAILED|aborted|partial|complete|Phase 1|Phase 2|sitemap|tag-index|recent-errors|fix-mentions|🔔"
```

While the bring-up runs, do nothing else — wait for the completion notification.
The bring-up sequence is:
`push → fetch → fix-mentions → sitemap → tag-index → recent-errors`.

---

## Phase 2 — Run remaining dashboards (~3-5 min)

`bring-up` doesn't include backlinks, recent-feed, or health. Run them with:

```bash
bash run.sh dashboard 2>&1 | tee /tmp/sync-all-dashboard.log
```

(`dashboard` mode runs sitemap + tag-index again, but they're idempotent and
fast to re-render — the cost is paid for the three new ones: backlinks,
recent-feed, health.)

If the user has signaled "skip dashboards" or "just push", skip this phase.

---

## Phase 3 — Diagnose failures

Read the latest entry in `runs.jsonl` (the most recent line):

```bash
tail -n 1 runs.jsonl | python3 -m json.tool
```

For each entry in `error_summary[]`:

1. **Cross-reference suspicions** against `SUSPICION-RULES.md`:
   - `cloudflare-waf-curl` → curl + IP/localhost in body. Suggest fenced code.
   - `cloudflare-waf-shell-pipe` → shell pipe in inline code outside fence.
   - `cloudflare-waf-sql-keyword` → SQL keyword in prose; rewrite or fence.
   - `cloudflare-waf-script-tag` → `<script>` literal; escape or fence.
   - `notion-body-too-large` → file > 500 KB; split the doc.
2. **Identify timeouts** (`Request to Notion API has timed out`) — these are
   usually 504s on big pages. They're transient ~70% of the time.
3. **Identify validation errors** — these are NOT transient and need code/content
   fixes. Flag them prominently.

---

## Phase 4 — Targeted retry (timeouts only)

If failures are pure timeouts (no WAF or validation errors), retry **once** with
the exact `bash sync.sh --only` command printed at the end of the original run:

```bash
bash sync.sh --no-wizard --only <failed-paths>
```

Do **NOT** retry validation/WAF errors — they will fail identically and waste
time. Tell the user what content needs to change.

If the retry still fails, stop retrying — the issue is likely the markdown
parser block-count scaling problem (see `run-notes.md`). Suggest the user
manually re-run with `bash sync.sh --only <path>` after a few minutes.

---

## Phase 5 — Render summary report

Use `gum-tui.sh` (via `~/.claude/skills/shared/gum-tui.sh` if present, else
print plain text) to render a fixed-width report:

```
╔══════════════════════════════════════════════════════════════════════╗
║                    notion-sync run summary                           ║
║                    run_id: YYYYMMDD-HHmmss                           ║
╠══════════════════════════════════════════════════════════════════════╣
║  ✓ pages          N created · M updated · K unchanged                ║
║  ✗ errors         X (after retries)                                  ║
║  ⏱  timing         Phase 1 Xs · Phase 2 Ys · total Zs                ║
║  📸 images         A uploaded · B cache hits · C in cache            ║
║  📊 dashboards     ✓ sitemap ✓ tag-index ✓ index-db ✓ recent ✓ ...  ║
╠══════════════════════════════════════════════════════════════════════╣
║  Failures (if any):                                                  ║
║    • path/to/file.md                                                 ║
║      cause: <human-readable diagnosis from suspicion rules>          ║
║      fix:   <one-line suggested action>                              ║
╠══════════════════════════════════════════════════════════════════════╣
║  Next: <one suggested action — e.g. "review prune dry-run" or       ║
║         "split create-upload.md before next sync">                  ║
╚══════════════════════════════════════════════════════════════════════╝
```

Also append a one-line entry to `run-notes.md` (newest-first) summarizing
the run — date, run_id, what failed, what the diagnosis suggests.

---

## Phase 6 — Optional dry-runs (only if asked)

If the user invoked the skill with `prune` or `prune-images` mentioned, also run
the dry-run versions:

```bash
bash list.sh prune          # orphan pages dry-run
bash list.sh prune-images   # orphan uploads dry-run (once shipped)
```

Print counts only. NEVER pass `--apply`.

---

## Anti-patterns — do NOT do these

- ❌ Don't loop indefinitely on retries. One retry pass after the script's own
  built-in retry pass is enough.
- ❌ Don't pass `--apply` to any prune subcommand without explicit user request
  on the same turn.
- ❌ Don't push to git or open PRs without explicit user request.
- ❌ Don't claim "dashboards updated" if the dashboard phase was skipped or any
  dashboard step exited non-zero. Verify `runs.jsonl` actually has entries
  reflecting the work, not just the absence of errors in the live log.
- ❌ Don't report success based on the bash exit code alone — `run.sh` may exit
  0 even when the inner `sync.sh` had per-file failures. Always cross-check
  `runs.jsonl` `stats.errors` and `error_summary` length.

## Notes for future invocations

- Total runtime on the project's typical docs root (~300 pages): **~15-20 min**
  for full bring-up + dashboards. Warn the user up-front if they didn't expect
  a long-running operation.
- The Phase 2 timeout on large files (e.g., `create-upload.md`) is a known
  Notion markdown-parser scaling issue documented in `run-notes.md`. A retry
  is worthwhile but not guaranteed.
- `.notion-cache.json` is consumed by Phase 1 move-detection AND by all
  dashboards. If it's stale (>7 days), `bring-up` refreshes it via its `fetch`
  step before dashboards read it — that ordering matters.
