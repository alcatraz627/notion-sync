/**
 * ANSI terminal color helpers — the single source of truth for the escape
 * codes that were previously copy-pasted across notion-list, reconcile, and
 * the leaf dashboard modules.
 *
 * Two consumption styles, both backed by the same `CODES` map:
 *   - standalone always-paint helpers (`dim`, `green`, …) for modules that
 *     don't gate on TTY
 *   - `makeClr(tty)` factory for the TTY-gated semantic palette (suppresses
 *     color when stdout isn't a terminal)
 */

export const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  brightBlack: "\x1b[90m",     // index.ts's "gray"
  grey245: "\x1b[38;5;245m",   // notion-list's "grey"
  underlineBlue: "\x1b[4;34m", // reconcile's "url"
} as const;

/** Wrap `s` in `code` + reset. When `tty` is false, returns `s` unchanged so
 *  redirected / piped output stays plain. Internal — consumers use the
 *  standalone helpers or `makeClr` below. */
function wrap(code: string, s: string, tty = true): string {
  return tty ? `${code}${s}${CODES.reset}` : s;
}

// ── Standalone always-paint helpers ──────────────────────────────────────────
// Match the shapes notion-list.ts + reconcile.ts used (no TTY gating).

export const dim    = (s: string) => wrap(CODES.dim, s);
export const bold   = (s: string) => wrap(CODES.bold, s);
export const red    = (s: string) => wrap(CODES.red, s);
export const green  = (s: string) => wrap(CODES.green, s);
export const yellow = (s: string) => wrap(CODES.yellow, s);
export const blue   = (s: string) => wrap(CODES.blue, s);
export const cyan   = (s: string) => wrap(CODES.cyan, s);
export const grey   = (s: string) => wrap(CODES.grey245, s);
export const url    = (s: string) => wrap(CODES.underlineBlue, s);

// ── TTY-gated semantic palette ────────────────────────────────────────────────
// The shape index.ts uses. Pass the process's TTY flag once; every method
// honors it. (index.ts migration is deferred to the progress-helper step,
// where its `paint`/`A` map are entangled with the progress bar.)

export function makeClr(tty: boolean) {
  const p = (code: string) => (s: string) => wrap(code, s, tty);
  return {
    header:  p(CODES.bold + CODES.cyan),
    phase:   p(CODES.bold + CODES.blue),
    section: p(CODES.bold + CODES.magenta),
    ok:      p(CODES.green),
    warn:    p(CODES.yellow),
    err:     p(CODES.red),
    url:     p(CODES.cyan),
    dim:     p(CODES.dim),
    bold:    p(CODES.bold),
    gray:    p(CODES.brightBlack),
  };
}
