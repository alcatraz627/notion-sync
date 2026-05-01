// backlinks.ts — append a "🔗 Linked from" callout to each Notion page
// listing every other doc in the tree that references it.
//
// Surface: bash list.sh backlinks. Idempotent — finds and replaces an
// existing backlinks callout (identified by the 🔗 emoji icon + the
// "Linked from" text prefix) so re-runs don't accumulate stale ones.
//
// Why a callout, not a paragraph: Notion renders callouts with a
// subtle background tint, making the backlinks visually distinct
// from the doc body. The 🔗 icon plus gray_background color
// produces a "metadata" look that doesn't compete with the page's
// real content.
//
// Match strategy: walk DOCS_DIR locally, parse markdown links in
// each .md file, resolve relative paths to canonical relPaths, then
// build an inverse map (target → list of sources). Match each
// targetPath to a Notion page via title from the cache. Unmatched
// targets are skipped with a count in the summary.

import { Client } from "@notionhq/client";
import * as fs from "fs";
import * as path from "path";

const BACKLINK_EMOJI = "🔗";
const BACKLINK_PREFIX = "Linked from "; // first text span in the callout — used as the marker on re-runs

export interface BacklinksCachePage {
  id: string;
  title: string;
  parent_id: string | null;
  url: string;
}

export interface BacklinksCache {
  fetched_at: string;
  root_id: string;
  pages: BacklinksCachePage[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Local frontmatter parser — mirror of index.ts's. Kept inline to keep
// this module independent of the sync-time pipeline.
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  let meta: Record<string, string> = {};
  let body = content;
  if (match) {
    body = content.slice(match[0].length);
    for (const line of match[1].split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return { meta, body };
}

function extractTitle(body: string, relPath: string): string {
  const h1 = body.match(/^#\s+(.+)$/m);
  return h1 ? h1[1].trim() : path.basename(relPath, ".md");
}

interface DocInfo {
  relPath: string;
  title: string;
  body: string;
}

// Walk DOCS_DIR for every .md file (excluding _*.md hidden files
// except _index.md) and return its parsed metadata.
function walkAllDocs(docsDir: string): DocInfo[] {
  const out: DocInfo[] = [];
  function walk(dir: string, relDir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      if (entry.name.startsWith("_") && entry.name !== "_index.md") continue;
      if (entry.name.endsWith(".claude.md")) continue;
      const raw = fs.readFileSync(abs, "utf8");
      const { body } = parseFrontmatter(raw);
      out.push({ relPath: rel, title: extractTitle(body, rel), body });
    }
  }
  walk(docsDir, "");
  return out;
}

// Extract every internal markdown link in a doc body and resolve it to
// a canonical relPath. Skips external links (http/mailto/anchors) and
// images. Mirrors the relative-path resolution in rewriteLinks() —
// section/dir links collapse to the corresponding `_index.md`.
function extractInternalLinks(sourceRelPath: string, body: string, allRelPaths: Set<string>): string[] {
  const out = new Set<string>();
  const dir = path.dirname(sourceRelPath);
  const linkRe = /\[([^\]]*)\]\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(body)) !== null) {
    let url = m[2].trim();
    if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:")) continue;
    if (url.startsWith("#")) continue;
    const [urlPath] = url.split("#");
    const isInternal =
      urlPath.endsWith(".md") ||
      urlPath.endsWith("/") ||
      urlPath === "" ||
      (urlPath.length > 0 && !path.extname(urlPath));
    if (!isInternal) continue;
    const resolved = path.normalize(path.join(dir, urlPath || ".")).replace(/\\/g, "/");
    if (resolved.startsWith("..")) continue;
    const noTrail = resolved.replace(/\/$/, "");
    const candidates = [
      resolved,
      resolved.replace(/\.md$/, ""),
      resolved + ".md",
      `${noTrail}/_index.md`,
    ];
    for (const c of candidates) {
      if (allRelPaths.has(c)) {
        out.add(c);
        break;
      }
    }
  }
  return Array.from(out);
}

interface BacklinkSource {
  relPath: string;
  title: string;
}

function buildBacklinkMap(docs: DocInfo[]): Map<string, BacklinkSource[]> {
  const allRelPaths = new Set(docs.map((d) => d.relPath));
  const out = new Map<string, BacklinkSource[]>();
  for (const src of docs) {
    const targets = extractInternalLinks(src.relPath, src.body, allRelPaths);
    for (const t of targets) {
      if (t === src.relPath) continue; // self-link, skip
      const arr = out.get(t) ?? [];
      // Dedupe — a doc that links to the same target multiple times
      // should only appear once in the backlinks list.
      if (!arr.some((s) => s.relPath === src.relPath)) {
        arr.push({ relPath: src.relPath, title: src.title });
      }
      out.set(t, arr);
    }
  }
  // Sort each target's sources by title for stable rendering.
  for (const arr of out.values()) {
    arr.sort((a, b) => a.title.localeCompare(b.title));
  }
  return out;
}

// Build the callout block payload for a target page's backlinks.
function buildBacklinkCallout(sources: Array<{ id: string; title: string }>): any {
  const richText: any[] = [
    {
      type: "text",
      text: { content: BACKLINK_PREFIX },
      annotations: { bold: true, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
    },
  ];
  sources.forEach((s, i) => {
    if (i > 0) {
      richText.push({
        type: "text",
        text: { content: ", " },
        annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "gray" },
      });
    }
    richText.push({
      type: "mention",
      mention: { type: "page", page: { id: s.id } },
      annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
    });
  });
  return {
    type: "callout",
    callout: {
      icon: { type: "emoji", emoji: BACKLINK_EMOJI },
      rich_text: richText,
      color: "gray_background",
    },
  };
}

// Detect an existing backlinks callout we authored on a page — by 🔗
// icon AND the first rich_text content starting with "Linked from ".
// Robust against accidental matches with user-authored callouts.
function isOurBacklinkCallout(block: any): boolean {
  if (block?.type !== "callout") return false;
  if (block.callout?.icon?.type !== "emoji") return false;
  if (block.callout?.icon?.emoji !== BACKLINK_EMOJI) return false;
  const firstSpan = block.callout?.rich_text?.[0];
  if (!firstSpan || firstSpan.type !== "text") return false;
  return firstSpan.text?.content?.startsWith(BACKLINK_PREFIX) ?? false;
}

async function findExistingBacklinkBlocks(
  notion: Client,
  pageId: string,
  rateLimitMs: number,
): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    await sleep(rateLimitMs);
    for (const block of res.results) {
      if (isOurBacklinkCallout(block)) out.push(block.id);
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function withRetry<T>(label: string, fn: () => Promise<T>, log: (msg: string) => void, maxAttempts = 4): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err?.status;
      const code = err?.code;
      const retriable =
        status === 504 || status === 502 || status === 503 ||
        status === 408 || status === 429 ||
        code === "notionhq_client_request_timeout" ||
        code === "ECONNRESET" || code === "ETIMEDOUT";
      if (!retriable || attempt === maxAttempts) throw err;
      const waitMs = 4000 * attempt;
      log(`    [${label}] ${status ?? code} — retry ${attempt}/${maxAttempts - 1} in ${waitMs / 1000}s`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

export interface GenerateBacklinksResult {
  total_docs_scanned: number;
  total_links_found: number;
  pages_with_backlinks: number;
  pages_unmatched: number;
  callouts_replaced: number;
  callouts_added: number;
  callouts_removed: number; // pages that previously had backlinks but no longer do
}

export async function generateBacklinks(opts: {
  notion: Client;
  cache: BacklinksCache;
  docsDir: string;
  rateLimitMs: number;
  log?: (msg: string) => void;
}): Promise<GenerateBacklinksResult> {
  const { notion, cache, docsDir, rateLimitMs } = opts;
  const log = opts.log ?? (() => {});

  log(`\nWalking ${docsDir} for the link graph…`);
  const docs = walkAllDocs(docsDir);
  log(`  scanned ${docs.length} docs`);

  const backlinkMap = buildBacklinkMap(docs);
  const totalLinks = Array.from(backlinkMap.values()).reduce((n, arr) => n + arr.length, 0);
  log(`  found ${totalLinks} internal link${totalLinks === 1 ? "" : "s"} across ${backlinkMap.size} target pages`);

  // Title → page index (best-effort matching, like tag-index.ts).
  const titleToPage = new Map<string, BacklinksCachePage>();
  for (const p of cache.pages) {
    if (!titleToPage.has(p.title)) titleToPage.set(p.title, p);
  }

  let pagesWithBacklinks = 0;
  let pagesUnmatched = 0;
  let calloutsReplaced = 0;
  let calloutsAdded = 0;
  let calloutsRemoved = 0;
  let processed = 0;

  // First pass: every target with backlinks → ensure a callout exists.
  for (const [targetPath, sources] of backlinkMap) {
    processed++;
    // Find the target's title from the docs walk.
    const targetDoc = docs.find((d) => d.relPath === targetPath);
    if (!targetDoc) continue;
    const targetPage = titleToPage.get(targetDoc.title);
    if (!targetPage) {
      pagesUnmatched++;
      continue;
    }

    // Resolve each source to a Notion page id (drop sources we can't match).
    const matchedSources: Array<{ id: string; title: string }> = [];
    for (const s of sources) {
      const sd = docs.find((d) => d.relPath === s.relPath);
      if (!sd) continue;
      const sp = titleToPage.get(sd.title);
      if (sp) matchedSources.push({ id: sp.id, title: sd.title });
    }
    if (matchedSources.length === 0) continue;

    pagesWithBacklinks++;

    // Find existing callout (if any), delete it, then append the new one.
    const existing = await withRetry(
      `find ${targetPath}`,
      () => findExistingBacklinkBlocks(notion, targetPage.id, rateLimitMs),
      log,
    );
    for (const blockId of existing) {
      await withRetry(
        `delete ${targetPath}`,
        () => notion.blocks.delete({ block_id: blockId }),
        log,
      );
      await sleep(rateLimitMs);
    }

    await withRetry(
      `append ${targetPath}`,
      () =>
        notion.blocks.children.append({
          block_id: targetPage.id,
          children: [buildBacklinkCallout(matchedSources)],
        }),
      log,
    );
    await sleep(rateLimitMs);

    if (existing.length > 0) calloutsReplaced++;
    else calloutsAdded++;

    if (processed % 25 === 0) {
      log(`  [${processed}/${backlinkMap.size}] processed · ${calloutsAdded} added · ${calloutsReplaced} replaced`);
    }
  }
  log(`  [${processed}/${backlinkMap.size}] done · ${calloutsAdded} added · ${calloutsReplaced} replaced`);

  // Note: we do NOT walk cache pages that aren't current backlink
  // targets to look for stale callouts from a previous run — that
  // would mean an O(N) blocks.children.list pass over the entire
  // tree on every run (~5 min on a 300-page tree). If a page used to
  // have inbound links but no longer does, its old callout sits there
  // until either (a) someone links to it again, in which case the
  // callout is replaced, or (b) the user deletes it manually. This
  // is an acceptable v1 tradeoff; could be optimized by maintaining
  // a local `.notion-backlinks-state.json` of pages we last touched.

  return {
    total_docs_scanned: docs.length,
    total_links_found: totalLinks,
    pages_with_backlinks: pagesWithBacklinks,
    pages_unmatched: pagesUnmatched,
    callouts_replaced: calloutsReplaced,
    callouts_added: calloutsAdded,
    callouts_removed: calloutsRemoved,
  };
}
