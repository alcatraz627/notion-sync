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

import { getNotion, extractPageId } from "./lib/notion";
import * as fs from "fs";
import * as path from "path";
import { convertPageLinksToMentions } from "./mention-converter";
import { generateSitemap } from "./sitemap";
import { titleVariants, buildVariantIndex, findMatches } from "./title-match";
import { dim, bold, grey, green, yellow, red, cyan } from "./lib/colors";
import { generateTagIndex } from "./tag-index";
import { generateIndexDb } from "./index-db";
import { generateBacklinks } from "./backlinks";
import { generateRecentFeed } from "./recent-feed";
import { generateHealth } from "./health";

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
// Cache file is keyed by NOTION_ROOT_PAGE_ID so swapping root targets
// (V2, sandbox) auto-isolates the cache. Legacy unkeyed file is auto-
// migrated on first read.
import { getCacheKey } from "./sync-state";
const LEGACY_CACHE_PATH = path.join(__dirname, ".notion-cache.json");
const cachePath = () => path.join(__dirname, `.notion-cache.${getCacheKey()}.json`);
function migrateLegacyCacheIfNeeded(): void {
  try {
    const cur = cachePath();
    if (fs.existsSync(LEGACY_CACHE_PATH) && !fs.existsSync(cur)) {
      fs.renameSync(LEGACY_CACHE_PATH, cur);
      console.error(`\x1b[2m  ℹ migrated legacy .notion-cache.json → ${path.basename(cur)} (root ${getCacheKey()})\x1b[0m`);
    }
  } catch (err: any) {
    console.error(`\x1b[33m  ⚠ legacy cache migration failed: ${err.message?.slice(0, 80)}\x1b[0m`);
  }
}

if (!NOTION_TOKEN || !RAW_ROOT) {
  console.error("notion-list: NOTION_TOKEN and NOTION_ROOT_PAGE_ID must be set in .env");
  process.exit(1);
}

const ROOT_ID = extractPageId(RAW_ROOT) ?? RAW_ROOT.replace(/-/g, "");

// timeoutMs: bumped from the SDK default (~60s) because chunked sitemap
// pushes get slower as the page accumulates blocks — section 5+ on a
// 300-page tree was reliably timing out at 60s.
const notion = getNotion({ timeoutMs: 300_000 });
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
// Color helpers live in lib/colors.ts (shared across the toolset).

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
  console.error(yellow(`\n⚠ Partial cache saved (${cache.pages.length} pages, ${reason}) → ${path.relative(process.cwd(), cachePath())}`));
}
process.on("SIGINT", () => { savePartial("SIGINT"); process.exit(130); });
process.on("uncaughtException", (e) => { savePartial(`uncaught: ${e?.message?.slice(0,60) ?? "err"}`); process.exit(1); });

async function walk(opts: { fetchIcons: boolean }): Promise<Cache> {
  const start = Date.now();
  const pages: CachedPage[] = [];
  let apiCalls = 0;
  walkProgress = { pages, apiCalls: 0, start, fetchIcons: opts.fetchIcons };

  // Milestone cadence — print a newline-anchored line every N pages so the
  // user sees activity accumulate, not just a single self-overwriting line.
  // Without milestones, large fetches on slow networks look frozen even when
  // they're making progress.
  const MILESTONE_EVERY = 25;
  let lastMilestone = 0;
  // Heartbeat — re-arm the live status line every few seconds even if no
  // new pages have arrived (e.g. stuck in a Notion 502 retry backoff). Some
  // terminals stop showing \r updates entirely if writes are too infrequent.
  const HEARTBEAT_MS = 5000;
  const heartbeat = setInterval(() => {
    if (pages.length > 0) {
      process.stdout.write(`\r  ${unboundedStatus(pages.length, `(heartbeat — still fetching)`, start)}`);
    }
  }, HEARTBEAT_MS);

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

    if (pages.length >= lastMilestone + MILESTONE_EVERY) {
      // Stamp a permanent milestone line, then re-arm the live cursor below.
      const elapsedMs = Date.now() - start;
      const rate = pages.length / Math.max(1, elapsedMs / 1000);
      process.stdout.write("\r" + " ".repeat(120) + "\r");
      console.log(`  ${dim(`[${fmtElapsedShort(elapsedMs)}]`)} ${green("✓")} ${pages.length} pages fetched  ${dim(`(${rate.toFixed(1)}/s, ${apiCalls} API calls)`)}`);
      lastMilestone = pages.length;
    }

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

  try {
    await visit(ROOT_ID, null, 0, rootTitle, rootIcon);
  } finally {
    clearInterval(heartbeat);
  }
  process.stdout.write("\r" + " ".repeat(120) + "\r");
  // Final summary line so the user has a permanent record after the
  // self-overwriting status line clears.
  const totalElapsed = Date.now() - start;
  const finalRate = pages.length / Math.max(1, totalElapsed / 1000);
  console.log(`  ${dim(`[${fmtElapsedShort(totalElapsed)}]`)} ${green("✓")} fetch complete  ${dim(`(${pages.length} pages, ${finalRate.toFixed(1)}/s, ${apiCalls} API calls)`)}`);

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

  // Variant-aware matching: a remote page is "covered" if any of its title
  // variants matches any local title variant (and vice versa). Catches
  // drift like "Forms" ↔ "UI Widgets — Forms", "Auth (Frontend)" ↔ "Auth",
  // hyphen-vs-space, etc. without hard-coding qualifier prefixes.
  const localVariantIndex  = buildVariantIndex(local.titles);
  const remotePages = cache.pages.filter((p) => p.parent_id !== null);
  const remoteTitlesArr = remotePages.map((p) => p.title);
  const remoteVariantIndex = buildVariantIndex(remoteTitlesArr);

  // Buckets: still-orphan + newly-rescued pairs.
  interface Pair { remoteTitle: string; remoteUrl: string; localTitle: string; localPath: string; ambiguous: number }
  const matchedPairs: Pair[] = [];
  const onlyRemote: typeof remotePages = [];
  const matchedRemoteTitles = new Set<string>();
  const matchedLocalTitles  = new Set<string>();

  // Rank a local hit when multiple match a single remote. Two-axis scoring:
  //   (1) variant overlap length — longer shared variant = more specific match
  //   (2) section-page affinity — if the Notion page has child pages (i.e. is
  //       a folder/section), strongly prefer local _index.md files
  // The combination disambiguates the common case where a generic Notion
  // section name like "Admin" could match many local leaf titles like
  // "Admin — Debug Tools" AND a folder `_index.md` titled "Product — Admin".
  // The _index bonus pushes the folder match to the top.
  const pickBestLocal = (remoteTitle: string, locals: Set<string>, remoteIsSection: boolean): string => {
    const remoteV = new Set(titleVariants(remoteTitle));
    let best: { local: string; score: number } | null = null;
    for (const lt of locals) {
      const lpath = local.pathByTitle.get(lt) ?? "";
      let score = 0;
      for (const v of titleVariants(lt)) {
        if (remoteV.has(v)) score = Math.max(score, v.length);
      }
      // _index.md is the section/folder representative — strongly prefer it
      // when the remote page itself is a section (has Notion-side children).
      if (remoteIsSection && lpath.endsWith("/_index.md")) score += 1000;
      // Symmetric mild bonus: when remote is NOT a section, prefer non-_index
      // locals so a folder _index doesn't grab a leaf-titled remote page.
      if (!remoteIsSection && !lpath.endsWith("/_index.md")) score += 50;
      // Tie-breaker for section matches: prefer SHORTER paths (higher in the
      // tree). When `Improvements` matches both `product/improvements/_index.md`
      // and `product/improvements/admin-panel/_index.md`, the former is the
      // parent and the right pick.
      if (remoteIsSection && lpath.endsWith("/_index.md")) {
        const depth = lpath.split("/").length;
        score -= depth; // shorter path wins
      }
      if (!best || score > best.score) best = { local: lt, score };
    }
    return best ? best.local : [...locals][0];
  };

  for (const p of remotePages) {
    const localHits = findMatches(p.title, localVariantIndex);
    if (localHits.size === 0) {
      onlyRemote.push(p);
      continue;
    }
    matchedRemoteTitles.add(p.title);
    const bestLocal = pickBestLocal(p.title, localHits, p.child_page_count > 0);
    matchedLocalTitles.add(bestLocal);
    matchedPairs.push({
      remoteTitle: p.title,
      remoteUrl: p.url,
      localTitle: bestLocal,
      localPath: local.pathByTitle.get(bestLocal) ?? "",
      ambiguous: localHits.size,
    });
  }

  const onlyLocal = [...local.titles].filter((t) => !matchedLocalTitles.has(t));
  const emptyRemote = cache.pages.filter((p) => p.parent_id !== null && p.block_count === 0);

  console.log(bold("\nDiff: remote vs local"));
  console.log(dim("─".repeat(72)));
  console.log(`${dim("Local docs:")}    ${local.titles.size}`);
  console.log(`${dim("Remote pages:")}  ${cache.pages.length - 1}  ${dim("(excluding root)")}`);
  console.log(`${dim("Matched:")}       ${matchedRemoteTitles.size} remote ↔ ${matchedLocalTitles.size} local  ${dim("(via title-variant pairing)")}`);
  console.log(dim("─".repeat(72)));

  console.log(`\n${bold(red(`✗ Remote-only (${onlyRemote.length})`))}  ${dim("— pages on Notion with no matching local title")}`);
  for (const p of onlyRemote.slice(0, 50)) {
    console.log(`    ${cyan(p.title)}  ${dim(p.url)}`);
  }
  if (onlyRemote.length > 50) console.log(dim(`    … +${onlyRemote.length - 50} more`));

  console.log(`\n${bold(yellow(`⚠ Empty remote pages (${emptyRemote.length})`))}  ${dim("— page exists but has 0 blocks")}`);
  for (const p of emptyRemote.slice(0, 50)) {
    const localHits = findMatches(p.title, localVariantIndex);
    const hint = localHits.size > 0 ? local.pathByTitle.get([...localHits][0]) : undefined;
    console.log(`    ${cyan(p.title)}  ${dim(p.url)}${hint ? `  ${dim("↳ " + hint)}` : ""}`);
  }
  if (emptyRemote.length > 50) console.log(dim(`    … +${emptyRemote.length - 50} more`));

  console.log(`\n${bold(green(`+ Local-only (${onlyLocal.length})`))}  ${dim("— local docs with no matching remote page title")}`);
  for (const t of onlyLocal.slice(0, 50)) {
    console.log(`    ${cyan(t)}  ${dim("↳ " + (local.pathByTitle.get(t) ?? ""))}`);
  }
  if (onlyLocal.length > 50) console.log(dim(`    … +${onlyLocal.length - 50} more`));

  // Rescued pairs. Split into "exact" (titles identical or trivially equal)
  // vs "renamed" (titles differ — the interesting case where the user might
  // want to verify the pairing). Show only renames in detail; collapse the
  // exact bucket to a count.
  const exactMatches = matchedPairs.filter(p => p.remoteTitle === p.localTitle);
  const renamedMatches = matchedPairs.filter(p => p.remoteTitle !== p.localTitle);
  const ambiguous = matchedPairs.filter(p => p.ambiguous > 1);

  if (renamedMatches.length > 0) {
    console.log(`\n${bold(cyan(`◆ Renamed pairs (${renamedMatches.length})`))}  ${dim("— matched via title-variant overlap (verify these)")}`);
    const shown = renamedMatches.slice(0, 80);
    for (const pair of shown) {
      const ambig = pair.ambiguous > 1 ? dim(`  [${pair.ambiguous} candidates]`) : "";
      console.log(`    ${cyan(pair.remoteTitle)} ${dim("→")} ${green(pair.localTitle)}${ambig}  ${dim("↳ " + pair.localPath)}`);
    }
    if (renamedMatches.length > 80) console.log(dim(`    … +${renamedMatches.length - 80} more`));
  }
  if (exactMatches.length > 0) {
    console.log(`\n${dim(`◆ Exact title matches: ${exactMatches.length}  (titles identical on both sides — no rename)`)}`);
  }
  if (ambiguous.length > 0) {
    console.log(`\n${dim(`⚠ ${ambiguous.length} remote pages had multiple plausible local pairings. The most-specific match was picked (longest shared variant). Run with --verbose for the alternatives.`)}`);
  }

  console.log("");
  console.log(dim("─".repeat(72)));
  console.log(`${dim("Match strategy:")} verbatim title + lenient-normalize + dash-tail + paren-strip.`);
  console.log(`${dim("Still brittle for:")} renamed-file-AND-renamed-H1 (no overlapping variant). Content-fingerprint pass would catch those.`);
  console.log("");
}

// ── Cache I/O ────────────────────────────────────────────────────────────────

function loadCache(): Cache | null {
  migrateLegacyCacheIfNeeded();
  if (!fs.existsSync(cachePath())) return null;
  try {
    return JSON.parse(fs.readFileSync(cachePath(), "utf8"));
  } catch (e: any) {
    console.error(red(`cache parse failed: ${e.message}`));
    return null;
  }
}
function saveCache(cache: Cache): void {
  fs.writeFileSync(cachePath(), JSON.stringify(cache, null, 2));
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

  if (cmd === "diff-content") {
    // Three-way diff report: BASE (snapshot) vs LOCAL (file on disk) vs
    // REMOTE (Notion right now, normalized via the pull pipeline). Read-only.
    // Default scope = protected_pages from the latest live run; pass --all
    // to walk every baselined page, or --paths a,b for a custom subset.
    // Delegates to diff-content.ts so the heavy HTML/server logic stays in
    // one place and this dispatcher stays a thin router.
    const passThrough = process.argv.slice(3);
    const proc = Bun.spawn(["bun", path.join(__dirname, "diff-content.ts"), ...passThrough], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    const code = await proc.exited;
    process.exit(code);
  }

  if (cmd === "recent-errors") {
    // Surface failed paths from recent runs.jsonl entries. No Notion fetch
    // required — purely local-log inspection. Default: scan last 5 runs,
    // print any with errors > 0 (or partial: true), give a copy-paste retry.
    const limitArg = args[args.indexOf("--limit") + 1];
    const limit = args.includes("--limit") ? parseInt(limitArg, 10) : 5;
    const logPath = path.join(process.cwd(), "runs.jsonl");
    if (!fs.existsSync(logPath)) {
      console.error(red(`runs.jsonl not found at ${logPath}`));
      process.exit(1);
    }
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
    const recent = lines.slice(-limit);
    let anyErrors = false;
    for (const line of recent) {
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      const errCount = entry.stats?.errors ?? 0;
      const isPartial = entry.partial === true;
      if (errCount === 0 && !isPartial) {
        console.log(`${dim(entry.run_id)}  ${green("✓")} ${entry.stats?.total ?? 0} files, no errors${isPartial ? " (partial)" : ""}`);
        continue;
      }
      anyErrors = true;
      const tag = isPartial ? red("partial") : red(`${errCount} error${errCount === 1 ? "" : "s"}`);
      const reason = entry.partial_reason ? dim(` [${entry.partial_reason}]`) : "";
      console.log(`\n${bold(entry.run_id)}  ${tag}${reason}  ${dim(entry.ts)}`);
      const errs = entry.error_summary ?? [];
      for (const e of errs.slice(0, 10)) {
        const susp = e.suspicions?.length ? dim(` [${e.suspicions.join(", ")}]`) : "";
        console.log(`  ${red("✗")} ${e.path}${susp}`);
        if (e.error) console.log(`     ${dim(e.error.slice(0, 120))}`);
      }
      if (errs.length > 10) console.log(dim(`  … +${errs.length - 10} more`));
      if (errs.length > 0) {
        const retryArgs = errs.map((e: any) => path.basename(e.path, ".md")).join(" ");
        console.log(`\n  ${dim("Retry:")} bash sync.sh --only ${retryArgs}`);
      }
    }
    if (!anyErrors) console.log(dim(`\n(no errors in last ${recent.length} run${recent.length === 1 ? "" : "s"})`));
    return;
  }

  if (cmd === "fetch" || (cmd === "auto" && !loadCache())) {
    console.log(bold(`\nFetching Notion tree from root ${ROOT_ID}…`));
    if (!fetchIcons) console.log(dim("  (--no-icons: skipping per-page metadata fetch)"));
    try {
      const cache = await walk({ fetchIcons });
      saveCache(cache);
      console.log(green(`✓ Cached ${cache.pages.length} pages → ${path.relative(process.cwd(), cachePath())}`));
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
    let totalApiCalls = 0;
    const startTs = Date.now();
    // Per-page slowness inspection: track the slowest page seen so we can
    // surface it at the end (useful for diagnosing "why so slow?" questions).
    let slowest: { title: string; ms: number; apiCalls: number } | null = null;
    for (const p of cache.pages) {
      pagesProcessed++;
      // liveProgress is mutated inside convertPageLinksToMentions after every
      // API call — the heartbeat below polls it to keep the progress line
      // moving even when one slow page would otherwise freeze the bar.
      const live = { blocks_inspected: 0, blocks_updated: 0, links_converted: 0, api_calls: 0 };
      const pageStart = Date.now();
      const repaint = () => {
        const pageElapsed = Math.floor((Date.now() - pageStart) / 1000);
        const live_str = dim(`  · ${live.blocks_inspected}b / ${live.api_calls}api / ${pageElapsed}s`);
        process.stdout.write(`\r  ${progressBar(pagesProcessed, cache.pages.length, p.title + live_str, startTs)}`);
      };
      repaint();
      // Repaint every 1s — catches the case where convertPageLinksToMentions
      // is stuck on a deeply-nested page making sequential rate-limited API
      // calls. Without the heartbeat the line shows the same N/total + page
      // title for minutes; with it, the user sees blocks/api counters tick.
      const heartbeat = setInterval(repaint, 1000);
      try {
        const r = await convertPageLinksToMentions({
          notion,
          pageId: p.id,
          ourPageIds,
          rateLimitMs: RATE_LIMIT_MS,
          liveProgress: live,
        });
        clearInterval(heartbeat);
        const pageMs = Date.now() - pageStart;
        totalApiCalls += live.api_calls;
        if (!slowest || pageMs > slowest.ms) slowest = { title: p.title, ms: pageMs, apiCalls: live.api_calls };
        if (r.links_converted > 0) {
          totalConverted += r.links_converted;
          totalUpdated += r.blocks_updated;
          pagesWithChanges++;
          process.stdout.write(`\r${" ".repeat(160)}\r`);
          console.log(`  ${green("✓")} ${p.title}  ${dim(`(${r.links_converted} link${r.links_converted === 1 ? "" : "s"} → mention${r.links_converted === 1 ? "" : "s"} · ${live.api_calls} API calls · ${Math.round(pageMs / 1000)}s)`)}`);
        }
      } catch (err: any) {
        clearInterval(heartbeat);
        process.stdout.write(`\r${" ".repeat(160)}\r`);
        console.error(`  ${red("✗")} ${p.title}: ${(err.message as string).slice(0, 80)}`);
      }
    }
    process.stdout.write(`\r${" ".repeat(160)}\r`);
    console.log(`\n${green("Done.")} Converted ${bold(String(totalConverted))} link${totalConverted === 1 ? "" : "s"} → mention${totalConverted === 1 ? "" : "s"} across ${pagesWithChanges} page${pagesWithChanges === 1 ? "" : "s"} (${totalUpdated} block update${totalUpdated === 1 ? "" : "s"}, ${totalApiCalls} total API calls).`);
    if (slowest) {
      console.log(dim(`  Slowest page: ${slowest.title}  (${Math.round(slowest.ms / 1000)}s, ${slowest.apiCalls} API calls)`));
    }
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
  } else if (cmd === "prune") {
    // v1.2 rename-safety: list (or archive) Notion pages that have no
    // matching local doc by title. Without --apply, dry-run only —
    // prints what WOULD be archived. With --apply, archives each one
    // via pages.update({archived: true}). Pages remain in Notion's
    // trash for ~30 days and can be restored manually.
    const apply = args.includes("--apply");
    const local = scanLocalDocs();
    // Orphans: pages whose title has no matching local doc H1 AND
    // which have no child pages of their own. The latter excludes
    // section pages (titled by folder name, not H1) — those would
    // false-positive otherwise. Real leaf orphans are pages with
    // 0 children that no longer correspond to a local file.
    //
    // Matching is variant-aware (mirrors runDiff) so an H1 like
    // "UI Widgets — Forms" still matches the Notion page "Forms" and
    // doesn't get reported as orphan + archived by --apply.
    const localVariantIndex = buildVariantIndex(local.titles);
    const orphans = cache.pages.filter(
      (p) => p.parent_id !== null
        && p.child_page_count === 0
        && findMatches(p.title, localVariantIndex).size === 0,
    );
    if (orphans.length === 0) {
      console.log(dim("No orphaned pages found — every Notion page has a matching local doc title."));
      return;
    }
    console.log(`${bold(red(`Found ${orphans.length} orphaned page${orphans.length === 1 ? "" : "s"}`))} ${dim("— in Notion, no matching local doc title")}\n`);
    for (const p of orphans) {
      console.log(`  ${cyan(p.title)}  ${dim(p.url)}`);
    }
    if (!apply) {
      console.log(`\n${dim("Dry-run only. To archive these pages:")}  ${bold("bash list.sh prune --apply")}`);
      console.log(dim("  Pages will move to Notion's Trash; restore from there if needed."));
      return;
    }
    console.log(`\n${yellow("Archiving…")}  (${RATE_LIMIT_MS}ms between calls)`);
    let archived = 0;
    let failed = 0;
    for (const p of orphans) {
      try {
        await notion.pages.update({ page_id: p.id, archived: true } as any);
        archived++;
        console.log(`  ${green("✓")} ${p.title}`);
      } catch (err: any) {
        failed++;
        console.error(`  ${red("✗")} ${p.title} — ${(err.message as string).slice(0, 80)}`);
      }
      await sleep(RATE_LIMIT_MS);
    }
    console.log(`\n${green("Done.")} ${archived} archived${failed > 0 ? `, ${red(String(failed))} failed` : ""}.`);
  } else if (cmd === "dashboards") {
    // Consolidated dashboard sweep — runs all 6 generators in ONE process,
    // reusing the already-loaded cache + notion client. Replaces run.sh's
    // `dashboard` mode (6× `bash list.sh <cmd>` = 6 bun cold-starts + 6 cache
    // parses) with a single in-memory pass. Each phase is isolated so one
    // failure doesn't strand the rest (mirrors the old `|| failed+=()`).
    //
    // Progress: a `[N/6] <name>` prefix on a self-overwriting line, fed by
    // each generator's `log` callback, plus a per-phase ✓/✗ summary line and
    // a final roll-up.
    const docsDir = process.env.DOCS_DIR;
    const runsPath = path.join(__dirname, "runs.jsonl");
    const limitArg = args[args.indexOf("--limit") + 1];
    const feedLimit = args.includes("--limit") ? parseInt(limitArg, 10) : 50;

    interface DashPhase { name: string; run: (log: (m: string) => void) => Promise<string> }
    const requireDocs = (): string => {
      if (!docsDir) throw new Error("DOCS_DIR env var not set");
      return docsDir;
    };
    const phases: DashPhase[] = [
      { name: "Sitemap", run: async (log) => {
        const r = await generateSitemap({ notion, cache, sitemapPageId: process.env.NOTION_SITEMAP_PAGE_ID || undefined, rateLimitMs: RATE_LIMIT_MS, log });
        return `${r.total_pages} pages · ${r.total_blocks} blocks`;
      }},
      { name: "Tag index", run: async (log) => {
        const r = await generateTagIndex({ notion, cache, docsDir: requireDocs(), tagIndexPageId: process.env.NOTION_TAG_INDEX_PAGE_ID || undefined, rateLimitMs: RATE_LIMIT_MS, log });
        return `${r.total_tags} tags · ${r.total_docs_with_tags} docs`;
      }},
      { name: "Index DB", run: async (log) => {
        const r = await generateIndexDb({ notion, cache, docsDir: requireDocs(), databaseId: process.env.NOTION_INDEX_DB_ID || undefined, rateLimitMs: RATE_LIMIT_MS, log });
        return `${r.total_docs} docs · +${r.rows_created}/~${r.rows_updated}`;
      }},
      { name: "Backlinks", run: async (log) => {
        const r = await generateBacklinks({ notion, cache, docsDir: requireDocs(), rateLimitMs: RATE_LIMIT_MS, log });
        return `${r.pages_with_backlinks} pages · ${r.callouts_added}+${r.callouts_replaced} callouts`;
      }},
      { name: "Recent feed", run: async (log) => {
        const r = await generateRecentFeed({ notion, cache, runsPath, limit: feedLimit, recentFeedPageId: process.env.NOTION_RECENT_FEED_PAGE_ID || undefined, rateLimitMs: RATE_LIMIT_MS, log });
        return `${r.total_entries_emitted} entries`;
      }},
      { name: "Sync Status", run: async (log) => {
        const r = await generateHealth({ notion, cache, runsPath, healthPageId: process.env.NOTION_HEALTH_PAGE_ID || undefined, rateLimitMs: RATE_LIMIT_MS, log });
        return `${r.blocks_pushed} blocks${r.ran_against ? ` · run ${r.ran_against}` : ""}`;
      }},
    ];

    console.log(bold(`\nRunning ${phases.length} dashboards in one process…`));
    const failed: string[] = [];
    const startAll = Date.now();
    let idx = 0;
    for (const ph of phases) {
      idx++;
      const prefix = dim(`[${idx}/${phases.length}]`);
      // Live line: each generator's log() overwrites the current status line.
      const phaseLog = (msg: string) => {
        const clean = msg.replace(/\n/g, " ").trim().slice(0, 70);
        process.stdout.write(`\r${" ".repeat(120)}\r  ${prefix} ${bold(ph.name)}  ${dim(clean)}`);
      };
      process.stdout.write(`\r  ${prefix} ${bold(ph.name)}  ${dim("starting…")}`);
      const t0 = Date.now();
      try {
        const summary = await ph.run(phaseLog);
        const secs = Math.round((Date.now() - t0) / 1000);
        process.stdout.write(`\r${" ".repeat(120)}\r`);
        console.log(`  ${green("✓")} ${prefix} ${bold(ph.name)}  ${dim(`${summary} · ${secs}s`)}`);
      } catch (err: any) {
        process.stdout.write(`\r${" ".repeat(120)}\r`);
        console.log(`  ${red("✗")} ${prefix} ${bold(ph.name)}  ${red((err.message ?? "failed").slice(0, 80))}`);
        failed.push(ph.name);
      }
    }
    const totalSecs = Math.round((Date.now() - startAll) / 1000);
    console.log("");
    if (failed.length === 0) {
      console.log(`${green("✓ All dashboards complete")}  ${dim(`(${totalSecs}s total)`)}`);
    } else {
      console.log(`${yellow(`⚠ ${failed.length}/${phases.length} dashboards failed:`)} ${failed.join(", ")}  ${dim(`(${totalSecs}s total)`)}`);
      process.exitCode = 1;
    }
  } else if (cmd === "health") {
    // Render the latest run's stats + recent run strip + last errors
    // to a 🩺 Sync Status page. No DOCS_DIR needed; cache provides
    // existence filter only for the find/create path.
    const healthPageId = process.env.NOTION_HEALTH_PAGE_ID || undefined;
    const runsPath = path.join(__dirname, "runs.jsonl");
    try {
      const result = await generateHealth({
        notion, cache, runsPath, healthPageId,
        rateLimitMs: RATE_LIMIT_MS,
        log: (msg) => console.log(msg),
      });
      console.log(
        `\n${green("Done.")} Sync Status ${result.page_was_created ? "created" : "updated"} — ${bold(String(result.blocks_pushed))} blocks${result.ran_against ? ` (latest run: ${result.ran_against})` : ""}.`,
      );
      console.log(dim(`  Page: https://www.notion.so/${result.health_page_id.replace(/-/g, "")}`));
    } catch (err: any) {
      console.error(red(`\n✗ Health generation failed: ${err.message}`));
      process.exit(1);
    }
  } else if (cmd === "recent-feed") {
    // Render the 📣 Recently Synced page from runs.jsonl. No DOCS_DIR
    // needed; cache provides the page-existence filter.
    const limitArg = args[args.indexOf("--limit") + 1];
    const limit = args.includes("--limit") ? parseInt(limitArg, 10) : 50;
    const recentFeedPageId = process.env.NOTION_RECENT_FEED_PAGE_ID || undefined;
    const runsPath = path.join(__dirname, "runs.jsonl");
    try {
      const result = await generateRecentFeed({
        notion, cache, runsPath, limit, recentFeedPageId,
        rateLimitMs: RATE_LIMIT_MS,
        log: (msg) => console.log(msg),
      });
      if (result.total_entries_emitted === 0) {
        console.log(dim(`\n(no entries to render — runs.jsonl is empty or has no successful syncs)`));
      } else {
        console.log(
          `\n${green("Done.")} Recent feed ${result.page_was_created ? "created" : "updated"} — ${bold(String(result.total_entries_emitted))} unique pages, ${result.blocks_wiped} wiped, ${result.batches_pushed} batch${result.batches_pushed === 1 ? "" : "es"} pushed.`,
        );
        console.log(dim(`  Page: https://www.notion.so/${result.recent_feed_page_id.replace(/-/g, "")}`));
      }
    } catch (err: any) {
      console.error(red(`\n✗ Recent feed generation failed: ${err.message}`));
      process.exit(1);
    }
  } else if (cmd === "backlinks") {
    // Walk DOCS_DIR for the link graph, append a "🔗 Linked from"
    // callout to each Notion page that has inbound links from other
    // docs. Idempotent — replaces existing callouts on re-run.
    const docsDir = process.env.DOCS_DIR;
    if (!docsDir) {
      console.error(red("DOCS_DIR env var not set — required for backlinks"));
      process.exit(1);
    }
    try {
      const result = await generateBacklinks({
        notion, cache, docsDir, rateLimitMs: RATE_LIMIT_MS,
        log: (msg) => console.log(msg),
      });
      console.log(
        `\n${green("Done.")} Backlinks — ${bold(String(result.pages_with_backlinks))} pages with inbound links · ${result.callouts_added} added · ${result.callouts_replaced} replaced${result.pages_unmatched > 0 ? ` · ${result.pages_unmatched} unmatched` : ""}.`,
      );
      console.log(dim(`  Scanned ${result.total_docs_scanned} docs, found ${result.total_links_found} internal links`));
    } catch (err: any) {
      console.error(red(`\n✗ Backlinks generation failed: ${err.message}`));
      process.exit(1);
    }
  } else if (cmd === "index-db") {
    // Push/refresh the 📇 Doc Index sidecar database. Walks DOCS_DIR
    // for every leaf doc, upserts one row per doc keyed by Path. Source
    // page mention populated by title match against the cache.
    const docsDir = process.env.DOCS_DIR;
    if (!docsDir) {
      console.error(red("DOCS_DIR env var not set — required for index-db"));
      process.exit(1);
    }
    const databaseId = process.env.NOTION_INDEX_DB_ID || undefined;
    try {
      const result = await generateIndexDb({
        notion, cache, docsDir, databaseId, rateLimitMs: RATE_LIMIT_MS,
        log: (msg) => console.log(msg),
      });
      console.log(
        `\n${green("Done.")} Index DB ${result.database_was_created ? "created" : "updated"} — ${bold(String(result.total_docs))} docs · ${result.rows_created} created · ${result.rows_updated} updated · ${result.rows_orphaned} orphaned${result.unmatched_to_page > 0 ? ` · ${result.unmatched_to_page} unmatched` : ""}.`,
      );
      console.log(dim(`  Database: https://www.notion.so/${result.database_id.replace(/-/g, "")}`));
    } catch (err: any) {
      console.error(red(`\n✗ Index DB generation failed: ${err.message}`));
      process.exit(1);
    }
  } else if (cmd === "tag-index") {
    // Walk DOCS_DIR for frontmatter / body tags, aggregate by tag, push
    // a 🏷️ Tags page. Auto-creates if missing; honours
    // NOTION_TAG_INDEX_PAGE_ID. Requires DOCS_DIR env var.
    const docsDir = process.env.DOCS_DIR;
    if (!docsDir) {
      console.error(red("DOCS_DIR env var not set — required for tag-index"));
      process.exit(1);
    }
    const tagIndexPageId = process.env.NOTION_TAG_INDEX_PAGE_ID || undefined;
    try {
      const result = await generateTagIndex({
        notion, cache, docsDir, tagIndexPageId, rateLimitMs: RATE_LIMIT_MS,
        log: (msg) => console.log(msg),
      });
      if (result.total_tags === 0) {
        console.log(dim(`\n(no tags found — nothing rendered)`));
      } else {
        console.log(
          `\n${green("Done.")} Tag index ${result.page_was_created ? "created" : "updated"} — ${bold(String(result.total_tags))} tags across ${result.total_docs_with_tags} docs (${result.matched_docs} matched to Notion pages, ${result.unmatched_docs} unmatched), ${result.mentions_converted} mention${result.mentions_converted === 1 ? "" : "s"}.`,
        );
        console.log(dim(`  Page: https://www.notion.so/${result.tag_index_page_id.replace(/-/g, "")}`));
      }
    } catch (err: any) {
      console.error(red(`\n✗ Tag index generation failed: ${err.message}`));
      process.exit(1);
    }
  } else if (cmd === "sitemap") {
    // Push a single 🗺️ Sitemap page summarizing the entire cached tree.
    // Auto-creates if missing; honours NOTION_SITEMAP_PAGE_ID if set.
    const sitemapPageId = process.env.NOTION_SITEMAP_PAGE_ID || undefined;
    try {
      const result = await generateSitemap({
        notion,
        cache,
        sitemapPageId,
        rateLimitMs: RATE_LIMIT_MS,
        log: (msg: string) => console.log(msg),
      });
      console.log(
        `\n${green("Done.")} Sitemap ${result.page_was_created ? "created" : "updated"} — ${bold(String(result.total_pages))} pages, ${result.total_blocks} blocks in ${result.batches_pushed} batch${result.batches_pushed === 1 ? "" : "es"}.`,
      );
      console.log(dim(`  Page: https://www.notion.so/${result.sitemap_page_id.replace(/-/g, "")}`));
    } catch (err: any) {
      console.error(red(`\n✗ Sitemap generation failed: ${err.message}`));
      process.exit(1);
    }
  } else {
    renderTree(cache, { maxDepth, emptyOnly });
  }
})();
