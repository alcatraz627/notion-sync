#!/usr/bin/env bun
/**
 * Notion docs sync — pushes a markdown docs folder to Notion maintaining folder structure.
 * Standalone tool — not part of any app. Run with: bun index.ts
 * Uses Notion's native markdown API (PATCH /pages/:id/markdown) for faithful rendering.
 *
 * Required env vars:
 *   NOTION_TOKEN        — Notion integration secret (secret_... or ntn_...)
 *   NOTION_ROOT_PAGE_ID — ID or URL slug of root Notion page
 *
 * Optional env vars:
 *   DOCS_DIR            — path to docs folder to sync (defaults to ./docs relative to CWD)
 *   GITHUB_REPO         — e.g. "versable-git/enhancement-product" (link rewriting fallback)
 *   GITHUB_BRANCH       — e.g. "development" (defaults to "development")
 *   GITHUB_DOCS_PATH    — docs path within the GitHub repo (default: "frontend/docs/product")
 *   NOTION_LINK_MODE    — "notion" (default) | "github" | "strip"
 *   NOTION_PAGE_ICON    — default emoji for all new pages (e.g. "📄")
 *   DRY_RUN             — set to "1" to preview without writing to Notion
 *
 * CLI args:
 *   --only <path> [path ...]  — sync only matching files/folders
 *
 * Frontmatter fields (per .md file, all optional):
 *   icon:   📋               — emoji or https:// URL applied as page icon
 *   cover:  https://...      — external image URL applied as page cover
 *
 * Example frontmatter:
 *   ---
 *   icon: 📋
 *   cover: https://images.unsplash.com/photo-xxx?w=1200
 *   ---
 *   # My Page Title
 */

import { Client } from "@notionhq/client";
import { createInterface } from "readline/promises";
import * as fs from "fs";
import * as path from "path";

// ── Types ─────────────────────────────────────────────────────────────────────

type SyncStatus = "created" | "updated" | "dry_run" | "error";
type LinkMode = "notion" | "github" | "strip";
type NotionIcon =
  | { type: "emoji"; emoji: string }
  | { type: "external"; external: { url: string } };
type NotionCover = { type: "external"; external: { url: string } };

interface PageInfo {
  id: string;
  title: string;
}
interface PageDiscovery {
  id: string;
  isNew: boolean;
}
interface ParsedDoc {
  title: string;
  body: string;
  meta: Record<string, string>;
  images: string[];
  icon: NotionIcon | undefined;
  cover: NotionCover | undefined;
}
interface SyncResult {
  path: string;
  title: string;
  status: SyncStatus;
  page_id?: string;
  notion_url?: string;
  elapsed_ms?: number;
  word_count?: number;
  error?: string;
}
interface RunLogEntry {
  ts: string;
  dry_run: boolean;
  filter: string[] | null;
  root_page_id: string;
  root_notion_url: string;
  github_base: string | null;
  link_mode: LinkMode;
  stats: {
    total: number;
    created: number;
    updated: number;
    dry_run: number;
    errors: number;
  };
  pages: SyncResult[];
  error_summary: { path: string; error: string }[] | null;
}

// ── ANSI colors ───────────────────────────────────────────────────────────────

const IS_TTY = process.stdout.isTTY === true;

const A = {
  r: "\x1b[0m",
  b: "\x1b[1m",
  d: "\x1b[2m",
  R: "\x1b[31m",
  G: "\x1b[32m",
  Y: "\x1b[33m",
  B: "\x1b[34m",
  M: "\x1b[35m",
  C: "\x1b[36m",
  W: "\x1b[90m",
} as const;

function paint(code: string, s: string): string {
  return IS_TTY ? `${code}${s}${A.r}` : s;
}

const clr = {
  header: (s: string) => paint(`${A.b}${A.C}`, s),
  phase: (s: string) => paint(`${A.b}${A.B}`, s),
  section: (s: string) => paint(`${A.b}${A.M}`, s),
  ok: (s: string) => paint(A.G, s),
  warn: (s: string) => paint(A.Y, s),
  err: (s: string) => paint(A.R, s),
  url: (s: string) => paint(A.C, s),
  dim: (s: string) => paint(A.d, s),
  bold: (s: string) => paint(A.b, s),
  gray: (s: string) => paint(A.W, s),
};

const sym = {
  ok: "✓",
  err: "✗",
  dot: "•",
  arr: "→",
  dry: "○",
  warn: "⚠",
  img: "📷",
  icon: "🎨",
  cover: "🖼",
  new: "✦",
  upd: "↺",
};

const HR = clr.dim("─".repeat(65));

// ── Config ────────────────────────────────────────────────────────────────────

const NOTION_TOKEN = process.env.NOTION_TOKEN ?? "";
const ROOT_PAGE_ID = process.env.NOTION_ROOT_PAGE_ID ?? "";
const DRY_RUN = process.env.DRY_RUN === "1";
const LINK_MODE: LinkMode = (process.env.NOTION_LINK_MODE ??
  "notion") as LinkMode;
const DEFAULT_ICON = process.env.NOTION_PAGE_ICON ?? null;

const DOCS_DIR = process.env.DOCS_DIR
  ? path.resolve(process.env.DOCS_DIR)
  : path.resolve(process.cwd(), "docs");
const GITHUB_REPO = process.env.GITHUB_REPO ?? null;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH ?? "development";
const GITHUB_DOCS_PATH =
  process.env.GITHUB_DOCS_PATH ?? "frontend/docs/product";
const GITHUB_BASE = GITHUB_REPO
  ? `https://github.com/${GITHUB_REPO}/blob/${GITHUB_BRANCH}/${GITHUB_DOCS_PATH}`
  : null;

const LOG_FILE = path.join(__dirname, "runs.jsonl");
const EXCLUDE_PATTERNS = [/^_/, /\.claude\.md$/];

// ── CLI args ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const onlyPaths: string[] = [];
let collectingOnly = false;
for (const arg of argv) {
  if (arg === "--only") {
    collectingOnly = true;
    continue;
  }
  if (arg.startsWith("--")) {
    collectingOnly = false;
    continue;
  }
  if (collectingOnly) onlyPaths.push(arg.replace(/\/$/, ""));
}

function shouldSync(relPath: string): boolean {
  if (onlyPaths.length === 0) return true;
  const base = path.basename(relPath, ".md");
  const basename = path.basename(relPath);
  return onlyPaths.some(
    (f) =>
      relPath === f ||
      relPath.startsWith(f + "/") ||
      basename === f ||
      base === f,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function apiCall<T>(fn: () => Promise<T>): Promise<T> {
  const result = await fn();
  await sleep(350);
  return result;
}

function shouldExclude(filename: string): boolean {
  return EXCLUDE_PATTERNS.some((p) => p.test(path.basename(filename)));
}

function safeReadFile(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, "utf-8");
  } catch {
    return null;
  }
}

async function askConfirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true; // non-interactive (CI): auto-confirm
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(prompt);
  rl.close();
  return answer.trim() === "" || /^y(es)?$/i.test(answer.trim());
}

// ── Frontmatter & doc parsing ─────────────────────────────────────────────────

function parseFrontmatter(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: content.slice(match[0].length) };
}

function extractTitle(body: string, relPath: string): string {
  const h1 = body.match(/^#\s+(.+)$/m);
  return h1 ? h1[1].trim() : path.basename(relPath, ".md");
}

function extractImages(body: string): string[] {
  const imgs: string[] = [];
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) imgs.push(m[1].trim());
  return imgs;
}

function resolveIcon(meta: Record<string, string>): NotionIcon | undefined {
  const raw = meta["icon"] ?? DEFAULT_ICON;
  if (!raw) return undefined;
  if (raw.startsWith("http://") || raw.startsWith("https://"))
    return { type: "external", external: { url: raw } };
  return { type: "emoji", emoji: raw };
}

function resolveCover(meta: Record<string, string>): NotionCover | undefined {
  const url = meta["cover"];
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://")))
    return undefined;
  return { type: "external", external: { url } };
}

// doc cache — populated during pre-run listing, reused in phases 1 & 2
const docCache = new Map<string, ParsedDoc>();

function getDoc(relPath: string): ParsedDoc | null {
  if (docCache.has(relPath)) return docCache.get(relPath)!;
  const raw = safeReadFile(path.join(DOCS_DIR, relPath));
  if (!raw) return null;
  const { meta, body } = parseFrontmatter(raw);
  const doc: ParsedDoc = {
    title: extractTitle(body, relPath),
    body,
    meta,
    images: extractImages(body),
    icon: resolveIcon(meta),
    cover: resolveCover(meta),
  };
  docCache.set(relPath, doc);
  return doc;
}

// ── Link rewriting ────────────────────────────────────────────────────────────

function notionUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

/**
 * Rewrites markdown links for Notion:
 * 1. Strips angle brackets from autolinks: (<https://...>) → (https://...)
 * 2. For relative .md links, resolution order depends on LINK_MODE:
 *    - "notion": Notion URL (via pageIdMap) → GitHub fallback → strip
 *    - "github": GitHub URL → strip
 *    - "strip":  always strip to plain text
 * 3. Fragment-only links (#anchor) and absolute URLs pass through unchanged
 */
function rewriteLinks(
  content: string,
  relPath: string,
  pageIdMap: Map<string, string>,
): string {
  const dir = path.dirname(relPath);
  return content.replace(
    /\[([^\]]*)\]\(([^)]*)\)/g,
    (_m, text: string, rawUrl: string) => {
      let url = rawUrl.trim();
      if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);
      if (
        url.startsWith("http://") ||
        url.startsWith("https://") ||
        url.startsWith("mailto:")
      )
        return `[${text}](${url})`;
      if (url.startsWith("#")) return `[${text}](${url})`;
      const [urlPath, anchor] = url.split("#");
      if (urlPath.endsWith(".md") || urlPath.endsWith("/") || urlPath === "") {
        const resolved = path
          .normalize(path.join(dir, urlPath || "."))
          .replace(/\\/g, "/");
        if (resolved.startsWith("..")) return text;
        if (LINK_MODE === "notion") {
          const pid =
            pageIdMap.get(resolved) ??
            pageIdMap.get(resolved.replace(/\.md$/, "")) ??
            pageIdMap.get(resolved + ".md");
          if (pid)
            return `[${text}](${notionUrl(pid)}${anchor ? "#" + anchor : ""})`;
        }
        if (LINK_MODE !== "strip" && GITHUB_BASE)
          return `[${text}](${GITHUB_BASE}/${resolved}${anchor ? "#" + anchor : ""})`;
        return text;
      }
      return text;
    },
  );
}

// ── Notion API ────────────────────────────────────────────────────────────────

const notion = new Client({ auth: NOTION_TOKEN });
const childPageCache = new Map<string, PageInfo[]>();

async function listChildPages(parentId: string): Promise<PageInfo[]> {
  if (childPageCache.has(parentId)) return childPageCache.get(parentId)!;
  const pages: PageInfo[] = [];
  let cursor: string | undefined;
  do {
    const res = await apiCall(() =>
      notion.blocks.children.list({
        block_id: parentId,
        start_cursor: cursor,
        page_size: 100,
      }),
    );
    for (const block of res.results) {
      if ("type" in block && block.type === "child_page")
        pages.push({
          id: block.id,
          title: (block as any).child_page.title as string,
        });
    }
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);
  childPageCache.set(parentId, pages);
  return pages;
}

async function getOrCreateChildPage(
  parentId: string,
  title: string,
  icon?: NotionIcon,
): Promise<{ id: string; isNew: boolean }> {
  if (DRY_RUN) return { id: `dry-run-${Date.now()}`, isNew: false };
  const children = await listChildPages(parentId);
  const existing = children.find((p) => p.title === title);
  if (existing) return { id: existing.id, isNew: false };
  const page = await apiCall(() =>
    notion.pages.create({
      parent: { page_id: parentId },
      properties: { title: { title: [{ text: { content: title } }] } },
      ...(icon ? { icon: icon as any } : {}),
    }),
  );
  children.push({ id: page.id, title });
  return { id: page.id, isNew: true };
}

// applies icon + cover to an existing or newly created page
async function updatePageMeta(
  pageId: string,
  icon: NotionIcon | undefined,
  cover: NotionCover | undefined,
): Promise<void> {
  if (!icon && !cover) return;
  await apiCall(() =>
    notion.pages.update({
      page_id: pageId,
      ...(icon ? { icon: icon as any } : {}),
      ...(cover ? { cover: cover as any } : {}),
    }),
  );
}

// ── Preflight ─────────────────────────────────────────────────────────────────

async function preflight(): Promise<string> {
  const problems: string[] = [];
  if (!NOTION_TOKEN) {
    problems.push("NOTION_TOKEN env var is not set");
  } else if (!/^(secret_|ntn_)/.test(NOTION_TOKEN)) {
    problems.push(
      `NOTION_TOKEN looks malformed (got: ${NOTION_TOKEN.slice(0, 8)}...)`,
    );
  }

  let resolvedPageId = ROOT_PAGE_ID;
  if (!ROOT_PAGE_ID) {
    problems.push("NOTION_ROOT_PAGE_ID env var is not set");
  } else {
    const hexMatch = ROOT_PAGE_ID.match(/([0-9a-f]{32})$/i);
    if (hexMatch) {
      resolvedPageId = hexMatch[1];
      if (ROOT_PAGE_ID !== resolvedPageId)
        console.log(
          clr.dim(
            `  Note: extracted page ID "${resolvedPageId}" from "${ROOT_PAGE_ID}"`,
          ),
        );
    } else if (!/^[0-9a-f-]{32,36}$/i.test(ROOT_PAGE_ID)) {
      problems.push(
        `NOTION_ROOT_PAGE_ID looks malformed — expected 32 hex chars, got: "${ROOT_PAGE_ID}"`,
      );
    }
  }

  if (!fs.existsSync(DOCS_DIR))
    problems.push(`DOCS_DIR does not exist: ${DOCS_DIR}`);

  if (problems.length > 0) {
    console.error(clr.err(`\n${sym.err} Config problems (aborting):`));
    for (const p of problems) console.error(clr.err(`  ${sym.dot} ${p}`));
    process.exit(1);
  }

  console.log(clr.dim("Preflight: verifying Notion connectivity..."));
  try {
    await notion.pages.retrieve({ page_id: resolvedPageId });
    console.log(
      `  ${clr.ok(sym.ok)} Root page reachable  ${clr.url(notionUrl(resolvedPageId))}\n`,
    );
  } catch (err: any) {
    const code: string = err.code ?? "unknown";
    if (code === "object_not_found" || err.status === 404) {
      console.error(
        clr.err(`\n${sym.err} Notion root page not found (${resolvedPageId})`),
      );
      console.error(
        "  Make sure: (1) page ID is correct, (2) integration is connected to the page",
      );
      console.error(
        "  To connect: open page in Notion → ... → Connections → select your integration",
      );
    } else if (code === "unauthorized" || err.status === 401) {
      console.error(
        clr.err(
          `\n${sym.err} Notion token rejected (${NOTION_TOKEN.slice(0, 12)}...)`,
        ),
      );
      console.error("  Check that the token is correct and not expired");
    } else {
      console.error(
        clr.err(
          `\n${sym.err} Notion API error during preflight: [${code}] ${err.message as string}`,
        ),
      );
    }
    process.exit(1);
  }
  return resolvedPageId;
}

// ── Doc scanning ──────────────────────────────────────────────────────────────

interface ScanResult {
  rootFiles: string[];
  sections: Map<string, string[]>;
}

function scanDocs(): ScanResult {
  const rootFiles: string[] = [];
  const sections = new Map<string, string[]>();
  for (const entry of fs.readdirSync(DOCS_DIR, { withFileTypes: true })) {
    if (shouldExclude(entry.name)) continue;
    if (entry.isFile() && entry.name.endsWith(".md")) {
      rootFiles.push(entry.name);
    } else if (entry.isDirectory()) {
      const dirFiles = fs
        .readdirSync(path.join(DOCS_DIR, entry.name))
        .filter((f) => f.endsWith(".md") && !shouldExclude(f))
        .map((f) => path.join(entry.name, f).replace(/\\/g, "/"));
      if (dirFiles.length > 0) sections.set(entry.name, dirFiles);
    }
  }
  return { rootFiles, sections };
}

// ── Pre-run listing ───────────────────────────────────────────────────────────

async function preRunListing(allToSync: string[]): Promise<boolean> {
  console.log(`\n${clr.bold(`Files to sync: ${allToSync.length}`)}`);
  console.log(HR);

  // Group by folder (null = root files), preserving order
  const groupOrder: Array<string | null> = [];
  const groupMap = new Map<string | null, string[]>();
  for (const relPath of allToSync) {
    const sep = relPath.indexOf("/");
    const folder = sep === -1 ? null : relPath.slice(0, sep);
    if (!groupMap.has(folder)) {
      groupMap.set(folder, []);
      groupOrder.push(folder);
    }
    groupMap.get(folder)!.push(relPath);
  }

  let counter = 0;

  function renderFile(
    relPath: string,
    linePrefix: string,
    metaPrefix: string,
  ): void {
    counter++;
    const doc = getDoc(relPath); // populates docCache for phases 1 & 2
    const title = doc?.title ?? path.basename(relPath, ".md");
    const images = doc?.images ?? [];
    const filename = path.basename(relPath);

    const metaParts: string[] = [];
    if (doc?.icon) {
      const iconStr =
        doc.icon.type === "emoji" ? doc.icon.emoji : clr.dim("[img]");
      metaParts.push(`${sym.icon} ${iconStr}`);
    }
    if (doc?.cover) metaParts.push(sym.cover);

    const imgStr =
      images.length === 0
        ? clr.dim("none")
        : `${images.length}  ${clr.dim(
            images
              .slice(0, 4)
              .map((s) => path.basename(s))
              .join(", ") +
              (images.length > 4 ? ` +${images.length - 4} more` : ""),
          )}`;
    metaParts.push(`${sym.img} ${imgStr}`);

    const idx = clr.gray(`[${counter}/${allToSync.length}]`);
    console.log(`\n${linePrefix}${filename}  ${idx}`);
    console.log(`${metaPrefix}  ${clr.dim(title)}   ${metaParts.join("   ")}`);
  }

  for (const folder of groupOrder) {
    const files = groupMap.get(folder)!;
    if (folder === null) {
      for (const relPath of files) {
        renderFile(relPath, "  ", "  ");
      }
    } else {
      console.log(`\n  ${clr.bold(folder)}/`);
      for (let i = 0; i < files.length; i++) {
        const isLast = i === files.length - 1;
        renderFile(
          files[i],
          isLast ? "  └── " : "  ├── ",
          isLast ? "       " : "  │    ",
        );
      }
    }
  }

  console.log(`\n${HR}`);
  const modeLabel = DRY_RUN
    ? clr.warn("dry run")
    : clr.ok("live sync to Notion");
  return askConfirm(`Proceed with ${modeLabel}? ${clr.dim("[Y/n]")} `);
}

// ── Phase 1: page discovery ───────────────────────────────────────────────────

/**
 * Ensures all pages exist in Notion. Returns:
 *   discoveryMap — relPath → { id, isNew }  (used in phase 2 to show created vs updated)
 *   pageIdMap    — relPath → id             (used by link rewriter)
 *
 * Two-phase design: all page IDs are known before any content is written,
 * enabling cross-file Notion link resolution in phase 2.
 */
async function discoverAllPages(
  rootFiles: string[],
  sections: Map<string, string[]>,
  rootPageId: string,
): Promise<{
  discoveryMap: Map<string, PageDiscovery>;
  pageIdMap: Map<string, string>;
}> {
  const discoveryMap = new Map<string, PageDiscovery>();
  const pageIdMap = new Map<string, string>();

  for (const file of rootFiles) {
    if (!shouldSync(file)) continue;
    const doc = getDoc(file);
    if (!doc) continue;
    try {
      const { id, isNew } = await getOrCreateChildPage(
        rootPageId,
        doc.title,
        doc.icon,
      );
      discoveryMap.set(file, { id, isNew });
      pageIdMap.set(file, id);
    } catch (err: any) {
      console.error(
        `  ${clr.err(sym.err)} Discovery failed for "${file}": ${err.message as string}`,
      );
    }
  }

  for (const [sectionDir, files] of sections) {
    const filesToSync = files.filter(shouldSync);
    if (filesToSync.length === 0) continue;

    const sectionTitle =
      sectionDir.charAt(0).toUpperCase() + sectionDir.slice(1);
    console.log(
      `  ${clr.section(sectionDir)} ${sym.arr} ${clr.bold(`"${sectionTitle}"`)}`,
    );

    let sectionPageId: string;
    if (DRY_RUN) {
      sectionPageId = `dry-run-section-${sectionDir}`;
      console.log(
        `    ${clr.dim(`[${sym.dry} DRY RUN] would get-or-create section page`)}`,
      );
    } else {
      try {
        const { id, isNew } = await getOrCreateChildPage(
          rootPageId,
          sectionTitle,
        );
        sectionPageId = id;
        const badge = isNew ? clr.ok(`${sym.new} CREATED`) : clr.dim("EXISTS");
        console.log(`    ${badge}  ${clr.url(notionUrl(id))}`);
      } catch (err: any) {
        console.error(
          `    ${clr.err(`${sym.err} Failed to get/create section`)}: ${err.message as string}`,
        );
        continue;
      }
    }

    for (const relPath of filesToSync) {
      const doc = getDoc(relPath);
      if (!doc) continue;
      try {
        const { id, isNew } = await getOrCreateChildPage(
          sectionPageId,
          doc.title,
          doc.icon,
        );
        discoveryMap.set(relPath, { id, isNew });
        pageIdMap.set(relPath, id);
      } catch (err: any) {
        console.error(
          `    ${clr.err(sym.err)} Discovery failed for "${relPath}": ${err.message as string}`,
        );
      }
    }
  }

  return { discoveryMap, pageIdMap };
}

// ── Phase 2: content writing ──────────────────────────────────────────────────

async function writeFileContent(
  relPath: string,
  discovery: PageDiscovery,
  pageIdMap: Map<string, string>,
  counter: { n: number; total: number },
): Promise<SyncResult> {
  const t0 = Date.now();
  const doc = getDoc(relPath);

  if (!doc) {
    console.error(
      `  ${clr.err(sym.err)} [${counter.n}/${counter.total}] ${relPath}: could not read file`,
    );
    return {
      path: relPath,
      title: relPath,
      status: "error",
      error: "Could not read file",
    };
  }

  const { title, body, images, icon, cover } = doc;
  const rewritten = rewriteLinks(body, relPath, pageIdMap);
  const pageNotionUrl = notionUrl(discovery.id);
  const action = discovery.isNew ? "created" : "updated";
  const actionBadge =
    action === "created"
      ? clr.ok(`${sym.new} CREATED`)
      : clr.warn(`${sym.upd} UPDATED`);

  const imgStr =
    images.length === 0
      ? clr.dim("none")
      : `${images.length}  ${clr.dim(images.map((s) => path.basename(s)).join(", "))}`;

  console.log(`\n  ${clr.bold(`[${counter.n}/${counter.total}]`)} ${relPath}`);
  console.log(`     ${clr.dim("Title:")}   ${title}`);
  console.log(`     ${clr.dim("Local:")}   docs/product/${relPath}`);

  if (icon) {
    const iconDisplay =
      icon.type === "emoji"
        ? icon.emoji
        : clr.url(icon.external.url.slice(0, 60));
    console.log(`     ${sym.icon}  ${clr.dim("Icon:")}    ${iconDisplay}`);
  }
  if (cover) {
    console.log(
      `     ${sym.cover}  ${clr.dim("Cover:")}   ${clr.url(cover.external.url)}`,
    );
  }
  if (images.length > 0) {
    console.log(`     ${sym.img}  ${clr.dim("Images:")}  ${imgStr}`);
  }

  if (DRY_RUN) {
    const wordCount = body.split(/\s+/).length;
    console.log(`     ${clr.dim("Words:")}   ~${wordCount}`);
    console.log(
      `     ${clr.dim("Status:")}  ${clr.dim(`[${sym.dry} DRY RUN] would ${action} + write markdown`)}`,
    );
    return { path: relPath, title, status: "dry_run", word_count: wordCount };
  }

  try {
    await updatePageMeta(discovery.id, icon, cover);
    await apiCall(() =>
      (notion.pages as any).updateMarkdown({
        page_id: discovery.id,
        type: "replace_content",
        replace_content: { new_str: rewritten, allow_deleting_content: true },
      }),
    );

    const elapsed = Date.now() - t0;
    console.log(`     ${clr.dim("Notion:")}  ${clr.url(pageNotionUrl)}`);
    console.log(
      `     ${clr.dim("Status:")}  ${actionBadge}  ${clr.dim(`${elapsed}ms`)}`,
    );
    return {
      path: relPath,
      title,
      status: action,
      page_id: discovery.id,
      notion_url: pageNotionUrl,
      elapsed_ms: elapsed,
    };
  } catch (err: any) {
    const errMsg: string = err.body
      ? JSON.stringify(err.body)
      : (err.message as string);
    console.error(
      `     ${clr.dim("Status:")}  ${clr.err(`${sym.err} ERROR — ${errMsg}`)}`,
    );
    return { path: relPath, title, status: "error", error: errMsg };
  }
}

// ── JSONL run log ─────────────────────────────────────────────────────────────

function appendRunLog(entry: RunLogEntry): void {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err: any) {
    console.warn(
      clr.warn(`Warning: could not write to run log: ${err.message as string}`),
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const runStart = new Date().toISOString();

  console.log(
    `\n${clr.header(`Notion Docs Sync${DRY_RUN ? " [DRY RUN]" : ""}`)}`,
  );
  console.log(HR);
  console.log(`${clr.dim("Docs dir:")}  ${DOCS_DIR}`);
  console.log(`${clr.dim("Root page:")} ${ROOT_PAGE_ID}`);
  console.log(
    `${clr.dim("Links:")}     ${LINK_MODE}${GITHUB_BASE ? clr.dim(` (fallback: ${GITHUB_BASE})`) : ""}`,
  );
  if (DEFAULT_ICON)
    console.log(
      `${clr.dim("Icon:")}      ${DEFAULT_ICON} ${clr.dim("(default for new pages)")}`,
    );
  if (onlyPaths.length > 0)
    console.log(`${clr.dim("Filter:")}    ${onlyPaths.join(", ")}`);
  console.log(HR + "\n");

  const rootPageId = await preflight();
  const { rootFiles, sections } = scanDocs();

  const allToSync: string[] = [
    ...rootFiles.filter(shouldSync),
    ...[...sections.values()].flat().filter(shouldSync),
  ];

  // Pre-run listing + confirmation — also warms docCache for all files
  const confirmed = await preRunListing(allToSync);
  if (!confirmed) {
    console.log(clr.warn("\nAborted."));
    process.exit(0);
  }

  // Phase 1 — ensure all pages exist, build page ID map for link rewriting
  console.log(`\n${clr.phase("Phase 1:")} ensuring pages exist in Notion...`);
  const { discoveryMap, pageIdMap } = await discoverAllPages(
    rootFiles,
    sections,
    rootPageId,
  );
  console.log(`  ${clr.ok(sym.ok)} ${discoveryMap.size} pages mapped\n`);

  // Phase 2 — write content with cross-file Notion links resolved
  console.log(`${clr.phase("Phase 2:")} writing content...`);
  const results: SyncResult[] = [];
  const counter = { n: 0, total: allToSync.length };

  for (const relPath of allToSync) {
    counter.n++;
    const discovery = discoveryMap.get(relPath);
    if (!discovery) {
      results.push({
        path: relPath,
        title: relPath,
        status: "error",
        error: "Page discovery failed in phase 1",
      });
      continue;
    }
    results.push(
      await writeFileContent(relPath, discovery, pageIdMap, counter),
    );
  }

  // Summary
  const errors = results.filter((r) => r.status === "error");
  const created = results.filter((r) => r.status === "created");
  const updated = results.filter((r) => r.status === "updated");
  const dryRun = results.filter((r) => r.status === "dry_run");

  console.log(`\n${HR}`);
  if (DRY_RUN) {
    console.log(
      clr.dim(
        `${sym.dry} DRY RUN complete — ${dryRun.length} files would be synced`,
      ),
    );
  } else {
    const parts: string[] = [];
    if (created.length)
      parts.push(clr.ok(`${sym.new} ${created.length} created`));
    if (updated.length)
      parts.push(clr.warn(`${sym.upd} ${updated.length} updated`));
    if (errors.length)
      parts.push(clr.err(`${sym.err} ${errors.length} errors`));
    console.log(`Sync complete — ${parts.join("   ")}`);
  }

  if (errors.length > 0) {
    console.error(`\n${clr.err(`${sym.err} ${errors.length} error(s):`)}`);
    for (const e of errors)
      console.error(clr.err(`  ${sym.dot} ${e.path}: ${e.error}`));
  }

  const logEntry: RunLogEntry = {
    ts: runStart,
    dry_run: DRY_RUN,
    filter: onlyPaths.length > 0 ? onlyPaths : null,
    root_page_id: rootPageId,
    root_notion_url: notionUrl(rootPageId),
    github_base: GITHUB_BASE,
    link_mode: LINK_MODE,
    stats: {
      total: results.length,
      created: created.length,
      updated: updated.length,
      dry_run: dryRun.length,
      errors: errors.length,
    },
    pages: results,
    error_summary:
      errors.length > 0
        ? errors.map((e) => ({ path: e.path, error: e.error! }))
        : null,
  };

  appendRunLog(logEntry);
  console.log(
    clr.dim(`\nRun logged → ${path.relative(process.cwd(), LOG_FILE)}`),
  );

  if (errors.length > 0) process.exit(1);
}

main().catch((err: Error) => {
  console.error(clr.err(`\n${sym.err} Unexpected fatal error: ${err.message}`));
  if (err.stack) console.error(clr.dim(err.stack));
  process.exit(1);
});
