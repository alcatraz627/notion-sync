# RCA: archived-page cascade (2026-04-29 → 2026-04-30)

A four-day debugging arc where notion-sync repeatedly tried to write to Notion pages that had been deleted (trashed) by the user between runs. Symptoms cascaded: 5 errors → 195 errors → 252 errors across successive "fix" attempts before the actual root cause was found. This document is the post-mortem. Future incidents in this codebase should consult it before assuming a similar fix.

> **One-line takeaway**: in distributed APIs, a filter on a boolean is only as good as where that boolean lives. `blocks.children.list` returns page-block pointers, but `block.archived` is always `false` even for deleted pages — the truth lives on the page object, accessible only via `pages.retrieve`. **Plus** Notion has *two* deletion states (`archived` and `in_trash`); checking only one silently lets the other through.

---

## 1. Timeline of failed fixes

| Commit  | Date | Run                | Result               | What it tried                                                                  | Why it didn't work                                                                                       |
| ------- | ---- | ------------------ | -------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `a510ee4` | 04-29 | `20260429-191328`  | 5 errors → aborted   | Filter `block.archived === true` from `listChildPages`                         | **No-op.** `blocks.children.list` returns `block.archived === false` for trashed pages — flag is on the *page*, not the block. |
| `eb8c36c` | 04-29 | (next run)         | improved leaf case   | Auto-unarchive Phase 2: on `archived` error, call `pages.update({archived:false})` then retry once | Wrong target. Failures were *ancestor*-archived, not *leaf*-archived. Errors changed from "archived block" to "archived ancestor". |
| `a668f3e` | 04-29 | `20260429-205535`  | **194 errors**       | Distinguish ancestor from leaf; walk `relPath`'s dir chain, unarchive every section page in `pageIdMap` | Race condition: Notion's unarchive returns 200 OK *before* the state change is visible. Phase 2 retry hit the same error. |
| `bd0c509` | 04-30 | `20260430-021257`  | **10 errors → aborted** | Add `await sleep(3000)` after ancestor unarchives before retrying                | Helped some, but unarchive call itself was unreliable on parents already in trash. Still occasional cascade. |
| `6764e94` | 04-30 | `20260429-222229`  | **195 errors**       | **Phase 1 root-cause fix.** In `getOrCreateChildPage`, on title match, call `pages.retrieve` and unarchive on the spot. | Closer — but `pages.retrieve` returned `archived: false` for pages that were `in_trash: true`. Two flags, only one checked. |
| `53508f8` | 04-30 | clean              | recovers             | If archived, treat as non-existent → `pages.create` fresh. (Eventual-consistency-proof: don't unarchive, just skip.) | Worked for `archived: true`. Still missed the `in_trash` cohort. |
| `a33682b` | 04-30 | clean (final)      | **0 errors, stable** | Check **`page.in_trash === true` OR `page.archived === true`** in Phase 1. Both states now treated as non-existent. | Final fix. Notion uses `in_trash` for the user-visible "Move to Trash" action and reserves `archived` for the older archive concept. |

---

## 2. Why the symptom kept changing

Each fix moved the failure to the next layer. That's a hallmark of patching symptoms without root cause — the bug shifts shape but doesn't go away.

```
Run 1 (a510ee4):    "Can't edit block that is archived"        ← leaf-level error
                          ↓ (added auto-unarchive on leaf)
Run 2 (eb8c36c):    "Can't edit page on block with an
                     archived ancestor"                          ← parent-level error
                          ↓ (added ancestor walk + unarchive)
Run 3 (a668f3e):    Same error, but now AFTER unarchive          ← timing race
                          ↓ (added 3s sleep)
Run 4 (bd0c509):    Same error sporadically                       ← unarchive itself unreliable
                          ↓ (Phase 1 unarchive instead)
Run 5 (6764e94):    Same error on a *subset* of pages              ← second deletion state
                          ↓ (check in_trash too)
Run 6 (a33682b):    Clean. 0 errors.                                ← root cause closed
```

The pattern: every "fix" passed the test that failed in the previous run, then a *different* shape of the same underlying bug showed up. The thing that finally broke the loop was reading Notion's API documentation for the response shape of `pages.retrieve` — at which point `in_trash` was visible alongside `archived`.

---

## 3. The two root causes

### 3a. Block-level vs page-level state

`blocks.children.list` returns an array of block objects. For `child_page` blocks, each block has an `archived` field — but that field reflects the **block pointer's** archived state, not the linked page's.

```typescript
// What we wrote (a510ee4 — DOES NOT WORK):
const pages = childBlocks.filter((b) => !b.archived); // always lets trashed pages through

// What actually works (a33682b):
for (const block of childBlocks) {
  const page = await notion.pages.retrieve({ page_id: block.id });
  if (page.in_trash || page.archived) continue; // skip
  // ...
}
```

**Cost**: one extra `pages.retrieve` per existing matched page on re-runs. ~1 second per page. Acceptable vs. the alternative (a sync that fails after every manual delete).

### 3b. Two deletion states, not one

Notion's data model has two separate flags for "this page should not be edited":

| Flag        | Set by                                              | Reversible via                                  |
| ----------- | --------------------------------------------------- | ----------------------------------------------- |
| `archived`  | Older "Archive" action (mostly removed from UI now) | `pages.update({archived: false})`               |
| `in_trash`  | "Move to Trash" — the standard delete UI flow       | Restore from Trash UI; *not* via update API     |

Checking only `archived` (most docs and SDK examples use that) silently misses every page deleted via the normal UI flow. The user's "I deleted some pages between runs" workflow always produces `in_trash: true` pages, never `archived: true` ones. So the first set of fixes never saw the deletion state in any run that exercised them.

---

## 4. Lessons for the future

### 4a. When a fix changes the symptom but not the failure, stop patching

After commit 3 (`a668f3e`) it should have been clear that the bug was structural, not surface-level. Each successive fix made the error message shorter or moved it across phases, but the count stayed roughly the same. The signal: **error count is the dependent variable, not the error message.** If the count doesn't drop, the patch isn't a fix.

`mistake-patterns.md` already has `[root-cause]` for this — this incident is a textbook instance.

### 4b. Filter-as-no-op silently passes everything

```typescript
arr.filter((x) => !x.someFlag)
```

If `someFlag` is never `true` for items you actually wanted to filter, this filter still type-checks, still runs, and silently lets every item through. Verify the filter does work by logging *one rejected item* in a known-bad case. If you can't construct a known-bad case, the filter probably doesn't filter anything.

### 4c. Read the API response, don't trust the SDK type

Notion's TypeScript SDK exposes `archived` prominently and `in_trash` more quietly (it's there, just less documented). The TypeScript types compile either way. Reading **one** real `pages.retrieve` response in a debugger / `console.log(JSON.stringify(page, null, 2))` would have surfaced both fields immediately. Pure-TypeScript debugging missed it for three days.

### 4d. Distributed APIs don't have read-after-write

`pages.update({archived: false})` returning 200 OK does **not** mean the next read on a child page will see the unarchived state. Notion is eventually consistent here; documented or not. The `await sleep(3000)` patch in `bd0c509` was a band-aid that worked sometimes — the better fix (`53508f8`) was to not rely on the unarchive at all and create a fresh page instead.

> Generalize: when an API call mutates state, the response gives you success of the *write*, not the *visibility* of the new state. Subsequent reads in the same code path may still see stale.

### 4e. "Manually-deleted between runs" is a real failure mode

The unspoken assumption in the original code was: pages we created are pages we own; they don't disappear. In practice, the user *will* delete pages between syncs (mistakes, restructuring, content moves). The script needs to handle this without reporting an error — that's a normal user action, not an exception. The current behavior (treat trashed pages as non-existent and re-create) is correct.

---

## 5. What changed in code, summarized

The current implementation (`a33682b` and after) does:

1. **Phase 1 only**: when `listChildPages` returns a title match, immediately `pages.retrieve` to read true state. If `page.in_trash || page.archived`, skip — caller falls through to `pages.create`.
2. **No Phase 2 unarchive logic.** Phase 2 trusts that Phase 1 only put valid (non-deleted) page IDs into `pageIdMap`.
3. **Suspicion checks suppressed for `validation_error`**: WAF rules don't apply to API-level errors (archive, invalid property, missing parent). `error_summary[*].suspicions` stays clean.

Net cost: one `pages.retrieve` per existing matched page. Net benefit: zero archived-block errors on subsequent runs.

---

## 6. Diagnostic recipe for future "archived" incidents

If errors of the form `Can't edit block that is archived` or `Can't edit page on block with an archived ancestor` show up again:

```bash
# 1. Get the latest run's failed paths
bash list.sh recent-errors

# 2. For one failed path, check actual state in Notion:
#    (replace PAGE_ID with the parent section page ID from the run log)
node -e "
  const {Client}=require('@notionhq/client');
  const c=new Client({auth:process.env.NOTION_TOKEN});
  c.pages.retrieve({page_id:'PAGE_ID'}).then(p=>console.log({
    archived:p.archived, in_trash:p.in_trash, last_edited:p.last_edited_time
  }));
"

# 3. If archived || in_trash → user deleted/archived this page between runs.
#    Expected behavior: re-run sync, Phase 1 will skip + re-create.

# 4. If neither → bug is elsewhere. Check pageIdMap construction,
#    look for a stale .notion-cache.json, or a parent at a deeper level.
```

---

## 7. Related artifacts

- `run-notes.md` 2026-04-29 / 2026-04-30 entries — chronological discovery log written as the bug surfaced. Some claims there were superseded by later findings; this RCA is the consolidated truth.
- `index.ts` `getOrCreateChildPage` — the load-bearing function. The `pages.retrieve` call lives here.
- `index.ts` `listChildPages` — kept simple now, with a comment explaining why no `block.archived` filter is needed (it never worked).

If a future agent is debugging similar symptoms, **read this file before attempting a fix.** The trap is repeatable; spending the days again is not.
