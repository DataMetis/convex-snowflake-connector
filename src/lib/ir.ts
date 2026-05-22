// Intermediate representation produced by schema discovery.
// Step 4 (DDL generation) reads this; step 5 (load) uses it for column projection.
//
// We intentionally collapse the Convex validator distinctions that JSON can't
// preserve (int64 vs float64, id vs string) — both halves of each pair map to
// the same Snowflake column type per spec §2, so the inferrer doesn't need to
// recover them from raw data.

export type ConvexType =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "bytes" }
  | { kind: "any" }
  | { kind: "array"; element: ConvexType }
  | { kind: "object"; fields: Record<string, ConvexType> }
  | { kind: "union"; members: ConvexType[] };

export interface ColumnSchema {
  name: string;
  type: ConvexType;
  nullable: boolean;
}

export interface TableSchema {
  /** Path as it appears in the ZIP (e.g. "rulers", "_components/aggregateShows/btree"). */
  path: string;
  /** Last segment of `path` — the table's local name. */
  name: string;
  /** True for "_"-prefixed top-level dirs and anything under "_components/". */
  system: boolean;
  columns: ColumnSchema[];
  /** Number of documents the inferrer actually read. */
  sampled: number;
  /** True if `sampled` < the table's total row count (i.e. we hit the sample cap). */
  truncated: boolean;
}

export interface DiscoveryResult {
  /** Path to the snapshot ZIP that was inferred from. */
  source: string;
  tables: TableSchema[];
}
