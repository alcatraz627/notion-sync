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
  Push <code>docs/product/**</code> markdown files to Notion — maintaining folder structure, icons, covers, and cross-doc links.
</p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white"/>
  <img alt="Node" src="https://img.shields.io/badge/Node-22-339933?logo=node.js&logoColor=white"/>
  <img alt="Standalone" src="https://img.shields.io/badge/standalone-not%20part%20of%20Next.js%20app-orange"/>
</p>

---

> **Standalone tool.** This script has its own `package.json`, `node_modules`, and `tsconfig.json`. It is not imported by or built with the Next.js frontend app. Run it locally with `bash sync.sh` or trigger it manually via GitHub Actions.

## Quick Start

```bash
cd frontend/scripts/notion-sync

# 1. Copy env template and fill in your credentials
cp .env.example .env
# Edit .env: set NOTION_TOKEN and NOTION_ROOT_PAGE_ID

# 2. Dry run — preview what would be synced, no writes to Notion
bash sync.sh --dry-run

# 3. Real sync
bash sync.sh

# 4. Sync only specific sections
bash sync.sh --only jobs
bash sync.sh --only jobs/overview.md admin
```

See [SETUP.md](SETUP.md) for one-time Notion integration setup and GitHub Actions configuration.

## What it does

The script walks `docs/product/**` and mirrors the folder structure as nested Notion pages:

```
docs/product/
├── overview.md        → page directly under Notion root
├── jobs/              → "Jobs" section page
│   ├── overview.md   → child page
│   └── details.md    → child page
├── user/              → "User" section page
└── admin/             → "Admin" section page
```

**Two-phase sync:**

1. **Discovery** — walks all files, creates or finds Notion pages by title, builds a `relPath → pageId` map.
2. **Content** — writes markdown content to each page, resolving relative `.md` links to Notion URLs using the map from phase 1.

This two-phase approach means cross-file links always resolve correctly, even across sections.

**Idempotent:** Finding pages by title under their parent means repeated runs never create duplicates. Content is replaced in place.

## Page metadata (frontmatter)

Add a YAML block at the top of any `.md` file to set Notion-specific properties:

```markdown
---
icon: 📋
cover: https://images.unsplash.com/photo-xxx?w=1200
---

# Page Title

Content starts here.
```

| Field   | Type                    | Effect                                              |
| ------- | ----------------------- | --------------------------------------------------- |
| `icon`  | emoji or `https://` URL | Sets the Notion page icon (emoji or external image) |
| `cover` | `https://` URL          | Sets the Notion page cover image                    |

The frontmatter block is stripped before content is sent to Notion. See [SETUP.md](SETUP.md#adding-page-metadata-frontmatter) for full details.

## Environment variables

| Variable              | Required | Default       | Description                                                  |
| --------------------- | -------- | ------------- | ------------------------------------------------------------ |
| `NOTION_TOKEN`        | yes      | —             | Integration secret (`secret_...` or `ntn_...`)               |
| `NOTION_ROOT_PAGE_ID` | yes      | —             | ID or URL of the root Notion page                            |
| `GITHUB_REPO`         | no       | —             | e.g. `versable-git/enhancement-product` (for link fallbacks) |
| `GITHUB_BRANCH`       | no       | `development` | Branch used in GitHub link fallbacks                         |
| `NOTION_LINK_MODE`    | no       | `notion`      | `notion` \| `github` \| `strip` — controls link rewriting    |
| `NOTION_PAGE_ICON`    | no       | —             | Default emoji for pages without frontmatter `icon:`          |
| `DRY_RUN`             | no       | —             | Set to `1` to preview without writing                        |

Set these in `.env` for local use (loaded automatically by `sync.sh`).

## Link rewriting

Relative `.md` links between docs are rewritten at sync time:

| `NOTION_LINK_MODE` | Behaviour                                                       |
| ------------------ | --------------------------------------------------------------- |
| `notion` (default) | Rewrites to Notion page URL; falls back to GitHub URL if needed |
| `github`           | Always rewrites to GitHub file URL                              |
| `strip`            | Removes link, leaves plain text                                 |

Fragment-only links (`#anchor`) and absolute URLs pass through unchanged.

## Images

Images must use absolute URLs to render in Notion — relative paths (`./images/foo.png`) will not load via the API.

Use GitHub raw URLs for images committed to the repo:

```
https://raw.githubusercontent.com/versable-git/enhancement-product/development/frontend/docs/product/images/your-image.png
```

## Excluded files

Files matching `_*.md` or `*.claude.md` (Claude scratchpad files) are skipped automatically.

## GitHub Actions

The workflow at `.github/workflows/notion-sync.yaml` exists but the **push trigger is disabled** — it will not run on commits automatically. Trigger it manually via **Actions → Sync docs to Notion → Run workflow**.

To re-enable automatic syncing, add a `push:` trigger to the workflow file.
