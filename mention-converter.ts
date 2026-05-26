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

// Match a Notion page URL and capture the 32-hex ID. Notion's markdown API
// canonicalizes our `https://www.notion.so/<id>` markdown links into
// `https://app.notion.com/p/<id>` when stored — so we must match BOTH forms,
// otherwise fix-mentions and the post-sync mention pass become no-ops.
//
// Forms covered:
//   https://www.notion.so/352bacd27dee81838d20c5bdac2527cf      (we write this)
//   https://www.notion.so/Docs-Structure-352bacd27dee81838d...  (with title slug)
//   https://app.notion.com/p/352bacd27dee81838d20c5bdac2527cf   (Notion stores this)
//   https://notion.so/abc...                                    (no www)
//   ID with dashes (UUID format) — strip them before matching the 32-hex
const NOTION_PAGE_URL_RE = /https?:\/\/(?:www\.|app\.)?notion\.(?:so|com)\/(?:p\/)?(?:[^/?#]*-)?([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}|[0-9a-f]{32})/i;

function extractNotionPageId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(NOTION_PAGE_URL_RE);
  if (!m) return null;
  return m[1].replace(/-/g, "").toLowerCase();
}

const cleanId = (id: string) => id.replace(/-/g, "").toLowerCase();

// Notion's `blocks.update` only accepts absolute link URLs. The markdown *import*
// endpoint is laxer — it stores in-page anchors like `[§3.4](#some-heading)` and
// scheme-less relatives verbatim — but resending one of those in an update payload
// fails the whole block with "Invalid URL for link". Such anchors are dead in
// Notion anyway (Notion navigates by block-id, not heading slug), so when we have
// to rewrite a block we drop the broken link and keep its text. Only http(s)/mailto/
// tel survive a round-trip.
const linkUrlSendable = (url: string) => /^(https?:\/\/|mailto:|tel:)/i.test(url);

interface ConvertOptions {
  notion: Client;
  pageId: string;
  ourPageIds: Set<string>; // dash-stripped lowercase 32-hex
  rateLimitMs?: number;
  // Whether to recurse into child_page (subpage) blocks. Default false: every
  // caller iterates pages independently (fix-mentions walks the whole cache;
  // the push converts each doc as it writes it), so descending into subpages
  // re-walks the entire tree under each page — quadratic. Leave off unless a
  // caller genuinely needs a one-shot whole-subtree conversion.
  descendChildPages?: boolean;
  // Optional live-counter the caller can poll while this function is
  // running. Mutated synchronously after each API call so a periodic
  // repainter (e.g. setInterval in the caller) can show "N blocks, M API
  // calls, K updates" in real time — important for slow pages where the
  // outer progress bar would otherwise appear frozen for minutes.
  liveProgress?: { blocks_inspected: number; blocks_updated: number; links_converted: number; api_calls: number };
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
  const { notion, pageId, ourPageIds, rateLimitMs = 350, liveProgress, descendChildPages = false } = opts;
  const result: ConvertResult = { blocks_inspected: 0, blocks_updated: 0, links_converted: 0 };
  const bumpApi = () => { if (liveProgress) liveProgress.api_calls++; };

  async function visit(blockId: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const res: any = await notion.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      bumpApi();
      await sleep(rateLimitMs);

      for (const block of res.results as any[]) {
        result.blocks_inspected++;
        if (liveProgress) liveProgress.blocks_inspected++;
        const blockType = block.type as string;

        // Skip child_page (subpages — the link IS the page itself, no rich_text).
        // Only descend when explicitly asked; otherwise the subpage is converted
        // by its own top-level pass (see descendChildPages note).
        if (blockType === "child_page") {
          if (descendChildPages && block.has_children) await visit(block.id);
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
              if (liveProgress) { liveProgress.links_converted += converted.count; liveProgress.blocks_updated++; }
              await (notion.blocks as any).update({
                block_id: block.id,
                [blockType]: { rich_text: converted.rich_text },
              });
              bumpApi();
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
              if (liveProgress) { liveProgress.links_converted += cellsCount; liveProgress.blocks_updated++; }
              await (notion.blocks as any).update({
                block_id: block.id,
                table_row: { cells: newCells },
              });
              bumpApi();
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

export function convertRichTextArray(rt: any[], ourPageIds: Set<string>): ConvertedArray {
  let changed = false;
  let count = 0;
  const out = rt.map((item) => {
    if (item.type !== "text") return item;
    const linkUrl = item.text?.link?.url;
    const pageId = extractNotionPageId(linkUrl);
    if (pageId && ourPageIds.has(cleanId(pageId))) {
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
    }
    // Passthrough item. If it carries a link URL that `blocks.update` would
    // reject (a `#heading` anchor, a scheme-less relative), strip the link so the
    // resent array stays valid — otherwise one dead anchor fails the whole block.
    // `changed` is intentionally NOT flipped here: a block with only dead anchors
    // and no real conversion is never sent (so we add no API calls), but if it's
    // being updated anyway for a real mention, the strip rides along for free.
    if (linkUrl && !linkUrlSendable(linkUrl)) {
      return { ...item, text: { ...item.text, link: null } };
    }
    return item;
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
