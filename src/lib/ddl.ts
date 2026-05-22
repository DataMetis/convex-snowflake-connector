import type { ColumnSchema, ConvexType, TableSchema } from "./ir.js";

export interface DDLTarget {
  database: string;
  schema: string;
}

/** Map an inferred ConvexType to a Snowflake column type per spec §2. */
export function snowflakeColumnType(type: ConvexType): string {
  switch (type.kind) {
    case "string":
      return "VARCHAR";
    case "number":
      return "NUMBER";
    case "boolean":
      return "BOOLEAN";
    case "bytes":
      return "BINARY";
    case "null":
    case "any":
    case "array":
    case "object":
    case "union":
      return "VARIANT";
  }
}

/** Wrap a Convex identifier in double quotes so Snowflake preserves case. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Fully-qualified `"DB"."SCHEMA"."table"` form. */
export function qualifiedName(target: DDLTarget, table: string): string {
  return `${quoteIdent(target.database)}.${quoteIdent(target.schema)}.${quoteIdent(table)}`;
}

function renderColumn(col: ColumnSchema): string {
  if (col.name === "_id") {
    return `${quoteIdent(col.name)} VARCHAR NOT NULL PRIMARY KEY`;
  }
  if (col.name === "_creationTime") {
    return `${quoteIdent(col.name)} TIMESTAMP_NTZ NOT NULL`;
  }
  const sfType = snowflakeColumnType(col.type);
  const nullClause = col.nullable ? "NULL" : "NOT NULL";
  return `${quoteIdent(col.name)} ${sfType} ${nullClause}`;
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

/**
 * Generate a CREATE OR REPLACE TABLE statement for one Convex table.
 * Returns an empty string for tables with no columns (export was empty) —
 * the caller decides whether to skip or warn.
 */
export function generateTableDDL(
  schema: TableSchema,
  target: DDLTarget,
): string {
  if (schema.columns.length === 0) return "";
  const fq = qualifiedName(target, schema.name);
  const lines = orderColumns(schema.columns).map((c) => `  ${renderColumn(c)}`);
  return `CREATE OR REPLACE TABLE ${fq} (\n${lines.join(",\n")}\n);`;
}

/** Generate DDL for every table in a discovery result; skips empty tables. */
export function generateAllDDL(
  tables: TableSchema[],
  target: DDLTarget,
): { ddl: string; skipped: string[] } {
  const stmts: string[] = [];
  const skipped: string[] = [];
  for (const t of tables) {
    const stmt = generateTableDDL(t, target);
    if (stmt) stmts.push(stmt);
    else skipped.push(t.path);
  }
  return { ddl: stmts.join("\n\n") + (stmts.length ? "\n" : ""), skipped };
}
