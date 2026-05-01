# notion-sync — usage guide

This guide is task-oriented: each section answers a "how do I…" question. For first-time setup of the Notion integration, see [SETUP.md](SETUP.md). For architectural notes (Claude context, key files, two-phase design), see [CLAUDE.md](CLAUDE.md).

> **Tools at a glance**
> - `bash sync.sh` — push local markdown → Notion (the main thing)
> - `bash list.sh` — read remote Notion tree, diff against local, batch-fix
> - `bash sync.sh --fix-mentions` — convert internal links → native page mentions on already-synced pages
> - All commands accept `-h` for inline help.

---

## Table of contents

1. [Daily sync workflow](#1-daily-sync-workflow)
2. [Selective sync](#2-selective-sync)
3. [Dry-run preview](#3-dry-run-preview)
4. [Verifying remote state](#4-verifying-remote-state)
5. [Comparing local vs remote](#5-comparing-local-vs-remote)
6. [Fixing failures](#6-fixing-failures)
7. [Image uploads for private repos](#7-image-uploads-for-private-repos)
8. [Internal links → page mentions](#8-internal-links--page-mentions)
9. [Reading the run log](#9-reading-the-run-log)
10. [Diagnosing failures](#10-diagnosing-failures)
11. [Performance tuning](#11-performance-tuning)
12. [Recipes & full command reference](#12-recipes--full-command-reference)

---

## 1. Daily sync workflow

```bash
bash sync.sh
```

Launches the **interactive wizard**. Prompts in order:

| # | Question | Default | Purpose |
|---|----------|---------|---------|
| 1 | Mode (sync / fix-mentions) | sync | What to do |
| 2 | Dry run? | No (live sync) | Preview without writing |
| 3 | Section filter | last selection | Limit to specific sections; blank = all |
| 4 | Upload images to Notion CDN? | Yes | Required for private repos |
| 5 | Convert links to mentions? | Yes | Inline pills vs new-tab links |
| 6 | Verbose output? | No (progress bar) | Per-file detail vs animated bar |
| 7 | Show metadata banner? | Yes | Frontmatter banner on each page |
| 8 | Link mode | notion | How to rewrite `.md` links between docs |
| 9 | Abort policy | disabled | Stop early after N consecutive errors |

Selections save to `.sync-defaults.json` (gitignored) — re-runs remember.

When the run finishes you'll see a macOS notification banner with stats (or a styled terminal line if not on macOS).

### Skip the wizard (use saved defaults)

```bash
bash sync.sh --no-wizard
```

Useful in scripts/CI or when you've already settled on your defaults.

---

## 2. Selective sync

### One section
```bash
bash sync.sh --only known-pitfalls
```

### Multiple sections
```bash
bash sync.sh --only jobs admin workflows
```

### One file (by stem)
```bash
bash sync.sh --only create-scraper
```

The filter matches against any path component or filename stem, so `create-scraper` matches `product/jobs/create-scraper.md`.

### Combined with other flags
```bash
bash sync.sh --no-wizard --only product --verbose
```

> **Filter trap to avoid**: in the wizard, picking *every* section in the multi-select isn't the same as picking nothing. The filter list excludes root-level files like `structure.md` because they don't prefix-match any section name. If you want everything synced, leave the filter blank.

---

## 3. Dry-run preview

Show what *would* happen without touching Notion:

```bash
bash sync.sh --dry-run
# or via wizard, answer Yes to "Dry run?"
```

Dry-run still walks the docs tree, builds the page-id map (using cached values where present), and prints every file the live sync would update — including title, icon, image count, and any unresolved-link warnings.

---

## 4. Verifying remote state

### Render the remote tree

```bash
bash list.sh show
```

Shows every Notion page under your root, grouped by section, with block counts and inline emoji icons. **No API calls** — reads `.notion-cache.json` (gitignored).

```bash
bash list.sh show --max-depth 2     # collapse beyond depth 2
bash list.sh show --empty-only      # only pages with 0 content blocks
```

If `.notion-cache.json` doesn't exist, `show` (and `diff`) auto-trigger a `fetch` first.

### Refresh the cache

```bash
bash list.sh fetch              # full walk, ~6 min for ~300 pages
bash list.sh fetch --no-icons   # skip per-page icon fetch (~3 min faster)
```

Crash-safe: SIGINT or a network failure mid-fetch saves a partial cache (with `partial: true`) so you can inspect what was retrieved before the abort.

---

## 5. Comparing local vs remote

```bash
bash list.sh diff
```

Reports three categories:

- **Remote-only** — Notion pages with no matching local title (often section pages with capitalized titles)
- **Empty remote pages** — pages where `block_count === 0` (sync was started but content write failed)
- **Local-only** — local docs with no remote counterpart yet

### Path-based comparison (more accurate)

The title-based diff above is brittle for section pages. For a stricter comparison, use the one-off comparator:

```bash
bun compare-apr-30-1/compare.ts
cat compare-apr-30-1/05-summary.txt
```

This walks Notion via `parent_id` chains and matches against local relative paths. Output goes to `compare-apr-30-1/` (see that folder's README for details).

### Mass-retry empty pages

```bash
bash sync.sh --no-wizard --only $(bash list.sh empty-paths)
```

`empty-paths` prints `--only`-friendly local paths whose remote counterpart is empty. Shell substitution feeds them straight to `sync.sh`. Exits non-zero if there's nothing to retry, so the wrapping `--only` doesn't get an empty arg list.

---

## 6. Fixing failures

After any run, transient API failures (502, timeouts) get a **retry pass** with up to 3 attempts each (commit `16e7eec`). If something still fails after that, target it directly:

```bash
# By section
bash sync.sh --no-wizard --only credits modals

# By file
bash sync.sh --no-wizard --only create-scraper
```

The retry uses **adaptive linear backoff** — rate limit widens on each failure (350ms → 1050ms in 3 steps), narrows after 3 consecutive successes. So a re-run after a string of failures starts with a calmer cadence.

### Recover from a "Can't edit block that is archived" error

This was a major bug, fixed in commit `83c9f41`. If you see it now, you're probably on a stale checkout — pull latest and re-run. Long story: Notion's `replace_content` with `allow_deleting_content: true` deleted child_page subpages. Fixed via list-blocks → delete-prose-only → `insert_content`.

---

## 7. Image uploads for private repos

```bash
# In .env
NOTION_UPLOAD_IMAGES=1
```

Required for **private** GitHub repos: `raw.githubusercontent.com` URLs return 404 to Notion, so images don't render. Enabling this:

1. Hashes each local image file (sha256)
2. Uploads new images via the Notion v5 fileUploads API
3. Caches `sha256 → file_upload_id` in `.notion-image-cache.json` (gitignored)
4. After Phase 2 writes a page's content, walks its blocks and swaps image type from `external` → `file_upload`

Free benefits:
- **Re-runs use cache** — image not re-uploaded on subsequent syncs
- **Renames are free** — same bytes hash to the same key
- **Edits trigger re-upload** — different hash → fresh upload

Cost on first full sync: ~2 API calls × N new images. For ~50 images that's ~70 seconds extra. Subsequent runs: 0 extra calls (all cache hits).

### Orphan cleanup (TODO)

Edited images leave their old `file_upload_id` orphaned on Notion's CDN. A scheduled remote agent at `2026-05-14T09:00:00Z` (routine `trig_01APt3L4CvbXfbrKCSboqVKW`) will add a `bash list.sh prune-images` command to clean them up. Until then, orphans accumulate harmlessly (Notion Pro has unlimited storage).

---

## 8. Internal links → page mentions

By default, after a page's content is written, internal markdown links (e.g. `[See foo](https://www.notion.so/<id>)` pointing at one of our synced pages) are converted to **native page mentions** — inline pills with hover preview, side-peek navigation, and auto-updating titles.

Disabled via:
```bash
NOTION_USE_MENTIONS=0    # in .env
```

### Retroactively fix already-synced pages

If you synced before the mention-converter shipped (commit `a9be20d`), those pages still have regular hyperlinks. Run the standalone:

```bash
bash list.sh fix-mentions
# or via wizard:
bash sync.sh        # → pick "fix-mentions" mode
```

Reads `.notion-cache.json`, walks every page's blocks, rewrites `text.link.url` → `mention.page.id` for any URL pointing at one of our pages. Idempotent — safe to re-run, no-op on already-converted blocks.

### Tradeoff to know about

A mention always displays the **linked page's current title** — not the original markdown anchor text. So `[click here](url-to-Foo-Doc)` becomes `Foo Doc` after conversion. For doc-link writing where anchor matches title, that's an upgrade. For "click here" style anchors, it changes wording. If that's not what you want, set `NOTION_USE_MENTIONS=0`.

---

## 9. Reading the run log

Every sync appends a JSONL entry to `runs.jsonl` (gitignored). Each line is a complete record:

```bash
# Latest run summary
tail -1 runs.jsonl | python3 -m json.tool

# Just the stats from latest run
tail -1 runs.jsonl | python3 -c "import sys,json; print(json.loads(sys.stdin.readline())['stats'])"

# Find a run by ID
grep '"run_id":"20260501-001544"' runs.jsonl | python3 -m json.tool

# All runs with errors
grep '"errors":[1-9]' runs.jsonl | wc -l
```

### Key fields per entry

| Field | Use |
|---|---|
| `run_id` | `YYYYMMDD-HHmmss` — for cross-reference |
| `config` | Full snapshot of every setting active during the run |
| `stats` | `{total, created, updated, errors, sections_written, aborted}` |
| `timing` | `{phase1_ms, phase2_ms, total_ms}` |
| `error_summary` | `[{path, error, suspicions}]` — quickest failure overview |
| `pages` | Per-file results: status, elapsed, content_chars |
| `sections` | Phase 1.5 results: `{rel_dir, content_written, error?}` |

### Long-term notes

After analyzing a notable run, append findings to `run-notes.md`. Newest first; include the `run_id` and what fixed it.

---

## 10. Diagnosing failures

### Built-in suspicion rules

For server-side rejections (5xx, WAF blocks), the script auto-checks the markdown body against a set of patterns:

| Rule | Trigger |
|---|---|
| `cloudflare-waf-curl` | `curl` + `localhost`/IP in same line outside fenced code |
| `cloudflare-waf-shell-pipe` | Shell pipe in inline code (command-injection signature) |
| `cloudflare-waf-sql-keyword` | SQL keywords (SELECT/DROP) in prose |
| `cloudflare-waf-script-tag` | `<script>` in markdown — always blocked |
| `notion-body-too-large` | File body > 500 KB |

Findings appear in the per-file error log AND in `runs.jsonl`'s `error_summary[].suspicions`.

### Common failure patterns

| Symptom | Likely cause | Fix |
|---|---|---|
| "Can't edit block that is archived" | Old code, archived-block bug | Pull latest (commit `83c9f41`+) |
| "Request to Notion API failed with status: 502" | Cloudflare gateway blip | Retry pass handles it; if it survives 3 retries, run again |
| "Request to Notion API has timed out" | Slow page or transient network | Same as above |
| `[link] unresolved: ...` warnings | Doc link target not in pageIdMap | Sync the missing dir/file too, OR check that the path is valid |
| Image broken in Notion | Private repo, `NOTION_UPLOAD_IMAGES=0` | Set to `1` and re-sync |
| Internal link opens new tab | `NOTION_USE_MENTIONS=0`, OR page synced before that feature shipped | Run `bash list.sh fix-mentions` |

### When the wizard config is the problem

The single biggest source of "missed files" historically: the saved filter in `.sync-defaults.json` quietly scoping to a subset. Diagnose:

```bash
cat .sync-defaults.json
```

If you see `"filter": "create-scraper"` (or similar), that's why your "full sync" wasn't full. Edit to `"filter": ""` or re-run the wizard and clear the multi-select.

---

## 11. Performance tuning

### Rate limit (adaptive)

The script defaults to 350ms between API calls (~2.85 req/s, under Notion's 3 req/s cap). On any API failure the rate widens by ~233ms (max 1050ms = 3× floor); after 3 consecutive successes it narrows back. Linear, not exponential — a single transient blip doesn't slingshot the rate to the ceiling for the rest of the run.

No env knob — this is intentional, controlled at the floor/ceiling/step constants in `index.ts`.

### Abort policy

Stop early on consecutive errors:

```bash
ABORT_POLICY=5   # stop if 5+ failures in last 10 items
```

Or pick interactively in the wizard. Disabled by default (collect every error, finish the run).

### Verbose vs progress bar

```bash
bash sync.sh --verbose            # per-file detail
bash sync.sh                      # animated progress bar (default)
```

Verbose is useful for debugging individual file issues. Progress bar is better for unattended runs (it fits in a single terminal line).

### Skip image upload + mentions for fast smoke tests

```bash
NOTION_UPLOAD_IMAGES=0 NOTION_USE_MENTIONS=0 bash sync.sh --only known-pitfalls
```

Drops Phase 2 per-page time from ~14s to ~5s. Useful for testing structural changes before a full sync.

---

## 12. Recipes & full command reference

### Common workflows

```bash
# === First sync after a long time ===
bash list.sh fetch                        # snapshot remote
bun compare-apr-30-1/compare.ts           # see what's missing/extra
bash sync.sh                              # full sync (wizard)
bash list.sh fix-mentions                 # convert links → mentions on legacy pages

# === Daily small change ===
bash sync.sh --no-wizard --only product/jobs/create-scraper

# === Mop up failures from a previous run ===
tail -1 runs.jsonl | python3 -c "import sys,json; d=json.loads(sys.stdin.readline()); [print(e['path']) for e in d.get('error_summary',[]) or []]"
# pipe that list into:
bash sync.sh --no-wizard --only $(...)

# === Verify a single page in browser after sync ===
tail -1 runs.jsonl | python3 -c "
import sys, json
d = json.loads(sys.stdin.readline())
for p in d.get('pages',[])[:5]:
    print(p.get('notion_url',''))"
```

### `sync.sh` flags

| Flag | Effect |
|------|--------|
| `-h, --help` | Show inline help |
| `--no-wizard` | Skip wizard, use saved defaults |
| `--dry-run` | Preview without writing |
| `--only <X> [Y...]` | Filter to specific section/file stems |
| `--verbose` | Per-file output |
| `--fix-mentions` | Skip sync, run mention-converter on cached pages |

### `list.sh` subcommands

| Subcommand | Effect |
|------------|--------|
| `show` (default) | Render cached tree |
| `show --max-depth N` | Collapse beyond depth N |
| `show --empty-only` | Only pages with 0 blocks |
| `fetch` | Force re-fetch from Notion |
| `fetch --no-icons` | Faster fetch, skip per-page icon retrieval |
| `diff` | Title-based comparison vs local docs |
| `empty-paths` | Print local paths for empty remote pages (for shell substitution) |
| `fix-mentions` | Walk every cached page, convert internal links → mentions |

### `.env` essentials

```bash
NOTION_TOKEN=secret_...                  # required
NOTION_ROOT_PAGE_ID=https://www.notion.so/...  # required, can be ID or URL
DOCS_DIR=/abs/path/to/your/docs          # required if not ./docs

GITHUB_REPO=owner/repo                   # for link fallbacks + image URLs
GITHUB_BRANCH=main                       # default: development
GITHUB_DOCS_ROOT=frontend/docs           # repo-relative path
GITHUB_DOC_SOURCE_URL_BASE=...           # optional override for "View source" link

NOTION_LINK_MODE=notion                  # notion | github | strip
NOTION_UPLOAD_IMAGES=1                   # private-repo image hosting
NOTION_USE_MENTIONS=1                    # internal links → mentions (default ON)
NOTION_SHOW_META=1                       # frontmatter banner (default ON)
NOTION_PAGE_ICON=📄                      # default emoji for icon-less pages
NOTION_FOLDER_ICON=📁                    # default emoji for sections
```

Full env reference: see `.env.example`.

---

## See also

- [SETUP.md](SETUP.md) — first-time Notion integration setup
- [CLAUDE.md](CLAUDE.md) — architectural notes for AI coding sessions
- [run-notes.md](run-notes.md) — long-term log of notable runs and findings
- [ROADMAP.md](ROADMAP.md) — planned features
- [`~/.claude/code/terminal-tooling-notion-sync.md`](~/.claude/code/terminal-tooling-notion-sync.md) — reusable CLI patterns extracted from this project
