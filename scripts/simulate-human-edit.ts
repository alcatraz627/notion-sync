#!/usr/bin/env bun
/**
 * Tampers with .notion-sync-state.json to simulate a human edit on a given
 * page WITHOUT actually editing Notion. Used to smoke-test the strict-mode
 * guardrail without disrupting real docs.
 *
 * Run:  bun scripts/simulate-human-edit.ts <relPath>
 *
 * Effect: rewrites the page's `last_pushed_edited_time` to a stale value
 * and deletes the cached `bot_id` (forces a re-fetch). On the next sync,
 * checkDivergence will see:
 *   - notion's last_edited_time !== stored baseline   → editedSinceBaseline
 *   - last_edited_by.id === bot_id                    → likely bot
 *   - Result: "benign-drift" soft warning
 *
 * To force a "user-edited" hard block, this script ALSO sets a fake
 * `last_pushed_edited_time` AND tampers with the recorded `expected_parent_id`
 * to force a "moved" divergence (which is unambiguous and doesn't depend
 * on edit-attribution).
 */

import * as fs from "fs";
import * as path from "path";

const relPath = process.argv[2];
if (!relPath) {
  console.error("Usage: bun scripts/simulate-human-edit.ts <relPath>");
  console.error("       (where relPath is a key under .notion-sync-state.json's pages map)");
  process.exit(2);
}

const STATE_PATH = path.join(__dirname, "..", ".notion-sync-state.json");
if (!fs.existsSync(STATE_PATH)) {
  console.error(`✗ ${STATE_PATH} does not exist. Run a successful sync first to populate it.`);
  process.exit(2);
}

const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
const page = state.pages?.[relPath];
if (!page) {
  console.error(`✗ "${relPath}" is not in state.pages. Available keys:`);
  for (const k of Object.keys(state.pages || {})) console.error(`    ${k}`);
  process.exit(2);
}

console.log(`Tampering with state for: ${relPath}`);
console.log(`  Before:`);
console.log(`    last_pushed_edited_time = ${page.last_pushed_edited_time}`);
console.log(`    expected_parent_id      = ${page.expected_parent_id}`);

// Force "moved" divergence — guaranteed to fire regardless of edit attribution.
page.expected_parent_id = "00000000-0000-0000-0000-000000000000";
// Force "edited" divergence too — Notion's actual last_edited_time will not match this.
page.last_pushed_edited_time = "2020-01-01T00:00:00.000Z";

fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
console.log(`  After:`);
console.log(`    last_pushed_edited_time = ${page.last_pushed_edited_time}`);
console.log(`    expected_parent_id      = ${page.expected_parent_id}`);
console.log("");
console.log("Now re-run:  DRY_RUN=0 bun index.ts --only " + path.basename(relPath, ".md"));
console.log("Expected:    Phase 1.7 fires, page is flagged as 'moved' (parent mismatch),");
console.log("             Phase 2 skips it as 'protected', runs.jsonl carries protected_pages[]");
