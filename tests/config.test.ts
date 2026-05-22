import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, interpolateEnv, loadConfig } from "../src/lib/config.js";

const baseYaml = [
  "convex:",
  "  url: ${CONVEX_URL}",
  "  admin_key: ${CONVEX_ADMIN_KEY}",
  "snowflake:",
  "  account: ${SNOWFLAKE_ACCOUNT}",
  "  user: ${SNOWFLAKE_USER}",
  "  database: IHDB",
  "  schema: PUBLIC",
  "  warehouse: COMPUTE_WH",
  "sync:",
  "  mode: full_refresh",
  "  tables:",
  "    - users",
  "    - orders",
  "",
].join("\n");

describe("interpolateEnv", () => {
  it("substitutes $-VAR placeholders in nested strings", () => {
    const out = interpolateEnv(
      { a: "${FOO}", b: ["${BAR}", { c: "${FOO}-x" }] },
      { FOO: "f", BAR: "b" },
    );
    expect(out).toEqual({ a: "f", b: ["b", { c: "f-x" }] });
  });

  it("throws on missing env var", () => {
    expect(() => interpolateEnv("${MISSING}", {})).toThrow(/MISSING/);
  });
});

describe("ConfigSchema", () => {
  it("defaults sync.mode to full_refresh and tables to '*'", () => {
    const cfg = ConfigSchema.parse({
      convex: { url: "https://x.convex.cloud" },
      snowflake: {
        account: "a",
        user: "u",
        database: "d",
        schema: "s",
        warehouse: "w",
      },
      sync: {},
    });
    expect(cfg.sync.mode).toBe("full_refresh");
    expect(cfg.sync.tables).toBe("*");
  });

  it("rejects an invalid sync.mode", () => {
    expect(() =>
      ConfigSchema.parse({
        convex: { url: "https://x.convex.cloud" },
        snowflake: {
          account: "a",
          user: "u",
          database: "d",
          schema: "s",
          warehouse: "w",
        },
        sync: { mode: "bogus" },
      }),
    ).toThrow();
  });

  it("rejects sync.mode=merge (not yet implemented)", () => {
    // Guards against accidentally re-introducing merge in the public schema
    // before the loader supports it.
    expect(() =>
      ConfigSchema.parse({
        convex: { url: "https://x.convex.cloud" },
        snowflake: {
          account: "a",
          user: "u",
          database: "d",
          schema: "s",
          warehouse: "w",
        },
        sync: { mode: "merge" },
      }),
    ).toThrow();
  });
});

describe("loadConfig", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "csc-cfg-"));
    path = join(dir, "config.yaml");
    writeFileSync(path, baseYaml);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses YAML and interpolates env vars", () => {
    const cfg = loadConfig(path, {
      CONVEX_URL: "https://demo.convex.cloud",
      CONVEX_ADMIN_KEY: "secret",
      SNOWFLAKE_ACCOUNT: "acct",
      SNOWFLAKE_USER: "alice",
    });
    expect(cfg.convex.url).toBe("https://demo.convex.cloud");
    expect(cfg.convex.admin_key).toBe("secret");
    expect(cfg.snowflake.account).toBe("acct");
    expect(cfg.sync.mode).toBe("full_refresh");
    expect(cfg.sync.tables).toEqual(["users", "orders"]);
  });

  it("auto-loads .env.local next to the config", () => {
    writeFileSync(
      join(dir, ".env.local"),
      [
        "CONVEX_URL=https://from-envfile.convex.cloud",
        "CONVEX_ADMIN_KEY=k",
        "SNOWFLAKE_ACCOUNT=a",
        "SNOWFLAKE_USER=u",
      ].join("\n"),
    );
    const env: NodeJS.ProcessEnv = {};
    const cfg = loadConfig(path, env);
    expect(cfg.convex.url).toBe("https://from-envfile.convex.cloud");
    expect(env["CONVEX_URL"]).toBe("https://from-envfile.convex.cloud");
  });

  it("skips env auto-load when envFile=false", () => {
    writeFileSync(join(dir, ".env.local"), "CONVEX_URL=should-not-be-used\n");
    expect(() => loadConfig(path, {}, { envFile: false })).toThrow(
      /CONVEX_URL/,
    );
  });

  it("gives a friendly error when the config file is missing", () => {
    expect(() => loadConfig(join(dir, "nope.yaml"))).toThrow(
      /Config file not found.*init/,
    );
  });
});
