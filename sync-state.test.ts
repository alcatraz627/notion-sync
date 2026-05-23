import { test, expect } from "bun:test";
import { getCacheKey, getSnapshotPath, getStatePath } from "./sync-state";

function withRoot(root: string | undefined, fn: () => void) {
  const prev = process.env.NOTION_ROOT_PAGE_ID;
  if (root === undefined) delete process.env.NOTION_ROOT_PAGE_ID;
  else process.env.NOTION_ROOT_PAGE_ID = root;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.NOTION_ROOT_PAGE_ID;
    else process.env.NOTION_ROOT_PAGE_ID = prev;
  }
}

test("getCacheKey — first 12 hex of the root id", () => {
  withRoot("V2-Product-Docs-364bacd27dee8053899ae7a5e6da8af3", () => {
    expect(getCacheKey()).toBe("364bacd27dee");
  });
  withRoot("https://www.notion.so/364bacd27dee8053899ae7a5e6da8af3?pvs=4", () => {
    expect(getCacheKey()).toBe("364bacd27dee");
  });
});

test("getCacheKey — 'default' when no id can be parsed", () => {
  withRoot("just-a-name-no-hex", () => expect(getCacheKey()).toBe("default"));
  withRoot(undefined, () => expect(getCacheKey()).toBe("default"));
});

test("getStatePath + getSnapshotPath — root-keyed filenames", () => {
  withRoot("364bacd27dee8053899ae7a5e6da8af3", () => {
    expect(getStatePath()).toContain(".notion-sync-state.364bacd27dee.json");
    expect(getSnapshotPath("product/jobs/overview.md"))
      .toContain(".notion-snapshots.364bacd27dee/product/jobs/overview.md");
  });
});

test("getCacheKey — distinct roots produce distinct keys (no collision)", () => {
  let a = "", b = "";
  withRoot("352bacd27dee80f3be8fe230c7d1ff9d", () => { a = getCacheKey(); });
  withRoot("364bacd27dee8053899ae7a5e6da8af3", () => { b = getCacheKey(); });
  expect(a).not.toBe(b);
});
