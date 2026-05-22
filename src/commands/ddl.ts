import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { discover } from "./discover.js";
import { bold, cyan, dim, green } from "../lib/colors.js";
import { loadConfig } from "../lib/config.js";
import { generateAllDDL, type DDLTarget } from "../lib/ddl.js";
import type { DiscoveryResult } from "../lib/ir.js";
import { logger } from "../lib/logger.js";

export interface DDLOptions {
  /** Config file (provides Snowflake database/schema). */
  config: string;
  /** Path to convex export ZIP — required unless --from is given. */
  export?: string;
  /** Path to a pre-discovered schema.json (skips rediscovery). */
  from?: string;
  /** Write SQL to this file (default: stdout). */
  output?: string;
  /** Sample size for discovery (ignored when --from is set). */
  sample?: number;
  /** Limit to these table paths. */
  tables?: string[];
}

export async function ddl(opts: DDLOptions): Promise<string> {
  const cfg = loadConfig(opts.config);
  const target: DDLTarget = {
    database: cfg.snowflake.database,
    schema: cfg.snowflake.schema,
  };

  let discovery: DiscoveryResult;
  if (opts.from) {
    discovery = JSON.parse(readFileSync(opts.from, "utf8")) as DiscoveryResult;
  } else {
    // No --export and no --from → let discover auto-run `convex export`.
    discovery = await discover({
      ...(opts.export !== undefined ? { export: opts.export } : {}),
      config: opts.config,
      userOnly: true,
      ...(opts.sample !== undefined ? { sample: opts.sample } : {}),
      ...(opts.tables !== undefined ? { tables: opts.tables } : {}),
    });
  }

  const tables = opts.tables
    ? discovery.tables.filter((t) => opts.tables!.includes(t.path))
    : discovery.tables;
  const { ddl: sql, skipped } = generateAllDDL(tables, target);

  logger.info(
    {
      target: `${target.database}.${target.schema}`,
      tables: tables.length - skipped.length,
      skippedEmpty: skipped,
    },
    "ddl: generated",
  );
  return sql;
}

function countTables(sql: string): number {
  return (sql.match(/CREATE OR REPLACE TABLE/gi) ?? []).length;
}

function formatSummary(sql: string, outputPath: string): string {
  const count = countTables(sql);
  return (
    `\n${green("✓")} Generated DDL for ${bold(String(count))} table(s).\n` +
    `Wrote SQL to ${cyan(outputPath)}\n\n` +
    `${bold("Next:")}\n` +
    `  ${cyan("convex-snowflake-connector sync")}\n` +
    `    ${dim("apply the DDL and load data into Snowflake")}\n`
  );
}

export async function ddlCommand(opts: DDLOptions): Promise<void> {
  const sql = await ddl(opts);

  if (opts.output !== undefined) {
    writeFileSync(opts.output, sql);
    logger.info({ output: opts.output }, "ddl: wrote SQL");
    process.stdout.write(formatSummary(sql, resolve(opts.output)));
    return;
  }

  // Piped / redirected: emit raw SQL so it composes with snowsql, jq, etc.
  if (process.stdout.isTTY !== true) {
    process.stdout.write(sql);
    return;
  }

  const defaultPath = resolve("schema.sql");
  writeFileSync(defaultPath, sql);
  logger.info({ output: defaultPath }, "ddl: wrote SQL");
  process.stdout.write(formatSummary(sql, defaultPath));
}
