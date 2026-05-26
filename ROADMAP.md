# notion-sync — Roadmap

> Current version: **1.3.0**. Items are ordered by priority within each tier.

Background design docs:
- [`DASHBOARDS-AND-ORCHESTRATION-EXPLORATION.md`](DASHBOARDS-AND-ORCHESTRATION-EXPLORATION.md) — full options analysis behind D1–D7, O1–O4
- [`OVERWRITE-GUARDRAILS-EXPLORATION.md`](OVERWRITE-GUARDRAILS-EXPLORATION.md) — design + research behind the guardrails feature
- [`RECONCILIATION-EXPLORATION.md`](RECONCILIATION-EXPLORATION.md) — design behind the reconcile flow
- [`SHARED-LIB-EXPLORATION.md`](SHARED-LIB-EXPLORATION.md) — the `lib/` extraction plan
- [`NAV-STRUCTURE-EXPLORATION.md`](NAV-STRUCTURE-EXPLORATION.md) — alternatives to the deep-nested page tree
- [`RCA-ARCHIVED-PAGES.md`](RCA-ARCHIVED-PAGES.md) — post-mortem to consult before touching `getOrCreateChildPage` / `listChildPages`
- [`SUSPICION-RULES.md`](SUSPICION-RULES.md) — full reference for WAF / size suspicion rules

---

## v1.3 — shipped

### Overwrite guardrails + reconcile

Pages a human edited in Notion are no longer silently overwritten. `sync-state.ts` records a per-page baseline (`last_pushed_edited_time` / block count) and a cached bot id; Phase 1.7 compares `last_edited_by`/time and **protects** pages diverged by a non-bot editor (`NOTION_GUARDRAILS=strict|warn|off`). `reconcile.ts` (`bash sync.sh reconcile`) is the interactive resolver — accept-local, keep-remote, or a 3-way browser diff. See `OVERWRITE-GUARDRAILS-EXPLORATION.md` / `RECONCILIATION-EXPLORATION.md`.

### `diff-content` — three-way content diff

`bash list.sh diff-content` renders a BASE/LOCAL/REMOTE diff to an HTML report served in a browser (list/tree toggle, search, char-level toggle, raw/rendered). BASE = the snapshot taken at last push (`.notion-snapshots.<key>/`). `--force` refetches; report caches to `.notion-diff-cache.<key>.json`.

### Resumable runs

`progress-ledger.ts` records each completed doc to `.notion-sync-progress.<key>.json`; an interrupted run continues with `bash sync.sh --resume`, skipping docs already written (Phase 1 discovery still re-runs fully). Guardrail baselines now flush per-doc so a crash can't lose them.

### Root-keyed state + `lib/` extraction

All state files are keyed by `NOTION_ROOT_PAGE_ID` (`getCacheKey()`), so switching roots isolates cache/state/snapshots/ledger; legacy unkeyed files auto-migrate. Shared helpers extracted to `lib/colors.ts`, `lib/notion.ts`, `lib/retry.ts`, `lib/env.ts`; title-variant matching to `title-match.ts`. fix-mentions now skips link-free docs and no longer double-walks subpages. Comprehensive unit-test suite added (`bun test`).

---

## v1.2 — shipped 2026-05-02

### Rename-safety (#25)

The pipeline now tolerates H1 changes, file moves, and folder renames without orphaning pages or breaking inbound mentions. Three pieces:

1. **Title update on existing page.** `updatePageMeta` now accepts a `title?` and includes it in `pages.update` whenever an H1 changes. Prevents the previous-page-orphans-when-H1-changes failure mode.
2. **Move detection.** A `globalTitleIndex` is built at preflight from `.notion-cache.json`. When `getOrCreateChildPage` doesn't find a title under the current parent but finds it elsewhere in the tree (and the title is unique), it calls `pages.update({parent: {page_id: newParent}})` to MOVE the existing page. Preserves page id and inbound mentions.
3. **`bash run.sh prune` mode.** Lists Notion pages with no matching local title (orphans). Dry-run by default; `bash list.sh prune --apply` archives them.

Run `bash list.sh fetch` to refresh the cache before a sync if you expect renames/moves — move-detection consults the cache, not live Notion.

### D6 — 🩺 Sync Status page

Renders the latest `runs.jsonl` entry to a Notion page: color-coded health callout, key stats (created/updated/errors/timing/image cache), last 10 errors with quick-retry hint, strip of the last 6 runs. Auto-refreshes via `bash run.sh dashboard`. Useful for collaborators who want at-a-glance health without grepping `runs.jsonl`.

### D3 — closed (substituted by D4)

D3 was originally to migrate every leaf page into a Notion database for native `multi_select` tag filtering. After review: **D4 (sidecar Index DB) provides every leaf doc as a queryable row with `Tags` (multi_select), plus a `Page` mention back to the source page.** This gives identical filter/sort/group views without the ~5-day migration cost, the risk of breaking inbound mentions on every doc, or the ongoing overhead of treating leaf pages as DB rows for content writes. Tags-as-text in the meta banner (D2) gives full-text search on actual leaf pages. **Together D2 + D4 deliver D3's intent at <½ the cost.** No code change for D3 itself; this is a roadmap close-out.

---

## v1.1 — shipped 2026-05-01

| Feature                                          | Doc / module                                  | Commit          |
| ------------------------------------------------ | --------------------------------------------- | --------------- |
| D1 — 🗺️ Sitemap dashboard                       | `sitemap.ts`                                  | `f7d6810`       |
| D2 — 🏷️ Tag index + frontmatter `tags:`         | `tag-index.ts`, `index.ts` extractTags        | `9e01bd3`       |
| D4 — 📇 Doc Index sidecar database               | `index-db.ts`                                 | `d692cd6`       |
| D5 — 📣 Recently Synced feed                     | `recent-feed.ts`                              | `d0620f7`       |
| D7 — 🔗 Backlinks per page                       | `backlinks.ts`                                | `a4d7d66`       |
| O2 — `bash run.sh` pipeline launcher             | `run.sh`                                      | `44d5717`       |
| O3 — Justfile mirror                             | `Justfile`                                    | `ef93fd7`       |
| Mention-coverage fix (`.md` text-hijack bug)     | `index.ts` rewriteLinks                        | `cd1db4b`       |
| Audit logging hardening (partial run logs etc.) | `index.ts`                                     | `ce13a5e`       |
| RCA + design docs (NAV / DASHBOARD / SUSPICION)   | various                                        | (multi)         |

---

## V2 shelf — deferred (future major version)

Items here are tracked but won't ship in v1.x.

### O4 — Unified TypeScript CLI (`bun cli …`)

Consolidate `sync.sh` / `list.sh` / `run.sh` into a single TS entrypoint with subcommands. Larger refactor; gains structured output and type safety. Defer until the bash glue actually starts hurting.

### notion-pull — Notion → local markdown (bidirectional)

Walks page block trees, renders to markdown, handles mentions back to `.md` paths, conflict detection vs. local files. ~4-6 days; not v1.x scope.

### Optional D3-real if D4 isn't enough

If the sidecar DB pattern fails to satisfy "I want native page-properties on the actual leaf pages", D3 remains an option — but only as a major-version migration with a careful rollback plan. Don't pick this up speculatively.

---

## Known limitations (not roadmap items)

| Limitation | Detail |
|---|---|
| Images in private repos | mitigated by `NOTION_UPLOAD_IMAGES=1` (Notion CDN upload pipeline shipped in v1.0) |
| `is_full_width` has no effect | Confirmed unfixable: Notion's v1 API rejects every shape. Toggle per-page in the Notion UI; D4 sidecar DB renders wide. |
| Anchor links (`foo.md#section`) | Notion doesn't navigate to fragment anchors (platform limitation). In-page `#heading` anchors are also dropped when a block is rewritten — Notion rejects scheme-less URLs on `blocks.update`, so `mention-converter.ts` strips them (keeps the text). |
| Notion rate limit | adaptive linear backoff (350-1050ms); large trees take proportional time |

---

## Done — v1.0 (shipped earlier)

(History; details in commit log.)

| Feature                                         | Module                                       |
| ----------------------------------------------- | -------------------------------------------- |
| Native Notion mentions                          | `mention-converter.ts`                       |
| Image upload to Notion CDN                      | `image-uploader.ts`                          |
| CLI progress bar + adaptive backoff              | `index.ts` (renderProgress)                  |
| `notion-diff` (path-based comparator)            | `compare-apr-30-1/`                           |
| Suspicion rules reference                        | `SUSPICION-RULES.md`                         |
| README + architecture diagram                    | `README.md`                                  |
| RCA: archived-page cascade                       | `RCA-ARCHIVED-PAGES.md`                      |
| Nav-structure exploration                        | `NAV-STRUCTURE-EXPLORATION.md`               |
| Dashboards + orchestration exploration           | `DASHBOARDS-AND-ORCHESTRATION-EXPLORATION.md` |
