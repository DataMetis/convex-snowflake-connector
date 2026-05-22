import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { statSync } from "node:fs";
import { logger } from "./logger.js";

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export interface RunConvexExportOptions {
  /** Absolute path to write the .zip to. Must end with `.zip`. */
  outputPath: string;
  /** When true, pass `--prod`. Otherwise targets the local/dev deployment. */
  prod?: boolean;
  /** When set, pass `--deployment-name <name>` to target a named deployment. */
  deploymentName?: string;
  /** Working directory for the spawned process. Defaults to process.cwd(). */
  cwd?: string;
  /** Environment for the child. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Override the convex CLI invocation. Defaults to ["npx", "convex"]. */
  command?: readonly [string, ...string[]];
  /** Injectable for tests. */
  spawnImpl?: SpawnFn;
}

export interface RunConvexExportResult {
  zipPath: string;
  sizeBytes: number;
}

function buildArgs(opts: RunConvexExportOptions): {
  command: string;
  args: string[];
} {
  const [command, ...baseArgs] = opts.command ?? ["npx", "convex"];
  const args = [
    ...baseArgs,
    "export",
    "--path",
    opts.outputPath,
    ...(opts.prod ? ["--prod"] : []),
    ...(opts.deploymentName ? ["--deployment-name", opts.deploymentName] : []),
  ];
  return { command, args };
}

function pipeChildOutput(
  child: ChildProcessWithoutNullStreams,
  stderrBuf: string[],
): void {
  child.stdout.on("data", (buf: Buffer) => {
    for (const line of buf.toString("utf8").split(/\r?\n/)) {
      if (line.length > 0) logger.debug({ line }, "convex export: stdout");
    }
  });
  // Stream stderr to our own stderr so the user sees convex's real error
  // messages live, and stash a copy so we can include them in any thrown
  // error when the child exits non-zero.
  child.stderr.on("data", (buf: Buffer) => {
    const chunk = buf.toString("utf8");
    stderrBuf.push(chunk);
    process.stderr.write(chunk);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });
}

export async function runConvexExport(
  opts: RunConvexExportOptions,
): Promise<RunConvexExportResult> {
  if (!opts.outputPath.endsWith(".zip")) {
    throw new Error(
      `runConvexExport: outputPath must end with .zip, got ${opts.outputPath}`,
    );
  }
  const { command, args } = buildArgs(opts);
  const spawnFn = opts.spawnImpl ?? spawn;

  logger.info(
    { command, args, outputPath: opts.outputPath },
    "extract: running convex export",
  );

  const child = spawnFn(command, args, {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
  });
  const stderrBuf: string[] = [];
  pipeChildOutput(child, stderrBuf);
  const exitCode = await waitForExit(child);

  if (exitCode !== 0) {
    const tail = stderrBuf
      .join("")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(-5)
      .join(" | ");
    const detail = tail !== "" ? ` — last stderr: ${tail}` : "";
    throw new Error(
      `convex export exited with code ${exitCode} (command: ${command} ${args.join(" ")})${detail}`,
    );
  }

  let stat;
  try {
    stat = statSync(opts.outputPath);
  } catch (cause) {
    throw new Error(
      `convex export succeeded but no file at ${opts.outputPath}`,
      { cause },
    );
  }

  logger.info(
    { zipPath: opts.outputPath, sizeBytes: stat.size },
    "extract: convex export complete",
  );
  return { zipPath: opts.outputPath, sizeBytes: stat.size };
}
