#!/usr/bin/env bun
/**
 * Reconciliation flow — guided per-page resolution of guardrail-protected pages.
 *
 * Spec: RECONCILIATION-EXPLORATION.md
 *
 * PR 1 scope (THIS FILE): skeleton + dry-run only.
 *   - Reads last live (non-dry-run, non-partial) entry of runs.jsonl.
 *   - Top-of-flow gum-checkbox to pick subset (default: all).
 *   - Sequential walk with kind-specific menu per page.
 *   - "← Back to previous page" navigation.
 *   - Prints intended resolutions; DOES NOT EXECUTE any writes.
 *   - End-of-flow summary lists what would have been done.
 *
 * PR 2: state mutations (accept-move, accept-archive, etc.) become real.
 * PR 3: pull path implemented (notion.pages.retrieveMarkdown).
 * PR 4: auto-prompt at end of sync, USAGE.md, /sync-all integration.
 */

import { Client } from "@notionhq/client";
import * as fs from "fs";
import * as path from "path";
import {
  loadState,
  saveState,
  ensureBotId,
  checkDivergence,
  recheckUserEdited,
  getStatePath,
  type SyncStateFile,
  type Divergence,
} from "./sync-state";

// ── ANSI colors (subset of index.ts's helpers, inlined to keep modules independent) ──
const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:  (s: string) => `\x1b[2m${s}\x1b[0m`,
  red:  (s: string) => `\x1b[31m${s}\x1b[0m`,
  green:(s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow:(s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  url:  (s: string) => `\x1b[4;34m${s}\x1b[0m`,
};

// ── Types mirroring runs.jsonl protected_pages[] entries ─────────────────────
// PR 2 will refactor `kind` (string) → `kinds` (string[]); for PR 1 we accept
// either shape so reconciliation works against existing log entries.

type DivergenceKind = Divergence["kind"];

interface ProtectedPage {
  path: string;
  kind?: DivergenceKind;     // PR 1 schema (legacy entries in runs.jsonl)
  kinds?: DivergenceKind[];  // PR 2 schema (current — index.ts emits this)
  detail?: string;           // PR 1 schema
  details?: string[];        // PR 2 schema
  notion_url: string;
}

interface RunLogEntry {
  run_id: string;
  ts: string;
  dry_run: boolean;
  partial?: boolean;
  guardrails_mode?: "strict" | "warn" | "off";
  protected_pages?: ProtectedPage[];
}

type ResolutionChoice =
  | "pull"
  | "force-overwrite"
  | "view-diff"
  | "accept-move"
  | "move-back"
  | "accept-archive"
  | "force-recreate"
  | "skip"
  | "back"
  | "cancel"
  | "auto";

interface Resolution {
  page: ProtectedPage;
  choice: ResolutionChoice;
  applied: boolean; // PR 1: always false (dry-run only)
}

// ── CLI args ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const pathFilters: string[] = [];
let inlineDiff = false;
let forcePull = false;
let acceptLossy = false;
let dryRun = false; // PR 2: real state mutations. --dry-run flag still works for preview.
for (const arg of argv) {
  if (arg === "--inline-diff")      { inlineDiff = true; continue; }
  if (arg === "--force-pull")       { forcePull = true; continue; }
  if (arg === "--accept-lossy-pull") { acceptLossy = true; continue; }
  if (arg === "--dry-run")          { dryRun = true; continue; }
  if (arg.startsWith("--"))         { continue; }
  pathFilters.push(arg.replace(/\/$/, ""));
}

// ── runs.jsonl reader ────────────────────────────────────────────────────────

const RUNS_LOG = path.join(__dirname, "runs.jsonl");
const MAX_LOOKBACK = 50;

function readLastLiveRun(): RunLogEntry | null {
  if (!fs.existsSync(RUNS_LOG)) return null;
  const lines = fs.readFileSync(RUNS_LOG, "utf-8").split("\n").filter(Boolean);
  // Walk backwards to find the most recent non-dry-run, non-partial entry.
  // Bounded to MAX_LOOKBACK to avoid scanning a huge log.
  const start = Math.max(0, lines.length - MAX_LOOKBACK);
  for (let i = lines.length - 1; i >= start; i--) {
    try {
      const entry: RunLogEntry = JSON.parse(lines[i]);
      if (entry.dry_run) continue;
      if (entry.partial) continue;
      return entry;
    } catch { /* skip malformed lines */ }
  }
  return null;
}

function pathMatches(filters: string[], relPath: string): boolean {
  if (filters.length === 0) return true;
  const base = path.basename(relPath, ".md");
  const basename = path.basename(relPath);
  return filters.some(f =>
    relPath === f ||
    relPath.startsWith(f + "/") ||
    basename === f ||
    base === f
  );
}

function getKinds(p: ProtectedPage): DivergenceKind[] {
  if (p.kinds) return p.kinds;
  if (p.kind) return [p.kind];
  return [];
}

// ── gum subprocess helpers ───────────────────────────────────────────────────

async function gumAvailable(): Promise<boolean> {
  // Need both: gum on PATH AND a real TTY (gum opens /dev/tty directly,
  // fails hard in non-interactive shells / piped stdin).
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  try {
    const proc = Bun.spawn(["which", "gum"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch { return false; }
}

/** Returns selected option string, or null on Esc/Ctrl-C (gum exit 130). */
async function gumChoose(prompt: string, options: string[]): Promise<string | null> {
  console.log(c.dim(prompt));
  const proc = Bun.spawn(["gum", "choose", ...options, `--height=${options.length + 2}`], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode === 130) return null;
  return text.trim() || null;
}

async function gumChooseMulti(prompt: string, options: string[], allSelected = true): Promise<string[] | null> {
  console.log(c.dim(prompt));
  const args = ["gum", "choose", "--no-limit", ...options, `--height=${Math.min(options.length + 2, 20)}`];
  if (allSelected) args.push(`--selected=${options.join(",")}`);
  const proc = Bun.spawn(args, {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode === 130) return null;
  return text.split("\n").map(s => s.trim()).filter(Boolean);
}

/** Numeric-prompt fallback when gum isn't installed. Reads stdin line-by-line
 *  via an async iterator over Bun.stdin — works reliably with piped input
 *  (Bun's readline/promises has interaction issues with subprocess spawns). */
let _stdinIter: AsyncIterator<string> | null = null;
async function readStdinLine(): Promise<string | null> {
  if (!_stdinIter) {
    // Lazy: build a line-iterator over process.stdin on first call.
    async function* lines(): AsyncIterator<string> {
      let buf = "";
      // @ts-ignore - process.stdin is async-iterable in Bun
      for await (const chunk of process.stdin) {
        buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          yield buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
        }
      }
      if (buf.length > 0) yield buf;
    }
    _stdinIter = lines();
  }
  const r = await _stdinIter.next();
  return r.done ? null : r.value;
}

// ── Diff tool sub-menu ──────────────────────────────────────────────────────
//
// When the user picks "View diff first", offer a tool sub-menu. Auto-detects
// what's installed; only shows tools that are actually available. Default
// (terminal git diff) always present.

type DiffTool = "git" | "code" | "opendiff" | "browser" | "inline";

interface DiffToolDetected {
  tool: DiffTool;
  label: string;
  hint: string;
}

async function detectDiffTools(): Promise<DiffToolDetected[]> {
  const tools: DiffToolDetected[] = [];
  // Always available
  tools.push({ tool: "git",     label: "Terminal — git diff",                 hint: "default; pager + colors" });
  // VS Code: `code` on PATH
  if (await binAvailable("code")) {
    tools.push({ tool: "code",  label: "VS Code (side-by-side, syntax)",      hint: "opens as a tab" });
  }
  // macOS FileMerge — `opendiff` is a wrapper that requires Xcode (not just
  // CLT). Skip if `xcode-select -p` points at the CLT-only path.
  if (await binAvailable("opendiff") && await xcodeFullInstalled()) {
    tools.push({ tool: "opendiff", label: "FileMerge (macOS GUI, three-pane)", hint: "left/right/merge" });
  }
  // Browser HTML — needs `open` (macOS) or `xdg-open` (linux)
  if (await binAvailable("open") || await binAvailable("xdg-open")) {
    tools.push({ tool: "browser", label: "Browser — HTML side-by-side",        hint: "renders to /tmp + opens" });
  }
  // Inline (no external tool, fallback)
  tools.push({ tool: "inline",  label: "Inline (no external tool)",           hint: "+/- lines in terminal" });
  return tools;
}

async function binAvailable(bin: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", bin], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch { return false; }
}

/** Returns true if Xcode (not just CLT) is installed — `xcode-select -p`
 *  pointing at /Applications/Xcode.app/... rather than CommandLineTools. */
async function xcodeFullInstalled(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["xcode-select", "-p"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return proc.exitCode === 0 && !/CommandLineTools/i.test(out);
  } catch { return false; }
}

/** Render the diff between local and pulled-tempfile using the chosen tool.
 *  Tool dispatcher — each branch self-contained. */
interface DiffResult {
  /** Browser merge mode wrote the local file. Caller should refresh baseline +
   *  treat the page as resolved (skip the menu re-prompt). */
  savedMerge?: boolean;
}

async function renderDiffWith(tool: DiffTool, localPath: string, tmpPath: string, mergedContent: string): Promise<DiffResult> {
  switch (tool) {
    case "git": {
      const proc = Bun.spawn(
        ["git", "--no-pager", "diff", "--no-index", "--color=always", localPath, tmpPath],
        { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
      );
      await proc.exited;
      // git diff exits 1 when files differ — normal.
      return {};
    }
    case "code": {
      // VS Code returns immediately after opening; we don't await the user's
      // viewing time. The reconcile loop re-renders the menu after this.
      const proc = Bun.spawn(["code", "--diff", localPath, tmpPath, "--wait"], {
        stdin: "ignore", stdout: "inherit", stderr: "inherit",
      });
      console.log(c.dim(`       Opened in VS Code (close the diff tab to continue)…`));
      await proc.exited;
      return {};
    }
    case "opendiff": {
      const proc = Bun.spawn(["opendiff", localPath, tmpPath], {
        stdin: "ignore", stdout: "inherit", stderr: "inherit",
      });
      console.log(c.dim(`       Opened in FileMerge (close the window to continue)…`));
      await proc.exited;
      return {};
    }
    case "browser": {
      // Generate diff via git, render rich HTML with three views (unified,
      // side-by-side, merge). Serve from a tiny Bun.serve on a random port
      // so the merge editor's Save button can POST back to /save without
      // CORS hassles. Server stops once the user saves or cancels.
      let diffOutput = "";
      const proc = Bun.spawn(
        ["git", "--no-pager", "diff", "--no-color", "--no-index", "--word-diff=plain", "-U99999", localPath, tmpPath],
        { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
      );
      diffOutput = await new Response(proc.stdout).text();
      await proc.exited;
      const localContent = fs.existsSync(localPath) ? fs.readFileSync(localPath, "utf-8") : "";
      const result = await runBrowserDiffServer({
        localPath,
        localContent,
        notionContent: mergedContent,
        diffOutput,
      });
      if (result === "saved") {
        console.log(c.green(`       ✓ Merged content saved to ${path.relative(process.cwd(), localPath)}`));
        return { savedMerge: true };
      } else if (result === "cancelled") {
        console.log(c.dim(`       (browser session cancelled — local file unchanged)`));
      } else {
        console.log(c.dim(`       (browser session timed out — local file unchanged)`));
      }
      return {};
    }
    case "inline": {
      const a = fs.existsSync(localPath) ? fs.readFileSync(localPath, "utf-8").split("\n") : [];
      const b = mergedContent.split("\n");
      const max = Math.max(a.length, b.length);
      for (let k = 0; k < max; k++) {
        if (a[k] === b[k]) continue;
        if (a[k] !== undefined) console.log(c.red(`- ${a[k]}`));
        if (b[k] !== undefined) console.log(c.green(`+ ${b[k]}`));
      }
      return {};
    }
  }
}

// ── Browser-diff server ─────────────────────────────────────────────────────
//
// When the user picks the "Browser" diff tool, reconcile starts a tiny
// Bun.serve on a random port that serves the diff HTML AND handles the
// merge editor's save button. The same-origin POST avoids CORS headaches.
// Server stops as soon as the user saves, cancels, or hits the timeout.

interface BrowserDiffArgs {
  localPath: string;
  localContent: string;
  notionContent: string;
  diffOutput: string;
}

const BROWSER_DIFF_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

async function runBrowserDiffServer(args: BrowserDiffArgs): Promise<"saved" | "cancelled" | "timeout"> {
  const { localPath, localContent, notionContent, diffOutput } = args;
  let outcome: "saved" | "cancelled" | "timeout" | null = null;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = renderDiffHtml(localPath, diffOutput, localContent, notionContent);
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/save" && req.method === "POST") {
        try {
          const text = await req.text();
          const tmp = `${localPath}.merge.${process.pid}.tmp`;
          fs.writeFileSync(tmp, text, "utf-8");
          fs.renameSync(tmp, localPath);
          outcome = "saved";
          return new Response("saved", { status: 200 });
        } catch (err: any) {
          return new Response(`save failed: ${err.message}`, { status: 500 });
        }
      }
      if (url.pathname === "/cancel") {
        outcome = "cancelled";
        return new Response("cancelled", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const url = `http://127.0.0.1:${server.port}/`;
  const opener = (await binAvailable("open")) ? "open" : "xdg-open";
  Bun.spawn([opener, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  console.log(c.dim(`       Opened ${url} — choose Unified / Side-by-side / Merge in the browser.`));
  console.log(c.dim(`       Reconcile is paused; will resume after you click Save or Cancel (timeout 30 min).`));

  // Poll for outcome with bounded wait. Avoids hanging reconcile if user
  // closes the browser without clicking anything.
  const deadline = Date.now() + BROWSER_DIFF_TIMEOUT_MS;
  while (outcome === null && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
  }
  // Give the response a moment to flush before stopping the server.
  await new Promise(r => setTimeout(r, 100));
  server.stop(true);
  return outcome ?? "timeout";
}

/** Parse `git diff --word-diff=plain` output into a renderable structure.
 *  Each non-header line falls into one of:
 *    - context:  starts with " " (or no prefix, depending on git mode)
 *    - hunk:     `@@ -... +... @@`
 *    - changed:  contains `[-...-]` and/or `{+...+}` markers
 *    - added:    starts with "+" (full-line addition without word markers)
 *    - removed:  starts with "-" (full-line removal)
 *  We render each as an HTML row with line-level color + inline <ins>/<del>
 *  for the word-level highlights. */
type DiffRow = { kind: "context" | "added" | "removed" | "changed" | "hunk" | "header"; html: string; raw: string };

/** Parse word-diff output into typed rows shared by all three views. */
function parseDiffOutput(diffOutput: string): DiffRow[] {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows: DiffRow[] = [];
  let inHeader = true;
  for (const raw of diffOutput.split("\n")) {
    if (raw.length === 0) continue;
    if (inHeader) {
      if (raw.startsWith("@@")) { inHeader = false; rows.push({ kind: "hunk", html: escape(raw), raw }); continue; }
      if (raw.startsWith("diff ") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ")) {
        rows.push({ kind: "header", html: escape(raw), raw });
        continue;
      }
      continue;
    }
    if (raw.startsWith("@@")) { rows.push({ kind: "hunk", html: escape(raw), raw }); continue; }
    const hasDel = raw.includes("[-");
    const hasIns = raw.includes("{+");
    if (hasDel || hasIns) {
      let out = "";
      let i = 0;
      while (i < raw.length) {
        if (raw.startsWith("[-", i)) {
          const end = raw.indexOf("-]", i + 2);
          if (end < 0) { out += escape(raw.slice(i)); break; }
          out += `<del>${escape(raw.slice(i + 2, end))}</del>`;
          i = end + 2;
        } else if (raw.startsWith("{+", i)) {
          const end = raw.indexOf("+}", i + 2);
          if (end < 0) { out += escape(raw.slice(i)); break; }
          out += `<ins>${escape(raw.slice(i + 2, end))}</ins>`;
          i = end + 2;
        } else {
          const nextDel = raw.indexOf("[-", i);
          const nextIns = raw.indexOf("{+", i);
          const next = [nextDel, nextIns].filter(n => n >= 0).sort((a, b) => a - b)[0] ?? raw.length;
          out += escape(raw.slice(i, next));
          i = next;
        }
      }
      rows.push({ kind: "changed", html: out, raw });
      continue;
    }
    if (raw.startsWith("+")) { rows.push({ kind: "added",   html: escape(raw.slice(1)), raw }); continue; }
    if (raw.startsWith("-")) { rows.push({ kind: "removed", html: escape(raw.slice(1)), raw }); continue; }
    rows.push({ kind: "context", html: escape(raw.startsWith(" ") ? raw.slice(1) : raw), raw });
  }
  return rows;
}

/** Build the unified-view <tr> rows. */
function buildUnifiedBody(rows: DiffRow[]): string {
  return rows.map(r => `<tr class="${r.kind}"><td class="gutter"></td><td class="line">${r.html || "&nbsp;"}</td></tr>`).join("\n");
}

/** Build side-by-side <tr> rows. Each logical row spans two columns. For
 *  word-changed lines, left shows del-only (deletions visible, insertions
 *  stripped); right shows ins-only. For pure-add: empty left, content right.
 *  For pure-remove: content left, empty right. */
function buildSideBySideBody(rows: DiffRow[]): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const stripIns = (raw: string) => raw.replace(/\{\+([^]*?)\+\}/g, "");
  const stripDel = (raw: string) => raw.replace(/\[-([^]*?)-\]/g, "");
  const renderSide = (raw: string, side: "left" | "right"): string => {
    // For changed lines, render only the markers relevant to this side.
    let out = "";
    let i = 0;
    while (i < raw.length) {
      if (raw.startsWith("[-", i)) {
        const end = raw.indexOf("-]", i + 2);
        if (end < 0) break;
        if (side === "left") out += `<del>${escape(raw.slice(i + 2, end))}</del>`;
        i = end + 2;
      } else if (raw.startsWith("{+", i)) {
        const end = raw.indexOf("+}", i + 2);
        if (end < 0) break;
        if (side === "right") out += `<ins>${escape(raw.slice(i + 2, end))}</ins>`;
        i = end + 2;
      } else {
        const nextDel = raw.indexOf("[-", i);
        const nextIns = raw.indexOf("{+", i);
        const next = [nextDel, nextIns].filter(n => n >= 0).sort((a, b) => a - b)[0] ?? raw.length;
        out += escape(raw.slice(i, next));
        i = next;
      }
    }
    return out || "&nbsp;";
  };
  return rows.map(r => {
    if (r.kind === "header") return ""; // hidden
    if (r.kind === "hunk") return `<tr class="hunk"><td colspan="2">${r.html}</td></tr>`;
    if (r.kind === "context") {
      return `<tr class="context"><td class="line left">${r.html || "&nbsp;"}</td><td class="line right">${r.html || "&nbsp;"}</td></tr>`;
    }
    if (r.kind === "added") {
      return `<tr><td class="line empty"></td><td class="line right added">${r.html || "&nbsp;"}</td></tr>`;
    }
    if (r.kind === "removed") {
      return `<tr><td class="line left removed">${r.html || "&nbsp;"}</td><td class="line empty"></td></tr>`;
    }
    if (r.kind === "changed") {
      // Pure-add lines (`{+full line+}`) render as empty-left/added-right.
      // Pure-remove lines (`[-full line-]`) render as removed-left/empty-right.
      // Mixed: both sides show same line with appropriate inline highlights.
      const stripped = stripIns(stripDel(r.raw));
      if (stripped.trim() === "") {
        const isPureAdd = !r.raw.includes("[-");
        const isPureRem = !r.raw.includes("{+");
        if (isPureAdd) return `<tr><td class="line empty"></td><td class="line right added">${renderSide(r.raw, "right")}</td></tr>`;
        if (isPureRem) return `<tr><td class="line left removed">${renderSide(r.raw, "left")}</td><td class="line empty"></td></tr>`;
      }
      return `<tr class="changed"><td class="line left">${renderSide(r.raw, "left")}</td><td class="line right">${renderSide(r.raw, "right")}</td></tr>`;
    }
    return "";
  }).join("\n");
}

function renderDiffHtml(localName: string, diffOutput: string, localContent: string, notionContent: string): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const title = `Reconcile — ${path.basename(localName)}`;

  const rows = parseDiffOutput(diffOutput);
  const unifiedBody = buildUnifiedBody(rows);
  const sxsBody = buildSideBySideBody(rows);
  const stats = {
    added:   rows.filter(r => r.kind === "added").length   + rows.filter(r => r.kind === "changed" && r.raw.includes("{+") && !r.raw.includes("[-")).length,
    removed: rows.filter(r => r.kind === "removed").length + rows.filter(r => r.kind === "changed" && r.raw.includes("[-") && !r.raw.includes("{+")).length,
    changed: rows.filter(r => r.kind === "changed" && r.raw.includes("[-") && r.raw.includes("{+")).length,
  };
  // The merge view starts pre-populated with local content. User edits toward
  // their desired final state, then clicks Save.
  const localJsonSafe = JSON.stringify(localContent);
  const notionJsonSafe = JSON.stringify(notionContent);

  return `<!doctype html>
<html lang="en" data-theme="dark" data-mode="unified"><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>
  :root[data-theme="dark"] {
    --bg: #0e1116; --fg: #d0d6e0; --fg-dim: #5c6675;
    --border: #2a2f3a; --hunk-bg: #1a1f2a; --hunk-fg: #8aa8d6;
    --add-bg: #163d2a; --add-fg: #a8e8b8; --add-marker: #4ec9b0;
    --del-bg: #4a1a1a; --del-fg: #f99090; --del-marker: #f78787;
    --ins-bg: #2d6a3f; --ins-fg: #ffffff;
    --del-inline-bg: #6b2a2a; --del-inline-fg: #ffffff;
    --header-bg: #161a22; --gutter-bg: #161a22;
    --button-bg: #1f2530; --button-fg: #d0d6e0; --button-border: #2a2f3a;
    --button-active-bg: #2a3344; --button-active-fg: #a8c8f0;
    --pane-label-bg: #1a1f2a; --pane-label-fg: #8aa8d6;
    --textarea-bg: #0e1116; --textarea-fg: #d0d6e0;
    --save-bg: #1a7f37; --save-fg: #ffffff; --save-hover: #2ea043;
    --cancel-bg: #1f2530; --cancel-fg: #f99090;
  }
  :root[data-theme="light"] {
    --bg: #ffffff; --fg: #24292f; --fg-dim: #6e7781;
    --border: #d0d7de; --hunk-bg: #ddf4ff; --hunk-fg: #0969da;
    --add-bg: #ddffdd; --add-fg: #1a7f37; --add-marker: #1a7f37;
    --del-bg: #ffdddd; --del-fg: #cf222e; --del-marker: #cf222e;
    --ins-bg: #aceebb; --ins-fg: #1a7f37;
    --del-inline-bg: #ffaba8; --del-inline-fg: #82071e;
    --header-bg: #f6f8fa; --gutter-bg: #f6f8fa;
    --button-bg: #f6f8fa; --button-fg: #24292f; --button-border: #d0d7de;
    --button-active-bg: #ddf4ff; --button-active-fg: #0969da;
    --pane-label-bg: #f6f8fa; --pane-label-fg: #57606a;
    --textarea-bg: #ffffff; --textarea-fg: #24292f;
    --save-bg: #1a7f37; --save-fg: #ffffff; --save-hover: #116329;
    --cancel-bg: #f6f8fa; --cancel-fg: #cf222e;
  }
  html, body { height: 100%; }
  body { font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 0; background: var(--bg); color: var(--fg); display: flex; flex-direction: column; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; background: var(--header-bg); border-bottom: 1px solid var(--border); flex-shrink: 0; }
  h1 { font-size: 13px; margin: 0; font-weight: 600; }
  h1 .file { color: var(--fg-dim); font-weight: 400; }
  .controls { display: flex; gap: 16px; align-items: center; }
  .stats { display: flex; gap: 12px; font-size: 11px; }
  .stats .added { color: var(--add-marker); }
  .stats .removed { color: var(--del-marker); }
  .stats .changed { color: var(--hunk-fg); }
  .modes { display: flex; gap: 0; border: 1px solid var(--button-border); border-radius: 4px; overflow: hidden; }
  .modes button { background: var(--button-bg); color: var(--button-fg); border: 0; border-right: 1px solid var(--button-border); padding: 4px 12px; font: inherit; cursor: pointer; }
  .modes button:last-child { border-right: 0; }
  .modes button.active { background: var(--button-active-bg); color: var(--button-active-fg); }
  .modes button:hover:not(.active) { background: var(--border); }
  button.theme { background: var(--button-bg); color: var(--button-fg); border: 1px solid var(--button-border); padding: 4px 10px; border-radius: 4px; font: inherit; cursor: pointer; }
  button.theme:hover { background: var(--border); }

  /* Views — only one visible based on data-mode */
  .view { display: none; flex: 1; min-height: 0; overflow: auto; }
  :root[data-mode="unified"] .view-unified { display: block; }
  :root[data-mode="sxs"] .view-sxs { display: block; }
  :root[data-mode="merge"] .view-merge { display: flex; }

  /* Tables (unified + sxs) */
  table { border-collapse: collapse; width: 100%; font: 12px/1.5 ui-monospace, "SF Mono", Menlo, monospace; }
  td.gutter { width: 40px; padding: 0 8px; text-align: right; color: var(--fg-dim); user-select: none; background: var(--gutter-bg); border-right: 1px solid var(--border); }
  td.line { padding: 0 12px; white-space: pre-wrap; word-break: break-word; vertical-align: top; }
  td.line.empty { background: var(--gutter-bg); }
  td.line.left.removed, td.line.right.added, tr.added > td, tr.removed > td { /* see specific rules below */ }
  /* Unified view */
  .view-unified tr.context { background: var(--bg); }
  .view-unified tr.added { background: var(--add-bg); color: var(--add-fg); }
  .view-unified tr.added td.gutter::after { content: "+"; color: var(--add-marker); }
  .view-unified tr.removed { background: var(--del-bg); color: var(--del-fg); }
  .view-unified tr.removed td.gutter::after { content: "−"; color: var(--del-marker); }
  .view-unified tr.changed { background: var(--bg); }
  .view-unified tr.changed td.gutter::after { content: "~"; color: var(--hunk-fg); }
  .view-unified tr.hunk { background: var(--hunk-bg); color: var(--hunk-fg); }
  .view-unified tr.hunk td { padding: 6px 12px; font-weight: 600; }
  .view-unified tr.header { display: none; }
  /* Side-by-side */
  .view-sxs td.line { width: 50%; border-right: 1px solid var(--border); }
  .view-sxs td.line.right { border-right: 0; }
  .view-sxs td.line.left.removed { background: var(--del-bg); color: var(--del-fg); }
  .view-sxs td.line.right.added  { background: var(--add-bg); color: var(--add-fg); }
  .view-sxs tr.changed td.line.left  { background: color-mix(in srgb, var(--del-bg) 50%, var(--bg) 50%); }
  .view-sxs tr.changed td.line.right { background: color-mix(in srgb, var(--add-bg) 50%, var(--bg) 50%); }
  .view-sxs tr.hunk { background: var(--hunk-bg); color: var(--hunk-fg); }
  .view-sxs tr.hunk td { padding: 6px 12px; font-weight: 600; }
  /* Merge view */
  .view-merge { padding: 12px; gap: 12px; }
  .pane { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .pane h2 { font-size: 11px; margin: 0; padding: 8px 12px; background: var(--pane-label-bg); color: var(--pane-label-fg); border-bottom: 1px solid var(--border); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .pane.local h2  { color: var(--del-marker); }
  .pane.merge h2  { color: var(--hunk-fg); }
  .pane.notion h2 { color: var(--add-marker); }
  .pane textarea { flex: 1; border: 0; resize: none; padding: 12px; font: 12px/1.5 ui-monospace, "SF Mono", Menlo, monospace; background: var(--textarea-bg); color: var(--textarea-fg); }
  .pane textarea:focus { outline: none; box-shadow: inset 0 0 0 2px var(--hunk-fg); }
  .pane.merge textarea { background: var(--bg); }
  .merge-actions { display: flex; gap: 8px; padding: 8px 12px; background: var(--pane-label-bg); border-top: 1px solid var(--border); }
  .merge-actions button { padding: 6px 14px; border: 0; border-radius: 4px; font: inherit; cursor: pointer; }
  .merge-actions button.save { background: var(--save-bg); color: var(--save-fg); font-weight: 600; }
  .merge-actions button.save:hover { background: var(--save-hover); }
  .merge-actions button.cancel { background: var(--cancel-bg); color: var(--cancel-fg); border: 1px solid var(--button-border); }
  .merge-actions .hint { margin-left: auto; align-self: center; font-size: 11px; color: var(--fg-dim); }

  ins { background: var(--ins-bg); color: var(--ins-fg); text-decoration: none; padding: 1px 2px; border-radius: 2px; }
  del { background: var(--del-inline-bg); color: var(--del-inline-fg); text-decoration: line-through; padding: 1px 2px; border-radius: 2px; }
  footer { padding: 10px 16px; font-size: 11px; color: var(--fg-dim); border-top: 1px solid var(--border); flex-shrink: 0; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); padding: 10px 16px; border-radius: 6px; background: var(--save-bg); color: var(--save-fg); font-weight: 600; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .toast.error { background: var(--del-bg); color: var(--del-fg); }
</style>
</head><body>
<header>
  <h1>Reconcile <span class="file">${escape(path.basename(localName))}</span></h1>
  <div class="controls">
    <div class="stats">
      <span class="added">+${stats.added} added</span>
      <span class="removed">−${stats.removed} removed</span>
      <span class="changed">~${stats.changed} changed</span>
    </div>
    <div class="modes" role="tablist">
      <button data-mode="unified" class="active">Unified</button>
      <button data-mode="sxs">Side-by-side</button>
      <button data-mode="merge">Merge ✏️</button>
    </div>
    <button class="theme" type="button" title="Toggle light/dark">🌓</button>
  </div>
</header>
<div class="view view-unified"><table>${unifiedBody}</table></div>
<div class="view view-sxs"><table>${sxsBody}</table></div>
<div class="view view-merge">
  <div class="pane local">
    <h2>Local — your file (read-only)</h2>
    <textarea readonly id="local-text"></textarea>
  </div>
  <div class="pane merge">
    <h2>Merge target — edit, then save</h2>
    <textarea id="merge-text"></textarea>
    <div class="merge-actions">
      <button class="save" id="save">💾 Save merged → local file</button>
      <button class="cancel" id="cancel">✗ Cancel (don't write)</button>
      <span class="hint">Saving overwrites the local doc and resolves the page.</span>
    </div>
  </div>
  <div class="pane notion">
    <h2>Notion — current page state (read-only)</h2>
    <textarea readonly id="notion-text"></textarea>
  </div>
</div>
<footer>Local (red −) vs Notion (green +). Inline <del>red</del>/<ins>green</ins> show word-level changes within mixed lines. <strong>Merge</strong> mode lets you build the final version by hand and save it directly to the local file.</footer>
<div class="toast" id="toast"></div>
<script>
  (function() {
    const root = document.documentElement;
    // Theme persistence
    const storedTheme = localStorage.getItem("notion-sync-diff-theme");
    if (storedTheme) root.setAttribute("data-theme", storedTheme);
    document.querySelector("button.theme").addEventListener("click", function() {
      const cur = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", cur);
      localStorage.setItem("notion-sync-diff-theme", cur);
    });
    // Mode switching
    const modeButtons = document.querySelectorAll(".modes button");
    modeButtons.forEach(btn => btn.addEventListener("click", function() {
      const mode = btn.dataset.mode;
      root.setAttribute("data-mode", mode);
      modeButtons.forEach(b => b.classList.toggle("active", b === btn));
    }));
    // Populate textareas (avoids HTML-escape issues with content containing tags)
    const localContent = ${localJsonSafe};
    const notionContent = ${notionJsonSafe};
    document.getElementById("local-text").value = localContent;
    document.getElementById("notion-text").value = notionContent;
    document.getElementById("merge-text").value = localContent;
    // Toast
    const toast = document.getElementById("toast");
    function showToast(msg, isError) {
      toast.textContent = msg;
      toast.className = "toast show" + (isError ? " error" : "");
      setTimeout(() => { toast.className = "toast" + (isError ? " error" : ""); }, 2400);
    }
    // Save / cancel
    document.getElementById("save").addEventListener("click", async function() {
      const merged = document.getElementById("merge-text").value;
      try {
        const res = await fetch("/save", { method: "POST", headers: { "content-type": "text/plain; charset=utf-8" }, body: merged });
        if (res.ok) {
          showToast("✓ Saved. Switch back to your terminal — reconcile has resumed.");
          setTimeout(() => { window.close(); }, 1500);
        } else {
          showToast("Save failed: HTTP " + res.status, true);
        }
      } catch (err) {
        showToast("Save failed: " + err.message, true);
      }
    });
    document.getElementById("cancel").addEventListener("click", async function() {
      try { await fetch("/cancel"); } catch (_) {}
      showToast("Cancelled — local file unchanged.");
      setTimeout(() => { window.close(); }, 1200);
    });
  })();
</script>
</body></html>`;
}

/** Yes/no confirm. Default applies on empty input or non-TTY. Uses gum if
 *  available + interactive; otherwise falls back to readline. */
async function confirmYN(prompt: string, defaultYes: boolean): Promise<boolean> {
  const useGum = await gumAvailable();
  if (useGum) {
    const args = ["gum", "confirm", prompt, `--affirmative=${defaultYes ? "Yes" : "yes"}`, `--negative=${defaultYes ? "no" : "No"}`];
    if (defaultYes) args.push("--default");
    const proc = Bun.spawn(args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    await proc.exited;
    if (proc.exitCode === 130) return false; // ctrl-c
    return proc.exitCode === 0;
  }
  // Readline fallback. Non-TTY → return default silently.
  if (!process.stdin.isTTY) return defaultYes;
  process.stdout.write(`${c.dim(prompt)} ${c.dim(defaultYes ? "[Y/n]" : "[y/N]")} `);
  const ans = (await readStdinLine())?.trim();
  if (ans == null || ans === "") return defaultYes;
  return /^y(es)?$/i.test(ans);
}

async function readlineChoose(prompt: string, options: string[]): Promise<string | null> {
  console.log(c.dim(prompt));
  for (let i = 0; i < options.length; i++) console.log(`  ${i + 1}. ${options[i]}`);
  process.stdout.write("  Select [1-" + options.length + "]: ");
  const ans = (await readStdinLine())?.trim();
  if (ans == null) return null;
  const n = parseInt(ans, 10);
  if (isNaN(n) || n < 1 || n > options.length) return null;
  console.log(""); // newline after the echoed input
  return options[n - 1];
}
function closeReadline(): void { /* iterator closes with stdin EOF */ }

// ── Pull path ────────────────────────────────────────────────────────────────
// Fetches Notion's current markdown for a page, strips the breadcrumb/banner/
// footer that we add at push time, converts <mention-page url=...> tags back
// to plain markdown links, merges with local frontmatter, and writes atomically
// to the local file. Used by the "Pull Notion → local" resolution for
// user-edited divergences.

interface PullResult {
  markdown: string;            // final body that was written (excludes frontmatter)
  truncated: boolean;          // Notion clipped the export
  unknown_block_ids: string[]; // block types Notion couldn't serialize as markdown
}

async function pullPageMarkdownRaw(notion: Client, pageId: string): Promise<PullResult> {
  const r: any = await (notion.pages as any).retrieveMarkdown({ page_id: pageId });
  return {
    markdown: r.markdown ?? "",
    truncated: r.truncated === true,
    unknown_block_ids: Array.isArray(r.unknown_block_ids) ? r.unknown_block_ids : [],
  };
}

/** Strip the trailing `\n\n---\n\n*Synced: <ts>*\n` footer that index.ts appends. */
function stripSyncFooter(md: string): string {
  return md.replace(/\n+---\n+\*Synced:[^\n]+\*\s*$/m, "").replace(/\s+$/, "") + "\n";
}

/** Strip the breadcrumb (`> 📍 ...`) and the meta-banner (consecutive `>` lines)
 *  from the top of the export. Cuts off everything before the first `# ` H1. */
function stripBreadcrumbAndBanner(md: string): string {
  const h1 = md.search(/^# /m);
  if (h1 < 0) return md; // no H1 — leave as-is, user can edit
  return md.slice(h1);
}

/** Convert Notion's custom `<mention-page url="X">Y</mention-page>` tags
 *  back to plain markdown links `[Y](X)`. The next sync's mention-converter
 *  will re-convert these to native page mentions. */
function convertMentionTagsToLinks(md: string): string {
  return md.replace(
    /<mention-page url="([^"]+)">([^<]*)<\/mention-page>/g,
    (_, url, label) => `[${label}](${url})`,
  );
}

/** Notion converts markdown pipe-tables to native `table` blocks the moment
 *  a user edits a cell in the UI. The retrieveMarkdown export then returns
 *  them as HTML `<table><tr><td>...` rather than pipe-tables. Convert back
 *  so the pulled local file matches the project's markdown convention.
 *
 *  Handles the format Notion emits: `<table header-row="true">` (or false),
 *  `<tr><td>cell</td>...</tr>`. Doesn't try to handle nested tables, complex
 *  block content inside cells (just inlines whatever's there), or thead/tbody
 *  wrappers (Notion doesn't emit them). */
function convertHtmlTablesToMarkdown(md: string): string {
  return md.replace(/<table([^>]*)>([\s\S]*?)<\/table>/g, (_full, attrs, inner) => {
    // header-row="true" means first row is the header. If absent or false,
    // we still treat the first row as header (markdown tables require one).
    const trMatches = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
    const rows: string[][] = [];
    for (const tr of trMatches) {
      const cells: string[] = [];
      for (const td of tr[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)) {
        let content = td[1].trim();
        // Unescape Notion's escapes for chars that have meaning in markdown
        content = content.replace(/\\([>|`*_])/g, "$1");
        // Pipes inside cells must be escaped in markdown
        content = content.replace(/\|/g, "\\|");
        // Newlines inside cells become <br> (markdown tables are single-line)
        content = content.replace(/\n+/g, "<br>");
        cells.push(content);
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length === 0) return "";
    const headerCount = rows[0].length;
    const out: string[] = [];
    out.push("| " + rows[0].join(" | ") + " |");
    out.push("|" + " --- |".repeat(headerCount));
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i].slice(0, headerCount);
      while (cells.length < headerCount) cells.push("");
      out.push("| " + cells.join(" | ") + " |");
    }
    return out.join("\n");
  });
}

/** Read local frontmatter (between `---\n` and `\n---\n`) and stitch it onto
 *  the pulled body. If the local file has no frontmatter, the pulled body
 *  becomes the whole file. */
function mergeWithLocalFrontmatter(localAbsPath: string, pulledBody: string): string {
  if (!fs.existsSync(localAbsPath)) return pulledBody;
  const local = fs.readFileSync(localAbsPath, "utf-8");
  const fmMatch = local.match(/^---\n[\s\S]*?\n---\n/);
  if (!fmMatch) return pulledBody;
  return fmMatch[0] + "\n" + pulledBody.replace(/^\n+/, "");
}

/** Read the existing frontmatter block (between `^---\n` and `\n---\n`) as
 *  a raw string. Returns null if the file has no frontmatter or doesn't exist.
 *  Cheap regex split — we don't parse YAML, just locate fields by line. */
function readLocalFrontmatterBlock(localAbsPath: string): string | null {
  if (!fs.existsSync(localAbsPath)) return null;
  const local = fs.readFileSync(localAbsPath, "utf-8");
  const fmMatch = local.match(/^---\n[\s\S]*?\n---\n/);
  return fmMatch ? fmMatch[0] : null;
}

/** Pull a top-level scalar value from a frontmatter block by key (e.g. `icon`). */
function getFrontmatterField(fm: string, key: string): string | null {
  const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, ""); // strip optional quotes
}

/** Replace or insert a top-level scalar field in a frontmatter block. */
function setFrontmatterField(fm: string, key: string, value: string): string {
  const re = new RegExp(`^${key}:\\s*.*$`, "m");
  if (re.test(fm)) return fm.replace(re, `${key}: ${value}`);
  // Insert before the closing `---\n`. fm ends with `\n---\n`.
  return fm.replace(/\n---\n$/, `\n${key}: ${value}\n---\n`);
}

/** Render Notion's icon object as a frontmatter-friendly scalar.
 *  Returns null for unknown shapes (custom_emoji, file uploads — out of scope). */
function notionIconToFrontmatter(icon: any): string | null {
  if (!icon) return null;
  if (icon.type === "emoji" && typeof icon.emoji === "string") return icon.emoji;
  if (icon.type === "external" && icon.external?.url) return icon.external.url;
  if (icon.type === "file" && icon.file?.url) return icon.file.url;
  return null;
}

/** Render Notion's cover object as a frontmatter-friendly URL. */
function notionCoverToFrontmatter(cover: any): string | null {
  if (!cover) return null;
  if (cover.type === "external" && cover.external?.url) return cover.external.url;
  if (cover.type === "file" && cover.file?.url) return cover.file.url;
  return null;
}

/** Returns true if `git status --porcelain <localPath>` is empty AND the path
 *  is in a git repo. Returns true also if git is not installed (we don't want
 *  git's absence to block reconciliation entirely). Errors lean permissive
 *  with a console warning so the user can see what we couldn't check. */
async function gitStatusClean(localAbsPath: string): Promise<{ clean: boolean; reason: string }> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain", "--", localAbsPath], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) return { clean: true, reason: "git not in a repo or unavailable — skipping check" };
    return out.trim() === ""
      ? { clean: true, reason: "" }
      : { clean: false, reason: out.trim() };
  } catch {
    return { clean: true, reason: "git not installed — skipping check" };
  }
}

interface PullArgs {
  notion: Client;
  state: SyncStateFile;
  page: ProtectedPage;
  forcePull: boolean;
  acceptLossy: boolean;
  inlineDiff: boolean;
}

/**
 * Top-level pull. Returns the absolute local path on success, or throws with
 * a user-facing error message describing what went wrong. Caller is expected
 * to update baseline + print follow-up hints.
 */
async function pullPageToLocal(args: PullArgs): Promise<{ localAbsPath: string; result: PullResult; baselineRefreshed: boolean }> {
  const { notion, state, page, forcePull, acceptLossy } = args;
  const docsDir = process.env.DOCS_DIR ?? path.join(__dirname, "docs");
  const localAbsPath = path.join(docsDir, page.path);

  // 1. Pre-flight: git status. Refuse if dirty unless --force-pull.
  const git = await gitStatusClean(localAbsPath);
  if (!git.clean && !forcePull) {
    throw new Error(
      `Local file has uncommitted changes:\n      ${git.reason.split("\n").map(l => "      " + l).join("\n").trim()}\n` +
      `      Commit or stash first, or pass --force-pull to overwrite anyway.`,
    );
  }

  // 2. Fetch Notion's markdown.
  const pageId = page_id_from(page);
  const result = await pullPageMarkdownRaw(notion, pageId);

  // 3. Truncation is fatal — never write a partial body.
  if (result.truncated) {
    throw new Error(
      `Notion's markdown export was truncated for this page (too large). ` +
      `Resolve in Notion's UI or split the page; pull is not safe.`,
    );
  }

  // 4. Lossy round-trip warning.
  if (result.unknown_block_ids.length > 0 && !acceptLossy) {
    throw new Error(
      `Notion couldn't serialize ${result.unknown_block_ids.length} block(s) as markdown ` +
      `— content from those blocks will be missing from the local file. ` +
      `Pass --accept-lossy-pull to override, or resolve in Notion's UI.\n` +
      `      Affected block ids: ${result.unknown_block_ids.slice(0, 5).join(", ")}${result.unknown_block_ids.length > 5 ? ", …" : ""}`,
    );
  }

  // 5. Transform: strip our footer/banner, convert mention tags.
  let body = result.markdown;
  body = stripSyncFooter(body);
  body = stripBreadcrumbAndBanner(body);
  body = convertMentionTagsToLinks(body);
  body = convertHtmlTablesToMarkdown(body);

  // 5b. Frontmatter merge with optional icon/cover prompt.
  //
  // Notion stores icon and cover as page metadata, not in the markdown
  // body. If the local file's frontmatter has a different icon/cover
  // than what's currently on the Notion page (e.g. a teammate set a
  // new emoji in the UI), prompt before silently discarding the human's
  // change. Default keeps local — matches existing v1.3 behavior; the
  // prompt only fires when there's a real divergence.
  let fm = readLocalFrontmatterBlock(localAbsPath);
  const pageMetaForFm: any = await notion.pages.retrieve({ page_id: pageId }).catch(() => null);
  if (fm && pageMetaForFm) {
    const notionIcon = notionIconToFrontmatter(pageMetaForFm.icon);
    const notionCover = notionCoverToFrontmatter(pageMetaForFm.cover);
    const localIcon = getFrontmatterField(fm, "icon");
    const localCover = getFrontmatterField(fm, "cover");
    if (notionIcon && notionIcon !== localIcon) {
      console.log(c.dim(`       Frontmatter divergence — icon: ${c.yellow(localIcon ?? "(none)")} (local) vs ${c.yellow(notionIcon)} (Notion)`));
      const useNotion = await confirmYN(`       Use Notion's icon "${notionIcon}"?`, false);
      if (useNotion) {
        fm = setFrontmatterField(fm, "icon", notionIcon);
        console.log(c.green(`       ✓ icon updated to Notion's value`));
      }
    }
    if (notionCover && notionCover !== localCover) {
      console.log(c.dim(`       Frontmatter divergence — cover: ${c.yellow(localCover ?? "(none)")} (local) vs ${c.yellow(notionCover)} (Notion)`));
      const useNotion = await confirmYN(`       Use Notion's cover URL?`, false);
      if (useNotion) {
        fm = setFrontmatterField(fm, "cover", notionCover);
        console.log(c.green(`       ✓ cover updated to Notion's value`));
      }
    }
  }

  // 5c. Stitch frontmatter onto the pulled body.
  const merged = fm
    ? fm + "\n" + body.replace(/^\n+/, "")
    : body;

  // 6. Atomic write: tmp + rename.
  if (!fs.existsSync(path.dirname(localAbsPath))) {
    fs.mkdirSync(path.dirname(localAbsPath), { recursive: true });
  }
  const tmp = `${localAbsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, merged, "utf-8");
  fs.renameSync(tmp, localAbsPath);

  // 7. Post-pull baseline refresh — close the concurrent-edit window. Notion's
  //    last_edited_time may have advanced between our retrieveMarkdown and now;
  //    record what's on the page right now as the new baseline. Reuses
  //    pageMetaForFm if step 5b fetched it; otherwise re-fetches.
  let baselineRefreshed = false;
  try {
    const meta: any = pageMetaForFm ?? await notion.pages.retrieve({ page_id: pageId });
    if (meta && state.pages[page.path]) {
      state.pages[page.path].last_pushed_edited_time = meta.last_edited_time;
      state.pages[page.path].last_pushed_at = new Date().toISOString();
      saveState(state);
      baselineRefreshed = true;
    }
  } catch (err: any) {
    // Non-fatal: file was pulled, just couldn't update baseline. The next sync
    // will see drift and re-flag, which is acceptable.
    console.error(c.yellow(`  ⚠ Pulled file but could not refresh baseline: ${err.message?.slice(0, 80)}. Next sync will re-flag.`));
  }

  return { localAbsPath, result, baselineRefreshed };
}

/** Show the diff between what was on local before pull and what's now there.
 *  Default: shell out to `git diff --no-index`. With --inline-diff: simple
 *  gum-rendered side-by-side line diff. */
async function showDiff(originalAbsPath: string, originalSnapshot: string | null, useInline: boolean): Promise<void> {
  if (originalSnapshot == null) {
    console.log(c.dim(`       (no pre-pull content to diff against — file was new)`));
    return;
  }
  // Write the snapshot to a tempfile and run `git diff --no-index`.
  const snap = `${originalAbsPath}.pre-pull.tmp`;
  fs.writeFileSync(snap, originalSnapshot, "utf-8");
  try {
    if (!useInline) {
      const proc = Bun.spawn(
        ["git", "--no-pager", "diff", "--no-index", "--color=always", snap, originalAbsPath],
        { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
      );
      await proc.exited;
      // git diff --no-index returns 1 when files differ — that's normal here.
    } else {
      // Minimal inline fallback — just print + and - lines. Good enough; a
      // real side-by-side renderer is out of scope for v1.
      const a = originalSnapshot.split("\n");
      const b = fs.readFileSync(originalAbsPath, "utf-8").split("\n");
      const max = Math.max(a.length, b.length);
      for (let i = 0; i < max; i++) {
        if (a[i] === b[i]) continue;
        if (a[i] !== undefined) console.log(c.red(`- ${a[i]}`));
        if (b[i] !== undefined) console.log(c.green(`+ ${b[i]}`));
      }
    }
  } finally {
    if (fs.existsSync(snap)) fs.unlinkSync(snap);
  }
}

// ── Resolution application ──────────────────────────────────────────────────
//
// PR 2 wires up the state-only mutations and prints the bash commands for
// the push paths. PR 3 implements the pull path.

interface ApplyContext {
  notion: Client;
  state: SyncStateFile;
  page: ProtectedPage;
  kinds: DivergenceKind[];
  dryRun: boolean;
  forcePull: boolean;
  acceptLossy: boolean;
  inlineDiff: boolean;
}

interface ApplyResult {
  mutatedState: boolean;          // saveState() should be called
  needsCommand: string | null;    // shell command to run as follow-up
  warning: string | null;         // user-visible warning (e.g. "edits will be lost")
  pulled: boolean;                // PR 3: true if local file was overwritten by pull
}

async function applyResolution(
  choice: ResolutionChoice,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  const { notion, state, page, dryRun } = ctx;
  const empty: ApplyResult = { mutatedState: false, needsCommand: null, warning: null, pulled: false };

  if (choice === "skip" || choice === "auto" || choice === "view-diff") return empty;

  if (choice === "accept-move") {
    // Update baseline.expected_parent_id to the current Notion parent (the
    // value that triggered the "moved" divergence — Divergence.current).
    // We don't have the live Divergence here; pull current parent from
    // notion.pages.retrieve to be safe.
    if (!state.pages[page.path]) {
      return { ...empty, warning: `No baseline recorded for ${page.path} — accept-move has no effect` };
    }
    if (dryRun) return { ...empty, warning: "[dry-run] would refresh baseline (parent + last_edited_time + block_count) from current Notion state" };
    try {
      const meta: any = await notion.pages.retrieve({ page_id: page_id_from(page) });
      const newParent = meta.parent?.page_id;
      if (!newParent) return { ...empty, warning: `Could not resolve current parent for ${page.path}` };
      // Refresh the FULL baseline — not just the parent. The accept-move
      // intent is "the current Notion state is the new truth", which means
      // last_edited_time should advance too (otherwise the next sync will
      // surface a benign-drift soft warning on top of an already-resolved
      // divergence). saveState writes atomically.
      state.pages[page.path].expected_parent_id = newParent;
      state.pages[page.path].last_pushed_edited_time = meta.last_edited_time;
      state.pages[page.path].last_pushed_at = new Date().toISOString();
      saveState(state);
      return { ...empty, mutatedState: true };
    } catch (err: any) {
      return { ...empty, warning: `accept-move failed: ${err.message?.slice(0, 80)}` };
    }
  }

  if (choice === "accept-archive") {
    // Drop the doc from sync-state, then optionally drop the local file too.
    // Default keeps the local file (safe — git history recovers it) but
    // offers the prompt so users don't have to break out of the flow.
    if (!state.pages[page.path]) {
      return { ...empty, warning: `No baseline recorded for ${page.path} — accept-archive has no effect` };
    }
    if (dryRun) return { ...empty, warning: "[dry-run] would drop baseline + (with confirmation) delete local file" };
    delete state.pages[page.path];
    saveState(state);

    const docsDir = process.env.DOCS_DIR ?? path.join(__dirname, "docs");
    const localAbsPath = path.join(docsDir, page.path);
    let deletedLocal = false;
    if (fs.existsSync(localAbsPath)) {
      const wantDelete = await confirmYN(
        `       Notion page archived. Also delete the local file (docs/${page.path})?`,
        false,
      );
      if (wantDelete) {
        try {
          fs.unlinkSync(localAbsPath);
          deletedLocal = true;
          console.log(c.green(`       ✓ Deleted ${path.relative(process.cwd(), localAbsPath)}`));
        } catch (err: any) {
          console.error(c.yellow(`       ⚠ Could not delete local file: ${err.message?.slice(0, 80)}`));
        }
      }
    }

    return {
      ...empty,
      mutatedState: true,
      warning: deletedLocal
        ? `Baseline dropped and local file deleted. Commit the deletion when ready.`
        : `Baseline dropped. Local file ${page.path} preserved. Run \`git rm docs/${page.path}\` to remove it later.`,
    };
  }

  if (choice === "force-overwrite") {
    // No state mutation here — the bash command does the work and the
    // post-push baseline record clears the divergence on its own.
    const only = path.basename(page.path, ".md");
    return {
      ...empty,
      needsCommand: `bash sync.sh --no-wizard --only ${only} --force-overwrite ${page.path}`,
    };
  }

  if (choice === "move-back" || choice === "force-recreate") {
    // CRITICAL data-loss guard (per OVERWRITE-GUARDRAILS-EXPLORATION review):
    // re-check user-edited before queuing the destructive command. If a human
    // edited the page after moving it, blindly re-parenting + force-overwrite
    // would silently lose the edit.
    if (!dryRun) {
      try {
        const baseline = state.pages[page.path];
        if (baseline) {
          const userEdit = await recheckUserEdited({
            notion,
            state,
            relPath: page.path,
            pageId: page_id_from(page),
            expectedParentId: baseline.expected_parent_id,
          });
          if (userEdit) {
            return {
              ...empty,
              warning:
                `⚠ Human edit detected on this page — ${userEdit.detail}.\n` +
                `   "${choice}" would overwrite those edits. Re-run reconcile and pick "Pull Notion → local" first, ` +
                `or pass --force-pull to acknowledge.`,
            };
          }
        }
      } catch {
        // Don't block on a transient retrieve error — surface a softer warning.
        return {
          ...empty,
          warning: `Could not re-check for human edits before "${choice}". Verify the page in Notion before re-running sync.`,
          needsCommand: queueCommand(choice, page),
        };
      }
    }
    return { ...empty, needsCommand: queueCommand(choice, page) };
  }

  if (choice === "pull") {
    if (dryRun) {
      return { ...empty, warning: "[dry-run] would fetch Notion markdown, strip footer/banner, convert mention tags, merge frontmatter, atomic-write to local, refresh baseline." };
    }
    try {
      const { localAbsPath, result, baselineRefreshed } = await pullPageToLocal({
        notion, state, page,
        forcePull: ctx.forcePull,
        acceptLossy: ctx.acceptLossy,
        inlineDiff: ctx.inlineDiff,
      });
      const lossyNote = result.unknown_block_ids.length > 0
        ? ` (${result.unknown_block_ids.length} block(s) couldn't be serialized — content may be incomplete)`
        : "";
      return {
        ...empty,
        pulled: true,
        mutatedState: baselineRefreshed,
        warning: `Pulled to ${path.relative(process.cwd(), localAbsPath)}${lossyNote}. Inspect with \`git diff -- ${path.relative(process.cwd(), localAbsPath)}\` before re-running sync.`,
      };
    } catch (err: any) {
      return { ...empty, warning: `Pull failed: ${err.message}` };
    }
  }

  return empty;
}

function page_id_from(page: ProtectedPage): string {
  // notion_url has the form https://www.notion.so/<32-hex>
  const m = page.notion_url.match(/([a-f0-9]{32})/i);
  if (!m) throw new Error(`Could not parse page id from notion_url: ${page.notion_url}`);
  // Reformat as UUID: 8-4-4-4-12
  const h = m[1];
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function queueCommand(choice: ResolutionChoice, page: ProtectedPage): string {
  const only = path.basename(page.path, ".md");
  if (choice === "move-back" || choice === "force-recreate") {
    return `bash sync.sh --no-wizard --only ${only} --force-overwrite ${page.path}`;
  }
  return `# unhandled choice: ${choice}`;
}

// ── Per-divergence menu ──────────────────────────────────────────────────────
//
// Each kind defines its own option set. The keys are stable resolution
// identifiers; the human-readable strings are what gum displays.

interface MenuOption {
  label: string;
  choice: ResolutionChoice;
}

function menuFor(kinds: DivergenceKind[]): MenuOption[] {
  // Composed menu: include relevant options for ALL kinds present. Order matters
  // — most "informative" first (View diff, then conservative picks, then
  // destructive picks, then skip + back).
  const opts: MenuOption[] = [];
  if (kinds.includes("user-edited")) {
    opts.push({ label: "View diff first",                       choice: "view-diff" });
    opts.push({ label: "Pull Notion → local (preserve edits)",  choice: "pull" });
    opts.push({ label: "Keep local — overwrite Notion",         choice: "force-overwrite" });
  }
  if (kinds.includes("moved")) {
    opts.push({ label: "Accept the move",                       choice: "accept-move" });
    opts.push({ label: "Move it back to expected parent",       choice: "move-back" });
  }
  if (kinds.includes("moved-out")) {
    opts.push({ label: "Accept — this doc is no longer ours",   choice: "accept-move" });
    opts.push({ label: "Re-create at original location",        choice: "force-recreate" });
  }
  if (kinds.includes("archived")) {
    opts.push({ label: "Accept the archive (drop from sync)",   choice: "accept-archive" });
    opts.push({ label: "Force-recreate at original location",   choice: "force-recreate" });
  }
  // Always-available navigation:
  opts.push({ label: "Skip — leave protected, decide later",    choice: "skip" });
  opts.push({ label: "← Back to previous page",                 choice: "back" });
  opts.push({ label: "✗ Cancel reconciliation",                 choice: "cancel" });
  return opts;
}

// ── Page card renderer ───────────────────────────────────────────────────────

function getDetails(p: ProtectedPage): string[] {
  if (p.details && p.details.length > 0) return p.details;
  if (p.detail) return [p.detail];
  return [];
}

function renderCard(page: ProtectedPage, idx: number, total: number): string {
  const kinds = getKinds(page);
  const details = getDetails(page);
  const kindBadge = kinds.map(k => {
    switch (k) {
      case "user-edited":  return c.red("✎ edited by human");
      case "moved":        return c.yellow("→ moved");
      case "moved-out":    return c.yellow("⤴ moved outside synced root");
      case "archived":     return c.red("✗ archived");
      case "benign-drift": return c.dim("· drift (benign)");
      default:             return c.dim("? " + k);
    }
  }).join("  ");
  const lines = [
    c.dim("─".repeat(70)),
    `${c.bold(`[${idx + 1}/${total}]`)} ${c.bold(page.path)}`,
    `       ${kindBadge}`,
  ];
  for (const d of details) lines.push(`       ${c.dim("Detail:")}  ${d}`);
  lines.push(`       ${c.dim("View:")}    ${c.url(page.notion_url)}`);
  lines.push("");
  return lines.join("\n");
}

// ── Main flow ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n${c.bold("Notion Reconciliation")} ${dryRun ? c.dim("[dry run]") : ""}`);
  console.log(c.dim("─".repeat(70)));

  // Notion client + sync state are initialized lazily — only fetched when the
  // user picks a resolution that needs them. ensureBotId is needed for the
  // user-edited re-check inside move-back/force-recreate.
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  if (!NOTION_TOKEN) {
    console.error(c.red("\n  NOTION_TOKEN is not set. Source .env first.\n"));
    process.exit(2);
  }
  const notion = new Client({ auth: NOTION_TOKEN });
  const state = loadState();
  if (!state.bot_id) {
    try { await ensureBotId(notion, state); }
    catch (err: any) { console.error(c.yellow(`  ⚠ Could not fetch bot id: ${err.message}. Live re-check will be skipped.`)); }
  }

  const lastRun = readLastLiveRun();
  if (!lastRun) {
    console.log(c.yellow("\n  No live (non-dry-run) sync found in the last " + MAX_LOOKBACK + " runs."));
    console.log(c.dim("  Run a sync first, then re-run reconcile.\n"));
    process.exit(0);
  }

  console.log(`\n${c.dim("Reading last live run:")} ${lastRun.run_id}  ${c.dim(`(${lastRun.ts})`)}`);
  console.log(`${c.dim("Guardrails mode:")}      ${lastRun.guardrails_mode ?? "(unset)"}`);

  const allProtected = (lastRun.protected_pages ?? []).filter(p => pathMatches(pathFilters, p.path));
  if (allProtected.length === 0) {
    if (pathFilters.length > 0) {
      console.log(c.yellow(`\n  No protected pages match filter: ${pathFilters.join(", ")}\n`));
    } else {
      console.log(c.green("\n  ✓ Nothing to reconcile — last run had no protected pages.\n"));
    }
    process.exit(0);
  }

  console.log(`${c.dim("Protected pages:")}      ${allProtected.length}`);

  // Live re-check — runs.jsonl is append-only, so a previous reconcile run
  // that resolved a page still leaves the entry in the log. Re-check each
  // page against current Notion state to filter out already-resolved ones,
  // and to update kinds/details if the page has drifted further since the
  // last sync (concurrent-edit window). Read-only — runs in --dry-run too.
  if (state.bot_id) {
    process.stdout.write(c.dim("Re-checking live state... "));
    const stillDiverged: ProtectedPage[] = [];
    let resolvedCount = 0;
    for (const p of allProtected) {
      const baseline = state.pages[p.path];
      if (!baseline) {
        // No baseline at all — likely accepted-archive previously, or never
        // baselined. Skip silently.
        resolvedCount++;
        continue;
      }
      try {
        const live = await checkDivergence({
          notion,
          state,
          relPath: p.path,
          pageId: page_id_from(p),
          expectedParentId: baseline.expected_parent_id,
        });
        const blocking = live.filter((d) => d.kind !== "benign-drift");
        if (blocking.length === 0) {
          resolvedCount++;
          continue;
        }
        // Replace the runs.jsonl-derived snapshot with the LIVE divergence
        // set — kinds may have changed (e.g. someone edited after the
        // sync), and we always want to act on current state.
        stillDiverged.push({
          path: p.path,
          kinds: blocking.map((d) => d.kind),
          details: blocking.map((d) => d.detail),
          notion_url: p.notion_url,
        });
      } catch (err: any) {
        // Network or retrieve error — keep the runs.jsonl snapshot, warn.
        console.error(c.yellow(`\n  ⚠ Could not re-check ${p.path}: ${err.message?.slice(0, 80)}`));
        stillDiverged.push(p);
      }
    }
    console.log(c.dim(`${stillDiverged.length} still diverged${resolvedCount > 0 ? `, ${resolvedCount} already resolved` : ""}`));

    if (stillDiverged.length === 0) {
      console.log(c.green(`\n  ✓ Nothing to reconcile — all ${allProtected.length} previously-protected page(s) are now in sync.\n`));
      process.exit(0);
    }
    // Replace the queue with the live-checked subset.
    allProtected.length = 0;
    allProtected.push(...stillDiverged);
  }

  // Top-of-flow checkbox: which pages to resolve in this session.
  const useGum = await gumAvailable();
  let queue: ProtectedPage[] = allProtected;
  if (allProtected.length > 1 && useGum) {
    const labels = allProtected.map(p => `${p.path} (${getKinds(p).join("+")})`);
    const picked = await gumChooseMulti("Pick pages to reconcile (space to toggle, enter to confirm):", labels, true);
    if (picked === null) { console.log(c.dim("\n  Cancelled.\n")); process.exit(130); }
    queue = allProtected.filter((_, i) => picked.includes(labels[i]));
    if (queue.length === 0) { console.log(c.dim("\n  Nothing selected. Exiting.\n")); process.exit(0); }
  }

  // Sequential walk with ← back navigation.
  const resolutions: Resolution[] = new Array(queue.length).fill(null).map((_, i) => ({
    page: queue[i],
    choice: "skip" as ResolutionChoice,
    applied: false,
  }));
  const pendingCommands: { path: string; choice: ResolutionChoice; command: string }[] = [];

  let i = 0;
  while (i < queue.length) {
    const page = queue[i];
    const kinds = getKinds(page);
    if (kinds.length === 0) {
      console.log(c.yellow(`  [${i + 1}/${queue.length}] ${page.path} — unknown divergence kind, skipping`));
      i++; continue;
    }

    console.log("\n" + renderCard(page, i, queue.length));

    // benign-drift auto-resolves with no prompt.
    if (kinds.length === 1 && kinds[0] === "benign-drift") {
      console.log(c.dim("       (benign — auto-resolved on next sync; no action needed)"));
      resolutions[i] = { page, choice: "auto", applied: false };
      i++; continue;
    }

    const opts = menuFor(kinds);
    // Hide ← Back on the first page.
    const optsForThisPage = i === 0 ? opts.filter(o => o.choice !== "back") : opts;
    const labels = optsForThisPage.map(o => o.label);

    const pick = useGum
      ? await gumChoose("       What would you like to do?", labels)
      : await readlineChoose("       What would you like to do?", labels);
    if (pick === null) {
      console.log(c.dim("\n  Cancelled.\n")); process.exit(130);
    }
    const matched = optsForThisPage.find(o => o.label === pick);
    if (!matched) {
      console.log(c.yellow(`       Unrecognized option: "${pick}" — skipping`));
      resolutions[i] = { page, choice: "skip", applied: false };
      i++; continue;
    }

    if (matched.choice === "cancel") {
      console.log(c.dim("\n  Cancelled.\n")); process.exit(0);
    }
    if (matched.choice === "back") {
      i = Math.max(0, i - 1);
      continue;
    }
    if (matched.choice === "view-diff") {
      // Fetch Notion's markdown, transform identically to pull, but write to
      // a tempfile and diff against current local. No state mutation.
      const docsDir = process.env.DOCS_DIR ?? path.join(__dirname, "docs");
      const localAbsPath = path.join(docsDir, page.path);
      try {
        console.log(c.dim("       Fetching Notion content for diff..."));
        const result = await pullPageMarkdownRaw(notion, page_id_from(page));
        if (result.truncated) {
          console.log(c.yellow(`       ⚠ Notion's export was truncated. Diff will be incomplete.`));
        }
        let body = result.markdown;
        body = stripSyncFooter(body);
        body = stripBreadcrumbAndBanner(body);
        body = convertMentionTagsToLinks(body);
        body = convertHtmlTablesToMarkdown(body);
        const merged = mergeWithLocalFrontmatter(localAbsPath, body);
        const tmp = `${localAbsPath}.notion-preview.tmp`;
        fs.writeFileSync(tmp, merged, "utf-8");

        // Pick which diff tool to use. Auto-detect what's installed; show
        // a sub-menu when interactive. CLI flags pre-select:
        //   --inline-diff → "inline"  (legacy)
        //   RECONCILE_DIFF_TOOL=<x>   (env var; bypasses sub-menu)
        try {
          const envChoice = (process.env.RECONCILE_DIFF_TOOL ?? "").toLowerCase();
          let chosenTool: DiffTool;
          if (inlineDiff) {
            chosenTool = "inline";
          } else if (envChoice === "git" || envChoice === "code" || envChoice === "opendiff" || envChoice === "browser" || envChoice === "inline") {
            chosenTool = envChoice;
          } else if (!fs.existsSync(localAbsPath)) {
            chosenTool = "inline"; // no local file to diff against
          } else {
            const tools = await detectDiffTools();
            // Build labels with ANSI dim'd hints, but resolve the user's
            // pick by matching against the plain label prefix — gum strips
            // ANSI codes from its echoed selection, so labels.indexOf(pick)
            // can't find the original string.
            const labels = tools.map(t => `${t.label}  ${c.dim("· " + t.hint)}`);
            const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
            const useGum = await gumAvailable();
            const pick = useGum
              ? await gumChoose("       View diff with:", labels)
              : await readlineChoose("       View diff with:", labels);
            if (pick === null) {
              chosenTool = "git";
            } else {
              const pickPlain = stripAnsi(pick).trim();
              const matched = tools.find(t => pickPlain.startsWith(t.label));
              chosenTool = matched ? matched.tool : "git";
            }
          }
          const diffResult = await renderDiffWith(chosenTool, localAbsPath, tmp, merged);
          // If browser merge mode wrote the local file, treat as a full
          // resolution: refresh the baseline so the next sync sees no
          // divergence, record as a "pull"-equivalent resolution, and
          // advance to the next page (skip the menu re-prompt).
          if (diffResult.savedMerge) {
            try {
              const baseline = state.pages[page.path];
              if (baseline) {
                const meta: any = await notion.pages.retrieve({ page_id: page_id_from(page) });
                baseline.last_pushed_edited_time = meta.last_edited_time;
                baseline.last_pushed_at = new Date().toISOString();
                saveState(state);
                console.log(c.green(`       ✓ Baseline refreshed; page resolved.`));
              }
            } catch (err: any) {
              console.error(c.yellow(`       ⚠ Could not refresh baseline: ${err.message?.slice(0, 80)}. Next sync will re-flag.`));
            }
            resolutions[i] = { page, choice: "pull", applied: true };
            i++;
            continue;
          }
        } finally {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        }
        console.log(c.dim(`       Diff: ${c.red("local")} → ${c.green("Notion's current state")}`));
      } catch (err: any) {
        console.log(c.yellow(`       ⚠ Could not fetch diff: ${err.message?.slice(0, 100)}`));
      }
      // Stay on this page — re-prompt without advancing i. The loop will
      // re-render the card and re-show the menu.
      continue;
    }

    // Apply the resolution. State mutations land per-page (resumability —
    // Ctrl-C between page 2 and 3 leaves pages 1-2 resolved on disk).
    const applied = await applyResolution(matched.choice, { notion, state, page, kinds, dryRun, forcePull, acceptLossy, inlineDiff });
    if (applied.warning) console.log(c.yellow(`       ${applied.warning}`));
    resolutions[i] = { page, choice: matched.choice, applied: applied.mutatedState || !!applied.needsCommand || !!applied.pulled };
    if (applied.mutatedState) {
      console.log(c.green(`       ✓ Applied: ${matched.choice}  ${c.dim("(state updated)")}`));
    } else if (applied.needsCommand) {
      // Stash the command for the end-of-flow summary
      pendingCommands.push({ path: page.path, choice: matched.choice, command: applied.needsCommand });
      console.log(c.green(`       ✓ Recorded: ${matched.choice}  ${c.dim("(command queued)")}`));
    } else if (applied.warning && (matched.choice === "move-back" || matched.choice === "force-recreate")) {
      // Blocked by user-edit re-check. Don't record as resolved.
      console.log(c.dim(`       (no action taken — re-run reconcile to choose differently)`));
      resolutions[i] = { page, choice: "skip", applied: false };
    } else {
      console.log(c.dim(`       ✓ ${matched.choice}`));
    }
    i++;
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log("\n" + c.bold("Reconciliation summary"));
  console.log(c.dim("─".repeat(70)));

  const grouped: Record<string, Resolution[]> = {};
  for (const r of resolutions) {
    grouped[r.choice] = grouped[r.choice] ?? [];
    grouped[r.choice].push(r);
  }
  for (const [choice, rs] of Object.entries(grouped)) {
    console.log(`\n  ${c.bold(choice)}  ${c.dim(`(${rs.length})`)}`);
    for (const r of rs) console.log(`    ${c.dim("·")} ${r.page.path}`);
  }

  // State mutations have already been applied + saved per-page. The follow-up
  // commands need to be run by the user (print-and-ask pattern, per design Q3).
  const stateMutated = resolutions.some(r => r.applied && (r.choice === "accept-move" || r.choice === "accept-archive"));
  const pulledFiles  = resolutions.filter(r => r.choice === "pull" && r.applied).map(r => r.page.path);

  if (stateMutated) {
    console.log("\n" + c.green("✓ State mutations saved to ") + c.dim(path.relative(process.cwd(), getStatePath())));
  }

  if (pendingCommands.length === 0 && pulledFiles.length === 0) {
    if (!stateMutated) {
      console.log(c.dim("\n  No actionable resolutions. (All pages were skipped or auto-resolved.)\n"));
    }
    return;
  }

  console.log("\n" + c.bold("Next steps — commands to run"));
  console.log(c.dim("─".repeat(70)));

  // Group pendingCommands so force-overwrite/recreate paths can share a single
  // bash invocation (cheaper Phase 1 / 1.5 setup than running per-doc).
  const cmdGrouped: Record<string, string[]> = {};
  for (const cmd of pendingCommands) {
    cmdGrouped[cmd.choice] = cmdGrouped[cmd.choice] ?? [];
    cmdGrouped[cmd.choice].push(cmd.path);
  }

  const overwriteOrRecreate = [...(cmdGrouped["force-overwrite"] ?? []), ...(cmdGrouped["force-recreate"] ?? []), ...(cmdGrouped["move-back"] ?? [])];
  if (overwriteOrRecreate.length > 0) {
    const onlyArgs = overwriteOrRecreate.map(p => path.basename(p, ".md")).join(" ");
    const forceArgs = overwriteOrRecreate.join(" ");
    console.log(`\n  ${c.green("◇")} Push ${overwriteOrRecreate.length} page(s) ${c.dim("(force-overwrite — local content wins)")}:`);
    console.log(`    ${c.dim("$")} bash sync.sh --no-wizard --only ${onlyArgs} --force-overwrite ${forceArgs}`);
  }

  if (pulledFiles.length > 0) {
    console.log(`\n  ${c.green("◇")} ${pulledFiles.length} page(s) pulled from Notion to local files:`);
    for (const p of pulledFiles) console.log(`    ${c.dim("·")} ${p}`);
    console.log(c.dim("\n    Inspect the changes:"));
    console.log(`    ${c.dim("$")} git diff -- ${pulledFiles.map(p => `docs/${p}`).join(" ")}`);
    console.log(c.dim("\n    Then push the merged content:"));
    const onlyArgs = pulledFiles.map(p => path.basename(p, ".md")).join(" ");
    console.log(`    ${c.dim("$")} bash sync.sh --no-wizard --only ${onlyArgs}`);
  }

  console.log("");
}

main()
  .then(() => closeReadline())
  .catch((err: any) => {
    closeReadline();
    console.error(c.red(`\n✗ Reconcile failed: ${err.message ?? err}`));
    if (err.stack) console.error(c.dim(err.stack));
    process.exit(1);
  });

// TODO(future): handle the duplicate-from-archive case — when a page was
// archived in Notion and a previous sync created a fresh duplicate. v1
// just pushes again; the duplicate stays as-is. See
// RECONCILIATION-EXPLORATION.md "Open questions — RESOLVED" #7.
