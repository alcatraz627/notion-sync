/**
 * Sync state — overwrite guardrails for human-edited Notion pages.
 *
 * Maintains `.notion-sync-state.json` (gitignored sidecar) recording, per
 * synced page:
 *   - the page id we created/found
 *   - the parent page id we expect (move detection)
 *   - the last_edited_time Notion reported AFTER our most recent push
 *     (string-equality compare avoids the minute-rounding issue)
 *   - block count at last push
 *   - our local-clock timestamp (diagnostics only)
 *
 * Also caches the integration's bot user id (`notion.users.me().id`) so we
 * can distinguish "we last edited" from "a human last edited."
 *
 * Spec: OVERWRITE-GUARDRAILS-EXPLORATION.md
 */

import { Client } from "@notionhq/client";
import * as fs from "fs";
import * as path from "path";
import { extractPageId } from "./lib/notion";

// ── Types ─────────────────────────────────────────────────────────────────────

export type GuardrailMode = "strict" | "warn" | "off";

export type DivergenceKind = "user-edited" | "moved" | "archived" | "moved-out" | "benign-drift";

export interface PageState {
  page_id: string;
  expected_parent_id: string;
  last_pushed_edited_time: string;
  last_pushed_block_count: number;
  last_pushed_at: string;
}

export interface SyncStateFile {
  version: 1;
  bot_id: string | null;
  bot_id_fetched_at: string | null;
  pages: Record<string, PageState>;
}

export interface Divergence {
  rel_path: string;
  page_id: string;
  kind: DivergenceKind;
  detail: string;
  notion_url: string;
  baseline?: string;
  current?: string;
  edited_by_id?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

// ── Root-keyed paths ─────────────────────────────────────────────────────────
//
// State files (cache, baselines, snapshots) live alongside the project and
// embed the NOTION_ROOT_PAGE_ID in their filename. Swapping the env to a
// different root (V2 target, test sandbox, alternate workspace) automatically
// gets a separate set of state files — no manual backup/restore, no risk of
// cross-contamination. Image cache is intentionally NOT keyed because Notion
// file uploads are workspace-scoped (one sha256 → one upload, reusable across
// every page in the same workspace).
//
// Filename shape: `.notion-sync-state.<12hex>.json` etc.  Twelve hex chars
// of the root page-id is short enough for `ls` output and unique enough that
// two different roots in the same project won't ever collide.
//
// Computed on demand (not at module load) so process.env updates from the
// entrypoint's .env parser are visible.

export function getCacheKey(): string {
  // First 12 hex of the root page id — short enough for `ls`, unique enough
  // that two roots won't collide. extractPageId handles every input form
  // (bare / dashed / slug-prefixed / URL ± query). Falls back to "default"
  // when the env is unset or no id can be parsed.
  const id = extractPageId(process.env.NOTION_ROOT_PAGE_ID ?? "");
  return id ? id.slice(0, 12) : "default";
}

function statePath(): string {
  return path.join(__dirname, `.notion-sync-state.${getCacheKey()}.json`);
}

function snapshotsDir(): string {
  return path.join(__dirname, `.notion-snapshots.${getCacheKey()}`);
}

// ── Legacy-name migration ────────────────────────────────────────────────────
//
// Prior versions used unkeyed paths (`.notion-sync-state.json` etc). If we
// find a legacy file but no keyed file for the current root, ASSUME the
// legacy file belongs to the current root and rename it in place. One-time
// migration; subsequent runs see only the keyed name.
//
// If BOTH legacy and keyed exist, we trust the keyed (don't overwrite).

const LEGACY_STATE_PATH = path.join(__dirname, ".notion-sync-state.json");
const LEGACY_SNAPSHOTS_DIR = path.join(__dirname, ".notion-snapshots");

function migrateLegacyIfNeeded(): void {
  try {
    const newState = statePath();
    if (fs.existsSync(LEGACY_STATE_PATH) && !fs.existsSync(newState)) {
      fs.renameSync(LEGACY_STATE_PATH, newState);
      console.error(`\x1b[2m  ℹ migrated legacy .notion-sync-state.json → ${path.basename(newState)} (root ${getCacheKey()})\x1b[0m`);
    }
    const newSnaps = snapshotsDir();
    if (fs.existsSync(LEGACY_SNAPSHOTS_DIR) && !fs.existsSync(newSnaps)) {
      fs.renameSync(LEGACY_SNAPSHOTS_DIR, newSnaps);
      console.error(`\x1b[2m  ℹ migrated legacy .notion-snapshots/ → ${path.basename(newSnaps)}/ (root ${getCacheKey()})\x1b[0m`);
    }
  } catch (err: any) {
    console.error(`\x1b[33m  ⚠ legacy state migration failed: ${err.message?.slice(0, 80)}\x1b[0m`);
  }
}

const BOT_ID_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Load / save ──────────────────────────────────────────────────────────────

export function loadState(): SyncStateFile {
  migrateLegacyIfNeeded();
  const sp = statePath();
  if (!fs.existsSync(sp)) {
    return { version: 1, bot_id: null, bot_id_fetched_at: null, pages: {} };
  }
  try {
    const raw = fs.readFileSync(sp, "utf-8");
    const parsed = JSON.parse(raw) as SyncStateFile;
    if (parsed.version !== 1) {
      throw new Error(`unsupported sync-state version: ${parsed.version}`);
    }
    if (!parsed.pages) parsed.pages = {};
    return parsed;
  } catch (err: any) {
    throw new Error(`failed to load .notion-sync-state.json: ${err.message}. Move it aside and re-run with --seed-state.`);
  }
}

export function saveState(state: SyncStateFile): void {
  // Atomic: write to a sibling tempfile, then rename. Avoids torn writes if
  // the process is killed mid-flush. Pattern matches std::claude conventions
  // for single-user JSON state files.
  const sp = statePath();
  const tmp = `${sp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, sp);
}

// ── Bot id ───────────────────────────────────────────────────────────────────

/**
 * Returns our bot user id, fetching from Notion if missing or stale.
 * Mutates `state` and saves it on a refresh.
 */
export async function ensureBotId(notion: Client, state: SyncStateFile, force = false): Promise<string> {
  const cached = state.bot_id;
  const fetchedAt = state.bot_id_fetched_at ? Date.parse(state.bot_id_fetched_at) : 0;
  const stale = !cached || !fetchedAt || Date.now() - fetchedAt > BOT_ID_TTL_MS;

  if (cached && !stale && !force) return cached;

  const me: any = await notion.users.me({});
  if (!me?.id) throw new Error("notion.users.me() returned no id — token may be invalid");
  if (me.type !== "bot") {
    throw new Error(`notion.users.me() returned type=${me.type} — expected "bot". This token is not an integration token.`);
  }
  state.bot_id = me.id;
  state.bot_id_fetched_at = new Date().toISOString();
  saveState(state);
  return me.id;
}

// ── Divergence check ─────────────────────────────────────────────────────────

interface CheckArgs {
  notion: Client;
  state: SyncStateFile;
  relPath: string;
  pageId: string;
  expectedParentId: string;
}

/**
 * Returns ALL applicable divergences for the page. A page can simultaneously
 * be moved AND user-edited — earlier versions early-returned on the first
 * match and silently lost human edits during a move-back. Now returns every
 * detected divergence so the reconcile flow can compose a menu across all of
 * them.
 *
 * Empty array means safe to overwrite. Pages with no recorded baseline (first
 * sync, or after `--seed-state`) also return [] — nothing to compare against.
 *
 * Cost: one `pages.retrieve` call. The caller should batch these
 * (concurrency-respecting the rate limit).
 */
export async function checkDivergence(args: CheckArgs): Promise<Divergence[]> {
  const { notion, state, relPath, pageId, expectedParentId } = args;
  if (!state.bot_id) {
    throw new Error("checkDivergence called before ensureBotId — bot_id is null");
  }
  const baseline = state.pages[relPath];
  if (!baseline) return []; // first push of this doc; nothing to protect

  const meta: any = await notion.pages.retrieve({ page_id: pageId });
  const notionUrl = `https://www.notion.so/${pageId.replace(/-/g, "")}`;
  const divergences: Divergence[] = [];

  // 1. Archived
  if (meta.archived === true || meta.in_trash === true) {
    divergences.push({
      rel_path: relPath,
      page_id: pageId,
      kind: "archived",
      detail: "page is archived/trashed in Notion",
      notion_url: notionUrl,
    });
  }

  // 2. Moved to a parent we don't expect (skip if archived — parent_id of an
  // archived page is unreliable and the archived divergence already covers it).
  // Compare NORMALIZED ids — Notion's API returns dashed UUIDs but our
  // baseline may have stored undashed slugs (e.g. extracted from the
  // NOTION_ROOT_PAGE_ID URL). Same page, different string.
  if (!divergences.some((d) => d.kind === "archived")) {
    const currentParent = meta.parent?.page_id;
    if (currentParent && normalizeId(currentParent) !== normalizeId(expectedParentId)) {
      divergences.push({
        rel_path: relPath,
        page_id: pageId,
        kind: "moved",
        detail: `parent changed from ${shortId(expectedParentId)} → ${shortId(currentParent)}`,
        notion_url: notionUrl,
        baseline: expectedParentId,
        current: currentParent,
      });
    }
  }

  // 3. Edited since baseline (independent of move/archive — caller composes)
  const editedTimeChanged = meta.last_edited_time !== baseline.last_pushed_edited_time;
  if (editedTimeChanged) {
    const editorId = meta.last_edited_by?.id;
    const editedByOther = editorId && editorId !== state.bot_id;
    if (editedByOther) {
      divergences.push({
        rel_path: relPath,
        page_id: pageId,
        kind: "user-edited",
        detail: `edited at ${meta.last_edited_time} by user ${shortId(editorId)} (baseline: ${baseline.last_pushed_edited_time})`,
        notion_url: notionUrl,
        baseline: baseline.last_pushed_edited_time,
        current: meta.last_edited_time,
        edited_by_id: editorId,
      });
    } else if (divergences.length === 0) {
      // Time changed, bot is still last editor, no other divergences — likely
      // a partial prior run or another integration. Soft-warn only when
      // there's nothing else to surface (otherwise it's noise).
      divergences.push({
        rel_path: relPath,
        page_id: pageId,
        kind: "benign-drift",
        detail: `last_edited_time advanced (${baseline.last_pushed_edited_time} → ${meta.last_edited_time}) but last editor is still us — likely a partial prior run`,
        notion_url: notionUrl,
        baseline: baseline.last_pushed_edited_time,
        current: meta.last_edited_time,
      });
    }
  }

  return divergences;
}

/**
 * Lightweight re-check for the user-edited condition only. Used at write-time
 * inside move-back / force-recreate paths to guard against data loss when a
 * page that was originally flagged as `moved` was ALSO edited by a human
 * (and the user picked "move it back" without realising the edit existed).
 *
 * Returns the user-edited Divergence if detected, null otherwise. Cheap:
 * a single pages.retrieve.
 */
export async function recheckUserEdited(args: CheckArgs): Promise<Divergence | null> {
  const all = await checkDivergence(args);
  return all.find((d) => d.kind === "user-edited") ?? null;
}

// ── Record after push ────────────────────────────────────────────────────────

/**
 * After a successful Phase 2 write, retrieve the page and persist the new
 * baseline. The retrieved `last_edited_time` is what subsequent runs compare
 * against — recording our local clock would race against Notion's
 * minute-rounding. Block count is captured as a secondary structural signal.
 *
 * Errors here are non-fatal: we log and continue. A missing record just
 * means the next run won't have a baseline for this doc and will skip
 * the divergence check (as if it were a first push).
 */
export async function recordPageBaseline(
  notion: Client,
  state: SyncStateFile,
  relPath: string,
  pageId: string,
  expectedParentId: string,
  snapshotBody?: string,
): Promise<void> {
  try {
    const meta: any = await notion.pages.retrieve({ page_id: pageId });
    const blocks: any = await notion.blocks.children.list({ block_id: pageId, page_size: 1 });
    // page_size=1 still reports has_more — we don't need an accurate total,
    // just a structural-drift signal. For accuracy use the next field:
    const blockCount = await countBlocks(notion, pageId).catch(() => -1);

    state.pages[relPath] = {
      page_id: pageId,
      expected_parent_id: expectedParentId,
      last_pushed_edited_time: meta.last_edited_time,
      last_pushed_block_count: blockCount,
      last_pushed_at: new Date().toISOString(),
    };
    if (snapshotBody !== undefined) {
      saveSnapshot(relPath, snapshotBody);
    }
  } catch (err: any) {
    // Non-fatal. Surface a warning via stderr; caller continues.
    console.error(`  ⚠ baseline record failed for ${relPath}: ${err.message?.slice(0, 80)}`);
  }
}

// ── Snapshots ────────────────────────────────────────────────────────────────

/**
 * Returns the absolute path where the snapshot for a given doc lives. The
 * snapshot is a verbatim copy of the local file at the moment we last pushed
 * it — the BASE for three-way reconcile diffs.
 *
 * Storage shape mirrors the docs tree: `.notion-snapshots/<relPath>`. Same
 * extension as the source so editors syntax-highlight it.
 */
export function getSnapshotPath(relPath: string): string {
  return path.join(snapshotsDir(), relPath);
}

/** Read the stored snapshot for a doc. Returns null if missing — caller
 *  should degrade to a 2-way diff when no BASE exists (first sync of a doc,
 *  or pre-snapshots state file). */
export function loadSnapshot(relPath: string): string | null {
  const p = getSnapshotPath(relPath);
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

/** Atomic write of a snapshot. Mirrors the .notion-sync-state.json strategy. */
function saveSnapshot(relPath: string, body: string): void {
  const dest = getSnapshotPath(relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, "utf-8");
  fs.renameSync(tmp, dest);
}

export function getSnapshotsDir(): string {
  return snapshotsDir();
}

async function countBlocks(notion: Client, pageId: string): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const res: any = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    n += res.results.length;
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return n;
}

// ── Util ─────────────────────────────────────────────────────────────────────

function shortId(id: string | undefined): string {
  if (!id) return "(unknown)";
  return id.replace(/-/g, "").slice(0, 8);
}

/** Strip dashes + lowercase. Notion's API returns dashed UUIDs, but URL slugs
 *  + page IDs extracted from URLs are typically undashed. Compare normalized. */
function normalizeId(id: string | undefined): string {
  return (id ?? "").replace(/-/g, "").toLowerCase();
}

export function getStatePath(): string {
  return statePath();
}

/**
 * Format a divergence list for terminal display. Returns a multi-line string
 * the caller can `console.log` directly.
 */
export function formatDivergences(
  divergences: Divergence[],
  mode: GuardrailMode,
  c: { warn: (s: string) => string; err: (s: string) => string; dim: (s: string) => string; bold: (s: string) => string; url: (s: string) => string },
): string {
  if (divergences.length === 0) return "";
  // Count by unique path to avoid double-counting a page that has multiple
  // divergence kinds (e.g. moved + user-edited). Also exclude benign-drift
  // — it's a soft warning that doesn't actually block writes, and counting
  // it as "protected" overstates the impact.
  const blockingPaths = new Set(divergences.filter((d) => d.kind !== "benign-drift").map((d) => d.rel_path));
  const blockingCount = blockingPaths.size;
  const verb = mode === "strict" ? "protected" : "flagged";
  const out: string[] = [];
  out.push("");
  if (blockingCount > 0) {
    out.push(c.bold(`🛡  Overwrite guardrails — ${blockingCount} page${blockingCount === 1 ? "" : "s"} ${verb}`));
  } else {
    out.push(c.dim(`🛡  Overwrite guardrails — soft drift on ${divergences.length} page(s); no blocking divergences`));
  }
  out.push("");
  for (const d of divergences) {
    out.push(`  ${c.warn(d.rel_path)}`);
    const arrow = c.dim("    ↳ ");
    switch (d.kind) {
      case "user-edited":
        out.push(`${arrow}${c.err("Edited by human")}  ${c.dim(d.detail)}`);
        out.push(`${arrow}Resolve: ${c.dim(`bash sync.sh --force-overwrite ${d.rel_path}`)}`);
        out.push(`${arrow}      OR: pull human edits back to local first`);
        break;
      case "moved":
        out.push(`${arrow}${c.err("Page moved")}  ${c.dim(d.detail)}`);
        out.push(`${arrow}Resolve: ${c.dim(`bash sync.sh --accept-move ${d.rel_path}`)}`);
        out.push(`${arrow}      OR: move it back in Notion`);
        break;
      case "moved-out":
        out.push(`${arrow}${c.err("Page moved outside synced root")}  ${c.dim(d.detail)}`);
        out.push(`${arrow}Resolve: ${c.dim(`bash sync.sh --accept-move ${d.rel_path}`)} ${c.dim("(or move it back, or remove the local doc)")}`);
        break;
      case "archived":
        out.push(`${arrow}${c.err("Archived in Notion")}  ${c.dim(d.detail)}`);
        out.push(`${arrow}Resolve: ${c.dim(`bash sync.sh --accept-archive ${d.rel_path}`)} ${c.dim("(or un-archive in Notion)")}`);
        break;
      case "benign-drift":
        out.push(`${arrow}${c.warn("Benign drift")}  ${c.dim(d.detail)}`);
        out.push(`${arrow}${c.dim("(soft warning — next push will refresh the baseline)")}`);
        break;
    }
    out.push(`${arrow}View: ${c.url(d.notion_url)}`);
    out.push("");
  }
  return out.join("\n");
}
