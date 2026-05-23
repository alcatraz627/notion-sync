import { test, expect } from "bun:test";
import { titleVariants, titlesMatch, buildVariantIndex, findMatches } from "./title-match";

// ── titlesMatch: the real-world rename pairs from the 2026-05-18 diff ────────

test("titlesMatch — qualifier-prefix drift (UI Widgets — Forms ↔ Forms)", () => {
  expect(titlesMatch("Forms", "UI Widgets — Forms")).toBe(true);
  expect(titlesMatch("Primitives", "UI Widgets — Primitives")).toBe(true);
});

test("titlesMatch — hyphen↔space + caps (Layout-and-nav ↔ Layout And Nav)", () => {
  expect(titlesMatch("Layout-and-nav", "UI Widgets — Layout And Nav")).toBe(true);
  expect(titlesMatch("Widgets-v2", "Widgets v2")).toBe(true);
});

test("titlesMatch — parenthetical qualifier (Auth ↔ Auth (Frontend))", () => {
  expect(titlesMatch("Auth", "Auth (Frontend)")).toBe(true);
});

test("titlesMatch — suffix qualifier via head (App ↔ App — product surface catalog)", () => {
  expect(titlesMatch("App", "App — product surface catalog")).toBe(true);
});

test("titlesMatch — prefix qualifier (Admin ↔ Product — Admin)", () => {
  expect(titlesMatch("Admin", "Product — Admin")).toBe(true);
  expect(titlesMatch("Credits", "Product Improvements — Credits")).toBe(true);
});

test("titlesMatch — unrelated titles do NOT match", () => {
  expect(titlesMatch("Forms", "Auth")).toBe(false);
  expect(titlesMatch("App", "Other")).toBe(false);
  expect(titlesMatch("Admin", "App")).toBe(false);
  expect(titlesMatch("Foo", "Bar")).toBe(false);
});

test("titlesMatch — camelCase-in-code is a known legit miss (not forced)", () => {
  // "Use-query-sync" vs "`useQuerySync` — URL ↔ state hook" — camelCase
  // tokenization differs; we accept this as a miss rather than over-matching.
  expect(titlesMatch("Use-query-sync", "`useQuerySync` — URL ↔ state hook")).toBe(false);
});

// ── titleVariants: shape ─────────────────────────────────────────────────────

test("titleVariants — includes verbatim, lenient, dash-tail, dash-head, paren-stripped", () => {
  const v = titleVariants("Product — Admin (beta)");
  expect(v).toContain("Product — Admin (beta)"); // verbatim
  expect(v).toContain("admin"); // dash-tail, paren-stripped, lenient
  expect(v).toContain("product"); // dash-head lenient
});

// ── buildVariantIndex + findMatches ──────────────────────────────────────────

test("findMatches — resolves a remote title to its local rename via the index", () => {
  const localTitles = ["UI Widgets — Forms", "Product — Admin", "Onboarding Router"];
  const idx = buildVariantIndex(localTitles);
  expect(findMatches("Forms", idx)).toEqual(new Set(["UI Widgets — Forms"]));
  expect(findMatches("Admin", idx)).toEqual(new Set(["Product — Admin"]));
  expect(findMatches("Nonexistent", idx).size).toBe(0);
});

test("findMatches — a generic token can hit multiple locals (caller disambiguates)", () => {
  const idx = buildVariantIndex(["Product — Admin", "Admin — Debug Tools"]);
  // both share the "admin" variant — findMatches returns both; the caller's
  // section-affinity/depth ranking picks the right one.
  expect(findMatches("Admin", idx).size).toBe(2);
});
