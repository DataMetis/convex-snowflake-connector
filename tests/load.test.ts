import { describe, expect, it } from "vitest";
import {
  buildCopyProjection,
  loadTable,
  projectionExpr,
  tableSlug,
} from "../src/lib/load.js";
import type { ColumnSchema, TableSchema } from "../src/lib/ir.js";
import type { Snapshot, TableEntry } from "../src/lib/snapshot.js";
import type { QueryRow, SnowflakeSession } from "../src/lib/snowflake.js";
import type { DDLTarget } from "../src/lib/ddl.js";

function col(
  name: string,
  type: ColumnSchema["type"],
  nullable = false,
): ColumnSchema {
  return { name, type, nullable };
}

function table(columns: ColumnSchema[]): TableSchema {
  return {
    path: "users",
    name: "users",
    system: false,
    columns,
    sampled: columns.length,
    truncated: false,
  };
}

describe("projectionExpr", () => {
  it("casts _id to VARCHAR", () => {
    expect(projectionExpr(col("_id", { kind: "string" }))).toBe(
      "$1['_id']::VARCHAR",
    );
  });

  it("wraps _creationTime in TO_TIMESTAMP_NTZ with ms scale", () => {
    expect(projectionExpr(col("_creationTime", { kind: "number" }))).toBe(
      "TO_TIMESTAMP_NTZ($1['_creationTime']::NUMBER, 3)",
    );
  });

  it("casts scalars to their Snowflake type", () => {
    expect(projectionExpr(col("name", { kind: "string" }))).toBe(
      "$1['name']::VARCHAR",
    );
    expect(projectionExpr(col("age", { kind: "number" }))).toBe(
      "$1['age']::NUMBER",
    );
    expect(projectionExpr(col("active", { kind: "boolean" }))).toBe(
      "$1['active']::BOOLEAN",
    );
  });

  it("leaves VARIANT columns uncast", () => {
    const v = projectionExpr(
      col("payload", { kind: "object", fields: { a: { kind: "string" } } }),
    );
    expect(v).toBe("$1['payload']");
    expect(
      projectionExpr(
        col("tags", { kind: "array", element: { kind: "string" } }),
      ),
    ).toBe("$1['tags']");
    expect(
      projectionExpr(
        col("either", {
          kind: "union",
          members: [{ kind: "string" }, { kind: "number" }],
        }),
      ),
    ).toBe("$1['either']");
  });

  it("escapes quotes and backslashes in field names", () => {
    expect(projectionExpr(col("weird'name", { kind: "string" }))).toBe(
      "$1['weird\\'name']::VARCHAR",
    );
    expect(projectionExpr(col("back\\slash", { kind: "string" }))).toBe(
      "$1['back\\\\slash']::VARCHAR",
    );
  });
});

describe("buildCopyProjection", () => {
  it("orders system fields first, then alphabetical, with quoted identifiers", () => {
    const schema = table([
      col("name", { kind: "string" }),
      col("_creationTime", { kind: "number" }),
      col("_id", { kind: "string" }),
      col("age", { kind: "number" }),
    ]);
    const { columnList, selectList } = buildCopyProjection(schema);
    expect(columnList).toBe(`"_id", "_creationTime", "age", "name"`);
    expect(selectList).toBe(
      [
        "$1['_id']::VARCHAR",
        "TO_TIMESTAMP_NTZ($1['_creationTime']::NUMBER, 3)",
        "$1['age']::NUMBER",
        "$1['name']::VARCHAR",
      ].join(", "),
    );
  });
});

interface FakeSessionOptions {
  /** SQL fragment (case-insensitive substring) to fail on, plus the error to throw. */
  failOn?: { match: string; error: Error };
  /** Rows returned by COPY INTO. Default: one row with rows_loaded=2. */
  copyRows?: QueryRow[];
}

function makeSession(opts: FakeSessionOptions = {}): {
  session: SnowflakeSession;
  sql: string[];
} {
  const sql: string[] = [];
  const session: SnowflakeSession = {
    conn: {} as never,
    close: () => Promise.resolve(),
    exec: (sqlText: string) => {
      sql.push(sqlText);
      if (
        opts.failOn !== undefined &&
        sqlText.toLowerCase().includes(opts.failOn.match.toLowerCase())
      ) {
        return Promise.reject(opts.failOn.error);
      }
      if (/^\s*COPY\s+INTO/i.test(sqlText)) {
        return Promise.resolve(opts.copyRows ?? [{ rows_loaded: 2 }]);
      }
      return Promise.resolve([]);
    },
  };
  return { session, sql };
}

function makeSnapshot(docs: unknown[]): {
  snapshot: Snapshot;
  entry: TableEntry;
} {
  const entry: TableEntry = {
    path: "users",
    name: "users",
    system: false,
    compressedSize: 1,
  };
  const snapshot: Snapshot = {
    path: "/tmp/fake.zip",
    tables: [entry],
    // eslint-disable-next-line @typescript-eslint/require-await -- AsyncIterable contract requires async generator
    readDocuments: async function* () {
      for (const d of docs) yield d;
    },
    close: () => Promise.resolve(),
  };
  return { snapshot, entry };
}

const usersSchema: TableSchema = {
  path: "users",
  name: "users",
  system: false,
  columns: [
    { name: "_id", type: { kind: "string" }, nullable: false },
    { name: "_creationTime", type: { kind: "number" }, nullable: false },
    { name: "name", type: { kind: "string" }, nullable: false },
  ],
  sampled: 1,
  truncated: false,
};

const target: DDLTarget = {
  database: "DB",
  schema: "PUBLIC",
};

const STAGING_FQ = `"DB"."PUBLIC"."users__csc_staging"`;
const TARGET_FQ = `"DB"."PUBLIC"."users"`;

describe("loadTable (swap flow)", () => {
  it("loads into staging then swaps with the target", async () => {
    const { session, sql } = makeSession({ copyRows: [{ rows_loaded: 2 }] });
    const { snapshot, entry } = makeSnapshot([
      { _id: "a", _creationTime: 1, name: "x" },
      { _id: "b", _creationTime: 2, name: "y" },
    ]);

    const result = await loadTable({
      session,
      snapshot,
      entry,
      schema: usersSchema,
      target,
    });

    expect(result).toEqual({
      table: "users",
      rowsLoaded: 2,
      bytesStaged: expect.any(Number),
    });

    // The first DDL touching the target must be CREATE OR REPLACE on staging
    // (built LIKE the target). Until SWAP runs, the original target is untouched.
    const createIdx = sql.findIndex((s) =>
      /CREATE OR REPLACE TABLE .* LIKE/i.test(s),
    );
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(sql[createIdx]).toContain(STAGING_FQ);
    expect(sql[createIdx]).toContain(`LIKE ${TARGET_FQ}`);

    const putIdx = sql.findIndex((s) => /^PUT /i.test(s));
    const copyIdx = sql.findIndex((s) => /^COPY INTO/i.test(s));
    const swapIdx = sql.findIndex((s) => /ALTER TABLE .* SWAP WITH/i.test(s));
    const dropIdx = sql.findIndex(
      (s, i) => i > swapIdx && /DROP TABLE IF EXISTS/i.test(s),
    );

    expect(createIdx).toBeLessThan(putIdx);
    expect(putIdx).toBeLessThan(copyIdx);
    expect(copyIdx).toBeLessThan(swapIdx);
    expect(swapIdx).toBeLessThan(dropIdx);

    expect(sql[copyIdx]).toContain(STAGING_FQ);
    expect(sql[copyIdx]).not.toMatch(
      new RegExp(`COPY INTO\\s+${TARGET_FQ.replace(/"/g, '"')}\\b`),
    );
    expect(sql[swapIdx]).toBe(
      `ALTER TABLE ${TARGET_FQ} SWAP WITH ${STAGING_FQ}`,
    );

    // The previous-data table (now living at the staging name) is dropped.
    expect(sql[dropIdx]).toContain(STAGING_FQ);

    // No bare TRUNCATE on the live target.
    expect(sql.some((s) => /TRUNCATE TABLE/i.test(s))).toBe(false);
  });

  it("still swaps when the source has zero rows (atomic empty refresh)", async () => {
    const { session, sql } = makeSession();
    const { snapshot, entry } = makeSnapshot([]);

    const result = await loadTable({
      session,
      snapshot,
      entry,
      schema: usersSchema,
      target,
    });

    expect(result).toEqual({ table: "users", rowsLoaded: 0, bytesStaged: 0 });

    // No PUT / COPY on empty input, but CREATE-OR-REPLACE + SWAP still run so
    // the cutover is atomic (target replaced by an empty table, never TRUNCATEd
    // in place).
    expect(sql.some((s) => /^PUT /i.test(s))).toBe(false);
    expect(sql.some((s) => /^COPY INTO/i.test(s))).toBe(false);
    expect(sql.some((s) => /CREATE OR REPLACE TABLE .* LIKE/i.test(s))).toBe(
      true,
    );
    expect(sql.some((s) => /ALTER TABLE .* SWAP WITH/i.test(s))).toBe(true);
  });

  it("leaves the target untouched and cleans up staging when COPY fails", async () => {
    const { session, sql } = makeSession({
      failOn: { match: "COPY INTO", error: new Error("boom") },
    });
    const { snapshot, entry } = makeSnapshot([
      { _id: "a", _creationTime: 1, name: "x" },
    ]);

    await expect(
      loadTable({ session, snapshot, entry, schema: usersSchema, target }),
    ).rejects.toThrow("boom");

    // No SWAP — original target data preserved.
    expect(sql.some((s) => /ALTER TABLE .* SWAP WITH/i.test(s))).toBe(false);

    // Cleanup of staging happens after the failure.
    const copyIdx = sql.findIndex((s) => /^COPY INTO/i.test(s));
    const cleanupIdx = sql.findIndex(
      (s, i) =>
        i > copyIdx &&
        /DROP TABLE IF EXISTS/i.test(s) &&
        s.includes(STAGING_FQ),
    );
    expect(cleanupIdx).toBeGreaterThan(copyIdx);
  });
});

describe("tableSlug", () => {
  it("preserves alphanumerics and underscores", () => {
    expect(tableSlug("users")).toBe("users");
    expect(tableSlug("user_events_v2")).toBe("user_events_v2");
  });

  it("collapses path separators and special chars", () => {
    expect(tableSlug("_components/aggregateShows/btree")).toBe(
      "_components_aggregateShows_btree",
    );
  });

  it("falls back to 'table' for empty input", () => {
    expect(tableSlug("")).toBe("table");
  });
});
