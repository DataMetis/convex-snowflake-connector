/**
 * v1 load path: full-refresh into Snowflake.
 *
 * For each table we:
 *   1. stream documents.jsonl from the Convex export into a local temp file
 *      (PUT needs a real file path);
 *   2. PUT it to the user's stage at @~/<stagePrefix>/<slug>/;
 *   3. CREATE OR REPLACE a staging table with the same shape as the target;
 *   4. COPY INTO the staging table with a typed SELECT projection over $1;
 *   5. ALTER TABLE … SWAP WITH the target (atomic, metadata-only) and drop
 *      the now-old staging table.
 *
 * If any step before the SWAP fails, the original target is untouched — no
 * empty-table window. The projection is the load-time counterpart to ddl.ts.
 */

import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DDLTarget } from "./ddl.js";
import { qualifiedName, quoteIdent } from "./ddl.js";
import type { ColumnSchema, ConvexType, TableSchema } from "./ir.js";
import { logger } from "./logger.js";
import type { Snapshot, TableEntry } from "./snapshot.js";
import type { SnowflakeSession } from "./snowflake.js";

export interface LoadTableOptions {
  session: SnowflakeSession;
  snapshot: Snapshot;
  entry: TableEntry;
  schema: TableSchema;
  target: DDLTarget;
  /** User-stage subdirectory. Defaults to "csc_stage". */
  stagePrefix?: string;
}

export interface LoadTableResult {
  table: string;
  rowsLoaded: number;
  bytesStaged: number;
}

const DEFAULT_STAGE_PREFIX = "csc_stage";

/** Single-quoted JSON-path key for `$1[...]`. Escapes `\` and `'`. */
function jsonPathKey(name: string): string {
  return `'${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Filesystem/stage-safe slug derived from a table path. */
export function tableSlug(path: string): string {
  const s = path.replace(/[^A-Za-z0-9_]+/g, "_");
  return s.length > 0 ? s : "table";
}

/** SELECT-expression for one column, sitting in front of `FROM @stage`. */
export function projectionExpr(col: ColumnSchema): string {
  const path = `$1[${jsonPathKey(col.name)}]`;
  if (col.name === "_id") return `${path}::VARCHAR`;
  if (col.name === "_creationTime") {
    // Convex export stores _creationTime as a number of milliseconds.
    return `TO_TIMESTAMP_NTZ(${path}::NUMBER, 3)`;
  }
  return scalarCast(path, col.type);
}

function scalarCast(path: string, type: ConvexType): string {
  switch (type.kind) {
    case "string":
      return `${path}::VARCHAR`;
    case "number":
      return `${path}::NUMBER`;
    case "boolean":
      return `${path}::BOOLEAN`;
    case "bytes":
      return `${path}::BINARY`;
    // null / any / array / object / union all map to VARIANT in DDL — no cast.
    case "null":
    case "any":
    case "array":
    case "object":
    case "union":
      return path;
  }
}

const SYSTEM_FIELD_ORDER: Record<string, number> = {
  _id: 0,
  _creationTime: 1,
};

function orderColumns(columns: ColumnSchema[]): ColumnSchema[] {
  return [...columns].sort((a, b) => {
    const sa = SYSTEM_FIELD_ORDER[a.name];
    const sb = SYSTEM_FIELD_ORDER[b.name];
    if (sa !== undefined && sb !== undefined) return sa - sb;
    if (sa !== undefined) return -1;
    if (sb !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });
}

export interface CopyStatement {
  columnList: string;
  selectList: string;
}

/**
 * Build the column-list and SELECT-list halves of the COPY INTO statement.
 * Returned as pieces (not a full statement) so tests can assert each without
 * matching whitespace, and so the stage path can be filled in at call time.
 */
export function buildCopyProjection(schema: TableSchema): CopyStatement {
  const cols = orderColumns(schema.columns);
  const columnList = cols.map((c) => quoteIdent(c.name)).join(", ");
  const selectList = cols.map(projectionExpr).join(", ");
  return { columnList, selectList };
}

async function writeDocumentsTo(
  snapshot: Snapshot,
  entry: TableEntry,
  outPath: string,
): Promise<{ rows: number; bytes: number }> {
  const out = createWriteStream(outPath, { encoding: "utf8" });
  let rows = 0;
  let bytes = 0;
  try {
    for await (const doc of snapshot.readDocuments(entry)) {
      const line = JSON.stringify(doc) + "\n";
      bytes += Buffer.byteLength(line, "utf8");
      if (!out.write(line)) {
        await new Promise<void>((resolve) =>
          out.once("drain", () => resolve()),
        );
      }
      rows++;
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
  return { rows, bytes };
}

function pickNumber(
  row: Record<string, unknown> | undefined,
  key: string,
): number {
  if (!row) return 0;
  const v = row[key] ?? row[key.toUpperCase()] ?? row[key.toLowerCase()];
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Build the full COPY INTO statement for a given staged file. */
export function buildCopyStatement(
  fq: string,
  stagePath: string,
  schema: TableSchema,
): string {
  const { columnList, selectList } = buildCopyProjection(schema);
  return (
    `COPY INTO ${fq} (${columnList})\n` +
    `  FROM (SELECT ${selectList} FROM ${stagePath}/)\n` +
    `  FILE_FORMAT = (TYPE = JSON STRIP_OUTER_ARRAY = FALSE)\n` +
    `  ON_ERROR = ABORT_STATEMENT\n` +
    `  PURGE = TRUE`
  );
}

async function copyFromStage(
  session: SnowflakeSession,
  fq: string,
  stagePath: string,
  schema: TableSchema,
): Promise<number> {
  const rows = await session.exec(buildCopyStatement(fq, stagePath, schema));
  return rows.reduce(
    (acc, r) => acc + pickNumber(r as Record<string, unknown>, "rows_loaded"),
    0,
  );
}

interface SwapLoadArgs {
  session: SnowflakeSession;
  fq: string;
  stagingFq: string;
  stagePath: string;
  jsonlPath: string;
  schema: TableSchema;
  rows: number;
}

async function loadIntoStagingAndSwap(args: SwapLoadArgs): Promise<number> {
  const { session, fq, stagingFq, stagePath, jsonlPath, schema, rows } = args;
  // CREATE OR REPLACE doubles as cleanup for any staging table left behind
  // by a prior failed run.
  await session.exec(`CREATE OR REPLACE TABLE ${stagingFq} LIKE ${fq}`);
  try {
    let rowsLoaded = 0;
    if (rows > 0) {
      await session.exec(`RM ${stagePath}`).catch(() => undefined);
      await session.exec(
        `PUT 'file://${jsonlPath}' ${stagePath}/ AUTO_COMPRESS=TRUE OVERWRITE=TRUE PARALLEL=4`,
      );
      rowsLoaded = await copyFromStage(session, stagingFq, stagePath, schema);
    }
    // SWAP is atomic and metadata-only. Until this runs, the target table
    // still holds the previous load's data.
    await session.exec(`ALTER TABLE ${fq} SWAP WITH ${stagingFq}`);
    return rowsLoaded;
  } catch (err) {
    await session
      .exec(`DROP TABLE IF EXISTS ${stagingFq}`)
      .catch(() => undefined);
    throw err;
  }
}

export async function loadTable(
  opts: LoadTableOptions,
): Promise<LoadTableResult> {
  const { session, snapshot, entry, schema, target } = opts;
  const slug = tableSlug(entry.path);
  const stagePath = `@~/${opts.stagePrefix ?? DEFAULT_STAGE_PREFIX}/${slug}`;
  const fq = qualifiedName(target, schema.name);
  const stagingFq = qualifiedName(target, `${schema.name}__csc_staging`);

  const tmp = await mkdtemp(join(tmpdir(), "csc-load-"));
  const jsonlPath = join(tmp, `${slug}.jsonl`);

  try {
    const { rows, bytes } = await writeDocumentsTo(snapshot, entry, jsonlPath);
    logger.info(
      { table: entry.path, rows, bytes },
      "load: wrote documents.jsonl",
    );

    const rowsLoaded = await loadIntoStagingAndSwap({
      session,
      fq,
      stagingFq,
      stagePath,
      jsonlPath,
      schema,
      rows,
    });

    // Post-swap, stagingFq holds the *old* data — drop it best-effort.
    await session
      .exec(`DROP TABLE IF EXISTS ${stagingFq}`)
      .catch(() => undefined);

    logger.info(
      { table: entry.path, rowsLoaded, bytesStaged: bytes },
      "load: copy complete",
    );
    return { table: entry.path, rowsLoaded, bytesStaged: bytes };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export interface LoadAllOptions {
  session: SnowflakeSession;
  snapshot: Snapshot;
  tables: Array<{ entry: TableEntry; schema: TableSchema }>;
  target: DDLTarget;
  stagePrefix?: string;
}

export async function loadAll(
  opts: LoadAllOptions,
): Promise<LoadTableResult[]> {
  const results: LoadTableResult[] = [];
  for (const { entry, schema } of opts.tables) {
    if (schema.columns.length === 0) {
      logger.warn(
        { table: entry.path },
        "load: skipping table with no inferred columns",
      );
      continue;
    }
    results.push(
      await loadTable({
        session: opts.session,
        snapshot: opts.snapshot,
        entry,
        schema,
        target: opts.target,
        ...(opts.stagePrefix !== undefined
          ? { stagePrefix: opts.stagePrefix }
          : {}),
      }),
    );
  }
  return results;
}
