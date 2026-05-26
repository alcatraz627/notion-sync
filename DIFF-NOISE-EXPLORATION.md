# diff-content noise — consolidated master catalog (2026-05-27)

Merged from 3 parallel scan agents over **90 files** (3 disjoint 30-file manifests),
`.notion-diff-cache.36bbacd27dee.json`. Source reports: `scan-agent-{1,2,3}.md`.

**Dataset invariant:** REMOTE was never human-edited → **every `baseToRemoteDiff`
segment is a normalization/round-trip artifact (pure noise).** ~3,700 REMOTE-side
segments analyzed across the three batches.

> **Counts are word-diff *segments*, not lines.** `git --word-diff=plain` splits at
> whitespace, so one changed line shatters into many `{+..+}`/`[-..-]` tokens.
> Links / bold / emphasis over-represent line impact. Treat counts as **relative
> severity**, not literal lines.

---

## FIX — high impact (the core list)

| # | Pattern | Severity | Files | Proposed normalization (in `normalizeForDiff`, both sides unless noted) |
|---|---------|---------:|------:|------------------------------------------------------------------------|
| **F1** | **Frontmatter block** — `---`/`icon:`/`status:`/`audience:`/`last_updated:`/`cover:`/`tags:`/`related:`/`owner:` | ★★★★★ | ~80/90 | Strip the leading `---…---` YAML block. **Root cause: stale BASE** — base snapshots lack frontmatter, local+remote both have it *identically*. Frontmatter is never pushed to Notion, so the diff should never see it. #1 source. |
| **F2** | **Emphasis delimiter** — `_italic_` ↔ `*italic*` | ★★★★★ | ~70/90 | Canonicalize single-marker italic to one delimiter, **outside** code spans/fences (protect `snake_case`). Widest file spread; the `_Last synced…_` footer is the biggest single carrier. |
| **F3** | **Link anchor + path** — `` [`x.md`](./y.md#frag) `` → `[y.md](y.md)` | ★★★★★ | ~45/90 | Three coupled sub-transforms: (a) strip backticks from anchor text; (b) for `.md` links, ignore/canonicalize anchor text (mention round-trip rewrites it to the target/title); (c) normalize target — drop leading `./`, drop `#fragment`, canonicalize `../`. |
| **F4** | **Bold+inline-code doubling** — `**\`x\`**` → `****\`x\`****` | ★★★★ | ~46/90 | Collapse runs of 3+ `*` to `**` (guard legit `***bold-italic***`). Notion re-emits bold-around-code with redundant `**`. |
| **F5** | **Widen the backslash-unescape set** — add `~ $ [ ] < > { } \| _ * #` | ★★★★ | ~30/90 | Current set is only `[>!\-=().,;:?]`. Notion escapes far more: `\~`(strike/approx), `\$`(Mongo ops), `\[ \]`(STUB tags), `\< \>`(TS generics/autolink), `\{ \} \|`(unions/JSX), `\_`,`\*`,`\#`(anchors). **One fix subsumes known #4 and #6** + several NEW. Apply both sides; leave `\\` and in-fence code alone. |
| **F6** | **Strip Notion-export HTML** — `<callout…>`,`</callout>`,`<aside>`,`<details>`,`<columns>`,`<span color=…>` + HTML comments `<!-- sherpa -->`/`<!-- claude -->` | ★★★ | ~75/90 | Strip export wrapper tags + HTML comments on both sides. **(See decision D1 on claude/sherpa comments.)** |
| **F7** | **Backlinks callout** — `🔗 Linked from …` block (REMOTE-only) | ★★★ | ~75/90 | Drop the marker-bounded `🔗 Linked from` block before diffing — it's tool-injected on Notion, guaranteed-absent locally. |
| **F8** | **Table content-cell padding** — `\| In scope     \|` vs `\| In scope \|` | ★★ | ~7/90 | Extend the separator-row normalization to content rows: trim cell edges + collapse internal space runs to one. |

---

## FIX — low volume / narrow (cheap add-ons)

| # | Pattern | Files | Fix |
|---|---------|------:|-----|
| F9 | **Ordered-list renumbering** `1.` ↔ `1)` / re-sequenced | ~3 | Canonicalize ordered-marker punctuation; optionally renumber to `N.`. High segment count but very narrow file spread. |
| F10 | **Bare-domain autolink** `amazon.com` → `[amazon.com](http://amazon.com)` | ~2 | Collapse `[X](http(s)://X)` to `X` when anchor == host (table-heavy docs). |
| F11 | **Unicode bullets** `•` / `‣` → `-` | ~8 | Map unicode bullet glyphs to `-`. |
| F12 | **GitHub-URL angle-autolink** `](<https://…>)` → `](https://…)` | ~2 | Strip `<>` wrapper around bare URLs in link targets (overlaps F5's `< >`). |
| F13 | **Slack URL scheme** `…slack.com/archives/Cxxx` ↔ `slackChannel://…slack.com/Cxxx` | ~1 | Canonicalize the two schemes. Niche (one file). |
| F14 | **Unordered marker** `*` / `+` → `-` | few | Canonicalize unordered bullet marker. |

---

## IGNORE — genuine content, risky, or absent

| Pattern | Why ignore |
|---------|------------|
| **OTHER residual** (~140 segs) | Genuine content split by word-diff: inline-code fragments, code-block tokens, reference-link labels (`[Task]:`), the `## See also` heading, real prose/number/date edits. No sub-pattern > ~5×. These are the *real* diffs the tool must keep showing. |
| **en/em dashes** `–` `—` | Author-intended typography ("Phases 1–4"); normalizing risks masking a real edit. |
| **checkbox** `[ ]` / `[x]` | Genuine task state in `todo.md`. |
| **ellipsis** `…`, **curly quotes, nbsp, arrows `→`, `&amp;`, footnotes, `---` HR, blockquote `>` spacing** | Zero or near-zero REMOTE hits across all 90 files — not present in this dataset, no fix warranted. |
| **`📷` image-attribution footer** (REMOTE-injected) | It IS pushed content (the attribution line Notion shows). Low volume. Decision D2. |

---

## Decisions needed before implementing

- **D1 — HTML comments (claude/sherpa):** F6 strips them on both sides → the diff
  vanishes. But `<!-- claude: re-check … -->` is a *genuine local-only* review note
  that legitimately never reached Notion. Strip-both (cleaner skim) **or** keep
  (surface local-only annotations)? Recommend **strip** — they're never-rendered
  tool markers, not content.
- **D2 — `📷` attribution footer:** it's real REMOTE content (not a round-trip
  artifact). Strip from the diff (cleaner) or keep (it's a genuine push)? Low volume
  either way; recommend **keep** (don't hide real pushed content).
- **D3 — `_index.md` "no base (2-way only)" (67 files, 17%):** still recommend the
  cheap relabel ("section page — no push-time snapshot; LOCAL vs REMOTE") now;
  snapshot section content later if section drift matters.

---

## Two meta-insights

1. **Stale BASE amplifies a chunk of the noise.** Frontmatter (F1) and some link
   path-rewrites (`boring-technical-stuff/`→`tech/`) are large *partly because the
   BASE snapshot predates those local changes*. A fresh `--seed-state` re-snapshot
   would shrink BASE→LOCAL noise. But BASE→REMOTE round-trip noise (escaping, bold,
   emphasis, links, callouts) is **independent of base staleness** — pure
   normalization gaps. F1 is worth doing in `normalizeForDiff` regardless (frontmatter
   should never be diffed).

2. **F5 is the highest leverage-per-line fix.** Widening one character class in the
   existing unescape `.replace()` clears `~ $ [ ] < > { } | _ * #` at once —
   subsuming two known candidates and ~4 new ones in a one-line change.

## Suggested implementation order (by impact, all in `normalizeForDiff` + 1 REMOTE pre-strip)

F1 frontmatter → F7 backlinks-callout → F5 widen-unescape → F2 emphasis →
F4 bold-`****` → F3 link-normalize → F6 html/comments → F8 table-cells →
then F9–F14 as cheap add-ons. Each independently testable against
`diff-content.test.ts`. Re-run `diff-content --force` + re-sample to confirm the
residual is dominated by OTHER-real (genuine) segments.
