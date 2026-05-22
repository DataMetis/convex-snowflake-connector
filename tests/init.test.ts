import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { init, mergeEnvAppend } from "../src/commands/init.js";
import { ScriptedPrompter } from "../src/lib/prompter.js";
import type { ConvexProbeResult } from "../src/lib/probe/convex.js";
import type { SnowflakeProbeResult } from "../src/lib/probe/snowflake.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "csc-init-test-"));
}

const okConvex = (): ConvexProbeResult => ({
  ok: true,
  url: "https://flying-mongoose-123.convex.cloud",
  latencyMs: 12,
  version: "1.39.1",
});

const okSnowflake = (): SnowflakeProbeResult => ({
  ok: true,
  latencyMs: 400,
  session: {
    user: "USER",
    account: "abc12345.us-east-1",
    role: "ANALYTICS_WRITER",
    warehouse: "COMPUTE_WH",
    database: "IHDB",
    schema: "PUBLIC",
  },
});

describe("init", () => {
  it("walks the happy path and produces a write plan", async () => {
    const dir = tmpDir();
    const prompter = new ScriptedPrompter([
      "https://flying-mongoose-123.convex.cloud", // Convex URL
      "deploykey_abc", // deploy key
      "abc12345.us-east-1", // SF account
      "ANALYST", // SF user
      "p@ssw0rd", // SF password
      "IHDB", // database
      "PUBLIC", // schema
      "COMPUTE_WH", // warehouse
      "", // role (skip)
    ]);

    const plan = await init(
      {
        configPath: join(dir, "convex-snowflake.config.yaml"),
        envPath: join(dir, ".env.local"),
      },
      {
        prompter,
        probeConvex: vi.fn().mockResolvedValue(okConvex()),
        probeSnowflake: vi.fn().mockResolvedValue(okSnowflake()),
        discoverSnowflakeConnections: () => ({
          path: "/dev/null",
          usable: [],
          skipped: [],
        }),
        env: {},
      },
    );

    expect(prompter.drained()).toBe(true);
    expect(plan.configYaml).toContain("database: IHDB");
    expect(plan.configYaml).toContain("schema: PUBLIC");
    expect(plan.configYaml).toContain("warehouse: COMPUTE_WH");
    expect(plan.configYaml).not.toContain("role:"); // role was skipped
    expect(plan.configYaml).toContain("${SNOWFLAKE_PASSWORD}"); // secrets indirected

    expect(plan.envAppend).toContain(
      "CONVEX_URL=https://flying-mongoose-123.convex.cloud",
    );
    expect(plan.envAppend).toContain("CONVEX_DEPLOY_KEY=deploykey_abc");
    expect(plan.configYaml).toContain("admin_key: ${CONVEX_DEPLOY_KEY}");
    expect(plan.envAppend).toContain("SNOWFLAKE_PASSWORD=p@ssw0rd");
    expect(plan.envAppend).not.toContain("p@ssw0rd\nundefined");
  });

  it("includes the role line when supplied", async () => {
    const dir = tmpDir();
    const prompter = new ScriptedPrompter([
      "https://x.convex.cloud",
      "", // skip deploy key
      "acct",
      "user",
      "pw",
      "DB",
      "PUBLIC",
      "WH",
      "MY_ROLE",
    ]);

    const plan = await init(
      {
        configPath: join(dir, "c.yaml"),
        envPath: join(dir, ".env.local"),
      },
      {
        prompter,
        probeConvex: vi.fn().mockResolvedValue(okConvex()),
        probeSnowflake: vi.fn().mockResolvedValue(okSnowflake()),
        discoverSnowflakeConnections: () => ({
          path: "/dev/null",
          usable: [],
          skipped: [],
        }),
        env: {},
      },
    );

    expect(plan.configYaml).toContain("role: ${SNOWFLAKE_ROLE}");
    expect(plan.configYaml).not.toContain("admin_key"); // deploy key skipped
    expect(plan.envAppend).not.toContain("CONVEX_DEPLOY_KEY"); // skipped
  });

  it("aborts when the Convex probe fails", async () => {
    const dir = tmpDir();
    const prompter = new ScriptedPrompter(["https://broken.convex.cloud"]);

    await expect(
      init(
        {
          configPath: join(dir, "c.yaml"),
          envPath: join(dir, ".env.local"),
        },
        {
          prompter,
          probeConvex: vi.fn().mockResolvedValue({
            ok: false,
            url: "https://broken.convex.cloud",
            latencyMs: 0,
            error: "Could not reach Convex at ...",
          } satisfies ConvexProbeResult),
          probeSnowflake: vi.fn().mockResolvedValue(okSnowflake()),
          env: {},
        },
      ),
    ).rejects.toThrow(/Could not reach Convex/);
  });

  it("uses an existing externalbrowser connection from connections.toml", async () => {
    const dir = tmpDir();
    const probeSpy = vi.fn().mockResolvedValue(okSnowflake());
    const prompter = new ScriptedPrompter([
      "https://x.convex.cloud", // Convex URL
      "", // skip deploy key
      "RJDODFG-TCA34621", // pick existing connection by name
      "IHDB", // database
      "PUBLIC", // schema
      "COMPUTE_WH", // warehouse
      "", // role (skip)
    ]);

    const plan = await init(
      {
        configPath: join(dir, "c.yaml"),
        envPath: join(dir, ".env.local"),
      },
      {
        prompter,
        probeConvex: vi.fn().mockResolvedValue(okConvex()),
        probeSnowflake: probeSpy,
        discoverSnowflakeConnections: () => ({
          path: "~/.snowflake/connections.toml",
          usable: [
            {
              name: "RJDODFG-TCA34621",
              account: "RJDODFG-TCA34621",
              user: "STHAKUR500",
              authenticator: "externalbrowser",
            },
          ],
          skipped: [],
        }),
        env: {},
      },
    );

    expect(prompter.drained()).toBe(true);
    expect(plan.configYaml).toContain("authenticator: externalbrowser");
    expect(plan.configYaml).not.toContain("password:");
    expect(plan.envAppend).not.toContain("SNOWFLAKE_PASSWORD");
    expect(plan.envAppend).toContain("SNOWFLAKE_ACCOUNT=RJDODFG-TCA34621");
    expect(plan.envAppend).toContain("SNOWFLAKE_USER=STHAKUR500");
    expect(probeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "RJDODFG-TCA34621",
        user: "STHAKUR500",
        auth: { kind: "externalbrowser" },
      }),
    );
  });

  it("uses an existing OAuth authorization-code connection", async () => {
    const dir = tmpDir();
    const probeSpy = vi.fn().mockResolvedValue(okSnowflake());
    const prompter = new ScriptedPrompter([
      "https://x.convex.cloud", // Convex URL
      "", // skip deploy key
      "TCA34621", // pick existing connection by name
      "IHDB", // database
      "PUBLIC", // schema
      "COMPUTE_WH", // warehouse
      "", // role (skip)
    ]);

    const plan = await init(
      {
        configPath: join(dir, "c.yaml"),
        envPath: join(dir, ".env.local"),
      },
      {
        prompter,
        probeConvex: vi.fn().mockResolvedValue(okConvex()),
        probeSnowflake: probeSpy,
        discoverSnowflakeConnections: () => ({
          path: "~/.snowflake/connections.toml",
          usable: [
            {
              name: "TCA34621",
              account: "tca34621.us-east-1",
              user: "STHAKUR500",
              authenticator: "oauth-authorization-code",
              clientStoreTemporaryCredential: true,
            },
          ],
          skipped: [],
        }),
        env: {},
      },
    );

    expect(prompter.drained()).toBe(true);
    expect(plan.configYaml).toContain(
      "authenticator: oauth-authorization-code",
    );
    expect(plan.configYaml).toContain(
      "client_store_temporary_credential: true",
    );
    expect(plan.configYaml).not.toContain("password:");
    expect(plan.envAppend).not.toContain("SNOWFLAKE_PASSWORD");
    expect(probeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "tca34621.us-east-1",
        user: "STHAKUR500",
        auth: {
          kind: "oauth-authorization-code",
          clientStoreTemporaryCredential: true,
        },
      }),
    );
  });

  it("aborts when the Snowflake probe fails", async () => {
    const dir = tmpDir();
    const prompter = new ScriptedPrompter([
      "https://x.convex.cloud",
      "",
      "wrong-account",
      "user",
      "pw",
      "DB",
      "PUBLIC",
      "WH",
      "",
    ]);

    await expect(
      init(
        {
          configPath: join(dir, "c.yaml"),
          envPath: join(dir, ".env.local"),
        },
        {
          prompter,
          probeConvex: vi.fn().mockResolvedValue(okConvex()),
          probeSnowflake: vi.fn().mockResolvedValue({
            ok: false,
            latencyMs: 0,
            error: 'Snowflake account "wrong-account" not found.',
          } satisfies SnowflakeProbeResult),
          discoverSnowflakeConnections: () => ({
            path: "/dev/null",
            usable: [],
            skipped: [],
          }),
          env: {},
        },
      ),
    ).rejects.toThrow(/wrong-account/);
  });
});

describe("mergeEnvAppend", () => {
  const APPEND =
    "# convex-snowflake-connector\nCONVEX_URL=https://a.convex.cloud\nSNOWFLAKE_ACCOUNT=acct1\nSNOWFLAKE_USER=user1\n";

  it("writes the append block verbatim into an empty file", () => {
    expect(mergeEnvAppend("", APPEND)).toBe(APPEND);
  });

  it("does not duplicate keys when run twice", () => {
    const once = mergeEnvAppend("", APPEND);
    const twice = mergeEnvAppend(once, APPEND);
    expect(twice).toBe(APPEND);
    expect(twice.match(/^CONVEX_URL=/gm)).toHaveLength(1);
    expect(twice.match(/^SNOWFLAKE_ACCOUNT=/gm)).toHaveLength(1);
    expect(twice.match(/^# convex-snowflake-connector$/gm)).toHaveLength(1);
  });

  it("replaces stale managed values with the new ones", () => {
    const stale =
      "# convex-snowflake-connector\nCONVEX_URL=https://old.convex.cloud\nSNOWFLAKE_ACCOUNT=oldacct\nSNOWFLAKE_USER=olduser\n";
    const merged = mergeEnvAppend(stale, APPEND);
    expect(merged).toContain("CONVEX_URL=https://a.convex.cloud");
    expect(merged).not.toContain("https://old.convex.cloud");
    expect(merged).not.toContain("oldacct");
  });

  it("preserves unrelated user-defined vars and comments", () => {
    const userContent =
      "# my own notes\nMY_OWN_VAR=keep-me\nANOTHER=42\nCONVEX_URL=https://old.convex.cloud\n";
    const merged = mergeEnvAppend(userContent, APPEND);
    expect(merged).toContain("# my own notes");
    expect(merged).toContain("MY_OWN_VAR=keep-me");
    expect(merged).toContain("ANOTHER=42");
    expect(merged).toContain("CONVEX_URL=https://a.convex.cloud");
    expect(merged).not.toContain("https://old.convex.cloud");
    // User content comes first, then a blank-line separator, then our block.
    expect(merged.indexOf("MY_OWN_VAR")).toBeLessThan(
      merged.indexOf("# convex-snowflake-connector"),
    );
  });

  it("does not accumulate trailing blank lines across runs", () => {
    let content = "";
    for (let i = 0; i < 5; i++) content = mergeEnvAppend(content, APPEND);
    expect(content).toBe(APPEND);
    expect(content.match(/\n\n+$/)).toBeNull();
  });
});
