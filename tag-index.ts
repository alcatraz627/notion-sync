// tag-index.ts — generate the 🏷️ Tags dashboard page on Notion.
//
// Walks DOCS_DIR for every leaf doc, parses frontmatter and body for tags,
// matches each doc to its Notion page via title from .notion-cache.json,
// aggregates tag → list of pages, and renders a single markdown page where
// each tag is an H3 followed by mention pills of its pages.
//
// Surface: bash list.sh tag-index. Auto-creates a "🏷️ Tags" page under
// the docs root, or honours NOTION_TAG_INDEX_PAGE_ID if set.
//
// Why duplicate the frontmatter parser here: keeping tag-index.ts an
// independent module (no import from index.ts) avoids dragging in the
// whole sync-time dependency tree (image upload, mention conversion,
// Phase 1.5 logic) just to walk the docs and render a flat list.

import { Client } from "@notionhq/client";
import * as fs from "fs";
import * as path from "path";
import { convertPageLinksToMentions } from "./mention-converter";

const TAG_INDEX_TITLE = "🏷️ Tags";

export interface TagIndexPage {
  id: string;
  title: string;
  parent_id: string | null;
  url: string;
  depth: number;
}

export interface TagIndexCache {
  fetched_at: string;
  root_id: string;
  pages: TagIndexPage[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Local frontmatter parser — copy of the shape used in index.ts.
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

// Mirror of extractTags from index.ts. Supports frontmatter `tags: [a,b]`
// and body convention `**Tags:** `a`, `b`, `c``. Lower-cases + dedupes.
function extractTags(meta: Record<string, string>, body: string): string[] {
  const out = new Set<string>();
  const ftRaw = meta.tags ?? meta.tag;
  if (ftRaw) {
    const cleaned = ftRaw.replace(/^\[|\]$/g, "").replace(/[`]/g, "");
    for (const t of cleaned.split(",")) {
      const trimmed = t.trim().replace(/^["']|["']$/g, "");
      if (trimmed && trimmed.length < 40) out.add(trimmed.toLowerCase());
    }
  }
  const bodyMatch = body.match(/^\*\*Tags?:?\*\*[:\s]*(.+?)$/im);
  if (bodyMatch) {
    for (const m of bodyMatch[1].matchAll(/`([^`]+)`/g)) {
      const t = m[1].trim().toLowerCase();
      if (t && t.length < 40) out.add(t);
    }
  }
  return Array.from(out).sort();
}

interface DocEntry {
  relPath: string;
  title: string;
  tags: string[];
}

// Walk DOCS_DIR for every .md file (excluding _*.md hidden files; _index.md
// is included because it's the section's content). Returns one entry per
// doc with extracted title + tags.
function walkDocs(docsDir: string): DocEntry[] {
  const out: DocEntry[] = [];
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
      // _*.md and *.claude.md skipped — except _index.md which is the section content.
      if (entry.name.startsWith("_") && entry.name !== "_index.md") continue;
      if (entry.name.endsWith(".claude.md")) continue;
      const raw = fs.readFileSync(abs, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const title = extractTitle(body, rel);
      const tags = extractTags(meta, body);
      if (tags.length > 0) {
        out.push({ relPath: rel, title, tags });
      }
    }
  }
  walk(docsDir, "");
  return out;
}

async function findOrCreateTagIndexPage(
  notion: Client,
  rootId: string,
  providedId: string | undefined,
  rateLimitMs: number,
  log: (msg: string) => void,
): Promise<{ id: string; created: boolean }> {
  if (providedId) {
    log(`  using configured NOTION_TAG_INDEX_PAGE_ID: ${providedId}`);
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
      if (block.child_page?.title !== TAG_INDEX_TITLE) continue;
      const page: any = await notion.pages.retrieve({ page_id: block.id });
      await sleep(rateLimitMs);
      if (page.in_trash || page.archived) continue;
      log(`  found existing tag-index page: ${block.id}`);
      return { id: block.id, created: false };
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  const created: any = await notion.pages.create({
    parent: { page_id: rootId },
    properties: {
      title: { title: [{ type: "text", text: { content: TAG_INDEX_TITLE } }] },
    },
    icon: { type: "emoji", emoji: "🏷️" },
  });
  await sleep(rateLimitMs);
  log(`  created tag-index page: ${created.id}`);
  return { id: created.id, created: true };
}

// Wipe all blocks on the target page before re-rendering.
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

// Aggregate per-doc tags into a tag → docs map. Match local docs to Notion
// pages by title from the cache. Unmatched docs are still surfaced under
// each tag, but render as plain text (no mention pill).
interface TagAggregate {
  [tag: string]: Array<{ title: string; relPath: string; pageUrl: string | null }>;
}

function aggregate(docs: DocEntry[], cache: TagIndexCache): TagAggregate {
  const titleToUrl = new Map<string, string>();
  for (const p of cache.pages) titleToUrl.set(p.title, p.url);
  const out: TagAggregate = {};
  for (const doc of docs) {
    const url = titleToUrl.get(doc.title) ?? null;
    for (const tag of doc.tags) {
      const arr = out[tag] ?? (out[tag] = []);
      arr.push({ title: doc.title, relPath: doc.relPath, pageUrl: url });
    }
  }
  // Sort each tag's doc list by title for stable output.
  for (const tag of Object.keys(out)) {
    out[tag].sort((a, b) => a.title.localeCompare(b.title));
  }
  return out;
}

function renderHeader(totalTags: number, totalDocs: number): string {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return [
    `# ${TAG_INDEX_TITLE}`,
    "",
    `_Last refreshed: ${ts} · ${totalTags} tags across ${totalDocs} docs_`,
    "",
    "Each tag below collects every doc that carries it (frontmatter `tags:` or body `**Tags:**` line). Click a doc title to jump to its Notion page.",
    "",
    "---",
    "",
  ].join("\n");
}

function renderTagSection(
  tag: string,
  docs: Array<{ title: string; relPath: string; pageUrl: string | null }>,
): string {
  const lines: string[] = [];
  lines.push(`## \`#${tag}\` _(${docs.length})_`);
  lines.push("");
  for (const d of docs) {
    if (d.pageUrl) {
      lines.push(`- [${d.title}](${d.pageUrl})`);
    } else {
      lines.push(`- ${d.title} _(unmatched: ${d.relPath})_`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

// Linear-backoff retry on transient 5xx — same pattern as sitemap.ts.
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

export interface GenerateTagIndexResult {
  tag_index_page_id: string;
  page_was_created: boolean;
  total_tags: number;
  total_docs_with_tags: number;
  matched_docs: number;
  unmatched_docs: number;
  blocks_wiped: number;
  mentions_converted: number;
  blocks_updated: number;
}

export async function generateTagIndex(opts: {
  notion: Client;
  cache: TagIndexCache;
  docsDir: string;
  tagIndexPageId?: string;
  rateLimitMs: number;
  log?: (msg: string) => void;
}): Promise<GenerateTagIndexResult> {
  const { notion, cache, docsDir, tagIndexPageId, rateLimitMs } = opts;
  const log = opts.log ?? (() => {});

  log(`\nWalking ${docsDir} for tags…`);
  const docs = walkDocs(docsDir);
  const matched = docs.filter((d) => cache.pages.some((p) => p.title === d.title)).length;
  const tagMap = aggregate(docs, cache);
  const tags = Object.keys(tagMap).sort();
  log(`  found ${tags.length} unique tags across ${docs.length} docs (${matched} matched to Notion pages)`);

  if (tags.length === 0) {
    log("  no tags found — nothing to render. Add `tags: [foo, bar]` to a doc's frontmatter or `**Tags:** \\`foo\\`, \\`bar\\`` in its body.");
    return {
      tag_index_page_id: "",
      page_was_created: false,
      total_tags: 0,
      total_docs_with_tags: 0,
      matched_docs: 0,
      unmatched_docs: 0,
      blocks_wiped: 0,
      mentions_converted: 0,
      blocks_updated: 0,
    };
  }

  const { id: pageId, created } = await findOrCreateTagIndexPage(
    notion, cache.root_id, tagIndexPageId, rateLimitMs, log,
  );

  log(`  wiping existing blocks…`);
  const wiped = await wipeBlocks(notion, pageId, rateLimitMs);
  log(`  wiped ${wiped} block${wiped === 1 ? "" : "s"}`);

  // Header chunk.
  await withChunkRetry("header", () =>
    (notion.pages as any).updateMarkdown({
      page_id: pageId,
      type: "insert_content",
      insert_content: { content: renderHeader(tags.length, docs.length) },
    }),
    log,
  );
  await sleep(Math.max(rateLimitMs, 1500));

  // One chunk per tag — keeps each insert small and avoids backpressure 504s
  // on the larger pages.
  let pushed = 0;
  for (const tag of tags) {
    await withChunkRetry(`#${tag}`, () =>
      (notion.pages as any).updateMarkdown({
        page_id: pageId,
        type: "insert_content",
        insert_content: { content: renderTagSection(tag, tagMap[tag]) },
      }),
      log,
    );
    await sleep(Math.max(rateLimitMs, 1500));
    pushed++;
    log(`  ✓ pushed [${pushed}/${tags.length}] #${tag} (${tagMap[tag].length} docs)`);
  }

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
  log(`  ✓ converted ${mentionResult.links_converted} link${mentionResult.links_converted === 1 ? "" : "s"} → mention${mentionResult.links_converted === 1 ? "" : "s"} (${mentionResult.blocks_updated} block update${mentionResult.blocks_updated === 1 ? "" : "s"})`);

  return {
    tag_index_page_id: pageId,
    page_was_created: created,
    total_tags: tags.length,
    total_docs_with_tags: docs.length,
    matched_docs: matched,
    unmatched_docs: docs.length - matched,
    blocks_wiped: wiped,
    mentions_converted: mentionResult.links_converted,
    blocks_updated: mentionResult.blocks_updated,
  };
}
