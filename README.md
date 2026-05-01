<div align="center">
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="128" height="128">
    <!-- Terminal >_ motif on dark background -->
    <rect x="0" y="0" width="64" height="64" fill="#0d1117"/>
    <!-- Window chrome -->
    <rect x="4" y="4" width="56" height="8" fill="#21262d"/>
    <rect x="8" y="7" width="4" height="2" fill="#f85149" rx="1"/>
    <rect x="14" y="7" width="4" height="2" fill="#3fb950" rx="1"/>
    <rect x="20" y="7" width="4" height="2" fill="#d29922" rx="1"/>
    <!-- > prompt -->
    <rect x="8" y="20" width="2" height="6" fill="#58a6ff"/>
    <rect x="10" y="20" width="2" height="2" fill="#58a6ff"/>
    <rect x="10" y="24" width="2" height="2" fill="#58a6ff"/>
    <!-- _ cursor -->
    <rect x="14" y="26" width="8" height="2" fill="#58a6ff"/>
    <!-- Notion N icon suggestion -->
    <rect x="40" y="18" width="4" height="18" fill="#e6edf3"/>
    <rect x="44" y="18" width="2" height="6" fill="#e6edf3"/>
    <rect x="46" y="24" width="2" height="6" fill="#8b949e"/>
    <rect x="48" y="30" width="4" height="6" fill="#8b949e"/>
    <rect x="52" y="18" width="4" height="18" fill="#8b949e"/>
    <!-- arrow connecting terminal to N -->
    <rect x="26" y="27" width="10" height="2" fill="#3fb950"/>
    <rect x="34" y="25" width="2" height="6" fill="#3fb950"/>
    <!-- bottom decorative line -->
    <rect x="4" y="48" width="56" height="2" fill="#21262d"/>
    <rect x="4" y="52" width="30" height="2" fill="#161b22"/>
  </svg>
</div>

<h1 align="center">notion-sync</h1>

<p align="center">
  Push markdown docs to Notion — maintaining folder structure, icons, covers, and cross-doc links.
</p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white"/>
  <img alt="Node" src="https://img.shields.io/badge/Node-22-339933?logo=node.js&logoColor=white"/>
  <img alt="Standalone" src="https://img.shields.io/badge/standalone-not%20part%20of%20Next.js%20app-orange"/>
</p>

---

> **Standalone tool.** Has its own `package.json`, `node_modules`, and `tsconfig.json`. Not imported by or built with the Next.js frontend app. Run locally with `bash sync.sh` or trigger manually via GitHub Actions.

## Quick start

```bash
# 1. Copy env template and fill in credentials
cp .env.example .env

# 2. Dry run — preview without writing to Notion
bash sync.sh --dry-run

# 3. Full sync
bash sync.sh

# 4. Sync only specific files or folders
bash sync.sh --only jobs
bash sync.sh --only auth-flow e2e-get-started
```

See [SETUP.md](SETUP.md) for one-time Notion integration setup, and [USAGE.md](USAGE.md) for a task-oriented guide covering every scenario (selective sync, image upload, mentions, diff, retry, performance tuning, etc.).

## Commands

Two scripts cover everything. Each row links to the relevant USAGE section.

### `sync.sh` — push local docs → Notion

| Command | What it does | Details |
|---|---|---|
| `bash sync.sh` | Interactive wizard (pick mode, filter, options) | [§1 Daily sync](USAGE.md#1-daily-sync-workflow) |
| `bash sync.sh --no-wizard` | Use saved defaults from last run | [§1](USAGE.md#1-daily-sync-workflow) |
| `bash sync.sh --dry-run` | Preview without writing | [§3 Dry-run](USAGE.md#3-dry-run-preview) |
| `bash sync.sh --only X Y …` | Sync only matching sections / files | [§2 Selective sync](USAGE.md#2-selective-sync) |
| `bash sync.sh --verbose` | Per-file output instead of progress bar | [§11 Performance tuning](USAGE.md#11-performance-tuning) |
| `bash sync.sh --fix-mentions` | Skip sync; convert internal links → page mentions | [§8 Mentions](USAGE.md#8-internal-links--page-mentions) |
| `bash sync.sh -h` | Inline help | — |

### `list.sh` — read remote, diff, batch-fix

| Command | What it does | Details |
|---|---|---|
| `bash list.sh` | Render cached remote tree (auto-fetches if no cache) | [§4 Verifying remote](USAGE.md#4-verifying-remote-state) |
| `bash list.sh fetch` | Refresh cache from Notion (~6 min for ~300 pages) | [§4](USAGE.md#4-verifying-remote-state) |
| `bash list.sh fetch --no-icons` | Faster fetch, skip per-page icon retrieval | [§4](USAGE.md#4-verifying-remote-state) |
| `bash list.sh show --max-depth N` | Collapse tree beyond depth N | [§4](USAGE.md#4-verifying-remote-state) |
| `bash list.sh show --empty-only` | Only pages with 0 content blocks | [§4](USAGE.md#4-verifying-remote-state) |
| `bash list.sh diff` | Title-based comparison vs local docs | [§5 Comparing](USAGE.md#5-comparing-local-vs-remote) |
| `bash list.sh empty-paths` | Print local paths whose remote page is empty | [§5](USAGE.md#5-comparing-local-vs-remote) |
| `bash list.sh fix-mentions` | Standalone: rewrite links → mentions on every cached page | [§8 Mentions](USAGE.md#8-internal-links--page-mentions) |

### Common workflows

```bash
# First sync after a long time
bash list.sh fetch                                # snapshot remote
bun compare-apr-30-1/compare.ts                   # path-based diff vs local
bash sync.sh                                      # full sync (wizard)
bash list.sh fix-mentions                         # convert legacy links

# Daily one-file change
bash sync.sh --no-wizard --only create-scraper

# Mop up empty remote pages
bash sync.sh --no-wizard --only $(bash list.sh empty-paths)
```

## What it does

Mirrors a local docs folder to Notion as nested pages, maintaining the full folder hierarchy:

```
docs/
├── overview.md              → leaf page under root
├── product/                 → "Product" section page (auto-indexed)
│   ├── _index.md            → content for the "Product" section page
│   ├── auth-flow.md         → child page
│   └── app/                 → "App" section page
│       └── auth-flow.md     → nested child page
└── system/                  → "System" section page
```

**Two-phase sync** — phase 1 discovers / creates all Notion pages and builds a `relPath → pageId` map; phase 2 writes content with cross-file links already resolved. This means links between any two docs always point to the right Notion page, even across sections.

**Idempotent** — pages are looked up by title under their parent. Repeated runs update content in place and never create duplicates.

## Architecture

```
                              ┌──────────────────────┐
   ┌─────────────────┐        │     Notion API       │
   │  docs/ (.md)    │        │  (api.notion.com)    │
   │  + frontmatter  │        └──────────┬───────────┘
   │  + images/      │                   │
   └────────┬────────┘                   │ HTTPS
            │ scanTree                   │ rate-limited (350-1050ms adaptive)
            ▼                            │
   ┌─────────────────┐                   │
   │   index.ts      │ ─── 1. discover ──▶  pages.create / find by title
   │   (sync engine) │ ─── 1.5 sections ─▶  blocks.list + delete-prose + insert
   │                 │ ─── 2. content ───▶  pages.updateMarkdown
   │                 │ ─── 2a. images ───▶  fileUploads.{create,send}
   │                 │ ─── 2b. mentions ─▶  blocks.list + blocks.update
   └────┬────────┬───┘                   │
        │        │                       │
        ▼        ▼                       │
   ┌────────┐ ┌────────────┐             │
   │image-  │ │mention-    │             │
   │uploader│ │converter   │             │
   └────────┘ └────────────┘             │
            ▲                            │
            │                            │
   ┌────────┴────────┐                   │
   │   sync.sh       │                   │
   │   (wizard +     │                   │
   │   notifier)     │                   │
   └─────────────────┘                   │
                                         │
   ┌─────────────────┐                   │
   │  notion-list.ts │ ◀─── fetch tree ──┘  blocks.children.list
   │  + list.sh      │      fix-mentions
   │  (read / diff)  │
   └────┬────────────┘
        │
        ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  Persistent state (gitignored)                               │
   │   • runs.jsonl              — append-only run log            │
   │   • metrics.jsonl           — rolling-window per-call timing │
   │   • .sync-defaults.json     — wizard's saved selections      │
   │   • .notion-cache.json      — cached remote tree             │
   │   • .notion-image-cache.json — sha256 → file_upload_id       │
   └──────────────────────────────────────────────────────────────┘
```

**Module responsibilities:**

| Module                  | Owns                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `sync.sh`               | wizard, env validation, defaults file, completion notification                        |
| `index.ts`              | Phase 1 discovery, Phase 1.5 sections, Phase 2 leaf writes, retry passes, run logging |
| `image-uploader.ts`     | sha256 dedup cache, fileUploads create+send, post-write image-block external→file_upload swap |
| `mention-converter.ts`  | walk page blocks, rewrite text-link annotations → page mentions                       |
| `notion-list.ts`        | walk Notion tree, save cache, render show/diff/empty-paths/fix-mentions               |
| `list.sh`               | wraps notion-list.ts; notification on long subcommands                                |

## Folder indexes (`_index.md`)

Drop a `_index.md` file in any folder to control that folder's section page:

```markdown
---
icon: 📦
---

# Product Docs

Overview text, a curated table of contents, See Also links — whatever you want
shown when someone lands on the section page.
```

- The `icon:` frontmatter sets the section page icon in Notion.
- The body becomes the section page content (after link + image rewriting).
- `_index.md` files are **never** synced as their own separate Notion pages.
- Folders **without** `_index.md` get an auto-generated index (child doc table with status + audience, subsection counts).

## Page metadata (frontmatter)

Any `.md` file can have a frontmatter block:

```markdown
---
icon: 📋
cover: https://images.unsplash.com/photo-xxx?w=1200
status: stable
audience: engineering
last_updated: 2026-04-24
---

# Page Title
```

| Field          | Effect                                                      |
| -------------- | ----------------------------------------------------------- |
| `icon`         | Emoji or `https://` URL → Notion page icon                  |
| `cover`        | `https://` URL → Notion page cover image                    |
| `status`       | Shown in metadata banner + auto-index tables                |
| `audience`     | Shown in metadata banner + auto-index tables                |
| `last_updated` | Shown in metadata banner                                    |

The frontmatter block is stripped before content is sent to Notion. Status + audience + last_updated are prepended as a blockquote banner at the top of each synced page.

## Folder mapping (`NOTION_SYNC_MAP`)

Route different top-level folders to separate Notion root pages:

```json
// sync-map.json
{
  "product": "Product-Docs-34abacd27dee80f3be8fe230c7d1ff9d",
  "boring-technical-stuff": "Eng-Docs-34abacd27dee80f3be8fe230c7d1ff9d"
}
```

```
NOTION_SYNC_MAP=./sync-map.json
```

Mapped folders bypass the default root and root their subtree directly under the mapped Notion page.

## Environment variables

| Variable                     | Required | Default            | Description                                                       |
| ---------------------------- | -------- | ------------------ | ----------------------------------------------------------------- |
| `NOTION_TOKEN`               | yes      | —                  | Integration secret (`secret_...` or `ntn_...`)                    |
| `NOTION_ROOT_PAGE_ID`        | yes      | —                  | ID or URL slug of the root Notion page                            |
| `DOCS_DIR`                   | yes      | `./docs`           | Absolute path to the local docs folder to sync                    |
| `GITHUB_REPO`                | no       | —                  | `owner/repo` — used for link fallbacks + image URLs               |
| `GITHUB_BRANCH`              | no       | `development`      | Branch for GitHub URLs                                            |
| `GITHUB_DOCS_ROOT`           | no       | `frontend/docs`    | Repo-relative path matching `DOCS_DIR`, for image URL building    |
| `GITHUB_DOCS_PATH`           | no       | `frontend/docs`    | Repo-relative path for markdown link fallbacks                    |
| `GITHUB_DOC_SOURCE_URL_BASE` | no       | computed           | Override for the per-doc "View source on GitHub" breadcrumb link  |
| `NOTION_LINK_MODE`           | no       | `notion`           | `notion` \| `github` \| `strip` — how `.md` links are rewritten   |
| `NOTION_PAGE_ICON`           | no       | —                  | Default emoji for leaf pages without `icon:` frontmatter          |
| `NOTION_FOLDER_ICON`         | no       | —                  | Default emoji for section pages without `_index.md`               |
| `NOTION_SHOW_META`           | no       | on                 | Set `0` to suppress the frontmatter banner on each page           |
| `NOTION_UPLOAD_IMAGES`       | no       | off                | `1` to upload images to Notion's CDN — required for private repos |
| `NOTION_USE_MENTIONS`        | no       | on                 | `0` to disable internal-link → page-mention conversion            |
| `NOTION_SYNC_MAP`            | no       | —                  | Path to JSON file mapping top-level folders to Notion roots       |
| `ABORT_POLICY`               | no       | `disabled`         | `disabled` \| `1` \| `2` \| `3` \| `5` \| `10` (consecutive errors) |
| `DRY_RUN`                    | no       | —                  | Set `1` to preview without writing                                |
| `VERBOSE`                    | no       | —                  | Set `1` for per-file output instead of progress bar               |

> `NOTION_FULL_WIDTH` is intentionally unused — `is_full_width` is **not settable via Notion's public REST API**. Verified 2026-05-01 across `format.full_width`, `is_full_width`, `page.full_width`, `format.is_full_width` shapes — all return `validation_error: body.X should be not present`. Notion strips the field from both reads and writes. Workarounds: toggle per-page in the Notion UI; or use a userscript / browser extension to auto-toggle on page load. Database views (D4 sidecar Index DB, future feature) render wide by default and partially address this.

## Link and image rewriting

**Links:** Relative `.md` links are rewritten during phase 2 based on `NOTION_LINK_MODE`:

| Mode               | Behaviour                                                       |
| ------------------ | --------------------------------------------------------------- |
| `notion` (default) | Rewrites to Notion page URL; falls back to GitHub URL if needed |
| `github`           | Always rewrites to GitHub viewer URL                            |
| `strip`            | Removes the link, leaves plain text                             |

After Phase 2 writes a page's content, internal `.md` links pointing at our synced pages are converted to **native Notion page mentions** — inline pills with hover-preview, side-peek navigation, and auto-updating titles. Disable via `NOTION_USE_MENTIONS=0`. See [USAGE §8](USAGE.md#8-internal-links--page-mentions) for the tradeoff (mentions display the linked page's current title, not the original anchor text).

**Images:** Relative image paths (`./images/foo.png`) are rewritten to `raw.githubusercontent.com` URLs using `GITHUB_REPO`, `GITHUB_BRANCH`, and `GITHUB_DOCS_ROOT`. For **private repos**, those URLs return 404 to Notion — set `NOTION_UPLOAD_IMAGES=1` to upload each image to Notion's CDN and swap the image block from `external` → `file_upload` after the markdown write. Uploads are sha256-cached in `.notion-image-cache.json` so re-runs and renames don't re-upload. See [USAGE §7](USAGE.md#7-image-uploads-for-private-repos).

## Failure handling

- **Per-item failures** are collected during the main loop, then a **retry pass** (up to 3 attempts each) runs at the end of Phase 1.5 and Phase 2 — handles transient 502s and timeouts.
- **Adaptive linear backoff** — rate limit widens on every API failure (350ms → 1050ms over 3 steps), narrows after 3 consecutive successes. Linear, not exponential, so a single blip doesn't slingshot the rate for the rest of the run.
- **Systemic abort** — configurable via `ABORT_POLICY` (1, 2, 3, 5, 10 consecutive failures). Disabled by default — collect every error, finish the run.
- **Retry command** — printed at the end of run for any items still failing after 3 attempts: `bash sync.sh --only file1 file2`.
- **Suspicion rules** — on any push failure, file content is checked against WAF + size rules. Findings appear in the per-file error log and `runs.jsonl` `error_summary[].suspicions`.
- **Crash-safe partial cache** — `list.sh fetch` saves a partial cache on SIGINT or unhandled error so 88 pages of progress aren't lost to a single 502.
- **Crash-safe partial run logs** — Ctrl-C / SIGTERM / uncaught exception during `sync.sh` flushes a `partial: true` entry to `runs.jsonl` with `partial_reason` recording the cause. Use `bash list.sh recent-errors` to see what got done before the kill.
- **Archived-page handling** — pages deleted in Notion between runs are detected in Phase 1 (`pages.retrieve` checks `in_trash || archived`) and treated as non-existent, so a fresh page is created. Background: [RCA-ARCHIVED-PAGES.md](RCA-ARCHIVED-PAGES.md).

## Run logs

Every run appends a JSON entry to `runs.jsonl`. Each entry includes:
- `run_id` — `YYYYMMDD-HHmmss` slug for easy reference
- `config` — full snapshot of all settings active during the run
- `timing` — `phase1_ms` (discovery) + `phase2_ms` (content writes)
- `pages` — per-file results with status, elapsed time, and suspicion diagnoses
- `sections` — per-folder section page write results
- `error_summary` — quick list of failed paths + suspicion names

Ask Claude to analyse a run: _"Read the latest entry in runs.jsonl and tell me what failed and why."_

## Excluded files

Files matching `_*.md` (except `_index.md` which is used for folder metadata) and `*.claude.md` are skipped.

## GitHub Actions

The workflow at `.github/workflows/notion-sync.yaml` exists but the **push trigger is disabled** — it won't run on commits automatically. Trigger it manually via **Actions → Sync docs to Notion → Run workflow**.

---
