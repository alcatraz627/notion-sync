// index-db.ts — generate the 📇 Doc Index sidecar database on Notion.
//
// Why a separate database, not migrating the actual pages: the leaf pages
// stay where they are (under their section's child_page hierarchy). The
// Index DB is a view-only mirror — one row per leaf doc with metadata
// properties (title, path, section, tags, last_synced, body_chars) plus
// a mention pointing back to the actual page. Existing tree intact, no
// migration risk; Notion's database views give filter/sort/group for free.
//
// Surface: bash list.sh index-db. Auto-creates a 📇 Doc Index database
// under root, or honours NOTION_INDEX_DB_ID. Idempotent on re-run:
// existing rows matched by `path` property are updated in place; new
// docs added; orphaned rows (path no longer exists locally) marked
// stale by clearing last_synced (kept around in case of accidental
// local delete; user can manually sweep).
//
// Design choice: we re-walk DOCS_DIR locally on every run rather than
// trying to incrementalize. The per-row API call is the dominant cost,
// not the local walk; on a 300-doc tree this means ~5 minutes of API
// calls (one upsert per row at 350ms rate limit), which is acceptable
// for a once-per-sync dashboard refresh.

import { Client } from "@notionhq/client";
import * as fs from "fs";
import * as path from "path";

const DB_TITLE = "📇 Doc Index";
const DB_ICON_EMOJI = "📇";

export interface IndexDbCachePage {
  id: string;
  title: string;
  parent_id: string | null;
  url: string;
}

export interface IndexDbCache {
  fetched_at: string;
  root_id: string;
  pages: IndexDbCachePage[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Local frontmatter parser — mirror of index.ts's. Kept inline so this
// module has no import cycle with the sync-time pipeline.
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
  section: string;       // top-level dir, e.g. "frontend", "boring-technical-stuff"
  tags: string[];
  status: string | null; // from frontmatter `status:` if present
  bodyChars: number;
  lastUpdated: string | null; // YYYY-MM-DD from frontmatter `last_updated:` if present
}

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
      // Skip _index.md (section pages — represented by their own row in
      // the tree, not as a leaf in the index DB) and other underscored
      // hidden files.
      if (entry.name.startsWith("_")) continue;
      if (entry.name.endsWith(".claude.md")) continue;
      const raw = fs.readFileSync(abs, "utf8");
      const { meta, body } = parseFrontmatter(raw);
      const title = extractTitle(body, rel);
      const section = rel.split("/")[0] ?? "(root)";
      out.push({
        relPath: rel,
        title,
        section,
        tags: extractTags(meta, body),
        status: meta.status ?? null,
        bodyChars: body.length,
        lastUpdated: meta.last_updated ?? null,
      });
    }
  }
  walk(docsDir, "");
  return out;
}

// Schema for the 📇 Doc Index database. Property names are user-facing
// (visible in the Notion UI as column headers). Notion auto-creates a
// `Name` title property on every new data source; we keep that name
// rather than trying to rename or replace it (the API rejects creating
// a second title property — "Cannot create new title property").
function dbProperties() {
  return {
    Name: { title: {} },
    Path: { rich_text: {} },
    Section: { select: {} },
    Tags: { multi_select: {} },
    Status: { select: {} },
    "Last updated": { date: {} },
    "Body chars": { number: { format: "number" as const } },
    Page: { rich_text: {} }, // mention pill → actual page
  };
}

// Find an existing 📇 Doc Index DB under `rootId`, or create one.
//
// In Notion's v1 API (post-2025) databases own one or more `data_sources`,
// and properties live on the data source — not directly on the database.
// To create rows we need the data_source_id, not the database id.
//
// Returns both ids so callers can use:
//   - database_id when listing children of root or referencing the DB block
//   - data_source_id when creating/querying rows
async function findOrCreateIndexDb(
  notion: Client,
  rootId: string,
  providedDbId: string | undefined,
  rateLimitMs: number,
  log: (msg: string) => void,
): Promise<{ databaseId: string; dataSourceId: string; created: boolean }> {
  // Helper: given a database id, retrieve its first data source id and
  // ensure its property schema matches our expectations. If the data
  // source is missing any of our properties, PATCH them in (cheap; the
  // operation is additive — existing rows keep their data).
  const resolveDataSource = async (dbId: string): Promise<string> => {
    const meta: any = await (notion.databases as any).retrieve({ database_id: dbId });
    await sleep(rateLimitMs);
    const ds = meta?.data_sources;
    if (!Array.isArray(ds) || ds.length === 0) {
      throw new Error(`database ${dbId} has no data_sources — schema may have been wiped`);
    }
    const dsId = ds[0].id;
    // Get current property names; patch missing ones.
    const dsMeta: any = await (notion.dataSources as any).retrieve({ data_source_id: dsId });
    await sleep(rateLimitMs);
    const expected = dbProperties();
    const current = (dsMeta?.properties as Record<string, any>) ?? {};
    const missing: Record<string, any> = {};
    for (const [name, schema] of Object.entries(expected)) {
      if (!current[name]) missing[name] = schema;
    }
    if (Object.keys(missing).length > 0) {
      log(`  patching missing properties on data source: ${Object.keys(missing).join(", ")}`);
      await (notion.dataSources as any).update({
        data_source_id: dsId,
        properties: missing,
      });
      await sleep(rateLimitMs);
    }
    return dsId;
  };

  if (providedDbId) {
    log(`  using configured NOTION_INDEX_DB_ID: ${providedDbId}`);
    const dataSourceId = await resolveDataSource(providedDbId);
    return { databaseId: providedDbId, dataSourceId, created: false };
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
      if (block.type !== "child_database") continue;
      if (block.child_database?.title !== DB_TITLE) continue;
      log(`  found existing index DB: ${block.id}`);
      const dataSourceId = await resolveDataSource(block.id);
      return { databaseId: block.id, dataSourceId, created: false };
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  // Create. v5 needs `initial_data_source: { properties }` — the older
  // top-level `properties` field is silently ignored (the SDK warns
  // "unknownParams: [properties]").
  const created: any = await (notion.databases as any).create({
    parent: { type: "page_id", page_id: rootId },
    icon: { type: "emoji", emoji: DB_ICON_EMOJI },
    title: [{ type: "text", text: { content: DB_TITLE } }],
    initial_data_source: {
      properties: dbProperties(),
    },
  });
  await sleep(rateLimitMs);
  log(`  created index DB: ${created.id}`);
  // The create response includes data_sources[]; first entry is the
  // initial one we just declared.
  const dsList = created?.data_sources;
  if (!Array.isArray(dsList) || dsList.length === 0) {
    // Fallback to retrieve in case the response shape changes again.
    const dataSourceId = await resolveDataSource(created.id);
    return { databaseId: created.id, dataSourceId, created: true };
  }
  return { databaseId: created.id, dataSourceId: dsList[0].id, created: true };
}

// Build a Title → page-id+url map. Index DB rows reference the source
// page via mention; matching is by title (best-effort — duplicate titles
// across different folders fall through; logged at the end).
function buildTitleIndex(cache: IndexDbCache): Map<string, IndexDbCachePage> {
  const out = new Map<string, IndexDbCachePage>();
  // Preserve first-seen for stable matching when titles collide.
  for (const p of cache.pages) {
    if (!out.has(p.title)) out.set(p.title, p);
  }
  return out;
}

// Build the property payload for one row. The `Page` property is a
// rich_text array containing a single mention object — Notion renders
// this as an inline pill that hover-previews the linked page.
function buildRowProps(doc: DocEntry, sourcePageId: string | null): any {
  const props: any = {
    Name: { title: [{ type: "text", text: { content: doc.title } }] },
    Path: { rich_text: [{ type: "text", text: { content: doc.relPath } }] },
    Section: { select: { name: doc.section || "(root)" } },
    Tags: {
      multi_select: doc.tags.map((t) => ({ name: t })),
    },
    Status: doc.status ? { select: { name: doc.status } } : { select: null },
    "Last updated": doc.lastUpdated ? { date: { start: doc.lastUpdated } } : { date: null },
    "Body chars": { number: doc.bodyChars },
  };
  if (sourcePageId) {
    props.Page = {
      rich_text: [{
        type: "mention",
        mention: { type: "page", page: { id: sourcePageId } },
      }],
    };
  } else {
    props.Page = { rich_text: [] };
  }
  return props;
}

// Query existing rows in the DB by Path property. Used to decide between
// create and update. Notion's databases.query is paginated; we collect
// everything since the DB grows roughly with docs/.
async function fetchExistingRows(
  notion: Client,
  dataSourceId: string,
  rateLimitMs: number,
): Promise<Map<string, string>> {
  const byPath = new Map<string, string>(); // path → page_id (row id)
  let cursor: string | undefined;
  do {
    const res: any = await (notion.dataSources as any).query({
      data_source_id: dataSourceId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    await sleep(rateLimitMs);
    for (const row of res.results as any[]) {
      const pathProp = row.properties?.Path?.rich_text;
      const path = Array.isArray(pathProp) && pathProp.length > 0 ? pathProp[0].plain_text : null;
      if (path) byPath.set(path, row.id);
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return byPath;
}

// Linear-backoff retry for transient 5xx — same pattern as sitemap.ts.
async function withRetry<T>(label: string, fn: () => Promise<T>, log: (msg: string) => void, maxAttempts = 4): Promise<T> {
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

export interface GenerateIndexDbResult {
  database_id: string;
  database_was_created: boolean;
  total_docs: number;
  rows_created: number;
  rows_updated: number;
  rows_unchanged: number; // (kept for forward-compat; v1 always upserts)
  rows_orphaned: number;
  unmatched_to_page: number;
}

export async function generateIndexDb(opts: {
  notion: Client;
  cache: IndexDbCache;
  docsDir: string;
  databaseId?: string;
  rateLimitMs: number;
  log?: (msg: string) => void;
}): Promise<GenerateIndexDbResult> {
  const { notion, cache, docsDir, databaseId, rateLimitMs } = opts;
  const log = opts.log ?? (() => {});

  log(`\nWalking ${docsDir} for index DB rows…`);
  const docs = walkDocs(docsDir);
  log(`  found ${docs.length} leaf docs`);

  const titleIndex = buildTitleIndex(cache);
  let unmatched = 0;
  for (const d of docs) {
    if (!titleIndex.has(d.title)) unmatched++;
  }
  if (unmatched > 0) {
    log(`  ${unmatched} doc${unmatched === 1 ? "" : "s"} couldn't be matched to a Notion page (will render without a page mention)`);
  }

  const { databaseId: dbId, dataSourceId, created } = await findOrCreateIndexDb(
    notion, cache.root_id, databaseId, rateLimitMs, log,
  );

  log(`  fetching existing rows…`);
  const existingByPath = created
    ? new Map<string, string>()
    : await fetchExistingRows(notion, dataSourceId, rateLimitMs);
  log(`  ${existingByPath.size} existing row${existingByPath.size === 1 ? "" : "s"}`);

  const localPaths = new Set(docs.map((d) => d.relPath));
  let rowsCreated = 0;
  let rowsUpdated = 0;
  let rowsOrphaned = 0;
  let n = 0;

  for (const doc of docs) {
    n++;
    const sourcePage = titleIndex.get(doc.title);
    const props = buildRowProps(doc, sourcePage?.id ?? null);
    const existingRowId = existingByPath.get(doc.relPath);
    if (existingRowId) {
      await withRetry(
        `update ${doc.relPath}`,
        () => notion.pages.update({ page_id: existingRowId, properties: props }),
        log,
      );
      rowsUpdated++;
    } else {
      await withRetry(
        `create ${doc.relPath}`,
        () => notion.pages.create({
          parent: { type: "data_source_id", data_source_id: dataSourceId } as any,
          properties: props,
        }),
        log,
      );
      rowsCreated++;
    }
    await sleep(rateLimitMs);
    if (n % 25 === 0 || n === docs.length) {
      log(`  [${n}/${docs.length}] ${rowsCreated} created · ${rowsUpdated} updated`);
    }
  }

  // Orphaned rows: existing in DB but no longer in DOCS_DIR. Don't delete
  // by default (could be accidental local removal) — clear last_updated to
  // mark stale. User can sweep manually via Notion's filter.
  for (const [orphPath, orphRowId] of existingByPath) {
    if (localPaths.has(orphPath)) continue;
    await withRetry(
      `orphan ${orphPath}`,
      () =>
        notion.pages.update({
          page_id: orphRowId,
          properties: { "Last updated": { date: null } },
        }),
      log,
    );
    await sleep(rateLimitMs);
    rowsOrphaned++;
  }
  if (rowsOrphaned > 0) {
    log(`  ${rowsOrphaned} orphaned row${rowsOrphaned === 1 ? "" : "s"} (not in local docs anymore — flagged, not deleted)`);
  }

  return {
    database_id: dbId,
    database_was_created: created,
    total_docs: docs.length,
    rows_created: rowsCreated,
    rows_updated: rowsUpdated,
    rows_unchanged: 0,
    rows_orphaned: rowsOrphaned,
    unmatched_to_page: unmatched,
  };
}
