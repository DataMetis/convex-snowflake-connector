/**
 * Discover existing Snowflake connections from `~/.snowflake/connections.toml`,
 * the file used by the Snowflake CLI / Python connector / snowsql. Lets `init`
 * offer a picker instead of forcing the user to retype account + user.
 *
 * We parse the TOML inline rather than pull in a dependency — connections.toml
 * is a strict subset (top-level scalars + named tables with string/bool
 * values), so a 40-line parser is honest. If the file grows arrays or nested
 * tables we'd need to swap to a real parser, but Snowflake's published schema
 * for this file doesn't.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Auth methods our pipeline can drive end-to-end. */
export type SupportedAuthenticator =
  | "password"
  | "externalbrowser"
  | "oauth-authorization-code";

export interface DiscoveredSnowflakeConnection {
  /** Section name in connections.toml, e.g. `TCA34621`. */
  name: string;
  account: string;
  user: string;
  authenticator: SupportedAuthenticator;
  /** Present iff the TOML stores it inline (rare for browser SSO). */
  password?: string;
  role?: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  /**
   * For OAuth authorization-code connections, whether to persist the refresh
   * token in the OS keychain so subsequent runs don't re-trigger the browser
   * dance. Snowflake CLI sets this to true by default.
   */
  clientStoreTemporaryCredential?: boolean;
}

export interface SnowflakeConnectionsDiscovery {
  path: string;
  /** Connections we can actually use (password or externalbrowser). */
  usable: DiscoveredSnowflakeConnection[];
  /** Connections present in the file but skipped (e.g. OAuth flows we can't drive). */
  skipped: Array<{ name: string; reason: string }>;
}

interface RawTable {
  [key: string]: string | boolean;
}

interface ParsedToml {
  top: RawTable;
  tables: Record<string, RawTable>;
}

function unquote(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function parseValue(raw: string): string | boolean {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return unquote(trimmed);
}

/**
 * Parse the subset of TOML that connections.toml uses. Not a general-purpose
 * parser — silently ignores arrays, inline tables, and multi-line strings.
 */
export function parseConnectionsToml(text: string): ParsedToml {
  const top: RawTable = {};
  const tables: Record<string, RawTable> = {};
  let current: RawTable = top;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, "").trim();
    if (line === "") continue;

    const headerMatch = /^\[([^\]]+)\]$/.exec(line);
    if (headerMatch !== null) {
      const name = headerMatch[1]!.trim();
      current = tables[name] ?? {};
      tables[name] = current;
      continue;
    }

    const kvMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (kvMatch !== null) {
      const key = kvMatch[1]!;
      current[key] = parseValue(kvMatch[2]!);
    }
  }

  return { top, tables };
}

const AUTH_KIND_MAP: Record<string, SupportedAuthenticator> = {
  SNOWFLAKE: "password",
  PASSWORD: "password",
  EXTERNALBROWSER: "externalbrowser",
  OAUTH_AUTHORIZATION_CODE: "oauth-authorization-code",
};

function classifyAuthenticator(
  raw: string | boolean | undefined,
): { kind: SupportedAuthenticator } | { skip: string } {
  // Snowflake's connections.toml normalizes authenticator strings to upper
  // snake case (PASSWORD, EXTERNALBROWSER, OAUTH_AUTHORIZATION_CODE, SNOWFLAKE_JWT).
  // Missing / empty authenticator → password (the SDK's default).
  if (raw === undefined || raw === "" || raw === false) {
    return { kind: "password" };
  }
  const v = String(raw).trim().toUpperCase();
  if (v === "") return { kind: "password" };
  const kind = AUTH_KIND_MAP[v];
  if (kind !== undefined) return { kind };
  if (v === "SNOWFLAKE_JWT")
    return { skip: "key-pair JWT not yet supported by init's picker" };
  if (v.startsWith("OAUTH"))
    return { skip: `OAuth variant "${v}" not yet supported by the connector` };
  return { skip: `unrecognized authenticator "${v}"` };
}

function asStringField(t: RawTable, key: string): string | undefined {
  const v = t[key];
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

type Classification =
  | { ok: true; conn: DiscoveredSnowflakeConnection }
  | { ok: false; reason: string };

function classifyTable(name: string, table: RawTable): Classification {
  const account = asStringField(table, "account");
  const user = asStringField(table, "user");
  if (account === undefined || user === undefined) {
    return { ok: false, reason: "missing account or user" };
  }
  const auth = classifyAuthenticator(table["authenticator"]);
  if ("skip" in auth) return { ok: false, reason: auth.skip };

  const conn: DiscoveredSnowflakeConnection = {
    name,
    account,
    user,
    authenticator: auth.kind,
  };
  const optionalFields = [
    "password",
    "role",
    "warehouse",
    "database",
    "schema",
  ] as const;
  for (const key of optionalFields) {
    const v = asStringField(table, key);
    if (v !== undefined) conn[key] = v;
  }
  const storeToken = table["client_store_temporary_credential"];
  if (typeof storeToken === "boolean") {
    conn.clientStoreTemporaryCredential = storeToken;
  }
  return { ok: true, conn };
}

function readFileOrEmpty(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read `~/.snowflake/connections.toml` (or a supplied path) and return the
 * connections we can drive. Missing file → empty discovery, never throws.
 */
export function discoverSnowflakeConnections(
  opts: { home?: string; path?: string } = {},
): SnowflakeConnectionsDiscovery {
  const path =
    opts.path ?? join(opts.home ?? homedir(), ".snowflake", "connections.toml");

  const text = readFileOrEmpty(path);
  if (text === null) return { path, usable: [], skipped: [] };

  const parsed = parseConnectionsToml(text);
  const usable: DiscoveredSnowflakeConnection[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const [name, table] of Object.entries(parsed.tables)) {
    const result = classifyTable(name, table);
    if (result.ok) usable.push(result.conn);
    else skipped.push({ name, reason: result.reason });
  }

  return { path, usable, skipped };
}
