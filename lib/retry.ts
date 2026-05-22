/**
 * Transient-failure retry — the single implementation behind the six
 * near-identical `withRetry` / `withChunkRetry` copies that had drifted
 * apart (different attempt counts, backoff curves, and retriable sets).
 *
 * Two knobs preserve each caller's tuned behavior:
 *   - `backoff: "exponential"` (notion-list's tree-walk, 2s→32s + Retry-After)
 *     vs `"linear"` (the dashboards' deliberate 4s·n — chosen for the "504
 *     wall on a large tag-index wipe", see sitemap.ts header).
 *   - `maxAttempts` (notion-list 5, dashboards 4).
 *
 * The retriable predicate is the UNION of all six callers' conditions, so
 * consolidating can't drop coverage anyone relied on. Erring toward more
 * retries on transient-looking errors is the safe direction.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True for errors worth retrying: rate-limit (429), request-timeout (408),
 *  any 5xx, Notion SDK timeout/response errors, and common socket failures.
 *  Status is read from `err.status` OR parsed from the SDK's `status: NNN`
 *  message text (tag-index hit cases where only the message carried it). */
export function isRetriable(err: any): boolean {
  const code = err?.code;
  const msgStatus = typeof err?.message === "string"
    ? err.message.match(/status:\s*(\d+)/)?.[1]
    : undefined;
  const s: number | undefined = err?.status ?? (msgStatus ? parseInt(msgStatus, 10) : undefined);
  return (
    s === 408 || s === 429 || (typeof s === "number" && s >= 500 && s < 600) ||
    code === "notionhq_client_request_timeout" ||
    code === "notionhq_client_response_error" ||
    code === "ECONNRESET" || code === "ETIMEDOUT"
  );
}

export interface RetryOpts {
  /** Short tag for the retry log line, e.g. the page title or operation. */
  label: string;
  /** Total tries including the first. Default 4. */
  maxAttempts?: number;
  /** "linear" → 4s·attempt; "exponential" → min(32s, 2s·2^(attempt-1)). Default linear. */
  backoff?: "linear" | "exponential";
  /** When set, a 429's `Retry-After` header (seconds) raises the wait floor. */
  honorRetryAfter?: boolean;
  /** Where the "retrying…" line goes. Default no-op (silent). */
  log?: (msg: string) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  const { label, maxAttempts = 4, backoff = "linear", honorRetryAfter = false, log = () => {} } = opts;
  let lastErr: any;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (!isRetriable(err) || attempt === maxAttempts) throw err;
      const base = backoff === "exponential"
        ? Math.min(32000, 2000 * Math.pow(2, attempt - 1))
        : 4000 * attempt;
      let waitMs = base;
      if (honorRetryAfter) {
        const hdr = err?.headers?.["retry-after"];
        const retryAfterMs = hdr ? parseInt(hdr, 10) * 1000 : 0;
        waitMs = Math.max(retryAfterMs, base);
      }
      log(`  [${label}] transient ${err?.status ?? err?.code} — retry ${attempt}/${maxAttempts - 1} in ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}
