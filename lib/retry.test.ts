import { test, expect } from "bun:test";
import { isRetriable, withRetry } from "./retry";

// ── isRetriable: the UNION of all six callers' conditions ────────────────────

test("isRetriable — rate limit + request timeout statuses", () => {
  expect(isRetriable({ status: 429 })).toBe(true);
  expect(isRetriable({ status: 408 })).toBe(true);
});

test("isRetriable — any 5xx", () => {
  for (const s of [500, 502, 503, 504, 599]) {
    expect(isRetriable({ status: s })).toBe(true);
  }
});

test("isRetriable — Notion SDK + socket codes", () => {
  expect(isRetriable({ code: "notionhq_client_request_timeout" })).toBe(true);
  expect(isRetriable({ code: "notionhq_client_response_error" })).toBe(true);
  expect(isRetriable({ code: "ECONNRESET" })).toBe(true);
  expect(isRetriable({ code: "ETIMEDOUT" })).toBe(true);
});

test("isRetriable — status parsed from message text (tag-index's case)", () => {
  expect(isRetriable({ message: "Notion API error status: 503 gateway" })).toBe(true);
  expect(isRetriable({ message: "status: 429 too many" })).toBe(true);
});

test("isRetriable — NOT retriable: 4xx client errors, unknown", () => {
  expect(isRetriable({ status: 400 })).toBe(false);
  expect(isRetriable({ status: 404 })).toBe(false);
  expect(isRetriable({ code: "validation_error" })).toBe(false);
  expect(isRetriable({})).toBe(false);
  expect(isRetriable(new Error("plain"))).toBe(false);
});

// ── withRetry: control flow ──────────────────────────────────────────────────

test("withRetry — succeeds first try, fn called once", async () => {
  let calls = 0;
  const r = await withRetry(async () => { calls++; return "ok"; }, { label: "t" });
  expect(r).toBe("ok");
  expect(calls).toBe(1);
});

test("withRetry — non-retriable error throws immediately (no retry, no wait)", async () => {
  let calls = 0;
  const start = Date.now();
  await expect(
    withRetry(async () => { calls++; throw { status: 400 }; }, { label: "t" }),
  ).rejects.toEqual({ status: 400 });
  expect(calls).toBe(1);
  expect(Date.now() - start).toBeLessThan(500); // no backoff wait
});

test("withRetry — retriable then success: retries once (linear ~4s wait)", async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls++;
    if (calls === 1) throw { status: 503 };
    return "recovered";
  }, { label: "t" });
  expect(r).toBe("recovered");
  expect(calls).toBe(2);
}, 10_000); // allow for the 4s linear backoff
