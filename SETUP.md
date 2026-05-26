# Notion Sync — Setup

Pushes `docs/product/**` to a Notion workspace. Runs as a **standalone local tool** — it has its own `package.json`, `node_modules`, and `tsconfig.json` and is completely independent from the Next.js frontend app.

## One-time setup

### 1. Create a Notion integration

1. Go to https://www.notion.so/my-integrations
2. Click **New integration**
3. Name it something like "Versable Docs Sync"
4. Set Capabilities: **Read content**, **Update content**, **Insert content**
5. Copy the **Internal Integration Secret** (starts with `secret_...`)

### 2. Create or choose the root Notion page

In your Notion workspace, create a page where the docs should live (e.g. "Product Docs"). This will be the parent of all synced content.

**Get the page ID:**

- Open the page in Notion
- The URL looks like: `https://www.notion.so/your-workspace/Page-Title-<PAGE_ID>`
- The page ID is the last 32-character hex string in the URL
- Example: `https://www.notion.so/my-workspace/Product-Docs-abc123def456...` → ID is `abc123def456...`

**Connect your integration to the page:**

- Open the page in Notion
- Click `...` (top right) → **Connections** → find your integration → connect it

### 3. Add GitHub secrets

In your GitHub repo → **Settings** → **Secrets and variables** → **Actions**:

| Secret name           | Value                                          |
| --------------------- | ---------------------------------------------- |
| `NOTION_TOKEN`        | The integration secret from step 1             |
| `NOTION_ROOT_PAGE_ID` | The page ID from step 2 (no hyphens, 32 chars) |

---

## Running locally

The tool runs on **[Bun](https://bun.sh)**. From the project root, install deps once, copy `.env.example` to `.env` and fill in your credentials, then use the helper scripts:

```bash
bun install                   # one-time: install dependencies

# Dry run (preview, no writes)
bash sync.sh --dry-run

# Sync everything (interactive wizard)
bash sync.sh

# Sync only specific folders or files
bash sync.sh --only jobs
bash sync.sh --only jobs/overview.md admin

# Resume an interrupted run (skips docs already written)
bash sync.sh --resume
```

`bash run.sh` is the pipeline-first launcher (named modes: `push`, `push:full`, `dashboard`, `check`, `bring-up`); run it bare for an interactive picker. See [USAGE.md](USAGE.md) for every scenario.

Or run the script directly with env vars (Bun reads `.ts` natively — no build step):

```bash
# Dry run
NOTION_TOKEN=secret_xxx NOTION_ROOT_PAGE_ID=xxx DRY_RUN=1 bun index.ts

# Real sync
NOTION_TOKEN=secret_xxx NOTION_ROOT_PAGE_ID=xxx \
  GITHUB_REPO=versable-git/enhancement-product \
  GITHUB_BRANCH=development \
  bun index.ts
```

---

## Adding page metadata (frontmatter)

Each `.md` file can include a YAML frontmatter block at the very top to control how its Notion page looks. All fields are optional.

```markdown
---
icon: 📋
cover: https://images.unsplash.com/photo-xxx?w=1200
---

# My Page Title

Page content starts here...
```

| Field   | Type                    | Description                                                                                         |
| ------- | ----------------------- | --------------------------------------------------------------------------------------------------- |
| `icon`  | emoji or `https://` URL | Sets the page icon. An emoji character is applied directly; a URL is set as an external image icon. |
| `cover` | `https://` URL          | Sets the page cover image. Must be a publicly accessible image URL (Unsplash, GitHub raw, etc).     |

**Notes:**

- Frontmatter must be at the very top of the file — no content before the opening `---`
- The frontmatter block is stripped before content is sent to Notion
- The page title is always taken from the first `# Heading` in the file body (not from frontmatter)
- You can set a default icon for all pages without frontmatter via the `NOTION_PAGE_ICON` env var (e.g. `NOTION_PAGE_ICON=📄`)

**Example with external icon URL:**

```markdown
---
icon: https://raw.githubusercontent.com/versable-git/enhancement-product/development/frontend/docs/product/images/jobs-icon.png
cover: https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=1200&auto=format&fit=crop
---

# Jobs Overview
```

---

## How it works

```
docs/product/
├── README.md            → page under root
├── jobs/                → "Jobs" section page
│   ├── overview.md      → child page
│   └── ...
├── user/                → "User" section page
├── admin/               → "Admin" section page
└── system/              → "System" section page
```

**Idempotency:** On each run, the script finds existing pages by title under their parent. If a page with that title exists, its content is replaced. If not, a new page is created. Run it as many times as you like — no duplicates.

**Link rewriting:** Relative `.md` links (e.g. `./jobs/overview.md`) are rewritten based on `NOTION_LINK_MODE` — default `notion` rewrites to the linked doc's **Notion page URL** (falling back to a GitHub URL if the target isn't synced), then Phase 2 converts those into native page mentions. `github` mode always links to GitHub; `strip` drops the link. External links and anchors are left unchanged.

**Files excluded:** Anything matching `_*.md` or `*.claude.md` (Claude scratchpad files) is not synced.

**Mermaid diagrams:** Rendered as code blocks in Notion. Notion displays them as readable code; they don't render as visual diagrams via the API.

---

## Adding images

When you add images to the docs:

- **Recommended (works for private repos): set `NOTION_UPLOAD_IMAGES=1`.** Each local/relative image is uploaded to Notion's own CDN and the image block is swapped to a `file_upload` reference. Uploads are sha256-cached in `.notion-image-cache.json`, so re-runs and renames don't re-upload.
- Without upload, relative image paths are rewritten to `raw.githubusercontent.com` URLs (`GITHUB_REPO` + `GITHUB_BRANCH` + `GITHUB_DOCS_ROOT`). These only render if the repo is **public** — private-repo raw URLs return 404 to Notion.
- Already-absolute `https://` image URLs pass through unchanged.

---

## GitHub Actions (optional)

The workflow at `.github/workflows/notion-sync.yaml` is **disabled by default** (push trigger removed). It will not run automatically.

To trigger it manually: **Actions** → **Sync docs to Notion** → **Run workflow**. Use the dry run toggle to preview without writing.

To re-enable automatic triggering, add a `push:` trigger back to the workflow file. See the file for the commented-out example.
