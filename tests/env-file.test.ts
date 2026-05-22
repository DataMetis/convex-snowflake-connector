import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnvFile, parseEnvFile } from "../src/lib/env-file.js";

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "csc-env-"));
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

describe("parseEnvFile", () => {
  it("parses KEY=value, ignores blanks and comments", () => {
    expect(
      parseEnvFile(["# leading", "FOO=bar", "", "BAZ = qux"].join("\n")),
    ).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips matched surrounding quotes", () => {
    expect(parseEnvFile(`A="b c"\nB='d e'\nC=raw`)).toEqual({
      A: "b c",
      B: "d e",
      C: "raw",
    });
  });

  it("trims whitespace inside quoted values", () => {
    expect(parseEnvFile(`X=" royal-history "`)).toEqual({ X: "royal-history" });
  });

  it("strips trailing inline `# comment` from unquoted values", () => {
    expect(
      parseEnvFile(
        "CONVEX_DEPLOYMENT=prod:abc # team: foo, project: bar\nOTHER=x #y",
      ),
    ).toEqual({ CONVEX_DEPLOYMENT: "prod:abc", OTHER: "x" });
  });

  it("preserves `#` inside quoted values", () => {
    expect(parseEnvFile(`KEY="a # b"`)).toEqual({ KEY: "a # b" });
  });

  it("strips a comment that follows the closing quote", () => {
    expect(parseEnvFile(`KEY="value" # trailing`)).toEqual({ KEY: "value" });
  });

  it("skips malformed lines silently", () => {
    expect(parseEnvFile("garbage\nFOO=bar\n=novalue\n")).toEqual({
      FOO: "bar",
    });
  });
});

describe("loadEnvFile", () => {
  it("reports missing when file does not exist", () => {
    const env: NodeJS.ProcessEnv = {};
    const r = loadEnvFile(join(tmpdir(), "definitely-missing.env"), env);
    expect(r.missing).toBe(true);
    expect(r.loaded).toEqual([]);
    expect(env).toEqual({});
  });

  it("loads values into env but does not override existing keys", () => {
    const path = tmpFile(".env.local", "FOO=from_file\nBAR=set\n");
    const env: NodeJS.ProcessEnv = { FOO: "from_shell" };
    const r = loadEnvFile(path, env);
    expect(r.missing).toBe(false);
    expect(env["FOO"]).toBe("from_shell"); // shell wins
    expect(env["BAR"]).toBe("set");
    expect(r.loaded).toEqual(["BAR"]);
  });
});
