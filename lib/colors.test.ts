import { test, expect } from "bun:test";
import { CODES, dim, green, red, grey, url, makeClr } from "./colors";

test("standalone helpers wrap text in the right code + reset", () => {
  expect(dim("x")).toBe(`${CODES.dim}x${CODES.reset}`);
  expect(green("x")).toBe(`${CODES.green}x${CODES.reset}`);
  expect(red("x")).toBe(`${CODES.red}x${CODES.reset}`);
});

test("grey uses the 256-color code (notion-list's grey245), not bright-black", () => {
  expect(grey("x")).toBe(`\x1b[38;5;245mx${CODES.reset}`);
  expect(CODES.grey245).toBe("\x1b[38;5;245m");
});

test("url is underline-blue (reconcile's shape)", () => {
  expect(url("x")).toBe(`\x1b[4;34mx${CODES.reset}`);
});

test("makeClr(true) paints, makeClr(false) passes through plain", () => {
  const on = makeClr(true);
  const off = makeClr(false);
  expect(on.err("x")).toBe(`${CODES.red}x${CODES.reset}`);
  expect(off.err("x")).toBe("x");
  // gray uses bright-black (index.ts's W), distinct from standalone grey245
  expect(on.gray("x")).toBe(`${CODES.brightBlack}x${CODES.reset}`);
});

test("makeClr composite codes (header/phase/section are bold+color)", () => {
  const on = makeClr(true);
  expect(on.header("x")).toBe(`${CODES.bold}${CODES.cyan}x${CODES.reset}`);
  expect(on.phase("x")).toBe(`${CODES.bold}${CODES.blue}x${CODES.reset}`);
  expect(on.section("x")).toBe(`${CODES.bold}${CODES.magenta}x${CODES.reset}`);
});

test("makeClr.url (cyan, index.ts shape) differs from standalone url (underline-blue)", () => {
  // Deliberate divergence: index.ts rendered urls as plain cyan; reconcile
  // used underline-blue. Both preserved — guard against accidental unification.
  expect(makeClr(true).url("x")).toBe(`${CODES.cyan}x${CODES.reset}`);
  expect(url("x")).toBe(`${CODES.underlineBlue}x${CODES.reset}`);
  expect(makeClr(true).url("x")).not.toBe(url("x"));
});
