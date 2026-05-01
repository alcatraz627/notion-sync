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
import { convertPageLinksToMentions } from "./mention-converter";

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

// ── Status-line helpers ───────────────────────────────────────────────────────
// Two flavours: bounded progress bar (used when total is known up front, e.g.
// fix-mentions, diff) and unbounded counter (used during fetch, where total
// page count is only knowable by completing the walk).

function fmtElapsedShort(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

function progressBar(n: number, total: number, label: string, startTs: number): string {
  const pct = total > 0 ? n / total : 0;
  const width = 28;
  const filled = Math.min(width, Math.round(pct * width));
  // Use Unicode block + light-shade for a clean filled/empty look
  const bar = "\x1b[32m" + "█".repeat(filled) + "\x1b[0m" + "\x1b[2m" + "░".repeat(width - filled) + "\x1b[0m";
  const pctStr = String(Math.floor(pct * 100)).padStart(3);
  const elapsed = Date.now() - startTs;
  // Use already-elapsed avg-per-item to project remaining. n must be >0 for
  // the rate to be meaningful — otherwise show "—" for ETA.
  const remaining = Math.max(0, total - n);
  let etaStr = "—";
  if (n > 0 && remaining > 0) {
    const avgMsPerItem = elapsed / n;
    const etaMs = remaining * avgMsPerItem;
    etaStr = fmtElapsedShort(etaMs);
  }
  const truncLabel = label.length > 48 ? label.slice(0, 47) + "…" : label;
  return `[${bar}] ${String(n).padStart(String(total).length)}/${total} ${pctStr}%  ETA ${etaStr.padStart(7)}  ${truncLabel.padEnd(48)}`;
}

function unboundedStatus(n: number, label: string, startTs: number): string {
  const elapsed = Date.now() - startTs;
  const rate = n > 0 ? n / Math.max(1, elapsed / 1000) : 0;
  const truncLabel = label.length > 50 ? label.slice(0, 49) + "…" : label;
  return `${dim(`elapsed ${fmtElapsedShort(elapsed)}  ·  ${n} pages  ·  ${rate.toFixed(1)}/s`)}  ${truncLabel.padEnd(50)}`;
}

function clearLine(): void {
  process.stdout.write("\r" + " ".repeat(120) + "\r");
}

// Retry transient Notion failures (5xx, network errors, rate-limit 429).
// Cloudflare often returns 502 mid-walk under load. Without retry, a single
// blip kills the whole fetch. Backoff: 2s, 4s, 8s, 16s, 32s. Honours
// Retry-After header on 429/503 if present.
async function withRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const status = err?.status;
      const retriable =
        status === 429 ||
        status === 408 ||
        (status >= 500 && status < 600) ||
        err?.code === "ECONNRESET" ||
        err?.code === "ETIMEDOUT" ||
        err?.code === "notionhq_client_request_timeout" ||
        (err?.code === "notionhq_client_response_error" && status >= 500);
      if (!retriable || attempt === maxAttempts) throw err;
      const retryAfterHeader = err?.headers?.["retry-after"];
      const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 0;
      const backoffMs = Math.min(32000, 2000 * Math.pow(2, attempt - 1));
      const waitMs = Math.max(retryAfterMs, backoffMs);
      process.stdout.write(
        `\r${" ".repeat(120)}\r${dim(`  [${label}] transient ${status ?? err.code} — retry ${attempt}/${maxAttempts - 1} in ${Math.round(waitMs / 1000)}s`)}\n`,
      );
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

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
    const res: any = await withRetry("list", () =>
      notion.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    );
    apiCalls++;
    blocks.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
    await sleep(RATE_LIMIT_MS);
  } while (cursor);
  return { blocks, apiCalls };
}

// Module-level handles for crash-safe partial save (the SIGINT/uncaught-exception
// handlers below dump these to disk so the user doesn't lose 88 pages of work
// to a Cloudflare 502 on the 89th page).
let walkProgress: { pages: CachedPage[]; apiCalls: number; start: number; fetchIcons: boolean } | null = null;
function savePartial(reason: string): void {
  if (!walkProgress || walkProgress.pages.length === 0) return;
  const cache: Cache = {
    fetched_at: new Date().toISOString(),
    root_id: ROOT_ID,
    pages: walkProgress.pages,
    stats: {
      total_pages: walkProgress.pages.length,
      total_api_calls: walkProgress.apiCalls,
      elapsed_ms: Date.now() - walkProgress.start,
      icons_fetched: walkProgress.fetchIcons,
    },
  };
  // Mark partial in a sidecar field so `show` can warn
  (cache as any).partial = true;
  (cache as any).partial_reason = reason;
  saveCache(cache);
  console.error(yellow(`\n⚠ Partial cache saved (${cache.pages.length} pages, ${reason}) → ${path.relative(process.cwd(), CACHE_PATH)}`));
}
process.on("SIGINT", () => { savePartial("SIGINT"); process.exit(130); });
process.on("uncaughtException", (e) => { savePartial(`uncaught: ${e?.message?.slice(0,60) ?? "err"}`); process.exit(1); });

async function walk(opts: { fetchIcons: boolean }): Promise<Cache> {
  const start = Date.now();
  const pages: CachedPage[] = [];
  let apiCalls = 0;
  walkProgress = { pages, apiCalls: 0, start, fetchIcons: opts.fetchIcons };

  // Root page metadata
  const rootMeta: any = await withRetry("root", () => notion.pages.retrieve({ page_id: ROOT_ID }));
  apiCalls++; walkProgress.apiCalls = apiCalls;
  await sleep(RATE_LIMIT_MS);
  const rootTitle = extractTitle(rootMeta) ?? "(root)";
  const rootIcon = opts.fetchIcons ? extractIcon(rootMeta) : null;

  // Recursive walk — produces depth-first ordered pages array
  async function visit(pageId: string, parentId: string | null, depth: number, title: string, icon: CachedPage["icon"]): Promise<void> {
    const url = `https://www.notion.so/${pageId.replace(/-/g, "")}`;
    // Unbounded progress (total unknown during fetch — depth-first discovery).
    // Shows: elapsed time, pages so far, throughput, current title.
    process.stdout.write(`\r  ${unboundedStatus(pages.length, `[d${depth}] ${title}`, start)}`);

    const { blocks, apiCalls: ac } = await listChildren(pageId);
    apiCalls += ac; walkProgress!.apiCalls = apiCalls;
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
          const meta: any = await withRetry("icon", () => notion.pages.retrieve({ page_id: cp.id }), 3);
          apiCalls++; walkProgress!.apiCalls = apiCalls;
          childIcon = extractIcon(meta);
          await sleep(RATE_LIMIT_MS);
        } catch {
          // ignore icon fetch failures even after retries
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
  if ((cache as any).partial) {
    console.log(yellow(`⚠ PARTIAL CACHE  — ${(cache as any).partial_reason ?? "unknown reason"}. Re-run \`bash list.sh fetch\` for a complete tree.`));
  }
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
    try {
      const cache = await walk({ fetchIcons });
      saveCache(cache);
      console.log(green(`✓ Cached ${cache.pages.length} pages → ${path.relative(process.cwd(), CACHE_PATH)}`));
    } catch (err: any) {
      // walk() crashed even after withRetry exhausted attempts. Save what we
      // collected so the user doesn't lose minutes of fetching.
      savePartial(`fetch failed: ${err?.status ?? err?.code ?? "err"}`);
      console.error(red(`\n✗ Fetch aborted after exhausting retries: ${err?.message?.slice(0, 120)}`));
      console.error(dim(`  Run \`bash list.sh fetch\` again to retry from scratch (no resume yet — partial cache is for inspection only).`));
      process.exit(1);
    }
    if (cmd === "fetch") return;
  }

  const cache = loadCache();
  if (!cache) {
    console.error(red("no cache available — run `notion-list fetch` first"));
    process.exit(1);
  }

  if (cmd === "fix-mentions") {
    // Retroactive pass — convert internal hyperlinks to native page mentions
    // on every page already in the cache. Safe to re-run (idempotent).
    const ourPageIds = new Set(cache.pages.map((p) => p.id.replace(/-/g, "").toLowerCase()));
    console.log(bold(`\nFixing mentions on ${cache.pages.length} pages…`));
    let totalConverted = 0;
    let totalUpdated = 0;
    let pagesProcessed = 0;
    let pagesWithChanges = 0;
    const startTs = Date.now();
    for (const p of cache.pages) {
      pagesProcessed++;
      process.stdout.write(`\r  ${progressBar(pagesProcessed, cache.pages.length, p.title, startTs)}`);
      try {
        const r = await convertPageLinksToMentions({
          notion,
          pageId: p.id,
          ourPageIds,
          rateLimitMs: RATE_LIMIT_MS,
        });
        if (r.links_converted > 0) {
          totalConverted += r.links_converted;
          totalUpdated += r.blocks_updated;
          pagesWithChanges++;
          process.stdout.write(`\r${" ".repeat(120)}\r`);
          console.log(`  ${green("✓")} ${p.title}  ${dim(`(${r.links_converted} link${r.links_converted === 1 ? "" : "s"} → mention${r.links_converted === 1 ? "" : "s"})`)}`);
        }
      } catch (err: any) {
        process.stdout.write(`\r${" ".repeat(120)}\r`);
        console.error(`  ${red("✗")} ${p.title}: ${(err.message as string).slice(0, 80)}`);
      }
    }
    process.stdout.write(`\r${" ".repeat(120)}\r`);
    console.log(`\n${green("Done.")} Converted ${bold(String(totalConverted))} link${totalConverted === 1 ? "" : "s"} → mention${totalConverted === 1 ? "" : "s"} across ${pagesWithChanges} page${pagesWithChanges === 1 ? "" : "s"} (${totalUpdated} block update${totalUpdated === 1 ? "" : "s"}).`);
  } else if (cmd === "diff") {
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
