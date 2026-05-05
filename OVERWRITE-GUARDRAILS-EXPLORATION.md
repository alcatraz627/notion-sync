# Overwrite Guardrails — Design Exploration

> **Status:** Spec / exploration. Not yet implemented.
> **Created:** 2026-05-06
> **Related:** [NAV-STRUCTURE-EXPLORATION.md](NAV-STRUCTURE-EXPLORATION.md), [DASHBOARDS-AND-ORCHESTRATION-EXPLORATION.md](DASHBOARDS-AND-ORCHESTRATION-EXPLORATION.md)

## Problem

Today notion-sync is one-way: local `docs/product/**` → Notion. Phase 2 unconditionally overwrites every page's content, and Phase 1 looks pages up by **title** under their parent. Two failure modes follow:

1. **Silent overwrite of human edits.** A teammate (or the user) edits a page in Notion. On the next `bash sync.sh`, that edit is wiped without warning.
2. **Lost moves + duplicates on rename.** If a page is moved or renamed in Notion, title-based lookup misses it, and `getOrCreateChildPage` creates a duplicate. The original remains, but is now an orphan diverging from local.

Both are silent — the run reports `errors: 0`. The user finds out the next time they open the page.

## Goal

Detect divergence (human edit, move, rename, archival) **before** Phase 2 writes, and refuse to overwrite without explicit confirmation. Default behavior: **diagnose, don't destroy** — the existing project posture (`/sync-all`, `prune` dry-run, `mode_dashboard` reports timeouts).

Non-goals (this spec):

- Bidirectional sync / pulling Notion edits back to local. Out of scope; tracked separately in V2 shelf as notion-pull.
- Conflict-resolution UI (3-way merge, diff viewer). Out of scope.
- Block-level granularity. Page-level signal is sufficient and far cheaper.

## Research summary

(Full sources at the bottom of [the catchup conversation](#sources).)

| Finding | Implication |
|---|---|
| `last_edited_by` is a User object with `{object, id, type}` where `type ∈ {"person", "bot"}` | Bot vs human is distinguishable per-edit. |
| Each integration has its own bot user with a unique id, retrievable via `notion.users.me()` | We can identify "us" reliably. |
| API-driven edits attribute to the integration's bot, not the human who triggered them | Our own pushes are correctly tagged as bot. Other integrations show as their own bot id (also flaggable). |
| `last_edited_time` is rounded to the nearest minute (Notion API change, July 2024) | Computing baselines from local clock is unsafe. Storing **the value Notion reports back to us** sidesteps the rounding entirely. |
| Notion comments do **not** bump `last_edited_time` | Comments are silently ignored by our check, which is the desired behavior. |
| The `.notion-cache.json` schema today stores `block_count`, `parent_id`, `title`, `url`, `icon` — no edit metadata | Adding two fields to the same record is the lightest-touch extension. |
| Prior art (go-notion-md-sync) embeds sync state in **markdown frontmatter** | Rejected: pollutes the source-of-truth docs in git, creates merge conflicts. We use gitignored sidecar JSON. |
| Prior art (NotionFS, go-notion-md-sync) all use **hybrid timestamp + content hash** | Content hash is rejected: Notion's markdown export is non-deterministic (mention text, block reorder, whitespace), so hashes drift between identical semantic states. Timestamps + edit-identity are sufficient. |

## Design

### 1. Signal hierarchy

| Signal | Cost / API | Decision power |
|---|---|---|
| `last_edited_by.id !== ourBotId` AND `last_edited_time` changed | One `pages.retrieve` per known page | Definitive: human (or another integration) edited |
| `parent.page_id !== expected_parent_id` | Same retrieve, free | Definitive: page moved |
| `archived === true` | Same retrieve, free | Definitive: page archived in Notion |
| `block_count` drift beyond margin (±2) | Same retrieve, free | Soft: structural change beyond what our re-render explains |
| Content sha256 round-trip | 2× API calls + render | **Rejected** — non-deterministic markdown export produces too many false positives |

Per-page cost: **one `pages.retrieve` call**, which is mostly free since Phase 1 already retrieves pages for icon and parent metadata (see `notion-list.ts:264`, `index.ts:1199`, `index.ts:1222`). The implementation should piggyback on those calls rather than add a separate pass.

### 2. State store — `.notion-sync-state.json`

A new gitignored sidecar, parallel to `.notion-cache.json` and `.notion-image-cache.json`:

```jsonc
{
  "version": 1,
  "bot_id": "abc-123-def",                  // cached from notion.users.me()
  "bot_id_fetched_at": "2026-05-06T08:00:00Z",
  "pages": {
    "product/jobs/create-upload.md": {
      "page_id": "353bacd2...3da3e09",
      "expected_parent_id": "34abacd2...",
      "last_pushed_edited_time": "2026-05-03T11:42:00.000Z",  // value Notion reported AFTER our push
      "last_pushed_block_count": 47,
      "last_pushed_at": "2026-05-03T11:42:13Z"                // our local clock, diagnostics only
    }
  }
}
```

**Critical detail:** `last_pushed_edited_time` is the value Notion returned to us when we retrieved the page **immediately after a successful write**. Comparing strings on the next run is exact and dodges the minute-rounding problem entirely.

**Bot-id cache TTL:** 7 days. Refresh on staleness or on explicit `--refresh-bot-id`.

### 3. The check

Run **once per known page**, between Phase 1 (discovery) and Phase 2 (content writes):

```ts
const meta = await notion.pages.retrieve({ page_id });
const state = syncState.pages[relPath];

const baseline = state?.last_pushed_edited_time;
const editedSinceBaseline = baseline && meta.last_edited_time !== baseline;
const editedByOther       = meta.last_edited_by.id !== syncState.bot_id;
const moved               = state && meta.parent.page_id !== state.expected_parent_id;
const archived            = meta.archived === true;

if (archived) flag("archived",   relPath, meta);
else if (moved) flag("moved",    relPath, { from: state.expected_parent_id, to: meta.parent.page_id });
else if (editedSinceBaseline && editedByOther)
              flag("user-edited", relPath, { at: meta.last_edited_time, by: meta.last_edited_by });
else if (editedSinceBaseline && !editedByOther)
              flag("benign-drift", relPath, meta); // soft warn — likely partial prior run; not a block
```

### 4. Default behavior — skip + report

Match the project's "diagnose, don't destroy" posture. On guardrail trip, the run **does not abort** — it sets the affected pages aside and continues with everything else.

```
🛡  Overwrite guardrails — 3 page(s) protected

  product/jobs/create-upload.md
    ↳ Edited by human at 2026-05-04T16:30:00Z
    ↳ Last clean baseline: 2026-05-03T11:42:00Z
    ↳ View: https://www.notion.so/353bacd2...
    ↳ Resolve: bash sync.sh --force-overwrite product/jobs/create-upload.md
               OR pull human edits back to local first

  product/billing/index.md
    ↳ Moved (parent changed)
    ↳ Resolve: bash sync.sh --accept-move product/billing/index.md
               OR move it back in Notion

  product/legacy/old.md
    ↳ Archived in Notion
    ↳ Resolve: bash sync.sh --accept-archive product/legacy/old.md
               OR un-archive and re-run

Continuing with 247 unprotected pages.
```

### 5. Wizard integration

Add a question to the existing wizard in `sync.sh` between **Mode** and **Filter**, mirroring the `NOTION_USE_MENTIONS` / `NOTION_UPLOAD_IMAGES` pattern:

```
🛡  Guardrails — protect human-edited Notion pages?
   ▸ Yes, check before overwriting (recommended)            ← default
     Warn but overwrite anyway
     Disabled
```

Saved to `.sync-defaults.json` as `"guardrails": "strict" | "warn" | "off"`. Exported to the Node script as `NOTION_GUARDRAILS=strict|warn|off`.

| Mode | Behavior |
|---|---|
| `strict` (default) | Skip protected pages, continue with others. Report at end. |
| `warn` | Print warnings, overwrite anyway. Useful for first rollout / debugging. |
| `off` | Skip the check entirely. Identical to today's behavior. |

CLI overrides:

| Flag | Effect |
|---|---|
| `--guardrails strict\|warn\|off` | Override saved default for this run |
| `--force-overwrite <path>` | Override `strict` for one specific page |
| `--accept-move <path>` | Accept the new parent, update state, push content |
| `--accept-archive <path>` | Mark page archived locally (skip on future runs) |
| `--refresh-bot-id` | Force `notion.users.me()` re-fetch |

### 6. Bonus: rename safety, finished

The state file's `page_id` lookup also closes a long-standing latent bug. Today `getOrCreateChildPage` looks up by **title** under the parent. If a user renames a page in Notion:

1. Lookup-by-title misses it.
2. A duplicate page is created with the local title.
3. The original orphan diverges silently.

With `.notion-sync-state.json`:

```ts
async function getOrCreateChildPage(parentId, relPath, title, icon) {
  const knownId = syncState.pages[relPath]?.page_id;
  if (knownId) {
    try {
      const meta = await notion.pages.retrieve({ page_id: knownId });
      if (!meta.archived && meta.parent.page_id === parentId) return knownId;
      // Else fall through to title lookup / create
    } catch (e) { /* page deleted: fall through */ }
  }
  // Existing title-based path…
}
```

This is the rest of the v1.2 "rename-safety" story — partially landed but not closed.

### 7. Edge cases

| Edge | Behavior |
|---|---|
| **First-ever push of a doc.** No state record. | Skip check, push, record baseline. |
| **User edits within the same minute we push.** Possible silent miss due to rounding. | Mitigate by storing the post-push retrieved value, not local clock. Race window ≤60s; acceptable for a doc-sync tool. |
| **Another integration touched the page.** `last_edited_by.id !== botId`, but not human either. | Flagged as "edited by other integration ({botName})". Soft warn by default; user can promote to strict via `--strict-other-integrations`. |
| **User adds a Notion comment.** | Comments don't bump `last_edited_time`. Silently ignored. ✓ |
| **User archives the page in Notion.** | `archived === true` → `flag("archived")`. Never overwrite an archived page. |
| **User moves the page outside the synced root.** | `parent.page_id` no longer in our id set → loud warning. Treat like archived: never overwrite. |
| **Block-count drift after our own re-push.** | If `last_edited_by === botId`, just refresh baseline. No flag. |
| **Markdown re-render produces semantically-identical output.** | Each push still bumps `last_edited_time` and `last_edited_by = bot`. Baseline updates to the new value. Fine. |
| **`.notion-sync-state.json` deleted or first run after upgrade.** | Treat as no-baseline. First run after upgrade: `--seed-state` flag does a no-op pass that records baselines without writing any content. |
| **State file vs cache drift.** | Cache (`.notion-cache.json`) is read-mostly and wiped freely; state file is write-after-success. No coupling required. |

### 8. Implementation cost

- **~80–150 LOC** in `index.ts` (state load, bot-id fetch, pre-Phase-2 check loop, post-Phase-2 record write, new flag parsing).
- **~20 LOC** in `sync.sh` (one `gum choose` block + saved-default plumbing).
- **One new env var** (`NOTION_GUARDRAILS`).
- **One new sidecar file** (`.notion-sync-state.json`).
- **One new doc section** in `USAGE.md` + `CLAUDE.md`.

No new dependencies. No new API surfaces — all signals come from `pages.retrieve` and `users.me`, both already used.

### 9. Rollout plan

1. **Probe (this PR).** Run [`scripts/probe-bot-id.ts`](scripts/probe-bot-id.ts) against the live workspace. Confirm:
   - `notion.users.me()` returns a bot user with a stable id.
   - Pushing content via the API and immediately retrieving the page returns `last_edited_by.id` equal to that bot id.
   - The retrieved `last_edited_time` is stable across consecutive retrieves (no clock drift).
2. **Schema + state file (PR 1).** Add `.notion-sync-state.json`, write-after-success, no checks yet. Deploy. Verify the file populates correctly across a full run.
3. **Check loop (PR 2).** Add the divergence check, default mode `warn` (visible but non-blocking). Run for one cycle. Inspect the flag rate; tune false-positive triggers.
4. **Default → strict (PR 3).** Flip default to `strict`. Add wizard question. Document in USAGE.md.
5. **Rename safety (PR 4).** Replace title-based lookup in `getOrCreateChildPage` with id-based-with-title-fallback.

Each PR is shippable on its own; the staged rollout means a regression in any step is caught before it can block syncs.

### 10. Alternatives considered (and rejected)

| Alternative | Why rejected |
|---|---|
| **Hidden marker block on each page** (a `code` block with `<!-- notion-sync: {hash, ts} -->`) | Pollutes the page UI; users can accidentally delete it. Self-contained but at the cost of every viewer seeing a marker. |
| **Notion property on the Doc Index DB row** | Cleaner UI-wise, but the index DB is a derived view, not the source of truth. Coupling the guardrail to a derived dashboard creates ordering bugs (what if the user disables `index-db`?). |
| **Frontmatter in the markdown source** (go-notion-md-sync's approach) | Pollutes git-tracked source files with sync-state metadata. Creates merge conflicts. The frontmatter-as-state pattern fits standalone tools, not docs-checked-into-git pipelines. |
| **Content sha256 round-trip** | Notion's markdown export is non-deterministic (mention rendering, block ordering, whitespace). Produces persistent false positives even when content is genuinely unchanged. |
| **Three-way merge** | Out of scope. Useful only with bidirectional sync, which is its own deferred V2 effort. |

## Open questions

- Should `--accept-move` trigger a state-only write, or also re-render the page (in case the human edited content in addition to moving)? Current design: state-only update; content gets pushed only on subsequent runs that pass the human-edit check. This avoids a "fixed the move but blew away the edits" surprise.
- Should the `warn` mode tag affected pages in `runs.jsonl` for `/sync-all` to surface in its end-of-run report? Strong yes; cheap.
- Wizard placement: between Mode and Filter (proposed) vs. inside an "advanced" submenu? Proposed placement keeps it visible; advanced submenu hides important safety behavior.

---

_Last updated: 2026-05-06_
