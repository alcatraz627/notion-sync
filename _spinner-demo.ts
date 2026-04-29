// Pulsing terminal spinner reference — drop-in animation patterns for CLI tools.
//
// Provides two production-ready styles:
//   1. braille-pulse  — spinning braille frames (npm/yarn) with a slow grey pulse layered over
//   2. pulse-dot      — single ● fading in and out (Claude Code style)
//
// Both use:
//   • Time-based animation (decoupled from frame rate) so timing is consistent across systems
//   • Powered sine curve for an "alive" feel — sharp peak, long rest at dim
//   • ANSI 256-colour grey ramp (codes 232–255) for smooth fades
//   • \r + hide-cursor for jitter-free in-place rendering
//
// Run: bun spinner-demo.ts        (browse all styles)
//      bun spinner-demo.ts --braille
//      bun spinner-demo.ts --pulse
//
// Wire into a tool: import { startSpinner } from this file and call
//      const stop = startSpinner({ style: "braille", label: "syncing..." });
//      // ... do work ...
//      stop();

const RESET = "\x1b[0m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const grey = (n: number, s: string) => `\x1b[38;5;${n}m${s}${RESET}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Timing curve ──────────────────────────────────────────────────────────────
// Claude Code-style pulse: sharp peak, long rest at dim end.
// Returns 0..1 brightness given elapsed ms within a `periodMs` cycle.
//
// Math: sin(πt) gives 0..1..0 over the cycle (smooth bell). Power > 1 sharpens
// the peak and broadens the trough — at ^1.4 the dot spends ~60% of the cycle
// in the dim half, ~40% near peak. Baseline 0.18 keeps it from going pitch-black.
function pulse01(elapsedMs: number, periodMs: number): number {
  const t = (elapsedMs % periodMs) / periodMs; // 0..1
  const sine = Math.sin(t * Math.PI);          // 0..1..0 across the cycle
  return 0.18 + 0.82 * Math.pow(sine, 1.4);
}

// Map 0..1 brightness onto ANSI 256-colour grey ramp (232 black → 255 white).
function brightnessToGrey(b: number): number {
  return 232 + Math.round(Math.max(0, Math.min(1, b)) * 23);
}

// ── Frame banks ───────────────────────────────────────────────────────────────
const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPIN_PERIOD_MS = 1200;  // one full braille rotation — relaxed pace
const PULSE_PERIOD_MS = 1400; // one full grey pulse — matches Claude Code's cadence

// ── Public API: startSpinner ──────────────────────────────────────────────────

export type SpinnerStyle = "braille" | "pulse";

export function startSpinner(opts: { style: SpinnerStyle; label?: string; tickMs?: number } = { style: "braille" }): () => void {
  const style = opts.style;
  const label = opts.label ?? "";
  const tick = opts.tickMs ?? 50; // 20 fps render rate
  const start = Date.now();

  process.stdout.write(HIDE_CURSOR);
  const timer = setInterval(() => {
    const elapsed = Date.now() - start;
    const brightness = pulse01(elapsed, PULSE_PERIOD_MS);
    const fg = brightnessToGrey(brightness);

    let glyph: string;
    if (style === "braille") {
      const frameIdx = Math.floor((elapsed / SPIN_PERIOD_MS) * BRAILLE.length) % BRAILLE.length;
      glyph = grey(fg, BRAILLE[frameIdx]);
    } else {
      glyph = grey(fg, "●");
    }
    process.stdout.write(`\r  ${glyph}  ${label}${" ".repeat(8)}`);
  }, tick);

  return () => {
    clearInterval(timer);
    process.stdout.write(`\r${" ".repeat(80)}\r`);
    process.stdout.write(SHOW_CURSOR);
  };
}

// ── Demo runner ───────────────────────────────────────────────────────────────

async function runDemo(style: SpinnerStyle, durationMs: number, label: string): Promise<void> {
  console.log(`\n  ${style}  (${PULSE_PERIOD_MS}ms pulse cycle)`);
  const stop = startSpinner({ style, label });
  await sleep(durationMs);
  stop();
}

if (import.meta.main || require.main === module) {
  const args = process.argv.slice(2);
  const onlyBraille = args.includes("--braille");
  const onlyPulse = args.includes("--pulse");

  (async () => {
    console.log("Spinner reference — Ctrl-C to stop\n");
    if (!onlyPulse) await runDemo("braille", 5000, "Phase 2: writing content...   17/34  50%  • improvements/CLAUDE.md");
    if (!onlyBraille) await runDemo("pulse", 5000, "thinking...");
    console.log("\nDone.");
  })();
}
