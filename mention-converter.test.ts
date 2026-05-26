import { test, expect } from "bun:test";
import { convertRichTextArray } from "./mention-converter";

const OURS = "abc123def456abc123def456abc12345";
const ourPageIds = new Set([OURS]);

const text = (content: string, url?: string | null) => ({
  type: "text",
  text: { content, link: url === undefined ? null : { url } },
  annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
});

// ── conversion: internal Notion link → mention ───────────────────────────────

test("converts our page link to a mention pill", () => {
  const r = convertRichTextArray([text("Overview", `https://www.notion.so/${OURS}`)], ourPageIds);
  expect(r.changed).toBe(true);
  expect(r.count).toBe(1);
  expect(r.rich_text[0]).toMatchObject({ type: "mention", mention: { type: "page", page: { id: OURS } } });
});

test("leaves an external (non-ours) http link untouched", () => {
  const r = convertRichTextArray([text("Docs", "https://example.com/x")], ourPageIds);
  expect(r.changed).toBe(false);
  expect(r.rich_text[0].text.link.url).toBe("https://example.com/x");
});

// ── the "Invalid URL for link" regression ────────────────────────────────────

test("strips a dead #anchor link that rides in a converted block", () => {
  // A block with both a real mention link AND an in-page TOC anchor. The anchor
  // would fail blocks.update; it must be stripped (text kept) so the resend is valid.
  const r = convertRichTextArray(
    [text("See ", undefined), text("Overview", `https://www.notion.so/${OURS}`), text(" §3.4", "#34-jobs-architecture-wizard")],
    ourPageIds,
  );
  expect(r.changed).toBe(true);
  const anchorItem = r.rich_text[2];
  expect(anchorItem.type).toBe("text");
  expect(anchorItem.text.content).toBe(" §3.4"); // text preserved
  expect(anchorItem.text.link).toBeNull(); // dead link dropped
});

test("does NOT flag a block as changed for anchors alone (no extra API call)", () => {
  // A pure-TOC block with only #anchor links and no real mention must report
  // changed=false so the caller never sends it (Option A — zero added API calls).
  const r = convertRichTextArray([text("§1", "#11-auth"), text("§2", "#21-teams")], ourPageIds);
  expect(r.changed).toBe(false);
  expect(r.count).toBe(0);
});

test("keeps sendable schemes (mailto/tel) in a converted block", () => {
  const r = convertRichTextArray(
    [text("Page", `https://www.notion.so/${OURS}`), text("mail", "mailto:a@b.com"), text("call", "tel:+15551234")],
    ourPageIds,
  );
  expect(r.changed).toBe(true);
  expect(r.rich_text[1].text.link.url).toBe("mailto:a@b.com");
  expect(r.rich_text[2].text.link.url).toBe("tel:+15551234");
});
