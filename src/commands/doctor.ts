import type { Config } from "../lib/config.js";
import { bold, cyan, dim, green, red } from "../lib/colors.js";
import { loadConfigWithEnv } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import type {
  ConvexProbeInput,
  ConvexProbeResult,
} from "../lib/probe/convex.js";
import { probeConvex } from "../lib/probe/convex.js";
import type {
  SnowflakeCreds,
  SnowflakeProbeResult,
} from "../lib/probe/snowflake.js";
import { probeSnowflake } from "../lib/probe/snowflake.js";
import { authFromConfig } from "../lib/snowflake.js";

/**
 * Preflight health check. Loads the config and runs both probes against
 * the live deployments. Both probes always run — partial reports beat
 * "first failure short-circuits" because users want to fix everything in
 * one round-trip, not chase issues one at a time.
 *
 * Exit non-zero on any failed check so it composes with CI.
 */

export interface DoctorOptions {
  config: string;
}

export interface DoctorDeps {
  probeConvex: (input: ConvexProbeInput) => Promise<ConvexProbeResult>;
  probeSnowflake: (creds: SnowflakeCreds) => Promise<SnowflakeProbeResult>;
}

export interface DoctorReport {
  ok: boolean;
  convex: ConvexProbeResult;
  snowflake: SnowflakeProbeResult;
}

function configToCreds(config: Config): SnowflakeCreds {
  const sf = config.snowflake;
  return {
    account: sf.account,
    user: sf.user,
    auth: authFromConfig(sf),
    warehouse: sf.warehouse,
    database: sf.database,
    schema: sf.schema,
    ...(sf.role !== undefined ? { role: sf.role } : {}),
  };
}

/**
 * Pure orchestrator. Takes a loaded config and injected probes, returns a
 * report. Does not load the config or print — the CLI wrapper does both.
 */
export async function doctor(
  config: Config,
  deps: DoctorDeps,
): Promise<DoctorReport> {
  const [convex, snowflake] = await Promise.all([
    deps.probeConvex({ url: config.convex.url }),
    deps.probeSnowflake(configToCreds(config)),
  ]);
  return { ok: convex.ok && snowflake.ok, convex, snowflake };
}

function formatConvex(r: ConvexProbeResult): string {
  if (r.ok) {
    const v = r.version !== undefined ? `, v${r.version}` : "";
    return `  ${green("✓")} reachable ${dim(`(${r.latencyMs}ms${v})`)}`;
  }
  return `  ${red("✗")} ${r.error ?? "unknown error"}`;
}

function formatSnowflake(r: SnowflakeProbeResult): string {
  if (r.ok && r.session) {
    const s = r.session;
    const parts = [
      `${s.user}@${s.account}`,
      s.role !== null ? `role=${s.role}` : null,
      s.warehouse !== null ? `warehouse=${s.warehouse}` : null,
      s.database !== null && s.schema !== null
        ? `${s.database}.${s.schema}`
        : null,
    ].filter((p): p is string => p !== null);
    return `  ${green("✓")} connected ${dim(`(${r.latencyMs}ms)`)} as ${parts.join(", ")}`;
  }
  return `  ${red("✗")} ${r.error ?? "unknown error"}`;
}

const NEXT_STEPS_OK = [
  "Next steps:",
  `  ${cyan("convex-snowflake-connector discover")}`,
  `    ${dim("infer table schemas (auto-runs `convex export` if needed)")}`,
  `  ${cyan("convex-snowflake-connector ddl")}`,
  `    ${dim("generate Snowflake CREATE TABLE statements (review before sync)")}`,
  `  ${cyan("convex-snowflake-connector sync")}`,
  `    ${dim("run the Convex → Snowflake load")}`,
  "",
].join("\n");

const NEXT_STEPS_FAIL = [
  "Next steps:",
  `  ${dim("Fix the failing check above, then re-run")} ${cyan("convex-snowflake-connector doctor")}.`,
  `  ${dim("Or re-run the wizard:")} ${cyan("convex-snowflake-connector init --force")}.`,
  "",
].join("\n");

export function formatReport(report: DoctorReport): string {
  const head =
    `${bold("Convex")}\n${formatConvex(report.convex)}\n` +
    `${bold("Snowflake")}\n${formatSnowflake(report.snowflake)}\n\n`;
  const verdict = report.ok
    ? `${green("✓")} All checks passed.\n\n`
    : `${red("✗")} Some checks failed.\n\n`;
  const tail = report.ok ? NEXT_STEPS_OK : NEXT_STEPS_FAIL;
  return head + verdict + tail;
}

/** CLI entry: loads config, runs the probes, prints, exits non-zero on failure. */
export async function doctorCommand(opts: DoctorOptions): Promise<void> {
  const { config, envFile } = loadConfigWithEnv(opts.config);
  if (envFile !== null && !envFile.missing && envFile.loaded.length > 0) {
    process.stdout.write(
      dim(`(loaded ${envFile.loaded.length} var(s) from ${envFile.path})\n`),
    );
  }
  const report = await doctor(config, { probeConvex, probeSnowflake });
  process.stdout.write(formatReport(report));
  logger.debug({ report }, "doctor: complete");
  if (!report.ok) process.exit(1);
}
