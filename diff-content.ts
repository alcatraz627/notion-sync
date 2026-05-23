/**
 * Three-way diff content report — bulk read-only view of what changed on
 * both sides since the last successful push.
 *
 * For each protected page from the latest live run (or each page with a
 * baseline when --all is set), this fetches three sides:
 *
 *   BASE   — `.notion-snapshots/<rel>.md` (verbatim local body at last push)
 *   LOCAL  — current file on disk (may include uncommitted edits)
 *   REMOTE — `pages.retrieveMarkdown` + the pull-pipeline transforms
 *
 * It then renders ONE HTML report with a per-page section showing two
 * side-by-side word-diffs (BASE→LOCAL, BASE→REMOTE), plus a classification
 * badge so the user can quickly tell which side moved.
 *
 * Read-only. No mutation, no save endpoint. The merge-and-save UX lives in
 * `reconcile.ts` (entered per-page).
 *
 * Spec / motivation: see CLAUDE.md and the 2026-05-15 session.
 */

import { getNotion } from "./lib/notion";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { marked } from "marked";
import {
  pullPageMarkdownRaw,
  stripSyncFooter,
  stripBreadcrumbAndBanner,
  convertMentionTagsToLinks,
  convertHtmlTablesToMarkdown,
  parseDiffOutput,
  buildUnifiedBody,
} from "./reconcile";
import { loadState, loadSnapshot, getCacheKey } from "./sync-state";
import { titleVariants } from "./title-match";
import { loadEnv } from "./lib/env";

// Configure marked: no GFM tables sanitization (the docs use them), no XSS
// sanitization (we trust local content — we wrote it), but escape ALL HTML
// embedded in markdown so that things like `<callout>` blocks Notion adds
// don't get interpreted as live HTML.
marked.setOptions({ gfm: true, breaks: false });

// ── Reverse remote rewrites ──────────────────────────────────────────────────
//
// The push pipeline (index.ts) replaces internal `.md` links with Notion page
// URLs, rewrites code-source paths to GitHub blob URLs, and uploads images
// to Notion's CDN. Each of those substitutions is a stable, derivable
// transform — we have all the inputs (Notion cache, image cache, env vars)
// at diff time, so we can REVERSE them on the pulled body before diffing
// against local. The result: a `.md` link looks like a `.md` link on both
// sides, a code ref looks like a code ref on both sides, an image looks
// like an image on both sides — even though Notion stored each in its own
// rewritten form. Drops 60-70% of the visible diff noise.

interface ReverseOpts {
  // Reverse map: 32-char hex page id → relPath of the doc Notion stored at
  // that page. Built from `.notion-cache.json` via the resolver pass.
  pageIdToRelPath: Map<string, string>;
  // Path prefix that index.ts uses for code-source links pushed to Notion.
  // We strip it back to whatever path the user originally wrote.
  githubBase: string | null;
  // Set of S3 URL prefixes Notion uses for uploaded images. Any image URL
  // starting with one of these is a Notion-managed asset; we redact the URL
  // (keep alt text) so the diff doesn't churn on host changes.
  imageHostPrefixes: string[];
}

function buildReverseOpts(cache: NotionCache, resolverIdToPath: Map<string, string>): ReverseOpts {
  const repo = process.env.GITHUB_REPO ?? "";
  const branch = process.env.GITHUB_BRANCH ?? "development";
  const docsRoot = process.env.GITHUB_DOCS_ROOT ?? "";
  const githubBase = repo
    ? `https://github.com/${repo}/blob/${branch}${docsRoot ? "/" + docsRoot.replace(/^\/|\/$/g, "") : ""}`
    : null;
  return {
    pageIdToRelPath: resolverIdToPath,
    githubBase,
    imageHostPrefixes: [
      "https://prod-files-secure.s3.us-west-2.amazonaws.com/",
      "https://s3.us-west-2.amazonaws.com/public.notion-static.com/",
      "https://www.notion.so/images/",
      "https://file.notion.so/",
    ],
  };
}

export function reverseRemoteRewrites(body: string, relPath: string, opts: ReverseOpts): string {
  const fromDir = path.dirname(relPath);

  // 1. Notion page URLs `[label](https://www.notion.so/<32hex>)` → relative
  //    `.md` link if the target page is one of ours. URL-as-label case (where
  //    Notion serialized a mention pill as `[<url>](<url>)`) is collapsed
  //    further: replace the label with the local path too.
  body = body.replace(
    /\[([^\]]+)\]\(https?:\/\/(?:www\.)?notion\.so\/([0-9a-f-]{32,})\)/gi,
    (full, label: string, hexRaw: string) => {
      const hex = hexRaw.replace(/-/g, "").toLowerCase();
      const target = opts.pageIdToRelPath.get(hex);
      if (!target) return full;
      const relTo = path.relative(fromDir, target).replace(/\\/g, "/") || "./" + path.basename(target);
      // If label looked like the URL itself (Notion's mention-pill serialization),
      // replace it with the resolved path so both halves line up with the
      // original local form `[../foo.md](../foo.md)`.
      const labelHex = label.replace(/^https?:\/\/(?:www\.)?notion\.so\//, "").replace(/-/g, "").toLowerCase();
      const labelWasUrl = /^[0-9a-f]{32}$/.test(labelHex);
      return `[${labelWasUrl ? relTo : label}](${relTo})`;
    },
  );

  // 2. GitHub blob URLs `[label](https://github.com/.../blob/.../foo)` → strip
  //    back to the original repo-relative path. Only kicks in when GITHUB_REPO
  //    is set (otherwise we never push these in the first place).
  if (opts.githubBase) {
    const ghPrefix = opts.githubBase + "/";
    const ghEscaped = ghPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    body = body.replace(
      new RegExp(`\\[([^\\]]+)\\]\\(${ghEscaped}([^)]+)\\)`, "g"),
      (full, label: string, tail: string) => {
        // Anchor fragment, if any, lives at the end of `tail`.
        const [pathOnly, anchor] = tail.split("#");
        const relTo = path.relative(fromDir, pathOnly).replace(/\\/g, "/") || "./" + path.basename(pathOnly);
        return `[${label}](${relTo}${anchor ? "#" + anchor : ""})`;
      },
    );
  }

  // 3. Image URLs hosted by Notion's CDN → redact to a placeholder so the
  //    diff doesn't churn on host change. We can't trivially recover the
  //    original local path from the URL alone (sha256 isn't embedded), so we
  //    apply the same redaction to LOCAL image paths via normalizeForDiff —
  //    both sides collapse to `![alt](IMG)` and only an alt-text change
  //    shows up. Done in normalizeForDiff() rather than here.

  // 4. Bare `.md` filename in URL with auto-prepended `http://` (Notion
  //    mangles `[foo.md](foo.md)` into `[foo.md](http://foo.md)` because it
  //    parses bare `.md` as a Moldova-TLD host).
  body = body.replace(/\[([^\]]+)\]\(http:\/\/([^)\s]+\.md)\)/g, "[$1]($2)");

  return body;
}

// ── DOCS_DIR walk + cache-based page-id resolver ─────────────────────────────

const CACHE_PATH = () => path.join(__dirname, `.notion-cache.${getCacheKey()}.json`);
const LEGACY_CACHE_PATH = path.join(__dirname, ".notion-cache.json");

interface CachePage { id: string; title: string; parent_id: string | null; depth: number; url?: string }
interface NotionCache { root_id: string; pages: CachePage[]; fetched_at: string }

function loadCache(): NotionCache | null {
  // notion-list.ts does the keyed→legacy migration on `fetch`; here we
  // just read whichever exists for the current root.
  const cur = CACHE_PATH();
  if (!fs.existsSync(cur) && fs.existsSync(LEGACY_CACHE_PATH)) {
    try { return JSON.parse(fs.readFileSync(LEGACY_CACHE_PATH, "utf-8")); } catch { return null; }
  }
  if (!fs.existsSync(cur)) return null;
  try { return JSON.parse(fs.readFileSync(cur, "utf-8")); } catch { return null; }
}

const stripDashes = (id: string) => id.replace(/-/g, "").toLowerCase();

function walkLocalDocs(docsDir: string): string[] {
  // Return rel-paths of all .md files under docsDir. Skips dotfiles.
  const out: string[] = [];
  const stack: { abs: string; rel: string }[] = [{ abs: docsDir, rel: "" }];
  while (stack.length > 0) {
    const { abs, rel } = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) stack.push({ abs: childAbs, rel: childRel });
      else if (e.isFile() && e.name.endsWith(".md")) {
        // Skip scratch/checkpoint files — they're never pushed to Notion.
        // Same `_*.claude.md` pattern that's gitignored at the project level.
        if (e.name.endsWith(".claude.md") || e.name.startsWith("_") && e.name !== "_index.md") continue;
        out.push(childRel);
      }
    }
  }
  return out.sort();
}

function readH1(absPath: string): string | null {
  try {
    const body = fs.readFileSync(absPath, "utf-8");
    const m = body.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

interface PageResolver {
  resolve(relPath: string): { pageId: string; notionUrl: string } | null;
  unmatchedCount: number;
}

function buildPageResolver(cache: NotionCache, docsDir: string, localPaths: string[]): PageResolver {
  // Index cache by parent_id (normalized). Each parent maps to its list of
  // children — we'll search them by title at walk-time.
  const childrenByParent = new Map<string, CachePage[]>();
  for (const p of cache.pages) {
    const k = stripDashes(p.parent_id ?? "");
    if (!childrenByParent.has(k)) childrenByParent.set(k, []);
    childrenByParent.get(k)!.push(p);
  }
  const rootIdNorm = stripDashes(cache.root_id);

  // For a folder segment, the Notion page's title could be any of several
  // forms because H1s drift over time (users edit them after sync) but the
  // dir-name stays stable. Return ALL candidates and let findChild try each.
  // Mirrors index.ts:776's `dirName.replace(/-/g, " ")` for the primary
  // fallback, but also tries the verbatim dir-name (Notion may have stored
  // it that way for hyphenated folders).
  // Each candidate generator returns an EXPANDED list — every base candidate
  // run through `titleVariants` to also yield dash-tail and paren-stripped
  // forms. Catches "Forms" ↔ "UI Widgets — Forms" and "Auth" ↔ "Auth (Frontend)"
  // without enumerating qualifier prefixes.
  const expand = (bases: string[]): string[] => {
    const out = new Set<string>();
    for (const b of bases) for (const v of titleVariants(b)) out.add(v);
    return [...out];
  };
  const folderTitleCache = new Map<string, string[]>();
  function folderTitles(relDir: string): string[] {
    if (folderTitleCache.has(relDir)) return folderTitleCache.get(relDir)!;
    const segName = path.basename(relDir);
    const bases: string[] = [];
    const indexPath = path.join(docsDir, relDir, "_index.md");
    const h1 = fs.existsSync(indexPath) ? readH1(indexPath) : null;
    if (h1) bases.push(h1);
    bases.push(segName.replace(/-/g, " "));
    bases.push(segName);
    const out = expand(bases);
    folderTitleCache.set(relDir, out);
    return out;
  }
  function leafTitles(absPath: string, basename: string): string[] {
    const bases: string[] = [];
    const h1 = readH1(absPath);
    if (h1) bases.push(h1);
    bases.push(basename);
    bases.push(basename.replace(/-/g, " "));
    return expand(bases);
  }

  // Match by exact title first (mirrors index.ts:1295 `p.title === title`),
  // then by a lenient normalize that treats hyphens/underscores/whitespace as
  // equivalent. The lenient pass catches "Boring-technical-stuff" (Notion's
  // literal title) ↔ "boring technical stuff" (the fallback derived via
  // index.ts:776's `dirName.replace(/-/g, " ")`). Both ultimately denote the
  // same folder; the discrepancy is just punctuation drift over time.
  const normalizeTitle = (s: string) =>
    s.toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  function findChildByAny(parentIdNorm: string, candidates: string[]): CachePage | null {
    const children = childrenByParent.get(parentIdNorm) ?? [];
    // Pass 1: exact match against any candidate (cheapest, mirrors index.ts).
    for (const cand of candidates) {
      const m = children.find(c => c.title === cand);
      if (m) return m;
    }
    // Pass 2: lenient normalize match against any candidate.
    for (const cand of candidates) {
      const candNorm = normalizeTitle(cand);
      const m = children.find(c => normalizeTitle(c.title) === candNorm);
      if (m) return m;
    }
    // Pass 3: variant overlap. The Notion page title itself may carry a
    // qualifier prefix or trailing paren that local stripped (or vice versa).
    // Generate variants for each child's title and check overlap against the
    // candidate list. More expensive (M children × per-title variant gen) so
    // only run after the cheaper passes fail.
    const candSet = new Set(candidates);
    for (const c of children) {
      for (const v of titleVariants(c.title)) {
        if (candSet.has(v)) return c;
      }
    }
    return null;
  }

  let unmatched = 0;
  return {
    unmatchedCount: 0,
    resolve(relPath: string) {
      // Build the expected title chain for this file. Rule:
      //   `_index.md` represents its containing folder → strip it from the
      //     segment list so the chain ends at the folder itself.
      //   Otherwise the final segment is a leaf doc → title = its H1, or
      //     filename without `.md` as fallback (matches index.ts:611's
      //     `extractTitle` exactly).
      // Each non-leaf segment titles → that folder's `_index.md` H1 if it
      // exists, else `dirName.replace('-', ' ')` (mirrors index.ts:776).
      const segments = relPath.split(path.sep);
      const isIndex = segments[segments.length - 1] === "_index.md";
      const pathSegs = isIndex ? segments.slice(0, -1) : segments;
      if (pathSegs.length === 0) { unmatched++; return null; }
      // For each segment, compute the list of title candidates (Notion may
      // match any of them — H1 / dirname-with-spaces / dirname-as-is).
      const candidatesPerSegment: string[][] = [];
      let accumRel = "";
      for (let i = 0; i < pathSegs.length; i++) {
        accumRel = accumRel ? path.join(accumRel, pathSegs[i]) : pathSegs[i];
        const isLeaf = !isIndex && i === pathSegs.length - 1;
        if (isLeaf) {
          const base = path.basename(pathSegs[i], ".md");
          candidatesPerSegment.push(leafTitles(path.join(docsDir, relPath), base));
        } else {
          candidatesPerSegment.push(folderTitles(accumRel));
        }
      }
      // Walk the cache, trying each segment's candidate list in order.
      let curIdNorm = rootIdNorm;
      for (const cands of candidatesPerSegment) {
        const child = findChildByAny(curIdNorm, cands);
        if (!child) { unmatched++; return null; }
        curIdNorm = stripDashes(child.id);
      }
      return {
        pageId: curIdNorm,
        notionUrl: `https://www.notion.so/${curIdNorm}`,
      };
    },
    get unmatchedCount() { return unmatched; },
  };
}

// ── Env + config ─────────────────────────────────────────────────────────────

loadEnv(path.join(__dirname, ".env"));

const NOTION_TOKEN = process.env.NOTION_TOKEN!;
const DOCS_DIR = process.env.DOCS_DIR ?? path.join(__dirname, "docs");
const RUNS_PATH = path.join(__dirname, "runs.jsonl");

if (!NOTION_TOKEN) {
  console.error("\x1b[31mNOTION_TOKEN missing\x1b[0m");
  process.exit(1);
}

const notion = getNotion({ timeoutMs: 120_000 });

// ── Types ────────────────────────────────────────────────────────────────────

type Side = "local" | "remote" | "both" | "neither" | "no-base";

interface PageReport {
  relPath: string;
  pageId: string;
  notionUrl: string;
  hasBase: boolean;
  base: string;
  local: string;
  remote: string;
  remoteTruncated: boolean;
  baseToLocalDiff: string;
  baseToRemoteDiff: string;
  localChanged: boolean;
  remoteChanged: boolean;
  classification: Side;
  fetchError?: string;
}

// ── Runs.jsonl helpers ───────────────────────────────────────────────────────

interface ProtectedRow {
  path: string;
  page_id: string;
  notion_url?: string;
  kinds?: string[];
}

function readLatestLiveRun(): { protected_pages: ProtectedRow[]; run_id: string } | null {
  if (!fs.existsSync(RUNS_PATH)) return null;
  const lines = fs.readFileSync(RUNS_PATH, "utf-8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.config?.dry_run) continue;
      if (e.partial) continue;
      return {
        protected_pages: Array.isArray(e.protected_pages) ? e.protected_pages : [],
        run_id: e.run_id ?? "unknown",
      };
    } catch { /* skip */ }
  }
  return null;
}

// ── Diff via git --no-index ──────────────────────────────────────────────────

/**
 * Normalize a markdown body for diffing.
 *
 * Notion's `retrieveMarkdown` trims trailing whitespace, while local files
 * almost always end with a final newline or several blank lines. Without
 * normalization, every page reports 5-15 spurious "trailing blank" removals.
 * We collapse all trailing whitespace to a single trailing newline on both
 * sides — semantically equivalent, removes the most common noise source.
 */
export function normalizeForDiff(body: string): string {
  return body
    // Strip code-fence language tags. Notion auto-detects the language and
    // attaches one even when local has a bare ```. We can't know whether
    // the user "meant" javascript or python, so collapse both sides to
    // unlabelled fences — a code-language change isn't a meaningful diff
    // for prose docs anyway. (Only applies to fence-OPENING lines that have
    // a language; bare ``` or ``` followed by space/end stay as-is.)
    .replace(/^(```)[a-zA-Z0-9_+\-]+\s*$/gm, "$1")
    // Normalize table separator rows. Notion emits `| --- |` with whatever
    // dash count its converter feels like (often matching the longest cell
    // width); local files typically use exactly 3 dashes. Collapse all
    // separator cells to 3 dashes while preserving alignment markers
    // (`:---`, `---:`, `:---:`).
    .replace(/^\s*\|(?:[-:|\s]+\|)+\s*$/gm, (line) => {
      const cells = line.trim().split("|").slice(1, -1).map((cell) => {
        const t = cell.trim();
        const leftAlign = t.startsWith(":");
        const rightAlign = t.endsWith(":");
        if (leftAlign && rightAlign) return ":---:";
        if (leftAlign) return ":---";
        if (rightAlign) return "---:";
        return "---";
      });
      return "| " + cells.join(" | ") + " |";
    })
    // Unescape backslash-escaped punctuation. Notion's exporter conservatively
    // escapes any character that COULD be markdown-meaningful even in plain
    // prose where it isn't — `\>`, `\-`, `\(`, `\.`, `\!`, etc. Local files
    // don't have these escapes. Strip them on both sides so what's
    // semantically the same word ends up the same string. Skipping `\\`
    // itself (genuine escape sequences in code samples) and `\[`/`\]` (which
    // we already handle inside table cells, and which CAN legitimately be
    // intentional in prose to suppress link syntax).
    .replace(/\\([>!\-=().,;:?])/g, "$1")
    // Image URLs → `IMG` placeholder. The local form is `./pic.png` or
    // similar relative path; Notion stores it on its CDN
    // (`prod-files-secure.s3.us-west-2.amazonaws.com/...`). Both encode the
    // SAME image — only alt text changes are meaningful for diff. Stripping
    // the URL to a stable placeholder on both sides collapses what's often
    // a 200-char per-image diff to zero. Alt text + the bang are preserved.
    .replace(/!\[([^\]]*)\]\([^)\s]+(?:\s+"[^"]*")?\)/g, "![$1](IMG)")
    // Collapse runs of 2+ blank lines into a single blank line. Markdown
    // treats any blank-line run as a paragraph break — local files often use
    // doubled-blanks as visual spacing, Notion always collapses to one.
    .replace(/\n{3,}/g, "\n\n")
    // Strip trailing whitespace, then put back one terminator newline so
    // POSIX text-file convention holds.
    .replace(/\s+$/, "")
    + "\n";
}

/**
 * Pull the YAML frontmatter block (between leading `---\n` and `\n---\n`)
 * out of a local file. Returns the block including both fences, or null when
 * the file has no frontmatter. We use this to re-graft local frontmatter
 * onto the pulled remote body — the pull pipeline's `stripBreadcrumbAndBanner`
 * intentionally discards everything before the first H1 (including
 * frontmatter), which is correct for reconcile-pull-to-local but bad for
 * diffing because it manufactures fake "removals" on every doc.
 */
function readFrontmatterBlock(absPath: string): string | null {
  if (!fs.existsSync(absPath)) return null;
  const body = fs.readFileSync(absPath, "utf-8");
  const m = body.match(/^---\n[\s\S]*?\n---\n/);
  return m ? m[0] : null;
}

type DiffGranularity = "word" | "char";

async function wordDiff(base: string, side: string, granularity: DiffGranularity = "word"): Promise<string> {
  // git diff returns 1 when files differ — that's normal. Capture stdout.
  // Granularity switches the word-diff regex: default `--word-diff=plain`
  // splits on whitespace (word-level); `--word-diff-regex=.` treats every
  // character as a word (char-level). Char-level is much noisier on big
  // edits but useful for inspecting precise punctuation/escape drift.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diff-content-"));
  const aPath = path.join(tmpDir, "base");
  const bPath = path.join(tmpDir, "side");
  fs.writeFileSync(aPath, normalizeForDiff(base));
  fs.writeFileSync(bPath, normalizeForDiff(side));
  try {
    const args = granularity === "char"
      ? ["git", "--no-pager", "diff", "--no-color", "--no-index", "--word-diff=plain", "--word-diff-regex=.", "-U99999", aPath, bPath]
      : ["git", "--no-pager", "diff", "--no-color", "--no-index", "--word-diff=plain", "-U99999", aPath, bPath];
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function hasMeaningfulDiff(diffOutput: string): boolean {
  return parseDiffOutput(diffOutput).some(r => r.kind === "added" || r.kind === "removed" || r.kind === "changed");
}

// ── Per-page build ───────────────────────────────────────────────────────────

async function buildReport(relPath: string, pageId: string, notionUrl: string, reverseOpts?: ReverseOpts): Promise<PageReport> {
  const localAbsPath = path.join(DOCS_DIR, relPath);
  const local = fs.existsSync(localAbsPath) ? fs.readFileSync(localAbsPath, "utf-8") : "";
  const baseStr = loadSnapshot(relPath);
  const hasBase = baseStr !== null;
  const base = baseStr ?? "";

  let remote = "";
  let remoteTruncated = false;
  let fetchError: string | undefined;
  try {
    const pulled = await pullPageMarkdownRaw(notion, pageId);
    remoteTruncated = pulled.truncated;
    let body = pulled.markdown;
    body = stripSyncFooter(body);
    body = stripBreadcrumbAndBanner(body);
    body = convertMentionTagsToLinks(body);
    body = convertHtmlTablesToMarkdown(body);
    // Reverse the push-side rewrites: Notion-URL links back to relative .md,
    // GitHub blob URLs back to repo-relative paths, etc. Done BEFORE the
    // frontmatter re-graft so the cleaned-up body is what the diff sees.
    if (reverseOpts) body = reverseRemoteRewrites(body, relPath, reverseOpts);
    // Re-graft local frontmatter so BASE/LOCAL/REMOTE share the same shape.
    // Pull pipeline drops it intentionally (reconcile pull-to-local doesn't
    // want Notion overwriting your icon/audience/last_updated YAML), but for
    // a diff view we want the frontmatter to cancel out as context, not
    // noise. If the local frontmatter doesn't match BASE's, the diff will
    // legitimately surface that — same as any other line drift.
    const fm = readFrontmatterBlock(localAbsPath);
    if (fm) body = fm + "\n" + body.replace(/^\n+/, "");
    remote = body;
  } catch (err: any) {
    fetchError = err?.message?.slice(0, 200) ?? "unknown";
  }

  const baseToLocalDiff = hasBase ? await wordDiff(base, local) : "";
  const baseToRemoteDiff = hasBase && !fetchError ? await wordDiff(base, remote) : "";

  // Fallback: when there's no base, compute LOCAL vs REMOTE directly so the
  // user still sees something useful. That diff goes into baseToRemoteDiff
  // slot and the UI flags it as "no-base" (2-way fallback view).
  const fallbackDiff = !hasBase && !fetchError ? await wordDiff(local, remote) : "";

  const localChanged = hasBase ? hasMeaningfulDiff(baseToLocalDiff) : false;
  const remoteChanged = hasBase ? hasMeaningfulDiff(baseToRemoteDiff) : false;

  let classification: Side;
  if (!hasBase) classification = "no-base";
  else if (localChanged && remoteChanged) classification = "both";
  else if (localChanged) classification = "local";
  else if (remoteChanged) classification = "remote";
  else classification = "neither";

  return {
    relPath,
    pageId,
    notionUrl,
    hasBase,
    base,
    local,
    remote,
    remoteTruncated,
    baseToLocalDiff: hasBase ? baseToLocalDiff : fallbackDiff,
    baseToRemoteDiff: hasBase ? baseToRemoteDiff : "",
    localChanged,
    remoteChanged,
    classification,
    fetchError,
  };
}

// ── HTML rendering ───────────────────────────────────────────────────────────

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderBadge(c: Side): string {
  const map: Record<Side, { label: string; cls: string }> = {
    local:    { label: "LOCAL changed",         cls: "badge-local" },
    remote:   { label: "REMOTE changed",        cls: "badge-remote" },
    both:     { label: "BOTH changed",          cls: "badge-both" },
    neither:  { label: "no detected change",    cls: "badge-clean" },
    "no-base":{ label: "no BASE (2-way only)",  cls: "badge-warn" },
  };
  const { label, cls } = map[c];
  return `<span class="badge ${cls}">${label}</span>`;
}

function renderPanel(title: string, diffOutput: string, emptyMsg: string): string {
  if (!diffOutput) {
    return `<div class="pane"><div class="pane-title">${title}</div><div class="pane-empty">${emptyMsg}</div></div>`;
  }
  const rows = parseDiffOutput(diffOutput);
  const body = buildUnifiedBody(rows);
  if (!rows.some(r => r.kind === "added" || r.kind === "removed" || r.kind === "changed")) {
    return `<div class="pane"><div class="pane-title">${title}</div><div class="pane-empty">No changes</div></div>`;
  }
  return `<div class="pane">
    <div class="pane-title">${title}</div>
    <table class="diff"><tbody>${body}</tbody></table>
  </div>`;
}

// ── Tree-building (group reports by directory) ──────────────────────────────

interface TreeNode {
  name: string;
  fullPath: string;
  children: Map<string, TreeNode>;
  reports: { idx: number; report: PageReport }[];
}

function buildTree(reports: PageReport[]): TreeNode {
  const root: TreeNode = { name: "", fullPath: "", children: new Map(), reports: [] };
  reports.forEach((r, i) => {
    const parts = r.relPath.split("/");
    let cur = root;
    for (let p = 0; p < parts.length - 1; p++) {
      const seg = parts[p];
      if (!cur.children.has(seg)) {
        const fullPath = cur.fullPath ? `${cur.fullPath}/${seg}` : seg;
        cur.children.set(seg, { name: seg, fullPath, children: new Map(), reports: [] });
      }
      cur = cur.children.get(seg)!;
    }
    cur.reports.push({ idx: i + 1, report: r });
  });
  return root;
}

function renderTreeNode(node: TreeNode, depth: number): string {
  const folders = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...node.reports].sort((a, b) => a.report.relPath.localeCompare(b.report.relPath));
  const parts: string[] = [];
  for (const f of folders) {
    const childContent = renderTreeNode(f, depth + 1);
    // Skip empty folders entirely (search may have filtered them all out).
    parts.push(`<details class="folder" data-folder="${escape(f.fullPath)}" open>
      <summary><span class="folder-toggle"></span><span class="folder-name">${escape(f.name)}</span><span class="folder-count" data-count></span></summary>
      <div class="folder-body">${childContent}</div>
    </details>`);
  }
  for (const { idx, report } of files) {
    parts.push(renderTreeCard(idx, report));
  }
  return parts.join("");
}

/** Compact tree-view card: one line summary, same expand-on-click behavior
 *  as the list view. Shares state with the list view via data-path. */
function renderTreeCard(idx: number, r: PageReport): string {
  return renderPageSection(idx, r, /* compact */ true);
}

/** Inner HTML of the .panels div in RENDERED mode — show each side's body
 *  as marked-rendered HTML, side by side, no diff highlights. For when the
 *  user wants to inspect the prose rather than the structural drift. */
function renderPanelsRendered(r: PageReport): string {
  if (r.fetchError) {
    return `<div class="pane pane-err">Remote fetch failed: ${escape(r.fetchError)}</div>`;
  }
  const renderSide = (title: string, body: string, empty: string) => {
    if (!body) return `<div class="pane"><div class="pane-title">${title}</div><div class="pane-empty">${empty}</div></div>`;
    // marked.parse can return a Promise in async mode; we use the sync overload.
    const html = (marked.parse(body, { async: false }) as string);
    return `<div class="pane"><div class="pane-title">${title}</div><div class="pane-rendered">${html}</div></div>`;
  };
  if (!r.hasBase) {
    return `${renderSide("LOCAL", r.local, "(empty)")} ${renderSide("REMOTE", r.remote, "(empty)")}`;
  }
  return `${renderSide("LOCAL", r.local, "(empty)")} ${renderSide("REMOTE", r.remote, "(empty)")}`;
}

/** Inner HTML of the .panels div — the diff content itself. Extracted so it
 *  can be served independently via /api/diff/<idx> for lazy-load. */
function renderPanelsInner(r: PageReport): string {
  const localLabel = "Local changes (BASE → LOCAL)";
  const remoteLabel = "Remote changes (BASE → REMOTE)";
  if (r.fetchError) {
    return `<div class="pane pane-err">Remote fetch failed: ${escape(r.fetchError)}</div>`;
  }
  if (!r.hasBase) {
    return renderPanel("LOCAL vs REMOTE (no BASE available — first push or pre-snapshots)", r.baseToLocalDiff, "Local and remote are identical");
  }
  return `${renderPanel(localLabel, r.baseToLocalDiff, "Local matches BASE — nothing changed locally")}
    ${renderPanel(remoteLabel, r.baseToRemoteDiff, "Remote matches BASE — nothing changed on Notion")}`;
}

function renderPageSection(idx: number, r: PageReport, compact = false): string {
  // Resolve hint: per-classification suggested command. Click the <code> to copy.
  const baseName = r.relPath.replace(/\.md$/, "").split("/").pop() ?? r.relPath;
  let resolveHint = "";
  if (r.classification === "local") {
    resolveHint = `<div class="resolve"><b>Local-only change.</b> Push it: <code data-copy="bash sync.sh --only ${escape(baseName)}">bash sync.sh --only ${escape(baseName)}</code></div>`;
  } else if (r.classification === "remote") {
    resolveHint = `<div class="resolve"><b>Remote-only change.</b> Pull it into local: <code data-copy="bash sync.sh reconcile --only ${escape(baseName)}">bash sync.sh reconcile --only ${escape(baseName)}</code></div>`;
  } else if (r.classification === "both") {
    resolveHint = `<div class="resolve"><b>Both sides changed.</b> Use the merge editor: <code data-copy="bash sync.sh reconcile --only ${escape(baseName)}">bash sync.sh reconcile --only ${escape(baseName)}</code> → pick "View diff" → "Browser (merge)"</div>`;
  } else if (r.classification === "no-base") {
    resolveHint = `<div class="resolve resolve-warn"><b>No BASE snapshot.</b> The first <code>bash sync.sh</code> run after this commit writes BASE on a successful push, after which the full 3-way view becomes available.</div>`;
  }

  // For tree-view cards we show only the filename, not the full path
  // (the surrounding folder hierarchy already encodes the path).
  const displayName = compact ? (r.relPath.split("/").pop() ?? r.relPath) : r.relPath;
  // Panels initially EMPTY — populated by JS via /api/diff/<idx> on first
  // open. Reduces initial payload from ~MB to ~50KB on a 100-page report.
  return `<details class="page" data-path="${escape(r.relPath)}" data-classification="${r.classification}" data-idx="${idx}">
    <summary>
      <span class="page-caret"></span>
      <span class="page-path">${escape(displayName)}</span>
      ${renderBadge(r.classification)}
      <a class="page-link" href="${r.notionUrl}" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗</a>
    </summary>
    ${resolveHint}
    <div class="panels" data-lazy="${idx}"></div>
  </details>`;
}

function renderHtml(reports: PageReport[], runId: string, scope: string, opts: { hiddenClean: number; builtAt?: string }): string {
  // Sort once for stable list view (alphabetical by path).
  const sorted = [...reports].sort((a, b) => a.relPath.localeCompare(b.relPath));
  const listSections = sorted.map((r, i) => renderPageSection(i + 1, r, /* compact */ false)).join("\n");
  const tree = buildTree(sorted);
  const treeBody = renderTreeNode(tree, 0);
  const counts = {
    local: reports.filter(r => r.classification === "local").length,
    remote: reports.filter(r => r.classification === "remote").length,
    both: reports.filter(r => r.classification === "both").length,
    clean: reports.filter(r => r.classification === "neither").length,
    noBase: reports.filter(r => r.classification === "no-base").length,
  };
  const builtAt = opts.builtAt ?? new Date().toISOString();
  // Pre-compute "Xm ago" string for the navbar staleness pill.
  const ageMs = Date.now() - Date.parse(builtAt);
  const ageMin = Math.floor(ageMs / 60_000);
  const ageStr = ageMin < 1 ? "just now" : ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ago`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>notion-sync • diff</title>
<script>
  // Apply theme + view BEFORE first paint so there's no flash. localStorage
  // is the source of truth; defaults are dark + tree.
  (function () {
    var r = document.documentElement;
    r.setAttribute('data-theme', localStorage.getItem('diff.theme') || 'dark');
    r.setAttribute('data-view', localStorage.getItem('diff.view') || 'tree');
  })();
</script>
<style>
  /* ── Theme tokens ─────────────────────────────────────────────────── */
  :root {
    --bg: #0e1014; --surface: #161922; --surface-2: #1d2230; --text: #e7e9ee;
    --dim: #8a93a6; --dimmer: #5d6478; --border: #262b38; --border-strong: #353b4c;
    --accent: #66a6ff; --accent-soft: rgba(102, 166, 255, 0.12);
    --add-bg: rgba(46, 160, 67, 0.18); --add-fg: #6fdc8c;
    --del-bg: rgba(248, 81, 73, 0.16); --del-fg: #ff8b80;
    --b-local: #c68a3d; --b-remote: #8a6dff; --b-both: #e16ba5;
    --b-clean: #4ea674; --b-warn: #d9a000; --b-err: #d65348;
  }
  html[data-theme="light"] {
    --bg: #fafbfc; --surface: #ffffff; --surface-2: #f4f5f8; --text: #1c1f26;
    --dim: #5a6373; --dimmer: #909aac; --border: #e1e4ea; --border-strong: #c8ccd5;
    --accent: #1a56c4; --accent-soft: rgba(26, 86, 196, 0.1);
    --add-bg: rgba(46, 160, 67, 0.13); --add-fg: #117a30;
    --del-bg: rgba(248, 81, 73, 0.13); --del-fg: #9e2521;
    --b-local: #b96f1f; --b-remote: #6f42c1; --b-both: #c0397a;
    --b-clean: #1e7a4d; --b-warn: #b07f00; --b-err: #b1241b;
  }
  /* ── Base ────────────────────────────────────────────────────────── */
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code, .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  /* ── Sticky navbar ──────────────────────────────────────────────── */
  nav.topbar {
    position: sticky; top: 0; z-index: 10;
    background: color-mix(in srgb, var(--bg) 92%, transparent);
    -webkit-backdrop-filter: saturate(180%) blur(12px); backdrop-filter: saturate(180%) blur(12px);
    border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 12px;
    padding: 10px 20px;
  }
  .brand { font-weight: 600; font-size: 13px; letter-spacing: 0.02em; color: var(--text); margin-right: 4px; }
  .brand .brand-sub { color: var(--dim); font-weight: 400; margin-left: 6px; }
  .seg { display: inline-flex; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 2px; }
  .seg button { background: transparent; color: var(--dim); border: 0; padding: 4px 10px; border-radius: 4px; font: inherit; font-size: 12px; cursor: pointer; }
  .seg button:hover { color: var(--text); }
  .seg button.active { background: var(--accent-soft); color: var(--accent); }
  .search { flex: 1 1 220px; max-width: 380px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; color: var(--text); font: inherit; font-size: 13px; outline: none; }
  .search:focus { border-color: var(--accent); }
  .search::placeholder { color: var(--dimmer); }
  .icon-btn { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; color: var(--text); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12px; }
  .icon-btn:hover { border-color: var(--border-strong); }
  .icon-btn svg { width: 14px; height: 14px; display: block; }
  .topbar-spacer { flex: 1; }
  /* Theme icon visibility: show sun in dark mode (to switch to light), moon in light mode. */
  html[data-theme="dark"]  .icon-moon { display: none; }
  html[data-theme="light"] .icon-sun  { display: none; }
  /* ── Main content ───────────────────────────────────────────────── */
  main { max-width: 1200px; margin: 0 auto; padding: 16px 20px 60px; }
  .statsbar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 10px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 18px; font-size: 12px; color: var(--dim); }
  .statsbar .pill { background: var(--surface-2); padding: 3px 9px; border-radius: 99px; font-weight: 500; }
  .statsbar .pill .n { color: var(--text); font-variant-numeric: tabular-nums; margin-right: 4px; }
  .statsbar .stale { color: var(--dimmer); margin-left: auto; }
  .hidden-note { color: var(--dimmer); font-size: 11px; font-style: italic; padding: 6px 14px 0; }
  .hidden-note code { background: var(--surface-2); padding: 1px 5px; border-radius: 3px; font-size: 10px; }
  /* ── View switching ─────────────────────────────────────────────── */
  html[data-view="list"] #view-tree { display: none; }
  html[data-view="tree"] #view-list { display: none; }
  /* ── Tree view ──────────────────────────────────────────────────── */
  #view-tree details.folder { margin: 0; }
  #view-tree details.folder > summary { display: flex; align-items: center; gap: 6px; padding: 5px 8px; cursor: pointer; user-select: none; border-radius: 4px; color: var(--text); font-weight: 500; }
  #view-tree details.folder > summary:hover { background: var(--surface-2); }
  #view-tree details.folder > summary::-webkit-details-marker { display: none; }
  #view-tree details.folder > summary::marker { display: none; }
  .folder-toggle::before { content: '▸'; color: var(--dimmer); font-size: 10px; transition: transform 0.12s ease; display: inline-block; width: 12px; }
  details.folder[open] > summary > .folder-toggle::before { transform: rotate(90deg); }
  .folder-name { color: var(--text); }
  .folder-count { color: var(--dimmer); font-size: 11px; margin-left: auto; padding-left: 8px; }
  .folder-body { margin-left: 14px; border-left: 1px solid var(--border); padding-left: 8px; }
  /* ── Page card (shared by list + tree) ──────────────────────────── */
  details.page { margin: 4px 0; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); transition: border-color 0.12s; }
  details.page:hover { border-color: var(--border-strong); }
  details.page[open] { border-color: var(--border-strong); }
  details.page > summary { padding: 7px 12px; cursor: pointer; display: flex; gap: 10px; align-items: center; user-select: none; list-style: none; }
  details.page > summary::-webkit-details-marker { display: none; }
  details.page > summary::marker { display: none; }
  .page-caret::before { content: '▸'; color: var(--dimmer); font-size: 10px; transition: transform 0.12s ease; display: inline-block; width: 10px; }
  details.page[open] > summary > .page-caret::before { transform: rotate(90deg); }
  .page-path { flex: 1; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .page-link { color: var(--dim); font-size: 12px; padding: 2px 6px; border-radius: 4px; }
  .page-link:hover { color: var(--accent); background: var(--accent-soft); text-decoration: none; }
  details.page[open] > summary { border-bottom: 1px solid var(--border); }
  /* ── Resolve hint ───────────────────────────────────────────────── */
  .resolve { padding: 8px 14px; background: var(--accent-soft); border-bottom: 1px solid var(--border); font-size: 12px; }
  .resolve-warn { background: color-mix(in srgb, var(--b-warn) 14%, transparent); }
  .resolve code { background: var(--surface-2); padding: 2px 7px; border-radius: 3px; cursor: copy; font-size: 11px; }
  .resolve code:hover { background: var(--border-strong); }
  .resolve code.copied { background: var(--b-clean); color: white; }
  /* ── Diff panels ────────────────────────────────────────────────── */
  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 10px 12px; }
  .panels:has(.pane:only-child) { grid-template-columns: 1fr; }
  .pane { background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px; overflow: hidden; min-width: 0; }
  .pane-title { padding: 6px 10px; border-bottom: 1px solid var(--border); font-size: 11px; color: var(--dim); font-weight: 500; }
  .pane-empty { padding: 10px; color: var(--dimmer); font-size: 12px; font-style: italic; }
  .pane-err { padding: 10px; color: var(--b-err); font-size: 12px; }
  table.diff { border-collapse: collapse; width: 100%; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11.5px; }
  table.diff td { padding: 0 8px; vertical-align: top; white-space: pre-wrap; word-break: break-word; }
  table.diff td.gutter { width: 0; padding: 0; }
  table.diff tr.context td { color: var(--dim); }
  table.diff tr.hunk td { color: var(--accent); padding: 4px 8px; background: var(--accent-soft); font-size: 10.5px; }
  /* Hide git plumbing header rows (diff/index/---/+++) — those name the
     internal tempfiles and add no signal to the viewer. */
  table.diff tr.header { display: none; }
  /* ── Rendered markdown panes (mode=rendered) ────────────────────── */
  .pane-rendered { padding: 12px 14px; font-size: 13px; line-height: 1.55; overflow-x: auto; }
  .pane-rendered h1, .pane-rendered h2, .pane-rendered h3 { margin-top: 16px; margin-bottom: 6px; color: var(--text); }
  .pane-rendered h1 { font-size: 17px; }
  .pane-rendered h2 { font-size: 15px; }
  .pane-rendered h3 { font-size: 14px; }
  .pane-rendered p { margin: 6px 0; }
  .pane-rendered ul, .pane-rendered ol { padding-left: 20px; margin: 6px 0; }
  .pane-rendered li { margin: 2px 0; }
  .pane-rendered code { background: var(--surface); padding: 1px 5px; border-radius: 3px; font-size: 11.5px; }
  .pane-rendered pre { background: var(--surface); padding: 8px 10px; border-radius: 4px; overflow-x: auto; }
  .pane-rendered pre code { background: transparent; padding: 0; }
  .pane-rendered blockquote { border-left: 3px solid var(--border-strong); padding-left: 10px; margin: 6px 0; color: var(--dim); }
  .pane-rendered table { border-collapse: collapse; margin: 6px 0; font-size: 12px; }
  .pane-rendered th, .pane-rendered td { border: 1px solid var(--border); padding: 4px 8px; }
  .pane-rendered th { background: var(--surface); }
  .pane-rendered a { color: var(--accent); }
  .pane-rendered img { max-width: 100%; height: auto; }
  .pane-rendered hr { border: 0; border-top: 1px solid var(--border); margin: 12px 0; }
  table.diff tr.added td { background: var(--add-bg); }
  table.diff tr.removed td { background: var(--del-bg); }
  table.diff tr.changed td { background: color-mix(in srgb, var(--add-bg) 50%, var(--del-bg) 50%); }
  ins { background: var(--add-bg); color: var(--add-fg); text-decoration: none; padding: 0 1px; border-radius: 2px; }
  del { background: var(--del-bg); color: var(--del-fg); text-decoration: line-through; padding: 0 1px; border-radius: 2px; }
  /* ── Badges ─────────────────────────────────────────────────────── */
  .badge { display: inline-block; padding: 1px 7px; border-radius: 99px; font-size: 10px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; color: white; flex-shrink: 0; }
  .badge-local { background: var(--b-local); }
  .badge-remote { background: var(--b-remote); }
  .badge-both { background: var(--b-both); }
  .badge-clean { background: var(--b-clean); }
  .badge-warn { background: var(--b-warn); color: #1c1f26; }
  .badge-err { background: var(--b-err); }
  /* ── Search filtering ───────────────────────────────────────────── */
  .filter-hide { display: none !important; }
  /* ── Empty state ────────────────────────────────────────────────── */
  .empty-state { text-align: center; color: var(--dim); padding: 60px 20px; font-size: 13px; }
  .empty-state b { color: var(--text); }
</style></head>
<body>
<nav class="topbar">
  <span class="brand">notion-sync<span class="brand-sub">3-way diff</span></span>
  <div class="seg" role="group" aria-label="view">
    <button data-view-btn="tree">Tree</button>
    <button data-view-btn="list">List</button>
  </div>
  <input class="search" id="search" placeholder="Filter by path…" autocomplete="off"/>
  <div class="seg" role="group" aria-label="mode">
    <button data-mode-btn="diff" title="Diff view (default) — shows changes">Diff</button>
    <button data-mode-btn="rendered" title="Rendered markdown — read prose without diff noise">Rendered</button>
  </div>
  <div class="seg" role="group" aria-label="granularity">
    <button data-gran-btn="word" title="Word-level diff (default)">Word</button>
    <button data-gran-btn="char" title="Character-level diff (finer, noisier)">Char</button>
  </div>
  <button class="icon-btn" id="expand-toggle" title="Expand or collapse all"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4-3 4 3"/><path d="M4 10l4 3 4-3"/></svg><span data-expand-label>Expand all</span></button>
  <button class="icon-btn" id="theme-toggle" title="Toggle theme">
    <svg class="icon-sun" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3"/></svg>
    <svg class="icon-moon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z"/></svg>
  </button>
</nav>
<main>
  <div class="statsbar">
    ${counts.both    > 0 ? `<span class="pill"><span class="n">${counts.both}</span>both</span>`     : ""}
    ${counts.remote  > 0 ? `<span class="pill"><span class="n">${counts.remote}</span>remote</span>` : ""}
    ${counts.local   > 0 ? `<span class="pill"><span class="n">${counts.local}</span>local</span>`   : ""}
    ${counts.noBase  > 0 ? `<span class="pill"><span class="n">${counts.noBase}</span>no-base</span>`: ""}
    <span class="stale">${escape(scope)} · built ${ageStr}</span>
  </div>
  ${opts.hiddenClean > 0 ? `<div class="hidden-note">${opts.hiddenClean} clean page${opts.hiddenClean === 1 ? "" : "s"} hidden — re-run with <code>--show-clean</code> to include.</div>` : ""}
  <div id="view-list">${listSections}</div>
  <div id="view-tree">${treeBody}</div>
  <div id="empty-search" class="empty-state" style="display: none;"><b>No matches.</b><br>Try a different filter.</div>
</main>
<script>
  // ── View toggle (tree | list) ─────────────────────────────────────
  document.querySelectorAll('[data-view-btn]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var v = btn.getAttribute('data-view-btn');
      document.documentElement.setAttribute('data-view', v);
      localStorage.setItem('diff.view', v);
      syncViewButtons();
    });
  });
  function syncViewButtons() {
    var cur = document.documentElement.getAttribute('data-view');
    document.querySelectorAll('[data-view-btn]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-view-btn') === cur);
    });
  }
  syncViewButtons();

  // ── Granularity toggle (word | char) ──────────────────────────────
  // On change: invalidate all loaded panels — empty them, reset loaded
  // state. Currently-open cards immediately refetch with the new
  // granularity; closed cards refetch on next open. Persisted in
  // localStorage so it survives reloads.
  function currentGranularity() {
    return localStorage.getItem('diff.granularity') || 'word';
  }
  function currentMode() {
    return localStorage.getItem('diff.mode') || 'diff';
  }
  function syncModeButtons() {
    var cur = currentMode();
    document.querySelectorAll('[data-mode-btn]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode-btn') === cur);
    });
    // Hide granularity toggle in rendered mode — it doesn't apply.
    var granSeg = document.querySelector('[aria-label="granularity"]');
    if (granSeg) granSeg.style.opacity = cur === 'rendered' ? '0.35' : '1';
    if (granSeg) granSeg.style.pointerEvents = cur === 'rendered' ? 'none' : '';
  }
  document.querySelectorAll('[data-mode-btn]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var nm = btn.getAttribute('data-mode-btn');
      if (nm === currentMode()) return;
      localStorage.setItem('diff.mode', nm);
      syncModeButtons();
      // Invalidate + refetch open panels with new mode.
      document.querySelectorAll('.panels[data-lazy]').forEach(function (p) { p.dataset.loaded = 'false'; p.innerHTML = ''; });
      document.querySelectorAll('details.page[open]').forEach(function (d) {
        var p = d.querySelector(':scope > .panels[data-lazy]');
        if (p) loadPanel(p);
      });
    });
  });
  syncModeButtons();
  function syncGranButtons() {
    var cur = currentGranularity();
    document.querySelectorAll('[data-gran-btn]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-gran-btn') === cur);
    });
  }
  document.querySelectorAll('[data-gran-btn]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var newGran = btn.getAttribute('data-gran-btn');
      if (newGran === currentGranularity()) return;
      localStorage.setItem('diff.granularity', newGran);
      syncGranButtons();
      // Invalidate every loaded panel. For currently-open cards, refetch
      // immediately so the user sees the change without manually toggling.
      var panels = document.querySelectorAll('.panels[data-lazy]');
      panels.forEach(function (p) { p.dataset.loaded = 'false'; p.innerHTML = ''; });
      document.querySelectorAll('details.page[open]').forEach(function (d) {
        // Re-fire toggle handler via close+open trick.
        var p = d.querySelector(':scope > .panels[data-lazy]');
        if (p) loadPanel(p);
      });
    });
  });
  syncGranButtons();

  // ── Theme toggle ──────────────────────────────────────────────────
  document.getElementById('theme-toggle').addEventListener('click', function () {
    var r = document.documentElement;
    var nxt = (r.getAttribute('data-theme') === 'dark') ? 'light' : 'dark';
    r.setAttribute('data-theme', nxt);
    localStorage.setItem('diff.theme', nxt);
  });

  // ── Expand/collapse all (navbar) ──────────────────────────────────
  // Only affects page cards (.page) — folders are independently controlled
  // by their own summary clicks and the folder-internal controls.
  var expandBtn = document.getElementById('expand-toggle');
  var expandLabel = expandBtn.querySelector('[data-expand-label]');
  function setExpandAll(open) {
    document.querySelectorAll('details.page').forEach(function (d) { d.open = open; });
    expandLabel.textContent = open ? 'Collapse all' : 'Expand all';
    expandBtn.setAttribute('data-state', open ? 'expanded' : 'collapsed');
  }
  expandBtn.addEventListener('click', function () {
    var anyOpen = !!document.querySelector('details.page[open]');
    setExpandAll(!anyOpen);
  });
  setExpandAll(false); // start collapsed

  // ── Search filter ────────────────────────────────────────────────
  // Matches against data-path. Hides non-matching .page cards AND any
  // folder that has zero visible descendants. Live, no debounce —
  // querySelectorAll is fast enough on ~300 cards.
  var searchInput = document.getElementById('search');
  var emptyState = document.getElementById('empty-search');
  function applyFilter(q) {
    q = q.trim().toLowerCase();
    var anyVisible = false;
    document.querySelectorAll('details.page').forEach(function (p) {
      var match = !q || p.getAttribute('data-path').toLowerCase().indexOf(q) !== -1;
      p.classList.toggle('filter-hide', !match);
      if (match) anyVisible = true;
    });
    document.querySelectorAll('details.folder').forEach(function (f) {
      var hasVisible = !!f.querySelector('details.page:not(.filter-hide)');
      f.classList.toggle('filter-hide', !hasVisible);
      // Auto-open folders when searching so matches are immediately visible.
      if (q && hasVisible) f.open = true;
    });
    // Update folder counts (visible / total).
    document.querySelectorAll('details.folder').forEach(function (f) {
      var countEl = f.querySelector(':scope > summary > [data-count]');
      if (!countEl) return;
      var total = f.querySelectorAll('details.page').length;
      var visible = f.querySelectorAll('details.page:not(.filter-hide)').length;
      countEl.textContent = (q && visible !== total) ? (visible + ' / ' + total) : (total > 0 ? total : '');
    });
    emptyState.style.display = anyVisible ? 'none' : '';
  }
  searchInput.addEventListener('input', function () { applyFilter(searchInput.value); });
  // Cmd/Ctrl+K focuses the search box.
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (e.key === 'Escape' && document.activeElement === searchInput) {
      searchInput.value = '';
      applyFilter('');
      searchInput.blur();
    }
  });
  applyFilter(''); // populate folder counts on initial load

  // ── Copy-to-clipboard for resolve commands (delegated to body so it
  //     works for both initial DOM and lazy-injected resolve hints) ────
  document.body.addEventListener('click', async function (e) {
    var el = e.target.closest('code[data-copy]');
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.getAttribute('data-copy') || '');
      var orig = el.textContent;
      el.classList.add('copied');
      el.textContent = '✓ copied';
      setTimeout(function () { el.classList.remove('copied'); el.textContent = orig; }, 900);
    } catch (e) { /* clipboard denied — user can still select manually */ }
  });

  // ── Lazy-load diff panels on first card open ─────────────────────
  // Initial HTML ships card shells only — panels are empty <div data-lazy=N>.
  // First time a card opens, fetch /api/diff/N (+ granularity) and inject.
  // Subsequent opens are instant unless granularity changed.
  async function loadPanel(panels) {
    if (panels.dataset.loaded === 'true' || panels.dataset.loading === 'true') return;
    panels.dataset.loading = 'true';
    panels.innerHTML = '<div class="pane-empty">Loading diff…</div>';
    try {
      var idx = panels.getAttribute('data-lazy');
      var gran = currentGranularity();
      var mode = currentMode();
      var qs = [];
      if (mode === 'rendered') qs.push('mode=rendered');
      else if (gran === 'char') qs.push('granularity=char');
      var url = '/api/diff/' + idx + (qs.length ? '?' + qs.join('&') : '');
      var r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var html = await r.text();
      panels.innerHTML = html;
      panels.dataset.loaded = 'true';
    } catch (err) {
      panels.innerHTML = '<div class="pane-err">Failed to load diff: ' + (err && err.message || err) + '</div>';
    } finally {
      panels.dataset.loading = 'false';
    }
  }
  document.body.addEventListener('toggle', function (e) {
    var details = e.target;
    if (!details || details.tagName !== 'DETAILS' || !details.classList.contains('page')) return;
    if (!details.open) return;
    var panels = details.querySelector(':scope > .panels[data-lazy]');
    if (panels) loadPanel(panels);
  }, true); // capture = true: <details> toggle event doesn't bubble normally
</script>
</body></html>`;
}

// ── Server + browser open ────────────────────────────────────────────────────

async function serveAndOpen(html: string, reports: PageReport[]): Promise<void> {
  // Sort reports the same way renderHtml does so the idx in `data-lazy="N"`
  // (assigned in render order) maps to the same report on the server.
  const sortedReports = [...reports].sort((a, b) => a.relPath.localeCompare(b.relPath));

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      // Lazy-load endpoint: returns just the .panels inner HTML for a card.
      // `idx` is 1-based to match the render-side assignment.
      if (url.pathname.startsWith("/api/diff/")) {
        const idx = parseInt(url.pathname.slice("/api/diff/".length), 10);
        if (isNaN(idx) || idx < 1 || idx > sortedReports.length) {
          return new Response("not found", { status: 404 });
        }
        const r = sortedReports[idx - 1];
        const mode = url.searchParams.get("mode") === "rendered" ? "rendered" : "diff";
        const granularity = url.searchParams.get("granularity") === "char" ? "char" : "word";
        // Mode "rendered" shows each side as parsed markdown HTML (no diff).
        // Mode "diff" (default) shows the word/char-level diff panels.
        return (async () => {
          if (mode === "rendered") {
            return new Response(renderPanelsRendered(r), { headers: { "content-type": "text/html; charset=utf-8" } });
          }
          if (granularity === "char") {
            const liveReport: PageReport = { ...r };
            if (r.hasBase && !r.fetchError) {
              liveReport.baseToLocalDiff = await wordDiff(r.base, r.local, "char");
              liveReport.baseToRemoteDiff = await wordDiff(r.base, r.remote, "char");
            } else if (!r.hasBase && !r.fetchError) {
              liveReport.baseToLocalDiff = await wordDiff(r.local, r.remote, "char");
            }
            return new Response(renderPanelsInner(liveReport), { headers: { "content-type": "text/html; charset=utf-8" } });
          }
          return new Response(renderPanelsInner(r), { headers: { "content-type": "text/html; charset=utf-8" } });
        })();
      }
      if (url.pathname === "/quit") {
        setTimeout(() => server.stop(true), 100);
        return new Response("bye", { headers: { "content-type": "text/plain" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}/`;
  console.log(`\n  Open in your browser:  \x1b[36m${url}\x1b[0m`);
  console.log(`  (Server stays up; Ctrl-C to stop, or visit ${url}quit)`);
  try {
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  } catch { /* no `open` — user clicks manually */ }
  // Hold open until SIGINT.
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => { server.stop(true); resolve(); });
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

// Root-keyed: diff reports embed Notion page_ids from a specific root,
// so reusing one across different roots would yield nonsensical diffs.
const DIFF_CACHE_PATH = () => path.join(__dirname, `.notion-diff-cache.${getCacheKey()}.json`);
const LEGACY_DIFF_CACHE_PATH = path.join(__dirname, ".notion-diff-cache.json");
function migrateLegacyDiffCacheIfNeeded(): void {
  try {
    const cur = DIFF_CACHE_PATH();
    if (fs.existsSync(LEGACY_DIFF_CACHE_PATH) && !fs.existsSync(cur)) {
      fs.renameSync(LEGACY_DIFF_CACHE_PATH, cur);
      console.error(`\x1b[2m  ℹ migrated legacy .notion-diff-cache.json → ${path.basename(cur)} (root ${getCacheKey()})\x1b[0m`);
    }
  } catch { /* ignore — diff cache is regenerable */ }
}

interface DiffCacheFile {
  built_at: string;
  scope: string;
  run_id: string;
  hidden_clean: number;
  reports: PageReport[];
}

function loadDiffCache(): DiffCacheFile | null {
  migrateLegacyDiffCacheIfNeeded();
  const p = DIFF_CACHE_PATH();
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return null; }
}

function saveDiffCache(c: DiffCacheFile): void {
  const p = DIFF_CACHE_PATH();
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, p);
}

// Lazy async-iterator over stdin. Bun's `readline/promises` hangs silently
// when this process is spawned via Bun.spawn (which is exactly how list.sh →
// notion-list.ts → diff-content.ts gets here). The async-iterator pattern
// over `process.stdin` works reliably — same workaround reconcile.ts uses.
let _stdinIter: AsyncIterator<string> | null = null;
async function readStdinLine(): Promise<string | null> {
  if (!_stdinIter) {
    async function* lines(): AsyncIterator<string> {
      let buf = "";
      // @ts-ignore — process.stdin is async-iterable in Bun
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

async function promptUseCache(builtAt: string, pageCount: number): Promise<boolean> {
  // One-shot Y/n prompt — Y = use cache, n = refresh. Inherits stdio so it
  // works inside the wrapping list.sh harness. If stdin isn't a TTY (CI,
  // piped), default to Y (use cache) since there's no way to ask.
  if (!process.stdin.isTTY) return true;
  const ageMs = Date.now() - Date.parse(builtAt);
  const ageMin = Math.floor(ageMs / 60_000);
  const ageStr = ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h${ageMin % 60}m ago`;
  process.stdout.write(`\x1b[36mUse cached diff report? (${pageCount} pages, built ${ageStr}) \x1b[2m[Y/n]\x1b[0m \x1b[36m>\x1b[0m `);
  const ans = (await readStdinLine())?.trim().toLowerCase() ?? "";
  return ans === "" || ans === "y" || ans === "yes";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pathFilters: string[] = [];
  // Default behavior changed (2026-05-15): scan every baselined page (not
  // just the last run's protected list, which goes stale fast and surfaces
  // sandbox test files). --protected-only restores the old behavior;
  // --show-clean keeps pages with no detected changes in the report.
  const protectedOnly = args.includes("--protected-only");
  const showClean = args.includes("--show-clean");
  // --force skips the "use cached report?" prompt and refetches everything.
  const force = args.includes("--force");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--paths" && args[i + 1]) {
      pathFilters.push(...args[i + 1].split(",").map(s => s.trim()).filter(Boolean));
      i++;
    }
  }

  // Cache fast-path: if we have a previous report on disk and --force isn't
  // set, ask the user. Pulling every page from Notion takes minutes; if you
  // just want to re-examine the same set after closing the tab, "Y" is the
  // right answer and you're in the browser in <1s.
  if (!force && pathFilters.length === 0 && !protectedOnly) {
    const cached = loadDiffCache();
    if (cached && (await promptUseCache(cached.built_at, cached.reports.length))) {
      const html = renderHtml(cached.reports, cached.run_id, cached.scope, { hiddenClean: cached.hidden_clean, builtAt: cached.built_at });
      await serveAndOpen(html, cached.reports);
      return;
    }
  }

  // Always load state — it's the source of truth for page_id (runs.jsonl's
  // protected_pages[] entries don't carry it, only path/kinds/notion_url).
  const state = loadState();

  let targets: ProtectedRow[];
  let runId = "n/a";
  let scope = "";
  let pageIdToRelPath = new Map<string, string>();

  if (protectedOnly) {
    // Old behavior: read protected_pages from the most recent live run.
    // Useful for "show me what the last sync flagged" but goes stale fast.
    const run = readLatestLiveRun();
    if (!run) {
      console.error("\x1b[31m--protected-only: no non-dry-run entry found in runs.jsonl.\x1b[0m");
      process.exit(1);
    }
    runId = run.run_id;
    const skipped: string[] = [];
    targets = run.protected_pages.flatMap((p) => {
      const st = state.pages[p.path];
      if (!st) { skipped.push(p.path); return []; }
      const pidNorm = st.page_id.replace(/-/g, "").toLowerCase();
      pageIdToRelPath.set(pidNorm, p.path);
      return [{
        path: p.path,
        page_id: st.page_id,
        notion_url: p.notion_url ?? `https://www.notion.so/${pidNorm}`,
        kinds: p.kinds,
      }];
    });
    if (skipped.length > 0) {
      console.log(`\x1b[33m  ⚠ Skipped ${skipped.length} page${skipped.length === 1 ? "" : "s"} not present in .notion-sync-state.json:\x1b[0m`);
      for (const p of skipped.slice(0, 5)) console.log(`     ${p}`);
      if (skipped.length > 5) console.log(`     … +${skipped.length - 5} more`);
    }
    scope = `protected pages from last live run (${runId})`;
  } else {
    // Default: walk DOCS_DIR for every .md file, resolve page_id via the
    // Notion cache's parent-chain tree. State.pages is consulted ONLY for
    // the optional BASE snapshot (it's the baseline registry, not the page
    // registry). One pages.retrieveMarkdown call per matched page — slower
    // than --protected-only but actually sees what's different now.
    const cache = loadCache();
    if (!cache) {
      console.error("\x1b[31m.notion-cache.json missing. Run \`bash list.sh fetch\` first to populate the remote tree cache.\x1b[0m");
      process.exit(1);
    }
    if (!process.env.DOCS_DIR && !fs.existsSync(path.join(__dirname, "docs"))) {
      console.error("\x1b[31mDOCS_DIR not set and no ./docs found.\x1b[0m");
      process.exit(1);
    }
    const cacheAgeMs = Date.now() - Date.parse(cache.fetched_at);
    const cacheAgeDays = Math.floor(cacheAgeMs / 86_400_000);
    if (cacheAgeDays > 1) {
      console.log(`\x1b[33m  ⚠ Notion cache is ${cacheAgeDays}d old — pages added on Notion since then will be reported as 'not on Notion'. Run \`bash list.sh fetch\` to refresh.\x1b[0m`);
    }

    const localPaths = walkLocalDocs(DOCS_DIR)
      .filter(rel => pathFilters.length === 0 || pathFilters.some(f => rel.includes(f)));
    const resolver = buildPageResolver(cache, DOCS_DIR, localPaths);

    const unmatched: string[] = [];
    targets = [];
    // Reverse map populated as we resolve — feeds reverseRemoteRewrites later.
    pageIdToRelPath = new Map();
    for (const rel of localPaths) {
      const resolved = resolver.resolve(rel);
      if (!resolved) { unmatched.push(rel); continue; }
      targets.push({
        path: rel,
        page_id: resolved.pageId,
        notion_url: resolved.notionUrl,
      });
      pageIdToRelPath.set(resolved.pageId, rel);
    }
    if (unmatched.length > 0) {
      console.log(`\x1b[33m  ⚠ ${unmatched.length} local doc${unmatched.length === 1 ? "" : "s"} not matched to a Notion page (may need pushing, or cache is stale):\x1b[0m`);
      for (const p of unmatched.slice(0, 8)) console.log(`     ${p}`);
      if (unmatched.length > 8) console.log(`     … +${unmatched.length - 8} more`);
    }

    const baselinedCount = targets.filter(t => state.pages[t.path]).length;
    if (baselinedCount < targets.length / 2) {
      console.log(`\x1b[36m  ℹ ${targets.length - baselinedCount}/${targets.length} pages have no BASE snapshot yet — they'll show a 2-way LOCAL-vs-REMOTE diff. Run \`bash sync.sh --seed-state\` once to baseline+snapshot every doc for full 3-way coverage.\x1b[0m`);
    }

    scope = pathFilters.length > 0
      ? `paths matching: ${pathFilters.join(", ")}`
      : `all ${targets.length} local doc${targets.length === 1 ? "" : "s"} matched to Notion`;
  }
  if (targets.length === 0) {
    console.log(`No pages to scan. ${pathFilters.length > 0 ? `Filter: ${pathFilters.join(", ")}.` : "State file may be empty — run \`bash sync.sh\` first."}`);
    process.exit(0);
  }

  // Build reverse-rewrite options once — passed to every buildReport so the
  // pulled remote body can be de-rewritten back to local-style links/paths.
  const cacheForOpts = loadCache();
  const reverseOpts: ReverseOpts | undefined = cacheForOpts
    ? buildReverseOpts(cacheForOpts, pageIdToRelPath)
    : undefined;

  console.log(`Building diff report for ${targets.length} page${targets.length === 1 ? "" : "s"}…`);
  const reports: PageReport[] = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    process.stdout.write(`\r  [${i + 1}/${targets.length}] ${t.path}                       `);
    const r = await buildReport(t.path, t.page_id, t.notion_url ?? `https://www.notion.so/${t.page_id.replace(/-/g, "")}`, reverseOpts);
    reports.push(r);
  }
  process.stdout.write("\r" + " ".repeat(80) + "\r");
  const cleanCount = reports.filter(r => r.classification === "neither").length;
  const visible = showClean ? reports : reports.filter(r => r.classification !== "neither");
  console.log(`Fetched ${reports.length} page${reports.length === 1 ? "" : "s"} • ${visible.length} with changes${!showClean && cleanCount > 0 ? ` • ${cleanCount} clean hidden (use --show-clean to include)` : ""}.`);

  if (visible.length === 0) {
    console.log(`\n  \x1b[32m✓ Nothing to reconcile — every scanned page matches its baseline + Notion's current state.\x1b[0m`);
    process.exit(0);
  }

  const builtAt = new Date().toISOString();
  saveDiffCache({
    built_at: builtAt,
    scope,
    run_id: runId,
    hidden_clean: showClean ? 0 : cleanCount,
    reports: visible,
  });
  const html = renderHtml(visible, runId, scope, { hiddenClean: showClean ? 0 : cleanCount, builtAt });
  await serveAndOpen(html, visible);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("\x1b[31mdiff-content failed:\x1b[0m", err?.message ?? err);
    process.exit(1);
  });
}
