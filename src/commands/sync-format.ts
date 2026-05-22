/**
 * TTY-only formatting helpers for `sync` — kept separate from sync.ts so the
 * orchestration file stays under the project's line-count gate.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { bold, cyan, dim, green, red, yellow } from "../lib/colors.js";
import type { DryRunResult, SyncOptions } from "./sync.js";
import { SyncConsentRequiredError, type SyncRundown } from "./sync-consent.js";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function formatTableList(r: DryRunResult): string {
  if (r.tables.length === 0) {
    return `${yellow("!")} No tables matched the current filter.`;
  }
  const totalBytes = r.tables.reduce((s, t) => s + t.compressedBytes, 0);
  const rows = r.tables.map((t) => {
    const tail = t.truncatedSample
      ? dim(` (sampled first ${t.sampledRows})`)
      : dim(` (${t.sampledRows} doc${t.sampledRows === 1 ? "" : "s"})`);
    return `  ${cyan(t.path)} ${dim(`— ${t.columns} col, ${formatBytes(t.compressedBytes)}`)}${tail}`;
  });
  const header = `${bold("Tables to sync")} ${dim(`(${r.tables.length}, ~${formatBytes(totalBytes)} compressed)`)}`;
  return [header, ...rows].join("\n");
}

function formatPreflight(r: DryRunResult): string {
  if (r.preflight.snowflakeOk) {
    const roleSuffix = r.role !== null ? ` as ${dim(`role=${r.role}`)}` : "";
    return `${green("✓")} Snowflake reachable${roleSuffix}`;
  }
  return `${dim("✗")} Snowflake preflight failed: ${r.preflight.snowflakeError ?? "unknown error"}`;
}

export function formatDryRun(r: DryRunResult): string {
  return [
    "",
    `${bold("Plan")} ${dim(`(mode: ${r.mode})`)}`,
    `  ${dim("source:")} ${r.source}`,
    `  ${dim("target:")} ${cyan(r.target)}`,
    "",
    formatTableList(r),
    "",
    formatPreflight(r),
    "",
    `${bold("This was a dry run.")} ${dim("No DDL, PUT, or COPY INTO ran.")}`,
    `Re-run without ${cyan("--dry-run")} to execute.`,
    "",
  ].join("\n");
}

// Table-driven flag collector so printSyncBanner stays under the complexity
// gate — adding a new flag is a one-line entry here.
const FLAG_LABELS: Array<{
  key: keyof SyncOptions;
  format: (v: NonNullable<SyncOptions[keyof SyncOptions]>) => string;
}> = [
  {
    key: "tables",
    format: (v) => `tables=${(v as string[]).join(",")}`,
  },
  { key: "limit", format: (v) => `limit=${String(v)}` },
  { key: "fromZip", format: (v) => `from-zip=${String(v)}` },
  { key: "prod", format: () => "prod" },
  { key: "deploymentName", format: (v) => `deployment-name=${String(v)}` },
  { key: "sample", format: (v) => `sample=${String(v)}` },
  { key: "dryRun", format: () => "dry-run" },
];

function collectFlags(opts: SyncOptions): string[] {
  const out: string[] = [];
  for (const entry of FLAG_LABELS) {
    const value = opts[entry.key];
    if (value === undefined || value === false) continue;
    out.push(entry.format(value));
  }
  return out;
}

function formatRundownTables(tables: string[]): string {
  if (tables.length <= 8) return tables.join(", ");
  const head = tables.slice(0, 8).join(", ");
  return `${head}, … (${tables.length - 8} more)`;
}

/**
 * Pure formatter for the destructive-operation consent banner. Returned as a
 * string (rather than written to stdout) so tests can snapshot the wording
 * without involving a TTY.
 */
export function formatConsentBanner(r: SyncRundown): string {
  return [
    "",
    `${yellow("⚠")}  ${bold("Full-refresh sync — review before continuing")}`,
    "",
    `${bold("Convex side")} ${dim("(read-only)")}:`,
    `  Pulls a full export from your Convex deployment via ${cyan("`convex export`")}.`,
    `  No data on Convex is modified, deleted, or written to. Your app is safe.`,
    "",
    `${bold("Snowflake side")} ${red("(destructive)")}:`,
    `  ${dim("source:")}  ${r.source}`,
    `  ${dim("target:")}  ${cyan(`${r.database}.${r.schema}`)}`,
    `  ${dim("tables:")}  ${r.tables.length} to replace`,
    `              ${dim(formatRundownTables(r.tables))}`,
    "",
    `  ${bold("What sync does, for each table:")}`,
    `    1. ${dim("CREATE OR REPLACE TABLE <t>__csc_staging LIKE <t>")}`,
    `    2. ${dim("PUT documents.jsonl to @~/csc_stage/<t>/")}`,
    `    3. ${dim("COPY INTO <t>__csc_staging")}`,
    `    4. ${dim("ALTER TABLE <t> SWAP WITH <t>__csc_staging")}`,
    `    5. ${dim("DROP TABLE <t>__csc_staging  ← previous Snowflake data is here")}`,
    "",
    `  ${red("Step 5 discards the previous contents of each listed Snowflake table.")}`,
    `  ${red("This tool cannot restore them.")}`,
    "",
    `Type ${bold("'yes'")} to proceed, anything else to abort.`,
    "",
  ].join("\n");
}

/**
 * Default consent callback wired up by the CLI. Prints the banner, reads one
 * line from stdin, accepts only literal "yes" (case-insensitive, trimmed).
 * Refuses outright when stdin is not a TTY — automation must pass --yes.
 */
export async function defaultConsentConfirm(
  rundown: SyncRundown,
): Promise<boolean> {
  if (stdin.isTTY !== true) {
    throw new SyncConsentRequiredError(
      "sync: refusing to run without confirmation when stdin is not a TTY. " +
        "Pass --yes to acknowledge this is a destructive full-refresh that " +
        "replaces target Snowflake table contents non-recoverably. " +
        "(Convex is not modified — this tool only reads from it.)",
    );
  }
  stdout.write(formatConsentBanner(rundown));
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question("> ");
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

export function printSyncBanner(opts: SyncOptions): void {
  if (process.stdout.isTTY !== true) return;
  const flags = collectFlags(opts);
  const banner = [
    `${bold("convex-snowflake-connector sync")} ${dim(flags.length > 0 ? `[${flags.join(", ")}]` : "(defaults)")}`,
    `${dim("  flags: --dry-run | -t/--tables <name…> | -n/--limit <n> | --from-zip <path> | --prod | --deployment-name <name> | -y/--yes")}`,
    `${dim("  tip:")} ${cyan("convex-snowflake-connector sync --dry-run")} ${dim("previews the plan without writing to Snowflake")}`,
    "",
  ].join("\n");
  process.stdout.write(banner);
}
