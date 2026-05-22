import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bold, cyan, dim, green } from "../lib/colors.js";
import { inferTableSchema } from "../lib/infer.js";
import type { DiscoveryResult, TableSchema } from "../lib/ir.js";
import { logger } from "../lib/logger.js";
import { openSnapshot } from "../lib/snapshot.js";
import { extract } from "./extract.js";

export interface DiscoverOptions {
  /** Path to a `convex export` ZIP. When omitted, auto-runs `convex export`. */
  export?: string;
  /** Path to the config YAML. Required when `export` is not provided. */
  config?: string;
  /** Forwarded to extract when auto-extracting. */
  prod?: boolean;
  /** Forwarded to extract when auto-extracting. */
  deploymentName?: string;
  /** Optional file path to write the JSON result to. Defaults to stdout. */
  output?: string;
  /** Sample size per table (default 1000). */
  sample?: number;
  /** When true, skip system tables and _components/* (default true). */
  userOnly?: boolean;
  /** Only include these tables. Filters by `path`. */
  tables?: string[];
}

async function resolveExportPath(opts: DiscoverOptions): Promise<string> {
  if (opts.export !== undefined) return opts.export;
  if (opts.config === undefined) {
    throw new Error(
      "discover: pass --export <zip> or --config <path> so the wizard can run `convex export` for you",
    );
  }
  process.stdout.write(
    dim("(no --export given; running `convex export` to a temp file…)\n"),
  );
  const result = await extract({
    config: opts.config,
    ...(opts.prod !== undefined ? { prod: opts.prod } : {}),
    ...(opts.deploymentName !== undefined
      ? { deploymentName: opts.deploymentName }
      : {}),
  });
  return result.zipPath;
}

export async function discover(
  opts: DiscoverOptions,
): Promise<DiscoveryResult> {
  const exportPath = await resolveExportPath(opts);
  const snap = await openSnapshot(exportPath);
  const userOnly = opts.userOnly ?? true;
  const wanted = opts.tables ? new Set(opts.tables) : null;

  const tables = snap.tables.filter((t) => {
    if (userOnly && t.system) return false;
    if (wanted && !wanted.has(t.path)) return false;
    return true;
  });

  logger.info(
    { source: exportPath, count: tables.length, userOnly },
    "discover: starting",
  );

  const inferred: TableSchema[] = [];
  try {
    for (const t of tables) {
      const schema = await inferTableSchema(t, snap.readDocuments(t), {
        sampleSize: opts.sample ?? 1000,
      });
      logger.info(
        {
          table: schema.path,
          columns: schema.columns.length,
          sampled: schema.sampled,
          truncated: schema.truncated,
        },
        "discover: inferred table",
      );
      inferred.push(schema);
    }
  } finally {
    await snap.close();
  }

  return { source: exportPath, tables: inferred };
}

function formatSummary(result: DiscoveryResult, outputPath: string): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `${green("✓")} Inferred ${bold(String(result.tables.length))} table(s):`,
  );
  for (const t of result.tables) {
    const truncated = t.truncated ? dim(" (truncated)") : "";
    lines.push(
      `  ${cyan(t.path)} ${dim(`— ${t.columns.length} col, ${t.sampled} doc${t.sampled === 1 ? "" : "s"} sampled${truncated}`)}`,
    );
  }
  lines.push("");
  lines.push(`Wrote full schema IR to ${cyan(outputPath)}`);
  lines.push("");
  lines.push(`${bold("Next:")}`);
  lines.push(
    `  ${cyan(`convex-snowflake-connector ddl --from ${outputPath}`)}`,
  );
  lines.push(`    ${dim("generate CREATE TABLE statements from this schema")}`);
  lines.push("");
  return lines.join("\n");
}

export async function discoverCommand(opts: DiscoverOptions): Promise<void> {
  const result = await discover(opts);
  const json = JSON.stringify(result, null, 2);

  // Explicit --output: write there, also print a summary.
  if (opts.output !== undefined) {
    writeFileSync(opts.output, json + "\n");
    logger.info({ output: opts.output }, "discover: wrote schema");
    process.stdout.write(formatSummary(result, resolve(opts.output)));
    return;
  }

  // Piped / redirected: keep emitting JSON so `discover | ddl --from -` etc.
  // composes. Only humans-on-a-TTY get the summary + default file.
  if (process.stdout.isTTY !== true) {
    process.stdout.write(json + "\n");
    return;
  }

  const defaultPath = resolve("schema.json");
  writeFileSync(defaultPath, json + "\n");
  logger.info({ output: defaultPath }, "discover: wrote schema");
  process.stdout.write(formatSummary(result, defaultPath));
}
