// Sitemap generator — renders the full Notion docs tree as a single
// terse-tree page (`🗺️ Sitemap`).
//
// Surface: bash list.sh sitemap (in notion-list.ts dispatcher).
// Config:  NOTION_SITEMAP_PAGE_ID — if set, target that page directly.
//          Otherwise the script looks for a child page of root titled
//          "🗺️ Sitemap" and creates one if absent.
//
// Why blocks API instead of markdown: earlier versions used
// `pages.updateMarkdown` with `insert_content` to push markdown chunks
// of the rendered sitemap, then ran mention-converter to upgrade
// links → mention pills. That approach hit Notion's "cumulative state"
// 504 wall — once the sitemap page had ~5 sections of blocks, the
// markdown parser slowed enough that subsequent inserts timed out
// repeatedly even at 3-12s retry backoff. This rewrite builds Notion
// blocks programmatically (heading_2, bulleted_list_item with mention
// rich_text) and pushes via `blocks.children.append` in batches of 100.
// No markdown parser involvement, mentions emitted directly, and the
// API path is faster + more predictable on big trees.

import { Client } from "@notionhq/client";
import { withRetry } from "./lib/retry";

const SITEMAP_TITLE = "🗺️ Sitemap";

// Same shape as Cache.pages in notion-list.ts. Re-declared here so this
// module has no import cycle with the dispatcher.
export interface SitemapPage {
  id: string;
  title: string;
  parent_id: string | null;
  url: string;
  block_count: number;
  child_page_count: number;
  has_content: boolean;
  icon: { type: string; value: string } | null;
  depth: number;
}

export interface SitemapCache {
  fetched_at: string;
  root_id: string;
  pages: SitemapPage[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Linear-backoff retry (4s·n, 4 attempts) — preset binder over lib/retry.
// Linear (not exponential) is deliberate for the chunked sitemap push: the
// 504 wall on a large wipe needs short, predictable waits, not 32s backoffs.
const withChunkRetry = <T>(label: string, fn: () => Promise<T>, log: (msg: string) => void, maxAttempts = 4): Promise<T> =>
  withRetry(fn, { label, log, maxAttempts });

async function findOrCreateSitemapPage(
  notion: Client,
  rootId: string,
  providedId: string | undefined,
  rateLimitMs: number,
  log: (msg: string) => void,
): Promise<{ id: string; created: boolean }> {
  if (providedId) {
    log(`  using configured NOTION_SITEMAP_PAGE_ID: ${providedId}`);
    return { id: providedId, created: false };
  }

  let cursor: string | undefined;
  do {
    const res: any = await notion.blocks.children.list({
      block_id: rootId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    await sleep(rateLimitMs);
    for (const block of res.results) {
      if (block.type !== "child_page") continue;
      if (block.child_page?.title !== SITEMAP_TITLE) continue;
      const page: any = await notion.pages.retrieve({ page_id: block.id });
      await sleep(rateLimitMs);
      if (page.in_trash || page.archived) {
        log(`  found archived sitemap page (${block.id}) — will create fresh`);
        continue;
      }
      log(`  found existing sitemap page: ${block.id}`);
      return { id: block.id, created: false };
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  const created: any = await notion.pages.create({
    parent: { page_id: rootId },
    properties: {
      title: { title: [{ type: "text", text: { content: SITEMAP_TITLE } }] },
    },
    icon: { type: "emoji", emoji: "🗺️" },
  });
  await sleep(rateLimitMs);
  log(`  created sitemap page: ${created.id}`);
  return { id: created.id, created: true };
}

// Build a sorted parent → children map.
function buildChildIndex(cache: SitemapCache): Map<string | null, SitemapPage[]> {
  const byParent = new Map<string | null, SitemapPage[]>();
  for (const p of cache.pages) {
    const arr = byParent.get(p.parent_id) ?? [];
    arr.push(p);
    byParent.set(p.parent_id, arr);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.title.localeCompare(b.title));
  return byParent;
}

function descendantCount(pageId: string, byParent: Map<string | null, SitemapPage[]>): number {
  const kids = byParent.get(pageId) ?? [];
  let n = kids.length;
  for (const k of kids) n += descendantCount(k.id, byParent);
  return n;
}

// Walk a section subtree and emit flat bulleted_list_item blocks with
// the folder path baked into the bullet text. Deep nesting via Notion's
// `children` field is limited (validation error above 2 levels in a
// single append), so we flatten and use a path prefix instead.
//
// Each leaf block's rich_text is:
//   [path-prefix italic dim]  [mention pill of the leaf page]
// Sub-section pages get bold + dim trailing count.
function emitSubtreeBullets(
  parentId: string,
  pathPrefix: string,
  byParent: Map<string | null, SitemapPage[]>,
  out: any[],
): void {
  const kids = byParent.get(parentId) ?? [];
  for (const kid of kids) {
    const grandKids = byParent.get(kid.id) ?? [];
    const isSubSection = grandKids.length > 0;
    const richText: any[] = [];
    if (pathPrefix) {
      richText.push({
        type: "text",
        text: { content: pathPrefix },
        annotations: {
          bold: false, italic: false, strikethrough: false, underline: false, code: false,
          color: "gray",
        },
      });
    }
    richText.push({
      type: "mention",
      mention: { type: "page", page: { id: kid.id } },
      annotations: {
        bold: isSubSection, italic: false, strikethrough: false, underline: false, code: false,
        color: "default",
      },
    });
    if (isSubSection) {
      richText.push({
        type: "text",
        text: { content: ` (${descendantCount(kid.id, byParent)})` },
        annotations: {
          bold: false, italic: true, strikethrough: false, underline: false, code: false,
          color: "gray",
        },
      });
    }
    out.push({
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: richText },
    });
    if (isSubSection) {
      // Recurse — keep the path prefix growing so nested folders are
      // visible without API-level nesting.
      const nextPrefix = pathPrefix + kid.title + " / ";
      emitSubtreeBullets(kid.id, nextPrefix, byParent, out);
    }
  }
}

// Build the full block list. One heading_2 per top-level section,
// then a flat list of bulleted_list_items for everything below
// (folder path baked into the bullet text in dim/gray).
function buildSitemapBlocks(cache: SitemapCache): any[] {
  const byParent = buildChildIndex(cache);
  const totalPages = cache.pages.filter((p) => p.parent_id !== null).length;
  const ts = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const blocks: any[] = [];
  blocks.push({
    type: "paragraph",
    paragraph: {
      rich_text: [{
        type: "text",
        text: { content: `Last refreshed: ${ts} · ${totalPages} pages` },
        annotations: { bold: false, italic: true, strikethrough: false, underline: false, code: false, color: "default" },
      }],
    },
  });
  blocks.push({ type: "divider", divider: {} });

  const topLevel = (byParent.get(cache.root_id) ?? []).filter((p) => p.title !== SITEMAP_TITLE);
  for (const section of topLevel) {
    const subtree = descendantCount(section.id, byParent);
    const sectionRichText: any[] = [
      {
        type: "mention",
        mention: { type: "page", page: { id: section.id } },
        annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
      },
    ];
    if (subtree > 0) {
      sectionRichText.push({
        type: "text",
        text: { content: ` (${subtree})` },
        annotations: { bold: false, italic: true, strikethrough: false, underline: false, code: false, color: "gray" },
      });
    }
    blocks.push({
      type: "heading_2",
      heading_2: { rich_text: sectionRichText },
    });
    emitSubtreeBullets(section.id, "", byParent, blocks);
  }
  return blocks;
}

// Wipe all blocks on the sitemap page. The sitemap is fully owned by
// this script — no manual content to preserve. Wipe is sequential at
// rateLimitMs per delete to stay within Notion's per-second cap.
async function wipeSitemapBlocks(notion: Client, pageId: string, rateLimitMs: number): Promise<number> {
  const allBlocks: any[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    await sleep(rateLimitMs);
    allBlocks.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  for (const block of allBlocks) {
    await notion.blocks.delete({ block_id: block.id });
    await sleep(rateLimitMs);
  }
  return allBlocks.length;
}

export interface GenerateSitemapResult {
  sitemap_page_id: string;
  page_was_created: boolean;
  total_pages: number;
  total_blocks: number;
  blocks_wiped: number;
  batches_pushed: number;
}

export async function generateSitemap(opts: {
  notion: Client;
  cache: SitemapCache;
  sitemapPageId?: string;
  rateLimitMs: number;
  log?: (msg: string) => void;
}): Promise<GenerateSitemapResult> {
  const { notion, cache, sitemapPageId, rateLimitMs } = opts;
  const log = opts.log ?? (() => {});

  log(`\nGenerating sitemap for ${cache.pages.length} cached pages…`);

  const { id: pageId, created } = await findOrCreateSitemapPage(
    notion, cache.root_id, sitemapPageId, rateLimitMs, log,
  );

  log(`  wiping existing blocks…`);
  const wiped = await wipeSitemapBlocks(notion, pageId, rateLimitMs);
  log(`  wiped ${wiped} block${wiped === 1 ? "" : "s"}`);

  // Build the entire block tree in memory, then push via
  // blocks.children.append in batches of <=100. Each block tree
  // includes its `children` field for nested bullets — the Notion API
  // walks the tree server-side, no extra API calls needed.
  const blocks = buildSitemapBlocks(cache);
  log(`  built ${blocks.length} top-level blocks (excluding nested children)`);

  // append accepts up to 100 children per call. Push in batches.
  const BATCH_SIZE = 100;
  // Inter-batch sleep — appends with deeply nested children take time
  // to process. 1.5s feels right empirically.
  const INTER_BATCH_MS = 1500;
  let pushed = 0;
  let batches = 0;
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);
    await withChunkRetry(
      `batch ${batches + 1}`,
      () =>
        notion.blocks.children.append({
          block_id: pageId,
          children: batch,
        }),
      log,
    );
    batches++;
    pushed += batch.length;
    log(`  ✓ pushed batch [${batches}/${Math.ceil(blocks.length / BATCH_SIZE)}] — ${pushed}/${blocks.length} blocks`);
    await sleep(INTER_BATCH_MS);
  }

  return {
    sitemap_page_id: pageId,
    page_was_created: created,
    total_pages: cache.pages.length,
    total_blocks: blocks.length,
    blocks_wiped: wiped,
    batches_pushed: batches,
  };
}
