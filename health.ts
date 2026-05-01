// health.ts — render the 🩺 Sync Status dashboard page on Notion.
//
// Shows the most recent run's stats, image-upload cache stats, last few
// errored paths with their suspicion tags, and a quick-retry command.
// Useful as an at-a-glance "is the sync healthy?" page for collaborators
// who don't want to grep runs.jsonl from a terminal.
//
// Surface: bash list.sh health. Auto-creates the page under root, or
// honours NOTION_HEALTH_PAGE_ID. Same blocks-API pattern as the other
// dashboards. Idempotent — wipes existing blocks before re-rendering.

import { Client } from "@notionhq/client";
import * as fs from "fs";

const HEALTH_TITLE = "🩺 Sync Status";

export interface HealthCachePage {
  id: string;
  title: string;
  parent_id: string | null;
  url: string;
}

export interface HealthCache {
  fetched_at: string;
  root_id: string;
  pages: HealthCachePage[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function findOrCreateHealthPage(
  notion: Client,
  rootId: string,
  providedId: string | undefined,
  rateLimitMs: number,
  log: (msg: string) => void,
): Promise<{ id: string; created: boolean }> {
  if (providedId) {
    log(`  using configured NOTION_HEALTH_PAGE_ID: ${providedId}`);
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
      if (block.child_page?.title !== HEALTH_TITLE) continue;
      const page: any = await notion.pages.retrieve({ page_id: block.id });
      await sleep(rateLimitMs);
      if (page.in_trash || page.archived) continue;
      log(`  found existing health page: ${block.id}`);
      return { id: block.id, created: false };
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  const created: any = await notion.pages.create({
    parent: { page_id: rootId },
    properties: {
      title: { title: [{ type: "text", text: { content: HEALTH_TITLE } }] },
    },
    icon: { type: "emoji", emoji: "🩺" },
  });
  await sleep(rateLimitMs);
  log(`  created health page: ${created.id}`);
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

interface RunSummary {
  run_id: string;
  ts: string;
  dry_run: boolean;
  partial?: boolean;
  partial_reason?: string;
  stats: any;
  image_stats?: any;
  error_summary?: any[] | null;
  timing?: any;
}

function readLatestRun(runsPath: string): RunSummary | null {
  if (!fs.existsSync(runsPath)) return null;
  const raw = fs.readFileSync(runsPath, "utf8");
  const lines = raw.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function readRecentRuns(runsPath: string, n: number): RunSummary[] {
  if (!fs.existsSync(runsPath)) return [];
  const lines = fs.readFileSync(runsPath, "utf8").trim().split("\n").filter(Boolean);
  const out: RunSummary[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    try { out.push(JSON.parse(lines[i])); } catch { continue; }
  }
  return out;
}

// Build the Notion blocks for the health page. Header + key stats +
// last-3 error summary (if any) + recent-runs sparkline (text-only).
function buildHealthBlocks(latest: RunSummary | null, recent: RunSummary[]): any[] {
  const blocks: any[] = [];
  const ts = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  blocks.push({
    type: "paragraph",
    paragraph: {
      rich_text: [{
        type: "text",
        text: { content: `Last refreshed: ${ts}` },
        annotations: { bold: false, italic: true, strikethrough: false, underline: false, code: false, color: "default" },
      }],
    },
  });
  blocks.push({ type: "divider", divider: {} });

  if (!latest) {
    blocks.push({
      type: "callout",
      callout: {
        icon: { type: "emoji", emoji: "ℹ️" },
        rich_text: [{ type: "text", text: { content: "No runs found in runs.jsonl yet." }, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }],
        color: "gray_background",
      },
    });
    return blocks;
  }

  // Latest run callout — color depends on health.
  const stats = latest.stats || {};
  const errors = stats.errors ?? 0;
  const aborted = stats.aborted === true;
  const partial = latest.partial === true;
  let color: string;
  let icon: string;
  let summary: string;
  if (partial) {
    color = "yellow_background"; icon = "⚠️";
    summary = `Last run was PARTIAL — ${latest.partial_reason ?? "unknown reason"}`;
  } else if (aborted) {
    color = "red_background"; icon = "🛑";
    summary = `Last run ABORTED — ${errors} consecutive errors`;
  } else if (errors > 0) {
    color = "orange_background"; icon = "⚠️";
    summary = `Last run had ${errors} error${errors === 1 ? "" : "s"}`;
  } else if (latest.dry_run) {
    color = "blue_background"; icon = "🔍";
    summary = `Last run was a DRY RUN — no Notion writes`;
  } else {
    color = "green_background"; icon = "✅";
    summary = `Last run successful — ${stats.created ?? 0} created, ${stats.updated ?? 0} updated, 0 errors`;
  }
  blocks.push({
    type: "callout",
    callout: {
      icon: { type: "emoji", emoji: icon },
      rich_text: [
        {
          type: "text",
          text: { content: summary },
          annotations: { bold: true, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
        },
        {
          type: "text",
          text: { content: `\n${latest.run_id} · ${latest.ts}` },
          annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: true, color: "gray" },
        },
      ],
      color,
    },
  });

  // Stats heading
  blocks.push({
    type: "heading_3",
    heading_3: { rich_text: [{ type: "text", text: { content: "Latest run stats" }, annotations: { bold: true, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }] },
  });

  const total = stats.total ?? 0;
  const created = stats.created ?? 0;
  const updated = stats.updated ?? 0;
  const dryRun = stats.dry_run ?? 0;
  const sectionsWritten = stats.sections_written ?? 0;
  const timing = latest.timing || {};
  const phase1Ms = timing.phase1_ms ?? 0;
  const phase2Ms = timing.phase2_ms ?? 0;
  const lines: string[] = [
    `· Total: ${total}`,
    `· Created: ${created}  ·  Updated: ${updated}  ·  Errors: ${errors}${dryRun ? `  ·  Dry-run: ${dryRun}` : ""}`,
    `· Sections written: ${sectionsWritten}`,
    `· Timing: Phase 1 ${(phase1Ms / 1000).toFixed(1)}s · Phase 2 ${(phase2Ms / 1000).toFixed(1)}s`,
  ];
  if (latest.image_stats) {
    const s = latest.image_stats;
    const ratio = (s.uploads + s.cache_hits) > 0 ? Math.round(100 * s.cache_hits / (s.uploads + s.cache_hits)) : 0;
    lines.push(`· Images: ${s.uploads} uploaded · ${s.cache_hits} cached · ${ratio}% cache hit · ${s.total_in_cache} entries total`);
  }
  for (const line of lines) {
    blocks.push({
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: line }, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }] },
    });
  }

  // Errors section
  const errSummary = (latest.error_summary as any[]) ?? [];
  if (errSummary.length > 0) {
    blocks.push({
      type: "heading_3",
      heading_3: { rich_text: [{ type: "text", text: { content: `Errors (${errSummary.length})` }, annotations: { bold: true, italic: false, strikethrough: false, underline: false, code: false, color: "red" } }] },
    });
    for (const e of errSummary.slice(0, 10)) {
      const susp = (e.suspicions ?? []).length > 0 ? ` · [${(e.suspicions as string[]).join(", ")}]` : "";
      blocks.push({
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [
            { type: "text", text: { content: `${e.path}` }, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: true, color: "default" } },
            { type: "text", text: { content: susp }, annotations: { bold: false, italic: true, strikethrough: false, underline: false, code: false, color: "orange" } },
          ],
        },
      });
      if (e.error) {
        blocks.push({
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: "  " + (e.error as string).slice(0, 200) }, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "gray" } }] },
        });
      }
    }
    // Quick-retry hint
    const retryArgs = errSummary.slice(0, 10).map((e) => {
      const base = (e.path as string).replace(/\.md$/, "").split("/").pop() ?? "";
      return base;
    }).join(" ");
    blocks.push({
      type: "code",
      code: {
        rich_text: [{ type: "text", text: { content: `bash sync.sh --only ${retryArgs}` }, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }],
        language: "bash",
      },
    });
  }

  // Recent runs strip
  if (recent.length > 1) {
    blocks.push({
      type: "heading_3",
      heading_3: { rich_text: [{ type: "text", text: { content: `Recent runs (${recent.length})` }, annotations: { bold: true, italic: false, strikethrough: false, underline: false, code: false, color: "default" } }] },
    });
    for (const r of recent) {
      const rs = r.stats || {};
      const rp = r.partial === true;
      const re = (rs.errors ?? 0) as number;
      const badge = rp ? "⚠️" : re > 0 ? "❌" : r.dry_run ? "🔍" : "✅";
      const summary2 = rp
        ? `partial — ${r.partial_reason ?? "?"}`
        : re > 0
          ? `${re} error${re === 1 ? "" : "s"}`
          : r.dry_run
            ? "dry-run"
            : `${rs.created ?? 0} created · ${rs.updated ?? 0} updated`;
      blocks.push({
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [
            { type: "text", text: { content: `${badge} ` }, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" } },
            { type: "text", text: { content: r.run_id }, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: true, color: "default" } },
            { type: "text", text: { content: ` — ${summary2}` }, annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "gray" } },
          ],
        },
      });
    }
  }

  // Footer hint
  blocks.push({ type: "divider", divider: {} });
  blocks.push({
    type: "paragraph",
    paragraph: {
      rich_text: [{
        type: "text",
        text: { content: "From the terminal: bash list.sh recent-errors  ·  bash list.sh diff  ·  bash run.sh check" },
        annotations: { bold: false, italic: true, strikethrough: false, underline: false, code: false, color: "gray" },
      }],
    },
  });

  return blocks;
}

export interface GenerateHealthResult {
  health_page_id: string;
  page_was_created: boolean;
  ran_against: string | null; // run_id of the latest entry rendered, or null
  blocks_pushed: number;
  blocks_wiped: number;
}

export async function generateHealth(opts: {
  notion: Client;
  cache: HealthCache;
  runsPath: string;
  healthPageId?: string;
  rateLimitMs: number;
  log?: (msg: string) => void;
}): Promise<GenerateHealthResult> {
  const { notion, cache, runsPath, healthPageId, rateLimitMs } = opts;
  const log = opts.log ?? (() => {});

  log(`\nReading ${runsPath} for latest run…`);
  const latest = readLatestRun(runsPath);
  const recent = readRecentRuns(runsPath, 6);
  if (!latest) {
    log("  runs.jsonl is empty");
  } else {
    log(`  latest: ${latest.run_id}${latest.partial ? " (PARTIAL)" : ""}`);
  }

  const { id: pageId, created } = await findOrCreateHealthPage(
    notion, cache.root_id, healthPageId, rateLimitMs, log,
  );

  log(`  wiping existing blocks…`);
  const wiped = await wipeBlocks(notion, pageId, rateLimitMs);
  log(`  wiped ${wiped} block${wiped === 1 ? "" : "s"}`);

  const blocks = buildHealthBlocks(latest, recent);
  await notion.blocks.children.append({ block_id: pageId, children: blocks });
  await sleep(rateLimitMs);
  log(`  ✓ pushed ${blocks.length} blocks`);

  return {
    health_page_id: pageId,
    page_was_created: created,
    ran_against: latest?.run_id ?? null,
    blocks_pushed: blocks.length,
    blocks_wiped: wiped,
  };
}
