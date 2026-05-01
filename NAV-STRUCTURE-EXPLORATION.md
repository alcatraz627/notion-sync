# Exploration: better Notion tree / nav structure

> **Status**: design exploration, no shipping code. The point of this doc is to evaluate alternatives to the current "deeply nested `child_page`" model with eyes open about tradeoffs, not to commit to any of them.

## 1. Current state (snapshot from `.notion-cache.json` 2026-05-01)

```
Total pages:  304
Depth 0:       1   ← root
Depth 1:      13   ← top-level sections (boring-technical-stuff/, frontend/, …)
Depth 2:      70
Depth 3:      82
Depth 4:      54
Depth 5:      79
Depth 6:       5   ← deepest leaves
```

So roughly 70% of pages live at depth 3–5 — the "deep middle" where Notion's UI starts to hurt.

## 2. Problems observed with deep `child_page` nesting

| Pain                                                                                     | Where it shows up                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Breadcrumb truncates after ~3 segments                                                   | Notion top bar — `Docs > … > leaf-page`                                               |
| Sidebar tree gets visually crowded once a section has >20 children                        | Left rail, especially `boring-technical-stuff/` and `frontend/`                       |
| No global ToC — every navigation starts from "click section, scroll, click subsection…" | User has to know the shape of the tree to navigate                                    |
| Sync-time Phase 1 cost grows linearly with depth (one `pages.list` per parent)           | Phase 1 takes ~30s on 304 pages even with adaptive rate limit                         |
| Cross-section links require typing the full name                                         | Mentions only resolve if the source markdown link points to the right `.md` file path |
| Empty section pages clutter (folders with no `_index.md` get auto-generated stubs)       | Adds noise without content; user has to ignore them                                   |

None of these are fatal — the current model works. But there's room for a structurally better answer.

## 3. Alternatives, with real tradeoffs

### Option A — status quo (do nothing)

**Pros**: zero migration cost; mirrors filesystem 1:1; native Notion nav works. **Cons**: everything in §2.

**When to pick**: if the cost of any migration outweighs the benefit. For 304 pages and one user, this is the default — most of the pain is "annoying" not "blocking".

### Option B — flatten to depth 2 + table-of-contents pages

Top-level: `Docs` → 13 section pages (depth 1). Each section page contains a *manually-rendered ToC* (heading + bullet list of links to leaf pages). All leaf pages live as direct children of their section — no deeper nesting. Sub-folder hierarchy collapses into "## Sub-folder name" headings inside the ToC.

**Pros**: depth never exceeds 2; sidebar shows section + its leaves only; ToC pages are great landing pages; cross-section linking unchanged. **Cons**: loses the narrative-shape of the filesystem (folders-within-folders); large sections (50+ docs) still feel crowded in the sidebar.

**Implementation effort**: medium. Rewrite `discoverTree` to ignore sub-folders and render a sub-tree heading inside each section's `_index.md` instead. Roughly 2 days. The auto-index generator already exists — would need to run at section level, not folder level.

### Option C — convert leaf docs to rows in a per-section database

Each top-level section becomes a Notion **database** (`/database` block) instead of a child_page. Each leaf doc is a row with properties: `title`, `path` (rich_text), `tags` (multi_select), `last_synced` (date). The page body of each row holds the actual content.

**Pros**: built-in views (table / gallery / list), filter, sort, group; can sort by `last_synced` to surface recent changes; database search is faster than tree search. **Cons**: Notion's `markdown` endpoint (`PATCH /pages/:id/markdown`) doesn't work the same way for database rows — content writes work, but full-page replacement semantics shift. Would need to re-test. Also, formatting fidelity in DB row pages tends to be slightly different from regular pages.

**Implementation effort**: large. Probably 4–5 days. Requires rebuilding the discovery + write phases for database rows, retesting all WAF / size suspicions, retesting mention conversion (mentions to DB rows have a different rich_text shape).

### Option D — synced-block global nav

Create one Notion page with the canonical ToC. Use a `synced_block` to embed it at the top of every leaf and section page. When the ToC page is edited, every embedded copy updates.

**Pros**: every page has the full nav at the top, no clicking-back-up; one source of truth; cheap to implement. **Cons**: synced_blocks have a ~100-block size limit each; 304 leaves can't all live in one nav block — would need to split per-section. The `@notionhq/client` SDK has `blocks.children.append` for synced sources but the public API around *creating* synced blocks has rough edges.

**Implementation effort**: small. ~1 day to prototype. Risk: synced block API has surfaces that aren't well documented.

### Option E — column layout for section pages

Keep current nesting. But on each section page (e.g., `frontend/_index.md`), generate a 2-3 column block layout for the auto-index instead of the current single-column bullet list. Easier visual scan when a section has 30+ children.

**Pros**: low-risk visual upgrade; doesn't change the tree shape; can ship incrementally. **Cons**: doesn't address depth, breadcrumb truncation, or sidebar crowding; just makes section pages prettier.

**Implementation effort**: small. ~half a day. The markdown endpoint accepts `column_list` blocks via the `markdown` API in some shapes (needs verification) — if not, falls back to direct `blocks.children.append` after the markdown push.

### Option F — toggleable folder summaries

Replace the auto-generated section index with toggle blocks: each sub-folder collapses by default, expanding to show its leaf docs. Reduces visual length on section pages without losing the hierarchy.

**Pros**: same content, less scrolling; sub-folder structure remains visible; trivial to ship. **Cons**: hidden-by-default content is harder to scan; "where is the doc I want?" requires opening every toggle. Tradeoff between density and discoverability.

**Implementation effort**: small. ~half a day. Markdown endpoint accepts toggle blocks via the `>` or fenced HTML-ish syntax in some Notion-flavored markdown dialects — needs verification with the v5 SDK.

## 4. Comparison matrix

| Option | Solves depth | Solves crowding | Solves breadcrumb | Migration cost | Reversibility |
| ------ | :----------: | :-------------: | :---------------: | :------------: | :-----------: |
| A — status quo                       | ✗ | ✗ | ✗ | none | n/a |
| B — flatten + ToC pages              | ✓ | ◐ | ✓ | medium | medium (one re-sync from clean) |
| C — database per section             | ✓ | ✓ | ✓ | large | hard (DB rows ≠ pages) |
| D — synced-block global nav          | ◐ | ✗ | ◐ | small | easy |
| E — column-layout section indexes    | ✗ | ◐ | ✗ | small | easy |
| F — toggle-collapsed folder summaries | ✗ | ◐ | ✗ | small | easy |

`◐` = partial. Migration cost includes Notion-side wipe risk if the script fails mid-restructure.

## 5. Recommendation

**Ship E + F as a small composable upgrade first** (one PR, ~1 day total). They're additive, reversible, and address the most-frequently-cited pain (visual crowding on big section pages) without touching the tree shape.

**Then re-evaluate.** If after E+F the user still finds depth/breadcrumb truncation painful, escalate to **Option B** (flatten + ToC). Skip C entirely unless database views become a primary use case (e.g., wanting to filter "all docs tagged `internal`" or "all docs edited in the last 7 days") — in which case C becomes worthwhile.

D (synced-block global nav) is interesting but the API risk is real; it's a fine future experiment but not a first move.

## 6. Open questions before any work starts

1. **Is the user's pain "I can't find the doc I want" or "the rendered Notion page looks crowded"?** Different problems, different fixes. E+F help the second; B helps the first.
2. **How often does the user navigate Notion vs. just edit local markdown and let sync handle it?** If Notion is read-only-ish for the user, "looks pretty" matters more than "easy to navigate".
3. **Are there external collaborators who navigate the Notion tree?** Then B becomes more compelling — easier nav for non-authors.
4. **Is there appetite for a Notion sidebar plugin / external tool?** Sometimes the right answer is "stop fighting Notion's nav and build the nav you want as a separate tool" — e.g., a static HTML index hosted somewhere, with deep links into Notion.

## 7. Effort summary

| Option | Time   | Risk    | Reversible |
| ------ | ------ | ------- | ---------- |
| A      | 0      | none    | n/a        |
| B      | ~2d    | medium  | medium     |
| C      | ~5d    | high    | low        |
| D      | ~1d    | medium  | high       |
| E      | ~0.5d  | low     | high       |
| F      | ~0.5d  | low     | high       |

If the user asks "what's the cheapest improvement?", the answer is E or F. If they ask "what's the right long-term shape?", probably B. If they ask "what would unlock new workflows?", probably C.
