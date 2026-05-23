/**
 * Minimal .env loader for the TS entry points that can be run directly
 * (`bun diff-content.ts`, `bun notion-list.ts`) without sync.sh's shell
 * sourcing. Consolidates two parsers that had drifted: one trimmed but kept
 * quotes, the other stripped quotes but didn't trim — producing DIFFERENT
 * values (and cache keys) for the same quoted root id.
 *
 * Unified rule, applied to every value: trim whitespace, THEN strip a single
 * pair of surrounding quotes. Never overwrites a var already in the
 * environment — so shell-exported / `--env`-sourced values always win, and a
 * deliberately-empty env var stays empty. No-op when the file is absent
 * (the vars may already be present via the shell).
 */

import * as fs from "fs";

export function loadEnv(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    if (m[1] in process.env) continue; // shell-set value wins
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
