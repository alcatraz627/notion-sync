# notion-sync — Roadmap

Items are ordered by priority within each tier. Highest-priority items marked `[P0]`.

---

## P0 — Reliability & Observability

### Logging completeness + error recovery `[P0]`

Current gaps to audit and fix:

- Verify every error surface has a structured `error_summary` entry with suspicions
- Add retry logic for transient 429/500 errors (currently aborts immediately)
- Add `--resume` flag: reads last run log, skips already-successfully-written pages (idempotent re-runs)
- Add per-page content hash: skip API write when content hasn't changed since last run
- Tune `ABORT_WINDOW` / `ABORT_ERRORS` thresholds based on real run data
- Document patterns in `run-notes.md` as they're discovered

---

## P1 — Content Fidelity

### Native Notion page-mention chips `[next up]`

`rewriteLinks()` produces `[text](https://notion.so/pageId)` — plain hyperlinks. Works, but not native chip-style mentions.

Phase 3 plan: after Phase 2 content writes, add a blocks API pass per page:
1. `GET /blocks/:pageId/children` (paginated)
2. Find `paragraph` / `bulleted_list_item` / `numbered_list_item` blocks with rich_text spans that have a link pointing to `notion.so/*`
3. Parse the page ID from the URL, look it up in `pageIdMap`
4. `PATCH /blocks/:blockId` — replace the text span with a `mention` type span (`mention.type = "page"`, `mention.page.id`)

Result: `@Page Name` chips with hover previews, consistent with native Notion navigation. Adds ~1 extra API pass per synced page.

### [Explore] Better Notion tree/navigation structure

Current sync creates nested pages (folder = parent page, file = child page). Browsing requires expanding a sidebar collapse tree — unwieldy with many sections.

Exploration directions:

- **Notion databases as section indexes** — create one database per section; each row is a doc entry with Name, Status, Audience, Tags columns, linking to the real page. Gives table/board/gallery view. See: [Working with databases](https://developers.notion.com/docs/working-with-databases) · [POST /databases](https://developers.notion.com/reference/post-database)
- **Linked database views** — one master database, filtered per section using Notion's `filter` query param. No duplication; one source of truth. More complex to bootstrap.
- **Synced blocks nav** — a manually-maintained nav block synced to every top-level page. Blocks API only; doesn't auto-update on new docs.
- **Notion wiki layout** (`is_wiki`) — private API only, same limitation as `is_full_width` (stripped by `@notionhq/client`).
- **Table-of-contents block** — auto-generates from headings within one page only; not cross-page.

Key trade-off: database-backed indexes give richer navigation but add ~2–3 extra API calls per section (create DB, create rows, keep in sync). Worth exploring after P1 items land and the sync is stable.

### Image support for private repos

`rewriteImages()` points to `raw.githubusercontent.com` — only works for public repos.

**Current mitigation (shipped):** every image block now emits a fallback caption line directly below it:
```
📷 _alt text_ · [source doc ↗](github.com/.../file.md) · [image ↗](raw_url)
```
Even when the image embed fails, the caption is always visible with copy-pasteable links.

**Full fix options:**
- **Pre-sync CDN upload pass:** collect all image paths → upload to S3/Cloudflare R2 → rewrite src before sending to Notion. Adds significant complexity + external dependency.
- **Public asset fork:** mirror only the `docs/**/*.{png,jpg,gif}` tree into a separate public repo and point `GITHUB_RAW_BASE` there.

> Note: Notion's own file upload API (`POST /v1/files`) returns pre-signed S3 URLs that expire in ~1 hour — unsuitable for persistent embeds.

---

## P2 — Bidirectional Sync

### `--diff` mode: compare local vs Notion tree

Walk local docs tree + fetch Notion subtree via children API → diff titles + structure → print colored side-by-side tree:
- Local-only entries
- Notion-only entries
- Matched (title same)
- Content-changed (local mtime newer than Notion `last_edited_time`)

No writes in diff mode.

### `--pull` mode: Notion → local markdown

Fetch Notion page content back to local file paths.

- **Phase 1:** show structural diff only (what would be overwritten)
- **Phase 2 (experimental):** prompt user to confirm per-file overwrites
- **Phase 3 (experimental):** if local file has uncommitted changes, show merge conflict + let user resolve in `$EDITOR`

---

## P3 — Developer Experience

### CLI progress bar + better TUI

Replace line-by-line `console.log` output with:
- Progress bar: `X / N pages synced`
- Per-API-call spinner
- End-of-run summary table (sections, files, errors, timing)

Library candidates: `cli-progress`, `ora`, `listr2`.

**Stretch:** interactive wizard mode — pick which folders to push before the run starts (using `prompts` / `inquirer`).

> Only implement once core sync logic is proven stable over several real runs.

### Better README with banner + architecture diagram

- `/banner` — colorful ASCII header at top of README
- `/diagram` — Unicode box-drawing flow of the two-phase sync architecture:
  ```
  walk DOCS_DIR → Phase 1 (discover/create pages) → Phase 2 (write content + rewrite links) → runs.jsonl
  ```

### Suspicion rules reference doc

Split the suspicion rules out of `CLAUDE.md` / `README.md` into `SUSPICION-RULES.md`. Per rule:
- Rule name
- Trigger pattern (regex or description)
- Code sample: triggering line → safe rewrite
- Recommended fix

Grows as new rules are discovered in `run-notes.md`. Link from `CLAUDE.md` "Diagnosing runs" section.

---

## Known Limitations (not roadmap items, just documented)

| Limitation | Detail |
|---|---|
| Images in private repos | `raw.githubusercontent.com` returns 404 for private repos — caption fallback always shows alt text + links |
| Cross-doc links are hyperlinks, not page chips | Notion markdown API has no `link_to_page` syntax; Phase 3 blocks pass (P1) will fix this |
| Anchor links in cross-doc links | `#heading` fragments appended to Notion URLs don't resolve (Notion doesn't support URL fragment navigation to blocks) |
| `is_full_width` has no effect | `NOTION_FULL_WIDTH` env var is read but ignored — Notion's public REST API does not expose `is_full_width`. Toggle full-width manually in the Notion UI per page. |
| Notion rate limit | Hard-coded 350ms sleep per API call; large doc trees take proportional time |
| `_index.md` icon only | Folder pages read icon from `_index.md` frontmatter; if no `_index.md`, uses `NOTION_FOLDER_ICON` default |
