/**
 * Tiny `.env` loader. The `init` wizard writes `.env.local` next to the
 * config YAML, and every other command resolves `${VAR}` references in that
 * YAML through `process.env`. Without an auto-loader, users have to remember
 * to `set -a; source .env.local; set +a` before each command — which is the
 * exact friction `init` exists to remove.
 *
 * Format we accept (the same subset `init` emits):
 *   - `KEY=value` per line
 *   - `# ...` comments and blank lines
 *   - optional surrounding quotes on the value
 *   - values are taken verbatim; we don't expand $VAR inside values
 *
 * Already-set env vars win — sourcing a file shouldn't override an explicit
 * shell export. Returns the keys it loaded (empty if file is missing).
 */

import { existsSync, readFileSync } from "node:fs";

export interface LoadEnvFileResult {
  path: string;
  loaded: string[];
  missing: boolean;
}

const LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function stripQuotes(v: string): string {
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

/**
 * Strip a trailing ` # comment` from an unquoted env value. Quoted values
 * preserve `#` verbatim inside, but a comment after the closing quote is
 * still removed. Standard dotenv behavior.
 *
 * Example: `prod:abc # team: foo` → `prod:abc`, but `"a # b"` → `"a # b"`.
 */
function stripInlineComment(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0]!;
    const closeIdx = trimmed.indexOf(quote, 1);
    if (closeIdx === -1) return trimmed; // unterminated quote — leave as-is
    return trimmed.slice(0, closeIdx + 1);
  }
  // Unquoted: cut at the first run of whitespace followed by '#'.
  const m = /\s+#/.exec(trimmed);
  return m === null ? trimmed : trimmed.slice(0, m.index);
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = LINE_RE.exec(line);
    if (m === null) continue;
    // Strip inline `# comment` first (dotenv standard), then surrounding
    // quotes, then trailing whitespace. Both have bitten us in the wild
    // (e.g. `CONVEX_DEPLOYMENT=prod:abc # team: foo, project: bar` ended up
    // passed to convex CLI as the whole string, parsed as " bar").
    out[m[1]!] = stripQuotes(stripInlineComment(m[2]!)).trim();
  }
  return out;
}

export function loadEnvFile(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): LoadEnvFileResult {
  if (!existsSync(path)) return { path, loaded: [], missing: true };
  const parsed = parseEnvFile(readFileSync(path, "utf8"));
  const loaded: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined) {
      env[k] = v;
      loaded.push(k);
    }
  }
  return { path, loaded, missing: false };
}
