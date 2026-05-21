/**
 * Title matching for local docs ↔ Notion pages.
 *
 * Local file H1s and Notion page titles drift over time in predictable ways:
 *   - H1 gains a qualifier prefix:  "Forms" → "UI Widgets — Forms"
 *   - H1 gains a qualifier suffix:  "App" → "App — product surface catalog"
 *   - Parenthetical added:           "Auth" → "Auth (Frontend)"
 *   - Hyphen-vs-space casing:        "Layout-and-nav" ↔ "Layout And Nav"
 *
 * `titleVariants` returns the set of normalized forms of a title, so the
 * matcher can find pairs even when both sides drifted in different ways.
 * The strategy is symmetric — apply the same transforms to LOCAL and REMOTE
 * before comparing. A match exists when ANY local variant equals ANY remote
 * variant.
 *
 * Spec: "Step 1-4" of the resolver upgrade discussion, 2026-05-18.
 */

/** Lowercase + treat any non-alphanumeric run as a single space + trim. The
 *  baseline normalization — handles hyphen-vs-space drift and casing. */
function lenient(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** All variants of a title that should be considered "the same name."
 *
 * Variants generated, in order:
 *   1. The title verbatim
 *   2. Lenient-normalized form of #1
 *   3. Tail-after-last-dash:     "X — Y" → "Y"  (strips qualifier prefix)
 *   4. Lenient form of #3
 *   5. Trailing-paren stripped:  "X (Y)" → "X"  (strips qualifier suffix)
 *   6. Lenient form of #5
 *   7. Tail-after-dash + paren-stripped (combined)
 *   8. Lenient form of #7
 *
 * The dash split matches BOTH em-dash (` — `) and ASCII hyphen surrounded
 * by spaces (` - `). It splits on the LAST occurrence so a multi-segment
 * title like "BTS / Frontend — Services" keeps the most-meaningful tail. */
export function titleVariants(title: string): string[] {
  const out = new Set<string>();
  const push = (s: string) => { if (s) out.add(s); };
  const original = title.trim();
  push(original);
  push(lenient(original));

  // Dash split. Match either em-dash or ascii hyphen surrounded by
  // whitespace on both sides. Greedy on the prefix so we always grab the
  // rightmost segment. Add BOTH head and tail as candidates because the
  // qualifier could be on either side:
  //   "UI Widgets — Forms"          → tail "Forms" is the name
  //   "App — product surface catalog" → head "App" is the name
  // We can't tell which without context; try both.
  const dashMatch = original.match(/^(.*)\s+[—–-]\s+(.+)$/);
  const tail = dashMatch ? dashMatch[2].trim() : null;
  const head = dashMatch ? dashMatch[1].trim() : null;
  if (tail) {
    push(tail);
    push(lenient(tail));
  }
  if (head) {
    push(head);
    push(lenient(head));
  }

  // Trailing parenthetical. `"Auth (Frontend)"` → `"Auth"`. Drops the LAST
  // parenthetical; doesn't try to handle nested parens.
  const parenStripped = original.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (parenStripped !== original && parenStripped) {
    push(parenStripped);
    push(lenient(parenStripped));
  }

  // Combined: dash-split AND trailing paren stripped on each side. Catches
  // `"Improvements — Admin Dashboard (HIGH PRIORITY)"` → `"Admin Dashboard"`
  // and `"App — surface catalog (deprecated)"` → `"App"`.
  if (tail) {
    const tailNoParen = tail.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (tailNoParen !== tail && tailNoParen) {
      push(tailNoParen);
      push(lenient(tailNoParen));
    }
  }
  if (head) {
    const headNoParen = head.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (headNoParen !== head && headNoParen) {
      push(headNoParen);
      push(lenient(headNoParen));
    }
  }

  return [...out];
}

/** True when any variant of `a` equals any variant of `b`. Use sparingly —
 *  for N-vs-M lookups, prefer `buildVariantIndex` + Set lookups. */
export function titlesMatch(a: string, b: string): boolean {
  const vb = new Set(titleVariants(b));
  return titleVariants(a).some((v) => vb.has(v));
}

/** Build a reverse index: variant → original titles that produced it. Use
 *  for fast "does this title match any in the bag?" queries. */
export function buildVariantIndex(titles: Iterable<string>): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  for (const t of titles) {
    for (const v of titleVariants(t)) {
      if (!idx.has(v)) idx.set(v, new Set());
      idx.get(v)!.add(t);
    }
  }
  return idx;
}

/** Returns the original titles in the index that match any variant of
 *  `query`. Empty set if no match. */
export function findMatches(query: string, idx: Map<string, Set<string>>): Set<string> {
  const out = new Set<string>();
  for (const v of titleVariants(query)) {
    const hits = idx.get(v);
    if (hits) for (const h of hits) out.add(h);
  }
  return out;
}
