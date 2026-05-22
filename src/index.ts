export { sync, type SyncOptions, type SyncResult } from "./commands/sync.js";
export {
  SyncCancelledError,
  SyncConsentRequiredError,
  type SyncRundown,
} from "./commands/sync-consent.js";
export {
  loadTable,
  loadAll,
  buildCopyProjection,
  projectionExpr,
  tableSlug,
  type LoadTableOptions,
  type LoadTableResult,
  type LoadAllOptions,
  type CopyStatement,
} from "./lib/load.js";
export {
  openSession,
  authFromConfig,
  type SnowflakeSession,
} from "./lib/snowflake.js";
export { discover, type DiscoverOptions } from "./commands/discover.js";
export { extract, type ExtractOptions } from "./commands/extract.js";
export {
  runConvexExport,
  type RunConvexExportOptions,
  type RunConvexExportResult,
} from "./lib/extract.js";
export { ddl, type DDLOptions } from "./commands/ddl.js";
export {
  snowflakeColumnType,
  generateTableDDL,
  generateAllDDL,
  quoteIdent,
  qualifiedName,
  type DDLTarget,
} from "./lib/ddl.js";
export {
  loadConfig,
  interpolateEnv,
  ConfigSchema,
  SyncMode,
  type Config,
} from "./lib/config.js";
export { logger } from "./lib/logger.js";
export {
  openSnapshot,
  type Snapshot,
  type TableEntry,
} from "./lib/snapshot.js";
export {
  inferTableSchema,
  merge as mergeConvexType,
  type InferOptions,
} from "./lib/infer.js";
export type {
  ConvexType,
  ColumnSchema,
  TableSchema,
  DiscoveryResult,
} from "./lib/ir.js";
