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

### Image support for private repos

`rewriteImages()` points to `raw.githubusercontent.com` — only works for public repos. `enhancement-product` is private, so images show as broken in Notion.

Options:
- **Pre-sync CDN upload pass:** collect all image paths → upload to S3/Cloudflare R2/public mirror → rewrite src before sending to Notion
- **Public repo mirror:** copy image assets to a separate public repo

Current state: images silently skip (text + tables still work). Known limitation.

### Native Notion page-mention chips (Phase 3)

`rewriteLinks()` produces `[text](https://notion.so/pageId)` — plain hyperlinks. Works, but not native chip-style mentions.

Phase 3 plan: after Phase 2 content writes, add a blocks API pass that scans each page's rich_text spans, finds inline links pointing at Notion page URLs, and replaces them with `link_mention` inline mentions. These render as `@Page Name` chips with hover previews.

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
| Images in private repos | `raw.githubusercontent.com` returns 404 for private repos — Notion shows broken image |
| Cross-doc links are hyperlinks, not page chips | Notion markdown API has no `link_to_page` syntax; Phase 3 blocks pass would fix this |
| Anchor links in cross-doc links | `#heading` fragments appended to Notion URLs don't resolve (Notion doesn't support URL fragment navigation to blocks) |
| Notion rate limit | Hard-coded 350ms sleep per API call; large doc trees take proportional time |
| `_index.md` icon only | Folder pages read icon from `_index.md` frontmatter; if no `_index.md`, uses `NOTION_FOLDER_ICON` default |
