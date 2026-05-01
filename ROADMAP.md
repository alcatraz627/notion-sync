# notion-sync — Roadmap

> Items are ordered by priority within each tier. Tier 1 = currently planned for v1.1; Tier 2 = follow-ups landing after Tier 1; V2 shelf = deferred until a major version. Current version: **1.1.0** (in progress).

Background design docs:
- [`DASHBOARDS-AND-ORCHESTRATION-EXPLORATION.md`](DASHBOARDS-AND-ORCHESTRATION-EXPLORATION.md) — full options analysis behind D1–D7, O1–O4
- [`NAV-STRUCTURE-EXPLORATION.md`](NAV-STRUCTURE-EXPLORATION.md) — alternatives to the deep-nested page tree
- [`RCA-ARCHIVED-PAGES.md`](RCA-ARCHIVED-PAGES.md) — post-mortem to consult before touching `getOrCreateChildPage` / `listChildPages`
- [`SUSPICION-RULES.md`](SUSPICION-RULES.md) — full reference for WAF / size suspicion rules

---

## Tier 1 — v1.1 (now, in execution order)

### D1 — Sitemap page

A `🗺️ Sitemap` page at the docs root. Column-laid-out terse tree with mention pills as leaves. Regenerated on every sync.

- **Surface**: new subcommand `bash list.sh sitemap`; later, a phase in `bash run.sh dashboard`.
- **Config**: `NOTION_SITEMAP_PAGE_ID` env var (auto-creates if absent at root).
- **Effort**: ~1 day. **Risk**: low.
- **Dep**: reads `.notion-cache.json` or `pageIdMap`.

### D2 — Tag index page (with frontmatter `tags:`)

`tags: [foo, bar]` in frontmatter → tags appear as `Tags: #foo #bar` in the meta banner so Notion's full-text search picks them up. Plus a `🏷️ Tags` page rendering every tag with mentions of pages that carry it.

- **Surface**: parser change in `index.ts` (`parseFrontmatter` reads `tags`) + new dashboard phase.
- **Effort**: ~½ day. **Risk**: low.

### D4 — Sidecar Index database

A `📇 Doc Index` Notion database under the docs root. One row per leaf doc, with properties: `title`, `path`, `section`, `tags` (multi_select), `last_synced`, `body_chars`, `→ Page` (mention). Existing tree intact; the database is purely an alternate view.

- **Surface**: new subcommand `bash list.sh index-db`; later a pipeline phase.
- **Config**: `NOTION_INDEX_DB_ID` env var.
- **Effort**: ~2 days. **Risk**: medium — first time we touch the database CRUD APIs.

### O2 — `bash run.sh` launcher with named modes

```bash
bash run.sh                  # interactive — wizard picks mode
bash run.sh push             # = today's sync.sh
bash run.sh push:full        # sync + fetch + diff + recent-errors + sitemap refresh
bash run.sh fix              # fix-mentions + recent-errors
bash run.sh check            # read-only: fetch + diff + recent-errors
bash run.sh dashboard        # refresh sitemap + tag-index + recent-feed (+ index-db)
bash run.sh bring-up         # full first-time sequence
```

`sync.sh` and `list.sh` stay around as low-level building blocks. README + USAGE.md updated to make `run.sh` the documented primary.

- **Effort**: ~1 day. **Risk**: low — pure bash glue.

### O3 — Justfile

A `Justfile` mirroring `run.sh` modes for users with `just` installed. Cheap to ship, gives `just --list` discoverability.

- **Effort**: ~½ day. **Risk**: low.

---

## Tier 2 — follow-up (after Tier 1)

### D5 — Recent changes feed

A `📣 Recently Synced` page rendered from `runs.jsonl` per-page entries. Last 50 syncs sorted desc.

- **Effort**: ~½ day. **Dep**: existing `runs.jsonl` data.

### D7 — Backlinks per page

For each leaf, append a "← Linked from" callout listing pages that reference it. Computed by inverting the link graph during Phase 2.

- **Effort**: ~1.5 days. **Risk**: medium — visual noise on hot pages with 30+ inbound links.

---

## V2 shelf — deferred (future major version)

These are tracked so they don't get lost, but won't ship in v1.x:

### D3 — Native multi-select tags (page → DB row migration)

Promote tags to a real Notion property by migrating leaf pages into a database. Replaced for v1 by D4 (sidecar Index DB), which gets the same filtering without migration risk.

### D6 — Health / status page

`🩺 Sync Status` page rendering last run id, error count, image cache size, last 3 errored paths. Mostly redundant with `bash list.sh recent-errors` for solo use; earns its keep only with collaborators.

### O4 — Unified TypeScript CLI (`bun cli …`)

Consolidate `sync.sh` / `list.sh` / `run.sh` into a single TS entrypoint with subcommands. Larger refactor; gains structured output and type safety. Defer until the bash glue actually starts hurting (after Tier 1 + 2 stabilize).

### notion-pull — Notion → local markdown (bidirectional sync)

Walks page block trees, renders to markdown, handles mentions back to `.md` paths, conflict detection vs. local files. ~4-6 days; not v1.x scope.

---

## Known limitations (not roadmap items)

| Limitation | Detail |
|---|---|
| Images in private repos | mitigated by `NOTION_UPLOAD_IMAGES=1` (Notion CDN upload pipeline shipped in v1.0) |
| `is_full_width` has no effect | `NOTION_FULL_WIDTH` env var read but ignored — not exposed by Notion's public REST API |
| Notion rate limit | adaptive linear backoff (350-1050ms); large trees take proportional time |
| `_index.md` icon only | folders without `_index.md` use `NOTION_FOLDER_ICON` default |

---

## Done — v1.0 (shipped)

(History; details in commit log.)

| Feature                                         | Doc / module                                  | Commit-ish              |
| ----------------------------------------------- | --------------------------------------------- | ----------------------- |
| Native Notion mentions                          | `mention-converter.ts` + USAGE.md §8          | `f4267e0` / `cf39327`   |
| Image upload to Notion CDN                      | `image-uploader.ts` + USAGE.md §7             | (multi-commit)          |
| CLI progress bar + adaptive backoff              | `index.ts` (renderProgress)                   | (multi-commit)          |
| `notion-diff` (path-based comparator)            | `compare-apr-30-1/`                            | `0115c3a`               |
| Audit logging (partial run logs, image_stats, recent-errors) | CLAUDE.md §Diagnosing runs            | `ce13a5e`               |
| Suspicion rules reference                        | `SUSPICION-RULES.md`                           | (in v1.0)               |
| README + architecture diagram                    | `README.md`                                    | (in v1.0)               |
| RCA: archived-page cascade                       | `RCA-ARCHIVED-PAGES.md`                        | `41df668`               |
| Nav-structure exploration                        | `NAV-STRUCTURE-EXPLORATION.md`                 | `24f7abe`               |
| Dashboards + orchestration exploration           | `DASHBOARDS-AND-ORCHESTRATION-EXPLORATION.md`  | `cf8dae9`               |
