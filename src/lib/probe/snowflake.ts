/**
 * Snowflake reachability + capability probe. Used by `init` (to auto-populate
 * warehouse/database/schema/role pickers) and `doctor` (to re-verify config).
 *
 * Wraps the callback-based snowflake-sdk in promises. Connections are
 * one-shot: each probe call creates a fresh connection, runs its queries,
 * and destroys it. Higher-level commands (sync, doctor) will want a
 * longer-lived connection helper — that lives in a separate module.
 */

import snowflake, {
  type Connection,
  type ConnectionOptions,
} from "snowflake-sdk";
import "../snowflake-sdk-init.js";

export type SnowflakeAuthenticator =
  | { kind: "password"; password: string }
  | { kind: "key-pair"; privateKeyPath: string; privateKeyPassphrase?: string }
  | { kind: "externalbrowser" }
  | {
      kind: "oauth-authorization-code";
      /**
       * When true (default), reuse a cached refresh token from the OS
       * keychain so the browser doesn't pop on every connection.
       */
      clientStoreTemporaryCredential?: boolean;
    };

export interface SnowflakeCreds {
  account: string;
  user: string;
  auth: SnowflakeAuthenticator;
  /** Optional context — when set, the probe asserts these are usable. */
  warehouse?: string;
  database?: string;
  schema?: string;
  role?: string;
}

export interface SnowflakeProbeResult {
  ok: boolean;
  latencyMs: number;
  /** Resolved session context after connecting (what Snowflake actually picked). */
  session?: {
    user: string;
    account: string;
    role: string | null;
    warehouse: string | null;
    database: string | null;
    schema: string | null;
  };
  error?: string;
}

export interface SnowflakeContextLists {
  warehouses: Array<{ name: string; state: string; size: string }>;
  databases: string[];
  schemas: string[];
  roles: string[];
}

function authOptions(auth: SnowflakeAuthenticator): Partial<ConnectionOptions> {
  switch (auth.kind) {
    case "password":
      return { password: auth.password };
    case "key-pair":
      return {
        authenticator: "SNOWFLAKE_JWT",
        privateKeyPath: auth.privateKeyPath,
        ...(auth.privateKeyPassphrase !== undefined
          ? { privateKeyPass: auth.privateKeyPassphrase }
          : {}),
      };
    case "externalbrowser":
      return { authenticator: "EXTERNALBROWSER" };
    case "oauth-authorization-code":
      return {
        authenticator: "OAUTH_AUTHORIZATION_CODE",
        clientStoreTemporaryCredential:
          auth.clientStoreTemporaryCredential ?? true,
      };
  }
}

function buildConnectionOptions(creds: SnowflakeCreds): ConnectionOptions {
  const base: ConnectionOptions = {
    account: creds.account,
    username: creds.user,
  };
  if (creds.warehouse !== undefined) base.warehouse = creds.warehouse;
  if (creds.database !== undefined) base.database = creds.database;
  if (creds.schema !== undefined) base.schema = creds.schema;
  if (creds.role !== undefined) base.role = creds.role;
  return { ...base, ...authOptions(creds.auth) };
}

function connectAsync(conn: Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    // EXTERNALBROWSER uses connectAsync; the regular `connect` works for the
    // other authenticators. Use connectAsync uniformly — it's a no-op
    // upgrade for password/key-pair and is required for browser SSO.
    void conn.connectAsync((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function asString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function asStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return asString(v);
}

function destroyAsync(conn: Connection): Promise<void> {
  return new Promise((resolve) => {
    conn.destroy(() => resolve());
  });
}

interface QueryRow {
  [column: string]: unknown;
}

function execAsync(conn: Connection, sqlText: string): Promise<QueryRow[]> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      complete: (err, _stmt, rows) => {
        if (err) reject(err);
        else resolve((rows ?? []) as QueryRow[]);
      },
    });
  });
}

function rowToSession(
  row: QueryRow,
): NonNullable<SnowflakeProbeResult["session"]> {
  return {
    user: asString(row["USER"]),
    account: asString(row["ACCOUNT"]),
    role: asStringOrNull(row["ROLE"]),
    warehouse: asStringOrNull(row["WAREHOUSE"]),
    database: asStringOrNull(row["DATABASE"]),
    schema: asStringOrNull(row["SCHEMA"]),
  };
}

const SESSION_SQL =
  "SELECT CURRENT_USER() AS USER, CURRENT_ACCOUNT() AS ACCOUNT, CURRENT_ROLE() AS ROLE, CURRENT_WAREHOUSE() AS WAREHOUSE, CURRENT_DATABASE() AS DATABASE, CURRENT_SCHEMA() AS SCHEMA";

export async function probeSnowflake(
  creds: SnowflakeCreds,
): Promise<SnowflakeProbeResult> {
  const conn = snowflake.createConnection(buildConnectionOptions(creds));
  const start = Date.now();
  try {
    await connectAsync(conn);
    const rows = await execAsync(conn, SESSION_SQL);
    const session = rowToSession(rows[0] ?? {});
    const latencyMs = Date.now() - start;
    const mismatch = checkSessionContext(creds, session);
    if (mismatch !== null) {
      return { ok: false, latencyMs, session, error: mismatch };
    }
    return { ok: true, latencyMs, session };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: explainSnowflakeError(err, creds),
    };
  } finally {
    await destroyAsync(conn);
  }
}

/**
 * The SDK silently tolerates a database/schema/warehouse/role that the
 * current session can't actually use — connect succeeds, but the
 * `CURRENT_*()` value comes back null (or, occasionally, a different name
 * than the user configured). Surface that here so doctor / dry-run fail
 * loudly instead of letting the first DDL trip on it.
 */
function checkSessionContext(
  creds: SnowflakeCreds,
  session: NonNullable<SnowflakeProbeResult["session"]>,
): string | null {
  const checks: Array<{
    label: string;
    want: string | undefined;
    got: string | null;
  }> = [
    { label: "database", want: creds.database, got: session.database },
    { label: "schema", want: creds.schema, got: session.schema },
    { label: "warehouse", want: creds.warehouse, got: session.warehouse },
    { label: "role", want: creds.role, got: session.role },
  ];
  for (const c of checks) {
    if (c.want === undefined) continue;
    if (c.got === null || c.got === "") {
      return `Snowflake connected but ${c.label} "${c.want}" is not active for this session — it likely doesn't exist or the role lacks USAGE on it.`;
    }
    if (c.got.toUpperCase() !== c.want.toUpperCase()) {
      return `Snowflake session ${c.label} is "${c.got}", not "${c.want}" — check the config (Snowflake folds unquoted names to upper case).`;
    }
  }
  return null;
}

/**
 * Pull picker-friendly lists from Snowflake. Used by `init` to autocomplete
 * the warehouse/database/schema/role prompts. Each list query is independent
 * — a failure on one (e.g. role lacks SHOW DATABASES) shouldn't block the
 * others, so we swallow per-query errors and return what we got.
 */
export async function listSnowflakeContext(
  creds: SnowflakeCreds,
): Promise<SnowflakeContextLists> {
  const conn = snowflake.createConnection(buildConnectionOptions(creds));
  await connectAsync(conn);
  try {
    const [warehouses, databases, schemas, roles] = await Promise.all([
      safeList(conn, "SHOW WAREHOUSES", (r) => ({
        name: asString(r["name"]),
        state: asString(r["state"]),
        size: asString(r["size"]),
      })),
      safeList(conn, "SHOW DATABASES", (r) => asString(r["name"])),
      creds.database !== undefined
        ? safeList(conn, `SHOW SCHEMAS IN DATABASE "${creds.database}"`, (r) =>
            asString(r["name"]),
          )
        : Promise.resolve([] as string[]),
      safeList(conn, "SHOW ROLES", (r) => asString(r["name"])),
    ]);
    return { warehouses, databases, schemas, roles };
  } finally {
    await destroyAsync(conn);
  }
}

async function safeList<T>(
  conn: Connection,
  sql: string,
  map: (row: QueryRow) => T,
): Promise<T[]> {
  try {
    const rows = await execAsync(conn, sql);
    return rows.map(map);
  } catch {
    return [];
  }
}

function explainSnowflakeError(err: unknown, creds: SnowflakeCreds): string {
  const msg = err instanceof Error ? err.message : String(err);

  if (/incorrect username or password/i.test(msg)) {
    return `Snowflake rejected the credentials for ${creds.user}@${creds.account}. Double-check SNOWFLAKE_USER and the password / private key.`;
  }
  if (/account.*not.*found|404|getaddrinfo/i.test(msg)) {
    return `Snowflake account "${creds.account}" not found. Use the locator form (e.g. "abc12345.us-east-1"), not the full URL.`;
  }
  if (/role.*does not exist/i.test(msg) && creds.role !== undefined) {
    return `Snowflake role "${creds.role}" does not exist or is not granted to ${creds.user}.`;
  }
  if (/warehouse.*does not exist/i.test(msg) && creds.warehouse !== undefined) {
    return `Snowflake warehouse "${creds.warehouse}" does not exist or is not accessible to the current role.`;
  }
  if (/database.*does not exist/i.test(msg) && creds.database !== undefined) {
    return `Snowflake database "${creds.database}" does not exist or is not accessible to the current role.`;
  }
  return `Snowflake connection failed: ${msg}`;
}
