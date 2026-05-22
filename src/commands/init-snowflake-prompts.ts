/**
 * Snowflake-side prompting for the `init` wizard. Split out of init.ts to
 * keep that file focused on orchestration + rendering. Two collection paths:
 *
 *   1. Pick an entry from `~/.snowflake/connections.toml` (preferred when
 *      one exists — saves retyping account/user, and handles browser SSO
 *      without a password prompt).
 *   2. Manual entry (the original wizard flow).
 */

import type { Prompter } from "../lib/prompter.js";
import type {
  DiscoveredSnowflakeConnection,
  SnowflakeConnectionsDiscovery,
} from "../lib/snowflake-connections.js";

export interface SnowflakeAnswers {
  account: string;
  user: string;
  /** Auth method chosen for this connection. Drives YAML + env output. */
  authenticator: "password" | "externalbrowser" | "oauth-authorization-code";
  /** Present iff authenticator === "password". */
  password?: string;
  /** For OAuth authorization-code: persist refresh token. */
  clientStoreTemporaryCredential?: boolean;
  database: string;
  schema: string;
  warehouse: string;
  role: string;
  /** When the user picked a connection from connections.toml, remember its name. */
  sourceConnection?: string;
}

const NONEMPTY =
  (label: string) =>
  (v: string): string | null =>
    v.trim() === "" ? `${label} is required` : null;

function describeConnection(c: DiscoveredSnowflakeConnection): string {
  const auth =
    c.authenticator === "externalbrowser"
      ? "browser SSO"
      : c.authenticator === "oauth-authorization-code"
        ? "OAuth (browser)"
        : "password";
  return `${c.name}  (${c.user}@${c.account}, ${auth})`;
}

async function pickExistingConnection(
  prompter: Prompter,
  discovery: SnowflakeConnectionsDiscovery,
): Promise<DiscoveredSnowflakeConnection | null> {
  if (discovery.usable.length === 0) {
    if (discovery.skipped.length > 0) {
      prompter.note(
        `  (found ${discovery.skipped.length} connection(s) in ${discovery.path} but none are supported yet: ${discovery.skipped
          .map((s) => `${s.name} — ${s.reason}`)
          .join("; ")})`,
      );
    }
    return null;
  }

  prompter.note(
    `\nFound ${discovery.usable.length} Snowflake connection(s) in ${discovery.path}.`,
  );
  if (discovery.skipped.length > 0) {
    prompter.note(
      `  (skipped ${discovery.skipped.length}: ${discovery.skipped
        .map((s) => `${s.name} — ${s.reason}`)
        .join("; ")})`,
    );
  }
  const MANUAL = "__manual__";
  const options = [
    ...discovery.usable.map((c) => ({
      value: c.name,
      label: describeConnection(c),
    })),
    { value: MANUAL, label: "Enter credentials manually" },
  ];
  const choice = await prompter.select<string>({
    message: "Use an existing connection?",
    options,
    default: discovery.usable[0]!.name,
  });
  if (choice === MANUAL) return null;
  return discovery.usable.find((c) => c.name === choice) ?? null;
}

async function resolvePassword(
  prompter: Prompter,
  conn: DiscoveredSnowflakeConnection,
): Promise<string | undefined> {
  if (conn.authenticator !== "password") return undefined;
  if (conn.password !== undefined) {
    prompter.note("  (password loaded from connections.toml)");
    return conn.password;
  }
  return prompter.secret({
    message: `Snowflake password for ${conn.user}`,
    validate: NONEMPTY("password"),
  });
}

async function collectFromExisting(
  prompter: Prompter,
  conn: DiscoveredSnowflakeConnection,
): Promise<SnowflakeAnswers> {
  prompter.note(`  using "${conn.name}" — ${conn.user}@${conn.account}`);
  const password = await resolvePassword(prompter, conn);

  const database = await prompter.text({
    message: "Database",
    ...(conn.database !== undefined ? { default: conn.database } : {}),
    validate: NONEMPTY("database"),
  });
  const schema = await prompter.text({
    message: "Schema",
    default: conn.schema ?? "PUBLIC",
  });
  const warehouse = await prompter.text({
    message: "Warehouse",
    default: conn.warehouse ?? "COMPUTE_WH",
  });
  const role = await prompter.text({
    message: "Role (optional, blank to skip)",
    default: conn.role ?? "",
  });

  const answers: SnowflakeAnswers = {
    account: conn.account,
    user: conn.user,
    authenticator: conn.authenticator,
    database,
    schema,
    warehouse,
    role,
    sourceConnection: conn.name,
  };
  if (password !== undefined) answers.password = password;
  if (conn.authenticator === "oauth-authorization-code") {
    answers.clientStoreTemporaryCredential =
      conn.clientStoreTemporaryCredential ?? true;
  }
  return answers;
}

async function collectManually(
  prompter: Prompter,
  env: NodeJS.ProcessEnv,
): Promise<SnowflakeAnswers> {
  const account = await prompter.text({
    message: "Snowflake account locator (e.g. abc12345.us-east-1)",
    ...(env["SNOWFLAKE_ACCOUNT"] !== undefined
      ? { default: env["SNOWFLAKE_ACCOUNT"] }
      : {}),
    validate: NONEMPTY("account"),
  });
  const user = await prompter.text({
    message: "Snowflake user",
    ...(env["SNOWFLAKE_USER"] !== undefined
      ? { default: env["SNOWFLAKE_USER"] }
      : {}),
    validate: NONEMPTY("user"),
  });
  const password = await prompter.secret({
    message: "Snowflake password",
    validate: NONEMPTY("password"),
  });
  const database = await prompter.text({
    message: "Database",
    validate: NONEMPTY("database"),
  });
  const schema = await prompter.text({ message: "Schema", default: "PUBLIC" });
  const warehouse = await prompter.text({
    message: "Warehouse",
    default: "COMPUTE_WH",
  });
  const role = await prompter.text({
    message: "Role (optional, blank to skip)",
    default: "",
  });
  return {
    account,
    user,
    authenticator: "password",
    password,
    database,
    schema,
    warehouse,
    role,
  };
}

export async function collectSnowflake(
  prompter: Prompter,
  env: NodeJS.ProcessEnv,
  discovery: SnowflakeConnectionsDiscovery,
): Promise<SnowflakeAnswers> {
  prompter.note("\nSnowflake");
  const picked = await pickExistingConnection(prompter, discovery);
  if (picked !== null) return collectFromExisting(prompter, picked);
  return collectManually(prompter, env);
}
