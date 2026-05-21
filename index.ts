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

import { getNotion, extractPageId } from "./lib/notion";
import { createInterface } from "readline/promises";
import * as fs from "fs";
import * as path from "path";
import { ImageUploader, swapImageBlocks } from "./image-uploader";
import { convertPageLinksToMentions, buildPageIdSet } from "./mention-converter";
import {
  loadState,
  saveState,
  ensureBotId,
  checkDivergence,
  recordPageBaseline,
  formatDivergences,
  getStatePath,
  getCacheKey,
  type SyncStateFile,
  type Divergence,
  type GuardrailMode,
} from "./sync-state";

// ── Types ─────────────────────────────────────────────────────────────────────

type SyncStatus = "created" | "updated" | "dry_run" | "error" | "protected";
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
  parentId: string; // Notion id of immediate parent (section page or root). Used by guardrails.
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

interface SectionWriteItem {
  relDir: string;
  dirName: string;
  sectionTitle: string;
  sectionPageId: string;
  folderIndex: ParsedDoc | null;
  subTree: DocTree;
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
  protected_kinds?: Divergence["kind"][];
  protected_details?: string[];
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
  // Image upload pipeline stats. Only populated when NOTION_UPLOAD_IMAGES=1.
  // Written by index.ts at run-end from imageUploader.getStats(). Helpful for
  // tracking cache hit rate and orphan accumulation over time.
  image_stats?: {
    uploads: number;
    cache_hits: number;
    total_in_cache: number;
  } | null;
  // True if the run was killed mid-flight (SIGINT / uncaughtException) and
  // this entry was written by the partial-save handler. Stats reflect what
  // had completed at the moment of termination, not a finished run.
  partial?: boolean;
  partial_reason?: string;
  pages: SyncResult[];
  sections: SectionResult[];
  error_summary: { path: string; error: string; suspicions: string[] }[] | null;
  // Pages skipped because of overwrite-guardrail divergence (NOTION_GUARDRAILS=strict).
  // Always present (may be empty array). Surfaced by /sync-all and the
  // reconcile flow. Schema v2 (2026-05-06): `kinds` is an array — a single
  // page can have multiple simultaneous divergences (e.g. moved + edited).
  protected_pages: { path: string; kinds: string[]; details: string[]; notion_url: string }[];
  guardrails_mode: GuardrailMode;
}

// Live snapshot of run progress, updated by main() at checkpoints. The SIGINT
// / uncaughtException handlers read this to write a `partial: true` entry to
// runs.jsonl when the process dies mid-flight. Set to null once a normal
// run completes so late signals don't double-write.
interface PartialSnapshot {
  runStartDate: Date;
  runStart: string;
  filter: string[] | null;
  configBuilder: () => RunConfig;
  results: SyncResult[];
  sectionResults: SectionResult[];
  phase1Ms: number;
  phase2Start: number | null; // null until Phase 2 begins
  aborted: { value: boolean };
}
let partialSnapshot: PartialSnapshot | null = null;

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

// When true, every image referenced in a doc gets uploaded to Notion's CDN and
// the image block is rewritten from external→file_upload after Phase 2 write.
// Required for private repos (raw.githubusercontent.com URLs 404 to Notion).
const UPLOAD_IMAGES = process.env.NOTION_UPLOAD_IMAGES === "1";
const IMAGE_CACHE_PATH = path.join(__dirname, ".notion-image-cache.json");

// When true, after Phase 2 writes a page's content via updateMarkdown, walk
// its blocks and convert internal-page hyperlinks (markdown `[text](notion-url)`)
// into native page mentions — inline pills with hover/peek + auto-updating
// titles, instead of the default "open in new tab" behaviour. Default ON since
// it strictly improves the reading experience for synced docs.
const USE_MENTIONS = process.env.NOTION_USE_MENTIONS !== "0";

// Per-doc "View source on GitHub" URL base. Each Notion page's breadcrumb
// gets a link to `${GITHUB_DOC_SOURCE_URL_BASE}/${relPath}`. Defaults to
// GITHUB_BLOB_BASE; an explicit env override lets you point to a different
// host/branch (e.g. always `main` for stable URLs even when syncing from
// `development`, or a self-hosted git mirror).
const GITHUB_DOC_SOURCE_URL_BASE =
  process.env.GITHUB_DOC_SOURCE_URL_BASE ?? GITHUB_BLOB_BASE;

// NOTION_FULL_WIDTH env var is intentionally unused: is_full_width is not
// settable via Notion's public REST API. Toggle full-width manually in Notion UI.
const SYNC_MAP_FILE = process.env.NOTION_SYNC_MAP ?? null;
const FOLDER_ICON = process.env.NOTION_FOLDER_ICON ?? null;
const SHOW_META = process.env.NOTION_SHOW_META !== "0"; // default on
const ABORT_POLICY_ENV = process.env.ABORT_POLICY ?? "disabled";
const ABORT_ENABLED = ABORT_POLICY_ENV !== "disabled";
const ABORT_ERRORS = parseInt(ABORT_POLICY_ENV) || 5;
const ABORT_WINDOW = 10;

// Overwrite guardrails — see OVERWRITE-GUARDRAILS-EXPLORATION.md.
// strict: skip and report any page where divergence is detected.
// warn  : print warnings but overwrite anyway (useful during initial rollout).
// off   : skip the check entirely (legacy behavior).
const GUARDRAILS_MODE: GuardrailMode = (() => {
  const raw = (process.env.NOTION_GUARDRAILS ?? "strict").toLowerCase();
  if (raw === "warn" || raw === "off") return raw;
  return "strict";
})();

const SCRIPT_VERSION = "1.3.0";
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
const forceOverwritePaths = new Set<string>();
const acceptMovePaths = new Set<string>();
const acceptArchivePaths = new Set<string>();
let argVerbose = false;
let argSeedState = false;
let argRefreshBotId = false;
let argGuardrailsOverride: GuardrailMode | null = null;

// Multi-value flags: --only / --force-overwrite / --accept-move / --accept-archive
// each consume subsequent positional args until the next "--flag".
type ListSink = "only" | "force" | "accept-move" | "accept-archive" | null;
let listSink: ListSink = null;
for (const arg of argv) {
  if (arg === "--only")             { listSink = "only";          continue; }
  if (arg === "--force-overwrite")  { listSink = "force";         continue; }
  if (arg === "--accept-move")      { listSink = "accept-move";   continue; }
  if (arg === "--accept-archive")   { listSink = "accept-archive";continue; }
  if (arg === "--verbose")          { argVerbose = true; listSink = null; continue; }
  if (arg === "--seed-state")       { argSeedState = true; listSink = null; continue; }
  if (arg === "--refresh-bot-id")   { argRefreshBotId = true; listSink = null; continue; }
  if (arg === "--guardrails") {
    listSink = null;
    // Value is the next arg — handle inline by consuming via index. Cheap
    // alternative: use --guardrails=strict syntax. Keep both forms working.
    continue;
  }
  if (arg.startsWith("--guardrails=")) {
    const v = arg.slice("--guardrails=".length).toLowerCase();
    if (v === "strict" || v === "warn" || v === "off") argGuardrailsOverride = v;
    listSink = null;
    continue;
  }
  if (arg.startsWith("--")) { listSink = null; continue; }
  if (listSink === "only")            onlyPaths.push(arg.replace(/\/$/, ""));
  else if (listSink === "force")      forceOverwritePaths.add(arg.replace(/\/$/, ""));
  else if (listSink === "accept-move") acceptMovePaths.add(arg.replace(/\/$/, ""));
  else if (listSink === "accept-archive") acceptArchivePaths.add(arg.replace(/\/$/, ""));
}

// Handle "--guardrails strict" (space-separated) form by post-walking argv.
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--guardrails" && i + 1 < argv.length) {
    const v = argv[i + 1].toLowerCase();
    if (v === "strict" || v === "warn" || v === "off") argGuardrailsOverride = v as GuardrailMode;
  }
}

const EFFECTIVE_GUARDRAILS: GuardrailMode = argGuardrailsOverride ?? GUARDRAILS_MODE;
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

// Adaptive linear backoff for the API rate limiter.
// Floor:   RATE_LIMIT_MS (default 350ms, ~2.85 req/s — safely under Notion's 3/s cap)
// Ceiling: RATE_LIMIT_MS * 3 (~1050ms, ~0.95 req/s — drops well below the cap)
// Step:    one third of the floor→ceiling span. Up on every failure, down after
//          3 consecutive successes. Linear (not exponential) so transient blips
//          don't slingshot the rate to the ceiling for a sustained run.
const RATE_LIMIT_FLOOR_MS = RATE_LIMIT_MS;
const RATE_LIMIT_CEILING_MS = RATE_LIMIT_MS * 3;
const RATE_LIMIT_STEP_MS = Math.round((RATE_LIMIT_CEILING_MS - RATE_LIMIT_FLOOR_MS) / 3);
let currentRateLimitMs = RATE_LIMIT_FLOOR_MS;
let consecutiveSuccesses = 0;

function reportApiSuccess(): void {
  consecutiveSuccesses++;
  if (consecutiveSuccesses >= 3 && currentRateLimitMs > RATE_LIMIT_FLOOR_MS) {
    currentRateLimitMs = Math.max(RATE_LIMIT_FLOOR_MS, currentRateLimitMs - RATE_LIMIT_STEP_MS);
    consecutiveSuccesses = 0;
  }
}
function reportApiFailure(): void {
  consecutiveSuccesses = 0;
  if (currentRateLimitMs < RATE_LIMIT_CEILING_MS) {
    currentRateLimitMs = Math.min(RATE_LIMIT_CEILING_MS, currentRateLimitMs + RATE_LIMIT_STEP_MS);
  }
}

async function apiCall<T>(fn: () => Promise<T>, label = "api"): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    const fn_ms = Date.now() - t0;
    await sleep(currentRateLimitMs);
    runMetrics.apiCalls.push({ op: label, fn_ms, total_ms: fn_ms + currentRateLimitMs });
    reportApiSuccess();
    return result;
  } catch (err) {
    reportApiFailure();
    throw err;
  }
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
  let meta: Record<string, string> = {};
  let body = content;
  if (match) {
    body = content.slice(match[0].length);
    for (const line of match[1].split(/\r?\n/)) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  // Strip HTML comments — they leak verbatim into Notion as raw text since
  // Notion's markdown renderer doesn't strip them. Tooling annotations like
  // `<!-- sessions: ... -->` and `<!-- sherpa: daily-... -->` are common.
  // Multi-line comments are handled by the [\s\S]*? greedy match.
  body = body.replace(/<!--[\s\S]*?-->\s*\n?/g, "");
  return { meta, body };
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
function buildMetaBanner(meta: Record<string, string>, body?: string): string {
  const parts: string[] = [];
  if (meta.status) {
    const emoji = STATUS_EMOJI[meta.status.toLowerCase()] ?? "🏷";
    parts.push(`${emoji} **${meta.status}**`);
  }
  if (meta.audience) parts.push(`audience: ${meta.audience}`);
  if (meta.last_updated) parts.push(`updated: ${meta.last_updated}`);
  if (parts.length === 0 && !body) return "";
  // Tags line — surfaced separately so each tag is full-text-searchable in
  // Notion. Pulled from frontmatter `tags:` AND any existing body convention
  // `**Tags:** `a`, `b`, `c``. Sourced via extractTags so both forms merge.
  const tags = extractTags(meta, body ?? "");
  const lines: string[] = [];
  if (parts.length > 0) lines.push(`> ${parts.join(" · ")}`);
  if (tags.length > 0) {
    const tagText = tags.map((t) => `\`#${t}\``).join(" ");
    lines.push(`> Tags: ${tagText}`);
  }
  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n\n`;
}

// Pull tags from a doc — supports both the YAML frontmatter convention
// (`tags: [a, b]` or `tags: a, b`) and the existing body convention used
// in many user docs (`**Tags:** `a`, `b`, `c``). Lower-cases all tags
// and dedupes across sources.
export function extractTags(meta: Record<string, string>, body: string): string[] {
  const out = new Set<string>();
  const ftRaw = meta.tags ?? meta.tag;
  if (ftRaw) {
    const cleaned = ftRaw.replace(/^\[|\]$/g, "").replace(/[`]/g, "");
    for (const t of cleaned.split(",")) {
      const trimmed = t.trim().replace(/^["']|["']$/g, "");
      if (trimmed && trimmed.length < 40) out.add(trimmed.toLowerCase());
    }
  }
  // Body convention: line starting with `**Tags:**` (case-insensitive),
  // tags as backticked tokens. Skip if the file has no such line.
  const bodyMatch = body.match(/^\*\*Tags?:?\*\*[:\s]*(.+?)$/im);
  if (bodyMatch) {
    for (const m of bodyMatch[1].matchAll(/`([^`]+)`/g)) {
      const t = m[1].trim().toLowerCase();
      if (t && t.length < 40) out.add(t);
    }
  }
  return Array.from(out).sort();
}

/**
 * Builds a breadcrumb line showing the doc's position in the folder tree.
 * Each segment links to its section page if available in pageIdMap.
 * If GITHUB_DOC_SOURCE_URL_BASE is configured, appends a "View source"
 * link to the original markdown file on GitHub for editing.
 * Only used in Phase 2 when pageIdMap is fully populated.
 */
function buildBreadcrumb(relPath: string, pageIdMap: Map<string, string>): string {
  const dir = path.dirname(relPath);
  const parts = dir === "." || dir === "" ? [] : dir.split("/");
  const crumbs = parts.map((part, i) => {
    const dirPath = parts.slice(0, i + 1).join("/");
    const id = pageIdMap.get(`${dirPath}/_index.md`);
    const label = part.replace(/-/g, " ");
    return id ? `[${label}](${notionUrl(id)})` : label;
  });
  const sourceLink = GITHUB_DOC_SOURCE_URL_BASE
    ? `[📝 source](${GITHUB_DOC_SOURCE_URL_BASE}/${relPath})`
    : "";
  if (crumbs.length === 0 && !sourceLink) return "";
  const left = crumbs.length > 0 ? `📍 ${crumbs.join(" / ")}` : "";
  const right = sourceLink;
  const sep = left && right ? "  ·  " : "";
  return `> ${left}${sep}${right}\n\n`;
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

// Local-time HH:MM:SS for live watch — preferred over UTC for verbose discovery logs.
function fmtTimeLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtElapsed(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// Verbose-gated log — suppressed in progress-bar mode to avoid corrupting bar
function vlog(...args: Parameters<typeof console.log>): void {
  if (VERBOSE) console.log(...args);
}

// Verbose Phase 1 discovery log entry. One unified format for both leaf docs
// and section pages so every entry shows: index, time, status badge, Notion URL,
// and the local source path on the next line. localPath is shown relative to
// DOCS_DIR for readability (matches what the user types in `--only`).
function logDiscovered(opts: {
  indent: string;
  index: number;
  total: number;
  isNew: boolean;
  notionId: string;
  localPath: string;          // relative to DOCS_DIR, or directory marker
  isSection?: boolean;
  isAutoIndex?: boolean;
}): void {
  if (!VERBOSE) return;
  const { indent, index, total, isNew, notionId, localPath, isSection, isAutoIndex } = opts;
  const idx = clr.gray(`[${String(index).padStart(String(total).length, "0")}/${total}]`);
  const time = clr.dim(fmtTimeLocal(new Date()));
  const badge = isNew ? clr.ok(`${sym.new} CREATED`) : clr.dim("EXISTS");
  const kind = isSection ? clr.dim(isAutoIndex ? "[section/auto]" : "[section]") : clr.dim("[doc]");
  console.log(`${indent}${idx} ${time}  ${badge}  ${kind}  ${clr.url(notionUrl(notionId))}`);
  console.log(`${indent}${" ".repeat(String(total).length * 2 + 3)} ${clr.dim(`↳ ${localPath}`)}`);
}

// ── Pulsing spinner ───────────────────────────────────────────────────────────
// Drop-in animation patterns for CLI tools. Reference template at
// ~/.claude/code/templates/spinner-demo.ts. Two styles:
//   • "braille" — spinning ⠋⠙⠹… for active work (Phase 2 progress line)
//   • "pulse"   — single ● fading in/out for waiting (Phase 1.5 between API calls)
// Both use time-based animation (Date.now() not frame index) so timing stays
// consistent even if a frame is dropped during a slow API call.

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPIN_PERIOD_MS = 1200;
const PULSE_PERIOD_MS = 1400;
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

// sin(πt)^1.4 powered curve gives sharp peak + held dim — Claude Code feel
function pulse01(elapsedMs: number, periodMs: number): number {
  const t = (elapsedMs % periodMs) / periodMs;
  const sine = Math.sin(t * Math.PI);
  // 0.35 baseline keeps the dim phase visible on dark terminals (grey ~240
  // instead of nearly-invisible 236). Peak still hits grey 255 (white).
  return 0.35 + 0.65 * Math.pow(sine, 1.4);
}
function brightnessGrey(b: number): number {
  return 232 + Math.round(Math.max(0, Math.min(1, b)) * 23);
}
function spinChar(elapsedMs: number): string {
  const idx = Math.floor((elapsedMs / SPIN_PERIOD_MS) * BRAILLE_FRAMES.length) % BRAILLE_FRAMES.length;
  return BRAILLE_FRAMES[idx];
}
function ansiGrey(n: number, s: string): string {
  return `\x1b[38;5;${n}m${s}\x1b[0m`;
}

// Active progress state — single-source-of-truth read by the tick loop.
// Setting `mode = "off"` stops rendering on the next tick.
type ProgressState =
  | { mode: "off" }
  | { mode: "bar"; n: number; total: number; file: string; status?: string; start: number }
  | { mode: "pulse"; label: string; n?: number; total?: number; start: number };

const progressState: { current: ProgressState } = { current: { mode: "off" } };
let progressTimer: ReturnType<typeof setInterval> | null = null;
let cursorHidden = false;

const BAR_WIDTH = 28;

function renderTick(): void {
  const s = progressState.current;
  if (s.mode === "off") return;
  const elapsed = Date.now() - s.start;
  const fg = brightnessGrey(pulse01(elapsed, PULSE_PERIOD_MS));

  if (s.mode === "bar") {
    const filled = Math.round((s.n / s.total) * BAR_WIDTH);
    const bar = paint(A.G, "█".repeat(filled)) + paint(A.d, "░".repeat(BAR_WIDTH - filled));
    const pct = String(Math.floor((s.n / s.total) * 100)).padStart(3);
    const label = s.file.length > 42 ? `…${s.file.slice(-41)}` : s.file.padEnd(42);
    const spinner = s.status === "error" ? paint(A.R, sym.err) : ansiGrey(fg, spinChar(elapsed));
    process.stdout.write(`\r  [${bar}] ${clr.bold(`${s.n}/${s.total}`)} ${pct}%  ${spinner} ${clr.dim(label)}`);
  } else {
    const dot = ansiGrey(fg, "●");
    const counter = s.n != null && s.total != null ? `[${s.n}/${s.total}] ` : "";
    process.stdout.write(`\r  ${dot}  ${counter}${clr.dim(s.label)}${" ".repeat(8)}`);
  }
}

function startProgressTicker(): void {
  if (progressTimer) return;
  if (!cursorHidden) {
    process.stdout.write(HIDE_CURSOR);
    cursorHidden = true;
  }
  progressTimer = setInterval(renderTick, 50); // 20 fps
}
function stopProgressTicker(): void {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function renderProgress(n: number, total: number, file: string, status?: string): void {
  const prev = progressState.current;
  const start = prev.mode === "bar" ? prev.start : Date.now();
  progressState.current = { mode: "bar", n, total, file, status, start };
  startProgressTicker();
  renderTick();
}
function setPulseLabel(label: string, n?: number, total?: number): void {
  const prev = progressState.current;
  const start = prev.mode === "pulse" ? prev.start : Date.now();
  progressState.current = { mode: "pulse", label, n, total, start };
  startProgressTicker();
  renderTick();
}
function clearProgress(): void {
  progressState.current = { mode: "off" };
  stopProgressTicker();
  process.stdout.write("\r" + " ".repeat(100) + "\r");
  if (cursorHidden) {
    process.stdout.write(SHOW_CURSOR);
    cursorHidden = false;
  }
}

// Wrap console.warn so warnings printed during an active progress line erase
// the line first (so the warning lands on its own row), then the next tick
// redraws the progress beneath it. Without this, warnings tear the bar apart.
const origConsoleWarn = console.warn.bind(console);
console.warn = (...args: any[]): void => {
  if (progressState.current.mode !== "off") {
    process.stdout.write("\r" + " ".repeat(100) + "\r");
  }
  origConsoleWarn(...args);
};
const origConsoleError = console.error.bind(console);
console.error = (...args: any[]): void => {
  if (progressState.current.mode !== "off") {
    process.stdout.write("\r" + " ".repeat(100) + "\r");
  }
  origConsoleError(...args);
};

// Restore cursor on process exit (Ctrl-C, normal exit) so we don't leave
// the terminal in hide-cursor mode if the script crashes mid-spin.
process.on("exit", () => {
  if (cursorHidden) process.stdout.write(SHOW_CURSOR);
});
process.on("SIGINT", () => {
  clearProgress();
  process.exit(130);
});

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
      // Treat as an internal doc/section link if:
      //   - it looks like a markdown file (.md)
      //   - it ends with `/` (directory link to section page)
      //   - it's empty (anchor-only on the same page handled above already)
      //   - OR it has no extension and looks relative (bare `[X](dir)` or
      //     `[X](dir/sibling)` — common in hand-written markdown). The bare
      //     case is identified by a leading `./` / `../` / no protocol AND no
      //     dot in the basename (so we don't grab `[X](https://example.com)`
      //     — those already returned above — or `[X](image.png)`).
      const looksLikeInternalLink =
        urlPath.endsWith(".md") ||
        urlPath.endsWith("/") ||
        urlPath === "" ||
        (urlPath.length > 0 && !path.extname(urlPath));
      if (looksLikeInternalLink) {
        const resolved = path
          .normalize(path.join(dir, urlPath || "."))
          .replace(/\\/g, "/");
        if (resolved.startsWith("..")) return text;
        if (LINK_MODE === "notion") {
          // Try (in order): exact, .md-stripped, .md-appended, _index.md fallback.
          // The _index.md fallback handles directory-style links (`dir/`, `dir`)
          // pointing at section pages registered as `dir/_index.md`.
          const noTrailSlash = resolved.replace(/\/$/, "");
          const candidateKeys = [
            resolved,
            resolved.replace(/\.md$/, ""),
            resolved + ".md",
            `${noTrailSlash}/_index.md`,
          ];
          let pid: string | undefined;
          let matchedKey: string | undefined;
          for (const k of candidateKeys) {
            const p = pageIdMap.get(k);
            if (p) {
              pid = p;
              matchedKey = k;
              break;
            }
          }
          if (pid) {
            // If the anchor text contains `.md`, Notion's markdown parser
            // hijacks the link URL — it sees `.md` in the text and overrides
            // the explicit href with `http://<text>/` (the Moldova TLD). The
            // mention-converter then can't recognize the mangled URL as
            // internal and leaves the link plain.
            //
            // Fix: substitute the linked doc's title for the anchor text
            // whenever the original text contains `.md`. The result reads
            // better anyway (real titles vs. raw filenames), and matches
            // what mention conversion would substitute server-side.
            //
            // Resolve title from the canonical doc (the .md key — for
            // section/directory matches, fall back to a humanized dir name).
            let finalText = text;
            if (/\.md\b/i.test(text)) {
              const docKey = matchedKey!.endsWith(".md") ? matchedKey! : matchedKey + ".md";
              const linked = getDoc(docKey);
              if (linked?.title) {
                finalText = linked.title;
              } else {
                // Last-resort: humanize the basename without extension.
                const base = path.basename(matchedKey!.replace(/\/_index\.md$/, "").replace(/\.md$/, ""));
                finalText = base.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
              }
            }
            return `[${finalText}](${notionUrl(pid)}${anchor ? "#" + anchor : ""})`;
          }
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

const notion = getNotion();

const imageUploader: ImageUploader | null = UPLOAD_IMAGES
  ? new ImageUploader(notion, IMAGE_CACHE_PATH, RATE_LIMIT_MS)
  : null;
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

// v1.2 rename-safety: built lazily at preflight from .notion-cache.json.
// Maps page title → its current Notion page id, but ONLY for titles that
// appear exactly once in the cache. When a local doc moves to a new
// parent, getOrCreateChildPage uses this to MOVE the existing page
// (preserving its id and inbound mentions) instead of creating a fresh
// one and orphaning the old. Skipping titles with multiple occurrences
// is intentional — moving the wrong "Modal" page would be much worse
// than creating a duplicate.
interface GlobalTitleEntry { id: string; parent_id: string | null }
let globalTitleIndex: Map<string, GlobalTitleEntry> | null = null;

function loadGlobalTitleIndex(): Map<string, GlobalTitleEntry> | null {
  // Cache is root-keyed (`.notion-cache.<key>.json`) since 2026-05-21. Read
  // the keyed path; fall back to the legacy unkeyed name only if the keyed
  // one doesn't exist yet (pre-migration). Without this, move-detection
  // silently goes dark after `list.sh fetch` renames the legacy file —
  // exactly the duplicate/orphan failure class RCA-ARCHIVED-PAGES.md covers.
  const keyedPath = path.join(__dirname, `.notion-cache.${getCacheKey()}.json`);
  const legacyPath = path.join(__dirname, ".notion-cache.json");
  const usingLegacy = !fs.existsSync(keyedPath);
  const cachePath = usingLegacy ? legacyPath : keyedPath;
  if (!fs.existsSync(cachePath)) return null;
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    // The keyed filename encodes the root, so a keyed cache is trusted. The
    // unkeyed legacy file does NOT — it may belong to a previously-synced
    // root if the user switched NOTION_ROOT_PAGE_ID. Running move-detection
    // against another workspace's ids is the exact orphan/duplicate hazard
    // RCA-ARCHIVED-PAGES.md warns about, so verify root_id before trusting it.
    if (usingLegacy && cache.root_id) {
      const norm = (s: string) => (s ?? "").replace(/-/g, "").toLowerCase();
      const wantKey = getCacheKey();
      if (!norm(cache.root_id).startsWith(wantKey)) {
        return null; // legacy cache is for a different root — skip move-detection
      }
    }
    const seen = new Map<string, GlobalTitleEntry | "duplicate">();
    for (const p of cache.pages ?? []) {
      if (!p.title || !p.id) continue;
      const existing = seen.get(p.title);
      if (existing === undefined) {
        seen.set(p.title, { id: p.id, parent_id: p.parent_id ?? null });
      } else {
        seen.set(p.title, "duplicate");
      }
    }
    const out = new Map<string, GlobalTitleEntry>();
    for (const [title, entry] of seen) {
      if (entry !== "duplicate") out.set(title, entry as GlobalTitleEntry);
    }
    return out;
  } catch {
    return null;
  }
}

async function getOrCreateChildPage(
  parentId: string,
  title: string,
  icon?: NotionIcon,
  knownPageId?: string,        // from .notion-sync-state.json — strongest lookup signal
): Promise<{ id: string; isNew: boolean }> {
  if (DRY_RUN) return { id: `dry-run-${Date.now()}`, isNew: false };

  // Strongest signal: id from the persistent state file. Survives renames in
  // Notion (which break title lookup) and is cheaper than listing children.
  // Fall through to title-based lookup if the id is archived/missing.
  if (knownPageId) {
    try {
      const meta: any = await apiCall(
        () => notion.pages.retrieve({ page_id: knownPageId }),
        "pages.retrieve",
      );
      const isTrashed = meta.in_trash === true || meta.archived === true;
      if (!isTrashed) {
        // If parent drifted, re-parent (the divergence check would have flagged
        // this earlier in strict mode; reaching here means the user passed
        // --accept-move OR is in warn/off mode).
        if (meta.parent?.page_id && meta.parent.page_id !== parentId) {
          await apiCall(
            () => (notion.pages as any).update({
              page_id: knownPageId,
              parent: { page_id: parentId, type: "page_id" },
            }),
            "pages.move",
          );
        }
        return { id: knownPageId, isNew: false };
      }
      // archived — fall through to title lookup / create
    } catch {
      // page deleted from Notion entirely — fall through
    }
  }

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

  // v1.2 rename-safety: before creating a new page, check whether a page
  // with this exact title exists ELSEWHERE in the cached tree. If so,
  // and the title is unique (only one match in the whole cache), assume
  // the doc was moved and migrate the existing page to this new parent
  // — preserves the page id and all inbound mentions.
  if (globalTitleIndex) {
    const moved = globalTitleIndex.get(title);
    if (moved && moved.id !== parentId) {
      // Verify the page is still alive (not in trash) before moving.
      try {
        const meta: any = await apiCall(
          () => notion.pages.retrieve({ page_id: moved.id }),
          "pages.retrieve",
        );
        if (!(meta.in_trash || meta.archived)) {
          // Found a live page with our title under a different parent.
          // Move it. notion.pages.update accepts {parent:{page_id}}.
          await apiCall(
            () => (notion.pages as any).update({
              page_id: moved.id,
              parent: { page_id: parentId, type: "page_id" },
            }),
            "pages.move",
          );
          // Don't mark as new — the page existed before and inbound
          // mentions still resolve to it. Caller treats this like a
          // matched-existing case.
          console.log(clr.dim(`    ↪ moved "${title}" to new parent (${moved.id.slice(0, 8)}…)`));
          children.push({ id: moved.id, title });
          // Remove from globalTitleIndex so subsequent lookups don't
          // try to move the same page again on retries / re-runs.
          globalTitleIndex.delete(title);
          return { id: moved.id, isNew: false };
        }
      } catch {
        // Stale cache entry — page no longer exists. Fall through to create.
      }
    }
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
  title?: string,
): Promise<void> {
  if (!icon && !cover && !title) return;
  await apiCall(() =>
    notion.pages.update({
      page_id: pageId,
      ...(icon ? { icon: icon as any } : {}),
      ...(cover ? { cover: cover as any } : {}),
      // v1.2 rename-safety: keep the Notion page title in sync with the
      // current doc H1. Without this, an H1 change orphans the previous
      // page (title-based discovery would create a fresh page next time).
      ...(title ? { properties: { title: { title: [{ text: { content: title } }] } } } : {}),
    } as any),
    "pages.update",
  );
}

// ── Preflight ─────────────────────────────────────────────────────────────────

async function preflight(): Promise<string> {
  // v1.2 rename-safety: load the global title→pageId index from the
  // .notion-cache.json before Phase 1 starts. If the cache is missing
  // or stale, move-detection silently falls back to the create-fresh
  // path (existing v1.1 behaviour). User can `bash list.sh fetch`
  // to refresh the cache before a sync if they expect renames/moves.
  globalTitleIndex = loadGlobalTitleIndex();
  if (globalTitleIndex && globalTitleIndex.size > 0) {
    console.log(clr.dim(`  Loaded ${globalTitleIndex.size} unique-title entries from the Notion cache (move-detection enabled)`));
  }

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
    // extractPageId handles bare id / dashed UUID / "Slug-<id>" / URL ± query.
    // The old end-anchored regex aborted the whole sync on a URL with a
    // trailing `?pvs=4` (no match → "malformed" → abort).
    const extracted = extractPageId(ROOT_PAGE_ID);
    if (extracted) {
      resolvedPageId = extracted;
      if (ROOT_PAGE_ID !== resolvedPageId)
        console.log(
          clr.dim(
            `  Note: extracted page ID "${resolvedPageId}" from "${ROOT_PAGE_ID}"`,
          ),
        );
    } else {
      problems.push(
        `NOTION_ROOT_PAGE_ID looks malformed — expected a 32-hex page id, got: "${ROOT_PAGE_ID}"`,
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
      // Keep the dir if it has any syncable content OR a local _index.md.
      // Without the _index.md check, folders that contain ONLY an _index.md
      // get silently dropped here (since EXCLUDE_PATTERNS filters _index.md
      // out of `sub.files`), so discoverTree never sees them and the section
      // page never gets created — this is what stranded `boring-technical-stuff/
      // observability/`, `flows/`, etc. on past full syncs.
      const hasIndex = fs.existsSync(path.join(absDir, entry.name, "_index.md"));
      if (sub.files.length > 0 || sub.subdirs.size > 0 || hasIndex)
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
  sectionWriteQueue: SectionWriteItem[] = [],
  discoveryCounter: { n: number; total: number } = { n: 0, total: 0 },
  syncState?: SyncStateFile,       // sync-state for id-based lookup (rename-safety)
): Promise<void> {
  // Files directly in this dir go under parentPageId
  for (const relPath of tree.files) {
    if (!shouldSync(relPath)) continue;
    const doc = getDoc(relPath);
    if (!doc) continue;
    try {
      const knownPageId = syncState?.pages[relPath]?.page_id;
      const { id, isNew } = await getOrCreateChildPage(
        parentPageId,
        doc.title,
        doc.icon,
        knownPageId,
      );
      discoveryMap.set(relPath, { id, isNew, parentId: parentPageId });
      pageIdMap.set(relPath, id);
      discoveryCounter.n++;
      logDiscovered({
        indent,
        index: discoveryCounter.n,
        total: discoveryCounter.total,
        isNew,
        notionId: id,
        localPath: relPath,
      });
    } catch (err: any) {
      console.error(
        `${indent}${clr.err(sym.err)} Discovery failed for "${relPath}": ${err.message as string}`,
      );
    }
  }

  // Each subdir becomes a section page; recurse into it
  for (const [dirName, subTree] of tree.subdirs) {
    const childRelDir = relDir ? `${relDir}/${dirName}` : dirName;
    const indexRelPath = `${childRelDir}/_index.md`;
    // Skip the dir entirely only if it has neither syncable leaf files nor an
    // _index.md that passes the filter. An _index.md alone is enough to justify
    // a section page (e.g. "boring-technical-stuff/observability" exists only
    // to host an index doc and be linked-to from sibling _index.md files).
    // shouldSync is applied to indexRelPath so the filter (--only) still bounds
    // the walk — without this gate, --only would discover the full tree.
    const hasSyncableFiles = collectFiles(subTree).filter(shouldSync).length > 0;
    const hasIndex = !!getFolderIndex(childRelDir) && shouldSync(indexRelPath);
    if (!hasSyncableFiles && !hasIndex) continue;

    // Folder map: if this top-level dir has an explicit Notion root, skip
    // creating a section page and root the subtree directly under that page.
    const mappedRootId = folderMap?.get(dirName);
    if (mappedRootId) {
      vlog(`${indent}${clr.section(dirName)} ${sym.arr} ${clr.dim("[mapped]")}  ${clr.url(notionUrl(mappedRootId))}`);
      // Don't pass folderMap recursively — mapping only applies at top level
      await discoverTree(subTree, mappedRootId, discoveryMap, pageIdMap, indent + "  ", undefined, childRelDir, sectionResults, sectionWriteQueue, discoveryCounter, syncState);
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
        discoveryCounter.n++;
        const sectionLocalPath = folderIndex
          ? `${childRelDir}/_index.md`
          : `${childRelDir}/  (auto-indexed)`;
        logDiscovered({
          indent: indent + "  ",
          index: discoveryCounter.n,
          total: discoveryCounter.total,
          isNew,
          notionId: id,
          localPath: sectionLocalPath,
          isSection: true,
          isAutoIndex: !folderIndex,
        });
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

    // Defer section content write to Phase 1.5 — there it runs after pageIdMap
    // is fully populated (so links to child pages resolve to Notion URLs) and
    // uses a non-destructive block-level write that preserves child_page blocks.
    sectionWriteQueue.push({ relDir: childRelDir, dirName, sectionTitle, sectionPageId, folderIndex, subTree });
    discoveryMap.set(indexRelPath, { id: sectionPageId, isNew: false, parentId: parentPageId });

    await discoverTree(subTree, sectionPageId, discoveryMap, pageIdMap, indent + "  ", undefined, childRelDir, sectionResults, sectionWriteQueue, discoveryCounter, syncState);
  }
}

// ── Phase 1.5: section content writes (non-destructive) ───────────────────────

/**
 * Re-write section page content without deleting child_page blocks.
 * Notion's `replace_content` (allow_deleting_content: true) wipes EVERY block
 * including subpages; using it on a section that already has children deletes
 * those children. So we instead:
 *   1. List the section's current blocks
 *   2. Delete only non-child_page blocks (heading, paragraph, list items, etc.)
 *   3. Use `insert_content` (additive) to write the new markdown
 * The result: child_page navigation is preserved, and section markdown is
 * fully refreshed with resolved Notion URLs in `_index.md` cross-links.
 */
async function writeSectionContent(
  sectionPageId: string,
  newMarkdown: string,
): Promise<void> {
  // 1. List current blocks (paginate through all)
  const allBlocks: any[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await apiCall(
      () => notion.blocks.children.list({
        block_id: sectionPageId,
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
      "blocks.children.list",
    );
    allBlocks.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  // 2. Delete only non-child_page blocks
  for (const block of allBlocks) {
    if (block.type === "child_page") continue;
    await apiCall(
      () => notion.blocks.delete({ block_id: block.id }),
      "blocks.delete",
    );
  }

  // 3. Insert new content (no `after` → prepended, before any child_page blocks)
  await apiCall(
    () => (notion.pages as any).updateMarkdown({
      page_id: sectionPageId,
      type: "insert_content",
      insert_content: { content: newMarkdown },
    }),
    "pages.updateMarkdown.insert",
  );
}

// ── Phase 2: content writing ──────────────────────────────────────────────────

async function writeFileContent(
  relPath: string,
  discovery: PageDiscovery,
  pageIdMap: Map<string, string>,
  counter: { n: number; total: number },
  ourPageIds?: Set<string>, // pre-built set of our page IDs for mention-conversion (lazy by caller)
  protectedDivergences?: Divergence[] | null, // if non-empty + mode=strict, skip write
  syncState?: SyncStateFile,                  // for post-write baseline recording
  expectedParentId?: string,                  // recorded into the new baseline
): Promise<SyncResult> {
  const hasProtection = protectedDivergences && protectedDivergences.length > 0;
  // Strict-mode guardrail: skip write entirely, surface as a "protected" SyncResult
  // so the run summary + runs.jsonl record the skip without it counting as an error.
  if (hasProtection && EFFECTIVE_GUARDRAILS === "strict") {
    if (!VERBOSE && IS_TTY) renderProgress(counter.n, counter.total, relPath, "protected");
    if (VERBOSE) {
      console.log(`\n  ${clr.warn(`[${counter.n}/${counter.total}]`)} ${relPath}  ${clr.dim("(protected)")}`);
      for (const d of protectedDivergences!) console.log(`     ${clr.dim("Reason:")}  ${d.kind} — ${d.detail}`);
    }
    return {
      path: relPath,
      title: relPath,
      status: "protected",
      page_id: discovery.id,
      protected_kinds: protectedDivergences!.map((d) => d.kind),
      protected_details: protectedDivergences!.map((d) => d.detail),
    };
  }
  if (hasProtection && EFFECTIVE_GUARDRAILS === "warn") {
    if (VERBOSE) {
      for (const d of protectedDivergences!) console.log(`     ${clr.warn(`${sym.warn} guardrail (warn): ${d.kind} — ${d.detail}`)}`);
    }
  }
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
  const banner = SHOW_META ? buildMetaBanner(meta, body) : "";
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

  // Build URL→file_upload_id map by uploading each local image. The keys
  // mirror what `rewriteImages` produces for the same doc, so swapImageBlocks
  // can match Notion image blocks (created with type=external pointing at
  // those URLs) and switch them to type=file_upload after the markdown write.
  // Skipped if NOTION_UPLOAD_IMAGES is off — image blocks stay external.
  const urlToUploadId = new Map<string, string>();
  if (imageUploader && images.length > 0 && GITHUB_RAW_BASE) {
    for (const src of images) {
      if (src.startsWith("http://") || src.startsWith("https://")) continue;
      const dirOf = path.dirname(relPath);
      const resolved = path.normalize(path.join(dirOf, src)).replace(/\\/g, "/");
      const absLocal = path.join(DOCS_DIR, resolved);
      const githubRawUrl = `${GITHUB_RAW_BASE}/${resolved}`;
      try {
        const result = await imageUploader.uploadImage(absLocal);
        urlToUploadId.set(githubRawUrl, result.file_upload_id);
        if (VERBOSE) {
          const tag = result.was_cached ? clr.dim("[cached]") : clr.ok("[uploaded]");
          console.log(`     ${sym.img}  ${tag} ${path.basename(absLocal)}  ${clr.dim(`(${(result.size_bytes / 1024).toFixed(0)} KB)`)}`);
        }
      } catch (err: any) {
        // Don't abort the whole doc on image upload failure — log and proceed
        // with the external URL fallback (which 404s on private repos but at
        // least the markdown sync continues).
        console.error(`     ${clr.warn(`${sym.warn} image upload failed: ${path.basename(absLocal)} — ${(err.message as string).slice(0, 80)}`)}`);
      }
    }
  }

  const doWrite = async (): Promise<void> => {
    await sleep(currentRateLimitMs);
    await updatePageMeta(discovery.id, icon, cover, title);
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

    // Post-process: swap image blocks from type=external (broken on private
    // repos) to type=file_upload referencing our just-uploaded files.
    if (imageUploader && urlToUploadId.size > 0) {
      try {
        const swapped = await swapImageBlocks(notion, discovery.id, urlToUploadId, currentRateLimitMs);
        if (VERBOSE && swapped > 0) {
          console.log(`     ${sym.img}  ${clr.dim(`swapped ${swapped} image block${swapped === 1 ? "" : "s"} to file_upload`)}`);
        }
      } catch (err: any) {
        console.error(`     ${clr.warn(`${sym.warn} block swap failed: ${(err.message as string).slice(0, 80)}`)}`);
      }
    }

    // Post-process: convert internal-page hyperlinks to native page mentions
    // so they render as inline pills with hover-preview / side-peek navigation
    // instead of opening in a new browser tab. Idempotent — safe on re-syncs.
    if (USE_MENTIONS && ourPageIds && ourPageIds.size > 0) {
      try {
        const r = await convertPageLinksToMentions({
          notion,
          pageId: discovery.id,
          ourPageIds,
          rateLimitMs: currentRateLimitMs,
        });
        if (VERBOSE && r.links_converted > 0) {
          console.log(`     🔗  ${clr.dim(`converted ${r.links_converted} link${r.links_converted === 1 ? "" : "s"} → mention${r.links_converted === 1 ? "" : "s"} (${r.blocks_updated} block update${r.blocks_updated === 1 ? "" : "s"})`)}`);
        }
      } catch (err: any) {
        console.error(`     ${clr.warn(`${sym.warn} mention conversion failed: ${(err.message as string).slice(0, 80)}`)}`);
      }
    }

    const elapsed = Date.now() - t0;
    runMetrics.files.push({ path: relPath, status: action, elapsed_ms: elapsed, content_chars: withFooter.length });
    if (VERBOSE) {
      console.log(`     ${clr.dim("Notion:")}  ${clr.url(pageNotionUrl)}`);
      console.log(`     ${clr.dim("Status:")}  ${actionBadge}  ${clr.dim(fmtElapsed(elapsed))}`);
    }

    // Record baseline for the next run's divergence check. Notion's reported
    // last_edited_time is what we compare against (string equality), so we
    // must store the value Notion gives us, not our local clock. Failure here
    // is non-fatal — next run just treats this doc as un-baselined.
    if (syncState && expectedParentId && EFFECTIVE_GUARDRAILS !== "off") {
      // Snapshot = raw local file body (pre-transform). Gives reconcile a fair
      // BASE for 3-way diffs: BASE/LOCAL are both raw markdown, REMOTE is
      // normalized to raw markdown by the pull-pipeline transforms.
      await recordPageBaseline(notion, syncState, relPath, discovery.id, expectedParentId, body);
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

function writePartialRunLog(reason: string): void {
  if (!partialSnapshot) return;
  const snap = partialSnapshot;
  partialSnapshot = null; // disarm — never write twice
  try {
    const phase2Ms = snap.phase2Start ? Date.now() - snap.phase2Start : 0;
    const created = snap.results.filter((r) => r.status === "created");
    const updated = snap.results.filter((r) => r.status === "updated");
    const dryRun = snap.results.filter((r) => r.status === "dry_run");
    const errors = snap.results.filter((r) => r.status === "error");
    const partialEntry: RunLogEntry = {
      run_id: makeRunId(snap.runStartDate),
      version: SCRIPT_VERSION,
      ts: snap.runStart,
      dry_run: DRY_RUN,
      filter: snap.filter,
      config: snap.configBuilder(),
      timing: {
        phase1_ms: snap.phase1Ms,
        phase2_ms: phase2Ms,
        total_ms: snap.phase1Ms + phase2Ms,
      },
      stats: {
        total: snap.results.length,
        created: created.length,
        updated: updated.length,
        dry_run: dryRun.length,
        errors: errors.length,
        sections_written: snap.sectionResults.filter((s) => s.content_written).length,
        aborted: snap.aborted.value,
      },
      pages: snap.results,
      sections: snap.sectionResults,
      error_summary:
        errors.length > 0
          ? errors.map((e) => ({
              path: e.path,
              error: e.error ?? "",
              suspicions: (e.suspicions ?? []).map((s) => s.name),
            }))
          : null,
      image_stats: imageUploader ? imageUploader.getStats() : null,
      protected_pages: snap.results
        .filter((r) => r.status === "protected")
        .map((r) => ({
          path: r.path,
          kinds: r.protected_kinds ?? [],
          details: r.protected_details ?? [],
          notion_url: r.notion_url ?? "",
        })),
      guardrails_mode: EFFECTIVE_GUARDRAILS,
      partial: true,
      partial_reason: reason,
    };
    appendRunLog(partialEntry);
    console.error(
      clr.warn(`\n${sym.warn} Partial run logged (${reason}) — ${snap.results.length} files processed before exit.`),
    );
  } catch (err) {
    console.error(clr.err(`Failed to write partial run log: ${(err as Error).message}`));
  }
}

async function main(): Promise<void> {
  const runStartDate = new Date();
  const runStart = runStartDate.toISOString();

  // Arm partial-save handlers. The snapshot is mutated by main() at
  // checkpoints (post Phase 1, during Phase 2 loop). On SIGINT or an
  // uncaught exception, writePartialRunLog flushes whatever progress
  // exists so kill mid-sync still leaves a diagnosable trail.
  process.on("SIGINT", () => {
    writePartialRunLog("SIGINT");
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    writePartialRunLog("SIGTERM");
    process.exit(143);
  });
  process.on("uncaughtException", (err) => {
    writePartialRunLog(`uncaughtException: ${err.message.slice(0, 200)}`);
    console.error(clr.err(`\n${sym.err} Uncaught: ${err.message}`));
    if (err.stack) console.error(clr.dim(err.stack));
    process.exit(1);
  });

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

  // Sync-state — overwrite guardrails. Loaded once; mutated as Phase 2
  // succeeds; saved at end. Skipped entirely for dry-runs (no writes happen
  // so baselines wouldn't be valid anyway).
  const syncState: SyncStateFile = loadState();
  if (!DRY_RUN && EFFECTIVE_GUARDRAILS !== "off") {
    try {
      await ensureBotId(notion, syncState, argRefreshBotId);
      console.log(`${clr.dim("Guardrails:")} ${EFFECTIVE_GUARDRAILS}  ${clr.dim(`(bot: ${syncState.bot_id?.slice(0, 8)}…)`)}`);
    } catch (err: any) {
      console.error(clr.warn(`  ${sym.warn} could not fetch bot id: ${err.message}. Guardrails disabled for this run.`));
    }
  } else if (DRY_RUN) {
    console.log(`${clr.dim("Guardrails:")} ${clr.dim("(skipped — dry-run)")}`);
  } else {
    console.log(`${clr.dim("Guardrails:")} ${clr.dim("off")}`);
  }

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
  const sectionWriteQueue: SectionWriteItem[] = [];
  const phase1Start = Date.now();
  // Estimate total discovery entries (leaf docs that pass shouldSync + all
  // section dirs that have at least one syncable file). Used by logDiscovered
  // to render `[NN/TT]` index prefixes.
  const countSections = (t: DocTree, baseRelDir = ""): number => {
    let n = 0;
    for (const [dirName, sub] of t.subdirs) {
      const childRelDir = baseRelDir ? `${baseRelDir}/${dirName}` : dirName;
      const hasFiles = collectFiles(sub).filter(shouldSync).length > 0;
      const hasIndex = !!getFolderIndex(childRelDir) && shouldSync(`${childRelDir}/_index.md`);
      if (!hasFiles && !hasIndex) continue;
      n += 1 + countSections(sub, childRelDir);
    }
    return n;
  };
  const discoveryCounter = {
    n: 0,
    total: collectFiles(tree).filter(shouldSync).length + countSections(tree),
  };
  await discoverTree(tree, rootPageId, discoveryMap, pageIdMap, "  ", folderMap, "", sectionResults, sectionWriteQueue, discoveryCounter, syncState);
  const phase1Ms = Date.now() - phase1Start;
  if (!VERBOSE && IS_TTY) clearProgress();
  console.log(`  ${clr.ok(sym.ok)} ${discoveryMap.size} pages mapped\n`);

  // ── --seed-state short-circuit ──
  // Records baselines for every existing (not freshly-created) page WITHOUT
  // writing any content. Use after first install / after a guardrail upgrade
  // so the next real run has something to compare against.
  if (argSeedState) {
    if (DRY_RUN) {
      console.log(clr.warn(`  ${sym.warn} --seed-state has no effect under --dry-run. Re-run without --dry-run.`));
      process.exit(0);
    }
    if (EFFECTIVE_GUARDRAILS === "off") {
      console.log(clr.warn(`  ${sym.warn} --seed-state is a no-op when NOTION_GUARDRAILS=off. Set guardrails to strict or warn first.`));
      process.exit(0);
    }
    console.log(`${clr.phase("Seeding baselines:")} retrieving last_edited_time for ${discoveryMap.size} pages...`);
    let seeded = 0;
    let skipped = 0;
    for (const relPath of allToSync) {
      const discovery = discoveryMap.get(relPath);
      if (!discovery) continue;
      if (discovery.isNew) { skipped++; continue; } // freshly created — nothing to baseline yet
      const seedDoc = getDoc(relPath);
      await recordPageBaseline(notion, syncState, relPath, discovery.id, discovery.parentId, seedDoc?.body);
      seeded++;
      if (!VERBOSE && IS_TTY) renderProgress(seeded, allToSync.length, relPath, "seeding");
    }
    if (!VERBOSE && IS_TTY) clearProgress();
    saveState(syncState);
    console.log(`  ${clr.ok(sym.ok)} ${seeded} baseline(s) recorded${skipped > 0 ? clr.dim(`, ${skipped} new pages skipped`) : ""}`);
    console.log(clr.dim(`  State written → ${path.relative(process.cwd(), getStatePath())}`));
    process.exit(0);
  }

  // Arm the partial-save snapshot. After this point, SIGINT will flush a
  // `partial: true` runs.jsonl entry with whatever progress has accumulated.
  const abortedRef = { value: false };
  const partialResults: SyncResult[] = [];
  partialSnapshot = {
    runStartDate,
    runStart,
    filter: onlyPaths.length > 0 ? onlyPaths : null,
    configBuilder: () => ({
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
    }),
    results: partialResults,
    sectionResults,
    phase1Ms,
    phase2Start: null,
    aborted: abortedRef,
  };

  // Phase 1.5 — write section page content. Runs after full discovery so all
  // child page IDs are in pageIdMap (links resolve to Notion URLs). Uses a
  // non-destructive block-level write that preserves child_page subpage blocks.
  // Helper: write one section's content. Returns { ok, error?, title }. The main
  // loop calls this and pushes a SectionResult; a later retry pass calls it
  // again for any failures (max 3 attempts each).
  const writeOneSection = async (item: SectionWriteItem): Promise<{ ok: boolean; error?: string; title: string }> => {
    const { relDir, dirName, sectionPageId, folderIndex, subTree } = item;
    const indexRelPath = relDir ? `${relDir}/_index.md` : "_index.md";
    if (folderIndex) {
      try {
        const banner = SHOW_META ? buildMetaBanner(folderIndex.meta, folderIndex.body) : "";
        const rewritten = rewriteLinks(
          rewriteImages(banner + folderIndex.body, indexRelPath),
          indexRelPath,
          pageIdMap,
        );
        const indexSyncedAt = fmtTimestamp(new Date());
        const rewrittenWithFooter = `${rewritten}\n\n---\n\n*Synced: ${indexSyncedAt}*\n`;
        await updatePageMeta(sectionPageId, folderIndex.icon, folderIndex.cover, folderIndex.title);
        await writeSectionContent(sectionPageId, rewrittenWithFooter);
        return { ok: true, title: folderIndex.title };
      } catch (err: any) {
        return { ok: false, error: (err.message as string).slice(0, 200), title: folderIndex.title };
      }
    } else {
      try {
        const autoContent = buildAutoIndex(dirName, subTree, pageIdMap, relDir);
        const autoSyncedAt = fmtTimestamp(new Date());
        const autoContentWithFooter = `${autoContent}\n---\n\n*Synced: ${autoSyncedAt}*\n`;
        await writeSectionContent(sectionPageId, autoContentWithFooter);
        return { ok: true, title: item.sectionTitle };
      } catch (err: any) {
        return { ok: false, error: (err.message as string).slice(0, 200), title: item.sectionTitle };
      }
    }
  };

  if (!DRY_RUN && sectionWriteQueue.length > 0) {
    console.log(`${clr.phase("Phase 1.5:")} writing section pages (${sectionWriteQueue.length})...`);
    let sectionN = 0;
    for (const item of sectionWriteQueue) {
      sectionN++;
      const { relDir, sectionTitle, sectionPageId, folderIndex } = item;
      if (!VERBOSE && IS_TTY) setPulseLabel(relDir || "(root)", sectionN, sectionWriteQueue.length);
      const result = await writeOneSection(item);
      if (result.ok) {
        const tag = folderIndex ? "_index.md" : "auto-index";
        vlog(`  ${clr.dim(`${sym.ok} ${tag} written`)}  ${clr.dim(`(${result.title})`)}`);
      } else {
        const tag = folderIndex ? "_index.md" : "auto-index";
        console.error(`  ${clr.warn(`${sym.warn} ${tag} write failed (${relDir}): ${(result.error || "").slice(0, 80)}`)}`);
      }
      sectionResults.push({
        rel_dir: relDir,
        title: result.title || sectionTitle,
        page_id: sectionPageId,
        notion_url: notionUrl(sectionPageId),
        had_index_md: !!folderIndex,
        content_written: result.ok,
        ...(result.ok ? {} : { error: result.error }),
      });
    }
    if (!VERBOSE && IS_TTY) clearProgress();
    console.log(`  ${clr.ok(sym.ok)} ${sectionWriteQueue.length} section pages written\n`);

    // Phase 1.5 retry pass — up to 3 extra attempts per failed section.
    // Adaptive backoff (in apiCall) will already have widened the rate-limit
    // window from the failure that triggered the retry, giving each attempt
    // a calmer cadence. After 3 attempts a section stays marked failed and
    // the user can re-run with `--only <section>` to try again later.
    const failed = sectionResults
      .map((r, idx) => ({ r, idx }))
      .filter(({ r }) => r.content_written === false);
    if (failed.length > 0) {
      console.log(`${clr.phase("Phase 1.5 retry:")} ${failed.length} failed section${failed.length === 1 ? "" : "s"} (up to 3 attempts each)...`);
      for (const { r, idx } of failed) {
        const item = sectionWriteQueue.find((x) => x.sectionPageId === r.page_id);
        if (!item) continue;
        for (let attempt = 1; attempt <= 3; attempt++) {
          console.log(`  ↻ ${r.rel_dir} — attempt ${attempt}/3  ${clr.dim(`(rate-limit ${currentRateLimitMs}ms)`)}`);
          const retryResult = await writeOneSection(item);
          if (retryResult.ok) {
            sectionResults[idx] = { ...sectionResults[idx], content_written: true, error: undefined };
            console.log(`    ${clr.ok(sym.ok)} recovered`);
            break;
          }
          sectionResults[idx] = { ...sectionResults[idx], error: retryResult.error };
          console.log(`    ${clr.warn(sym.warn)} still failing: ${(retryResult.error || "").slice(0, 80)}`);
          if (attempt === 3) {
            console.log(`    ${clr.err(sym.err)} giving up — re-run with --only ${r.rel_dir} later`);
          }
        }
      }
    }
  }

  // ── Phase 1.7 — divergence check (overwrite guardrails) ──
  // Cost: one pages.retrieve per known doc with a baseline. Skipped entirely
  // for dry-runs or guardrails=off, and skipped per-page for docs the user
  // explicitly overrode via --force-overwrite / --accept-move / --accept-archive.
  // Spec: OVERWRITE-GUARDRAILS-EXPLORATION.md
  const protectedByPath = new Map<string, Divergence[]>();
  const divergenceList: Divergence[] = [];
  const overrideMatches = (set: Set<string>, relPath: string): boolean => {
    if (set.size === 0) return false;
    const base = path.basename(relPath, ".md");
    const basename = path.basename(relPath);
    for (const f of set) {
      if (relPath === f || relPath.startsWith(f + "/") || basename === f || base === f) return true;
    }
    return false;
  };

  if (!DRY_RUN && EFFECTIVE_GUARDRAILS !== "off" && syncState.bot_id) {
    console.log(`${clr.phase("Phase 1.7:")} checking for human-edited Notion pages...`);
    let checked = 0;
    let protectedCount = 0;
    for (const relPath of allToSync) {
      const discovery = discoveryMap.get(relPath);
      if (!discovery || discovery.isNew) continue; // freshly created — no baseline possible
      if (!syncState.pages[relPath]) continue;       // no baseline recorded yet
      if (!VERBOSE && IS_TTY) renderProgress(checked + 1, allToSync.length, relPath, "checking");

      // Caller-supplied per-page overrides — the user explicitly accepted the
      // divergence, so don't even check (and don't surface the "would have
      // been protected" finding either).
      if (overrideMatches(forceOverwritePaths, relPath)) continue;

      // For accept-move and accept-archive, we still run the check so the
      // SyncResult records what was overridden — but we don't add to the
      // protected map (the write proceeds).
      try {
        // checkDivergence now returns ALL applicable kinds. The reconcile
        // flow gets a richer picture — e.g. a page that's both moved AND
        // user-edited shows BOTH, so the user can't accidentally pick
        // "move it back" without realizing the human's edits exist.
        const baseline = syncState.pages[relPath];
        const divs = await checkDivergence({
          notion,
          state: syncState,
          relPath,
          pageId: discovery.id,
          expectedParentId: baseline.expected_parent_id,
        });
        if (divs.length === 0) { checked++; continue; }

        // Apply per-page CLI overrides. acceptMove / acceptArchive only
        // dismiss the corresponding kind — other divergences still surface.
        let remaining = divs;
        if (overrideMatches(acceptMovePaths, relPath)) {
          if (remaining.some((d) => d.kind === "moved")) {
            baseline.expected_parent_id = discovery.parentId;
            remaining = remaining.filter((d) => d.kind !== "moved");
          }
        }
        if (overrideMatches(acceptArchivePaths, relPath)) {
          if (remaining.some((d) => d.kind === "archived")) {
            delete syncState.pages[relPath];
            remaining = []; // dropping the doc clears all divergences for it
          }
        }
        if (remaining.length === 0) { checked++; continue; }

        for (const d of remaining) divergenceList.push(d);
        // benign-drift is soft-warn — present in divergenceList for the report
        // but not in protectedByPath, so it doesn't block the write.
        const blocking = remaining.filter((d) => d.kind !== "benign-drift");
        if (blocking.length > 0) {
          protectedByPath.set(relPath, blocking);
          protectedCount++;
        }
      } catch (err: any) {
        console.error(`  ${clr.warn(`${sym.warn} divergence check failed for ${relPath}: ${err.message?.slice(0, 80)}`)}`);
      }
      checked++;
    }
    if (!VERBOSE && IS_TTY) clearProgress();
    if (protectedCount === 0 && divergenceList.length === 0) {
      console.log(`  ${clr.ok(sym.ok)} no human edits detected (${checked} pages checked)\n`);
    } else {
      const c = { warn: clr.warn, err: clr.err, dim: clr.dim, bold: clr.bold, url: clr.url };
      console.log(formatDivergences(divergenceList, EFFECTIVE_GUARDRAILS, c));
      if (EFFECTIVE_GUARDRAILS === "warn") {
        console.log(clr.warn(`  ${sym.warn} guardrails=warn — overwriting anyway. Re-run with --guardrails strict to block.\n`));
      } else if (protectedCount > 0) {
        console.log(clr.dim(`  Continuing with ${allToSync.length - protectedCount} unprotected page(s).\n`));
      }
    }
  }

  // Phase 2 — write content with cross-file Notion links resolved
  console.log(`${clr.phase("Phase 2:")} writing content...`);
  // Reuse partialResults so the SIGINT handler sees pushes in-place.
  const results: SyncResult[] = partialResults;
  const total = allToSync.length;
  const counter = { n: 0, total };
  const recentStatuses: SyncStatus[] = [];
  // Set of all page IDs we synced — used by mention-converter to identify
  // which markdown links can become native mentions vs. stay as external links.
  const ourPageIds = USE_MENTIONS ? buildPageIdSet(pageIdMap) : new Set<string>();

  const phase2Start = Date.now();
  partialSnapshot.phase2Start = phase2Start;
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
    const protectedDivs = protectedByPath.get(relPath) ?? null;
    const r = await writeFileContent(relPath, discovery, pageIdMap, counter, ourPageIds, protectedDivs, syncState, discovery.parentId);
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
        abortedRef.value = true;
        break;
      }
    }
  }
  if (!VERBOSE && IS_TTY) clearProgress();

  // Phase 2 retry pass — up to 3 extra attempts per failed file. Skips items
  // that errored in Phase 1 discovery (no Notion page to retry against) and
  // items hit by the abort policy (likely systemic — retrying won't help).
  // Uses the adaptive backoff which will already have widened the rate-limit
  // window from the original failures.
  const aborted = abortedRef.value;
  if (!aborted && !DRY_RUN) {
    const retryable = results
      .map((r, idx) => ({ r, idx }))
      .filter(({ r }) => r.status === "error" && r.error !== "Page discovery failed in phase 1");
    if (retryable.length > 0) {
      console.log(`\n${clr.phase("Phase 2 retry:")} ${retryable.length} failed file${retryable.length === 1 ? "" : "s"} (up to 3 attempts each)...`);
      for (const { r, idx } of retryable) {
        const discovery = discoveryMap.get(r.path);
        if (!discovery) continue;
        for (let attempt = 1; attempt <= 3; attempt++) {
          console.log(`  ↻ ${r.path} — attempt ${attempt}/3  ${clr.dim(`(rate-limit ${currentRateLimitMs}ms)`)}`);
          const retryResult = await writeFileContent(r.path, discovery, pageIdMap, { n: counter.n, total: counter.total }, ourPageIds, null, syncState, discovery.parentId);
          if (retryResult.status !== "error") {
            results[idx] = retryResult;
            console.log(`    ${clr.ok(sym.ok)} recovered (${retryResult.status})`);
            break;
          }
          results[idx] = retryResult;
          console.log(`    ${clr.warn(sym.warn)} still failing: ${(retryResult.error || "").slice(0, 80)}`);
          if (attempt === 3) {
            console.log(`    ${clr.err(sym.err)} giving up — re-run with --only ${path.basename(r.path, ".md")} later`);
          }
        }
      }
    }
  }
  const phase2Ms = Date.now() - phase2Start;

  // Summary
  const errors = results.filter((r) => r.status === "error");
  const created = results.filter((r) => r.status === "created");
  const updated = results.filter((r) => r.status === "updated");
  const dryRun = results.filter((r) => r.status === "dry_run");
  const protectedResults = results.filter((r) => r.status === "protected");

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
    if (protectedResults.length)
      parts.push(clr.warn(`🛡  ${protectedResults.length} protected`));
    if (errors.length)
      parts.push(clr.err(`${sym.err} ${errors.length} errors`));
    console.log(`Sync complete — ${parts.join("   ")}`);
    if (imageUploader) {
      const s = imageUploader.getStats();
      console.log(clr.dim(`Images:        ${s.uploads} uploaded, ${s.cache_hits} cached  (cache: ${s.total_in_cache} entries)`));
    }
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
    image_stats: imageUploader ? imageUploader.getStats() : null,
    protected_pages: protectedResults.map((r) => ({
      path: r.path,
      kinds: r.protected_kinds ?? [],
      details: r.protected_details ?? [],
      notion_url: r.notion_url ?? notionUrl(r.page_id ?? ""),
    })),
    guardrails_mode: EFFECTIVE_GUARDRAILS,
  };

  // Run completed — disarm the partial-save handler so a late shutdown signal
  // doesn't overwrite the full log entry we're about to write.
  partialSnapshot = null;

  // Persist any baselines recorded by recordPageBaseline during this run, plus
  // any --accept-move/--accept-archive mutations to the state file. Skipped
  // for dry-runs (no real writes happened) and guardrails=off.
  if (!DRY_RUN && EFFECTIVE_GUARDRAILS !== "off") {
    try { saveState(syncState); }
    catch (err: any) { console.error(clr.warn(`  ${sym.warn} could not save .notion-sync-state.json: ${err.message}`)); }
  }

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

  // Auto-prompt: if guardrails skipped any pages, offer to walk the user
  // through reconciliation immediately. Non-TTY (CI / GitHub Action) gets the
  // hint as text only — interactive resolution requires gum + stdin.
  if (!DRY_RUN && protectedResults.length > 0) {
    const n = protectedResults.length;
    if (process.stdin.isTTY && process.stdout.isTTY) {
      console.log(""); // spacer
      const accepted = await askConfirm(
        `🛡  ${n} page${n === 1 ? " is" : "s are"} protected. Reconcile now? ${clr.dim("[Y/n]")} `,
      );
      if (accepted) {
        // Inherit stdio so gum can drive its own TTY interaction, and stdout
        // streams directly to the user's terminal.
        const proc = Bun.spawn(["bun", path.join(__dirname, "reconcile.ts")], {
          stdin: "inherit", stdout: "inherit", stderr: "inherit",
        });
        await proc.exited;
      } else {
        console.log(clr.dim(`  Resolve later with: bash sync.sh reconcile`));
      }
    } else {
      console.log(clr.dim(`\n  Run \`bash sync.sh reconcile\` (interactive) to resolve the ${n} protected page(s).`));
    }
  }

  if (errors.length > 0) process.exit(1);
}

main().catch((err: Error) => {
  console.error(clr.err(`\n${sym.err} Unexpected fatal error: ${err.message}`));
  if (err.stack) console.error(clr.dim(err.stack));
  process.exit(1);
});
