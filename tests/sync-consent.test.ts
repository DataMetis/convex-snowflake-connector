import { describe, expect, it, vi } from "vitest";
import {
  ensureConsent,
  SyncCancelledError,
  SyncConsentRequiredError,
  type SyncRundown,
} from "../src/commands/sync-consent.js";
import { formatConsentBanner } from "../src/commands/sync-format.js";

const rundown: SyncRundown = {
  source: "/tmp/convex-export-abc.zip",
  database: "IHDB",
  schema: "PUBLIC",
  tables: ["users", "orders", "sessions"],
};

describe("ensureConsent", () => {
  it("returns silently when yes=true and never invokes the callback", async () => {
    const confirm = vi.fn();
    await expect(
      ensureConsent({ yes: true, confirm }, rundown),
    ).resolves.toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("invokes the confirm callback when yes is not set", async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    await ensureConsent({ confirm }, rundown);
    expect(confirm).toHaveBeenCalledWith(rundown);
  });

  it("throws SyncCancelledError when the callback returns false", async () => {
    await expect(
      ensureConsent({ confirm: () => Promise.resolve(false) }, rundown),
    ).rejects.toBeInstanceOf(SyncCancelledError);
  });

  it("throws SyncConsentRequiredError when no callback and no yes flag", async () => {
    await expect(ensureConsent({}, rundown)).rejects.toBeInstanceOf(
      SyncConsentRequiredError,
    );
  });

  it("error message mentions --yes, non-recoverability, and Convex read-only", async () => {
    try {
      await ensureConsent({}, rundown);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SyncConsentRequiredError);
      const msg = (err as Error).message;
      expect(msg).toMatch(/--yes/);
      expect(msg).toMatch(/non-recoverabl/i);
      expect(msg).toMatch(/Convex is not modified/i);
    }
  });

  it("propagates errors thrown inside the callback", async () => {
    const boom = new Error("callback failed");
    await expect(
      ensureConsent({ confirm: () => Promise.reject(boom) }, rundown),
    ).rejects.toBe(boom);
  });
});

// ANSI escape codes get stripped here so the assertions don't depend on the
// terminal-detection heuristic in colors.ts.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("formatConsentBanner", () => {
  it("includes the Convex-read-only / Snowflake-destructive framing", () => {
    const out = stripAnsi(formatConsentBanner(rundown));
    expect(out).toMatch(/Convex side.+read-only/i);
    expect(out).toMatch(/No data on Convex is modified/i);
    expect(out).toMatch(/Snowflake side.+destructive/i);
  });

  it("shows source, target, and table count", () => {
    const out = stripAnsi(formatConsentBanner(rundown));
    expect(out).toContain("/tmp/convex-export-abc.zip");
    expect(out).toContain("IHDB.PUBLIC");
    expect(out).toContain("3 to replace");
    expect(out).toContain("users, orders, sessions");
  });

  it("truncates the table list when there are more than 8 tables", () => {
    const many: SyncRundown = {
      ...rundown,
      tables: Array.from({ length: 12 }, (_, i) => `t${i}`),
    };
    const out = stripAnsi(formatConsentBanner(many));
    expect(out).toContain("12 to replace");
    expect(out).toMatch(/t0, t1, t2, t3, t4, t5, t6, t7, … \(4 more\)/);
    expect(out).not.toContain("t11");
  });

  it("describes the 5-step swap flow and the non-recoverable warning", () => {
    const out = stripAnsi(formatConsentBanner(rundown));
    expect(out).toMatch(/CREATE OR REPLACE TABLE.*__csc_staging LIKE/);
    expect(out).toMatch(/COPY INTO.*__csc_staging/);
    expect(out).toMatch(/ALTER TABLE.*SWAP WITH/);
    expect(out).toMatch(/DROP TABLE.*__csc_staging/);
    expect(out).toMatch(/cannot restore them/i);
  });

  it("instructs the user to type 'yes'", () => {
    const out = stripAnsi(formatConsentBanner(rundown));
    expect(out).toMatch(/Type 'yes' to proceed/);
  });
});
