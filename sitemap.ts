// Sitemap generator — renders the full Notion docs tree as a single
// terse-tree page (`🗺️ Sitemap`). Pushed to Notion as markdown with
// internal links, then converted to native mention pills via
// mention-converter so each leaf hovers / side-peeks the real page.
//
// Surface: bash list.sh sitemap (in notion-list.ts dispatcher).
// Config:  NOTION_SITEMAP_PAGE_ID — if set, target that page directly.
//          Otherwise the script looks for a child page of root titled
//          "🗺️ Sitemap" and creates one if absent.
//
// Why chunked writes: a single replace_content push of 300+ links (~30 KB
// markdown) reliably times out on Notion's parse step. We mirror the
// pattern from writeSectionContent in index.ts: wipe all existing blocks
// first, then insert one chunk per top-level section. Each section is
// small enough (<50 lines, <5 KB) that the parse completes well under
// the SDK timeout.

import { Client } from "@notionhq/client";
import { convertPageLinksToMentions } from "./mention-converter";

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

// Notion's markdown-insert endpoint slows as the target page grows;
// after 4-5 large chunks it starts returning 504/timeout. Retry these
// transient failures with linear backoff. Mirrors withRetry in
// notion-list.ts but kept local so this module has no import cycle.
async function withChunkRetry<T>(
  label: string,
  fn: () => Promise<T>,
  log: (msg: string) => void,
  maxAttempts = 4,
): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err?.status;
      const code = err?.code;
      const retriable =
        status === 504 ||
        status === 502 ||
        status === 503 ||
        status === 408 ||
        status === 429 ||
        code === "notionhq_client_request_timeout" ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT";
      if (!retriable || attempt === maxAttempts) throw err;
      const waitMs = 4000 * attempt; // 4s, 8s, 12s
      log(`    [${label}] ${status ?? code} — retry ${attempt}/${maxAttempts - 1} in ${waitMs / 1000}s`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

// Find the existing sitemap page under `rootId` by title, or create one.
// Skips archived/in_trash matches the same way getOrCreateChildPage does
// (so a manually-trashed sitemap doesn't get reused — fresh page instead).
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

// Build a parent_id → children map sorted by title. Used by render*.
function buildChildIndex(cache: SitemapCache): Map<string | null, SitemapPage[]> {
  const byParent = new Map<string | null, SitemapPage[]>();
  for (const p of cache.pages) {
    const arr = byParent.get(p.parent_id) ?? [];
    arr.push(p);
    byParent.set(p.parent_id, arr);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.title.localeCompare(b.title));
  }
  return byParent;
}

function descendantCount(
  pageId: string,
  byParent: Map<string | null, SitemapPage[]>,
): number {
  const kids = byParent.get(pageId) ?? [];
  let n = kids.length;
  for (const k of kids) n += descendantCount(k.id, byParent);
  return n;
}

// Recursively render a node's children as a nested bullet list.
function renderChildren(
  parentId: string,
  level: number,
  out: string[],
  byParent: Map<string | null, SitemapPage[]>,
): void {
  const kids = byParent.get(parentId) ?? [];
  if (kids.length === 0) return;
  const indent = "  ".repeat(level);
  for (const kid of kids) {
    const grandKids = byParent.get(kid.id) ?? [];
    if (grandKids.length > 0) {
      out.push(`${indent}- **[${kid.title}](${kid.url})** _(${grandKids.length})_`);
      renderChildren(kid.id, level + 1, out, byParent);
    } else {
      out.push(`${indent}- [${kid.title}](${kid.url})`);
    }
  }
}

function renderHeader(totalPages: number): string {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return [
    `# ${SITEMAP_TITLE}`,
    "",
    `_Last refreshed: ${ts} · ${totalPages} pages_`,
    "",
    "---",
    "",
  ].join("\n");
}

function renderSection(
  section: SitemapPage,
  byParent: Map<string | null, SitemapPage[]>,
): string {
  const subtree = descendantCount(section.id, byParent);
  const sizeNote = subtree > 0 ? ` _(${subtree})_` : "";
  const lines: string[] = [];
  lines.push(`## [${section.title}](${section.url})${sizeNote}`);
  lines.push("");
  renderChildren(section.id, 0, lines, byParent);
  lines.push("");
  return lines.join("\n");
}

// Wipe all blocks on the sitemap page. Assumes the sitemap page has no
// child_page blocks to preserve (it's a leaf-style dashboard, not a
// section page). If a user manually adds children, they'll be lost on
// next refresh — documented behavior.
async function wipeSitemapBlocks(
  notion: Client,
  pageId: string,
  rateLimitMs: number,
): Promise<number> {
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
  sections_pushed: number;
  blocks_wiped: number;
  mentions_converted: number;
  blocks_updated: number;
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
    notion,
    cache.root_id,
    sitemapPageId,
    rateLimitMs,
    log,
  );

  // Wipe before re-rendering. New page → 0 blocks; existing → may have
  // dozens. Skipping this would prepend new content above stale.
  log(`  wiping existing blocks…`);
  const wiped = await wipeSitemapBlocks(notion, pageId, rateLimitMs);
  log(`  wiped ${wiped} block${wiped === 1 ? "" : "s"}`);

  const byParent = buildChildIndex(cache);
  const totalPages = cache.pages.filter((p) => p.parent_id !== null).length;
  const topLevel = (byParent.get(cache.root_id) ?? []).filter(
    (p) => p.title !== SITEMAP_TITLE,
  );

  // Header chunk first.
  await withChunkRetry(
    "header",
    () =>
      (notion.pages as any).updateMarkdown({
        page_id: pageId,
        type: "insert_content",
        insert_content: { content: renderHeader(totalPages) },
      }),
    log,
  );
  await sleep(rateLimitMs);

  // One section at a time, but each section's markdown is sub-chunked
  // by line count. Earlier we tried "one chunk per top-level section"
  // — that worked for the first few sections, then dense sections like
  // "Improvements" started returning 504. The cause is cumulative state:
  // Notion's parser slows on a page that already has hundreds of blocks.
  // Splitting each section into ~40-line slices keeps every insert
  // bounded regardless of how dense the source section is.
  const SLICE_LINES = 40;
  let sectionsPushed = 0;
  for (const section of topLevel) {
    const md = renderSection(section, byParent);
    const lines = md.split("\n");
    // Build slices preserving the section heading on slice 1; subsequent
    // slices continue the bullet list (no heading).
    const slices: string[] = [];
    for (let i = 0; i < lines.length; i += SLICE_LINES) {
      slices.push(lines.slice(i, i + SLICE_LINES).join("\n"));
    }
    for (let s = 0; s < slices.length; s++) {
      const sliceLabel = slices.length > 1 ? `${section.title} [${s + 1}/${slices.length}]` : section.title;
      await withChunkRetry(
        sliceLabel,
        () =>
          (notion.pages as any).updateMarkdown({
            page_id: pageId,
            type: "insert_content",
            insert_content: { content: slices[s] },
          }),
        log,
      );
      await sleep(Math.max(rateLimitMs, 1500));
    }
    sectionsPushed++;
    const sliceNote = slices.length > 1 ? ` _(${slices.length} slices)_` : "";
    log(`  ✓ pushed [${sectionsPushed}/${topLevel.length}] ${section.title}${sliceNote}`);
  }

  // Convert internal markdown links → native mention pills. Every page
  // in the cache is "ours" by definition.
  log(`  converting links → mentions…`);
  const ourPageIds = new Set(
    cache.pages.map((p) => p.id.replace(/-/g, "").toLowerCase()),
  );
  const mentionResult = await convertPageLinksToMentions({
    notion,
    pageId,
    ourPageIds,
    rateLimitMs,
  });
  log(
    `  ✓ converted ${mentionResult.links_converted} link${mentionResult.links_converted === 1 ? "" : "s"} → mention${mentionResult.links_converted === 1 ? "" : "s"} (${mentionResult.blocks_updated} block update${mentionResult.blocks_updated === 1 ? "" : "s"})`,
  );

  return {
    sitemap_page_id: pageId,
    page_was_created: created,
    total_pages: cache.pages.length,
    sections_pushed: sectionsPushed,
    blocks_wiped: wiped,
    mentions_converted: mentionResult.links_converted,
    blocks_updated: mentionResult.blocks_updated,
  };
}
