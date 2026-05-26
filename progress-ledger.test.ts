import { test, expect, beforeEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Pin the root so getCacheKey() (used inside ledgerPath) is deterministic.
process.env.NOTION_ROOT_PAGE_ID = "36bbacd27dee8002b0d0e95b8cdd1a57";
const { loadLedger, startLedger, markDone, clearLedger, ledgerPath } = await import("./progress-ledger");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));

beforeEach(() => {
  // Clean slate per test — remove any ledger left by a prior one.
  clearLedger(dir);
});
afterAll(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

test("ledgerPath is keyed by the Notion root", () => {
  expect(path.basename(ledgerPath(dir))).toBe(".notion-sync-progress.36bbacd27dee.json");
});

test("loadLedger returns null when absent", () => {
  expect(loadLedger(dir)).toBeNull();
});

test("startLedger writes a fresh ledger that loadLedger reads back", () => {
  const l = startLedger("20260526-120000", ["a.md", "b.md", "c.md"], dir);
  expect(l.completed).toEqual([]);
  expect(l.doc_set).toEqual(["a.md", "b.md", "c.md"]);
  const reloaded = loadLedger(dir)!;
  expect(reloaded.run_id).toBe("20260526-120000");
  expect(reloaded.doc_set).toEqual(["a.md", "b.md", "c.md"]);
});

test("markDone appends durably and dedups", () => {
  const l = startLedger("r", ["a.md", "b.md"], dir);
  markDone(l, "a.md", dir);
  markDone(l, "a.md", dir); // dup — no-op
  markDone(l, "b.md", dir);
  expect(l.completed).toEqual(["a.md", "b.md"]);
  // persisted, not just in-memory
  expect(loadLedger(dir)!.completed).toEqual(["a.md", "b.md"]);
});

test("clearLedger removes the file", () => {
  startLedger("r", ["a.md"], dir);
  expect(loadLedger(dir)).not.toBeNull();
  clearLedger(dir);
  expect(loadLedger(dir)).toBeNull();
  expect(fs.existsSync(ledgerPath(dir))).toBe(false);
});

test("corrupt ledger is treated as absent (start fresh)", () => {
  fs.writeFileSync(ledgerPath(dir), "{ not valid json");
  expect(loadLedger(dir)).toBeNull();
});

test("ledger missing required arrays is rejected", () => {
  fs.writeFileSync(ledgerPath(dir), JSON.stringify({ run_id: "r", started_at: "t" }));
  expect(loadLedger(dir)).toBeNull();
});
