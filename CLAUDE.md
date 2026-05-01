# notion-sync — Claude Context

## What this is

A **standalone Node.js script** (`index.ts`) that pushes markdown files from `docs/product/**` to Notion. It has its own `package.json`, `node_modules`, and `tsconfig.json`.

**It is not part of the Next.js frontend app.** Do not import from it, build it with Next.js, or treat it as part of the frontend dependency tree. Nothing in `src/` references it. It runs completely independently.

## Running

```bash
bash sync.sh                  # interactive wizard (sync OR fix-mentions mode)
bash sync.sh --no-wizard      # use saved defaults
bash sync.sh --dry-run        # preview only, no Notion writes
bash sync.sh --only jobs      # filter to one section
bash sync.sh --fix-mentions   # convert internal links → mentions on already-synced pages

bash list.sh                  # render cached remote tree
bash list.sh fetch            # refresh cache from Notion
bash list.sh diff             # title-based diff vs local docs
bash list.sh fix-mentions     # standalone mention conversion (no sync)
bash list.sh empty-paths      # print local paths whose remote page is empty
```

For end-user docs see [USAGE.md](USAGE.md). This file is for Claude (architectural context).

## Key files

| File                    | Purpose                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| `index.ts`              | Sync logic — Phase 1 discovery, Phase 1.5 sections, Phase 2 content + retries   |
| `image-uploader.ts`     | Notion CDN image upload (sha256-cached) + image-block external→file_upload swap |
| `mention-converter.ts`  | Walk page blocks, rewrite internal hyperlinks → native page mentions            |
| `notion-list.ts`        | Read remote tree, cache to `.notion-cache.json`, diff/show/empty-paths/fix-mentions |
| `sync.sh`               | Wizard + env validation + macOS notification + bun launcher                     |
| `list.sh`               | Wraps notion-list.ts with notification on long-running subcommands              |
| `.env` / `.env.example` | Credentials + behaviour toggles                                                 |
| `.sync-defaults.json`   | Wizard's saved selections (gitignored)                                          |
| `.notion-cache.json`    | Cached remote page tree from `list.sh fetch` (gitignored)                       |
| `.notion-image-cache.json` | sha256 → file_upload_id map for uploaded images (gitignored)                |
| `runs.jsonl`            | Append-only log of every sync run                                               |
| `metrics.jsonl`         | Rolling-window (last 5) per-API-call timing                                     |
| `SETUP.md`              | One-time Notion integration setup guide                                         |
| `USAGE.md`              | Task-oriented end-user guide (covers all scenarios)                             |
| `run-notes.md`          | Long-term log of notable runs and what fixed them                               |
| `RCA-ARCHIVED-PAGES.md` | Post-mortem of the 2026-04-29 → 04-30 archived-page cascade — read before attempting any "archived block / archived ancestor" fix |

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
| `NOTION_SYNC_MAP`            | no       | Path to JSON mapping top-level dirs → separate Notion roots |
| `ABORT_POLICY`               | no       | `disabled` \| `1` \| `2` \| `3` \| `5` \| `10` (consecutive errors) |
| `DRY_RUN`                    | no       | `1` = preview only                                  |
| `VERBOSE`                    | no       | `1` = per-file output instead of progress bar       |

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

## Phases

- **Phase 1 (discovery)**: walk all `.md`, `getOrCreateChildPage` for each, build `pageIdMap` and `discoveryMap`. Section pages also discovered + queued for Phase 1.5.
- **Phase 1.5 (section content)**: write `_index.md` content (or auto-index for folders without one) to each section page. Uses non-destructive list-blocks + delete-prose + `insert_content` to preserve child_page subpages. Failed sections get a retry pass at the end (up to 3 attempts each).
- **Phase 2 (leaf content)**: for each leaf doc — upload images (if `NOTION_UPLOAD_IMAGES=1`) → `updateMarkdown` → swap image blocks external→file_upload → convert internal links → mentions (if `NOTION_USE_MENTIONS=1`). Failed docs get a retry pass at the end (up to 3 attempts each).

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
