// One-off path-based comparator for the Apr-30 audit.
// NOT a persistent CLI — lives alongside its output files for reproducibility.
//
// Reads:
//   01-notion-cache.json   (snapshot of remote at analysis time)
//   ../docs/               (local docs tree, via DOCS_DIR or default)
//
// Writes (via the run script that wraps this):
//   04-path-diff.json   structured comparison data
//   05-summary.txt      human-readable summary
//
// Method:
//   1. Notion side — walk pages via parent_id to compute full path-from-root.
//   2. Local side — walk DOCS_DIR for every .md file, compute relative path.
//   3. Match by normalized path (lowercased segments, _index.md handled).
//      A leaf doc `boring-technical-stuff/frontend/card.md` matches a Notion
//      page at path `Boring-technical-stuff / Frontend / Card — Content...`
//      via segment-prefix lookup: parent path matches, then leaf title is
//      treated as the "Notion equivalent" of the local title.

import * as fs from "fs";
import * as path from "path";

interface CachedPage {
  id: string;
  title: string;
  parent_id: string | null;
  url: string;
  block_count: number;
  child_page_count: number;
  has_content: boolean;
  icon: { type: string; value: string } | null;
  depth: number;
}
interface Cache {
  fetched_at: string;
  root_id: string;
  pages: CachedPage[];
  stats: any;
}

const HERE = __dirname;
const PROJECT = path.resolve(HERE, "..");
const CACHE_PATH = path.join(HERE, "01-notion-cache.json");

// Read .env for DOCS_DIR
const envContent = fs.readFileSync(path.join(PROJECT, ".env"), "utf8");
for (const line of envContent.split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const DOCS_DIR = process.env.DOCS_DIR ?? path.join(PROJECT, "docs");

// ── Load Notion cache ─────────────────────────────────────────────────────────

const cache: Cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));

// Build id → page map and compute path-from-root for each page.
const byId = new Map(cache.pages.map((p) => [p.id, p]));
const cleanId = (id: string) => id.replace(/-/g, "");

function notionPath(p: CachedPage): string[] {
  const segs: string[] = [];
  let cur: CachedPage | undefined = p;
  while (cur) {
    segs.unshift(cur.title);
    if (!cur.parent_id) break;
    // parent_id in cache uses dashed UUID format; cache keys may not
    cur = byId.get(cur.parent_id) ?? byId.get(cleanId(cur.parent_id));
  }
  return segs;
}

// ── Walk local docs ───────────────────────────────────────────────────────────

interface LocalDoc {
  rel_path: string;       // e.g. boring-technical-stuff/frontend/card.md
  abs_path: string;
  title: string;          // first `# heading` if present, else basename
  has_frontmatter_only: boolean;
  body_lines: number;
  body_chars: number;
  is_index: boolean;      // true when filename is _index.md
}

function readDoc(absPath: string, relPath: string): LocalDoc | null {
  if (!fs.existsSync(absPath)) return null;
  const raw = fs.readFileSync(absPath, "utf8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const body = fmMatch ? fmMatch[2] : raw;
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : path.basename(relPath, ".md");
  const trimmed = body.trim();
  return {
    rel_path: relPath,
    abs_path: absPath,
    title,
    has_frontmatter_only: trimmed.length === 0,
    body_lines: trimmed.split("\n").length,
    body_chars: trimmed.length,
    is_index: path.basename(relPath) === "_index.md",
  };
}

function walkLocal(): LocalDoc[] {
  const out: LocalDoc[] = [];
  function rec(absDir: string, relPrefix: string): void {
    if (!fs.existsSync(absDir)) return;
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      // Skip the same files notion-sync skips: leading underscore EXCEPT _index.md,
      // and *.claude.md authoring annotations.
      if (ent.name.startsWith("_") && ent.name !== "_index.md") continue;
      if (ent.name.endsWith(".claude.md")) continue;
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      const abs = path.join(absDir, ent.name);
      if (ent.isFile() && ent.name.endsWith(".md")) {
        const doc = readDoc(abs, rel);
        if (doc) out.push(doc);
      } else if (ent.isDirectory()) {
        rec(abs, rel);
      }
    }
  }
  rec(DOCS_DIR, "");
  return out;
}

const localDocs = walkLocal();

// ── Path normalization ────────────────────────────────────────────────────────
// Notion stores section page titles capitalized (`Boring-technical-stuff`)
// while local dir names are lowercased (`boring-technical-stuff`). Compare on
// lowercased segments. For leaf docs the local segment is the basename without
// .md and the Notion segment is the page title — these can legitimately differ
// (e.g. local "card.md" → Notion "Card — Content Container Component"), so we
// match leaves by parent-directory equivalence, not by the leaf segment itself.

const normSeg = (s: string): string => s.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

interface MatchedPair {
  local: LocalDoc;
  notion: CachedPage;
  notion_path: string[];
}
interface MissingOnRemote {
  local: LocalDoc;
  expected_parent_path: string[];
  reason: string;
}
interface ExtraOnRemote {
  notion: CachedPage;
  notion_path: string[];
  reason: string;
}
interface ThinRemote {
  local: LocalDoc;
  notion: CachedPage;
  notion_path: string[];
  block_count: number;
  local_chars: number;
  ratio: number;       // block_count / max(1, local_chars/300) — chars/300 ~ blocks
}

const matched: MatchedPair[] = [];
const missingOnRemote: MissingOnRemote[] = [];
const extraOnRemote: ExtraOnRemote[] = [];
const thinRemote: ThinRemote[] = [];

// Index Notion pages by normalized parent path to enable fast lookup
// for leaf docs whose local title may differ from remote title.
const notionByParent = new Map<string, CachedPage[]>();
const notionByFullPath = new Map<string, CachedPage>();
const rootPage = cache.pages.find((p) => !p.parent_id);
if (rootPage) notionByFullPath.set("", rootPage); // root _index.md matches root page
for (const p of cache.pages) {
  if (!p.parent_id) continue; // skip root for parent indexing
  const segs = notionPath(p);
  const parentSegs = segs.slice(1, -1).map(normSeg);
  const parentKey = parentSegs.join("/");
  const arr = notionByParent.get(parentKey) ?? [];
  arr.push(p);
  notionByParent.set(parentKey, arr);
  notionByFullPath.set(segs.slice(1).map(normSeg).join("/"), p);
}

// Also index local *directories* — a Notion section page should match a
// local directory whether or not it has an _index.md. Without this, dirs
// like "boring-technical-stuff/frontend/services/" (no _index.md but with
// subdir cron-tick/) get incorrectly flagged as "extra on remote".
const localDirs = new Set<string>();
function walkLocalDirs(absDir: string, relPrefix: string): void {
  if (!fs.existsSync(absDir)) return;
  for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (ent.name.startsWith("_") || ent.name.startsWith(".")) continue;
    if (!ent.isDirectory()) continue;
    const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
    localDirs.add(rel);
    walkLocalDirs(path.join(absDir, ent.name), rel);
  }
}
walkLocalDirs(DOCS_DIR, "");

// Track which Notion pages got matched to detect extras
const matchedNotionIds = new Set<string>();

for (const local of localDocs) {
  const localSegs = local.rel_path.replace(/\.md$/, "").split("/");
  const isIndex = local.is_index;

  // For section _index.md, the matching Notion page is at the parent directory's path.
  // For leaves, the path is the full segments.
  const targetSegs = isIndex ? localSegs.slice(0, -1) : localSegs;
  const targetKey = targetSegs.map(normSeg).join("/");

  let notionPage = notionByFullPath.get(targetKey);

  // Fallback for leaf docs: Notion title comes from the `# heading` of the
  // local file (notion-sync sets the page title from doc.title), so try
  // matching by the local doc's title within the parent's children. This is
  // how a local `card.md` containing `# Card — Content Container Component`
  // resolves to a Notion page titled the same.
  if (!notionPage && !isIndex) {
    const parentKey = targetSegs.slice(0, -1).map(normSeg).join("/");
    const siblings = notionByParent.get(parentKey) ?? [];
    // First: exact normalized title equality (Notion title === local heading)
    let direct = siblings.find((s) => normSeg(s.title) === normSeg(local.title));
    // Second: filename-stem equality (for files whose title was generated from filename)
    if (!direct) direct = siblings.find((s) => normSeg(s.title) === normSeg(localSegs[localSegs.length - 1]));
    if (direct) notionPage = direct;
  }

  if (notionPage) {
    matched.push({ local, notion: notionPage, notion_path: notionPath(notionPage) });
    matchedNotionIds.add(notionPage.id);

    // Flag thin pages: page exists but block_count looks suspiciously small
    // relative to local content size. Heuristic: ~300 chars produces ~1 block,
    // so expect block_count ≈ chars/300. Flag pages where ratio < 0.3.
    const expectedBlocks = Math.max(1, Math.floor(local.body_chars / 300));
    const ratio = notionPage.block_count / expectedBlocks;
    if (ratio < 0.3 && local.body_chars > 200) {
      thinRemote.push({
        local,
        notion: notionPage,
        notion_path: notionPath(notionPage),
        block_count: notionPage.block_count,
        local_chars: local.body_chars,
        ratio,
      });
    }
  } else {
    missingOnRemote.push({
      local,
      expected_parent_path: targetSegs.slice(0, -1),
      reason: isIndex ? "no Notion page at directory path" : "no Notion page at file path or matching sibling title",
    });
  }
}

// Find extras — Notion pages no local doc matched. But before classifying as
// "extra", check if the page corresponds to a local directory without an
// _index.md (i.e. an auto-indexed section page). Those are not extras — sync
// is supposed to create them.
const matchedDirs = new Set<string>();
for (const p of cache.pages) {
  if (!p.parent_id) continue;
  if (matchedNotionIds.has(p.id)) continue;
  const segs = notionPath(p).slice(1).map(normSeg); // drop root segment
  const dirRelPath = segs.join("/");
  if (localDirs.has(dirRelPath)) {
    // Notion section page corresponds to a local directory (no _index.md)
    matchedNotionIds.add(p.id);
    matchedDirs.add(dirRelPath);
    continue;
  }
  extraOnRemote.push({
    notion: p,
    notion_path: notionPath(p),
    reason: p.child_page_count > 0 && !p.has_content
      ? "section page (likely matches a local _index.md but title-norm collision)"
      : "no matching local doc",
  });
}

// ── Output ────────────────────────────────────────────────────────────────────

const result = {
  generated_at: new Date().toISOString(),
  cache_fetched_at: cache.fetched_at,
  totals: {
    local_docs: localDocs.length,
    local_dirs_without_index: localDirs.size,
    notion_pages: cache.pages.length - 1, // exclude root
    matched_docs: matched.length,
    matched_auto_index_sections: matchedDirs.size,
    missing_on_remote: missingOnRemote.length,
    extra_on_remote: extraOnRemote.length,
    thin_remote_pages: thinRemote.length,
  },
  matched: matched.map((m) => ({
    local_path: m.local.rel_path,
    notion_id: m.notion.id,
    notion_url: m.notion.url,
    notion_path: m.notion_path.join(" / "),
    block_count: m.notion.block_count,
  })),
  missing_on_remote: missingOnRemote.map((m) => ({
    local_path: m.local.rel_path,
    title: m.local.title,
    expected_parent_path: m.expected_parent_path.join(" / "),
    body_chars: m.local.body_chars,
    reason: m.reason,
  })),
  extra_on_remote: extraOnRemote.map((e) => ({
    notion_id: e.notion.id,
    title: e.notion.title,
    notion_url: e.notion.url,
    notion_path: e.notion_path.join(" / "),
    block_count: e.notion.block_count,
    reason: e.reason,
  })),
  thin_remote_pages: thinRemote.map((t) => ({
    local_path: t.local.rel_path,
    notion_url: t.notion.url,
    block_count: t.block_count,
    local_chars: t.local_chars,
    ratio: Number(t.ratio.toFixed(2)),
  })),
};

fs.writeFileSync(path.join(HERE, "04-path-diff.json"), JSON.stringify(result, null, 2));

// Summary text
const lines: string[] = [];
lines.push("# Notion vs Local Docs — Path-based Comparison");
lines.push(`Generated: ${result.generated_at}`);
lines.push(`Cache fetched: ${cache.fetched_at}`);
lines.push("");
lines.push("## Totals");
lines.push(`  Local docs:                  ${result.totals.local_docs}`);
lines.push(`  Local dirs (any depth):      ${result.totals.local_dirs_without_index}`);
lines.push(`  Notion pages:                ${result.totals.notion_pages}`);
lines.push(`  Matched docs:                ${result.totals.matched_docs}`);
lines.push(`  Matched auto-index sections: ${result.totals.matched_auto_index_sections}  (Notion section page ↔ local dir without _index.md)`);
lines.push(`  Missing on remote:           ${result.totals.missing_on_remote}  (local exists, no Notion page)`);
lines.push(`  Extra on remote:             ${result.totals.extra_on_remote}    (Notion page, no local doc or dir)`);
lines.push(`  Thin remote pages:           ${result.totals.thin_remote_pages}  (block_count <30% of expected)`);
lines.push("");

if (result.missing_on_remote.length > 0) {
  lines.push("## ✗ Missing on remote — local doc has no Notion page");
  for (const m of result.missing_on_remote) {
    lines.push(`  ${m.local_path}`);
    lines.push(`    title:  "${m.title}"`);
    lines.push(`    parent: ${m.expected_parent_path || "(root)"}`);
    lines.push(`    chars:  ${m.body_chars}`);
    lines.push(`    why:    ${m.reason}`);
    lines.push("");
  }
} else {
  lines.push("## ✓ No local docs missing on remote");
  lines.push("");
}

if (result.thin_remote_pages.length > 0) {
  lines.push("## ⚠ Thin remote pages — content suspiciously sparse vs local");
  lines.push(`(block_count is <30% of expected; expected ≈ chars/300)`);
  for (const t of result.thin_remote_pages) {
    lines.push(`  ${t.local_path}`);
    lines.push(`    blocks: ${t.block_count}   chars(local): ${t.local_chars}   ratio: ${t.ratio}`);
    lines.push(`    ${t.notion_url}`);
    lines.push("");
  }
}

if (result.extra_on_remote.length > 0) {
  lines.push("## + Extra on remote — Notion page with no local match");
  lines.push("(Often section pages whose title doesn't normalize back cleanly — inspect manually)");
  for (const e of result.extra_on_remote.slice(0, 100)) {
    lines.push(`  ${e.title}`);
    lines.push(`    path:   ${e.notion_path}`);
    lines.push(`    blocks: ${e.block_count}   reason: ${e.reason}`);
    lines.push(`    ${e.notion_url}`);
    lines.push("");
  }
  if (result.extra_on_remote.length > 100) {
    lines.push(`  … +${result.extra_on_remote.length - 100} more (see 04-path-diff.json)`);
  }
}

fs.writeFileSync(path.join(HERE, "05-summary.txt"), lines.join("\n"));

console.log("Written:");
console.log("  04-path-diff.json  (structured)");
console.log("  05-summary.txt     (human-readable)");
console.log("");
console.log(`Totals: ${result.totals.local_docs} local | ${result.totals.notion_pages} remote | ` +
            `${result.totals.matched_docs} matched | ${result.totals.missing_on_remote} missing | ` +
            `${result.totals.extra_on_remote} extra | ${result.totals.thin_remote_pages} thin`);
