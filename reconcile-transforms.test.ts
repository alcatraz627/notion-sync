import { test, expect } from "bun:test";
import {
  stripSyncFooter,
  stripBreadcrumbAndBanner,
  convertMentionTagsToLinks,
  convertHtmlTablesToMarkdown,
  parseDiffOutput,
  buildUnifiedBody,
} from "./reconcile";

// ── stripSyncFooter ──────────────────────────────────────────────────────────

test("stripSyncFooter — removes the trailing Synced footer", () => {
  const body = "# Title\n\nContent here.\n\n---\n\n*Synced: 2026-05-24 10:00*\n";
  expect(stripSyncFooter(body)).toBe("# Title\n\nContent here.\n");
});

test("stripSyncFooter — no-op when no footer", () => {
  expect(stripSyncFooter("# Title\n\nbody\n")).toBe("# Title\n\nbody\n");
});

// ── stripBreadcrumbAndBanner ─────────────────────────────────────────────────

test("stripBreadcrumbAndBanner — cuts everything before the first H1", () => {
  const md = "> 📍 Breadcrumb > path\n> meta banner line\n\n# Real Title\n\nbody";
  expect(stripBreadcrumbAndBanner(md)).toBe("# Real Title\n\nbody");
});

test("stripBreadcrumbAndBanner — no H1 leaves content untouched", () => {
  const md = "> just a quote\nno heading here";
  expect(stripBreadcrumbAndBanner(md)).toBe(md);
});

// ── convertMentionTagsToLinks (incl the self-closing fix) ────────────────────

test("convertMentionTagsToLinks — paired form → markdown link", () => {
  const md = `See <mention-page url="https://www.notion.so/abc">Other Doc</mention-page> here.`;
  expect(convertMentionTagsToLinks(md)).toBe("See [Other Doc](https://www.notion.so/abc) here.");
});

test("convertMentionTagsToLinks — self-closing form (the regression fix)", () => {
  const md = `Ref <mention-page url="https://www.notion.so/xyz"/> end.`;
  // self-closing has no label → url becomes both label and href
  expect(convertMentionTagsToLinks(md)).toBe("Ref [https://www.notion.so/xyz](https://www.notion.so/xyz) end.");
});

// ── convertHtmlTablesToMarkdown (escapes + trailing empty cols) ──────────────

test("convertHtmlTablesToMarkdown — basic table → pipe table", () => {
  const html = `<table header-row="true"><tr><td>Name</td><td>Type</td></tr><tr><td>id</td><td>string</td></tr></table>`;
  const out = convertHtmlTablesToMarkdown(html);
  expect(out).toContain("| Name | Type |");
  expect(out).toContain("| --- | --- |");
  expect(out).toContain("| id | string |");
});

test("convertHtmlTablesToMarkdown — trims trailing empty columns (the ghost-column fix)", () => {
  const html = `<table><tr><td>A</td><td>B</td><td></td><td></td></tr><tr><td>1</td><td>2</td></tr></table>`;
  const out = convertHtmlTablesToMarkdown(html);
  // header collapses to 2 cols, not 4
  expect(out).toContain("| A | B |");
  expect(out).toContain("|" + " --- |".repeat(2));
  expect(out).not.toContain("| A | B |  |  |");
});

test("convertHtmlTablesToMarkdown — unescapes over-escaped cell punctuation", () => {
  const html = `<table><tr><td>Type</td></tr><tr><td>\\(H \\| false\\)</td></tr></table>`;
  const out = convertHtmlTablesToMarkdown(html);
  // backslash-escaped ( ) restored; literal pipe inside cell re-escaped as \|
  expect(out).toContain("(H \\| false)");
});

// ── parseDiffOutput + buildUnifiedBody ───────────────────────────────────────

test("parseDiffOutput — classifies hunk / added / removed / context rows", () => {
  const diff = [
    "diff --git a/x b/y", "index 111..222", "--- a/x", "+++ b/y",
    "@@ -1,3 +1,3 @@", " unchanged", "+added line", "-removed line",
  ].join("\n");
  const rows = parseDiffOutput(diff);
  const kinds = rows.map((r) => r.kind);
  expect(kinds).toContain("hunk");
  expect(kinds).toContain("added");
  expect(kinds).toContain("removed");
  expect(kinds).toContain("context");
  // git plumbing headers classified as "header" (hidden in the UI)
  expect(kinds).toContain("header");
});

test("parseDiffOutput — word-level [-del-]/{+ins+} markers become del/ins HTML", () => {
  const diff = "@@ -1 +1 @@\n[-old-]{+new+} text";
  const rows = parseDiffOutput(diff);
  const changed = rows.find((r) => r.kind === "changed");
  expect(changed).toBeDefined();
  expect(changed!.html).toContain("<del>old</del>");
  expect(changed!.html).toContain("<ins>new</ins>");
});

test("buildUnifiedBody — emits one <tr> per row with its kind class", () => {
  const rows = parseDiffOutput("@@ -1 +1 @@\n+x\n-y");
  const html = buildUnifiedBody(rows);
  expect(html).toContain('<tr class="added">');
  expect(html).toContain('<tr class="removed">');
  expect(html).toContain('<tr class="hunk">');
});
