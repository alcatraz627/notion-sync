/**
 * Notion client + page-id helpers — shared across the toolset so the client
 * construction and the "what page id does this string mean?" logic live in
 * one place instead of being re-derived per entry file.
 */

import { Client } from "@notionhq/client";

/** Construct a Notion client from `NOTION_TOKEN`. Lenient by design: an unset
 *  token yields a client that fails on first API call with the SDK's own auth
 *  error. Token VALIDATION (with a friendly message) is the caller's job —
 *  index.ts does it in preflight, reconcile.ts checks + exits — and the
 *  factory must not preempt those by throwing at module-load time.
 *  `timeoutMs` defaults to the SDK default (60s); pass larger for long walks. */
export function getNotion(opts: { timeoutMs?: number } = {}): Client {
  const auth = process.env.NOTION_TOKEN ?? "";
  return opts.timeoutMs ? new Client({ auth, timeoutMs: opts.timeoutMs }) : new Client({ auth });
}

/**
 * Extract the canonical undashed 32-hex page id from any form the user might
 * put in `NOTION_ROOT_PAGE_ID` or a sync-map: a bare id, a dashed UUID, a
 * "Slug-<id>" value, or a copy-link URL (with or without a `?…` query).
 *
 * Strategy: drop the URL query/fragment (so a decoy id in `?param=<other>`
 * can't win), prefer a dashed UUID if present (an unambiguous paste), else
 * take the LAST bare 32-hex run in the path (the id trails the slug, and the
 * dash separator keeps a slug word from fusing into the id run). Returns null
 * if no id is found.
 */
export function extractPageId(raw: string): string | null {
  if (!raw) return null;
  const noQuery = raw.split(/[?#]/)[0];
  const dashed = noQuery.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const bare = noQuery.match(/[0-9a-f]{32}/gi);
  const pick = dashed?.[0] ?? bare?.[bare.length - 1];
  return pick ? pick.replace(/-/g, "").toLowerCase() : null;
}
