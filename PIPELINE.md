# notion-sync — Pipeline Diagram

End-to-end view of how `notion-sync` moves markdown into Notion: discovery → section content → leaf content (with image upload, native mentions, rename/move detection), then the post-sync dashboard generators and prune subcommands.

Re-render the live (gum-styled) version any time with:

```bash
bash scripts/render-pipeline-diagram.sh
```

```text
╔════════════════════════════════════════════════════════════════════════════╗
║                                                                            ║
║                     notion-sync — End-to-End Pipeline                      ║
║    markdown → Notion (with rename-safety, mentions, dashboards, prune)     ║
║                                                                            ║
╚════════════════════════════════════════════════════════════════════════════╝

╔════════════════════════════════════════════════════════════════════════════╗
║  LOCAL FILESYSTEM                                                          ║
║  ╭────────────────╮   ╭────────╮                                           ║
║  │  docs/**/*.md  │   │  .env  │                                           ║
║  ╰────────────────╯   ╰────────╯                                           ║
╚════════════════════════════════════════════════════════════════════════════╝
                                  │
                                  ▼
╔════════════════════════════════════════════════════════════════════════════╗
║  STATE / CACHES (gitignored)                                               ║
║  ╭────────────────────╮  ╭──────────────────────────╮  ╭────────────╮      ║
║  │ .notion-cache.json │  │ .notion-image-cache.json │  │ runs.jsonl │      ║
║  ╰────────────────────╯  ╰──────────────────────────╯  ╰────────────╯      ║
╚════════════════════════════════════════════════════════════════════════════╝
                                  │
                                  ▼
╔════════════════════════════════════════════════════════════════════════════╗
║  PHASE 1 — Discovery (build pageIdMap; rename-safety MOVE detection)       ║
║  ╭──────────────────────╮  ╭──────────────────╮  ┌──────────────────────┐  ║
║  │ getOrCreateChildPage │  │ globalTitleIndex │  │ pages.update(parent) │  ║
║  ╰──────────────────────╯  ╰──────────────────╯  └──────────────────────┘  ║
╚════════════════════════════════════════════════════════════════════════════╝
                                  │
                                  ▼
╔════════════════════════════════════════════════════════════════════════════╗
║  PHASE 1.5 — Section content (preserves child_page subpages)               ║
║  ╭─────────────╮ ──▶ ╭──────────────╮ ──▶ ╭────────────────╮               ║
║  │ list-blocks │     │ delete-prose │     │ insert_content │               ║
║  ╰─────────────╯     ╰──────────────╯     ╰────────────────╯               ║
╚════════════════════════════════════════════════════════════════════════════╝
                                  │
                                  ▼
╔════════════════════════════════════════════════════════════════════════════╗
║  PHASE 2 — Leaf content (images + content + native mentions)               ║
║  ╭────────────────╮ ──▶ ╭────────────────╮ ──▶ ╭───────────────────╮       ║
║  │ image-uploader │     │ updateMarkdown │     │ mention-converter │       ║
║  ╰────────────────╯     ╰────────────────╯     ╰───────────────────╯       ║
╚════════════════════════════════════════════════════════════════════════════╝
                                  │
                                  ▼
╔════════════════════════════════════════════════════════════════════════════╗
║  NOTION API (@notionhq/client v5  ·  adaptive 350-1050ms backoff)          ║
║  ╭───────╮  ╭────────╮  ╭─────────────────────────╮                        ║
║  │ pages │  │ blocks │  │ databases / dataSources │                        ║
║  ╰───────╯  ╰────────╯  ╰─────────────────────────╯                        ║
║                           ╭───────────────────╮                            ║
║                           │ fileUploads (CDN) │                            ║
║                           ╰───────────────────╯                            ║
╚════════════════════════════════════════════════════════════════════════════╝

      ─────────────────────  POST-SYNC PIPELINE  ─────────────────────

╔════════════════════════════════════════════════════════════════════════════╗
║  DASHBOARDS — bash run.sh dashboard  (read cache + runs.jsonl)             ║
║  ╭─────────────╮  ╭───────────────╮  ╭─────────────╮                       ║
║  │ 🗺️  sitemap │  │ 🏷️  tag-index │  │ 📇 index-db │                       ║
║  ╰─────────────╯  ╰───────────────╯  ╰─────────────╯                       ║
║  ╭────────────────╮  ╭──────────────╮  ╭───────────╮                       ║
║  │ 📣 recent-feed │  │ 🔗 backlinks │  │ 🩺 health │                       ║
║  ╰────────────────╯  ╰──────────────╯  ╰───────────╯                       ║
╚════════════════════════════════════════════════════════════════════════════╝

                                  │
                                  ▼
╔════════════════════════════════════════════════════════════════════════════╗
║  PRUNE — dry-run by default; --apply requires explicit confirm             ║
║  ╭──────────────────────╮  ╭──────────────────────────╮                    ║
║  │ prune (orphan pages) │  │ prune-images (scheduled) │                    ║
║  ╰──────────────────────╯  ╰──────────────────────────╯                    ║
╚════════════════════════════════════════════════════════════════════════════╝

  Cache feeds Phase 1 (move detection) AND dashboards (sitemap, tag-index,
                          recent-feed, backlinks).
  runs.jsonl feeds recent-feed + health.   .notion-image-cache.json feeds
                               prune-images.
```

## How to read it

- **Top → bottom = data → compute.** Local docs and gitignored state caches sit above the three sync phases. Every phase reads downward from cache and writes upward into it on completion.
- **Phase 1 consults `globalTitleIndex` (built from `.notion-cache.json`) BEFORE creating duplicates.** That's the rename-safety story in one frame: if a title moved folders since the last cache fetch, the existing page is reparented (`pages.update({parent})`) instead of orphaning the original.
- **Phase 1.5 uses `list-blocks → delete-prose → insert_content`**, not the destructive markdown replace path. Section pages keep their `child_page` subpages alive across re-syncs.
- **Phase 2 is the only path that touches `fileUploads` (the Notion CDN)** — image upload happens before the markdown write so external image URLs can be swapped to `file_upload` references in the same pass. The mention-converter then walks the page blocks and rewrites internal `.md` hyperlinks into native page mentions.
- **Dashboards read the OUTPUTS of a sync run, not docs directly.** That's why `dashboard` mode is fast (no markdown re-parse) and why prune is safe (it only sees what already exists in cache).
- **Prune subcommands are dry-run by default.** `--apply` additionally requires interactive confirmation before destructive Notion calls.

## Renderer script

The diagram is generated by [`scripts/render-pipeline-diagram.sh`](scripts/render-pipeline-diagram.sh) using `gum style` + `gum join` (via `~/.claude/skills/shared/gum-tui.sh`). Re-run it whenever the pipeline shape changes and paste the ANSI-stripped output back into this file.
