import { test, expect } from "bun:test";
import { normalizeForDiff, reverseRemoteRewrites } from "./diff-content";

// ── normalizeForDiff: the noise-reduction rules ──────────────────────────────

test("normalizeForDiff — strips code-fence language tags", () => {
  const out = normalizeForDiff("```javascript\ncode\n```\n");
  expect(out).toContain("```\ncode\n```");
  expect(out).not.toContain("```javascript");
});

test("normalizeForDiff — normalizes table separator dash count, preserves alignment", () => {
  const out = normalizeForDiff("| a | b | c |\n| ---- | :--- | ---: |\n");
  expect(out).toContain("| --- | :--- | ---: |");
});

test("normalizeForDiff — unescapes backslash-escaped prose punctuation", () => {
  const out = normalizeForDiff("a list\\- item with \\(parens\\) and \\> quote\n");
  expect(out).toContain("a list- item with (parens) and > quote");
});

test("normalizeForDiff — collapses image URLs to a stable placeholder (keeps alt)", () => {
  const out = normalizeForDiff("![the chart](https://prod-files-secure.s3.amazonaws.com/x/y.png)\n");
  expect(out).toContain("![the chart](IMG)");
});

test("normalizeForDiff — collapses 3+ blank lines to one + trims trailing", () => {
  const out = normalizeForDiff("a\n\n\n\n\nb\n\n\n");
  expect(out).toBe("a\n\nb\n");
});

// ── reverseRemoteRewrites: undo the push-side rewrites for clean diffs ────────

const opts = {
  pageIdToRelPath: new Map([["abc123def456abc123def456abc12345", "product/jobs/overview.md"]]),
  githubBase: "https://github.com/acme/repo/blob/main/docs",
  imageHostPrefixes: ["https://prod-files-secure.s3.amazonaws.com/"],
};

test("reverseRemoteRewrites — Notion URL → relative .md (URL-as-label collapses too)", () => {
  const body = "See [https://www.notion.so/abc123def456abc123def456abc12345](https://www.notion.so/abc123def456abc123def456abc12345).";
  const out = reverseRemoteRewrites(body, "product/jobs/queue.md", opts);
  // resolves to the relative path from queue.md's dir to overview.md
  expect(out).toContain("](overview.md)");
  expect(out).not.toContain("notion.so");
});

test("reverseRemoteRewrites — unknown Notion page id left untouched", () => {
  const body = "[x](https://www.notion.so/0000000000000000000000000000ffff)";
  expect(reverseRemoteRewrites(body, "a.md", opts)).toBe(body);
});

test("reverseRemoteRewrites — GitHub blob URL → repo-relative path", () => {
  const body = "[run.ts](https://github.com/acme/repo/blob/main/docs/lib/run.ts)";
  const out = reverseRemoteRewrites(body, "lib/other.md", opts);
  expect(out).toContain("](run.ts)");
  expect(out).not.toContain("github.com");
});

test("reverseRemoteRewrites — bare .md with auto-prepended http:// is stripped", () => {
  const body = "[debug-tools.md](http://debug-tools.md)";
  expect(reverseRemoteRewrites(body, "a.md", opts)).toBe("[debug-tools.md](debug-tools.md)");
});
