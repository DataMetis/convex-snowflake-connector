# @datametis/convex-snowflake-connector

A generic, project-agnostic CLI that syncs any [Convex](https://www.convex.dev/)
deployment into [Snowflake](https://www.snowflake.com/). One command exports
your Convex data, infers a schema, ensures Snowflake tables, and loads every
row — atomically.

```bash
npx @datametis/convex-snowflake-connector init   # interactive setup
npx @datametis/convex-snowflake-connector sync   # extract + load
```

Zero project-specific code — works against any Convex deployment.

## Why this exists

Convex is excellent for application state — reactive queries, transactional
writes, low-latency reads from your app. It is not a SQL warehouse: no `JOIN`
across tables at analytics scale, no native BI-tool integration, no window
functions, no ad-hoc SQL for analysts. Snowflake is the opposite. Teams that
ship on Convex eventually want both surfaces and end up writing one-off
export scripts that drift from the schema, miss new tables, and break
silently. This tool replaces that script: one command, schema-aware,
idempotent, and atomic per table — safe to put on a cron.

### How we keep Snowflake in sync with Convex

The CLI runs **scheduled full refreshes**. Every run exports the current
Convex state, infers schemas, ensures Snowflake tables, then loads each one
into a `<table>__csc_staging` table and `ALTER TABLE … SWAP WITH`s it into
place. The swap is atomic and metadata-only, so a failed sync never leaves
the warehouse in a partial state. Put it on a cron at whatever cadence
matches your staleness budget — hourly is typical, nightly is cheap.

Two patterns commonly compared against this:

- **Incremental batch** (only pull rows changed since the last watermark) is
  cheaper at scale, but on Convex it would need a watermark-aware extractor
  and a separate story for updates and deletes. `_creationTime` is a usable
  watermark for inserts; updates and deletes are the open question. Listed
  in the roadmap as merge-mode.
- **CDC** (stream every insert/update/delete as it happens) requires the
  source to expose a change log. Convex does not surface one today. When it
  does, this tool is where that work lands — see "Scope and non-goals" below.

For most analytics use cases, scheduled full refresh is the right answer.
It's the simplest thing that gives you a consistent, queryable copy of your
production data without needing any code on the Convex side.

## How it works

```
convex export ──► snapshot.zip ──► infer schema ──► CREATE OR REPLACE TABLE
                                              │
                                              └──► PUT @~/csc_stage/<table>/
                                                   CREATE OR REPLACE TABLE <t>__csc_staging LIKE <t>
                                                   COPY INTO <t>__csc_staging FROM (SELECT $1[col]::TYPE …)
                                                   ALTER TABLE <t> SWAP WITH <t>__csc_staging
```

1. **Extract.** Shells out to `npx convex export --path <tmp>.zip`. Auth is
   delegated to the user's environment (`CONVEX_DEPLOY_KEY` or local
   `.env.local`).
2. **Discover.** Reads each table's `documents.jsonl` from the ZIP, samples
   up to 1000 rows, and infers column types. Parsing `convex/schema.ts`
   directly was evaluated and rejected — convex-ents / `@convex-dev/auth`
   wrappers make it unreliable.
3. **DDL.** Emits `CREATE OR REPLACE TABLE` per table using the type map in
   [`src/lib/ddl.ts`](./src/lib/ddl.ts). `_id` is the PK (`VARCHAR`);
   `_creationTime` is `TIMESTAMP_NTZ`; objects / arrays / unions become
   `VARIANT`.
4. **Load.** Streams each NDJSON to a temp file, `PUT`s it to the user
   stage, creates a `<table>__csc_staging` table `LIKE` the target, `COPY
INTO` the staging table with `PURGE = TRUE`, then `ALTER TABLE … SWAP
   WITH` for an atomic, metadata-only cutover. If any step before the swap
   fails, the live target is untouched — there is no empty-table window.

## Installation

Requires Node ≥ 20.

```bash
# One-off use
npx @datametis/convex-snowflake-connector <command>

# Project install
npm install -D @datametis/convex-snowflake-connector
# or
bun add -d @datametis/convex-snowflake-connector
```

## Quick start

```bash
# 1. Generate convex-snowflake.config.yaml + .env.local
npx @datametis/convex-snowflake-connector init

# 2. Verify both sides are reachable
npx @datametis/convex-snowflake-connector doctor --config convex-snowflake.config.yaml

# 3. Run a sync
npx @datametis/convex-snowflake-connector sync --config convex-snowflake.config.yaml
```

To skip the `convex export` step (useful when iterating against a fixed
snapshot):

```bash
npx @datametis/convex-snowflake-connector sync -c convex-snowflake.config.yaml --from-zip ./snapshot.zip
```

`sync` will print a rundown of what it's about to do and require you to
type `yes` before mutating Snowflake. For non-interactive contexts (cron,
CI) pass `--yes` to acknowledge that the run replaces target table
contents non-recoverably. Convex is not modified — this tool only reads
from it.

## Configuration

`init` writes this file for you. Secrets live in `.env.local`; the YAML
references them via `${VAR}`.

```yaml
# convex-snowflake.config.yaml
convex:
  url: ${CONVEX_URL}
  admin_key: ${CONVEX_DEPLOY_KEY} # optional
snowflake:
  account: ${SNOWFLAKE_ACCOUNT}
  user: ${SNOWFLAKE_USER}
  password: ${SNOWFLAKE_PASSWORD} # or set `private_key:` for key-pair auth
  database: IHDB
  schema: PUBLIC
  warehouse: COMPUTE_WH
  role: ANALYST # optional
sync:
  mode: full_refresh
  tables: "*" # or an explicit list
```

## CLI reference

| Command    | Purpose                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| `init`     | Interactive wizard. Prompts for Convex + Snowflake credentials, runs live probes, writes the config + `.env.local`. |
| `doctor`   | Re-runs the same probes against existing config; exits non-zero on failure.                                         |
| `extract`  | Runs `convex export` to produce a snapshot ZIP. Standalone of `sync`.                                               |
| `discover` | Infers table schemas from a snapshot ZIP and emits JSON IR.                                                         |
| `ddl`      | Generates `CREATE OR REPLACE TABLE` SQL from a discovery result.                                                    |
| `sync`     | Full pipeline: extract → infer → ensure DDL → load.                                                                 |

Each command supports `--help` for full flag listings.

## Programmatic use

The library exports the same building blocks the CLI uses:

```ts
import {
  sync,
  loadConfig,
  openSession,
} from "@datametis/convex-snowflake-connector";

// `yes: true` acknowledges that sync replaces target Snowflake table
// contents non-recoverably. Convex is not modified — this tool only reads
// from it. Omit `yes` and pass a `confirm` callback to gate interactively.
await sync({ config: "./convex-snowflake.config.yaml", yes: true });
```

See [`src/index.ts`](./src/index.ts) for the full surface.

## Development

```bash
bun install
bun run dev      # tsup --watch
bun run test     # vitest
bun run build    # quality gates (typecheck → eslint → prettier) + tsup bundle
```

The codebase follows the conventions in [`CLAUDE.md`](./CLAUDE.md):
TypeScript strict, ESM-only, Zod-validated config, pino logging. Each
subcommand is a pure function in `src/commands/<name>.ts` with a thin CLI
wrapper.

## Scope and non-goals

**In scope:**

- One direction: Convex → Snowflake.
- Full-refresh mode: stage-and-swap atomic cutover per table.
- Zero project-specific knowledge — no code installed into the user's
  Convex deployment.

**Not in scope** (see [`CONVEX_SNOWFLAKE_CONNECTOR.md`](./CONVEX_SNOWFLAKE_CONNECTOR.md) for rationale):

- Merge mode (`MERGE INTO … ON _id`).
- Snowflake → Convex restore.
- CDC via Convex mutation hooks + Snowpipe.
- Verify layer (deterministic post-sync parity checks).
- Agent layer (anomaly narration, adaptive remediation).

## License

MIT.
