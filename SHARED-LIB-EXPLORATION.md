# Shared-lib extraction — plan

> Status: PLANNED (workstream A). Workstream B (dashboard consolidation) is
> DONE on this branch. This doc maps the duplication and the migration path
> for extracting a shared `lib/`. To be executed incrementally on this branch,
> merged to main when stable.

## Why

10.5k lines of TS across 14 files reimplement the same "talk to Notion with
retries + show progress" concerns per-file. The architecture is a fat
dispatcher (`notion-list.ts`) plus flat self-contained leaf modules (the 6
dashboards), and the leaves' isolation is exactly why `withRetry`, color
helpers, and rate-limit constants got copy-pasted into 5+ of them. The fix is
a shared `lib/` the leaves depend on — keeping them independent of each OTHER
while removing the copy-paste.

## Current component graph

```
SHELL ENTRYPOINTS                TS ENTRYPOINTS              LEAF MODULES
run.sh ──┬─► sync.sh    ───────► index.ts ──────┬─► image-uploader.ts
         │                                       ├─► mention-converter.ts
         │                                       └─► sync-state.ts
         ├─► list.sh    ───────► notion-list.ts ─┬─► sitemap.ts
         │                       (hub/dispatch)   ├─► tag-index.ts
         │                                        ├─► index-db.ts
         │                                        ├─► backlinks.ts
         │                                        ├─► recent-feed.ts
         │                                        ├─► health.ts
         │                                        ├─► mention-converter.ts
         │                                        └─► title-match.ts
         └─► (diff-content) ───► diff-content.ts ─┬─► reconcile.ts
                                                   ├─► sync-state.ts
                                                   └─► title-match.ts
                                 reconcile.ts ────► sync-state.ts
```

## Duplication survey (grounded in rg, 2026-05-21)

| Concern | Lives in (count) | Proposed home |
|---|---|---|
| Notion Client construction | index, notion-list, diff-content, reconcile (4×) | `lib/notion.ts` `getNotion()` |
| `withRetry` (429/5xx) | notion-list, backlinks, recent-feed + sitemap, tag-index local copies (5×) | `lib/retry.ts` |
| Rate limiting | notion-list (flat 350), index.ts (adaptive floor/ceiling) (2×) | `lib/rate-limit.ts` |
| `.env` parsing | diff-content, notion-list (2×, + Bun auto-loads) | `lib/env.ts` |
| Color helpers (ANSI) | notion-list + leaf copies (~6×) | `lib/colors.ts` |
| Progress UI (bar/spinner/heartbeat/live-counter) | notion-list + ad-hoc `\r` everywhere | `lib/progress.ts` |
| cache load/save + keyed paths | notion-list, diff-content, index.ts, sync-state (4×) | `lib/cache.ts` or extend sync-state |

## Migration sequence (incremental, verify-after-each)

1. `lib/colors.ts` — 6 copies → 1. Pure, zero behavior. [~30min, trivial]
2. `lib/notion.ts` — 4 client constructions → `getNotion({timeoutMs})`. [~20min]
3. `lib/retry.ts` — merge 5 copies. **CAREFUL** (see risk below). [~1hr]
4. `lib/progress.ts` — bar/spinner/heartbeat/LiveCounter; migrate fix-mentions
   + dashboards + fetch to it. [~1.5hr]
5. `lib/rate-limit.ts` — promote index.ts's adaptive limiter. [~1hr]
6. `lib/env.ts` — consolidate after verifying Bun auto-load gap + the
   --env <path> custom-file path still works. [~30min]

Each step independently shippable + type-checkable. Total ~5h, no big-bang.

## Risk: the retry merge (Step 3)

The 5 `withRetry` copies are NOT identical:
- `notion-list.ts` — 5 attempts, exponential 2s→32s, honors `Retry-After`
- `backlinks.ts` / `recent-feed.ts` — 4 attempts, linear backoff, `log` callback
- `sitemap.ts` / `tag-index.ts` — "kept local" linear-backoff variants

Merge into `withRetry(fn, {maxAttempts, backoff:"exp"|"linear", onRetry})` but
preserve each caller's exact attempt count + curve. The dashboards' linear
backoff was deliberate (sitemap.ts comment: "Notion 504s on large tag-index
wipe"). A naive flatten to exponential could regress that.

## Known issues to address during this work (from 2026-05-21 skeptical review)

These were surfaced by the adversarial review of the workstream-B/cache-keying
changes. The two HIGH findings were fixed inline; these remain:

- **Variant-match false positives** (`title-match.ts` titleVariants): head/tail
  dash-split + paren-strip makes `"App — X"`↔`"App — Y"`, `"Auth (Frontend)"`↔
  `"Auth (Backend)"` collide. Blast radius is "confusing diff output"; for
  `prune` it errs SAFE (more conservative = fewer archives). Tighten by
  requiring minimum variant specificity (don't match on a bare short head word
  alone) and/or weighting tail-matches over head-matches.
- **Stale diff served silently** (`diff-content.ts` promptUseCache): defaults to
  "use cache" when stdin isn't a TTY (the spawned list.sh path) and the diff
  cache has no content/mtime invalidation. Add a cache-staleness check
  (compare against `.notion-cache` mtime or a content hash).
- **`dashboards` swallows missing DOCS_DIR** as a vague "phase failed" — give a
  specific up-front error when DOCS_DIR is unset and tag-index/index-db/backlinks
  are in the phase list.
- **Two divergent `.env` parsers** (notion-list `.trim()`+keeps-quotes vs
  diff-content quote-strip+no-trim) — resolved naturally by Step 6 (`lib/env.ts`).
