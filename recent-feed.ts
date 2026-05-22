// recent-feed.ts — render the 📣 Recently Synced dashboard page on Notion.
//
// Walks runs.jsonl backwards (newest first) and aggregates the most-
// recently-synced N pages, deduplicated by page_id (a doc that was
// touched in three runs only appears once, with its newest timestamp).
//
// Surface: bash list.sh recent-feed. Auto-creates a "📣 Recently Synced"
// page under the docs root, or honours NOTION_RECENT_FEED_PAGE_ID.
//
// Why blocks API rather than markdown: same lesson as sitemap and
// tag-index — Notion's markdown parser scales poorly with target page
// block count. We build heading_2 + bulleted_list_item blocks directly
// and push via blocks.children.append. Each entry is a date heading
// followed by mention pills with status badge prefix.

import { Client } from "@notionhq/client";
import * as fs from "fs";
import * as path from "path";
import { withRetry } from "./lib/retry";

const RECENT_FEED_TITLE = "📣 Recently Synced";
const DEFAULT_LIMIT = 50;

export interface RecentFeedCachePage {
  id: string;
  title: string;
  parent_id: string | null;
  url: string;
}

export interface RecentFeedCache {
  fetched_at: string;
  root_id: string;
  pages: RecentFeedCachePage[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Linear-backoff retry (4s·n, 4 attempts) — preset binder over lib/retry.
const retry = <T>(label: string, fn: () => Promise<T>, log: (msg: string) => void, maxAttempts = 4): Promise<T> =>
  withRetry(fn, { label, log, maxAttempts });

interface FeedEntry {
  page_id: string;            // canonical (no dashes) for matching against cache
  title: string;
  status: "created" | "updated" | "dry_run" | "error";
  ts: string;                 // ISO from runs.jsonl
  date: string;               // YYYY-MM-DD for grouping
  run_id: string;
  is_new?: boolean;
  elapsed_ms?: number;
}

const cleanId = (id: string) => id.replace(/-/g, "").toLowerCase();

// Walk runs.jsonl backwards collecting per-page entries until we have
// `limit` distinct page_ids. Older mentions of an already-seen page_id
// are skipped — a page only appears once, with its newest sync.
function readRecentRuns(runsPath: string, limit: number): FeedEntry[] {
  if (!fs.existsSync(runsPath)) return [];
  // Read the whole file — runs.jsonl is bounded (one entry per run, not huge).
  const raw = fs.readFileSync(runsPath, "utf8");
  const lines = raw.trim().split("\n").filter(Boolean);
  const seen = new Set<string>();
  const entries: FeedEntry[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let run: any;
    try { run = JSON.parse(lines[i]); } catch { continue; }
    const ts = run.ts;
    const runId = run.run_id;
    const pages = run.pages ?? [];
    for (const p of pages) {
      // Skip errors and dry-runs from the feed — show only successful syncs.
      if (p.status !== "created" && p.status !== "updated") continue;
      if (!p.page_id) continue;
      const id = cleanId(p.page_id);
      if (seen.has(id)) continue;
      seen.add(id);
      const date = (ts || "").slice(0, 10) || "(unknown)";
      entries.push({
        page_id: id,
        title: p.title ?? p.path ?? "(unknown)",
        status: p.status,
        ts: ts ?? "",
        date,
        run_id: runId ?? "",
        is_new: p.is_new,
        elapsed_ms: p.elapsed_ms,
      });
      if (entries.length >= limit) return entries;
    }
  }
  return entries;
}

async function findOrCreateRecentFeedPage(
  notion: Client,
  rootId: string,
  providedId: string | undefined,
  rateLimitMs: number,
  log: (msg: string) => void,
): Promise<{ id: string; created: boolean }> {
  if (providedId) {
    log(`  using configured NOTION_RECENT_FEED_PAGE_ID: ${providedId}`);
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
      if (block.child_page?.title !== RECENT_FEED_TITLE) continue;
      const page: any = await notion.pages.retrieve({ page_id: block.id });
      await sleep(rateLimitMs);
      if (page.in_trash || page.archived) continue;
      log(`  found existing recent-feed page: ${block.id}`);
      return { id: block.id, created: false };
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  const created: any = await notion.pages.create({
    parent: { page_id: rootId },
    properties: {
      title: { title: [{ type: "text", text: { content: RECENT_FEED_TITLE } }] },
    },
    icon: { type: "emoji", emoji: "📣" },
  });
  await sleep(rateLimitMs);
  log(`  created recent-feed page: ${created.id}`);
  return { id: created.id, created: true };
}

async function wipeBlocks(notion: Client, pageId: string, rateLimitMs: number): Promise<number> {
  const all: any[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    await sleep(rateLimitMs);
    all.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  for (const b of all) {
    await notion.blocks.delete({ block_id: b.id });
    await sleep(rateLimitMs);
  }
  return all.length;
}

const STATUS_BADGE: Record<string, string> = {
  created: "🆕",
  updated: "✏️",
  dry_run: "🔍",
  error: "❌",
};

// Build the block list. Header (italic timestamp + divider), then one
// heading_3 per date with bulleted_list_items underneath.
function buildFeedBlocks(entries: FeedEntry[]): any[] {
  const blocks: any[] = [];
  const ts = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  blocks.push({
    type: "paragraph",
    paragraph: {
      rich_text: [{
        type: "text",
        text: { content: `Last refreshed: ${ts} · ${entries.length} most-recent unique pages` },
        annotations: { bold: false, italic: true, strikethrough: false, underline: false, code: false, color: "default" },
      }],
    },
  });
  blocks.push({
    type: "paragraph",
    paragraph: {
      rich_text: [{
        type: "text",
        text: { content: "Newest first. Each page appears once with its most recent sync — older entries for the same page are collapsed." },
        annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "gray" },
      }],
    },
  });
  blocks.push({ type: "divider", divider: {} });

  // Group by date (already sorted desc since we walked runs.jsonl backwards).
  let lastDate: string | null = null;
  for (const e of entries) {
    if (e.date !== lastDate) {
      blocks.push({
        type: "heading_3",
        heading_3: {
          rich_text: [{
            type: "text",
            text: { content: e.date },
            annotations: { bold: true, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
          }],
        },
      });
      lastDate = e.date;
    }
    const badge = STATUS_BADGE[e.status] ?? "·";
    const newPill = e.is_new ? " (new)" : "";
    const richText: any[] = [
      {
        type: "text",
        text: { content: `${badge} ` },
        annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
      },
      {
        type: "mention",
        mention: { type: "page", page: { id: e.page_id } },
        annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
      },
    ];
    if (newPill) {
      richText.push({
        type: "text",
        text: { content: newPill },
        annotations: { bold: false, italic: true, strikethrough: false, underline: false, code: false, color: "blue" },
      });
    }
    if (e.elapsed_ms !== undefined) {
      const elapsed = e.elapsed_ms >= 1000 ? `${(e.elapsed_ms / 1000).toFixed(1)}s` : `${e.elapsed_ms}ms`;
      richText.push({
        type: "text",
        text: { content: ` · ${elapsed}` },
        annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: true, color: "gray" },
      });
    }
    blocks.push({
      type: "bulleted_list_item",
      bulleted_list_item: { rich_text: richText },
    });
  }
  return blocks;
}

export interface GenerateRecentFeedResult {
  recent_feed_page_id: string;
  page_was_created: boolean;
  total_runs_scanned: number;
  total_entries_emitted: number;
  blocks_wiped: number;
  batches_pushed: number;
}

export async function generateRecentFeed(opts: {
  notion: Client;
  cache: RecentFeedCache;
  runsPath: string;
  limit?: number;
  recentFeedPageId?: string;
  rateLimitMs: number;
  log?: (msg: string) => void;
}): Promise<GenerateRecentFeedResult> {
  const { notion, cache, runsPath, recentFeedPageId, rateLimitMs } = opts;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const log = opts.log ?? (() => {});

  log(`\nReading ${runsPath} for recent syncs (limit ${limit})…`);
  const entries = readRecentRuns(runsPath, limit);
  log(`  collected ${entries.length} unique page entries`);

  if (entries.length === 0) {
    log("  no entries found — runs.jsonl is empty or has no successful syncs");
    return {
      recent_feed_page_id: "",
      page_was_created: false,
      total_runs_scanned: 0,
      total_entries_emitted: 0,
      blocks_wiped: 0,
      batches_pushed: 0,
    };
  }

  // Drop entries whose page_id isn't in the cache — those pages were
  // deleted from Notion since the run was logged, mention rendering
  // would 404. Cheap filter; the cache is authoritative for "what
  // pages exist right now".
  const cacheIds = new Set(cache.pages.map((p) => cleanId(p.id)));
  const live = entries.filter((e) => cacheIds.has(e.page_id));
  if (live.length < entries.length) {
    log(`  filtered ${entries.length - live.length} entries with deleted/trashed source pages`);
  }

  const { id: pageId, created } = await findOrCreateRecentFeedPage(
    notion, cache.root_id, recentFeedPageId, rateLimitMs, log,
  );

  log(`  wiping existing blocks…`);
  const wiped = await wipeBlocks(notion, pageId, rateLimitMs);
  log(`  wiped ${wiped} block${wiped === 1 ? "" : "s"}`);

  const blocks = buildFeedBlocks(live);
  log(`  built ${blocks.length} blocks`);

  const BATCH_SIZE = 100;
  const INTER_BATCH_MS = 1500;
  let batches = 0;
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);
    await retry(
      `batch ${batches + 1}`,
      () => notion.blocks.children.append({ block_id: pageId, children: batch }),
      log,
    );
    batches++;
    log(`  ✓ pushed batch [${batches}/${Math.ceil(blocks.length / BATCH_SIZE)}] — ${Math.min((batches) * BATCH_SIZE, blocks.length)}/${blocks.length} blocks`);
    await sleep(INTER_BATCH_MS);
  }

  return {
    recent_feed_page_id: pageId,
    page_was_created: created,
    total_runs_scanned: 0, // filled below
    total_entries_emitted: live.length,
    blocks_wiped: wiped,
    batches_pushed: batches,
  };
}
