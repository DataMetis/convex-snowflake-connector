#!/usr/bin/env node
import { Command } from "commander";
import { ddlCommand } from "./commands/ddl.js";
import { discoverCommand } from "./commands/discover.js";
import { doctorCommand } from "./commands/doctor.js";
import { extractCommand } from "./commands/extract.js";
import { initCommand } from "./commands/init.js";
import { syncCommand } from "./commands/sync.js";
import { logger } from "./lib/logger.js";

const program = new Command();

program
  .name("convex-snowflake-connector")
  .description("Sync any Convex deployment into Snowflake")
  .version("0.1.0");

program
  .command("init")
  .description(
    "Interactive setup: prompts for Convex + Snowflake credentials, validates both, and writes convex-snowflake.config.yaml + .env.local",
  )
  .option(
    "-c, --config <path>",
    "where to write the config (default: ./convex-snowflake.config.yaml)",
  )
  .option("-e, --env <path>", "where to append secrets (default: ./.env.local)")
  .option("--force", "overwrite an existing config without prompting")
  .action(async (opts: { config?: string; env?: string; force?: boolean }) => {
    await initCommand({
      ...(opts.config !== undefined ? { configPath: opts.config } : {}),
      ...(opts.env !== undefined ? { envPath: opts.env } : {}),
      ...(opts.force !== undefined ? { force: opts.force } : {}),
    });
  });

program
  .command("doctor")
  .description(
    "Re-run init's connectivity checks against existing config; exits non-zero on any failure",
  )
  .option(
    "-c, --config <path>",
    "path to convex-snowflake.config.yaml",
    "convex-snowflake.config.yaml",
  )
  .action(async (opts: { config: string }) => {
    await doctorCommand({ config: opts.config });
  });

program
  .command("sync")
  .description("Sync Convex tables into Snowflake")
  .option(
    "-c, --config <path>",
    "path to convex-snowflake.config.yaml",
    "convex-snowflake.config.yaml",
  )
  .option(
    "-t, --tables <names...>",
    "only sync these tables, matched by name (space-separated)",
  )
  .option(
    "-n, --limit <n>",
    "cap the number of tables synced (after --tables filter)",
    (v: string) => parseInt(v, 10),
  )
  .option(
    "--from-zip <path>",
    "reuse an existing export ZIP (skip `convex export`)",
  )
  .option("--prod", "target the production Convex deployment")
  .option("--deployment-name <name>", "target a named Convex deployment")
  .option(
    "-s, --sample <n>",
    "sample size for schema inference (default 1000)",
    (v: string) => parseInt(v, 10),
  )
  .option(
    "--dry-run",
    "preview the plan (tables, volume, Snowflake reachability) without mutating Snowflake",
  )
  .option(
    "-y, --yes",
    "skip the interactive confirmation prompt (required for non-TTY contexts like cron/CI)",
  )
  .action(
    async (opts: {
      config: string;
      tables?: string[];
      limit?: number;
      fromZip?: string;
      prod?: boolean;
      deploymentName?: string;
      sample?: number;
      dryRun?: boolean;
      yes?: boolean;
    }) => {
      await syncCommand({
        config: opts.config,
        ...(opts.tables !== undefined ? { tables: opts.tables } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.fromZip !== undefined ? { fromZip: opts.fromZip } : {}),
        ...(opts.prod !== undefined ? { prod: opts.prod } : {}),
        ...(opts.deploymentName !== undefined
          ? { deploymentName: opts.deploymentName }
          : {}),
        ...(opts.sample !== undefined ? { sample: opts.sample } : {}),
        ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
        ...(opts.yes !== undefined ? { yes: opts.yes } : {}),
      });
    },
  );

program
  .command("discover")
  .description(
    "Infer table schemas from a `convex export` ZIP and emit JSON IR. With no --export, runs `convex export` automatically.",
  )
  .option(
    "-e, --export <path>",
    "path to an existing convex export ZIP (skips running `convex export`)",
  )
  .option(
    "-c, --config <path>",
    "path to convex-snowflake.config.yaml (used when auto-extracting)",
    "convex-snowflake.config.yaml",
  )
  .option("--prod", "auto-extract from the production deployment")
  .option("--deployment-name <name>", "auto-extract from a named deployment")
  .option("-o, --output <path>", "write JSON to this file (default: stdout)")
  .option(
    "-s, --sample <n>",
    "max documents to sample per table (default 1000)",
    (v: string) => parseInt(v, 10),
  )
  .option("-t, --tables <names...>", "limit to these table paths")
  .option(
    "--include-system",
    "include system tables (_-prefixed and _components/*)",
  )
  .action(
    async (opts: {
      export?: string;
      config: string;
      prod?: boolean;
      deploymentName?: string;
      output?: string;
      sample?: number;
      tables?: string[];
      includeSystem?: boolean;
    }) => {
      await discoverCommand({
        ...(opts.export !== undefined ? { export: opts.export } : {}),
        config: opts.config,
        ...(opts.prod !== undefined ? { prod: opts.prod } : {}),
        ...(opts.deploymentName !== undefined
          ? { deploymentName: opts.deploymentName }
          : {}),
        ...(opts.output !== undefined ? { output: opts.output } : {}),
        ...(opts.sample !== undefined ? { sample: opts.sample } : {}),
        ...(opts.tables !== undefined ? { tables: opts.tables } : {}),
        userOnly: !opts.includeSystem,
      });
    },
  );

program
  .command("ddl")
  .description(
    "Generate Snowflake CREATE OR REPLACE TABLE DDL from a discovery result",
  )
  .option(
    "-c, --config <path>",
    "path to convex-snowflake.config.yaml",
    "convex-snowflake.config.yaml",
  )
  .option("-e, --export <path>", "path to convex export ZIP (runs discover)")
  .option(
    "--from <path>",
    "pre-discovered schema.json from `discover --output`",
  )
  .option("-o, --output <path>", "write SQL to this file (default: stdout)")
  .option(
    "-s, --sample <n>",
    "max documents to sample per table when discovering",
    (v: string) => parseInt(v, 10),
  )
  .option("-t, --tables <names...>", "limit to these table paths")
  .action(
    async (opts: {
      config: string;
      export?: string;
      from?: string;
      output?: string;
      sample?: number;
      tables?: string[];
    }) => {
      await ddlCommand({
        config: opts.config,
        ...(opts.export !== undefined ? { export: opts.export } : {}),
        ...(opts.from !== undefined ? { from: opts.from } : {}),
        ...(opts.output !== undefined ? { output: opts.output } : {}),
        ...(opts.sample !== undefined ? { sample: opts.sample } : {}),
        ...(opts.tables !== undefined ? { tables: opts.tables } : {}),
      });
    },
  );

program
  .command("extract")
  .description(
    "Run `convex export` to produce a snapshot ZIP (auth via env: CONVEX_DEPLOY_KEY / local creds)",
  )
  .option(
    "-c, --config <path>",
    "path to convex-snowflake.config.yaml",
    "convex-snowflake.config.yaml",
  )
  .option("-o, --output <path>", "write ZIP here (default: temp file)")
  .option("--prod", "target the production deployment (--prod)")
  .option(
    "--deployment-name <name>",
    "target a named deployment (--deployment-name)",
  )
  .action(
    async (opts: {
      config: string;
      output?: string;
      prod?: boolean;
      deploymentName?: string;
    }) => {
      await extractCommand({
        config: opts.config,
        ...(opts.output !== undefined ? { output: opts.output } : {}),
        ...(opts.prod !== undefined ? { prod: opts.prod } : {}),
        ...(opts.deploymentName !== undefined
          ? { deploymentName: opts.deploymentName }
          : {}),
      });
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  logger.error({ err }, "command failed");
  process.exit(1);
});
