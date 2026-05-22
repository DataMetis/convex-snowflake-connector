import { describe, expect, it, vi } from "vitest";
import { doctor, formatReport } from "../src/commands/doctor.js";
import type { Config } from "../src/lib/config.js";
import type { ConvexProbeResult } from "../src/lib/probe/convex.js";
import type { SnowflakeProbeResult } from "../src/lib/probe/snowflake.js";

const configWithPassword = (): Config => ({
  convex: {
    url: "https://x.convex.cloud",
    admin_key: "deploykey_abc",
  },
  snowflake: {
    account: "abc12345.us-east-1",
    user: "USER",
    password: "pw",
    database: "IHDB",
    schema: "PUBLIC",
    warehouse: "COMPUTE_WH",
  },
  sync: { mode: "full_refresh", tables: "*" },
});

const okConvex = (): ConvexProbeResult => ({
  ok: true,
  url: "https://x.convex.cloud",
  latencyMs: 12,
  version: "1.39.1",
});

const okSnowflake = (): SnowflakeProbeResult => ({
  ok: true,
  latencyMs: 411,
  session: {
    user: "USER",
    account: "ABC12345",
    role: "ANALYTICS_WRITER",
    warehouse: "COMPUTE_WH",
    database: "IHDB",
    schema: "PUBLIC",
  },
});

describe("doctor", () => {
  it("reports ok when both probes succeed", async () => {
    const report = await doctor(configWithPassword(), {
      probeConvex: vi.fn().mockResolvedValue(okConvex()),
      probeSnowflake: vi.fn().mockResolvedValue(okSnowflake()),
    });
    expect(report.ok).toBe(true);
    const formatted = formatReport(report);
    expect(formatted).toContain("✓ reachable");
    expect(formatted).toContain("✓ connected");
    expect(formatted).toContain("✓ All checks passed");
  });

  it("runs both probes even when one fails (so users see the full picture)", async () => {
    const probeConvex = vi.fn().mockResolvedValue({
      ok: false,
      url: "https://x.convex.cloud",
      latencyMs: 0,
      error: "Could not reach Convex at .../version",
    } satisfies ConvexProbeResult);
    const probeSnowflake = vi.fn().mockResolvedValue(okSnowflake());

    const report = await doctor(configWithPassword(), {
      probeConvex,
      probeSnowflake,
    });

    expect(probeConvex).toHaveBeenCalled();
    expect(probeSnowflake).toHaveBeenCalled();
    expect(report.ok).toBe(false);
    const formatted = formatReport(report);
    expect(formatted).toContain("✗ Could not reach Convex");
    expect(formatted).toContain("✓ connected");
    expect(formatted).toContain("✗ Some checks failed");
  });

  it("picks key-pair auth when private_key is set", async () => {
    const probeSnowflake = vi.fn().mockResolvedValue(okSnowflake());
    const cfg: Config = {
      ...configWithPassword(),
      snowflake: {
        ...configWithPassword().snowflake,
        password: undefined,
        private_key: "/path/to/key.p8",
      },
    };
    await doctor(cfg, {
      probeConvex: vi.fn().mockResolvedValue(okConvex()),
      probeSnowflake,
    });
    expect(probeSnowflake).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: { kind: "key-pair", privateKeyPath: "/path/to/key.p8" },
      }),
    );
  });

  it("throws when no Snowflake credential is present", async () => {
    const cfg: Config = {
      ...configWithPassword(),
      snowflake: { ...configWithPassword().snowflake, password: undefined },
    };
    await expect(
      doctor(cfg, {
        probeConvex: vi.fn().mockResolvedValue(okConvex()),
        probeSnowflake: vi.fn().mockResolvedValue(okSnowflake()),
      }),
    ).rejects.toThrow(/authenticator|password|private_key/);
  });
});
