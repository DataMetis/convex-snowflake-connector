/**
 * Consent gate for `sync`. Refactored out of sync.ts so the orchestration
 * file stays under the project's line-count limit.
 *
 * Lives alongside sync.ts (not in lib/) because it is sync-specific —
 * other commands either don't mutate Snowflake or use their own gates.
 */

import { logger } from "../lib/logger.js";

export interface SyncRundown {
  /** Path to the Convex export ZIP that will be loaded. */
  source: string;
  /** Snowflake database that will be written to. */
  database: string;
  /** Snowflake schema that will be written to. */
  schema: string;
  /** Convex table paths that would be replaced this run. */
  tables: string[];
}

export class SyncConsentRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncConsentRequiredError";
  }
}

export class SyncCancelledError extends Error {
  constructor() {
    super("sync: cancelled by user");
    this.name = "SyncCancelledError";
  }
}

export interface ConsentInput {
  yes?: boolean;
  confirm?: (rundown: SyncRundown) => Promise<boolean>;
}

export async function ensureConsent(
  input: ConsentInput,
  rundown: SyncRundown,
): Promise<void> {
  if (input.yes === true) {
    logger.info({ consent: "--yes" }, "sync: consent granted via flag");
    return;
  }
  if (input.confirm === undefined) {
    throw new SyncConsentRequiredError(
      "sync: refusing to run without confirmation. " +
        "Pass `yes: true` (CLI: --yes) to acknowledge this is a destructive " +
        "full-refresh that replaces target Snowflake table contents " +
        "non-recoverably. Convex is not modified — this tool only reads from it.",
    );
  }
  const ok = await input.confirm(rundown);
  if (!ok) throw new SyncCancelledError();
}
