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

test("normalizeForDiff — adjacent table separator rows stay separate (regression)", () => {
  // Two stacked separator rows must NOT merge into one (the \s-eats-\n bug).
  const out = normalizeForDiff("| a | b |\n| --- | --- |\n| --- | --- |\n");
  const sepLines = out.split("\n").filter((l) => l === "| --- | --- |");
  expect(sepLines.length).toBe(2);
});

// ── F1: frontmatter strip ────────────────────────────────────────────────────

test("normalizeForDiff — strips leading YAML frontmatter (F1)", () => {
  const out = normalizeForDiff("---\nicon: 🛍️\nstatus: stable\n---\n\n# Title\n\nBody\n");
  expect(out).not.toContain("icon:");
  expect(out).not.toContain("status:");
  expect(out.trimStart().startsWith("# Title")).toBe(true);
});

test("normalizeForDiff — a non-leading `---` (horizontal rule) is preserved (F1)", () => {
  const out = normalizeForDiff("# Title\n\ntext\n\n---\n\nmore\n");
  expect(out).toContain("\n---\n");
});

// ── F7: backlinks callout strip ──────────────────────────────────────────────

test("normalizeForDiff — strips the 🔗 Linked from backlinks callout (F7)", () => {
  const body = "# P\n\nbody\n\n<callout icon=\"🔗\" color=\"gray_bg\">\n\t**Linked from **[a.md](a.md)<span color=\"gray\">, </span>[B](b.md)\n</callout>\n";
  const out = normalizeForDiff(body);
  expect(out).not.toContain("Linked from");
  expect(out).not.toContain("<callout");
  expect(out).toContain("body");
});

test("normalizeForDiff — strips a bare `**Linked from**` line without a callout wrapper (F7)", () => {
  const out = normalizeForDiff("# P\n\n\t**Linked from **[x](x.md)\n");
  expect(out).not.toContain("Linked from");
});

// ── F6: Notion-export HTML + comments ────────────────────────────────────────

test("normalizeForDiff — removes HTML comments (sherpa/claude markers) (F6)", () => {
  const out = normalizeForDiff("# P\n\n<!-- sherpa: daily-20260428 @ 2026-04-28 -->\ntext\n<!-- claude: re-check this -->\nmore\n");
  expect(out).not.toContain("sherpa");
  expect(out).not.toContain("claude:");
  expect(out).toContain("text");
});

test("normalizeForDiff — unwraps callout/span/aside tags but keeps inner text (F6)", () => {
  const out = normalizeForDiff("<aside>\nimportant note <span color=\"gray\">aside</span>\n</aside>\n");
  expect(out).not.toContain("<aside>");
  expect(out).not.toContain("<span");
  expect(out).toContain("important note");
  expect(out).toContain("aside");
});

// ── F5: widened backslash-unescape set ───────────────────────────────────────

test("normalizeForDiff — unescapes the widened punctuation set (F5)", () => {
  // ~ $ [ ] < > { } | _ * # plus the original > ! - = ( ) . , ; : ?
  const out = normalizeForDiff("a \\~b \\$inc \\[STUB\\] \\<T\\> \\{x\\} a\\|b c\\_d e\\*f \\#h\n");
  expect(out).toContain("~b");
  expect(out).toContain("$inc");
  expect(out).toContain("[STUB]");
  expect(out).toContain("<T>");
  expect(out).toContain("{x}");
  expect(out).toContain("a|b");
  expect(out).toContain("c_d");
  expect(out).toContain("e*f");
  expect(out).toContain("#h");
});

test("normalizeForDiff — leaves a literal backslash escape (\\\\) alone (F5)", () => {
  const out = normalizeForDiff("path C:\\\\temp\n");
  expect(out).toContain("\\\\temp");
});

// ── F4: bold **** doubling ───────────────────────────────────────────────────

test("normalizeForDiff — collapses 4+ asterisks to ** (bold-around-code doubling) (F4)", () => {
  expect(normalizeForDiff("see ****`sendInvite`**\n")).toContain("**`sendInvite`**");
  expect(normalizeForDiff("see **`render_js`****\n")).toContain("**`render_js`**");
});

test("normalizeForDiff — leaves *, **, *** intact (F4)", () => {
  const out = normalizeForDiff("*i* **b** ***bi***\n");
  expect(out).toContain("*i*");
  expect(out).toContain("**b**");
  expect(out).toContain("***bi***");
});

// ── F3: link anchor + target canonicalization ────────────────────────────────

test("normalizeForDiff — strips backticks from link anchor text (F3)", () => {
  const out = normalizeForDiff("see [`../api/scraper.md`](../api/scraper.md)\n");
  expect(out).not.toContain("[`");
});

test("normalizeForDiff — .md link anchor+target canonicalize, drops ./ and #frag (F3)", () => {
  // human anchor + ./ + #fragment all collapse to bare target on both sides
  expect(normalizeForDiff("[Admin Parts](./parts-list.md#9-deletion)\n")).toContain("[parts-list.md](parts-list.md)");
  expect(normalizeForDiff("[parts-list.md](parts-list.md)\n")).toContain("[parts-list.md](parts-list.md)");
});

test("normalizeForDiff — a genuinely different .md path still differs (F3 preserves real moves)", () => {
  const a = normalizeForDiff("[x](../system/auth.md)\n");
  const b = normalizeForDiff("[x](../../tech/system/auth.md)\n");
  expect(a).not.toBe(b); // real path change is NOT collapsed
});

// ── F2: emphasis _ ↔ * ───────────────────────────────────────────────────────

test("normalizeForDiff — canonicalizes flanking _italic_ to *italic* (F2)", () => {
  expect(normalizeForDiff("_Last synced 2026-04-24_\n")).toContain("*Last synced 2026-04-24*");
  expect(normalizeForDiff("a _word_ here\n")).toContain("a *word* here");
});

test("normalizeForDiff — leaves intra-word underscores (snake_case) untouched (F2)", () => {
  const out = normalizeForDiff("call some_function_name and other_var\n");
  expect(out).toContain("some_function_name");
  expect(out).toContain("other_var");
});

test("normalizeForDiff — underscores inside inline code survive (F2)", () => {
  const out = normalizeForDiff("use `max_retries` and `$inc`\n");
  expect(out).toContain("max_retries");
});

// ── Pass 3: cheap add-ons (F10/F11/F12/F14) ──────────────────────────────────

test("normalizeForDiff — strips <> autolink wrapper in link target (F12)", () => {
  expect(normalizeForDiff("[src](<https://github.com/x/y>)\n")).toContain("[src](https://github.com/x/y)");
});

test("normalizeForDiff — collapses bare-domain autolink to host (F10)", () => {
  expect(normalizeForDiff("| `a.py` | [amazon.com](http://amazon.com) |\n")).toContain("| amazon.com |");
  // a real labelled link is NOT collapsed
  expect(normalizeForDiff("[Amazon](http://amazon.com)\n")).toContain("[Amazon](http://amazon.com)");
  // a URL with a path is NOT collapsed
  expect(normalizeForDiff("[x.com](http://x.com/page)\n")).toContain("[x.com](http://x.com/page)");
});

test("normalizeForDiff — normalizes unicode bullets and */+ markers to - (F11/F14)", () => {
  expect(normalizeForDiff("• one\n‣ two\n")).toBe("- one\n- two\n");
  expect(normalizeForDiff("* a\n+ b\n- c\n")).toBe("- a\n- b\n- c\n");
});

test("normalizeForDiff — a *emphasis* line start is not mistaken for a bullet (F14)", () => {
  expect(normalizeForDiff("*emphasis* text\n")).toContain("*emphasis*");
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
