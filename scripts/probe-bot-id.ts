#!/usr/bin/env bun
/**
 * Read-only probe — validates the assumptions behind OVERWRITE-GUARDRAILS-EXPLORATION.md
 * before any guardrail code is written.
 *
 * Run:  bun scripts/probe-bot-id.ts
 *
 * Expected outcomes (all must pass):
 *   1. notion.users.me() returns a user with type === "bot" and a stable id.
 *   2. A page recently pushed by this integration reports last_edited_by.id === botId.
 *   3. last_edited_time is a valid ISO string and stable across two consecutive retrieves.
 *   4. The page meta carries the parent.page_id we expect from the cache.
 *
 * If any assumption fails, the spec needs revising before we build on it.
 */

import { Client } from "@notionhq/client";
import { readFileSync } from "fs";
import { join } from "path";

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    console.error(`✗ Missing env var: ${k}. Run via 'bash sync.sh' to load .env, or 'set -a; source .env; set +a; bun scripts/probe-bot-id.ts'`);
    process.exit(2);
  }
  return v;
};

const NOTION_TOKEN = env("NOTION_TOKEN");
const notion = new Client({ auth: NOTION_TOKEN });

const CACHE_PATH = join(process.cwd(), ".notion-cache.json");
const cache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));

// Pick a recently-synced leaf page from the cache as our probe target.
// Leaves only — child_page_count === 0 means we won't accidentally confuse parent metadata.
const probeTarget = cache.pages.find(
  (p: any) => p.has_content && p.child_page_count === 0 && p.depth >= 2
);
if (!probeTarget) {
  console.error("✗ No suitable leaf page found in .notion-cache.json. Run 'bash list.sh fetch' first.");
  process.exit(2);
}

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:   (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow:(s: string) => `\x1b[33m${s}\x1b[0m`,
  dim:   (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold:  (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
const record = (name: string, pass: boolean, detail: string) => {
  checks.push({ name, pass, detail });
  const tag = pass ? c.green("✓") : c.red("✗");
  console.log(`  ${tag} ${name}\n    ${c.dim(detail)}`);
};

console.log(c.bold("\nProbe 1 — notion.users.me() returns a stable bot identity"));
console.log(c.dim("─".repeat(70)));

const me: any = await notion.users.me({});
record(
  "users.me() returns a user object",
  !!me?.id,
  `id=${me?.id}  object=${me?.object}`,
);
record(
  "user.type === 'bot'",
  me?.type === "bot",
  `type=${me?.type}  name=${me?.name}`,
);
record(
  "bot has owner metadata",
  !!me?.bot?.owner,
  `owner.type=${me?.bot?.owner?.type}  workspace=${me?.bot?.workspace_name ?? "(n/a)"}`,
);

const botId: string = me.id;

console.log(c.bold("\nProbe 2 — recently-synced page reports our bot as last editor"));
console.log(c.dim("─".repeat(70)));
console.log(c.dim(`  Probe target: "${probeTarget.title}"`));
console.log(c.dim(`  Page id:      ${probeTarget.id}`));

const meta1: any = await notion.pages.retrieve({ page_id: probeTarget.id });

record(
  "page.last_edited_by exists and has the expected shape",
  !!meta1.last_edited_by?.id && !!meta1.last_edited_by?.object,
  `last_edited_by={object: ${meta1.last_edited_by?.object}, id: ${meta1.last_edited_by?.id}}`,
);
record(
  "page.last_edited_by.id === ourBotId  (we were last editor)",
  meta1.last_edited_by?.id === botId,
  meta1.last_edited_by?.id === botId
    ? `match: both = ${botId}`
    : `MISMATCH — bot=${botId} vs page=${meta1.last_edited_by?.id}. ` +
      `Means a human or another integration edited after our last push. ` +
      `Spec is still valid; this just isn't a clean probe page.`,
);
record(
  "page.last_edited_time is a parseable ISO string",
  !!meta1.last_edited_time && !isNaN(Date.parse(meta1.last_edited_time)),
  `last_edited_time=${meta1.last_edited_time}`,
);
record(
  "page.parent.page_id is present (move-detection target field)",
  !!meta1.parent?.page_id,
  `parent.type=${meta1.parent?.type}  parent.page_id=${meta1.parent?.page_id}`,
);
record(
  "page.archived field is present (archive-detection target field)",
  meta1.archived !== undefined,
  `archived=${meta1.archived}`,
);

console.log(c.bold("\nProbe 3 — last_edited_time is stable across consecutive retrieves"));
console.log(c.dim("─".repeat(70)));
await new Promise((r) => setTimeout(r, 1500));
const meta2: any = await notion.pages.retrieve({ page_id: probeTarget.id });
record(
  "two consecutive retrieves return identical last_edited_time",
  meta1.last_edited_time === meta2.last_edited_time,
  `t1=${meta1.last_edited_time}  t2=${meta2.last_edited_time}`,
);
record(
  "two consecutive retrieves return identical last_edited_by.id",
  meta1.last_edited_by?.id === meta2.last_edited_by?.id,
  `id1=${meta1.last_edited_by?.id}  id2=${meta2.last_edited_by?.id}`,
);

console.log(c.bold("\nProbe 4 — minute-rounding observation"));
console.log(c.dim("─".repeat(70)));
const rounded = meta1.last_edited_time?.endsWith(":00.000Z");
record(
  "last_edited_time is rounded to the minute (per Notion July 2024 change)",
  rounded === true,
  rounded
    ? `seconds component is :00.000Z — rounding confirmed, baseline-string-equality strategy is necessary`
    : `seconds component is non-zero — Notion may not be rounding for this object/workspace yet. Re-check assumption.`,
);

console.log(c.bold("\n────────────────────────────────────────────────────────────────────────"));
const passed = checks.filter((x) => x.pass).length;
const failed = checks.length - passed;
const verdict = failed === 0 ? c.green("ALL CHECKS PASSED") : c.red(`${failed} CHECK(S) FAILED`);
console.log(`  ${verdict}  (${passed}/${checks.length})`);
console.log(c.dim("────────────────────────────────────────────────────────────────────────\n"));

if (failed > 0) {
  console.log(c.yellow("Action: review the failed checks above before implementing the guardrails spec."));
  console.log(c.yellow("Some failures (notably probe 2.b) may simply mean the chosen probe page was edited"));
  console.log(c.yellow("by a human after the last sync — that's actually evidence the design works, not a bug."));
  process.exit(1);
}

console.log(c.dim("Bot id, page metadata shape, time stability, and rounding all confirmed."));
console.log(c.dim("Safe to proceed with .notion-sync-state.json + check loop implementation."));
