# notion-sync — Claude Context

## What this is

A **standalone Node.js script** (`index.ts`) that pushes markdown files from `docs/product/**` to Notion. It has its own `package.json`, `node_modules`, and `tsconfig.json`.

**It is not part of the Next.js frontend app.** Do not import from it, build it with Next.js, or treat it as part of the frontend dependency tree. Nothing in `src/` references it. It runs completely independently.

## Running

```bash
bash sync.sh              # local run (reads .env)
bash sync.sh --dry-run    # preview only, no Notion writes
bash sync.sh --only jobs  # filter to one section
```

Or manually: `node_modules/.bin/tsx index.ts [--only ...]`

## Key files

| File           | Purpose                                         |
| -------------- | ----------------------------------------------- |
| `index.ts`     | Entire sync logic — types, config, API calls    |
| `sync.sh`      | Local runner: loads `.env`, installs deps, runs |
| `.env`         | Local credentials (not committed)               |
| `.env.example` | Template for `.env`                             |
| `SETUP.md`     | One-time Notion integration setup guide         |
| `runs.jsonl`   | Append-only log of every sync run               |

## Architecture — two-phase sync

**Phase 1 (discovery):** Walks all `.md` files, calls `getOrCreateChildPage` for each, builds `pageIdMap: Map<relPath, pageId>`.

**Phase 2 (content):** Walks the same files, calls `rewriteLinks` (uses `pageIdMap` to resolve `.md` links → Notion URLs), then `updateMarkdown` to push content.

The two-phase design is necessary: phase 2 needs all page IDs upfront so cross-file links can resolve correctly, even across sections.

## Environment variables

| Variable              | Required | Description                                         |
| --------------------- | -------- | --------------------------------------------------- |
| `NOTION_TOKEN`        | yes      | Integration secret (`secret_...` or `ntn_...`)      |
| `NOTION_ROOT_PAGE_ID` | yes      | Root page ID or URL                                 |
| `GITHUB_REPO`         | no       | `owner/repo` for GitHub link fallbacks              |
| `GITHUB_BRANCH`       | no       | Branch for GitHub links (default: `development`)    |
| `NOTION_LINK_MODE`    | no       | `notion` (default) \| `github` \| `strip`           |
| `NOTION_PAGE_ICON`    | no       | Default emoji for pages without frontmatter `icon:` |
| `DRY_RUN`             | no       | `1` = preview only                                  |

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
- Rate limit: 350ms sleep after every API call (~3 req/sec)
- Page lookup is by title under parent — no external state file needed

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

### Suspicion rules (built into the script)

| Rule name | What it means |
| --------- | -------------- |
| `cloudflare-waf-curl` | `curl` + `localhost`/IP in request body — Cloudflare SSRF WAF block. Fix: reword to remove the combination outside fenced blocks. |
| `cloudflare-waf-shell-pipe` | Shell pipe pattern in inline code outside a fenced block — command injection WAF signature. |
| `cloudflare-waf-sql-keyword` | SQL keywords (SELECT/DROP/etc.) in prose — ModSecurity rule. |
| `cloudflare-waf-script-tag` | `<script>` tag — always blocked. |
| `notion-body-too-large` | File exceeds 500 KB — Notion markdown body limit. |

### After analysing a run

Append findings to `run-notes.md` — newest entry first, include the `run_id`, date, what happened, and what fixed it (or what to try next). This file is the long-term memory for run patterns.
