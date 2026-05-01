// mention-converter.ts — convert Notion-internal markdown links to native page mentions.
//
// Why: `updateMarkdown` writes `[text](https://www.notion.so/<id>)` as a regular
// link annotation — clicking opens in a new browser tab. A native mention object
// renders as an inline pill, hover-previews, opens in side-peek, and auto-updates
// when the linked page's title changes.
//
// Method: walk a page's blocks (paginated, recurse into has_children), scan each
// block's rich_text arrays for `{type: text, text.link.url: <notion-url>}` where
// the URL's 32-hex page ID is one of ours, and replace with
// `{type: mention, mention: {type: page, page: {id}}}`. Blocks where ANY
// conversion happened get blocks.update'd with the rewritten rich_text.
//
// Tradeoff: a mention's display text is always the linked page's CURRENT title
// (not the original markdown anchor text). For doc-link style writing that's
// fine — even better, since titles stay in sync. For "click here" anchors it
// changes the wording. Acceptable for our use case.

import { Client } from "@notionhq/client";

// Block types whose data field contains a `rich_text` array we can walk.
// Each block.<type>.rich_text is the array; each block.<type> may also have
// `children` if expanded, handled separately via has_children + recursion.
const RICH_TEXT_BLOCK_TYPES = [
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "code",
  "template",
] as const;

// Match a Notion page URL and capture the 32-hex ID (with or without dashes).
// Examples that match:
//   https://www.notion.so/352bacd27dee81838d20c5bdac2527cf
//   https://www.notion.so/Docs-Structure-352bacd27dee81838d20c5bdac2527cf
//   https://notion.so/abc123ef4567890abcdef0123456789a
const NOTION_PAGE_URL_RE = /https?:\/\/(?:www\.)?notion\.so\/(?:[^/?#]*-)?([0-9a-f]{32})/i;

function extractNotionPageId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(NOTION_PAGE_URL_RE);
  return m ? m[1].toLowerCase() : null;
}

const cleanId = (id: string) => id.replace(/-/g, "").toLowerCase();

interface ConvertOptions {
  notion: Client;
  pageId: string;
  ourPageIds: Set<string>; // dash-stripped lowercase 32-hex
  rateLimitMs?: number;
}

export interface ConvertResult {
  blocks_inspected: number;
  blocks_updated: number;
  links_converted: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Walk a page's blocks and convert internal markdown links to native page mentions.
 * Idempotent: re-running on already-converted blocks is a no-op (mentions have no
 * `text.link.url` to match).
 */
export async function convertPageLinksToMentions(opts: ConvertOptions): Promise<ConvertResult> {
  const { notion, pageId, ourPageIds, rateLimitMs = 350 } = opts;
  const result: ConvertResult = { blocks_inspected: 0, blocks_updated: 0, links_converted: 0 };

  async function visit(blockId: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const res: any = await notion.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      await sleep(rateLimitMs);

      for (const block of res.results as any[]) {
        result.blocks_inspected++;
        const blockType = block.type as string;

        // Skip child_page (subpages — the link IS the page itself, no rich_text)
        if (blockType === "child_page") {
          if (block.has_children) await visit(block.id);
          continue;
        }

        // Convert rich_text on supported block types
        if ((RICH_TEXT_BLOCK_TYPES as readonly string[]).includes(blockType)) {
          const richText = block[blockType]?.rich_text as any[] | undefined;
          if (Array.isArray(richText)) {
            const converted = convertRichTextArray(richText, ourPageIds);
            if (converted.changed) {
              result.links_converted += converted.count;
              result.blocks_updated++;
              await (notion.blocks as any).update({
                block_id: block.id,
                [blockType]: { rich_text: converted.rich_text },
              });
              await sleep(rateLimitMs);
            }
          }
        }

        // table_row blocks are special: they have `cells: rich_text[][]` (array of arrays)
        if (blockType === "table_row") {
          const cells = block.table_row?.cells as any[][] | undefined;
          if (Array.isArray(cells)) {
            let cellsChanged = false;
            let cellsCount = 0;
            const newCells = cells.map((cell) => {
              const c = convertRichTextArray(cell, ourPageIds);
              if (c.changed) { cellsChanged = true; cellsCount += c.count; }
              return c.rich_text;
            });
            if (cellsChanged) {
              result.links_converted += cellsCount;
              result.blocks_updated++;
              await (notion.blocks as any).update({
                block_id: block.id,
                table_row: { cells: newCells },
              });
              await sleep(rateLimitMs);
            }
          }
        }

        // Recurse into children if any (toggles, callouts, columns, etc.)
        if (block.has_children) {
          await visit(block.id);
        }
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
  }

  await visit(pageId);
  return result;
}

interface ConvertedArray {
  rich_text: any[];
  changed: boolean;
  count: number;
}

function convertRichTextArray(rt: any[], ourPageIds: Set<string>): ConvertedArray {
  let changed = false;
  let count = 0;
  const out = rt.map((item) => {
    if (item.type !== "text") return item;
    const linkUrl = item.text?.link?.url;
    const pageId = extractNotionPageId(linkUrl);
    if (!pageId) return item;
    if (!ourPageIds.has(cleanId(pageId))) return item; // not one of our pages — leave external

    changed = true;
    count++;
    // Build a mention object. Preserve annotations (bold/italic/code) so the
    // pill keeps any styling the original anchor had. Do NOT include `plain_text`
    // — Notion fills it from the linked page's current title server-side.
    return {
      type: "mention",
      mention: {
        type: "page",
        page: { id: pageId },
      },
      annotations: item.annotations ?? {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: "default",
      },
    };
  });
  return { rich_text: out, changed, count };
}

/**
 * Helper to build the `ourPageIds` set from a pageIdMap (relPath → page-id).
 */
export function buildPageIdSet(pageIdMap: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const id of pageIdMap.values()) out.add(cleanId(id));
  return out;
}
