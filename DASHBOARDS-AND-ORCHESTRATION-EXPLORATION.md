# Exploration: dashboards, tagging, and pipeline orchestration

> **Status**: design exploration, no shipping code. Three connected questions: (a) what extra surfaces should we render *on Notion itself* (sitemap, tag index, dashboards), (b) how do we get tag-based search/filter working, and (c) given the growing number of subcommands, should the project's *primary* mental model be a pipeline rather than `sync.sh + helpers`. The third question depends on the first two — every new dashboard feature is one more step to sequence.

## 1. Current state

### Surfaces today

| Surface              | Where it lives          | Updated by                   |
| -------------------- | ----------------------- | ---------------------------- |
| Per-page content     | One Notion page per `.md` | `sync.sh`                    |
| Section index pages  | One page per folder      | `sync.sh` Phase 1.5          |
| Page metadata banner | Top of each leaf page    | `sync.sh` (when `SHOW_META=1`) |
| (none)               | A sitemap               | —                            |
| (none)               | Tag index / tag search   | —                            |
| (none)               | Recent-changes feed      | —                            |
| (none)               | Health / status page     | —                            |
| (none)               | Backlinks per page       | —                            |

Five well-known dashboard concepts are completely absent.

### Commands today

```
sync.sh                             # the push
sync.sh --dry-run                   # preview
sync.sh --only X Y                  # filtered push
sync.sh --fix-mentions              # retroactive mentions

list.sh                             # render cached tree
list.sh fetch                       # refresh cache
list.sh diff                        # title-based drift
list.sh empty-paths                 # empty remote pages
list.sh fix-mentions                # standalone retroactive mentions
list.sh recent-errors               # local-log failure scan
```

Nine distinct verbs across two scripts. The user runs ~3-5 of these in a typical workflow. The mental model "sync.sh is primary, list.sh is helpers" is starting to fray — `recent-errors` and `fetch` are now part of the routine loop.

## 2. Pain summary

| Pain                                                          | Today's workaround                                  |
| ------------------------------------------------------------- | --------------------------------------------------- |
| "Where in the docs is X?" — no global map                     | Open Notion sidebar, scroll, click through          |
| "Which docs talk about authentication?" — no tag search       | Use Notion's full-text search; hope text is in body |
| "What changed today?" — no recent feed                        | Read `runs.jsonl` manually                          |
| "Is sync healthy?" — no status page                           | Run `recent-errors` in a terminal                   |
| "Which pages link to this one?" — no backlinks                | Grep `docs/` locally                                |
| "What's the right command order for a full bring-up?"         | Read USAGE.md §Quick recipes                        |
| Wizard prompts vary across `sync.sh`/`list.sh`/etc.            | Memorize each script's flag set                     |

## 3. Part I — Dashboard / discovery features

Each option is independent; they can ship piecemeal.

### Option D1 — Sitemap page (terse tree map)

A dedicated Notion page (e.g., `🗺️ Sitemap`) at the docs root, regenerated on every sync. Body is a column-laid-out terse tree using mention pills as leaves.

```
🗺️ Sitemap                          Last refreshed: 2026-05-01 14:49 UTC
─────────────────────────────────

▾ Backend  (24)                     ▾ Frontend  (87)                ▾ Boring  (53)
  • @[Auth setup]                    • @[App router migration]        • @[Build pipeline]
  • @[Cron jobs]                     • @[Design tokens]               • @[Observability]
  • @[Permissions matrix]            • @[Forms primer]                • …
  ▸ Tooling (12)                     ▾ Components  (23)               ▸ Workers (8)
                                       • @[Modal]                     ▸ DB tooling (5)
                                       • @[Dropdown]
                                       …
```

**Pros**: one-click overview; mention pills give hover preview; column layout fits 304 pages on a single screen. **Cons**: regenerating means deleting and rewriting the page on every sync (ok); column blocks via the markdown endpoint need verification (might require the blocks API).

**Implementation**: read `.notion-cache.json` (or the in-flight `pageIdMap` if generated during `sync.sh`), render markdown with mentions, push to a designated page ID stored in `.env` (`NOTION_SITEMAP_PAGE_ID=…`) or auto-create at root.

**Effort**: small — ~1 day. The biggest unknown is whether the markdown endpoint accepts `column_list`; if not, fall back to a single-column toggle list.

---

### Option D2 — Tag index page (markdown-rendered)

Add `tags: [foo, bar]` to frontmatter. A new page `🏷️ Tags` lists every tag with the pages that carry it, rendered as a flat markdown index:

```
🏷️ Tag Index                       Last refreshed: 2026-05-01

#auth        @[Auth setup] · @[Permissions matrix] · @[OAuth flow]
#caching     @[CDN strategy] · @[Cache invalidation]
#deprecated  @[Old API guide]
#performance @[Bundle analysis] · @[Database indexing] · @[Image optimization]
…
```

Plus, the per-page meta banner already at the top of leaf pages gets a `Tags: #auth #ssr` line, so Notion's full-text search picks up tag tokens.

**Pros**: zero new infrastructure (still regular pages); native Notion search works on tag tokens; one extra page to maintain. **Cons**: not a *real* tag system — just searchable text; can't filter "all docs with `#auth` AND `#staging`" without a database.

**Implementation**: extend `parseFrontmatter` to read `tags`, append a tag line to the meta banner, and write a new `tags.md`-derived dashboard page during a final pipeline phase.

**Effort**: small — ~½ day.

---

### Option D3 — Tags as native multi-select properties (requires partial DB migration)

Promote tags to a **real Notion property** by moving each leaf page into a database. This is option C from `NAV-STRUCTURE-EXPLORATION.md` re-applied. With proper properties, you get filter/sort/group views for free.

**Pros**: proper filtering, multi-tag intersect, sort by `last_synced`, group by `section`. **Cons**: large migration cost; markdown endpoint behaviour on database rows needs verification; rich_text mention shape changes.

**Effort**: large — ~5 days. Don't pick this unless tag-power-user workflows are the primary motivator.

---

### Option D4 — Sidecar "Index" database (no migration needed)

Keep all leaf pages exactly as they are. Create a **separate database** (e.g., `📇 Doc Index`) under the docs root. Each row is metadata about one leaf doc, with a `→ Page` mention column linking back to the actual page.

Properties: `title`, `path` (rich_text), `section` (select), `tags` (multi_select), `last_synced` (date), `body_chars` (number), `→ Page` (rich_text mention).

**Pros**: keeps existing tree intact (zero migration risk); database gives all the views/filters you'd want; can be deleted and regenerated at any time without affecting actual pages. **Cons**: indirection — clicking a tag takes you to the index row, then you click the mention to reach the actual page. Two clicks instead of one.

**Implementation**: new subcommand `bash list.sh index-db` (or pipeline phase) that:
1. Walks local files + frontmatter
2. Ensures the index database exists (create if missing)
3. Upserts one row per leaf doc keyed by `path`
4. Sets all properties from frontmatter + filesystem
5. Sets `→ Page` to a mention of the corresponding Notion page from `pageIdMap`

**Effort**: medium — ~2 days. Notion's database CRUD via SDK is well-documented; the upsert keying logic is the only careful bit.

---

### Option D5 — Recent changes feed

A `📣 Recently Synced` page rendered from `runs.jsonl` after every sync. Sorted by `last_synced` desc, limited to last 50 entries.

```
📣 Recently Synced                  Last refreshed: 2026-05-01 14:49 UTC

2026-05-01  @[Auth setup]            (updated, 2.1 KB)
2026-05-01  @[Modal v2]              (created, 4.3 KB)
2026-04-30  @[CDN strategy]          (updated, 1.8 KB)
…
```

**Pros**: trivial; great glanceable feed; uses already-recorded data. **Cons**: only useful if you sync often (otherwise the feed is stale).

**Effort**: small — ~½ day, mostly rendering.

---

### Option D6 — Health / status page

A `🩺 Sync Status` page auto-updated after every run with: last run id, total pages, error count, image cache size, last 3 errored paths with copy-paste retry. Essentially `bash list.sh recent-errors` rendered to Notion.

**Pros**: visible to anyone in Notion (collaborators); doubles as a "is the docs pipeline healthy?" indicator. **Cons**: low value if you mostly check status from the terminal anyway.

**Effort**: small — ~½ day. Largely re-using the data structures behind `recent-errors`.

---

### Option D7 — Backlinks per page

For each leaf page, append a "← Linked from" callout listing every other page that links to it. Computable from the link graph already constructed during sync.

**Pros**: makes Notion's "linked references" usable across the doc set; helps discover related content. **Cons**: callout adds visual noise to every page; backlinks can be voluminous (hot pages might have 30+ inbound links).

**Effort**: medium — ~1.5 days. Need to invert the link graph during Phase 2, then add a final block to each page.

## 4. Part II — Pipeline orchestration

The user's instinct is right: with 9+ subcommands and a typical workflow involving 3-5 of them, the project should expose a **pipeline-first** mental model.

### Option O1 — status quo (multiple bash entry points)

Today's setup. **Pros**: simple, each command is independently runnable. **Cons**: user has to know which commands compose into a routine; USAGE.md §Quick recipes is the only documentation of valid sequences.

### Option O2 — unified `bash run.sh` launcher with named modes

One entry point, modes select the pipeline:

```bash
bash run.sh                 # interactive — wizard picks mode
bash run.sh push            # sync only (= today's sync.sh)
bash run.sh push:full       # sync + fetch + diff + recent-errors + sitemap refresh
bash run.sh fix             # fix-mentions + recent-errors
bash run.sh check           # read-only verification: fetch + diff + recent-errors
bash run.sh dashboard       # refresh sitemap + tag-index + recent-feed + health
bash run.sh bring-up        # full first-time sequence: sync + fix-mentions + dashboards
```

Internally each mode is a sequence of phases; phases can be the same as today's commands or refactored helpers. `sync.sh` and `list.sh` stay around as low-level entry points (and for the GitHub Action), but `run.sh` becomes the documented primary.

**Pros**: terse, discoverable (`run.sh --help` lists all modes); composable; doesn't require tool installation beyond bash; backward-compatible. **Cons**: yet another bash file; mode names need careful design (`push:full` vs `full-push` etc.).

**Effort**: small — ~1 day to scaffold + document. New modes accrete naturally as new dashboard features land.

---

### Option O3 — `Justfile` (or `Makefile`)

```just
push:           bash sync.sh
fetch:          bash list.sh fetch
diff:           bash list.sh diff
errors:         bash list.sh recent-errors

push-full:  push fetch diff errors sitemap
check:      fetch diff errors
bring-up:   push fix-mentions push-full
```

**Pros**: declarative; dependency graph between targets; widely understood; great `just --list` output. **Cons**: requires `just` (or `make`) installed; phase functions still live in bash; one more tool to introduce.

**Effort**: small — ~½ day (install just + write the file).

---

### Option O4 — single TS pipeline runner (`bun run cli.ts`)

A TypeScript CLI inside notion-sync that owns all commands:

```bash
bun cli push
bun cli push --full
bun cli check
bun cli dashboard
bun cli bring-up
```

Each subcommand calls into shared modules (no shelling out to sub-scripts). Wizard logic, env validation, notification, and pipeline orchestration all live in TS.

**Pros**: cleanest internal architecture; phases compose by function calls (no shell-arg quoting); easier to add structured output / JSON mode for automation; types catch refactor errors. **Cons**: bigger refactor; loses bash's "I can read this in 30 seconds" property; gum-based wizard is painful to replicate in TS without a TUI library.

**Effort**: large — ~3-4 days to consolidate; ongoing benefit each time a new mode is added.

---

## 5. Comparison matrix

### Dashboards

| Option | Solves "find a doc"  | Solves "tag search" | Migration cost | Reversibility |
| ------ | :------------------: | :-----------------: | :------------: | :-----------: |
| D1 — Sitemap                | ✓ | ✗ | small | high |
| D2 — Tag index page         | ◐ | ◐ | small | high |
| D3 — Native multi-select tags | ✓ | ✓ | large | low |
| D4 — Sidecar Index DB       | ✓ | ✓ | small | high |
| D5 — Recent feed            | ✗ | ✗ | small | high |
| D6 — Health page            | ✗ | ✗ | small | high |
| D7 — Backlinks              | ◐ | ✗ | medium | high |

### Orchestration

| Option | Discoverability | Refactor cost | New tool to install | Backward compat |
| ------ | :-------------: | :-----------: | :-----------------: | :-------------: |
| O1 — status quo                | low    | none | no  | n/a |
| O2 — `bash run.sh`             | high   | small | no  | yes |
| O3 — Justfile                  | high   | small | yes (`just`) | yes |
| O4 — TS CLI (`bun cli`)        | high   | large | no  | partial |

## 6. Recommendation

**Phase 1 — composable, low-risk wins (~3 days total):**

1. **D1 (Sitemap)** — biggest discovery improvement per day-of-work.
2. **D2 (Tag index page)** — tag-as-text gets you 80% of the search benefit at 10% of the cost of D3/D4.
3. **D5 (Recent feed)** — almost-free given the data already exists.
4. **O2 (`bash run.sh`)** — wraps the new + existing commands; ~1 day; sets up the pipeline mental model without a heavy refactor.

After Phase 1, the project mental model becomes: *"`bash run.sh` is the primary entry point; modes select the pipeline; sync.sh and list.sh are low-level building blocks."* Update README and USAGE.md to reflect this.

**Phase 2 — only if Phase 1 isn't enough (~3 more days):**

5. **D4 (Sidecar Index DB)** — adds proper filtering/sorting *without* migrating existing pages. Worth it if Phase 1 tag search feels too weak. Don't pick D3.
6. **D6 (Health page)** — nice-to-have; fits cleanly as a new pipeline phase.

**Skip unless explicitly motivated:**

- **D3 (Native multi-select)** — high migration cost; D4 gets you the same views without it.
- **D7 (Backlinks)** — visual noise tradeoff; ship later if requested.
- **O3 (Justfile)** — same value as O2 but adds a tool dependency.
- **O4 (TS CLI)** — large refactor, defer until Phase 1+2 commands stabilize and the bash glue actually starts hurting.

## 7. Open questions

1. **Is the user *one user* or are there collaborators reading the Notion docs?** D1/D2 are mainly for collaborators; for solo use, terminal-based discovery (grep, ls, list.sh) is often faster.
2. **How often does the doc set change?** D5 (recent feed) only earns its keep with frequent syncs.
3. **Are tags going to be high-cardinality?** If yes, D2's flat tag-index page gets long fast — D4 (sidecar DB with multi_select filter) scales better.
4. **Should the sitemap link to local files too?** A sitemap with `→ Notion` AND `→ GitHub source` links per leaf doubles its utility for code-review-adjacent flows.
5. **How fast does `run.sh push:full` need to be?** Sequential phases are simple but slow. Parallelizing (e.g., dashboard refreshes don't depend on each other) is doable but adds complexity. Defer until measured.

## 8. Effort summary

| Item | Time | Risk | Reversibility |
| ---- | ---- | ---- | ------------- |
| D1 — Sitemap                       | ~1d   | low    | high |
| D2 — Tag index page                | ~½d   | low    | high |
| D3 — Native multi-select tags      | ~5d   | high   | low  |
| D4 — Sidecar Index DB              | ~2d   | medium | high |
| D5 — Recent feed                   | ~½d   | low    | high |
| D6 — Health page                   | ~½d   | low    | high |
| D7 — Backlinks                     | ~1.5d | medium | high |
| O1 — status quo                    | 0     | none   | n/a  |
| O2 — `bash run.sh`                 | ~1d   | low    | high |
| O3 — Justfile                      | ~½d   | low    | high |
| O4 — TS CLI (`bun cli`)            | ~3-4d | medium | medium |

**If asked "what's the cheapest combined improvement?"** — D1 + D2 + D5 + O2, total ~3 days, ships a real pipeline-first project with a sitemap, tag search, and recent feed. Good baseline.

**If asked "what's the right long-term architecture?"** — D1 + D2 + D4 + O2 + (later) O4. The sidecar DB is the structural answer for searchability; O2 first, O4 only when the bash glue actually hurts.

## 9. Naming / surface notes

When this lands, the dashboard pages live alongside docs at the root. Suggested icons + names (consistent with current `NOTION_FOLDER_ICON` pattern):

- `🗺️ Sitemap`
- `🏷️ Tags`
- `📣 Recently Synced`
- `🩺 Sync Status` (Phase 2)
- `📇 Doc Index` (Phase 2, if D4 ships)

Each one pinned at the root above the section pages. The order in the sidebar can be enforced by writing them first during sync.

---

If approved, the Phase 1 implementation order would be: **O2 first** (so subsequent dashboard phases plug into a real pipeline), then D5 (cheapest, validates the rendering pipeline), then D2 (touches frontmatter — a small parser change is the only risk), then D1 (most user-visible, builds on patterns from D2/D5).
