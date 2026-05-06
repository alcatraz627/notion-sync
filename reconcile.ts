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
        const merged = mergeWithLocalFrontmatter(localAbsPath, body);
        const tmp = `${localAbsPath}.notion-preview.tmp`;
        fs.writeFileSync(tmp, merged, "utf-8");
        try {
          if (inlineDiff || !fs.existsSync(localAbsPath)) {
            // Inline (no git). Quick line diff.
            const a = fs.existsSync(localAbsPath) ? fs.readFileSync(localAbsPath, "utf-8").split("\n") : [];
            const b = merged.split("\n");
            const max = Math.max(a.length, b.length);
            for (let k = 0; k < max; k++) {
              if (a[k] === b[k]) continue;
              if (a[k] !== undefined) console.log(c.red(`- ${a[k]}`));
              if (b[k] !== undefined) console.log(c.green(`+ ${b[k]}`));
            }
          } else {
            const proc = Bun.spawn(
              ["git", "--no-pager", "diff", "--no-index", "--color=always", localAbsPath, tmp],
              { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
            );
            await proc.exited;
            // git diff exits 1 when files differ — that's normal.
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
