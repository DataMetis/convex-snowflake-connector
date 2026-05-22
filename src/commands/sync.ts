import { loadConfig, type Config } from "../lib/config.js";
import { generateAllDDL, type DDLTarget } from "../lib/ddl.js";
import { extract } from "./extract.js";
import { inferTableSchema } from "../lib/infer.js";
import type { TableSchema } from "../lib/ir.js";
import { loadAll, type LoadTableResult } from "../lib/load.js";
import { logger } from "../lib/logger.js";
import {
  openSnapshot,
  type Snapshot,
  type TableEntry,
} from "../lib/snapshot.js";
import { probeSnowflake } from "../lib/probe/snowflake.js";
import {
  authFromConfig,
  openSession,
  type SnowflakeSession,
} from "../lib/snowflake.js";
import {
  defaultConsentConfirm,
  formatDryRun,
  printSyncBanner,
} from "./sync-format.js";
import {
  ensureConsent,
  SyncCancelledError,
  type SyncRundown,
} from "./sync-consent.js";

export interface SyncOptions {
  config: string;
  /** When set, only sync these table paths. */
  tables?: string[];
  /** Forwarded to `extract`. */
  prod?: boolean;
  deploymentName?: string;
  /** Reuse an existing export ZIP instead of running `convex export`. */
  fromZip?: string;
  /** Sample size for schema inference. Default 1000. */
  sample?: number;
  /** Cap the number of tables synced (after name filter is applied). */
  limit?: number;
  /** When true, run preflight and report a plan without mutating Snowflake. */
  dryRun?: boolean;
  /**
   * Acknowledge that sync replaces Snowflake table contents non-recoverably.
   * Required when no `confirm` callback is supplied. Cron / CI should set
   * this to `true`.
   */
  yes?: boolean;
  /**
   * Interactive consent callback. Receives a rundown of what the run will
   * touch; resolve to `true` to proceed, `false` to abort. The CLI passes a
   * readline-based prompt here; programmatic callers can substitute their own.
   * Ignored when `yes` is true.
   */
  confirm?: (rundown: SyncRundown) => Promise<boolean>;
}

export interface SyncResult {
  mode: Config["sync"]["mode"];
  source: string;
  tables: LoadTableResult[];
}

export interface DryRunTable {
  path: string;
  columns: number;
  sampledRows: number;
  truncatedSample: boolean;
  compressedBytes: number;
}

export interface DryRunResult {
  dryRun: true;
  mode: Config["sync"]["mode"];
  source: string;
  target: string;
  /** What `CURRENT_ROLE()` reports after the Snowflake session opens. */
  role: string | null;
  tables: DryRunTable[];
  preflight: {
    snowflakeOk: boolean;
    snowflakeError?: string;
  };
}

interface InferredTable {
  entry: TableEntry;
  schema: TableSchema;
}

function selectTables(
  all: TableEntry[],
  filter: string[] | undefined,
  limit: number | undefined,
): TableEntry[] {
  const userOnly = all.filter((t) => !t.system);
  let picked = userOnly;
  if (filter && filter.length > 0) {
    // Match by short `name` (last segment of path) — that's what users see
    // in dry-run output and what they type in `--tables users orders`.
    const wanted = new Set(filter);
    picked = userOnly.filter((t) => wanted.has(t.name));
  }
  if (limit !== undefined && limit > 0 && picked.length > limit) {
    picked = picked.slice(0, limit);
  }
  return picked;
}

async function resolveZipPath(opts: SyncOptions): Promise<string> {
  if (opts.fromZip !== undefined) return opts.fromZip;
  const result = await extract({
    config: opts.config,
    ...(opts.prod !== undefined ? { prod: opts.prod } : {}),
    ...(opts.deploymentName !== undefined
      ? { deploymentName: opts.deploymentName }
      : {}),
  });
  return result.zipPath;
}

async function inferAll(
  snap: Snapshot,
  entries: TableEntry[],
  sampleSize: number,
): Promise<InferredTable[]> {
  const out: InferredTable[] = [];
  for (const entry of entries) {
    const schema = await inferTableSchema(entry, snap.readDocuments(entry), {
      sampleSize,
    });
    logger.info(
      {
        table: schema.path,
        columns: schema.columns.length,
        sampled: schema.sampled,
      },
      "sync: inferred schema",
    );
    out.push({ entry, schema });
  }
  return out;
}

async function ensureTables(
  session: SnowflakeSession,
  inferred: InferredTable[],
  target: DDLTarget,
): Promise<void> {
  const { ddl, skipped } = generateAllDDL(
    inferred.map((i) => i.schema),
    target,
  );
  if (skipped.length > 0) {
    logger.warn({ skipped }, "sync: skipping tables with no columns");
  }
  if (ddl.length === 0) return;
  for (const stmt of ddl.split(/;\s*\n+/).filter((s) => s.trim() !== "")) {
    await session.exec(stmt);
  }
  logger.info(
    { tables: inferred.length - skipped.length },
    "sync: ensured tables",
  );
}

async function runMutating(args: {
  cfg: Config;
  snap: Snapshot;
  zipPath: string;
  tablesFilter: string[] | undefined;
  opts: SyncOptions;
}): Promise<SyncResult> {
  const { cfg, snap, zipPath, tablesFilter, opts } = args;
  const entries = selectTables(snap.tables, tablesFilter, opts.limit);
  if (entries.length === 0) {
    logger.warn(
      { zipPath, requested: tablesFilter },
      "sync: no tables matched filter",
    );
    return { mode: cfg.sync.mode, source: zipPath, tables: [] };
  }

  await ensureConsent(opts, {
    source: zipPath,
    database: cfg.snowflake.database,
    schema: cfg.snowflake.schema,
    tables: entries.map((e) => e.path),
  });

  const session = await openSession(cfg.snowflake);
  try {
    return await runSync({ cfg, session, snap, zipPath, entries, opts });
  } finally {
    await session.close();
  }
}

export async function sync(
  opts: SyncOptions,
): Promise<SyncResult | DryRunResult> {
  const cfg = loadConfig(opts.config);
  const tablesFilter =
    opts.tables ?? (cfg.sync.tables === "*" ? undefined : cfg.sync.tables);

  logger.info(
    {
      convexUrl: cfg.convex.url,
      mode: cfg.sync.mode,
      tables: tablesFilter ?? "*",
      dryRun: opts.dryRun === true,
    },
    "sync: starting",
  );

  const zipPath = await resolveZipPath(opts);
  const snap = await openSnapshot(zipPath);
  try {
    if (opts.dryRun === true) {
      return await runDryRun({ cfg, snap, zipPath, tablesFilter, opts });
    }
    return await runMutating({ cfg, snap, zipPath, tablesFilter, opts });
  } finally {
    await snap.close();
  }
}

interface DryRunCtx {
  cfg: Config;
  snap: Snapshot;
  zipPath: string;
  tablesFilter: string[] | undefined;
  opts: SyncOptions;
}

async function runDryRun(ctx: DryRunCtx): Promise<DryRunResult> {
  const { cfg, snap, zipPath, tablesFilter, opts } = ctx;
  const mode = cfg.sync.mode;
  const entries = selectTables(snap.tables, tablesFilter, opts.limit);
  const inferred = await inferAll(snap, entries, opts.sample ?? 1000);

  const tables: DryRunTable[] = inferred.map((i) => ({
    path: i.schema.path,
    columns: i.schema.columns.length,
    sampledRows: i.schema.sampled,
    truncatedSample: i.schema.truncated,
    compressedBytes: i.entry.compressedSize,
  }));

  // Preflight Snowflake via the same probe `doctor` uses — it validates
  // database/schema/warehouse/role are actually active on the session, so a
  // typo or missing GRANT surfaces here, not on the first CREATE TABLE.
  const sf = cfg.snowflake;
  const probe = await probeSnowflake({
    account: sf.account,
    user: sf.user,
    auth: authFromConfig(sf),
    warehouse: sf.warehouse,
    database: sf.database,
    schema: sf.schema,
    ...(sf.role !== undefined ? { role: sf.role } : {}),
  });

  return {
    dryRun: true,
    mode,
    source: zipPath,
    target: `${cfg.snowflake.database}.${cfg.snowflake.schema}`,
    role: probe.session?.role ?? null,
    tables,
    preflight: {
      snowflakeOk: probe.ok,
      ...(probe.error !== undefined ? { snowflakeError: probe.error } : {}),
    },
  };
}

interface RunSyncCtx {
  cfg: Config;
  session: SnowflakeSession;
  snap: Snapshot;
  zipPath: string;
  entries: TableEntry[];
  opts: SyncOptions;
}

async function runSync(ctx: RunSyncCtx): Promise<SyncResult> {
  const { cfg, session, snap, zipPath, entries, opts } = ctx;
  const mode = cfg.sync.mode;
  const inferred = await inferAll(snap, entries, opts.sample ?? 1000);
  const target: DDLTarget = {
    database: cfg.snowflake.database,
    schema: cfg.snowflake.schema,
  };
  await ensureTables(session, inferred, target);
  const tables = await loadAll({
    session,
    snapshot: snap,
    tables: inferred.filter((i) => i.schema.columns.length > 0),
    target,
  });
  return { mode, source: zipPath, tables };
}

export async function syncCommand(opts: SyncOptions): Promise<void> {
  printSyncBanner(opts);
  const optsWithConfirm: SyncOptions = {
    ...opts,
    confirm: opts.confirm ?? defaultConsentConfirm,
  };
  try {
    const result = await sync(optsWithConfirm);

    if ("dryRun" in result && result.dryRun === true) {
      if (process.stdout.isTTY === true) {
        process.stdout.write(formatDryRun(result));
      } else {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      }
      if (!result.preflight.snowflakeOk) process.exit(1);
      return;
    }

    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err) {
    if (err instanceof SyncCancelledError) {
      process.stderr.write("sync: aborted — no changes made.\n");
      process.exit(2);
    }
    throw err;
  }
}
