# Reconciliation Flow — Design Exploration

> **Status:** v2 — all four PRs done (2026-05-06). PR 1 ✓, PR 2 ✓, PR 3 ✓ pull path, PR 4 ✓ auto-prompt + `/sync-all` integration + USAGE.md tutorial.
> **Builds on:** [OVERWRITE-GUARDRAILS-EXPLORATION.md](OVERWRITE-GUARDRAILS-EXPLORATION.md) — guardrails ship the divergence detection; this spec ships what the user does about it.
> **Verdict:** Approved post-review (see §"Review Outcome" below).

## PR 1 + 2 closeout — what shipped

- `reconcile.ts` (~520 LOC) with kind-specific menus, ← Back navigation, gum + readline fallback.
- `bash sync.sh reconcile [paths...]` dispatch + help text.
- Schema migration: `runs.jsonl.protected_pages[].kind` → `kinds: string[]` + `details: string[]`.
- `checkDivergence` returns `Divergence[]` (closed the moved+user-edited data-loss leak the reviewer flagged).
- State mutations (`accept-move`, `accept-archive`) land per-page; resumable via atomic `saveState`.
- Push-needed resolutions print bash commands; `move-back`/`force-recreate` re-run a user-edit re-check at apply-time.
- **Live re-check** (added during testing — not in original spec): every reconcile invocation re-validates each protected page against current Notion state, filtering out previously-resolved entries automatically. Closes the concurrent-edit window between Phase 1.7 and the moment the user picks a resolution.
- USAGE.md §11.5 documents the full UX. CLAUDE.md updated with new files + env var.

## TL;DR

A guided per-page resolution flow for protected pages. Five divergence kinds, each with a kind-specific menu. v1 ships a **dry-run-by-default skeleton** that prints decisions without executing — the actual writes land in PR 2. The "Pull Notion → local" path uses the SDK's `pages.retrieveMarkdown` (probe confirmed working). v1 explicitly does **not** auto-run a follow-up sync; instead it prints the exact `bash sync.sh ...` command for the user to run.

## Why this matters

The guardrails work landed in this branch detects divergence between local docs and Notion (`user-edited`, `moved`, `moved-out`, `archived`, `benign-drift`) and writes them as `protected_pages[]` in `runs.jsonl`. Today the user gets a printed list with copy-paste flags (`--force-overwrite`, `--accept-move`, `--accept-archive`).

That's the floor, not the ceiling. The flags are blunt — they don't help the user **decide**. Without a guided flow:

- Users will default to `--force-overwrite` because it's the obvious "make it go away" answer, silently losing Notion edits.
- Move detection becomes noise users learn to ignore.
- The "pull Notion → local" path (which the V2 shelf calls notion-pull) is needed in tiny per-page form right now, even if full bidirectional sync stays deferred.

The reconciliation flow turns the protected-pages list into a structured decision per page, and routes each decision to the right action.

## Goals (and how we'll validate them)

| Goal | Validation |
|---|---|
| **No silent data loss.** Notion edits never get blown away without the user explicitly choosing "local wins". | Manually edit a page in Notion → run sync → reconcile → confirm "Pull from Notion" preserves the human edits in the local file. |
| **Decision support, not just escape hatches.** Each divergence kind has a kind-specific menu, not the same three flags. | Read the menu output for each of `user-edited`, `moved`, `moved-out`, `archived` and confirm choices are tailored. |
| **Match existing UX.** Gum-driven prompts that feel like the `sync.sh` wizard. | Visual review against `sync.sh` wizard's style: same colors, same `gum confirm`/`gum choose` patterns. |
| **Idempotent.** Running reconcile twice with nothing changed is a no-op. | After resolving everything, re-run reconcile → "Nothing to reconcile." |
| **Resumable.** Closing mid-flow and re-running picks up where we left off. | Resolve 1 of 3, kill, re-run → only 2 remaining. |
| **No coupling to sync.** Reconciliation can run standalone (`bash sync.sh reconcile`) without triggering a fresh sync. | Run `reconcile` against a clean repo (last sync was hours ago) and confirm it reads from `runs.jsonl`. |

## Non-goals

- **Full bidirectional sync.** This is per-page reconciliation, not a long-running pull-then-push loop.
- **Three-way merge UI.** If user wants merge, they get a diff view and resolve in their editor, not in-flow.
- **Automatic resolution heuristics.** No "if local is newer, pick local" logic. The user always chooses.
- **Multi-doc batch decisions.** Each protected page resolves individually. (Possible future v2: "apply this choice to all `moved` divergences," but not v1.)

## Inputs

The flow reads two artifacts already produced by the guardrails work:

1. **`runs.jsonl`** — last entry's `protected_pages[]` is the work queue.
2. **`.notion-sync-state.json`** — the baseline. Updated as reconciliation choices land.

Plus the live Notion API (one `pages.retrieve` per page being reconciled, plus an `pages.retrievePageMarkdown` for the "pull" path — see Open Questions below for SDK availability).

## Output

For each protected page, the user makes one of these choices, and the flow executes it:

| Divergence kind | Menu options |
|---|---|
| **`user-edited`** | 1. **Pull Notion → local** (overwrites the local file, optionally `git diff` for review)<br>2. **Keep local, overwrite Notion** (= `--force-overwrite`)<br>3. **View diff first** (then loops back to this menu)<br>4. **Skip — leave protected** |
| **`moved`** | 1. **Accept the move** (update baseline, leave page where the human put it)<br>2. **Move it back to expected parent** (re-parents via API + force-overwrite content)<br>3. **Skip** |
| **`moved-out`** | 1. **Accept — this doc is no longer ours** (drop from state, optionally `git rm` the local file)<br>2. **Re-create at original location** (force-create new page, push content)<br>3. **Skip** |
| **`archived`** | 1. **Accept the archive** (drop state entry, optionally `git rm` the local file)<br>2. **Un-archive instructions** (we can't always un-archive via API; print the URL + steps)<br>3. **Force-recreate** (new page at expected location, push content)<br>4. **Skip** |
| **`benign-drift`** | Auto-resolved — no prompt. Print "next sync auto-clears" and update baseline. |

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  bash sync.sh reconcile [<path>...]                               │
│  bash list.sh reconcile                                           │
│      │                                                             │
│      ▼                                                             │
│  reconcile.ts                                                     │
│      │                                                             │
│      ├─ readLastRunProtected() ── runs.jsonl: tail -1 → JSON       │
│      ├─ filterByPath(args)                                         │
│      └─ for each protected_page:                                   │
│             │                                                      │
│             ├─ printDivergenceCard(page)                           │
│             ├─ choice = gum choose [kind-specific menu]            │
│             ├─ resolve(page, choice)                               │
│             │     ├─ user-edited:                                  │
│             │     │     ├─ pull   ─── exportMarkdown → write file  │
│             │     │     ├─ force  ─── set forceOverwritePaths      │
│             │     │     ├─ diff   ─── exportMarkdown → diff → loop │
│             │     │     └─ skip                                    │
│             │     ├─ moved:                                        │
│             │     │     ├─ accept ─── update baseline.parent       │
│             │     │     ├─ move-back ─── pages.update + force      │
│             │     │     └─ skip                                    │
│             │     ├─ moved-out / archived: similar                 │
│             │     └─ benign-drift: auto                            │
│             │                                                      │
│             └─ saveState() after each resolution                   │
│                                                                    │
│  When force-* or push-back chosen, end-of-flow runs:               │
│      bash sync.sh --no-wizard --only <paths> --force-overwrite ... │
└────────────────────────────────────────────────────────────────────┘
```

### Module: `reconcile.ts`

Standalone TS file alongside `sync-state.ts`. Imports the Notion client, sync-state helpers, and one new helper (`pullPageMarkdown`).

```ts
// reconcile.ts (sketch)
import { Client } from "@notionhq/client";
import { loadState, saveState, ... } from "./sync-state";

export async function reconcile(opts: {
  paths?: string[];     // optional filter; default = all protected from last run
  autoPull?: boolean;   // skip prompts, pick "Pull Notion" for every user-edited (rare; explicit opt-in)
  dryRun?: boolean;     // print decisions without executing
}): Promise<ReconcileSummary>;

interface Resolution {
  path: string;
  divergence_kind: string;
  choice: "pull" | "force" | "accept-move" | "accept-archive" | "move-back" | "recreate" | "skip" | "auto";
  applied: boolean;
  details?: string;
}

interface ReconcileSummary {
  resolutions: Resolution[];
  pending_pushes: string[];   // paths that need a follow-up sync write
  errors: { path: string; error: string }[];
}
```

### CLI surface

```
bash sync.sh reconcile                           # reads last runs.jsonl protected_pages[]
bash sync.sh reconcile <path>                    # only this page
bash sync.sh reconcile --auto-pull               # batch — every user-edited becomes a pull
bash sync.sh reconcile --dry-run                 # print decisions, no writes
```

Internally `sync.sh` matches `reconcile` as the first arg and shells into `bun reconcile.ts`.

### After reconciliation: the follow-up push

Many resolutions need a follow-up Phase 2 write (force-overwrite, move-back, recreate). Two strategies:

**A. Inline.** `reconcile.ts` collects pending paths and shells out to `bash sync.sh --no-wizard --only <paths> --force-overwrite <paths>` at the end. Pros: single command, user sees full result. Cons: shells back into the wizard's setup overhead (env vars, defaults file, gum prep).

**B. Print and ask.** After resolutions land, print the exact retry command and exit. User runs it. Pros: clean separation. Cons: two-step.

Proposal: **A by default, with `--no-followup` to switch to B.** Mirrors the existing `bash sync.sh` wizard's "Proceed?" pattern at end.

## The "Pull Notion → local" path — sub-design

This is the only genuinely new write path. Everything else is wiring existing flags.

### What it must do

1. **Retrieve the page's content as markdown.** Notion v5 SDK exposes `pages.retrievePageMarkdown` (need to verify name during impl). If unavailable, fall back to walking blocks via `blocks.children.list` and serializing — but that's significant work.
2. **Strip our own footer.** Every page we sync has `\n\n---\n\n*Synced: <ts>*\n` appended. Reconciliation pulls should strip this before writing local.
3. **Strip the breadcrumb + meta-banner.** The first ~5-10 lines we add for navigation should not bleed into the local source.
4. **Preserve frontmatter.** The local file's YAML frontmatter (`icon:`, `cover:`) is NOT in Notion (icon/cover live in page metadata). Pull must merge: keep local frontmatter, replace body with Notion content.
5. **Write atomically.** Tmp-file + rename. Same pattern as `saveState`.
6. **Show a diff.** Print `diff -u local-original pulled` (or just hint at `git diff`).
7. **Re-baseline.** After write, the next sync will compare against the same Notion state — no re-flag.

### Open question — block-level fidelity

Markdown ↔ Notion-blocks is **lossy in both directions**. The Notion API's markdown export doesn't perfectly round-trip every block type. So a "pull → push" cycle may produce a non-identity transformation:

- Toggle blocks → flatten or collapse?
- Synced blocks → resolve once?
- Database links → markdown link with title?
- Equations, code with line numbers, mention-pills?

For v1, we accept this lossiness and document it: **"Reconciliation pull captures the page's textual content. Some block types may render differently in markdown."** Users who want bit-exact preservation should resolve in Notion's UI and re-pull.

### Implementation plan for pull

```ts
async function pullPageMarkdown(notion: Client, pageId: string): Promise<string> {
  // Notion SDK v5 — verify exact signature in impl
  const md: any = await notion.pages.retrievePageMarkdown({ page_id: pageId });
  return md.markdown ?? md;  // shape TBD
}

function stripSyncFooter(md: string): string {
  // Remove trailing "\n\n---\n\n*Synced: ...*\n"
  return md.replace(/\n+---\n+\*Synced:[^\n]+\*\n*$/, "\n");
}

function stripBreadcrumbAndBanner(md: string): string {
  // Drop everything before the first H1 (typically "# Title").
  // Belt and suspenders: also drop callout blocks at the top that look like our meta-banner.
  const h1 = md.search(/^#\s/m);
  return h1 >= 0 ? md.slice(h1) : md;
}

function mergeWithLocalFrontmatter(localPath: string, notionBody: string): string {
  const local = fs.readFileSync(localPath, "utf-8");
  const fmMatch = local.match(/^---\n[\s\S]*?\n---\n/);
  return fmMatch ? `${fmMatch[0]}\n${notionBody}` : notionBody;
}
```

## Idempotency & resumability

The flow's state lives in two files:

- **`runs.jsonl`** — append-only. The work queue is the *last* entry's `protected_pages[]`. As resolutions land, they're not removed from this file (we don't mutate runs.jsonl). Instead:
- **`.notion-sync-state.json`** — when a resolution updates a baseline, the next run's Phase 1.7 won't re-flag that page. So the second `reconcile` invocation simply finds nothing to do.

For pages where the user chose "Skip", the next run flags them again — exactly the intended behavior.

For mid-flow interruption: each resolution calls `saveState(syncState)` immediately after applying. So a Ctrl-C between page 2 and page 3 leaves pages 1-2 resolved on disk, page 3 still pending. Re-running picks up at page 3.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| **`pages.retrievePageMarkdown` may not exist or have a different name in SDK v5.** | Probe at impl-start; fall back to block-walk serialization if needed. Keep design valid either way — only the function body changes. |
| **Pull strips local-only frontmatter `icon:` if we're not careful.** | Mandatory frontmatter merge (sub-design above). Add a unit-equivalent test: pull a page with frontmatter, verify it's preserved. |
| **The user picks "Pull from Notion" but local has uncommitted git changes that get clobbered.** | Pre-flight: run `git status -- <path>` and refuse to pull if dirty unless `--force-pull` flag passed. |
| **A divergence kind we didn't enumerate (new failure mode added later).** | Default branch in the resolve switch: print the page, hand the user a `--force-overwrite` hint, log to runs.jsonl. Never crash. |
| **Reconcile auto-prompt at end of sync becomes annoying.** | Default it to OFF for v1. Sync prints "X protected — run `bash sync.sh reconcile` to resolve." User opts in. Reverse later if usage data justifies. |
| **`/sync-all` skill needs to know about reconciliation as a follow-up step.** | Update the skill's prompt to mention "if protected_pages > 0, suggest /reconcile or `bash sync.sh reconcile`". |

## Open questions — RESOLVED (2026-05-06)

| # | Question | Answer |
|---|---|---|
| 1 | Auto-prompt at end of sync? | **Yes — default ON.** End of sync prompts "X protected. Reconcile now? [Y/n]" with default Y. |
| 2 | `reconcile` command home? | **`sync.sh reconcile`.** Not list.sh. Discoverability beats the read-only/write split. |
| 3 | Pull-then-push automatic? | **No — user inspects, then re-runs sync.** Pull leaves the local file dirty. The flow prints `git diff <path>` and the next-step `bash sync.sh --only ...` command. User chooses when to push. |
| 4 | Diff viewer? | **Both.** Default to `git diff --no-index` (external, leverages user's pager + colors). Fall back to a gum-rendered inline diff if git isn't available, OR if user passes `--inline-diff`. |
| 5 | Multi-doc batch resolution? | **Deferred.** v1 is per-page. Single-doc workflow must support easy back-and-forth: top-of-flow checkbox lets the user pick a subset, and within the walk, "← back to previous page" is allowed. |
| 6 | Git pre-flight on pull? | **Yes, but defensive.** Don't crash if git is missing. Scope `git status --porcelain` to the docs folder only. Filter to `.md` files (ignore `.DS_Store`, `.notion-cache.json`, anything not in the doc tree). Override: `--force-pull` skips the check. |
| 7 | Duplicate-from-archive (page archived in Notion → push created a fresh duplicate, now both exist) | **v1: just push again.** Acceptable for now. Add TODO comment in `reconcile.ts` referencing this exploration doc. Future: a mini-spec for archive recovery. |

## Validation plan (before writing code)

The design is approved when:

- [ ] All six goals above have a concrete validation step.
- [ ] Each divergence kind has a defined menu.
- [ ] The pull-path subdesign answers: where does frontmatter go, how do we strip our footer, how do we test for round-trip lossiness.
- [ ] Risks are listed with mitigations.
- [ ] Implementation plan exists with file boundaries (`reconcile.ts`, `sync.sh` glue, follow-up push command).
- [ ] At least one external review (sub-agent) has scrutinized for missing edge cases.

---

## Appendix — Pseudocode walkthrough for a `user-edited` resolution

```
$ bash sync.sh reconcile

Reading last run: 20260506-022050
3 page(s) protected. Reconciling…

────────────────────────────────────────────────────────────────────
[1/3]  product/jobs/create-upload.md
       ↳ Edited by human at 2026-05-06T03:14:00Z
       ↳ View: https://www.notion.so/352bacd2…

       What would you like to do?
       ▸ Pull Notion → local (preserve human edits)
         Keep local, overwrite Notion
         View diff first
         Skip for now

> [user picks "View diff first"]

  Fetching Notion content…
  Differences (- local, + Notion):
    @@ -42,7 +42,7 @@
    -**Tip:** Validate inputs before submitting.
    +**Tip:** Validate inputs before submitting. Backend rejects empty arrays.
  …

       ▸ Pull Notion → local
         Keep local, overwrite Notion
         View diff again
         Skip

> [user picks "Pull Notion → local"]

  Pre-flight: git status -- product/jobs/create-upload.md
  Clean — proceeding.
  Fetching Notion content…
  Stripping sync footer + breadcrumb…
  Merging with local frontmatter (icon: ⬆️)…
  Writing docs/product/jobs/create-upload.md
  Re-baseline: last_pushed_edited_time updated to 2026-05-06T03:14:00Z

  ✓ Resolved: pulled human edits to local file.
  ▸ Inspect: git diff docs/product/jobs/create-upload.md

[2/3]  product/billing/index.md
       ↳ Page moved (parent changed from 34abacd2… → 89ed8431…)
       …
```

---

# Review Outcome

The draft above (sections "Why this matters" through "Pseudocode walkthrough") was reviewed by an opus sub-agent. The verdict was **ship with revisions**. Three load-bearing issues + several smaller fixes. Each is addressed below with my position and the chosen resolution.

## Issue 1 — Unverified SDK assumption ✅ RESOLVED

**Reviewer:** "The entire `user-edited` branch depends on `pages.retrievePageMarkdown` existing. Probe before approving."

**Resolution.** Probe complete. SDK exposes `notion.pages.retrieveMarkdown({page_id})`. Live response shape:

```jsonc
{
  "object": "page_markdown",
  "id": "...",
  "markdown": "<full markdown body>",
  "truncated": false,           // ← NEW: design must handle
  "unknown_block_ids": [],      // ← NEW: design must handle
  "request_id": "..."
}
```

**Two design additions follow from the actual response shape:**

a. **`truncated: true` is fatal for reconciliation.** A truncated pull would write an incomplete file and re-baseline against an outgoing diff that doesn't exist locally. If the response is truncated, abort the pull, surface the URL, and tell the user to resolve in Notion's UI. Do not write a partial file.

b. **`unknown_block_ids: [...]` means lossy round-trip.** If non-empty, prompt the user before writing: "N block(s) couldn't be serialized as markdown — review Notion side first." Allow override with `--accept-lossy-pull`.

**Plus a third issue that surfaced from the actual markdown:** Notion serializes mentions as a custom tag — `<mention-page url="...">Title</mention-page>`. Our `mention-converter.ts` matches markdown links, not these tags. Either:
- Strip-and-convert at pull time: `<mention-page url="X">Y</mention-page>` → `[Y](X)`. Round-trip stable on next push.
- Leave them; on next push, mention-converter ignores them, they render as broken text in Notion.

Pick **strip-and-convert.** Document in the pull-path subdesign.

## Issue 2 — Data-loss leak in `moved` / `archived` ✅ ACCEPTED, FIXING

**Reviewer:** "`checkDivergence` short-circuits on `archived`, then `moved`, then reaches `user-edited`. A page that's both moved AND edited gets flagged as `moved`. The 'Move it back + force-overwrite' menu option silently overwrites the human's edits."

**This is a real hole.** Confirmed by reading `sync-state.ts:checkDivergence` — the early-return order is `archived` → `moved` → `user-edited`. The current "Move it back" UX advertises clean re-parent; it actually overwrites unflagged edits.

**Resolution.** Two changes:

a. **`checkDivergence` returns ALL applicable divergences, not just the first.** Refactor `checkDivergence` to return `Divergence[]` instead of `Divergence | null`. The protected_pages entry can carry multiple kinds (e.g., `["moved", "user-edited"]`). The reconciliation menu then composes options across kinds.

b. **For any "force-overwrite content" path under `moved`/`archived`, re-run the user-edited check before the write.** Even if (a) ships, the second check is cheap insurance: one extra `pages.retrieve` per resolved page. If user-edited divergence is detected at write-time, abort and re-prompt.

This requires reopening the guardrails work — the schema change to `protected_pages[]` is non-trivial but small. Better to fix this now than to ship a known data-loss path.

## Issue 3 — Resumability vs end-of-flow batch push ✅ ACCEPTED, SIMPLIFYING

**Reviewer:** "Per-resolution `saveState` plus end-of-flow shell-out is contradictory. Ctrl-C between resolution 2 (force-overwrite chosen) and resolution 3 leaves baseline updated for nothing — the force-overwrite never executed."

**Resolution.** Drop the inline shell-out path entirely for v1. Use **option B (print-and-ask)** only:

```
Reconciliation complete.

  Force-overwrite needed for 2 page(s):
    bash sync.sh --no-wizard --only create-upload billing/index --force-overwrite product/jobs/create-upload.md product/billing/index.md

  Pull-then-push needed for 1 page(s) (already pulled, run a sync to push refreshed local):
    bash sync.sh --no-wizard --only files-browser

Run the commands above in order.
```

Honest, testable, dodges all the wizard-state coupling failure modes the reviewer enumerated (`DRY_RUN=1` in saved defaults, argv overflow, validator surprises). Promote to inline shell-out only after the print-and-ask flow has run for a release and the failure surface is understood.

## Smaller fixes (all accepted)

| # | Reviewer point | Resolution |
|---|---|---|
| 1 | Concurrent edits between Phase 1.7 and pull | Re-retrieve `last_edited_time` immediately AFTER the pull and persist *that* value as the new baseline. One extra retrieve per pull; cheap. |
| 2 | Last `runs.jsonl` entry was `--dry-run` | Walk `runs.jsonl` backwards to the most recent **non-dry-run, non-partial** entry. Refuse with a clear error if none in the last 50 entries. |
| 3 | `--only` semantics mismatch (sync uses section names, reconcile design uses paths) | Reconcile accepts both — same matching logic as `shouldSync` (basename / base / exact / prefix). Document explicitly. |
| 4 | Subpages of a protected section page | Document explicitly: child pages are not implicitly protected. The user can decide independently per page. If they want all-of-section, they can `bash sync.sh reconcile product/jobs/`. |
| 5 | Skip-this-one vs cancel-the-flow | Skip is its own menu option. Esc/Ctrl-C aborts the whole flow (returns gum's 130). Don't conflate. |
| 6 | Frontmatter merge — what if Notion gained an icon the local doesn't have? | Show a "Notion has icon X, local has icon Y. Merge from Notion?" prompt during pull. v1 default: keep local. |
| 7 | Sequential walk past 5 pages is slow | Add a top-of-flow gum-checkbox: "Resolve which pages? (all selected by default)" — lets the user trim the queue before starting. |
| 8 | `benign-drift` doesn't need a menu | Auto-resolved silently. Just refresh the baseline + log "auto-resolved" in the summary. |
| 9 | `--auto-pull` flag overcomplicates v1 | Cut. v1 is fully interactive. |
| 10 | Internal vs external diff viewer | External: shell out to `git diff --no-index <local> <pulled.tmp>` since git is already a hard project dependency. No `delta`/internal renderer. |
| 11 | Pre-flight `git status` check on pull paths | Yes. Refuse to overwrite a dirty file unless `--force-pull` is passed. |
| 12 | Doc length | Cut by ~40%. The "Pseudocode walkthrough" appendix is the load-bearing example; everything else trims. (This revision pass adds length but the next pass will strip the original draft sections that are now superseded.) |

## Issues my draft missed entirely

- **Truncation handling** (from the SDK probe). New requirement.
- **`unknown_block_ids` handling** (from the SDK probe). New requirement.
- **Mention-tag conversion at pull time** (from inspecting the actual markdown export). New requirement.

---

# Implementation Plan

Following the reviewer's recommended PR breakdown, with the issue-1/2/3 resolutions folded in. Each PR is independently shippable and reversible.

## PR 1 — Skeleton + dry-run only (no writes)

**Goal:** Land the CLI surface, the menu structure, the runs.jsonl filtering, and the kind-specific decision UX. **Zero writes.** Every action only logs intent.

**Files:**
- `reconcile.ts` — new module. `readLastLiveRun()`, `printDivergenceCard()`, `promptForKind()`, `recordDecision()`. Returns a structured plan.
- `sync.sh` — match `reconcile` as the first arg → `bun reconcile.ts <remaining args>`.
- `list.sh` — add `reconcile` as an alias that delegates to `sync.sh reconcile`.
- `RECONCILIATION-EXPLORATION.md` — trim original-draft sections superseded by the post-review revisions (per smaller-fix #12).

**Schema change:** None. Reads existing `runs.jsonl` and `.notion-sync-state.json`.

**Done when:**
- `bash sync.sh reconcile` walks last live run's `protected_pages[]`, prompts gum-style per page, prints the resolution it would have applied, exits clean.
- `bash sync.sh reconcile --only <path>` filters.
- A dry-run `runs.jsonl` entry is correctly skipped (walks backwards to most recent live entry).
- `bash sync.sh reconcile` against a clean repo (last entry has `protected_pages: []`) prints "Nothing to reconcile" and exits 0.

**Out of scope (PR 2+):** Any actual file writes. Pull from Notion. Any `--accept-*` state mutation. Any push.

## PR 2 — Multi-divergence schema + non-pull resolutions

**Goal:** Address Issue 2 from the review (data-loss leak). Refactor guardrails to support multiple divergence kinds per page. Wire up every resolution that doesn't require Notion content fetching.

**Files:**
- `sync-state.ts` — `checkDivergence` returns `Divergence[]` instead of `Divergence | null`. Update `formatDivergences` and `Divergence` types accordingly. **Schema bump: `runs.jsonl.protected_pages[].kind` becomes `kinds: string[]`.** This is a breaking schema change for `/sync-all` and any downstream readers; coordinate.
- `index.ts` — Phase 1.7 collects all divergences, not just the first. The `protectedDivergence` arg to `writeFileContent` becomes `Divergence[]`.
- `reconcile.ts` — apply `accept-move`, `accept-archive`, `move-back` (state-only update of `expected_parent_id`), `recreate` (state-only deletion), `force-overwrite` (records intent, doesn't push). End-of-flow prints the `bash sync.sh ...` command for any pending pushes (per Issue 3 resolution).
- For `moved`/`archived` write paths: re-run a synchronous user-edited check inside `reconcile.ts` before mutating state, even if the divergence list said only "moved". Belt-and-suspenders against partial baselines.

**Done when:**
- A page that's both moved AND edited shows up with `kinds: ["moved", "user-edited"]` in `runs.jsonl`.
- "Move it back" prompt for that page surfaces both kinds; user is forced to address the edit too before the move-back is queued.
- All non-pull menu options work end-to-end: state mutates, next sync respects the new baseline, the user gets a print-and-ask follow-up command.
- `/sync-all` skill updated to read `kinds: string[]` instead of `kind: string`.

## PR 3 — Pull path

**Goal:** Implement "Pull Notion → local" with the design additions from Issue 1's resolution.

**Files:**
- `reconcile.ts` — new functions `pullPageMarkdown()`, `stripSyncFooter()`, `stripBreadcrumbAndBanner()`, `convertMentionTagsToLinks()`, `mergeWithLocalFrontmatter()`, `gitStatusClean()`.
- Pull workflow:
  1. `gitStatusClean(localPath)` — abort with hint if dirty unless `--force-pull`.
  2. `notion.pages.retrieveMarkdown({page_id})` — abort if `truncated === true`. Prompt if `unknown_block_ids.length > 0` (override: `--accept-lossy-pull`).
  3. Strip our sync footer (`\n\n---\n\n*Synced: ...*\n`).
  4. Strip the breadcrumb + meta-banner (everything before first H1).
  5. Convert `<mention-page url="X">Y</mention-page>` → `[Y](X)`.
  6. Merge with local frontmatter (preserve `icon:`, `cover:`).
  7. Atomic write (`<path>.tmp` + rename).
  8. Re-retrieve `last_edited_time` post-pull (Issue-1.a fix); update baseline.
  9. Print `git diff` hint.

**Done when:**
- Pull on a Notion-edited page produces a local file containing the human's edits, with frontmatter preserved, footer stripped, mentions converted to markdown links.
- `truncated: true` aborts cleanly with URL printed.
- `unknown_block_ids: [...]` prompts user, allows override with `--accept-lossy-pull`.
- Concurrent-edit window is closed: post-pull baseline matches the moment we pulled, not the moment Phase 1.7 ran.

## PR 4 — Auto-prompt + `/sync-all` integration + docs

**Goal:** Smooth integration once PR 1-3 have run for a few syncs.

**Files:**
- `index.ts` — at end of sync, if `protectedResults.length > 0`, prompt: **"X protected. Reconcile now? [Y/n]"** with default **Y** (per Q1 answer). User can decline; runs the reconcile flow inline if accepted.
- `.claude/skills/sync-all/SKILL.md` — when summary shows `protected_pages > 0`, suggest `bash sync.sh reconcile` as the next action. Include a one-line "what this means" gloss.
- USAGE.md — add a "Reconciliation" section.

**Done when:**
- The complete flow (sync → guardrails fire → reconcile → push) is documented as a tutorial in USAGE.md.
- `/sync-all` surfaces protected pages in its summary report.

---

# Validation against original goals

| Goal | How v1 (PRs 1-3) satisfies it |
|---|---|
| **No silent data loss** | `kinds: string[]` schema + re-check at write time means a moved-and-edited page surfaces both. Pull path's post-pull baseline closes the concurrent-edit window. `truncated` aborts cleanly. |
| **Decision support, not escape hatches** | Five kind-specific menus, each with 2-4 options tailored to that divergence type. |
| **Match existing UX** | Gum prompts identical in style to `sync.sh` wizard. |
| **Idempotent** | State mutations land per-resolution. Re-running on resolved pages finds nothing. |
| **Resumable** | Per-resolution `saveState` + no inline batch push (per Issue 3 resolution) means Ctrl-C never leaves a half-applied state. |
| **No coupling to sync** | Reads only `runs.jsonl` + `.notion-sync-state.json`. Writes only `.notion-sync-state.json` and the local doc file. Print-and-ask for any push. |
