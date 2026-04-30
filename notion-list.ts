// notion-list — read remote page tree, cache, render, compare against local docs.
//
// Subcommands:
//   bun notion-list.ts fetch [--no-icons]   walk Notion, cache to .notion-cache.json
//   bun notion-list.ts show  [--max-depth N] [--empty-only]   render cached tree
//   bun notion-list.ts diff                 compare cache vs local docs
//
// Default (no subcommand) = `show` if cache exists, else `fetch` then `show`.
//
// The cache stores raw structure only — page IDs, titles, parent IDs, block
// counts, icons, URLs, fetched-at timestamp. Compare-content is a follow-up.

import { Client } from "@notionhq/client";
import * as fs from "fs";
import * as path from "path";

// ── Env loading (bun --env-file would work but we mimic sync.sh's behaviour) ──
const envContent = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
for (const line of envContent.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const NOTION_TOKEN = process.env.NOTION_TOKEN!;
const RAW_ROOT = process.env.NOTION_ROOT_PAGE_ID!;
const DOCS_DIR = process.env.DOCS_DIR ?? path.join(__dirname, "docs");
const RATE_LIMIT_MS = 350;
const CACHE_PATH = path.join(__dirname, ".notion-cache.json");

if (!NOTION_TOKEN || !RAW_ROOT) {
  console.error("notion-list: NOTION_TOKEN and NOTION_ROOT_PAGE_ID must be set in .env");
  process.exit(1);
}

const ROOT_ID = (RAW_ROOT.match(/([0-9a-f]{32})$/i)?.[1] ?? RAW_ROOT).replace(/-/g, "");

const notion = new Client({ auth: NOTION_TOKEN });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Cache shape ───────────────────────────────────────────────────────────────

interface CachedPage {
  id: string;
  title: string;
  parent_id: string | null;     // null = root
  url: string;
  block_count: number;          // total blocks of any type at this page level
  child_page_count: number;     // direct child_page blocks
  has_content: boolean;         // block_count > child_page_count (any prose/headings/etc)
  icon: { type: string; value: string } | null;  // null if --no-icons
  depth: number;                // 0 = root
}

interface Cache {
  fetched_at: string;
  root_id: string;
  pages: CachedPage[];          // flat list, ordered by depth-first traversal
  stats: {
    total_pages: number;
    total_api_calls: number;
    elapsed_ms: number;
    icons_fetched: boolean;
  };
}

// ── Pretty rendering helpers ──────────────────────────────────────────────────

const RESET = "\x1b[0m";
const c = (code: string, s: string) => `${code}${s}${RESET}`;
const dim = (s: string) => c("\x1b[2m", s);
const bold = (s: string) => c("\x1b[1m", s);
const grey = (s: string) => c("\x1b[38;5;245m", s);
const green = (s: string) => c("\x1b[32m", s);
const yellow = (s: string) => c("\x1b[33m", s);
const red = (s: string) => c("\x1b[31m", s);
const cyan = (s: string) => c("\x1b[36m", s);

function fmtSize(n: number): string {
  if (n === 0) return red("empty");
  if (n < 5) return yellow(`${n} blk`);
  if (n < 50) return `${n} blk`;
  return green(`${n} blk`);
}

// ── Walk: recursively fetch child pages ──────────────────────────────────────

async function listChildren(blockId: string): Promise<{ blocks: any[]; apiCalls: number }> {
  const blocks: any[] = [];
  let cursor: string | undefined;
  let apiCalls = 0;
  do {
    const res: any = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    apiCalls++;
    blocks.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
    await sleep(RATE_LIMIT_MS);
  } while (cursor);
  return { blocks, apiCalls };
}

async function walk(opts: { fetchIcons: boolean }): Promise<Cache> {
  const start = Date.now();
  const pages: CachedPage[] = [];
  let apiCalls = 0;

  // Root page metadata
  const rootMeta: any = await notion.pages.retrieve({ page_id: ROOT_ID });
  apiCalls++;
  await sleep(RATE_LIMIT_MS);
  const rootTitle = extractTitle(rootMeta) ?? "(root)";
  const rootIcon = opts.fetchIcons ? extractIcon(rootMeta) : null;

  // Recursive walk — produces depth-first ordered pages array
  async function visit(pageId: string, parentId: string | null, depth: number, title: string, icon: CachedPage["icon"]): Promise<void> {
    const url = `https://www.notion.so/${pageId.replace(/-/g, "")}`;
    process.stdout.write(`\r  fetching depth ${depth}: ${title.slice(0, 60).padEnd(60)} (${pages.length} pages so far)`);

    const { blocks, apiCalls: ac } = await listChildren(pageId);
    apiCalls += ac;
    const childPages = blocks.filter((b) => b.type === "child_page");

    pages.push({
      id: pageId,
      title,
      parent_id: parentId,
      url,
      block_count: blocks.length,
      child_page_count: childPages.length,
      has_content: blocks.length > childPages.length,
      icon,
      depth,
    });

    for (const cp of childPages) {
      const childTitle = cp.child_page?.title ?? "(untitled)";
      let childIcon: CachedPage["icon"] = null;
      if (opts.fetchIcons) {
        try {
          const meta: any = await notion.pages.retrieve({ page_id: cp.id });
          apiCalls++;
          childIcon = extractIcon(meta);
          await sleep(RATE_LIMIT_MS);
        } catch {
          // ignore icon fetch failures
        }
      }
      await visit(cp.id, pageId, depth + 1, childTitle, childIcon);
    }
  }

  await visit(ROOT_ID, null, 0, rootTitle, rootIcon);
  process.stdout.write("\r" + " ".repeat(120) + "\r");

  return {
    fetched_at: new Date().toISOString(),
    root_id: ROOT_ID,
    pages,
    stats: {
      total_pages: pages.length,
      total_api_calls: apiCalls,
      elapsed_ms: Date.now() - start,
      icons_fetched: opts.fetchIcons,
    },
  };
}

function extractTitle(page: any): string | null {
  const props = page?.properties;
  if (!props) return null;
  for (const v of Object.values(props) as any[]) {
    if (v?.type === "title" && Array.isArray(v.title)) {
      return v.title.map((t: any) => t.plain_text).join("") || null;
    }
  }
  return null;
}
function extractIcon(page: any): CachedPage["icon"] {
  const i = page?.icon;
  if (!i) return null;
  if (i.type === "emoji") return { type: "emoji", value: i.emoji };
  if (i.type === "external") return { type: "external", value: i.external?.url ?? "" };
  if (i.type === "file") return { type: "file", value: i.file?.url ?? "" };
  return { type: i.type, value: "" };
}

// ── Render: tree view from cached pages list ─────────────────────────────────

function renderTree(cache: Cache, opts: { maxDepth?: number; emptyOnly?: boolean }): void {
  const { fetched_at, pages, stats } = cache;
  const fetchedAgo = humanAgo(new Date(fetched_at));
  console.log(bold("\nNotion remote tree"));
  console.log(dim("─".repeat(72)));
  console.log(`${dim("Fetched:")}  ${fetched_at}  ${dim(`(${fetchedAgo})`)}`);
  console.log(`${dim("Pages:")}    ${stats.total_pages}`);
  console.log(`${dim("API:")}      ${stats.total_api_calls} calls in ${(stats.elapsed_ms / 1000).toFixed(1)}s${stats.icons_fetched ? "" : dim(" (no icons)")}`);
  console.log(dim("─".repeat(72)));
  console.log("");

  // pages array is already depth-first ordered. Build child map for sibling-aware tree drawing.
  const byParent = new Map<string | null, CachedPage[]>();
  for (const p of pages) {
    const arr = byParent.get(p.parent_id) ?? [];
    arr.push(p);
    byParent.set(p.parent_id, arr);
  }

  const root = pages.find((p) => p.parent_id === null);
  if (!root) {
    console.log(red("  (cache has no root page)"));
    return;
  }

  let lineCount = 0;
  let emptyCount = 0;

  function shouldShow(p: CachedPage): boolean {
    if (opts.maxDepth != null && p.depth > opts.maxDepth) return false;
    if (opts.emptyOnly && p.has_content) return false;
    return true;
  }

  function draw(page: CachedPage, prefix: string, isLast: boolean): void {
    const children = byParent.get(page.id) ?? [];
    const branch = page.depth === 0 ? "" : isLast ? "└── " : "├── ";
    const iconStr = page.icon?.type === "emoji" ? `${page.icon.value} ` : page.icon ? "🖼️  " : "";
    const empty = !page.has_content;
    const titleStr = empty && page.child_page_count === 0 ? red(page.title) : page.title;

    if (shouldShow(page)) {
      const sizePart = empty
        ? page.child_page_count > 0
          ? dim(`(${page.child_page_count} subpages, no own content)`)
          : red("(empty)")
        : `${fmtSize(page.block_count - page.child_page_count)}${page.child_page_count > 0 ? dim(` + ${page.child_page_count} sub`) : ""}`;
      const url = grey(page.url);
      console.log(`${prefix}${branch}${iconStr}${bold(titleStr)}  ${sizePart}  ${url}`);
      lineCount++;
      if (empty && page.child_page_count === 0) emptyCount++;
    }

    if (opts.maxDepth != null && page.depth >= opts.maxDepth) return;
    const childPrefix = prefix + (page.depth === 0 ? "" : isLast ? "    " : "│   ");
    children.forEach((child, i) => draw(child, childPrefix, i === children.length - 1));
  }

  draw(root, "", true);
  console.log(dim("─".repeat(72)));
  console.log(`${dim("Shown:")}    ${lineCount} pages   ${red(String(emptyCount))} truly empty`);
  if (opts.emptyOnly) console.log(dim(`(filter: --empty-only)`));
  console.log("");
}

function humanAgo(d: Date): string {
  const ms = Date.now() - d.getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ── Diff: cache vs local docs ────────────────────────────────────────────────

function scanLocalDocs(): { titles: Set<string>; pathByTitle: Map<string, string> } {
  const titles = new Set<string>();
  const pathByTitle = new Map<string, string>();
  function walk(absDir: string, relPrefix: string): void {
    if (!fs.existsSync(absDir)) return;
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (ent.name.startsWith("_") && ent.name !== "_index.md") continue;
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      if (ent.isFile() && ent.name.endsWith(".md")) {
        const raw = fs.readFileSync(path.join(absDir, ent.name), "utf8");
        const titleMatch = raw.match(/^---[\s\S]*?---\s*#\s+(.+)$/m) ?? raw.match(/^#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : path.basename(ent.name, ".md");
        titles.add(title);
        pathByTitle.set(title, rel);
      } else if (ent.isDirectory()) {
        walk(path.join(absDir, ent.name), rel);
      }
    }
  }
  walk(DOCS_DIR, "");
  return { titles, pathByTitle };
}

function runDiff(cache: Cache): void {
  const local = scanLocalDocs();
  const remoteTitles = new Set(cache.pages.map((p) => p.title));

  const onlyRemote = cache.pages.filter((p) => p.parent_id !== null && !local.titles.has(p.title));
  const onlyLocal = [...local.titles].filter((t) => !remoteTitles.has(t));
  const emptyRemote = cache.pages.filter((p) => p.parent_id !== null && p.block_count === 0);

  console.log(bold("\nDiff: remote vs local"));
  console.log(dim("─".repeat(72)));
  console.log(`${dim("Local docs:")}    ${local.titles.size}`);
  console.log(`${dim("Remote pages:")}  ${cache.pages.length - 1}  ${dim("(excluding root)")}`);
  console.log(dim("─".repeat(72)));

  console.log(`\n${bold(red(`✗ Remote-only (${onlyRemote.length})`))}  ${dim("— pages on Notion with no matching local title")}`);
  for (const p of onlyRemote.slice(0, 50)) {
    console.log(`    ${cyan(p.title)}  ${dim(p.url)}`);
  }
  if (onlyRemote.length > 50) console.log(dim(`    … +${onlyRemote.length - 50} more`));

  console.log(`\n${bold(yellow(`⚠ Empty remote pages (${emptyRemote.length})`))}  ${dim("— page exists but has 0 blocks")}`);
  for (const p of emptyRemote.slice(0, 50)) {
    const localHint = local.pathByTitle.get(p.title);
    console.log(`    ${cyan(p.title)}  ${dim(p.url)}${localHint ? `  ${dim("↳ " + localHint)}` : ""}`);
  }
  if (emptyRemote.length > 50) console.log(dim(`    … +${emptyRemote.length - 50} more`));

  console.log(`\n${bold(green(`+ Local-only (${onlyLocal.length})`))}  ${dim("— local docs with no matching remote page title")}`);
  for (const t of onlyLocal.slice(0, 50)) {
    console.log(`    ${cyan(t)}  ${dim("↳ " + (local.pathByTitle.get(t) ?? ""))}`);
  }
  if (onlyLocal.length > 50) console.log(dim(`    … +${onlyLocal.length - 50} more`));

  console.log("");
  console.log(dim("─".repeat(72)));
  console.log(`Tip: title-based match is brittle — a follow-up will compare by parent path.`);
  console.log("");
}

// ── Cache I/O ────────────────────────────────────────────────────────────────

function loadCache(): Cache | null {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch (e: any) {
    console.error(red(`cache parse failed: ${e.message}`));
    return null;
  }
}
function saveCache(cache: Cache): void {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// ── Entrypoint ───────────────────────────────────────────────────────────────

(async () => {
  const args = process.argv.slice(2);
  const cmd = args[0] && !args[0].startsWith("-") ? args[0] : "auto";
  const flags = new Set(args);

  const fetchIcons = !flags.has("--no-icons");
  const emptyOnly = flags.has("--empty-only");
  const maxDepthArg = args[args.indexOf("--max-depth") + 1];
  const maxDepth = args.includes("--max-depth") ? parseInt(maxDepthArg, 10) : undefined;

  if (cmd === "fetch" || (cmd === "auto" && !loadCache())) {
    console.log(bold(`\nFetching Notion tree from root ${ROOT_ID}…`));
    if (!fetchIcons) console.log(dim("  (--no-icons: skipping per-page metadata fetch)"));
    const cache = await walk({ fetchIcons });
    saveCache(cache);
    console.log(green(`✓ Cached ${cache.pages.length} pages → ${path.relative(process.cwd(), CACHE_PATH)}`));
    if (cmd === "fetch") return;
  }

  const cache = loadCache();
  if (!cache) {
    console.error(red("no cache available — run `notion-list fetch` first"));
    process.exit(1);
  }

  if (cmd === "diff") {
    runDiff(cache);
  } else if (cmd === "empty-paths") {
    // Print local paths whose remote page exists but has 0 blocks. One per line.
    // Use directly via shell substitution:
    //   bash sync.sh --only $(bash list.sh empty-paths)
    const local = scanLocalDocs();
    const empties = cache.pages.filter((p) => p.parent_id !== null && p.block_count === 0);
    const matched: string[] = [];
    const unmatched: string[] = [];
    for (const p of empties) {
      const localPath = local.pathByTitle.get(p.title);
      if (localPath) matched.push(localPath);
      else unmatched.push(p.title);
    }
    if (unmatched.length > 0) {
      console.error(dim(`# ${unmatched.length} empty remote pages had no matching local title (skipped):`));
      for (const t of unmatched) console.error(dim(`#   ${t}  (likely a section page; title differs from _index.md heading)`));
    }
    if (matched.length === 0) {
      console.error(dim("# (no empty pages with matching local docs — nothing to retry)"));
      process.exit(2); // non-zero so command substitution into --only doesn't run sync with no args
    }
    for (const p of matched) console.log(p);
  } else {
    renderTree(cache, { maxDepth, emptyOnly });
  }
})();
