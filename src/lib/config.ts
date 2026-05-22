import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadEnvFile, type LoadEnvFileResult } from "./env-file.js";
import { normalizeIdentifier } from "./snowflake-identifier.js";

const SnowflakeIdent = z.string().min(1).transform(normalizeIdentifier);

// Only full-refresh is implemented today. The enum is kept (rather than a
// literal) so additional modes can be added without changing the call sites
// that read `cfg.sync.mode`.
export const SyncMode = z.enum(["full_refresh"]);
export type SyncMode = z.infer<typeof SyncMode>;

export const ConfigSchema = z.object({
  convex: z.object({
    url: z.string().url(),
    admin_key: z.string().optional(),
  }),
  snowflake: z.object({
    account: z.string().min(1),
    user: z.string().min(1),
    /**
     * Explicit auth method. Omitted → inferred from which credential field is
     * present (password / private_key). Set to "externalbrowser" for SSO,
     * or "oauth-authorization-code" for Snowflake's OAuth code flow (the
     * Snowflake CLI default). Neither browser nor OAuth need a secret in
     * `.env.local` — the SDK opens a browser and caches the refresh token.
     */
    authenticator: z
      .enum([
        "password",
        "key-pair",
        "externalbrowser",
        "oauth-authorization-code",
      ])
      .optional(),
    password: z.string().optional(),
    private_key: z.string().optional(),
    /**
     * For OAuth/SSO authenticators: persist the refresh token in the OS
     * keychain so subsequent runs reuse it. Defaults to true (matches the
     * Snowflake CLI default).
     */
    client_store_temporary_credential: z.boolean().default(true),
    database: SnowflakeIdent,
    schema: SnowflakeIdent,
    warehouse: SnowflakeIdent,
    role: SnowflakeIdent.optional(),
  }),
  sync: z.object({
    mode: SyncMode.default("full_refresh"),
    tables: z.union([z.literal("*"), z.array(z.string()).min(1)]).default("*"),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

const ENV_VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export function interpolateEnv(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_VAR_RE, (_, name: string) => {
      const v = env[name];
      if (v === undefined) {
        throw new Error(`Environment variable ${name} is not set`);
      }
      return v;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateEnv(v, env));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateEnv(v, env);
    }
    return out;
  }
  return value;
}

export interface LoadConfigOptions {
  /**
   * Path to a `.env`-style file to load before resolving `${VAR}` references.
   * Defaults to `<config-dir>/.env.local`. Pass `false` to skip the auto-load.
   * Shell-exported vars always win over file contents.
   */
  envFile?: string | false;
}

export interface LoadConfigResult {
  config: Config;
  envFile: LoadEnvFileResult | null;
}

export function loadConfig(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadConfigOptions = {},
): Config {
  return loadConfigWithEnv(path, env, opts).config;
}

export function loadConfigWithEnv(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadConfigOptions = {},
): LoadConfigResult {
  if (!existsSync(path)) {
    throw new Error(
      `Config file not found at ${path}. Run \`convex-snowflake-connector init\` to create one, or pass --config <path>.`,
    );
  }
  let envFileResult: LoadEnvFileResult | null = null;
  if (opts.envFile !== false) {
    const envPath =
      opts.envFile !== undefined
        ? isAbsolute(opts.envFile)
          ? opts.envFile
          : resolve(opts.envFile)
        : resolve(dirname(path), ".env.local");
    envFileResult = loadEnvFile(envPath, env);
  }
  const raw: unknown = parseYaml(readFileSync(path, "utf8"));
  const interpolated = interpolateEnv(raw, env);
  return { config: ConfigSchema.parse(interpolated), envFile: envFileResult };
}
