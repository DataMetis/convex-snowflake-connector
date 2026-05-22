import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runConvexExport, type SpawnFn } from "../src/lib/extract.js";

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
}

function fakeSpawnFactory(behavior: {
  /** Called synchronously with the args the CLI received. */
  onSpawn?: (cmd: string, args: readonly string[]) => void;
  /** If set, write this file to disk before emitting 'close'. */
  produceFile?: { path: string; contents: string };
  /** Exit code emitted on 'close'. */
  exitCode?: number;
  /** Stderr lines to emit. */
  stderr?: string[];
}): SpawnFn {
  return (cmd, args) => {
    behavior.onSpawn?.(cmd, args);
    const child = new EventEmitter() as FakeChild;
    child.stdout = Readable.from([]);
    child.stderr = Readable.from(
      (behavior.stderr ?? []).map((l) => Buffer.from(l + "\n", "utf8")),
    );
    // Defer 'close' so the caller can attach listeners first.
    setImmediate(() => {
      if (behavior.produceFile) {
        writeFileSync(behavior.produceFile.path, behavior.produceFile.contents);
      }
      child.emit("close", behavior.exitCode ?? 0);
    });
    return child as unknown as ReturnType<SpawnFn>;
  };
}

describe("runConvexExport", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "csc-extract-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects outputPath that is not a .zip", async () => {
    await expect(
      runConvexExport({
        outputPath: join(dir, "out.tar"),
        spawnImpl: fakeSpawnFactory({ produceFile: undefined }),
      }),
    ).rejects.toThrow(/\.zip/);
  });

  it("invokes `npx convex export --path <zip>` and returns size on success", async () => {
    const outputPath = join(dir, "snap.zip");
    let captured: { cmd: string; args: readonly string[] } | undefined;
    const result = await runConvexExport({
      outputPath,
      spawnImpl: fakeSpawnFactory({
        onSpawn: (cmd, args) => {
          captured = { cmd, args };
        },
        produceFile: { path: outputPath, contents: "pretend-zip" },
      }),
    });

    expect(captured?.cmd).toBe("npx");
    expect(captured?.args).toEqual(["convex", "export", "--path", outputPath]);
    expect(result.zipPath).toBe(outputPath);
    expect(result.sizeBytes).toBe("pretend-zip".length);
  });

  it("passes --prod and --deployment-name when set", async () => {
    const outputPath = join(dir, "snap.zip");
    let captured: readonly string[] = [];
    await runConvexExport({
      outputPath,
      prod: true,
      deploymentName: "happy-otter-123",
      spawnImpl: fakeSpawnFactory({
        onSpawn: (_cmd, args) => {
          captured = args;
        },
        produceFile: { path: outputPath, contents: "x" },
      }),
    });
    expect(captured).toEqual([
      "convex",
      "export",
      "--path",
      outputPath,
      "--prod",
      "--deployment-name",
      "happy-otter-123",
    ]);
  });

  it("throws when the CLI exits non-zero", async () => {
    await expect(
      runConvexExport({
        outputPath: join(dir, "snap.zip"),
        spawnImpl: fakeSpawnFactory({ exitCode: 1 }),
      }),
    ).rejects.toThrow(/exited with code 1/);
  });

  it("includes captured stderr tail in the error on non-zero exit", async () => {
    await expect(
      runConvexExport({
        outputPath: join(dir, "snap.zip"),
        spawnImpl: fakeSpawnFactory({
          exitCode: 1,
          stderr: ["✖ You are not logged in.", "Run `npx convex login`."],
        }),
      }),
    ).rejects.toThrow(/not logged in.*convex login/);
  });

  it("throws when the CLI exits 0 but no file is produced", async () => {
    await expect(
      runConvexExport({
        outputPath: join(dir, "snap.zip"),
        spawnImpl: fakeSpawnFactory({ exitCode: 0 }),
      }),
    ).rejects.toThrow(/no file at/);
  });
});
