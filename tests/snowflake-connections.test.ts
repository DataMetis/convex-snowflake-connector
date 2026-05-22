import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverSnowflakeConnections,
  parseConnectionsToml,
} from "../src/lib/snowflake-connections.js";

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "csc-conn-test-"));
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

describe("parseConnectionsToml", () => {
  it("parses named tables with string and boolean values", () => {
    const parsed = parseConnectionsToml(
      [
        `default_connection_name = "TCA34621"`,
        ``,
        `[TCA34621]`,
        `account = "tca34621.us-east-1"`,
        `user = "STHAKUR500"`,
        `authenticator = "EXTERNALBROWSER"`,
        `client_store_temporary_credential = true`,
      ].join("\n"),
    );
    expect(parsed.top["default_connection_name"]).toBe("TCA34621");
    expect(parsed.tables["TCA34621"]).toEqual({
      account: "tca34621.us-east-1",
      user: "STHAKUR500",
      authenticator: "EXTERNALBROWSER",
      client_store_temporary_credential: true,
    });
  });

  it("ignores comments and blank lines", () => {
    const parsed = parseConnectionsToml(
      `# top comment\n[A]\nuser = "x"  # trailing comment\n\n# another\naccount = "y"\n`,
    );
    expect(parsed.tables["A"]).toEqual({ user: "x", account: "y" });
  });
});

describe("discoverSnowflakeConnections", () => {
  it("returns empty discovery when the file is missing", () => {
    const result = discoverSnowflakeConnections({
      path: join(tmpdir(), "definitely-not-here-csc.toml"),
    });
    expect(result.usable).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("classifies externalbrowser, password, and OAuth authorization code as usable", () => {
    const path = tmpFile(
      "connections.toml",
      [
        `default_connection_name = "TCA34621"`,
        ``,
        `[RJDODFG-TCA34621]`,
        `account = "RJDODFG-TCA34621"`,
        `user = "STHAKUR500"`,
        `authenticator = "EXTERNALBROWSER"`,
        `role = ""`,
        ``,
        `[TCA34621]`,
        `account = "tca34621.us-east-1"`,
        `user = "STHAKUR500"`,
        `authenticator = "OAUTH_AUTHORIZATION_CODE"`,
        `client_store_temporary_credential = true`,
        ``,
        `[LEGACY]`,
        `account = "abc12345.us-east-1"`,
        `user = "ANALYST"`,
        `password = "s3cret"`,
      ].join("\n"),
    );
    const result = discoverSnowflakeConnections({ path });
    expect(result.usable).toHaveLength(3);
    const browser = result.usable.find((c) => c.name === "RJDODFG-TCA34621");
    expect(browser?.authenticator).toBe("externalbrowser");
    expect(browser?.role).toBeUndefined(); // empty string treated as missing
    const oauth = result.usable.find((c) => c.name === "TCA34621");
    expect(oauth?.authenticator).toBe("oauth-authorization-code");
    expect(oauth?.clientStoreTemporaryCredential).toBe(true);
    const legacy = result.usable.find((c) => c.name === "LEGACY");
    expect(legacy?.authenticator).toBe("password");
    expect(legacy?.password).toBe("s3cret");
    expect(result.skipped).toEqual([]);
  });

  it("skips OAuth variants that aren't authorization-code", () => {
    const path = tmpFile(
      "connections.toml",
      [
        `[CC]`,
        `account = "a"`,
        `user = "u"`,
        `authenticator = "OAUTH_CLIENT_CREDENTIALS"`,
      ].join("\n"),
    );
    const result = discoverSnowflakeConnections({ path });
    expect(result.usable).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.name).toBe("CC");
    expect(result.skipped[0]?.reason).toMatch(/OAUTH_CLIENT_CREDENTIALS/);
  });

  it("skips connections missing account or user", () => {
    const path = tmpFile(
      "connections.toml",
      [`[BROKEN]`, `authenticator = "EXTERNALBROWSER"`].join("\n"),
    );
    const result = discoverSnowflakeConnections({ path });
    expect(result.usable).toEqual([]);
    expect(result.skipped).toEqual([
      { name: "BROKEN", reason: "missing account or user" },
    ]);
  });
});
