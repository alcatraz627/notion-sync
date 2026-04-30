# Notion ↔ Local Docs Comparison — Apr 30, 2026 (run 1)

One-off audit checking whether every local markdown doc has a populated Notion page.

## TL;DR

**8 docs missing on Notion**, 0 extras, 0 thin pages. Caused by a `--only` filter
configuration in the most recent full sync that excluded root-level files plus
folders whose only content was an `_index.md`. See `05-summary.txt` for the
exact list and the fix below.

## Files in this folder

| File | What it is | How produced |
|---|---|---|
| `README.md` | This file | Hand-written |
| `01-notion-cache.json` | Snapshot of remote Notion state at the moment of analysis (296 pages, fetched 2026-04-30T14:53Z). Frozen so re-running `compare.ts` later still produces the same diff against the same remote state. | `cp ../.notion-cache.json` (after `bash list.sh fetch`) |
| `02-title-diff.txt` | Quick title-only diff from the existing `notion-list diff` command. Brittle because section titles in Notion (`Frontend`) don't match local `_index.md` headings (`BTS — Frontend (engineering index)`). Kept for cross-reference. | `bash list.sh diff > 02-title-diff.txt` |
| `03-empty-pages.txt` | Tree view of any Notion pages with `block_count === 0`. Currently empty — every Notion page has at least one block. | `bash list.sh show --empty-only > 03-empty-pages.txt` |
| `compare.ts` | The path-based comparator. **Not a persistent CLI command** — single-purpose script for this audit. Walks Notion via `parent_id` chains to compute path-from-root, walks `docs/` for relative paths, joins on normalized segments, then handles the asymmetries (root `_index.md` ↔ root page, local dirs without `_index.md` ↔ Notion auto-index pages, leaf docs whose Notion title differs from the filename). | Hand-written |
| `04-path-diff.json` | Structured comparison output. Contains four arrays: `matched`, `missing_on_remote`, `extra_on_remote`, `thin_remote_pages`. Includes `block_count` and `local_chars` for every entry so you can audit the matching logic. | `bun compare.ts` |
| `05-summary.txt` | Human-readable summary of `04-path-diff.json`. Read this first. | `bun compare.ts` |

## How to re-run

```bash
# 1. Refresh the remote cache (5–7 min for ~300 pages)
bash list.sh fetch --no-icons

# 2. Snapshot to this folder (so the analysis is reproducible)
cp .notion-cache.json compare-apr-30-1/01-notion-cache.json

# 3. Re-generate text views of the cache
bash list.sh diff > compare-apr-30-1/02-title-diff.txt
bash list.sh show --empty-only > compare-apr-30-1/03-empty-pages.txt

# 4. Re-run the comparator
bun compare-apr-30-1/compare.ts

# 5. Inspect
cat compare-apr-30-1/05-summary.txt
```

## Method notes

**Path normalization** — every path segment is normalized via `lower → spaces-to-hyphens → strip-non-alnum-hyphen` before comparison. This handles:
- `boring-technical-stuff` (local) vs `Boring-technical-stuff` (Notion title from dir name)
- `card.md` (local filename) vs `Card — Content Container Component` (local `# heading`, used as Notion title)

**Three match strategies, in order**:
1. Full normalized path equality (`boring-technical-stuff/frontend/ui-widgets/primitives/card-content-container-component`)
2. Parent path + local `# heading` matches a Notion page in the same parent
3. Parent path + local filename stem matches a Notion page in the same parent

**Asymmetries handled**:
- Local root `_index.md` matches the Notion *root page itself* (not a sibling)
- Local directories without `_index.md` match Notion *auto-index section pages* (sync creates these even when there's no `_index.md` to source from)

**Thin-page heuristic** — `block_count / max(1, chars / 300) < 0.3` flags pages where Notion has dramatically less content than the local file would suggest. Currently zero hits on the cache; rule retained for future regressions.

## Findings + cause

The 8 missing docs split into two groups:

### Group A — root-level files (2): `structure.md`, `product-todos.md`
- **Cause**: the most recent full live sync (`runs.jsonl` entry `2026-04-30T00:11:38`) had `filter: ["boring-technical-stuff", "conventions", ...all 11 top-level dirs]`. When `--only` lists every dir individually, root-level files don't prefix-match any of them and `shouldSync()` excludes them silently.
- **Local UX bug**: the wizard wrote all 11 dirs into the filter when the user picked "all sections" — that should have been equivalent to no filter.
- **Workaround for now**: `bash sync.sh --only structure product-todos` (the filter accepts basenames too).
- **Real fix**: in `sync.sh`, when `CHOSEN_FILTER` is the full set of section dirs, treat it as no filter (or in `index.ts` `shouldSync`, treat root-level files as always included when no explicit `--only` was passed for them).

### Group B — index-only folders (6): `auth`, `widgets-v2`, `flows`, `tooling`, `workers`, `observability`
All under `boring-technical-stuff/`. Each has a local `_index.md` and no other content (no leaf files, no subdirs).
- **Cause**: the older `discoverTree` had `if (collectFiles(subTree).filter(shouldSync).length === 0) continue;` — folders whose only content was an `_index.md` were skipped entirely.
- **Status**: fix already shipped (commit `aca3bec`, "feat: verbose Phase 1 log shows index, timestamp, and local path per entry") — `discoverTree` now includes folders with only `_index.md`. **But no full sync has run since the fix.** Re-running sync will create these section pages.

## Recommended next action

```bash
# Catches both groups in one run:
bash sync.sh --no-wizard
```

The current `.sync-defaults.json` has `filter: "boring-technical-stuff conventions ... workflows"` (the bad config). Either edit that file to set `"filter": ""`, or re-run the wizard and clear the filter selection.
