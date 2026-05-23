import { test, expect } from "bun:test";
import { loadEnv } from "./env";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

function withTempEnv(body: string, fn: (p: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-test-"));
  const p = path.join(dir, ".env");
  fs.writeFileSync(p, body);
  try { fn(p); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("loadEnv — strips surrounding quotes AND trims (the unified rule)", () => {
  withTempEnv(`FOO_QUOTED="hello"\nFOO_SPACED=  spaced  \nFOO_BOTH=  "both"  \n`, (p) => {
    delete process.env.FOO_QUOTED; delete process.env.FOO_SPACED; delete process.env.FOO_BOTH;
    loadEnv(p);
    expect(process.env.FOO_QUOTED).toBe("hello");  // quotes stripped
    expect(process.env.FOO_SPACED).toBe("spaced");  // trimmed
    expect(process.env.FOO_BOTH).toBe("both");       // trimmed then de-quoted
    delete process.env.FOO_QUOTED; delete process.env.FOO_SPACED; delete process.env.FOO_BOTH;
  });
});

test("loadEnv — never overwrites a var already in the environment", () => {
  withTempEnv(`FOO_PRESET=fromfile\n`, (p) => {
    process.env.FOO_PRESET = "fromshell";
    loadEnv(p);
    expect(process.env.FOO_PRESET).toBe("fromshell"); // shell value wins
    delete process.env.FOO_PRESET;
  });
});

test("loadEnv — leaves a deliberately-empty existing var empty", () => {
  withTempEnv(`FOO_EMPTY=fromfile\n`, (p) => {
    process.env.FOO_EMPTY = ""; // present but empty
    loadEnv(p);
    expect(process.env.FOO_EMPTY).toBe(""); // not overwritten (key IS present)
    delete process.env.FOO_EMPTY;
  });
});

test("loadEnv — ignores non-KEY=VALUE lines and missing file", () => {
  withTempEnv(`# a comment\n\nlowercase=skipped\nGOOD=ok\n`, (p) => {
    delete process.env.GOOD;
    loadEnv(p);
    expect(process.env.GOOD).toBe("ok");
    expect(process.env.lowercase).toBeUndefined();
    delete process.env.GOOD;
  });
  expect(() => loadEnv("/nonexistent/path/.env")).not.toThrow();
});
