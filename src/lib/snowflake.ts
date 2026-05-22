/**
 * Long-lived Snowflake session used by `sync` (and, later, `verify`).
 *
 * The probe module (src/lib/probe/snowflake.ts) makes one-shot connections
 * for connectivity checks. Sync needs a connection that stays open across
 * PUT / TRUNCATE / COPY INTO for every table, so we wrap snowflake-sdk's
 * callback API in a small promise-based session here.
 */

import snowflake, {
  type Binds,
  type Connection,
  type ConnectionOptions,
} from "snowflake-sdk";
import type { Config } from "./config.js";
import type { SnowflakeAuthenticator } from "./probe/snowflake.js";
import "./snowflake-sdk-init.js";

export interface SnowflakeSession {
  conn: Connection;
  exec: (sqlText: string, binds?: Binds) => Promise<QueryRow[]>;
  close: () => Promise<void>;
}

export interface QueryRow {
  [column: string]: unknown;
}

/**
 * Translate the Config's snowflake block to the authenticator shape used by
 * snowflake-sdk. Honors an explicit `authenticator:` field when present
 * (init writes `externalbrowser` for SSO connections, which carry no secret);
 * otherwise infers from which credential is set.
 */
export function authFromConfig(
  sf: Config["snowflake"],
): SnowflakeAuthenticator {
  if (sf.authenticator === "externalbrowser") {
    return { kind: "externalbrowser" };
  }
  if (sf.authenticator === "oauth-authorization-code") {
    return {
      kind: "oauth-authorization-code",
      clientStoreTemporaryCredential: sf.client_store_temporary_credential,
    };
  }
  if (sf.authenticator === "key-pair") {
    if (sf.private_key === undefined || sf.private_key === "") {
      throw new Error(
        "snowflake: authenticator=key-pair requires `private_key`",
      );
    }
    return { kind: "key-pair", privateKeyPath: sf.private_key };
  }
  if (sf.password !== undefined && sf.password !== "") {
    return { kind: "password", password: sf.password };
  }
  if (sf.private_key !== undefined && sf.private_key !== "") {
    return { kind: "key-pair", privateKeyPath: sf.private_key };
  }
  throw new Error(
    "snowflake: config must set `authenticator` to `externalbrowser` / `oauth-authorization-code`, or supply `password` / `private_key`",
  );
}

function buildOptions(sf: Config["snowflake"]): ConnectionOptions {
  const base: ConnectionOptions = {
    account: sf.account,
    username: sf.user,
    database: sf.database,
    schema: sf.schema,
    warehouse: sf.warehouse,
  };
  if (sf.role !== undefined) base.role = sf.role;

  const auth = authFromConfig(sf);
  switch (auth.kind) {
    case "password":
      return { ...base, password: auth.password };
    case "key-pair":
      return {
        ...base,
        authenticator: "SNOWFLAKE_JWT",
        privateKeyPath: auth.privateKeyPath,
      };
    case "externalbrowser":
      return { ...base, authenticator: "EXTERNALBROWSER" };
    case "oauth-authorization-code":
      return {
        ...base,
        authenticator: "OAUTH_AUTHORIZATION_CODE",
        clientStoreTemporaryCredential:
          auth.clientStoreTemporaryCredential ?? true,
      };
  }
}

function connectAsync(conn: Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    void conn.connectAsync((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function destroyAsync(conn: Connection): Promise<void> {
  return new Promise((resolve) => {
    conn.destroy(() => resolve());
  });
}

export async function openSession(
  sf: Config["snowflake"],
): Promise<SnowflakeSession> {
  const conn = snowflake.createConnection(buildOptions(sf));
  await connectAsync(conn);

  const exec = (sqlText: string, binds?: Binds): Promise<QueryRow[]> =>
    new Promise((resolve, reject) => {
      conn.execute({
        sqlText,
        ...(binds !== undefined ? { binds } : {}),
        complete: (err, _stmt, rows) => {
          if (err) reject(err);
          else resolve((rows ?? []) as QueryRow[]);
        },
      });
    });

  return {
    conn,
    exec,
    close: () => destroyAsync(conn),
  };
}
