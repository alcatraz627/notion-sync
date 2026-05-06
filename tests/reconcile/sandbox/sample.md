---
icon: 🧪
cover: https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=1200
status: stable
audience: engineers
last_updated: 2026-05-06
tags: [test, reconcile, sandbox]
---

# Reconcile Test Sandbox

> **Purpose:** Exercise every notion-sync feature in one short doc — frontmatter, headings, lists, code, tables, callouts, links, images. Used by the reconcile flow test runner.

This page is **created and overwritten by `bash sync.sh --env .env.test`**. Edit it freely in Notion to test the divergence detection — your edits will surface in `bash sync.sh --env .env.test reconcile`.

## What gets exercised

A short prose paragraph with **bold**, *italic*, ~~strikethrough~~, `inline code`, and a [hyperlink to Notion](https://www.notion.so). The frontmatter banner above is auto-rendered from `status: stable / audience: engineers / last_updated: 2026-05-06` plus the `tags:` array.

### Bullet list

- First item — a short bullet
- Second item with **inline emphasis** and a `code reference`
- Third item with a [link to Anthropic](https://www.anthropic.com)

### Numbered list

1. First step — define the goal
2. Second step — write the test
3. Third step — run reconcile

### Task list

- [x] Frontmatter coverage (icon, cover, status, audience, last_updated, tags)
- [x] Headings (H1, H2, H3)
- [x] Inline formatting (bold, italic, strikethrough, code, link)
- [x] Lists (bullet, numbered, task)
- [ ] Edit this page in Notion and re-run reconcile

## Code block

```typescript
// A typescript snippet to test syntax highlighting.
async function reconcile(page: Page): Promise<Resolution> {
  if (page.divergence.kind === "user-edited") {
    return { choice: "pull", reason: "preserve human edits" };
  }
  return { choice: "skip", reason: "no action needed" };
}
```

## Blockquote / callout-style

> 💡 **Tip:** Notion renders consecutive `>` lines as a callout-style quote.
> Multi-line continuation works when each line starts with `>`.
> Used by notion-sync for the per-page meta banner at the top of every doc.

## Table

| Field | Required | Default | Description |
|---|---|---|---|
| `icon` | no | — | Emoji or URL — sets Notion page icon |
| `cover` | no | — | URL — sets Notion page cover image |
| `status` | no | — | Free-form; shown in meta banner |
| `audience` | no | — | Free-form; shown in meta banner |
| `tags` | no | — | YAML list; rendered as `#tag` chips |

## Links — internal vs external

- **External URL:** [Notion API docs](https://developers.notion.com)
- **Anchor on this page:** [back to top](#reconcile-test-sandbox)
- **Relative .md link** (would resolve to a Notion mention if a sibling existed): `[sibling doc](./other.md)` — left as a literal example since this sandbox has only one doc.

## Image (public URL — no upload needed)

![A small Unsplash test image](https://images.unsplash.com/photo-1518770660439-4636190af475?w=400)

## HTML comment (preserved on push, may be stripped by Notion's markdown export on pull)

<!-- This comment exists in the local file. After a Notion-side edit + pull, it may or may not be preserved depending on how Notion handles inline HTML during markdown export. -->

## What to edit when testing reconcile

Pick one of these:

1. **Edit a paragraph** — change "What gets exercised" prose. Easy to spot in the diff.
2. **Reorder a section** — move "Code block" before "Bullet list".
3. **Change the icon in Notion's UI** — clicks the icon at top of page, picks a different emoji. Tests the frontmatter merge prompt.
4. **Move the page** — drag it to a different parent in Notion. Tests `moved` divergence.
5. **Archive the page** — `...` → Move to trash. Tests `archived` divergence.

After editing in Notion, run:

```bash
bash sync.sh --env .env.test reconcile
```

Pick "View diff first" to see what changed, then either "Pull Notion → local" (preserves your edit) or "Keep local — overwrite Notion" (discards your edit). The reconcile flow walks the rest.
