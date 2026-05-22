import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bold, cyan, dim, green } from "../lib/colors.js";
import type { Prompter } from "../lib/prompter.js";
import { ReadlinePrompter } from "../lib/prompter.js";
import type {
  ConvexProbeInput,
  ConvexProbeResult,
} from "../lib/probe/convex.js";
import { probeConvex } from "../lib/probe/convex.js";
import type {
  SnowflakeCreds,
  SnowflakeProbeResult,
} from "../lib/probe/snowflake.js";
import { probeSnowflake } from "../lib/probe/snowflake.js";
import type { SnowflakeConnectionsDiscovery } from "../lib/snowflake-connections.js";
import { discoverSnowflakeConnections } from "../lib/snowflake-connections.js";
import { logger } from "../lib/logger.js";
import type { SnowflakeAnswers } from "./init-snowflake-prompts.js";
import { collectSnowflake } from "./init-snowflake-prompts.js";

/**
 * Setup wizard. Walks the user through Convex + Snowflake credentials,
 * validates both with live probes, and writes:
 *
 *   - convex-snowflake.config.yaml   (committable; references env vars)
 *   - .env.local                     (gitignored; holds secrets)
 *
 * Snowflake-side prompting (picker over `~/.snowflake/connections.toml` +
 * manual fallback) lives in init-snowflake-prompts.ts.
 */

export interface InitOptions {
  /** Where to write the config YAML. Default: ./convex-snowflake.config.yaml */
  configPath?: string;
  /** Where to write/append secrets. Default: ./.env.local */
  envPath?: string;
  /** Overwrite an existing config without prompting. */
  force?: boolean;
}

export interface InitDeps {
  prompter: Prompter;
  probeConvex: (input: ConvexProbeInput) => Promise<ConvexProbeResult>;
  probeSnowflake: (creds: SnowflakeCreds) => Promise<SnowflakeProbeResult>;
  discoverSnowflakeConnections: () => SnowflakeConnectionsDiscovery;
  env: NodeJS.ProcessEnv;
}

export interface InitPlan {
  configPath: string;
  configYaml: string;
  envPath: string;
  envAppend: string;
}

const URL_VALIDATOR = (v: string): string | null => {
  try {
    new URL(v);
    return null;
  } catch {
    return "must be a valid URL (e.g. https://flying-mongoose-123.convex.cloud)";
  }
};

interface ConvexAnswers {
  url: string;
  deployKey: string;
}

async function confirmOverwrite(
  prompter: Prompter,
  configPath: string,
  force: boolean | undefined,
): Promise<void> {
  if (!existsSync(configPath) || force === true) return;
  const overwrite = await prompter.confirm({
    message: `${configPath} already exists. Overwrite?`,
    default: false,
  });
  if (!overwrite) throw new Error("init cancelled: existing config kept");
}

async function collectConvex(
  prompter: Prompter,
  env: NodeJS.ProcessEnv,
  probe: InitDeps["probeConvex"],
): Promise<ConvexAnswers> {
  prompter.note("\nConvex");
  const url = await prompter.text({
    message: "Convex deployment URL",
    ...(env["CONVEX_URL"] !== undefined ? { default: env["CONVEX_URL"] } : {}),
    validate: URL_VALIDATOR,
  });
  const result = await probe({ url });
  if (!result.ok) throw new Error(result.error ?? "Convex probe failed");
  prompter.note(
    `  ✓ reachable (${result.latencyMs}ms${result.version !== undefined ? `, v${result.version}` : ""})`,
  );
  const deployKey = await prompter.secret({
    message: "Convex deploy key (paste from dashboard, blank to skip)",
  });
  return { url, deployKey };
}

async function verifySnowflake(
  prompter: Prompter,
  sf: SnowflakeAnswers,
  probe: InitDeps["probeSnowflake"],
): Promise<void> {
  const opensBrowser =
    sf.authenticator === "externalbrowser" ||
    sf.authenticator === "oauth-authorization-code";
  prompter.note(
    opensBrowser
      ? "\nTesting Snowflake connection (a browser window may open)..."
      : "\nTesting Snowflake connection...",
  );
  const auth: SnowflakeCreds["auth"] =
    sf.authenticator === "externalbrowser"
      ? { kind: "externalbrowser" }
      : sf.authenticator === "oauth-authorization-code"
        ? {
            kind: "oauth-authorization-code",
            clientStoreTemporaryCredential:
              sf.clientStoreTemporaryCredential ?? true,
          }
        : { kind: "password", password: sf.password ?? "" };
  const result = await probe({
    account: sf.account,
    user: sf.user,
    auth,
    warehouse: sf.warehouse,
    database: sf.database,
    schema: sf.schema,
    ...(sf.role !== "" ? { role: sf.role } : {}),
  });
  if (!result.ok) throw new Error(result.error ?? "Snowflake probe failed");
  prompter.note(`  ✓ connected (${result.latencyMs}ms)`);
}

/**
 * Pure orchestrator. Takes injected deps, returns a write plan. Does not
 * touch the filesystem — the CLI wrapper does that.
 */
export async function init(
  opts: InitOptions,
  deps: InitDeps,
): Promise<InitPlan> {
  const configPath = resolve(opts.configPath ?? "convex-snowflake.config.yaml");
  const envPath = resolve(opts.envPath ?? ".env.local");

  await confirmOverwrite(deps.prompter, configPath, opts.force);
  const convex = await collectConvex(deps.prompter, deps.env, deps.probeConvex);
  const discovery = deps.discoverSnowflakeConnections();
  const sf = await collectSnowflake(deps.prompter, deps.env, discovery);
  await verifySnowflake(deps.prompter, sf, deps.probeSnowflake);

  return {
    configPath,
    configYaml: renderConfigYaml(convex, sf),
    envPath,
    envAppend: renderEnvAppend(convex, sf),
  };
}

function renderConfigYaml(convex: ConvexAnswers, sf: SnowflakeAnswers): string {
  // Secrets stay in .env.local; YAML references them via ${VAR}. For browser
  // SSO / OAuth there is no secret to indirect — we emit `authenticator:`
  // instead. OAuth also persists a refresh-token flag.
  let authLines: string;
  if (sf.authenticator === "externalbrowser") {
    authLines = `  authenticator: externalbrowser\n`;
  } else if (sf.authenticator === "oauth-authorization-code") {
    const store = sf.clientStoreTemporaryCredential ?? true;
    authLines =
      `  authenticator: oauth-authorization-code\n` +
      `  client_store_temporary_credential: ${store}\n`;
  } else {
    authLines = `  password: \${SNOWFLAKE_PASSWORD}\n`;
  }
  const roleLine = sf.role !== "" ? `  role: \${SNOWFLAKE_ROLE}\n` : "";
  const provenance =
    sf.sourceConnection !== undefined
      ? ` (from connections.toml entry "${sf.sourceConnection}")`
      : "";
  return `# Written by \`convex-snowflake-connector init\`.${provenance} Secrets live in .env.local.
convex:
  url: \${CONVEX_URL}
${convex.deployKey !== "" ? "  admin_key: ${CONVEX_DEPLOY_KEY}\n" : ""}snowflake:
  account: \${SNOWFLAKE_ACCOUNT}
  user: \${SNOWFLAKE_USER}
${authLines}  database: ${sf.database}
  schema: ${sf.schema}
  warehouse: ${sf.warehouse}
${roleLine}sync:
  mode: full_refresh
  tables: "*"
`;
}

const ENV_BANNER = "# convex-snowflake-connector";

/**
 * Merge the wizard's env block into an existing `.env.local` without
 * duplicating keys on re-run. We extract the keys the wizard defines, strip
 * any prior lines from this codebase (matching keys, plus the banner comment),
 * and append the freshly rendered block. Lines the user added themselves are
 * preserved.
 */
export function mergeEnvAppend(existing: string, append: string): string {
  const managedKeys = new Set<string>();
  for (const line of append.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) managedKeys.add(line.slice(0, eq));
  }

  const kept = existing.split("\n").filter((line) => {
    if (line === ENV_BANNER) return false;
    if (line === "" || line.startsWith("#")) return true;
    const eq = line.indexOf("=");
    if (eq <= 0) return true;
    return !managedKeys.has(line.slice(0, eq));
  });
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();

  const base = kept.join("\n");
  const sep = base === "" ? "" : base.endsWith("\n") ? "\n" : "\n\n";
  return base + sep + append;
}

function renderEnvAppend(convex: ConvexAnswers, sf: SnowflakeAnswers): string {
  const lines = [ENV_BANNER, `CONVEX_URL=${convex.url}`];
  if (convex.deployKey !== "") {
    lines.push(`CONVEX_DEPLOY_KEY=${convex.deployKey}`);
  }
  lines.push(`SNOWFLAKE_ACCOUNT=${sf.account}`, `SNOWFLAKE_USER=${sf.user}`);
  if (sf.authenticator === "password" && sf.password !== undefined) {
    lines.push(`SNOWFLAKE_PASSWORD=${sf.password}`);
  }
  if (sf.role !== "") lines.push(`SNOWFLAKE_ROLE=${sf.role}`);
  return lines.join("\n") + "\n";
}

/** CLI entry: runs the wizard with real deps and writes the plan. */
export async function initCommand(opts: InitOptions): Promise<void> {
  const plan = await init(opts, {
    prompter: new ReadlinePrompter(),
    probeConvex,
    probeSnowflake,
    discoverSnowflakeConnections: () => discoverSnowflakeConnections(),
    env: process.env,
  });

  writeFileSync(plan.configPath, plan.configYaml, "utf8");

  // Merge into .env.local: preserve unrelated user vars, but replace our own
  // KEY=VALUE lines rather than duplicating them on re-run.
  const existing = existsSync(plan.envPath)
    ? readFileSync(plan.envPath, "utf8")
    : "";
  writeFileSync(plan.envPath, mergeEnvAppend(existing, plan.envAppend), "utf8");

  logger.info(
    { configPath: plan.configPath, envPath: plan.envPath },
    "init: wrote config and env",
  );
  process.stdout.write(
    `\n${green("✓")} ${bold("Setup complete.")}\n` +
      `  ${dim(plan.configPath)}\n` +
      `  ${dim(plan.envPath)}\n\n` +
      `${bold("Next steps:")}\n` +
      `  1. ${cyan("convex-snowflake-connector doctor")}\n` +
      `     ${dim("verify both Convex and Snowflake reachable from the saved config")}\n` +
      `  2. ${cyan("convex-snowflake-connector discover")}\n` +
      `     ${dim("infer table schemas (auto-runs `npx convex export` if needed)")}\n` +
      `  3. ${cyan("convex-snowflake-connector ddl")}\n` +
      `     ${dim("generate Snowflake CREATE TABLE statements (review before sync)")}\n` +
      `  4. ${cyan("convex-snowflake-connector sync")}\n` +
      `     ${dim("run the Convex → Snowflake load")}\n`,
  );
}
