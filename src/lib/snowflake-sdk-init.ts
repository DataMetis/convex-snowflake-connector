/**
 * Silence snowflake-sdk's INFO-level chatter (connection lifecycle, easy-logging
 * checks, etc.) so the CLI doesn't look like it's crash-dumping.
 *
 * The SDK logs to stderr at INFO by default. We bump it to ERROR unless the
 * user opts into more detail via `SNOWFLAKE_LOG_LEVEL`. Import this module
 * once per process — `configure` is global and idempotent.
 */

import snowflake, { type LogLevel } from "snowflake-sdk";

const VALID = new Set<LogLevel>([
  "OFF",
  "ERROR",
  "WARN",
  "INFO",
  "DEBUG",
  "TRACE",
]);

function resolveLogLevel(): LogLevel {
  const raw = process.env["SNOWFLAKE_LOG_LEVEL"]?.toUpperCase();
  if (raw !== undefined && VALID.has(raw as LogLevel)) return raw as LogLevel;
  return "ERROR";
}

snowflake.configure({ logLevel: resolveLogLevel() });
