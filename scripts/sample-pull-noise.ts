#!/usr/bin/env bun
/**
 * Sample N random docs, pull from Notion, apply the existing transform
 * pipeline, and report the differences against local — categorized so we
 * can see what's "noise" (Notion roundtrip artifacts that the pipeline
 * should strip) vs "legit" (real content drift).
 *
 * Usage:  bun scripts/sample-pull-noise.ts [N]    (default N=20)
 *
 * This is a one-off diagnostic — not wired into list.sh / sync.sh.
 */

import { Client } from "@notionhq/client";
import * as fs from "fs";
import * as path from "path";
import {
  pullPageMarkdownRaw,
  stripSyncFooter,
  stripBreadcrumbAndBanner,
  convertMentionTagsToLinks,
  convertHtmlTablesToMarkdown,
} from "../reconcile";

const PROJECT = path.join(__dirname, "..");
const envContent = fs.readFileSync(path.join(PROJECT, ".env"), "utf8");
for (const line of envContent.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const DOCS_DIR = process.env.DOCS_DIR!;
const notion = new Client({ auth: process.env.NOTION_TOKEN!, timeoutMs: 120_000 });
const cache = JSON.parse(fs.readFileSync(path.join(PROJECT, ".notion-cache.json"), "utf-8"));

// Minimal copy of diff-content.ts's resolver — keep this script standalone.
const stripDashes = (s: string) => s.replace(/-/g, "").toLowerCase();
const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const byParent = new Map<string, any[]>();
for (const p of cache.pages) {
  const k = stripDashes(p.parent_id ?? "");
  if (!byParent.has(k)) byParent.set(k, []);
  byParent.get(k)!.push(p);
}
const rootId = stripDashes(cache.root_id);

function readH1(absPath: string): string | null {
  try {
    const m = fs.readFileSync(absPath, "utf-8").match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

function resolve(relPath: string): string | null {
  const segments = relPath.split(path.sep);
  const isIndex = segments[segments.length - 1] === "_index.md";
  const pathSegs = isIndex ? segments.slice(0, -1) : segments;
  let cur = rootId;
  let accum = "";
  for (let i = 0; i < pathSegs.length; i++) {
    accum = accum ? path.join(accum, pathSegs[i]) : pathSegs[i];
    const isLeaf = !isIndex && i === pathSegs.length - 1;
    let cands: string[];
    if (isLeaf) {
      const h1 = readH1(path.join(DOCS_DIR, relPath));
      const base = path.basename(pathSegs[i], ".md");
      cands = [h1 ?? "", base, base.replace(/-/g, " ")].filter(Boolean);
    } else {
      const ip = path.join(DOCS_DIR, accum, "_index.md");
      const h1 = fs.existsSync(ip) ? readH1(ip) : null;
      cands = [h1 ?? "", pathSegs[i].replace(/-/g, " "), pathSegs[i]].filter(Boolean);
    }
    const children = byParent.get(cur) ?? [];
    let match: any = null;
    for (const c of cands) { match = children.find((ch) => ch.title === c); if (match) break; }
    if (!match) {
      for (const c of cands) {
        const cn = normTitle(c);
        match = children.find((ch) => normTitle(ch.title) === cn);
        if (match) break;
      }
    }
    if (!match) return null;
    cur = stripDashes(match.id);
  }
  return cur;
}

// Walk DOCS_DIR for .md files (skip scratch).
function walkLocal(): string[] {
  const out: string[] = [];
  const stack = [{ abs: DOCS_DIR, rel: "" }];
  while (stack.length) {
    const { abs, rel } = stack.pop()!;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const ca = path.join(abs, e.name);
      const cr = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) stack.push({ abs: ca, rel: cr });
      else if (e.isFile() && e.name.endsWith(".md")) {
        if (e.name.endsWith(".claude.md") || (e.name.startsWith("_") && e.name !== "_index.md")) continue;
        out.push(cr);
      }
    }
  }
  return out;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Categorize a single hunk of diff into one of our "noise" buckets.
// Returns the matching category names (a hunk can match multiple).
const NOISE_CATEGORIES: { name: string; test: (delLine: string, addLine: string) => boolean }[] = [
  {
    name: "trailing-whitespace",
    test: (d, a) => d.trimEnd() === a.trimEnd() && d !== a,
  },
  {
    name: "leading-whitespace",
    test: (d, a) => d.trimStart() === a.trimStart() && d !== a,
  },
  {
    name: "blank-line-count",
    test: (d, a) => d.trim() === "" && a.trim() === "" && d !== a,
  },
  {
    name: "backslash-escape-drift",
    // Notion likes to escape (or un-escape) chars like _ * # > in prose.
    test: (d, a) => d.replace(/\\([_*#>|`])/g, "$1") === a.replace(/\\([_*#>|`])/g, "$1") && d !== a,
  },
  {
    name: "list-marker-change",
    // - vs * vs + vs numbered.
    test: (d, a) => d.replace(/^\s*[-*+]\s+/, "").replace(/^\s*\d+\.\s+/, "") === a.replace(/^\s*[-*+]\s+/, "").replace(/^\s*\d+\.\s+/, "") && d !== a,
  },
  {
    name: "html-entity-roundtrip",
    test: (d, a) => d.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") === a.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") && d !== a,
  },
  {
    name: "smart-quotes",
    test: (d, a) => d.replace(/[""]/g, '"').replace(/['']/g, "'") === a.replace(/[""]/g, '"').replace(/['']/g, "'") && d !== a,
  },
];

interface SampleResult {
  relPath: string;
  pageId: string;
  localLen: number;
  remoteLen: number;
  totalDiffLines: number;
  noiseHits: Record<string, number>;
  pureAdditions: number;
  pureRemovals: number;
  changedLines: number;
  rawDiffHead: string;
}

// Mirror diff-content.ts's processing exactly so the sampler reflects what
// the actual report sees, not just the raw pipeline. Without this, we'd
// keep counting frontmatter and trailing-blank noise that the report has
// already neutralized.
function readFrontmatterBlock(absPath: string): string | null {
  if (!fs.existsSync(absPath)) return null;
  const body = fs.readFileSync(absPath, "utf-8");
  const m = body.match(/^---\n[\s\S]*?\n---\n/);
  return m ? m[0] : null;
}
const normalizeForDiff = (body: string) =>
  body.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";

async function diffOnePage(relPath: string, pageId: string): Promise<SampleResult> {
  const localAbs = path.join(DOCS_DIR, relPath);
  let local = fs.readFileSync(localAbs, "utf-8");
  const pulled = await pullPageMarkdownRaw(notion, pageId);
  let remote = pulled.markdown;
  remote = stripSyncFooter(remote);
  remote = stripBreadcrumbAndBanner(remote);
  remote = convertMentionTagsToLinks(remote);
  remote = convertHtmlTablesToMarkdown(remote);
  // Re-graft local frontmatter + normalize trailing whitespace — matches
  // diff-content.ts buildReport() so the sampler's noise figures track the
  // actual report's noise figures.
  const fm = readFrontmatterBlock(localAbs);
  if (fm) remote = fm + "\n" + remote.replace(/^\n+/, "");
  local = normalizeForDiff(local);
  remote = normalizeForDiff(remote);

  // Pair-wise diff via line arrays (LCS) — keep it simple, we just want
  // category counts not perfect alignment.
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");
  const localSet = new Map<string, number>();
  for (const l of localLines) localSet.set(l, (localSet.get(l) ?? 0) + 1);
  const remoteSet = new Map<string, number>();
  for (const l of remoteLines) remoteSet.set(l, (remoteSet.get(l) ?? 0) + 1);

  // Lines unique to each side after balancing counts.
  const onlyLocal: string[] = [];
  const onlyRemote: string[] = [];
  for (const [line, count] of localSet) {
    const rc = remoteSet.get(line) ?? 0;
    if (count > rc) for (let i = 0; i < count - rc; i++) onlyLocal.push(line);
  }
  for (const [line, count] of remoteSet) {
    const lc = localSet.get(line) ?? 0;
    if (count > lc) for (let i = 0; i < count - lc; i++) onlyRemote.push(line);
  }

  // Pair onlyLocal vs onlyRemote by index (rough, but good enough for
  // sampling category prevalence).
  const noiseHits: Record<string, number> = {};
  let changed = 0;
  const n = Math.min(onlyLocal.length, onlyRemote.length);
  for (let i = 0; i < n; i++) {
    changed++;
    for (const cat of NOISE_CATEGORIES) {
      if (cat.test(onlyLocal[i], onlyRemote[i])) {
        noiseHits[cat.name] = (noiseHits[cat.name] ?? 0) + 1;
      }
    }
  }

  // Build a tiny preview head (first 15 differing lines, ± marked)
  const head: string[] = [];
  for (let i = 0; i < Math.min(15, onlyLocal.length); i++) head.push(`- ${onlyLocal[i].slice(0, 180)}`);
  for (let i = 0; i < Math.min(15, onlyRemote.length); i++) head.push(`+ ${onlyRemote[i].slice(0, 180)}`);

  return {
    relPath,
    pageId,
    localLen: localLines.length,
    remoteLen: remoteLines.length,
    totalDiffLines: onlyLocal.length + onlyRemote.length,
    noiseHits,
    pureAdditions: Math.max(0, onlyRemote.length - n),
    pureRemovals: Math.max(0, onlyLocal.length - n),
    changedLines: changed,
    rawDiffHead: head.join("\n"),
  };
}

async function main() {
  const N = parseInt(process.argv[2] ?? "20", 10);
  console.log(`Sampling ${N} random pages from ${DOCS_DIR}…\n`);
  const all = walkLocal();
  const matched: { relPath: string; pageId: string }[] = [];
  for (const rel of all) {
    const pid = resolve(rel);
    if (pid) matched.push({ relPath: rel, pageId: pid });
  }
  console.log(`Found ${matched.length} resolvable pages (of ${all.length} local docs).`);
  const sample = shuffle(matched).slice(0, N);

  const results: SampleResult[] = [];
  for (let i = 0; i < sample.length; i++) {
    const { relPath, pageId } = sample[i];
    process.stdout.write(`  [${i + 1}/${sample.length}] ${relPath} … `);
    try {
      const r = await diffOnePage(relPath, pageId);
      results.push(r);
      console.log(`${r.totalDiffLines} diff lines, ${Object.keys(r.noiseHits).length} noise cats`);
    } catch (err: any) {
      console.log(`ERR: ${err.message?.slice(0, 80)}`);
    }
  }

  // Aggregate
  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log("AGGREGATE NOISE CATEGORIES (line-level hits across all sampled pages)");
  console.log("══════════════════════════════════════════════════════════════════");
  const totals: Record<string, number> = {};
  let totalChanged = 0;
  let totalPureAdd = 0;
  let totalPureDel = 0;
  for (const r of results) {
    for (const [cat, n] of Object.entries(r.noiseHits)) totals[cat] = (totals[cat] ?? 0) + n;
    totalChanged += r.changedLines;
    totalPureAdd += r.pureAdditions;
    totalPureDel += r.pureRemovals;
  }
  const sortedCats = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  for (const [cat, n] of sortedCats) {
    const pct = totalChanged > 0 ? Math.round((n / totalChanged) * 100) : 0;
    console.log(`  ${cat.padEnd(28)}  ${String(n).padStart(5)}  (${pct}% of changed lines)`);
  }
  console.log(`  ${"-".repeat(40)}`);
  console.log(`  changed-line-pairs            ${String(totalChanged).padStart(5)}`);
  console.log(`  pure-additions-on-remote      ${String(totalPureAdd).padStart(5)}  (lines only on Notion side)`);
  console.log(`  pure-removals-on-remote       ${String(totalPureDel).padStart(5)}  (lines only on local side)`);

  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log("PER-PAGE BREAKDOWN (sorted by total diff lines, descending)");
  console.log("══════════════════════════════════════════════════════════════════");
  results.sort((a, b) => b.totalDiffLines - a.totalDiffLines);
  for (const r of results) {
    const cats = Object.entries(r.noiseHits).map(([k, v]) => `${k}=${v}`).join(", ") || "—";
    console.log(`\n  ${r.relPath}`);
    console.log(`    diff=${r.totalDiffLines}  local=${r.localLen}L  remote=${r.remoteLen}L  changed=${r.changedLines}  +${r.pureAdditions}/-${r.pureRemovals}`);
    console.log(`    noise: ${cats}`);
  }

  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log("RAW SAMPLES (first 3 noisiest pages, first 15 differing lines each)");
  console.log("══════════════════════════════════════════════════════════════════");
  for (const r of results.slice(0, 3)) {
    console.log(`\n── ${r.relPath} ──`);
    console.log(r.rawDiffHead);
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
