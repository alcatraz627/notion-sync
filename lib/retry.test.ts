import { test, expect } from "bun:test";
import { isRetriable, withRetry, computeWaitMs } from "./retry";

// ── computeWaitMs: backoff curves (pure, no real sleeps) ─────────────────────

test("computeWaitMs — linear is 4s·attempt", () => {
  expect(computeWaitMs(1, "linear", false, {})).toBe(4000);
  expect(computeWaitMs(2, "linear", false, {})).toBe(8000);
  expect(computeWaitMs(3, "linear", false, {})).toBe(12000);
});

test("computeWaitMs — exponential is min(32s, 2s·2^(n-1))", () => {
  expect(computeWaitMs(1, "exponential", false, {})).toBe(2000);
  expect(computeWaitMs(2, "exponential", false, {})).toBe(4000);
  expect(computeWaitMs(3, "exponential", false, {})).toBe(8000);
  expect(computeWaitMs(4, "exponential", false, {})).toBe(16000);
  expect(computeWaitMs(5, "exponential", false, {})).toBe(32000);
  expect(computeWaitMs(6, "exponential", false, {})).toBe(32000); // capped
});

test("computeWaitMs — HTTP-date Retry-After does NOT produce NaN (regression)", () => {
  // RFC 7231 allows Retry-After as an HTTP-date; parseInt → NaN must not
  // leak into the wait (NaN → setTimeout fires instantly, defeating backoff).
  const err = { status: 429, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } };
  const w = computeWaitMs(1, "exponential", true, err);
  expect(Number.isFinite(w)).toBe(true);
  expect(w).toBe(2000); // falls back to the exponential base
});

test("computeWaitMs — Retry-After raises the floor only when honored", () => {
  const err = { status: 429, headers: { "retry-after": "10" } }; // 10s
  // exponential attempt 1 base = 2s; Retry-After 10s wins
  expect(computeWaitMs(1, "exponential", true, err)).toBe(10000);
  // not honored → base only
  expect(computeWaitMs(1, "exponential", false, err)).toBe(2000);
  // honored but base already exceeds Retry-After → base wins
  expect(computeWaitMs(5, "exponential", true, { headers: { "retry-after": "3" } })).toBe(32000);
});

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

test("withRetry — exhausts maxAttempts then throws last error", async () => {
  let calls = 0;
  await expect(
    withRetry(async () => { calls++; throw { status: 503 }; }, { label: "t", maxAttempts: 2 }),
  ).rejects.toEqual({ status: 503 });
  expect(calls).toBe(2); // 2 total tries (1 retry → 1 linear 4s wait)
}, 10_000);

test("isRetriable — err.status takes precedence over message-parsed status", () => {
  // status says retriable (503), message would parse non-retriable — status wins
  expect(isRetriable({ status: 503, message: "status: 400 bad" })).toBe(true);
  // no status field → falls back to message parse
  expect(isRetriable({ message: "status: 503" })).toBe(true);
});
