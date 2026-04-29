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
 *   GITHUB_DOCS_ROOT    — repo-relative path prefix for DOCS_DIR, used for image URLs (default: "frontend/docs")
 *   NOTION_LINK_MODE    — "notion" (default) | "github" | "strip"
 *   NOTION_PAGE_ICON    — default emoji for all leaf pages (e.g. "📄")
 *   NOTION_FOLDER_ICON  — default emoji for folder/section pages without _index.md (e.g. "📁")
 *   NOTION_FULL_WIDTH   — "0" to disable full-width layout (default: on)
 *   NOTION_SHOW_META    — "0" to suppress frontmatter banner at top of each page (default: on)
 *   NOTION_SYNC_MAP     — path to JSON file mapping top-level folders to separate Notion root IDs
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
interface SuspicionMatch {
  name: string;
  explain: string;
}

interface SectionResult {
  rel_dir: string;
  title: string;
  page_id: string;
  notion_url: string;
  had_index_md: boolean;
  content_written: boolean;
  error?: string;
}

interface RunConfig {
  root_page_id: string;
  root_notion_url: string;
  docs_dir: string;
  link_mode: string;
  github_repo: string | null;
  github_branch: string;
  github_docs_root: string;
  github_docs_path: string;
  show_meta: boolean;
  folder_icon: string | null;
  default_page_icon: string | null;
  sync_map_file: string | null;
  rate_limit_ms: number;
  abort_window: number;
  abort_errors: number;
}

interface SyncResult {
  path: string;
  title: string;
  status: SyncStatus;
  page_id?: string;
  notion_url?: string;
  is_new?: boolean;
  elapsed_ms?: number;
  word_count?: number;
  error?: string;
  suspicions?: SuspicionMatch[];
}

// ── Metrics types (written to metrics.jsonl, rolling last N runs) ─────────────

interface ApiCallMetric {
  op: string;       // e.g. "pages.create", "pages.updateMarkdown"
  fn_ms: number;    // actual API call duration (before rate-limit sleep)
  total_ms: number; // fn_ms + RATE_LIMIT_MS
}

interface FileMetric {
  path: string;
  status: SyncStatus;
  elapsed_ms: number;
  content_chars: number;
}

interface MetricsSectionSummary {
  dir: string;
  file_count: number;
  total_ms: number;
  avg_ms: number;
  max_ms: number;
  slowest: string;
}

interface MetricsEntry {
  run_id: string;
  ts: string;
  dry_run: boolean;
  api_calls: ApiCallMetric[];
  api_summary: {
    count: number;
    total_fn_ms: number;
    avg_fn_ms: number;
    max_fn_ms: number;
    slowest_op: string;
    by_op: Record<string, { count: number; total_fn_ms: number; avg_fn_ms: number }>;
  };
  files: FileMetric[];
  file_summary: {
    count: number;
    total_ms: number;
    avg_ms: number;
    max_ms: number;
    slowest_path: string;
  };
  sections: MetricsSectionSummary[];
  timing: { phase1_ms: number; phase2_ms: number; total_ms: number };
}

interface RunLogEntry {
  run_id: string;
  version: string;
  ts: string;
  dry_run: boolean;
  filter: string[] | null;
  config: RunConfig;
  timing: { phase1_ms: number; phase2_ms: number; total_ms: number };
  stats: {
    total: number;
    created: number;
    updated: number;
    dry_run: number;
    errors: number;
    sections_written: number;
    aborted: boolean;
  };
  pages: SyncResult[];
  sections: SectionResult[];
  error_summary: { path: string; error: string; suspicions: string[] }[] | null;
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
const GITHUB_DOCS_ROOT = process.env.GITHUB_DOCS_ROOT ?? "frontend/docs";
const GITHUB_BASE = GITHUB_REPO
  ? `https://github.com/${GITHUB_REPO}/blob/${GITHUB_BRANCH}/${GITHUB_DOCS_PATH}`
  : null;
const GITHUB_RAW_BASE = GITHUB_REPO
  ? `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${GITHUB_DOCS_ROOT}`
  : null;
// GitHub blob base for linking to source .md files and image blobs in the UI
const GITHUB_BLOB_BASE = GITHUB_REPO
  ? `https://github.com/${GITHUB_REPO}/blob/${GITHUB_BRANCH}/${GITHUB_DOCS_ROOT}`
  : null;

// NOTION_FULL_WIDTH env var is intentionally unused: is_full_width is not
// settable via Notion's public REST API. Toggle full-width manually in Notion UI.
const SYNC_MAP_FILE = process.env.NOTION_SYNC_MAP ?? null;
const FOLDER_ICON = process.env.NOTION_FOLDER_ICON ?? null;
const SHOW_META = process.env.NOTION_SHOW_META !== "0"; // default on
const ABORT_POLICY_ENV = process.env.ABORT_POLICY ?? "disabled";
const ABORT_ENABLED = ABORT_POLICY_ENV !== "disabled";
const ABORT_ERRORS = parseInt(ABORT_POLICY_ENV) || 5;
const ABORT_WINDOW = 10;

const SCRIPT_VERSION = "1.2.0";
const RATE_LIMIT_MS = 350;

const LOG_FILE = path.join(__dirname, "runs.jsonl");
const METRICS_FILE = path.join(__dirname, "metrics.jsonl");
const METRICS_MAX_RUNS = 5; // rolling window — older entries are dropped
const EXCLUDE_PATTERNS = [/^_/, /\.claude\.md$/];

// Module-level accumulator — populated during the run, flushed to metrics.jsonl at end.
const runMetrics = {
  apiCalls: [] as ApiCallMetric[],
  files: [] as FileMetric[],
};

// ── Push failure suspicion rules ──────────────────────────────────────────────
// Each rule runs against the file content when a push fails.
// Add new rules here; they'll automatically appear in error output.

interface SuspicionRule {
  name: string;
  // One-line explanation shown when the rule fires
  explain: string;
  check: (content: string) => boolean;
}

const SUSPICION_RULES: SuspicionRule[] = [
  {
    name: "cloudflare-waf-curl",
    // curl + localhost/IP in request body triggers Cloudflare SSRF WAF rules.
    // Especially dangerous outside fenced code blocks (table cells, inline code).
    explain:
      'Contains `curl` with a localhost/IP URL — Cloudflare WAF flags this as SSRF in POST bodies.',
    check: (c) => /curl\s+.*localhost/i.test(c) || /curl\s+.*\d+\.\d+\.\d+\.\d+/i.test(c),
  },
  {
    name: "cloudflare-waf-shell-pipe",
    // Shell pipe sequences (cmd | head, cmd | grep) outside fenced blocks
    // can match command-injection WAF signatures.
    explain:
      'Contains a shell pipe pattern (e.g. `cmd | head`) outside a fenced code block.',
    check: (c) => {
      // Strip fenced code blocks, then look for pipes between shell-like tokens
      const stripped = c.replace(/```[\s\S]*?```/g, "");
      return /`[^`]*\|\s*\w+[^`]*`/.test(stripped);
    },
  },
  {
    name: "cloudflare-waf-sql-keyword",
    // SQL keywords (SELECT, DROP, INSERT, etc.) in POST bodies trigger ModSecurity rules.
    // Usually fine inside fenced blocks; risky in prose or table cells.
    explain:
      'Contains SQL keywords (SELECT/DROP/INSERT/UPDATE) outside a fenced code block.',
    check: (c) => {
      const stripped = c.replace(/```[\s\S]*?```/g, "");
      return /\b(SELECT|DROP|INSERT|UPDATE|DELETE|CREATE TABLE|ALTER TABLE)\b/i.test(stripped);
    },
  },
  {
    name: "cloudflare-waf-script-tag",
    // <script> tags in markdown content are a near-certain WAF block.
    explain: 'Contains a <script> tag — always blocked by Cloudflare WAF.',
    check: (c) => /<script[\s>]/i.test(c),
  },
  {
    name: "notion-body-too-large",
    // Notion's markdown endpoint has an undocumented ~2MB body limit.
    // Files approaching this size may get rejected or time out.
    explain: 'File content exceeds 500 KB — may hit Notion markdown body size limits.',
    check: (c) => Buffer.byteLength(c, "utf8") > 500_000,
  },
];

// ── CLI args ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const onlyPaths: string[] = [];
let collectingOnly = false;
let argVerbose = false;
for (const arg of argv) {
  if (arg === "--only") { collectingOnly = true; continue; }
  if (arg === "--verbose") { argVerbose = true; collectingOnly = false; continue; }
  if (arg.startsWith("--")) { collectingOnly = false; continue; }
  if (collectingOnly) onlyPaths.push(arg.replace(/\/$/, ""));
}

const VERBOSE = process.env.VERBOSE === "1" || argVerbose;

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

// ── Suspicion checks ─────────────────────────────────────────────────────────

function runSuspicionChecks(content: string): SuspicionMatch[] {
  return SUSPICION_RULES.filter((r) => r.check(content)).map((r) => ({
    name: r.name,
    explain: r.explain,
  }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function apiCall<T>(fn: () => Promise<T>, label = "api"): Promise<T> {
  const t0 = Date.now();
  const result = await fn();
  const fn_ms = Date.now() - t0;
  await sleep(RATE_LIMIT_MS);
  runMetrics.apiCalls.push({ op: label, fn_ms, total_ms: fn_ms + RATE_LIMIT_MS });
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

function makeRunId(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
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

/**
 * Reads _index.md for a given relDir (excluded from normal sync but used for
 * folder icon + section page content). Returns null if no _index.md exists.
 */
function getFolderIndex(relDir: string): ParsedDoc | null {
  const indexRelPath = relDir ? `${relDir}/_index.md` : "_index.md";
  if (docCache.has(indexRelPath)) return docCache.get(indexRelPath)!;
  const raw = safeReadFile(path.join(DOCS_DIR, indexRelPath));
  if (!raw) return null;
  const { meta, body } = parseFrontmatter(raw);
  const doc: ParsedDoc = {
    title: extractTitle(body, indexRelPath),
    body,
    meta,
    images: extractImages(body),
    icon: resolveIcon(meta),
    cover: resolveCover(meta),
  };
  docCache.set(indexRelPath, doc);
  return doc;
}

const STATUS_EMOJI: Record<string, string> = {
  stable: "✅", stub: "⚠️", partial: "🔧", planned: "📅", deprecated: "🗑️",
};

/**
 * Builds a one-line blockquote banner from frontmatter metadata fields.
 * Prepended to page body before syncing so Notion pages show doc context.
 * Returns empty string if no relevant fields are present.
 */
function buildMetaBanner(meta: Record<string, string>): string {
  const parts: string[] = [];
  if (meta.status) {
    const emoji = STATUS_EMOJI[meta.status.toLowerCase()] ?? "🏷";
    parts.push(`${emoji} **${meta.status}**`);
  }
  if (meta.audience) parts.push(`audience: ${meta.audience}`);
  if (meta.last_updated) parts.push(`updated: ${meta.last_updated}`);
  if (parts.length === 0) return "";
  return `> ${parts.join(" · ")}\n\n`;
}

/**
 * Builds a breadcrumb line showing the doc's position in the folder tree.
 * Each segment links to its section page if available in pageIdMap.
 * Only used in Phase 2 when pageIdMap is fully populated.
 */
function buildBreadcrumb(relPath: string, pageIdMap: Map<string, string>): string {
  const dir = path.dirname(relPath);
  if (dir === "." || dir === "") return "";
  const parts = dir.split("/");
  const crumbs = parts.map((part, i) => {
    const dirPath = parts.slice(0, i + 1).join("/");
    const id = pageIdMap.get(`${dirPath}/_index.md`);
    const label = part.replace(/-/g, " ");
    return id ? `[${label}](${notionUrl(id)})` : label;
  });
  return `> 📍 ${crumbs.join(" / ")}\n\n`;
}

/**
 * Auto-generates a section index page for folders without _index.md.
 * Lists child docs (with status + audience) and subsections with doc counts.
 * Called after recursion so child page IDs are available for linking.
 */
function buildAutoIndex(
  dirName: string,
  subTree: DocTree,
  pageIdMap: Map<string, string>,
  childRelDir: string,
): string {
  const title = dirName.replace(/-/g, " ");
  const lines: string[] = [`# ${title.charAt(0).toUpperCase() + title.slice(1)}\n`];

  const filePaths = subTree.files.filter(shouldSync);
  if (filePaths.length > 0) {
    lines.push("\n## Contents\n");
    lines.push("| Doc | Status | Audience |");
    lines.push("| --- | ------ | -------- |");
    for (const relPath of filePaths) {
      const doc = docCache.get(relPath);
      if (!doc) continue;
      const id = pageIdMap.get(relPath);
      const titleCell = id ? `[${doc.title}](${notionUrl(id)})` : doc.title;
      const statusRaw = (doc.meta.status ?? "").toLowerCase();
      const statusCell = statusRaw ? `${STATUS_EMOJI[statusRaw] ?? "🏷"} ${statusRaw}` : "—";
      const audienceCell = doc.meta.audience ?? "—";
      lines.push(`| ${titleCell} | ${statusCell} | ${audienceCell} |`);
    }
  }

  if (subTree.subdirs.size > 0) {
    lines.push("\n## Sections\n");
    lines.push("| Section | Docs |");
    lines.push("| ------- | ---- |");
    for (const [subDirName, subSubTree] of subTree.subdirs) {
      const subIndexRelPath = `${childRelDir}/${subDirName}/_index.md`;
      const id = pageIdMap.get(subIndexRelPath);
      const label = subDirName.replace(/-/g, " ");
      const count = collectFiles(subSubTree).filter(shouldSync).length;
      const titleCell = id ? `[${label}](${notionUrl(id)})` : label;
      lines.push(`| ${titleCell} | ${count} |`);
    }
  }

  return lines.join("\n") + "\n";
}

// ── Link rewriting ────────────────────────────────────────────────────────────

function notionUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function fmtTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

function fmtTimeShort(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function fmtElapsed(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// Verbose-gated log — suppressed in progress-bar mode to avoid corrupting bar
function vlog(...args: Parameters<typeof console.log>): void {
  if (VERBOSE) console.log(...args);
}

// Progress bar for Phase 2 — in-place single-line update via \r
const BAR_WIDTH = 28;
function renderProgress(n: number, total: number, file: string, status?: string): void {
  const filled = Math.round((n / total) * BAR_WIDTH);
  const bar = paint(A.G, "█".repeat(filled)) + paint(A.d, "░".repeat(BAR_WIDTH - filled));
  const pct = String(Math.floor((n / total) * 100)).padStart(3);
  const label = file.length > 42 ? `…${file.slice(-41)}` : file.padEnd(42);
  const statusDot = status === "error" ? paint(A.R, sym.err) : paint(A.d, sym.dot);
  process.stdout.write(`\r  [${bar}] ${clr.bold(`${n}/${total}`)} ${pct}%  ${statusDot} ${clr.dim(label)}`);
}
function clearProgress(): void {
  process.stdout.write("\r" + " ".repeat(100) + "\r");
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
          // Log when a relative .md link can't be resolved — helps diagnose
          // missing pageIdMap entries. Notion auto-links plain-text "foo.md" as
          // http://foo.md (Moldova TLD), so unresolved links cause bad renders.
          console.warn(
            clr.warn(`  [link] unresolved: "${resolved}" (in ${relPath}) — not in pageIdMap`),
          );
        }
        if (LINK_MODE !== "strip" && GITHUB_REPO) {
          // Check if resolved path (relative to DOCS_DIR) actually exists.
          // If not, the link is repo-root-relative (e.g. src/core/...) written
          // without a leading / — use raw urlPath with the repo-root blob base
          // instead of GITHUB_BASE (which already has GITHUB_DOCS_PATH prefixed).
          const existsInDocs =
            fs.existsSync(path.join(DOCS_DIR, resolved)) ||
            fs.existsSync(path.join(DOCS_DIR, resolved + ".md"));
          const githubHref = existsInDocs
            ? `${GITHUB_BASE}/${resolved}`
            : `https://github.com/${GITHUB_REPO}/blob/${GITHUB_BRANCH}/${urlPath}`;
          return `[${text}](${githubHref}${anchor ? "#" + anchor : ""})`;
        }
        return text;
      }
      return text;
    },
  );
}

/**
 * Rewrites relative image src paths to GitHub raw.githubusercontent.com URLs.
 * Only runs when GITHUB_REPO + GITHUB_BRANCH are set.
 * Already-absolute URLs pass through unchanged.
 */
function rewriteImages(content: string, relPath: string): string {
  if (!GITHUB_RAW_BASE) return content;
  const dir = path.dirname(relPath);
  return content.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_m, alt: string, src: string) => {
      if (src.startsWith("http://") || src.startsWith("https://")) return _m;
      const resolved = path.normalize(path.join(dir, src)).replace(/\\/g, "/");
      const rawUrl = `${GITHUB_RAW_BASE}/${resolved}`;
      // Fallback caption: always present so readers can navigate to the image
      // even when Notion can't load it (e.g. private repo raw URLs return 404).
      const altText = alt.trim();
      const sourceUrl = GITHUB_BLOB_BASE ? `${GITHUB_BLOB_BASE}/${relPath}` : null;
      const captionParts = [
        altText ? `📷 _${altText}_` : "📷",
        sourceUrl ? `[source doc ↗](${sourceUrl})` : null,
        `[image ↗](${rawUrl})`,
      ].filter(Boolean).join(" · ");
      return `![${alt}](${rawUrl})\n\n${captionParts}`;
    },
  );
}

/**
 * Loads an optional JSON file mapping top-level folder names to Notion page IDs.
 * Format: { "product": "notion-page-id-or-url-slug", "system": "..." }
 * Resolves each value the same way preflight resolves ROOT_PAGE_ID.
 */
function loadFolderMap(): Map<string, string> {
  if (!SYNC_MAP_FILE) return new Map();
  const absPath = path.resolve(SYNC_MAP_FILE);
  if (!fs.existsSync(absPath)) {
    console.warn(clr.warn(`${sym.warn} NOTION_SYNC_MAP not found: ${absPath}`));
    return new Map();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(absPath, "utf-8")) as Record<string, string>;
    const result = new Map<string, string>();
    for (const [folder, idOrSlug] of Object.entries(raw)) {
      const hexMatch = idOrSlug.match(/([0-9a-f]{32})$/i);
      result.set(folder, hexMatch ? hexMatch[1] : idOrSlug);
    }
    console.log(clr.dim(`  Folder map: ${[...result.keys()].join(", ")}`));
    return result;
  } catch (err: any) {
    console.warn(clr.warn(`${sym.warn} Could not parse NOTION_SYNC_MAP: ${err.message as string}`));
    return new Map();
  }
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
      "blocks.children.list",
    );
    for (const block of res.results) {
      // Collect all child_page blocks — archived status is checked per-page in
      // getOrCreateChildPage via pages.retrieve (block.archived is always false
      // even for trashed pages, so filtering here would be a no-op).
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
  if (existing) {
    // blocks.children.list always reports archived: false on the block object
    // even when the underlying page is trashed — the real flag is on the page.
    // If the matched page is archived, treat it as non-existent and fall through
    // to create a fresh one. Unarchiving is unreliable (Notion eventual consistency).
    const pageData = await apiCall(
      () => notion.pages.retrieve({ page_id: existing.id }),
      "pages.retrieve",
    );
    // Notion uses `in_trash` for pages moved to trash; `archived` is a separate
    // toggle. Both mean "don't reuse this page" — skip and create a fresh one.
    const isTrashed = (pageData as any).in_trash === true || (pageData as any).archived === true;
    if (!isTrashed) {
      return { id: existing.id, isNew: false };
    }
    // trashed/archived — fall through to pages.create below
  }
  const page = await apiCall(() =>
    notion.pages.create({
      parent: { page_id: parentId },
      properties: { title: { title: [{ text: { content: title } }] } },
      ...(icon ? { icon: icon as any } : {}),
    }),
    "pages.create",
  );
  // Notion deduplicates pages.create by title+parent — if a trashed page with
  // the same title exists, the API returns that trashed page instead of creating
  // a new one. Unarchive immediately so Phase 2 can write to it.
  if ((page as any).in_trash === true || (page as any).archived === true) {
    await apiCall(
      () => notion.pages.update({ page_id: page.id, archived: false }),
      "pages.unarchive",
    );
  }
  children.push({ id: page.id, title });
  return { id: page.id, isNew: true };
}

// applies icon and cover to a page.
// NOTE: is_full_width is NOT in Notion's public REST API — @notionhq/client
// strips it with a warning and it has no effect. Full-width must be set
// manually in the Notion UI (or via the undocumented private API).
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
    } as any),
    "pages.update",
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

// ── Doc scanning ─────────────────────────────────────────────────────────────

interface DocTree {
  files: string[];               // full relPaths (from DOCS_DIR) of .md files in this dir
  subdirs: Map<string, DocTree>; // dirname → subtree
}

function collectFiles(tree: DocTree): string[] {
  const out: string[] = [...tree.files];
  for (const sub of tree.subdirs.values()) out.push(...collectFiles(sub));
  return out;
}

function scanTree(absDir: string, relPrefix: string): DocTree {
  const tree: DocTree = { files: [], subdirs: new Map() };
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (shouldExclude(entry.name)) continue;
    if (entry.isFile() && entry.name.endsWith(".md")) {
      tree.files.push(relPrefix ? `${relPrefix}/${entry.name}` : entry.name);
    } else if (entry.isDirectory()) {
      const childPrefix = relPrefix
        ? `${relPrefix}/${entry.name}`
        : entry.name;
      const sub = scanTree(path.join(absDir, entry.name), childPrefix);
      if (sub.files.length > 0 || sub.subdirs.size > 0)
        tree.subdirs.set(entry.name, sub);
    }
  }
  return tree;
}

function scanDocs(): DocTree {
  return scanTree(DOCS_DIR, "");
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
 * Recursively ensures all pages exist in Notion, mirroring the folder hierarchy.
 * Populates discoveryMap (relPath → {id, isNew}) and pageIdMap (relPath → id).
 *
 * Two-phase design: all IDs are known before content is written, enabling
 * cross-file Notion link resolution in phase 2.
 */
async function discoverTree(
  tree: DocTree,
  parentPageId: string,
  discoveryMap: Map<string, PageDiscovery>,
  pageIdMap: Map<string, string>,
  indent = "  ",
  folderMap?: Map<string, string>, // optional: top-level folder → mapped Notion root
  relDir = "",                     // relative path from DOCS_DIR to current dir (for _index.md)
  sectionResults: SectionResult[] = [],
): Promise<void> {
  // Files directly in this dir go under parentPageId
  for (const relPath of tree.files) {
    if (!shouldSync(relPath)) continue;
    const doc = getDoc(relPath);
    if (!doc) continue;
    try {
      const { id, isNew } = await getOrCreateChildPage(
        parentPageId,
        doc.title,
        doc.icon,
      );
      discoveryMap.set(relPath, { id, isNew });
      pageIdMap.set(relPath, id);
    } catch (err: any) {
      console.error(
        `${indent}${clr.err(sym.err)} Discovery failed for "${relPath}": ${err.message as string}`,
      );
    }
  }

  // Each subdir becomes a section page; recurse into it
  for (const [dirName, subTree] of tree.subdirs) {
    if (collectFiles(subTree).filter(shouldSync).length === 0) continue;

    const childRelDir = relDir ? `${relDir}/${dirName}` : dirName;
    const indexRelPath = `${childRelDir}/_index.md`;

    // Folder map: if this top-level dir has an explicit Notion root, skip
    // creating a section page and root the subtree directly under that page.
    const mappedRootId = folderMap?.get(dirName);
    if (mappedRootId) {
      vlog(`${indent}${clr.section(dirName)} ${sym.arr} ${clr.dim("[mapped]")}  ${clr.url(notionUrl(mappedRootId))}`);
      // Don't pass folderMap recursively — mapping only applies at top level
      await discoverTree(subTree, mappedRootId, discoveryMap, pageIdMap, indent + "  ", undefined, childRelDir, sectionResults);
      continue;
    }

    // Read _index.md for folder icon (if it exists)
    const folderIndex = getFolderIndex(childRelDir);
    const folderIconResolved: NotionIcon | undefined =
      folderIndex?.icon ??
      (FOLDER_ICON ? ({ type: "emoji", emoji: FOLDER_ICON } as NotionIcon) : undefined);

    const sectionTitle = dirName.charAt(0).toUpperCase() + dirName.slice(1);
    const indexNote = folderIndex ? clr.dim(` ${sym.icon} ${folderIndex.icon?.type === "emoji" ? folderIndex.icon.emoji : "[img]"}`) : "";
    vlog(`${indent}${clr.section(dirName)}${indexNote} ${sym.arr} ${clr.bold(`"${sectionTitle}"`)}`);
    if (!VERBOSE && IS_TTY) {
      process.stdout.write(`\r  ${clr.dim("Phase 1:")} discovering ${clr.dim(childRelDir || "root")}...${" ".repeat(20)}`);
    }

    let sectionPageId: string;
    if (DRY_RUN) {
      sectionPageId = `dry-run-section-${dirName}`;
      vlog(`${indent}  ${clr.dim(`[${sym.dry} DRY RUN] would get-or-create section page`)}`);
    } else {
      try {
        const { id, isNew } = await getOrCreateChildPage(
          parentPageId,
          sectionTitle,
          folderIconResolved,
        );
        sectionPageId = id;
        const badge = isNew ? clr.ok(`${sym.new} CREATED`) : clr.dim("EXISTS");
        vlog(`${indent}  ${badge}  ${clr.url(notionUrl(id))}`);
        // full-width not settable via public API — user sets manually in Notion
      } catch (err: any) {
        console.error(
          `${indent}  ${clr.err(`${sym.err} Failed to get/create section`)}: ${err.message as string}`,
        );
        continue;
      }
    }

    // Register section page BEFORE recursing so breadcrumbs + cross-links
    // from children can resolve ancestor section pages during Phase 1.
    pageIdMap.set(indexRelPath, sectionPageId);

    // Write section content BEFORE recursing so replace_content doesn't delete
    // child_page blocks created during the recursive call. Child page links in
    // _index.md won't resolve here (IDs don't exist yet) — they fall back to
    // GitHub URLs. This is acceptable; the child pages themselves get full content
    // in Phase 2 which runs after all IDs are in pageIdMap.
    if (!DRY_RUN) {
      if (folderIndex) {
        try {
          const banner = SHOW_META ? buildMetaBanner(folderIndex.meta) : "";
          const rewritten = rewriteLinks(
            rewriteImages(banner + folderIndex.body, indexRelPath),
            indexRelPath,
            pageIdMap,
          );
          const indexSyncedAt = fmtTimestamp(new Date());
          const rewrittenWithFooter = `${rewritten}\n\n---\n\n*Synced: ${indexSyncedAt}*\n`;
          await updatePageMeta(sectionPageId, folderIndex.icon, folderIndex.cover);
          await apiCall(() =>
            (notion.pages as any).updateMarkdown({
              page_id: sectionPageId,
              type: "replace_content",
              replace_content: { new_str: rewrittenWithFooter, allow_deleting_content: true },
            }),
            "pages.updateMarkdown.index",
          );
          discoveryMap.set(indexRelPath, { id: sectionPageId, isNew: false });
          vlog(`${indent}  ${clr.dim(`${sym.ok} _index.md written`)}  ${clr.dim(`(${folderIndex.title})`)}`);
          sectionResults.push({
            rel_dir: childRelDir,
            title: folderIndex.title,
            page_id: sectionPageId,
            notion_url: notionUrl(sectionPageId),
            had_index_md: true,
            content_written: true,
          });
        } catch (err: any) {
          console.error(
            `${indent}  ${clr.warn(`${sym.warn} _index.md write failed: ${(err.message as string).slice(0, 80)}`)}`,
          );
          sectionResults.push({
            rel_dir: childRelDir,
            title: sectionTitle,
            page_id: sectionPageId,
            notion_url: notionUrl(sectionPageId),
            had_index_md: true,
            content_written: false,
            error: (err.message as string).slice(0, 200),
          });
        }
      } else {
        // No _index.md — write auto-index now (before recursion) using available IDs.
        // Child page IDs aren't known yet so links will be plain text; that is correct
        // behaviour since the alternative is to write after recursion and have
        // replace_content delete the just-created child_page blocks.
        try {
          const autoContent = buildAutoIndex(dirName, subTree, pageIdMap, childRelDir);
          const autoSyncedAt = fmtTimestamp(new Date());
          const autoContentWithFooter = `${autoContent}\n---\n\n*Synced: ${autoSyncedAt}*\n`;
          await apiCall(() =>
            (notion.pages as any).updateMarkdown({
              page_id: sectionPageId,
              type: "replace_content",
              replace_content: { new_str: autoContentWithFooter, allow_deleting_content: true },
            }),
            "pages.updateMarkdown.auto",
          );
          const childCount = collectFiles(subTree).filter(shouldSync).length;
          vlog(`${indent}  ${clr.dim(`${sym.ok} auto-index written`)}  ${clr.dim(`(${childCount} docs)`)}`);
          sectionResults.push({
            rel_dir: childRelDir,
            title: sectionTitle,
            page_id: sectionPageId,
            notion_url: notionUrl(sectionPageId),
            had_index_md: false,
            content_written: true,
          });
        } catch (err: any) {
          console.error(
            `${indent}  ${clr.warn(`${sym.warn} auto-index write failed: ${(err.message as string).slice(0, 80)}`)}`,
          );
          sectionResults.push({
            rel_dir: childRelDir,
            title: sectionTitle,
            page_id: sectionPageId,
            notion_url: notionUrl(sectionPageId),
            had_index_md: false,
            content_written: false,
            error: (err.message as string).slice(0, 200),
          });
        }
      }
    }

    await discoverTree(subTree, sectionPageId, discoveryMap, pageIdMap, indent + "  ", undefined, childRelDir, sectionResults);
  }
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

  const { title, body, images, icon, cover, meta } = doc;
  const breadcrumb = buildBreadcrumb(relPath, pageIdMap);
  const banner = SHOW_META ? buildMetaBanner(meta) : "";
  // Images first (relative paths → GitHub raw URLs), then links (.md → Notion URLs)
  const rewritten = rewriteLinks(rewriteImages(breadcrumb + banner + body, relPath), relPath, pageIdMap);
  // Footer: divider + italic last-synced timestamp appended to every page
  const syncedAt = fmtTimestamp(new Date(t0));
  const withFooter = `${rewritten}\n\n---\n\n*Synced: ${syncedAt}*\n`;
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

  if (VERBOSE) {
    console.log(`\n  ${clr.bold(`[${counter.n}/${counter.total}]`)} ${relPath}  ${clr.dim(fmtTimeShort(new Date(t0)))}`);
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
      console.log(`     ${sym.cover}  ${clr.dim("Cover:")}   ${clr.url(cover.external.url)}`);
    }
    if (images.length > 0) {
      console.log(`     ${sym.img}  ${clr.dim("Images:")}  ${imgStr}`);
    }
  }

  if (DRY_RUN) {
    const wordCount = body.split(/\s+/).length;
    if (VERBOSE) {
      console.log(`     ${clr.dim("Words:")}   ~${wordCount}`);
      console.log(`     ${clr.dim("Status:")}  ${clr.dim(`[${sym.dry} DRY RUN] would ${action} + write markdown`)}`);
    }
    return { path: relPath, title, status: "dry_run", word_count: wordCount };
  }

  const doWrite = async (): Promise<void> => {
    await sleep(RATE_LIMIT_MS);
    await updatePageMeta(discovery.id, icon, cover);
    await apiCall(() =>
      (notion.pages as any).updateMarkdown({
        page_id: discovery.id,
        type: "replace_content",
        replace_content: { new_str: withFooter, allow_deleting_content: true },
      }),
      "pages.updateMarkdown",
    );
  };

  try {
    await doWrite();

    const elapsed = Date.now() - t0;
    runMetrics.files.push({ path: relPath, status: action, elapsed_ms: elapsed, content_chars: withFooter.length });
    if (VERBOSE) {
      console.log(`     ${clr.dim("Notion:")}  ${clr.url(pageNotionUrl)}`);
      console.log(`     ${clr.dim("Status:")}  ${actionBadge}  ${clr.dim(fmtElapsed(elapsed))}`);
    }
    return {
      path: relPath,
      title,
      status: action,
      page_id: discovery.id,
      notion_url: pageNotionUrl,
      is_new: discovery.isNew,
      elapsed_ms: elapsed,
    };
  } catch (err: any) {
    const errMsg: string = err.body
      ? JSON.stringify(err.body)
      : (err.message as string);

    const elapsed = Date.now() - t0;
    runMetrics.files.push({ path: relPath, status: "error", elapsed_ms: elapsed, content_chars: withFooter.length });
    if (!VERBOSE && IS_TTY) process.stdout.write("\n");
    console.error(`  ${clr.err(`${sym.err} ${relPath}: ${errMsg.slice(0, 120)}`)}`);
    if (!VERBOSE && IS_TTY) renderProgress(counter.n, counter.total, relPath, "error");

    // Only run WAF suspicion checks when the error looks like a server-side
    // rejection — not for Notion's own validation_error codes (archived page,
    // invalid property, etc.) which have a clear non-WAF cause.
    let fired: SuspicionMatch[] = [];
    const isNotionValidationError = errMsg.includes('"code":"validation_error"') || errMsg.includes("validation_error");
    if (!isNotionValidationError) {
      fired = runSuspicionChecks(rewritten);
      if (fired.length > 0) {
        console.error(`     ${clr.warn(`${sym.warn} Possible causes:`)}`);
        for (const r of fired)
          console.error(`       ${clr.dim(`[${r.name}]`)} ${r.explain}`);
      }
    } else {
      // Surface the Notion error code directly so it's visible in the console
      try {
        const parsed = JSON.parse(JSON.parse(errMsg) as string) as { code?: string; message?: string };
        console.error(`     ${clr.dim("Notion:")}   ${clr.err(parsed.message ?? errMsg.slice(0, 120))}`);
      } catch { /* already printed above */ }
    }

    return { path: relPath, title, status: "error", error: errMsg, suspicions: fired };
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

function buildAndWriteMetrics(
  runId: string,
  ts: string,
  timing: { phase1_ms: number; phase2_ms: number; total_ms: number },
): void {
  const { apiCalls, files } = runMetrics;

  // API summary
  const byOp: Record<string, { count: number; total_fn_ms: number }> = {};
  for (const c of apiCalls) {
    if (!byOp[c.op]) byOp[c.op] = { count: 0, total_fn_ms: 0 };
    byOp[c.op].count++;
    byOp[c.op].total_fn_ms += c.fn_ms;
  }
  const totalFnMs = apiCalls.reduce((s, c) => s + c.fn_ms, 0);
  const maxCall = apiCalls.reduce((m, c) => (c.fn_ms > m.fn_ms ? c : m), { op: "", fn_ms: 0, total_ms: 0 });
  const apiSummary = {
    count: apiCalls.length,
    total_fn_ms: totalFnMs,
    avg_fn_ms: apiCalls.length ? Math.round(totalFnMs / apiCalls.length) : 0,
    max_fn_ms: maxCall.fn_ms,
    slowest_op: maxCall.op,
    by_op: Object.fromEntries(
      Object.entries(byOp).map(([op, v]) => [
        op,
        { count: v.count, total_fn_ms: v.total_fn_ms, avg_fn_ms: Math.round(v.total_fn_ms / v.count) },
      ]),
    ),
  };

  // File summary
  const totalFileMs = files.reduce((s, f) => s + f.elapsed_ms, 0);
  const slowestFile = files.reduce((m, f) => (f.elapsed_ms > m.elapsed_ms ? f : m), { path: "", elapsed_ms: 0, status: "dry_run" as SyncStatus, content_chars: 0 });
  const fileSummary = {
    count: files.length,
    total_ms: totalFileMs,
    avg_ms: files.length ? Math.round(totalFileMs / files.length) : 0,
    max_ms: slowestFile.elapsed_ms,
    slowest_path: slowestFile.path,
  };

  // Section summaries — group by top-level directory
  const sectionMap: Record<string, FileMetric[]> = {};
  for (const f of files) {
    const dir = f.path.includes("/") ? f.path.split("/")[0] : "(root)";
    if (!sectionMap[dir]) sectionMap[dir] = [];
    sectionMap[dir].push(f);
  }
  const sections: MetricsSectionSummary[] = Object.entries(sectionMap).map(([dir, sFiles]) => {
    const total = sFiles.reduce((s, f) => s + f.elapsed_ms, 0);
    const slowest = sFiles.reduce((m, f) => (f.elapsed_ms > m.elapsed_ms ? f : m), sFiles[0]);
    return {
      dir,
      file_count: sFiles.length,
      total_ms: total,
      avg_ms: Math.round(total / sFiles.length),
      max_ms: slowest.elapsed_ms,
      slowest: slowest.path,
    };
  });

  const entry: MetricsEntry = {
    run_id: runId,
    ts,
    dry_run: DRY_RUN,
    api_calls: apiCalls,
    api_summary: apiSummary,
    files,
    file_summary: fileSummary,
    sections,
    timing,
  };

  try {
    // Rolling window: keep last METRICS_MAX_RUNS - 1 existing entries + new one
    let existing: MetricsEntry[] = [];
    if (fs.existsSync(METRICS_FILE)) {
      existing = fs
        .readFileSync(METRICS_FILE, "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as MetricsEntry);
    }
    const trimmed = [...existing.slice(-(METRICS_MAX_RUNS - 1)), entry];
    fs.writeFileSync(METRICS_FILE, trimmed.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    console.log(clr.dim(`Metrics  → ${path.relative(process.cwd(), METRICS_FILE)} (last ${trimmed.length} runs)`));
  } catch (err: any) {
    console.warn(clr.warn(`Warning: could not write metrics: ${err.message as string}`));
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const runStartDate = new Date();
  const runStart = runStartDate.toISOString();

  console.log(
    `\n${clr.header(`Notion Docs Sync${DRY_RUN ? " [DRY RUN]" : ""}`)}`,
  );
  console.log(HR);
  console.log(`${clr.dim("Docs dir:")}  ${DOCS_DIR}`);
  console.log(`${clr.dim("Root page:")} ${ROOT_PAGE_ID}`);
  console.log(
    `${clr.dim("Links:")}     ${LINK_MODE}${GITHUB_BASE ? clr.dim(` (fallback: ${GITHUB_BASE})`) : ""}`,
  );
  if (GITHUB_RAW_BASE)
    console.log(`${clr.dim("Images:")}    ${clr.dim(`→ ${GITHUB_RAW_BASE}/...`)}`);
  // full-width not logged — not settable via public API
  if (SHOW_META)
    console.log(`${clr.dim("Meta:")}      frontmatter banner on`);
  if (DEFAULT_ICON)
    console.log(
      `${clr.dim("Icon:")}      ${DEFAULT_ICON} ${clr.dim("(default for new pages)")}`,
    );
  if (onlyPaths.length > 0)
    console.log(`${clr.dim("Filter:")}    ${onlyPaths.join(", ")}`);
  console.log(HR + "\n");

  const rootPageId = await preflight();
  const tree = scanDocs();
  const allToSync = collectFiles(tree).filter(shouldSync);

  // Pre-run listing + confirmation — also warms docCache for all files
  const confirmed = await preRunListing(allToSync);
  if (!confirmed) {
    console.log(clr.warn("\nAborted."));
    process.exit(0);
  }

  // Phase 1 — ensure all pages exist, build page ID map for link rewriting
  console.log(`\n${clr.phase("Phase 1:")} ensuring pages exist in Notion...`);
  const discoveryMap = new Map<string, PageDiscovery>();
  const pageIdMap = new Map<string, string>();
  const folderMap = loadFolderMap();
  const sectionResults: SectionResult[] = [];
  const phase1Start = Date.now();
  await discoverTree(tree, rootPageId, discoveryMap, pageIdMap, "  ", folderMap, "", sectionResults);
  const phase1Ms = Date.now() - phase1Start;
  if (!VERBOSE && IS_TTY) clearProgress();
  console.log(`  ${clr.ok(sym.ok)} ${discoveryMap.size} pages mapped\n`);

  // Phase 2 — write content with cross-file Notion links resolved
  console.log(`${clr.phase("Phase 2:")} writing content...`);
  const results: SyncResult[] = [];
  const total = allToSync.length;
  const counter = { n: 0, total };
  const recentStatuses: SyncStatus[] = [];
  let aborted = false;

  const phase2Start = Date.now();
  for (const relPath of allToSync) {
    counter.n++;
    const discovery = discoveryMap.get(relPath);
    if (!discovery) {
      if (!VERBOSE && IS_TTY) renderProgress(counter.n, total, relPath, "error");
      const r: SyncResult = {
        path: relPath,
        title: relPath,
        status: "error",
        error: "Page discovery failed in phase 1",
      };
      results.push(r);
      recentStatuses.push("error");
      if (recentStatuses.length > ABORT_WINDOW) recentStatuses.shift();
      continue;
    }

    if (!VERBOSE && IS_TTY) renderProgress(counter.n, total, relPath);
    const r = await writeFileContent(relPath, discovery, pageIdMap, counter);
    results.push(r);
    recentStatuses.push(r.status);
    if (recentStatuses.length > ABORT_WINDOW) recentStatuses.shift();

    if (ABORT_ENABLED) {
      const recentErrors = recentStatuses.filter((s) => s === "error").length;
      if (recentErrors >= ABORT_ERRORS) {
        if (!VERBOSE && IS_TTY) process.stdout.write("\n");
        console.error(
          clr.err(
            `\n${sym.err} Aborting — ${recentErrors} failures in last ${recentStatuses.length} items. Likely a systemic issue (token, network, WAF block).`,
          ),
        );
        aborted = true;
        break;
      }
    }
  }
  if (!VERBOSE && IS_TTY) clearProgress();
  const phase2Ms = Date.now() - phase2Start;

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
    console.error(`\n${clr.err(`${sym.err} ${errors.length} failed:`)}`);
    for (const e of errors) {
      const suspicionNote =
        e.suspicions && e.suspicions.length > 0
          ? clr.warn(` [${e.suspicions.map((s) => s.name).join(", ")}]`)
          : "";
      console.error(clr.err(`  ${sym.dot} ${e.path}`) + suspicionNote);
    }

    // Retry command — use path basename as --only filter (matches shouldSync logic)
    const retryArgs = errors
      .map((e) => path.basename(e.path, ".md"))
      .join(" ");
    console.error(
      `\n${clr.dim("Retry failed files:")}  bash sync.sh --only ${retryArgs}`,
    );
  }

  if (aborted) {
    const notRun = allToSync.slice(results.length);
    if (notRun.length > 0) {
      const skippedArgs = notRun.map((p) => path.basename(p, ".md")).join(" ");
      console.error(
        clr.warn(
          `\n${sym.warn} ${notRun.length} file(s) not reached due to abort:`,
        ),
      );
      for (const p of notRun) console.error(clr.warn(`  ${sym.dot} ${p}`));
      console.error(
        `\n${clr.dim("Retry skipped files:")}  bash sync.sh --only ${skippedArgs}`,
      );
    }
  }

  const runConfig: RunConfig = {
    root_page_id: rootPageId,
    root_notion_url: notionUrl(rootPageId),
    docs_dir: DOCS_DIR,
    link_mode: LINK_MODE,
    github_repo: GITHUB_REPO,
    github_branch: GITHUB_BRANCH,
    github_docs_root: GITHUB_DOCS_ROOT,
    github_docs_path: GITHUB_DOCS_PATH,
    show_meta: SHOW_META,
    folder_icon: FOLDER_ICON,
    default_page_icon: DEFAULT_ICON,
    sync_map_file: SYNC_MAP_FILE,
    rate_limit_ms: RATE_LIMIT_MS,
    abort_window: ABORT_WINDOW,
    abort_errors: ABORT_ERRORS,
  };

  const logEntry: RunLogEntry = {
    run_id: makeRunId(runStartDate),
    version: SCRIPT_VERSION,
    ts: runStart,
    dry_run: DRY_RUN,
    filter: onlyPaths.length > 0 ? onlyPaths : null,
    config: runConfig,
    timing: {
      phase1_ms: phase1Ms,
      phase2_ms: phase2Ms,
      total_ms: phase1Ms + phase2Ms,
    },
    stats: {
      total: results.length,
      created: created.length,
      updated: updated.length,
      dry_run: dryRun.length,
      errors: errors.length,
      sections_written: sectionResults.filter((s) => s.content_written).length,
      aborted,
    },
    pages: results,
    sections: sectionResults,
    error_summary:
      errors.length > 0
        ? errors.map((e) => ({
            path: e.path,
            error: e.error ?? "",
            suspicions: (e.suspicions ?? []).map((s) => s.name),
          }))
        : null,
  };

  appendRunLog(logEntry);
  console.log(
    clr.dim(`\nRun logged → ${path.relative(process.cwd(), LOG_FILE)}`),
  );

  if (!DRY_RUN) {
    buildAndWriteMetrics(makeRunId(runStartDate), runStart, {
      phase1_ms: phase1Ms,
      phase2_ms: phase2Ms,
      total_ms: phase1Ms + phase2Ms,
    });
  }

  if (errors.length > 0) process.exit(1);
}

main().catch((err: Error) => {
  console.error(clr.err(`\n${sym.err} Unexpected fatal error: ${err.message}`));
  if (err.stack) console.error(clr.dim(err.stack));
  process.exit(1);
});
