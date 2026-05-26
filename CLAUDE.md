# notion-sync — Claude Context

## What this is

A **standalone Node.js script** (`index.ts`) that pushes markdown files from `docs/product/**` to Notion. It has its own `package.json`, `node_modules`, and `tsconfig.json`.

**It is not part of the Next.js frontend app.** Do not import from it, build it with Next.js, or treat it as part of the frontend dependency tree. Nothing in `src/` references it. It runs completely independently.

## Running

**Primary entry point (v1.2+):** `bash run.sh` — pipeline-first launcher with named modes.

```bash
bash run.sh                   # interactive picker (gum-styled if available)
bash run.sh push              # = bash sync.sh
bash run.sh push:full         # push + fetch + diff + recent-errors + sitemap
bash run.sh fix               # fix-mentions + recent-errors
bash run.sh check             # read-only verification
bash run.sh dashboard         # refresh sitemap + tag-index + index-db + backlinks + recent-feed + health (phases chain via || — one failure won't strand the rest)
bash run.sh bring-up          # full first-time bring-up sequence
bash run.sh prune             # list orphan Notion pages (dry run; --apply to archive)
```

`sync.sh` and `list.sh` remain available as low-level building blocks (and are still the right choice for the GitHub Action and other scripted contexts that don't want the wizard). Users with `just` installed can also use the `Justfile` (mirrors run.sh modes).

```bash
# Low-level (still supported):
bash sync.sh                  # interactive wizard (sync OR fix-mentions mode)
bash sync.sh --no-wizard      # saved defaults
bash sync.sh --dry-run        # preview only
bash sync.sh --only jobs      # filter
bash sync.sh --fix-mentions   # mention conversion mode
bash sync.sh --resume         # continue an interrupted run (skips docs already written)

bash list.sh                  # render cached remote tree
bash list.sh fetch            # refresh cache from Notion
bash list.sh diff             # title-based diff vs local docs
bash list.sh diff-content     # three-way diff report (BASE/LOCAL/REMOTE), served in a browser; scans every baselined page by default, --paths a,b to scope, --protected-only for last-run subset, --show-clean to include unchanged pages, --force to refetch
bash list.sh fix-mentions     # standalone mention conversion
bash list.sh dashboards       # run ALL 6 dashboards in one process (sitemap+tag-index+index-db+backlinks+recent-feed+health)
bash list.sh sitemap          # push 🗺️ Sitemap dashboard page
bash list.sh tag-index        # push 🏷️ Tags dashboard page
bash list.sh index-db         # push 📇 Doc Index sidecar database
bash list.sh backlinks        # append 🔗 Linked from callouts to each page
bash list.sh recent-feed      # push 📣 Recently Synced page (last 50 unique)
bash list.sh health           # push 🩺 Sync Status page from latest run
bash list.sh prune            # list orphan pages; --apply to archive
bash list.sh recent-errors    # local-log failure scan
bash list.sh empty-paths      # paths of empty remote pages
```

For end-user docs see [USAGE.md](USAGE.md). This file is for Claude (architectural context).

## Key files

| File                    | Purpose                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| `index.ts`              | Sync logic — Phase 1 discovery, Phase 1.5 sections, Phase 2 content + retries   |
| `image-uploader.ts`     | Notion CDN image upload (sha256-cached) + image-block external→file_upload swap |
| `mention-converter.ts`  | Walk page blocks, rewrite internal hyperlinks → native page mentions. Strips dead `#anchor`/relative link URLs when rewriting a block (Notion rejects them on `blocks.update`). `descendChildPages` off by default (callers iterate pages independently) |
| `sync-state.ts`         | Overwrite guardrails — bot-id cache, baseline tracking, divergence detection (`Divergence[]`), root-keyed state file. `getCacheKey()` derives the `<key>` suffix from `NOTION_ROOT_PAGE_ID` |
| `progress-ledger.ts`    | Resumable runs — per-doc ledger (`.notion-sync-progress.<key>.json`) recording completed docs; read on start for `--resume`. Atomic temp+rename writes |
| `reconcile.ts`          | Interactive guided resolution of guardrail-protected pages (`bash sync.sh reconcile`). `--inline-diff` / `RECONCILE_DIFF_TOOL` pick the diff renderer |
| `notion-list.ts`        | Read remote tree, cache to `.notion-cache.<key>.json`, dispatcher for show/diff/diff-content/fix-mentions/dashboards/sitemap/tag-index/index-db/backlinks/recent-feed/health/prune/recent-errors/empty-paths |
| `diff-content.ts`       | Three-way (BASE/LOCAL/REMOTE) content diff, rendered to an HTML report served in a browser. Caches to `.notion-diff-cache.<key>.json` (`--force` refetches) |
| `title-match.ts`        | Title-variant matching (dash/paren/lenient-normalize) used by `diff` + `prune` to pair renamed local docs ↔ Notion pages |
| `lib/colors.ts`         | ANSI color/style helpers (single source; `makeClr(isTty)` factory) |
| `lib/notion.ts`         | `getNotion()` client factory + `extractPageId()` (URL/ID → undashed 32-hex) |
| `lib/retry.ts`          | Unified `withRetry`/`isRetriable`/`computeWaitMs` — one retry policy for every API caller |
| `lib/env.ts`            | `loadEnv()` — the single `.env` parser (CRLF-safe, never overwrites existing env) |
| `sitemap.ts`            | Render the 🗺️ Sitemap dashboard page from cache (chunked-with-retry push)       |
| `tag-index.ts`          | Render the 🏷️ Tags dashboard from frontmatter + body tags across all docs       |
| `index-db.ts`           | Upsert rows in the 📇 Doc Index sidecar database (Notion DB CRUD via SDK)       |
| `recent-feed.ts`        | 📣 Recently Synced page rendered from `runs.jsonl` (top N unique syncs)        |
| `backlinks.ts`          | 🔗 Linked from callouts on each page (idempotent marker-based replace)         |
| `health.ts`             | 🩺 Sync Status page — latest run summary + recent run strip + error retry hint |
| `run.sh`                | **Primary launcher** — pipeline modes (push, push:full, fix, check, dashboard, bring-up, prune) |
| `Justfile`              | `just`-flavoured mirror of run.sh modes for users who have just installed       |
| `sync.sh`               | Wizard + env validation + macOS notification + bun launcher                     |
| `list.sh`               | Wraps notion-list.ts with notification on long-running subcommands              |
| `.env` / `.env.example` | Credentials + behaviour toggles                                                 |
| `.sync-defaults.json`   | Wizard's saved selections (gitignored)                                          |
| `.notion-cache.<key>.json` | Cached remote page tree from `list.sh fetch`. `<key>` = 12-hex of `NOTION_ROOT_PAGE_ID` (via `getCacheKey()`), so switching roots isolates state. Legacy unkeyed files auto-migrate. Gitignored. |
| `.notion-image-cache.json` | sha256 → file_upload_id map for uploaded images. Workspace-scoped (shared across roots — NOT keyed). Gitignored. |
| `.notion-sync-state.<key>.json` | Per-page baseline (page_id, expected_parent_id, last_pushed_edited_time, last_pushed_block_count) + cached bot_id. Flushed per-doc during Phase 2. Read by Phase 1.7 + reconcile. Root-keyed, gitignored. |
| `.notion-snapshots.<key>/` | Per-doc raw-body snapshots (BASE for 3-way diffs). Root-keyed, gitignored. |
| `.notion-diff-cache.<key>.json` | Cached `diff-content` report (`--force` busts it). Root-keyed, gitignored. |
| `.notion-sync-progress.<key>.json` | Resume ledger — `{run_id, started_at, doc_set[], completed[]}`. Present only while a run is incomplete; cleared on clean finish. Root-keyed, gitignored. |
| `runs.jsonl`            | Append-only log of every sync run                                               |
| `metrics.jsonl`         | Rolling-window (last 5) per-API-call timing                                     |
| `SETUP.md`              | One-time Notion integration setup guide                                         |
| `USAGE.md`              | Task-oriented end-user guide (covers all scenarios)                             |
| `run-notes.md`          | Long-term log of notable runs and what fixed them                               |
| `RCA-ARCHIVED-PAGES.md` | Post-mortem of the 2026-04-29 → 04-30 archived-page cascade — read before attempting any "archived block / archived ancestor" fix |
| `OVERWRITE-GUARDRAILS-EXPLORATION.md` | Design + research for the guardrails feature (sync-state.ts). Notion API edit-attribution, schema, rollout plan. |
| `RECONCILIATION-EXPLORATION.md` | Design (post-review) for the reconcile flow (reconcile.ts). 4-PR rollout; PR 1+2 done; PR 3 (pull-from-Notion) pending. |
| `scripts/probe-bot-id.ts` | Read-only probe — validates `users.me()` + `last_edited_by` + minute-rounding assumptions. Run before changing guardrail logic. |
| `scripts/simulate-human-edit.ts` | Tampers `.notion-sync-state.json` to force a divergence. Test-only utility. |
| `scripts/probe-bad-link.ts` | Read-only probe — walks a page's blocks and flags link URLs Notion would reject on `blocks.update` (the `#anchor`/relative case behind "Invalid URL for link"). |
| `PIPELINE.md`           | The post-sync pipeline / orchestration map (push → enrich → verify)             |
| `ROADMAP.md`            | Version history + shelved ideas                                                 |
| `SHARED-LIB-EXPLORATION.md` | Design doc for the `lib/` extraction (Workstream A)                         |
| `NAV-STRUCTURE-EXPLORATION.md` | Design exploration: alternatives to the deep nested-page tree (databases, flatten + ToC, synced-block nav, column layouts, toggles) |
| `DASHBOARDS-AND-ORCHESTRATION-EXPLORATION.md` | Design exploration: sitemap / tag index / recent-feed dashboards on Notion + pipeline-first project orchestration (`bash run.sh` modes) |

## Architecture — two-phase sync

**Phase 1 (discovery):** Walks all `.md` files, calls `getOrCreateChildPage` for each, builds `pageIdMap: Map<relPath, pageId>`.

**Phase 2 (content):** Walks the same files, calls `rewriteLinks` (uses `pageIdMap` to resolve `.md` links → Notion URLs), then `updateMarkdown` to push content.

The two-phase design is necessary: phase 2 needs all page IDs upfront so cross-file links can resolve correctly, even across sections.

## Environment variables

| Variable                     | Required | Description                                         |
| ---------------------------- | -------- | --------------------------------------------------- |
| `NOTION_TOKEN`               | yes      | Integration secret (`secret_...` or `ntn_...`)      |
| `NOTION_ROOT_PAGE_ID`        | yes      | Root page ID or URL                                 |
| `DOCS_DIR`                   | yes-ish  | Absolute path to local docs root (default `./docs`) |
| `GITHUB_REPO`                | no       | `owner/repo` for GitHub link fallbacks              |
| `GITHUB_BRANCH`              | no       | Branch for GitHub links (default: `development`)    |
| `GITHUB_DOCS_ROOT`           | no       | Repo-relative path corresponding to DOCS_DIR        |
| `GITHUB_DOC_SOURCE_URL_BASE` | no       | Override for "View source" link in breadcrumb       |
| `NOTION_LINK_MODE`           | no       | `notion` (default) \| `github` \| `strip`           |
| `NOTION_PAGE_ICON`           | no       | Default emoji for pages without frontmatter `icon:` |
| `NOTION_FOLDER_ICON`         | no       | Default emoji for sections without `_index.md`      |
| `NOTION_SHOW_META`           | no       | `0` to disable frontmatter banner (default: on)     |
| `NOTION_UPLOAD_IMAGES`       | no       | `1` to upload images to Notion CDN — required for private repos |
| `NOTION_USE_MENTIONS`        | no       | `0` to disable internal-link → mention conversion (default: on) |
| `NOTION_GUARDRAILS`          | no       | `strict` (default) \| `warn` \| `off` — overwrite protection for human-edited pages |
| `NOTION_SYNC_MAP`            | no       | Path to JSON mapping top-level dirs → separate Notion roots |
| `NOTION_FULL_WIDTH`          | no       | Declared but inert (full-width is not settable via the public API) |
| `NOTION_SITEMAP_PAGE_ID` etc. | no     | Pin a dashboard to an existing page instead of creating one. Also `NOTION_TAG_INDEX_PAGE_ID`, `NOTION_INDEX_DB_ID`, `NOTION_RECENT_FEED_PAGE_ID`, `NOTION_HEALTH_PAGE_ID` |
| `RECONCILE_DIFF_TOOL`        | no       | Pre-pick the reconcile diff renderer (bypasses the sub-menu) |
| `ABORT_POLICY`               | no       | `disabled` \| `1` \| `2` \| `3` \| `5` \| `10` (consecutive errors) |
| `DRY_RUN`                    | no       | `1` = preview only                                  |
| `VERBOSE`                    | no       | `1` = per-file output instead of progress bar       |

Command-line flags (passed to `sync.sh` → `index.ts`): `--no-wizard`, `--dry-run`, `--only <paths>`, `--fix-mentions`, `--resume`, `--verbose`, `--seed-state`, `--refresh-bot-id`, `--guardrails <strict|warn|off>`, `--force-overwrite`/`--accept-move`/`--accept-archive <paths>`, `--env <path>`.

## Frontmatter

Any `.md` file can have a YAML frontmatter block at the top:

```markdown
---
icon: 📋
cover: https://images.unsplash.com/photo-xxx?w=1200
---

# Page Title
```

- `icon`: emoji character or `https://` URL → sets Notion page icon
- `cover`: `https://` URL → sets Notion page cover image
- Frontmatter is stripped before content is sent to Notion

## Key functions in `index.ts`

- `parseFrontmatter(content)` — extracts `meta` dict and `body` from `---` block
- `resolveIcon(meta)` / `resolveCover(meta)` — converts frontmatter strings to Notion API shapes
- `getDoc(relPath)` — cached doc access; populates `docCache` on first read
- `rewriteLinks(content, relPath, pageIdMap)` — rewrites `.md` links based on `NOTION_LINK_MODE`
- `getOrCreateChildPage(parentId, title, icon?)` — idempotent page creation by title
- `updatePageMeta(pageId, icon, cover)` — sets icon/cover via `notion.pages.update`
- `preRunListing(allToSync)` — prints tree-structured file list, asks for confirmation
- `discoverAllPages(...)` — Phase 1 driver
- `writeFileContent(...)` — Phase 2 driver, calls `updateMarkdown`

## Notion API notes

- Uses `@notionhq/client` v5 with the native markdown endpoint: `PATCH /pages/:id/markdown`
- The `replace_content` body must be `{ new_str: string, allow_deleting_content: true }` (object, not string)
- Rate limit: **adaptive** — floor 350ms, ceiling 1050ms (3×). Widens on every API failure, narrows after 3 consecutive successes (commit `16e7eec`).
- Page lookup is by title under parent — no external state file needed
- **`replace_content` deletes child_page subpages too**, so Phase 1.5 uses a list-blocks → delete-non-child_page-blocks → `insert_content` flow to keep subpages alive (commit `83c9f41`).
- **`blocks.update` for images rejects an explicit `type` field** — the discriminator is inferred from which sub-field is present. Send `{image: {file_upload: {id}}}`, NOT `{image: {type: "file_upload", file_upload: {id}}}`.
- **Mention objects display the linked page's CURRENT title**, not the original markdown anchor text. By design (auto-updating), but worth noting if anchor text matters.
- **`blocks.update` re-validates EVERY link in the resent rich_text array** and rejects scheme-less URLs — notably in-page `#heading` anchors that the markdown *import* stored verbatim. So rewriting one block (e.g. mention conversion) fails the whole block if it also holds a TOC anchor. `mention-converter.ts` strips those dead links (keeps the text) when it rewrites a block. See `scripts/probe-bad-link.ts`.

## Phases

- **Phase 1 (discovery)**: walk all `.md`, `getOrCreateChildPage` for each, build `pageIdMap` and `discoveryMap`. Section pages also discovered + queued for Phase 1.5.
- **Phase 1.5 (section content)**: write `_index.md` content (or auto-index for folders without one) to each section page. Uses non-destructive list-blocks + delete-prose + `insert_content` to preserve child_page subpages. Failed sections get a retry pass at the end (up to 3 attempts each).
- **Phase 2 (leaf content)**: for each leaf doc — upload images (if `NOTION_UPLOAD_IMAGES=1`) → `updateMarkdown` → swap image blocks external→file_upload → convert internal links → mentions (if `NOTION_USE_MENTIONS=1`). Failed docs get a retry pass at the end (up to 3 attempts each). Each successful doc is recorded in the resume ledger and its guardrail baseline is flushed immediately.

## Resume (interrupted runs)

A full push takes >2h, almost all in Phase 2. Every doc that lands is appended to `.notion-sync-progress.<key>.json`. On the next run, a leftover ledger triggers `--resume` (or an interactive prompt): **Phase 1 discovery still runs fully** (idempotent; `pageIdMap` must be complete so links in the docs we *do* write resolve), but Phase 2 skips docs already in the ledger (status `skipped`). A clean finish (all docs reached, no errors) deletes the ledger; an incomplete run keeps it and prints the `--resume` hint. Dry-runs never touch the ledger.

`fix-mentions` has two cost optimizations: it skips docs whose local source has **no internal links** (nothing to convert), and `convertPageLinksToMentions` no longer descends into `child_page` blocks (every page is already walked in its own pass — avoids a quadratic re-walk).

## GitHub Actions

The workflow at `.github/workflows/notion-sync.yaml` has the **push trigger disabled**. It only runs when triggered manually (`workflow_dispatch`). Do not re-enable the push trigger without checking with the user.

## Diagnosing runs

Run logs are in `runs.jsonl` (append-only JSONL, one object per run). Each entry has a `run_id` field (format: `YYYYMMDD-HHmmss`) for easy reference.

### Read the latest run

```bash
tail -n 1 runs.jsonl | python3 -m json.tool
```

### Read a specific run by ID

```bash
grep '"run_id":"20260429-143022"' runs.jsonl | python3 -m json.tool
```

### Key fields to check

| Field | What to look at |
| ----- | --------------- |
| `stats.errors` | Non-zero = something failed |
| `stats.aborted` | True = systemic failure hit the rolling abort window |
| `error_summary` | Array of `{path, error, suspicions}` — quickest failure overview |
| `pages[*].suspicions` | Array of `{name, explain}` for each failed file — WAF/size/content diagnosis |
| `sections[*].content_written` | False = section page content write failed |
| `config` | Full snapshot of all settings active during the run |
| `timing` | `phase1_ms` = discovery, `phase2_ms` = content writes |
| `image_stats` | `{uploads, cache_hits, total_in_cache}` — only set when `NOTION_UPLOAD_IMAGES=1`. Cache-hit ratio tracks dedup efficiency. |
| `partial` | True = run was killed mid-flight (SIGINT/SIGTERM/uncaught). `partial_reason` records the cause. Stats reflect progress at termination. |

### Quick failure scan across recent runs

```bash
bash list.sh recent-errors            # last 5 runs, only prints details for those with errors or partial: true
bash list.sh recent-errors --limit 50 # wider window, e.g. when investigating a regression
```

Output prints `run_id`, error count, suspicion tags per failed path, and a copy-paste `bash sync.sh --only ...` retry command. Does not require a Notion cache — purely local-log.

### Suspicion rules (built into the script)

| Rule name | What it means |
| --------- | -------------- |
| `cloudflare-waf-curl` | `curl` + `localhost`/IP in request body — Cloudflare SSRF WAF block. Fix: reword to remove the combination outside fenced blocks. |
| `cloudflare-waf-shell-pipe` | Shell pipe pattern in inline code outside a fenced block — command injection WAF signature. |
| `cloudflare-waf-sql-keyword` | SQL keywords (SELECT/DROP/etc.) in prose — ModSecurity rule. |
| `cloudflare-waf-script-tag` | `<script>` tag — always blocked. |
| `notion-body-too-large` | File exceeds 500 KB — Notion markdown body limit. |

See [SUSPICION-RULES.md](SUSPICION-RULES.md) for full code samples (triggers vs. safe patterns) and fix recipes for each rule.

### After analysing a run

Append findings to `run-notes.md` — newest entry first, include the `run_id`, date, what happened, and what fixed it (or what to try next). This file is the long-term memory for run patterns.

For the archived-page incident specifically, see [RCA-ARCHIVED-PAGES.md](RCA-ARCHIVED-PAGES.md) — the consolidated post-mortem, including a diagnostic recipe for any future "archived block" / "archived ancestor" recurrences. Read that before patching anything around `getOrCreateChildPage` or `listChildPages`.
