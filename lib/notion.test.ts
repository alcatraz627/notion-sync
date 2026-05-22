import { test, expect } from "bun:test";
import { extractPageId, getNotion } from "./notion";

test("extractPageId — bare 32-hex", () => {
  expect(extractPageId("364bacd27dee8053899ae7a5e6da8af3")).toBe("364bacd27dee8053899ae7a5e6da8af3");
});

test("extractPageId — slug-prefixed", () => {
  expect(extractPageId("V2-Product-Docs-364bacd27dee8053899ae7a5e6da8af3")).toBe("364bacd27dee8053899ae7a5e6da8af3");
});

test("extractPageId — copy-link URL", () => {
  expect(extractPageId("https://www.notion.so/364bacd27dee8053899ae7a5e6da8af3")).toBe("364bacd27dee8053899ae7a5e6da8af3");
});

test("extractPageId — URL with ?pvs query (regression: was aborting sync)", () => {
  expect(extractPageId("https://www.notion.so/Page-364bacd27dee8053899ae7a5e6da8af3?pvs=4")).toBe("364bacd27dee8053899ae7a5e6da8af3");
});

test("extractPageId — decoy id in query param does not win", () => {
  const real = "364bacd27dee8053899ae7a5e6da8af3";
  const decoy = "999bbbb27dee8053899ae7a5e6da8af3";
  expect(extractPageId(`https://www.notion.so/Page-${real}?d=${decoy}`)).toBe(real);
});

test("extractPageId — dashed UUID normalizes to undashed lowercase", () => {
  expect(extractPageId("364BACD2-7DEE-8053-899A-E7A5E6DA8AF3")).toBe("364bacd27dee8053899ae7a5e6da8af3");
});

test("extractPageId — 32-hex slug before dashed id: dashed wins", () => {
  const slug = "aaaabbbbccccdddd1111222233334444";
  const real = "364bacd2-7dee-8053-899a-e7a5e6da8af3";
  expect(extractPageId(`${slug}-${real}`)).toBe("364bacd27dee8053899ae7a5e6da8af3");
});

test("extractPageId — no id present returns null", () => {
  expect(extractPageId("just-a-slug-no-id")).toBeNull();
  expect(extractPageId("")).toBeNull();
});

test("getNotion — returns a client even with no token (lenient by design)", () => {
  const prev = process.env.NOTION_TOKEN;
  delete process.env.NOTION_TOKEN;
  const client = getNotion();
  expect(client).toBeDefined();
  expect(typeof client).toBe("object");
  if (prev !== undefined) process.env.NOTION_TOKEN = prev;
});
