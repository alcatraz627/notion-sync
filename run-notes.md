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

## 2026-05-02 — `tag-index` 504 on wipe — existing page too large to read in one shot

**Run IDs:** 20260502-051846 (bring-up) succeeded for tag-index inside `bring-up`'s flow when it was a fresh build. The follow-up `dashboard` mode invocation later the same day FAILED tag-index after 1192s. Aborted before backlinks/recent-feed/health, requiring the orchestrator to invoke each remaining dashboard manually.

**What happened:** `tag-index.ts` first reads the existing page's blocks (to wipe before rebuild). The current tag-index page has 1299 blocks (351 tags × ~3.7 blocks each). Notion's `blocks.children.list` 504s when called against a page that large in a single hop.

**Why this matters for the orchestrator:**
- A failed dashboard subprocess kills the rest of `bash run.sh dashboard` because the script chains phases sequentially without `|| true`.
- The fix in `tag-index.ts` should paginate the wipe (read+delete in chunks of 100 blocks, like sitemap.ts does for new pushes — but in reverse). Until that's fixed, the workaround is: archive the old page in Notion UI, then re-run — fresh-build path completes in ~4 min.
- Also worth: changing `mode_dashboard` in `run.sh` to use `||` between phases so one failure doesn't strand the others.

**Suspicion engine:** The first run's `create-upload.md` failure tagged `cloudflare-waf-shell-pipe` and `cloudflare-waf-sql-keyword` but the actual error was `Request to Notion API has timed out` — a transient that cleared on retry. This is a useful reminder: WAF suspicions are a **content hint**, not a diagnosis. When the underlying error is a timeout, ignore the suspicion tags and just retry.

---

## 2026-05-02 — Audit: behaviour of doc updates (renames/moves leave orphans)

User asked how future doc updates flow through the pipeline. Traced the code paths; results:

**Pages are identified in Notion by `(parent_id, title)`, not by file path.** Page IDs are stable forever once created — mentions reference page IDs and continue to work even if the file path changes. But `getOrCreateChildPage` only matches by current title under current parent, and `updatePageMeta` only updates icon/cover, never title. So:

- **Content-only edits** (scenario 1): perfect. Hit `replace_content` on the existing page. Mentions stay valid.
- **H1 title changed** (scenario 2): script creates a NEW page with new title; old page lingers as orphan. Inbound mentions still point at old page (stale).
- **File renamed without H1 change** (scenario 3): perfect. Same parent + title → finds existing page.
- **File moved across folders** (scenario 4): new parent → new page. Old page orphaned.
- **Folder renamed** (scenario 5): cascade. Whole subtree gets re-created at the new section. Old subtree fully orphaned.
- **File deleted locally** (scenario 7): page on Notion sits untouched.
- **Anchor in link** (`foo.md#section`): URL is preserved correctly, but Notion doesn't navigate to fragment anchors — known platform limitation.

**Three v1.2 fixes that would close the structural gap:**

1. **Update title on existing page when H1 changes** — one-liner: `notion.pages.update({page_id, properties: {title: ...}})` after content write. Closes #2.
2. **Move-detection in `getOrCreateChildPage`** — search for title across the entire cached tree, not just direct children. If found under a different parent, `pages.update({parent: {page_id: newParent}})` to move. Closes #4, #5.
3. **`bash run.sh prune` mode** — uses `notion-diff` extras + interactive confirmation to archive orphans. Closes #7 and the accumulation from #2/#4/#5.

Together these would make the pipeline "rename-safe" — ~1 day of v1.2 work.

**Pattern to watch:** if user reports duplicate pages or stale mentions after a doc reorg, this is the cause. Workaround until v1.2: manually delete the orphan in Notion (the trashed-page detection in `getOrCreateChildPage` will then re-create cleanly if needed).

## 2026-05-02 — `pages.updateMarkdown` 504s correlate with target page block count

**Symptom:** D1 (sitemap) and D2 (tag-index) both reliably succeeded for ~5 chunks of `pages.updateMarkdown({type: "insert_content"})`, then started returning 504 / "Request to Notion API failed with status: 504" repeatedly even with 4-12s exponential retries. Smaller chunks didn't help; longer inter-chunk delays didn't help; the same chunk failed 3 retries in a row before throwing.

**Diagnosis:** the failure rate **correlates with the target page's accumulated block count, not the per-call payload size.** First few chunks → fast. Once the page had ~100+ blocks the markdown parser+inserter started timing out internally.

**Fix (commit `f7d6810`):** rewrite both modules to use `blocks.children.append` directly. Build Notion blocks programmatically (heading_2 / heading_3 / bulleted_list_item with mention rich_text) and push 100 blocks per `append` call. Skips Notion's markdown parser entirely; mentions emitted directly so no post-pass mention-converter needed.

**Real-world numbers from validation (304-page docs root):**
- Sitemap: 305 blocks in 4 batches of 100 → 20 seconds, 0 retries
- Tag-index: 1299 blocks (351 tags × heading + bullets) in 13 batches → 4 minutes, occasional 504 retries (recovered cleanly)
- Index DB: 254 rows via separate page-create calls → 5 minutes, 0 retries (different API path, no parser involvement)

**Pattern to watch:** any feature that pushes structured content to Notion should prefer `blocks.children.append` over `pages.updateMarkdown` when the content is under our control. The markdown endpoint is convenient for one-shot whole-page replaces (Phase 2 leaf writes), but suffers on incremental builds. Reserve markdown for the user's source docs; use blocks API for our generated dashboards.

**Notion's nested-children-depth quirk:** the API validates nested children at most 2 levels deep in a single `append` call. `body.children[3].bulleted_list_item.children[0].bulleted_list_item.children[9].bulleted_list_item.children should be not present`. For deeper hierarchies, flatten using indented text (sitemap uses gray-italic folder-path prefix) or do follow-up appends targeting the parent.

## 2026-05-02 — `databases.create` v5 SDK shape change — properties live on data sources

**Symptom:** D4 (sidecar Index DB) creation failed with `Title is not a property that exists. Path is not a property that exists. ...` — the database was created but with no properties beyond the auto-created `Name` (title).

**Diagnosis:** Notion's API split databases into two layers in the v5 SDK: a `database` is now a container; the actual properties live on a `data_source`. `databases.create({parent, properties})` (the v4 shape) silently ignores the `properties` field — the SDK warns `unknownParams: [properties]` but proceeds. The right shape is `databases.create({parent, initial_data_source: {properties: ...}})`. Page rows are parented via `data_source_id`, not `database_id`. Queries via `dataSources.query` (not `databases.query`).

**Fix (commit `379496d`):** in `index-db.ts`:
1. Use `initial_data_source: {properties}` when creating the database.
2. After create, extract `data_source_id` from the response.
3. For existing databases (re-runs), call `databases.retrieve` and use the first `data_sources[].id`.
4. Page rows: `parent: {type: "data_source_id", data_source_id}` instead of `database_id`.
5. Queries: `dataSources.query({data_source_id})`.
6. **Schema patch on existing DBs:** if a previous (broken) run created a DB without our properties, retrieve the data source, diff against expected, and `dataSources.update({data_source_id, properties})` to add missing ones. Idempotent — script can recover a half-broken DB.

**Default title quirk:** Notion auto-creates a `Name` (title) property on every new data source and rejects `Cannot create new title property` when adding another. We use `Name` as our title column rather than `Title` so the auto-created one suffices.

## 2026-05-01 — Notion auto-detect URL bug — `[foo.md](url)` link text hijacks the href

**Symptom:** Pages like `https://www.notion.so/Jobs-352bacd27dee81a4a53de063b3094432` had every internal link rendered as `http://overview.md/` (Moldova TLD), not the Notion URL we wrote. `fix-mentions` reported 0 conversions on these because the URLs weren't recognized as `notion.so` / `app.notion.com`. Affected every `_index.md`-style page that referenced sibling docs as `[overview.md](overview.md)`.

**Diagnosis:** Wrote a debug hook that captured the post-`rewriteLinks` markdown to `/tmp/rewritten-*.md`. The markdown was correct: `[overview.md](https://www.notion.so/352bacd27dee819ea4dce1f6b5d7814f)`. Yet Notion's stored block had `text.link.url = "http://overview.md/"`. **Notion's markdown parser ignored the explicit href and synthesized one from the link text** — it sees `something.md` in the text and auto-links to the Moldova TLD `.md`. mention-converter then can't recognize the mangled URL as internal and leaves the link plain.

**Fix (commit pending):** in `rewriteLinks`, when the resolved internal link's anchor text contains `.md`, substitute the linked doc's `title` (from `getDoc(matchedKey)`) as the anchor text. So `[overview.md](url)` becomes `[Jobs — Overview](url)` — Notion has no `.md` in the text to auto-detect, the URL stays as written, and mention conversion succeeds. Falls back to a humanized basename when the doc title isn't in `docCache` (e.g. cross-section section page references during a filtered `--only` run).

**Validated on:** `product/jobs/_index.md` — re-synced with `--only product/jobs`. Inspector now reports `broken_md: 0`, `app.notion.com: 8` (Notion's canonical form for `notion.so`), titles substituted correctly. After a follow-up `bash list.sh fix-mentions` pass, all 8 become mention pills.

**Lesson:** When integrating with a markdown parser you don't own, never trust that explicit syntax wins over autodetect. Notion specifically aggressively auto-links anything that resembles a URL in *any* text content — this trumps even an explicit `[text](href)` annotation. The defense is to keep URL-shaped tokens out of link text entirely.

## 2026-05-01 — audit logging hardening (no run, infrastructure note)

Three improvements landed in this session — relevant for future RCA-style runs:

1. **Partial run logs on Ctrl-C / SIGTERM / uncaught exception.** A new `partialSnapshot` module variable in `index.ts` captures progress at every checkpoint. `SIGINT`/`SIGTERM`/`uncaughtException` handlers flush a `partial: true` entry to `runs.jsonl` with `partial_reason` set to the cause. So killing a sync mid-flight no longer loses the trail — `bash list.sh recent-errors` will surface what got done and which file was being processed when the kill landed. New `RunLogEntry` fields: `partial`, `partial_reason`.
2. **Image upload stats persisted.** `image_stats: {uploads, cache_hits, total_in_cache}` is now written to every `runs.jsonl` entry when `NOTION_UPLOAD_IMAGES=1`. Previously only printed to terminal — now you can chart cache-hit ratio over time without scraping log lines.
3. **`bash list.sh recent-errors` subcommand.** Reads `runs.jsonl`, prints the last N runs (default 5), drills into any with `errors > 0` or `partial: true`, shows suspicion tags per failed path and a copy-paste `bash sync.sh --only ...` retry command. Pure local-log — no Notion API calls. Use `--limit 50` to widen the window when investigating a regression.

**Pattern to watch:** when an old run shows up in `recent-errors` with `partial: true` and no clear reason, check `partial_reason`. If it says `SIGINT`, the user killed it; if `uncaughtException: ...`, an unhandled error escaped the main `try/catch` — likely worth a bug report.

## 2026-05-01 — clean state milestone — 0 missing / 0 extras / 0 thin

After completing the bring-up sequence + retroactive mention conversion, the path-based comparator returns:

```
Local docs:                  298
Notion pages:                303
Matched docs:                298
Matched auto-index sections: 6
Missing on remote:           0
Extra on remote:             0
Thin remote pages:           0
```

This is the first time the comparator has reported zero drift. Confirms:
- 6 previously-stranded index-only folders (`boring-technical-stuff/observability/`, `frontend/auth/`, `widgets-v2/`, `flows/`, `backend/tooling/`, `workers/`) were correctly synced after the `scanTree` fix in `0115c3a`.
- 2 transient Phase 1.5 failures (`improvements/credits/_index.md`, `product/modals/_index.md`) recovered on the targeted `--only improvements/credits product/modals` re-run.
- Root-level files (`structure.md`, `product-todos.md`) now in cache — confirmed the wizard "all sections" filter trap from `aff07ec`.

## 2026-05-01 — fix-mentions found 0 conversions — Notion canonicalizes URLs

**Symptom:** After the v1 mention-converter shipped (`f4267e0`), running `bash list.sh fix-mentions` reported "Converted 0 links → mentions across 0 pages" despite user-visible "open in new tab" behaviour confirming many internal links remained unconverted.

**Root cause (commit `cf39327`):** Notion's markdown API silently rewrites `https://www.notion.so/<id>` URLs to `https://app.notion.com/p/<id>` when storing them in rich_text annotations. Our regex only matched `notion.so` URLs, so:
- The post-sync mention pass during `writeFileContent` was a no-op on EVERY page synced since `f4267e0`
- `fix-mentions` couldn't find any candidates to convert

Diagnostic that surfaced this — list one synced page's blocks, count `text.link.url` annotations, sample a few:

```typescript
// All sample URLs were:
//   https://app.notion.com/p/352bacd27dee81aaa79ec7b80ec8479c
// (Not the https://www.notion.so/ form we wrote)
```

**Fix:** regex extended to match `app.notion.com/p/` AND dashed-UUID form. Verified with 7 unit-test URLs.

After the fix: 1311 links converted to mentions across 27 pages (1117 block updates).

**Lesson for next session:** when an API converts your input format silently, your write-side rewriter and your read-side scanner have to know about both forms. Test with the actual stored data, not what you wrote.

## 2026-04-30 — run 20260430-021257 — archived ancestor unarchive+retry race condition (10 errors, aborted)

**Run:** 17 created, 0 updated, 10 errors, aborted (abort policy: 10). All errors under `boring-technical-stuff/frontend/...`.

**Error:** `validation_error: Can't edit page on block with an archived ancestor.`

**Root cause:** Eventual consistency in Notion's unarchive API. Phase 2's auto-unarchive correctly called `pages.update(archived: false)` on `boring-technical-stuff/frontend/_index.md`, but retried the write immediately after. Notion returns 200 OK on the unarchive before the state change is visible to child writes — the retry hit the same "archived ancestor" error. The 350ms rate-limit sleep between calls is not sufficient as a propagation buffer.

**Fix applied (bd0c509):**
- Added `await sleep(3000)` after unarchiving all ancestor section pages, before retrying the write. 3 seconds gives Notion time to propagate the unarchive state.
- Also added `is_new` to `SyncResult` / runs.jsonl page entries so future analysis can distinguish newly-created vs existing pages in error context.

**Phase 1 behavior confirmed correct:** Phase 1 DID find and unarchive `boring-technical-stuff/frontend` (9 `pages.retrieve` calls, 17 `pages.unarchive` calls seen in metrics). The problem was exclusively in Phase 2 retry timing.

**Pattern to watch:** If "archived ancestor" errors recur with the 3s delay and retry still fails, increase the delay to 5-8s. If many files fail in Phase 2 with this error even after the retry succeeds (unarchived marker in log), it means Phase 1 unarchive missed a deeper ancestor — check that all `_index.md` keys for the affected path are in `pageIdMap`.

## 2026-04-29 — run 20260429-205535 — archived ancestor cascade (194 errors)

**Run:** 2 updated, 15 created, 194 errors, not aborted (abort disabled). 1 timeout.

**Error:** `validation_error: Can't edit page on block with an archived ancestor. You must unarchive the ancestor before editing page.`

**Root cause:** Distinct from the previous "archived block" error. Here, a *parent section page* (e.g. `boring-technical-stuff/frontend`) was archived/trashed in Notion. Phase 1 still successfully created child pages under it (Notion allows creating children under archived parents), but Phase 2 write calls to those children fail with "archived ancestor".

**Previous fix was incomplete:** The unarchive-and-retry in `writeFileContent` called `pages.update(archived: false)` on the *leaf page* (the file being written). For the ancestor case the leaf itself is fine — it's a parent section that needs unarchiving, not the leaf.

**Fix applied (a668f3e → next commit):**
- Detect "ancestor" in the error message to distinguish from leaf-archived case.
- For ancestor case: traverse up `relPath`'s directory segments, look up each section page ID in `pageIdMap` (via `dir/_index.md` keys), and unarchive all of them before retrying.
- After full Notion wipe and fresh sync this won't occur immediately, but will recur if any section page is manually trashed between runs.

**This Phase 2 fix was insufficient** — see 2026-04-30 entry below for the correct Phase 1 fix.

**Pattern to watch:** If many sibling files under a folder all fail with `archived ancestor` (not just one), suspect the parent section page is trashed. Check Notion trash for the folder-level page, restore it, or let the auto-unarchive handle it on next run.

## 2026-04-30 — run 20260429-222229 — archived ancestor root cause fixed in Phase 1

**Run:** 17 created, 195 errors (all "archived ancestor"), even after Notion wipe.

**Root cause (definitive):** `blocks.children.list` returns archived/trashed pages with `block.archived === false` — the archived flag is on the PAGE object (from `pages.retrieve`), not on the block pointer. This means `!block.archived` filtering in `listChildPages` was a no-op. Trashed pages were being returned as valid matches, their IDs stored in `pageIdMap`, and Phase 2 wrote to children of those archived pages → cascade "archived ancestor" errors on all children.

**Why wipe didn't help:** Notion's "delete" moves pages to Trash (archived), not permanent deletion. `blocks.children.list` still returns them. The script matched by title and stored their (archived) IDs.

**Fix applied (next commit):**
- `getOrCreateChildPage`: when a title match is found in `listChildPages`, call `pages.retrieve(existing.id)` to get actual archived status. If `page.archived === true`, call `pages.update({ archived: false })` to unarchive before returning the ID.
- Removed the no-op `!block.archived` filter from `listChildPages` with a comment explaining why it can't work.
- Cost: 1 extra `pages.retrieve` per existing matched page (only on re-runs, not fresh runs). ~74s overhead on a 212-page re-run — acceptable vs. 195 errors.

**Pattern to watch:** If this recurs, check that `getOrCreateChildPage` is hitting the retrieve path (look for `pages.retrieve` in metrics). If all pages are new (isNew: true) the retrieve is never called.

---

## 2026-04-29 — run 20260429-191328 — archived pages abort

**Run:** 1 updated, 5 errors, aborted. All errors identical.

**Error:** `validation_error: Can't edit block that is archived. You must unarchive the block before editing.`

**Root cause:** `notion.blocks.children.list` returns archived (trashed) child_page blocks in its results without filtering. Phase 1 found these pages by title match and stored their IDs as valid targets. Phase 2 tried to write to them → 400 validation_error. Pages were manually deleted in Notion between runs.

**Suspicion false positive:** WAF suspicion rules also fired on these pages (shell-pipe, SQL keyword content patterns) but were unrelated to the actual error — the real cause was the archived block state.

**Fix applied (d58490c → next commit):**
- `listChildPages`: filter out blocks where `block.archived === true` — archived pages are now invisible to the script; Phase 1 will treat them as non-existent and create fresh ones.
- Suspicion checks: suppressed when error is a Notion `validation_error` code (not WAF-related) — reduces noise and surfaces the actual Notion message instead.

**Pattern to watch:** If many files fail with `validation_error` and `aborted: true`, check for manually-deleted Notion pages. After the fix, those files will be re-created on the next run.
