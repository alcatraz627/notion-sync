// progress-ledger.ts — crash-resumable progress for long sync runs.
//
// A full push of hundreds of docs takes >2h, almost entirely in Phase 2 content
// writes. If it's interrupted (Ctrl-C, crash, laptop sleep), re-running from
// scratch re-pushes everything. This ledger records which leaf docs have been
// written so a resumed run can skip them — Phase 1 discovery still re-runs fully
// (it's idempotent and the page-id map must be complete for link resolution),
// but Phase 2 only writes what's left.
//
// The file is keyed by the Notion root (same scheme as the cache / state files),
// so switching NOTION_ROOT_PAGE_ID isolates progress automatically. It lives only
// for the duration of an interrupted run: a clean finish deletes it.

import fs from "node:fs";
import path from "node:path";
import { getCacheKey } from "./sync-state";

export interface ProgressLedger {
  run_id: string;
  started_at: string;
  doc_set: string[]; // every leaf doc this run intended to write
  completed: string[]; // relPaths already written successfully (the skip-set)
}

export function ledgerPath(dir: string = __dirname): string {
  return path.join(dir, `.notion-sync-progress.${getCacheKey()}.json`);
}

/** Read the ledger for the current root, or null if none / unreadable. */
export function loadLedger(dir?: string): ProgressLedger | null {
  const p = ledgerPath(dir);
  if (!fs.existsSync(p)) return null;
  try {
    const l = JSON.parse(fs.readFileSync(p, "utf8")) as ProgressLedger;
    if (!Array.isArray(l.completed) || !Array.isArray(l.doc_set)) return null;
    return l;
  } catch {
    return null; // corrupt ledger — treat as absent, start fresh
  }
}

/** Begin a fresh ledger and write it to disk. */
export function startLedger(run_id: string, doc_set: string[], dir?: string): ProgressLedger {
  const ledger: ProgressLedger = { run_id, started_at: new Date().toISOString(), doc_set, completed: [] };
  flush(ledger, dir);
  return ledger;
}

/** Record a doc as done and persist immediately (durable per-doc). */
export function markDone(ledger: ProgressLedger, relPath: string, dir?: string): void {
  if (ledger.completed.includes(relPath)) return;
  ledger.completed.push(relPath);
  flush(ledger, dir);
}

/** Remove the ledger — call on a clean finish so the next run starts fresh. */
export function clearLedger(dir?: string): void {
  const p = ledgerPath(dir);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* best-effort */ }
}

function flush(ledger: ProgressLedger, dir?: string): void {
  // Atomic-ish: write to a temp sibling then rename, so a crash mid-write can't
  // leave a truncated ledger that loadLedger would reject and discard.
  const p = ledgerPath(dir);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, p);
}
