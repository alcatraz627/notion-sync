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

| Variable              | Required | Default            | Description                                                  |
| --------------------- | -------- | ------------------ | ------------------------------------------------------------ |
| `NOTION_TOKEN`        | yes      | —                  | Integration secret (`secret_...` or `ntn_...`)               |
| `NOTION_ROOT_PAGE_ID` | yes      | —                  | ID or URL slug of the root Notion page                       |
| `DOCS_DIR`            | yes      | `./docs`           | Absolute path to the local docs folder to sync               |
| `GITHUB_REPO`         | no       | —                  | `owner/repo` — used for link fallbacks + image URLs          |
| `GITHUB_BRANCH`       | no       | `development`      | Branch for GitHub URLs                                       |
| `GITHUB_DOCS_ROOT`    | no       | `frontend/docs`    | Repo-relative path matching `DOCS_DIR`, for image URL building |
| `GITHUB_DOCS_PATH`    | no       | `frontend/docs`    | Repo-relative path for markdown link fallbacks               |
| `NOTION_LINK_MODE`    | no       | `notion`           | `notion` \| `github` \| `strip` — how `.md` links are rewritten |
| `NOTION_PAGE_ICON`    | no       | —                  | Default emoji for leaf pages without `icon:` frontmatter     |
| `NOTION_FOLDER_ICON`  | no       | —                  | Default emoji for section pages without `_index.md`          |
| `NOTION_FULL_WIDTH`   | no       | on                 | Set `0` to disable full-width layout on all pages            |
| `NOTION_SHOW_META`    | no       | on                 | Set `0` to suppress the frontmatter banner on each page      |
| `NOTION_SYNC_MAP`     | no       | —                  | Path to JSON file mapping top-level folders to Notion roots  |
| `DRY_RUN`             | no       | —                  | Set `1` to preview without writing                           |

## Link and image rewriting

**Links:** Relative `.md` links are rewritten during phase 2 based on `NOTION_LINK_MODE`:

| Mode               | Behaviour                                                       |
| ------------------ | --------------------------------------------------------------- |
| `notion` (default) | Rewrites to Notion page URL; falls back to GitHub URL if needed |
| `github`           | Always rewrites to GitHub viewer URL                            |
| `strip`            | Removes the link, leaves plain text                             |

**Images:** Relative image paths (`./images/foo.png`) are rewritten to `raw.githubusercontent.com` URLs using `GITHUB_REPO`, `GITHUB_BRANCH`, and `GITHUB_DOCS_ROOT`. Already-absolute URLs pass through unchanged.

## Failure handling

- **Per-file failures** are skipped — the run continues to the next file.
- **Systemic abort** — if 5+ failures occur within a rolling window of 10 items, the run aborts (likely token revocation, network failure, or persistent WAF block).
- **Retry command** — printed at end of run for any failed files: `bash sync.sh --only file1 file2`
- **Suspicion rules** — on any push failure, the file content is checked against WAF + size rules to explain probable causes.

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
