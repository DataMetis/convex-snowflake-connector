import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../lib/config.js";
import { runConvexExport, type RunConvexExportResult } from "../lib/extract.js";
import { logger } from "../lib/logger.js";

export interface ExtractOptions {
  config: string;
  /** Where to write the .zip. Defaults to a temp file. */
  output?: string;
  /** Target the production deployment (passes --prod to convex). */
  prod?: boolean;
  /** Target a named deployment (passes --deployment-name). */
  deploymentName?: string;
}

export async function extract(
  opts: ExtractOptions,
): Promise<RunConvexExportResult> {
  // loadConfig validates the file even though `extract` itself doesn't use
  // most fields — we want one canonical "is this config sane?" entry point.
  loadConfig(opts.config);

  const outputPath = opts.output
    ? resolve(opts.output)
    : join(mkdtempSync(join(tmpdir(), "csc-extract-")), "convex-export.zip");

  return runConvexExport({
    outputPath,
    ...(opts.prod !== undefined ? { prod: opts.prod } : {}),
    ...(opts.deploymentName !== undefined
      ? { deploymentName: opts.deploymentName }
      : {}),
  });
}

export async function extractCommand(opts: ExtractOptions): Promise<void> {
  const result = await extract(opts);
  logger.info({ zipPath: result.zipPath }, "extract: done");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
