import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — yazl ships no types
import yazl from "yazl";
import { writeFileSync } from "node:fs";
import { openSnapshot } from "../src/lib/snapshot.js";

interface ZipFile {
  addBuffer(content: Buffer, path: string): void;
  end(): void;
  outputStream: NodeJS.ReadableStream;
}

async function buildFixtureZip(
  entries: Record<string, string>,
  outPath: string,
): Promise<void> {
  const zf = new (yazl as { ZipFile: new () => ZipFile }).ZipFile();
  for (const [path, content] of Object.entries(entries)) {
    zf.addBuffer(Buffer.from(content, "utf8"), path);
  }
  zf.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zf.outputStream as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  writeFileSync(outPath, Buffer.concat(chunks));
}

describe("openSnapshot", () => {
  let dir: string;
  let zipPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "csc-snap-"));
    zipPath = join(dir, "fixture.zip");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists user and system tables and streams documents", async () => {
    await buildFixtureZip(
      {
        "README.md": "fixture\n",
        "_tables/documents.jsonl": '{"name":"users","id":10001}\n',
        "_tables/generated_schema.jsonl": '"uniform"\n',
        "users/documents.jsonl":
          '{"_id":"a","name":"Alice"}\n{"_id":"b","name":"Bob"}\n',
        "users/generated_schema.jsonl": '"uniform"\n',
        "_components/foo/bar/documents.jsonl": '{"x":1}\n',
        "_components/foo/bar/generated_schema.jsonl": '"uniform"\n',
      },
      zipPath,
    );

    const snap = await openSnapshot(zipPath);
    try {
      const paths = snap.tables.map((t) => t.path).sort();
      expect(paths).toEqual(["_components/foo/bar", "_tables", "users"]);

      const users = snap.tables.find((t) => t.path === "users");
      expect(users?.system).toBe(false);
      expect(snap.tables.find((t) => t.path === "_tables")?.system).toBe(true);
      expect(
        snap.tables.find((t) => t.path === "_components/foo/bar")?.system,
      ).toBe(true);

      const docs: unknown[] = [];
      if (!users) throw new Error("users not found");
      for await (const d of snap.readDocuments(users)) docs.push(d);
      expect(docs).toEqual([
        { _id: "a", name: "Alice" },
        { _id: "b", name: "Bob" },
      ]);
    } finally {
      await snap.close();
    }
  });

  it("supports early break without leaking the underlying file handle", async () => {
    const lines = Array.from(
      { length: 100 },
      (_, i) => `{"_id":"${i}","n":${i}}\n`,
    ).join("");
    await buildFixtureZip(
      {
        "things/documents.jsonl": lines,
      },
      zipPath,
    );

    const snap = await openSnapshot(zipPath);
    const things = snap.tables.find((t) => t.path === "things");
    if (!things) throw new Error("things not found");
    let i = 0;
    for await (const _doc of snap.readDocuments(things)) {
      if (++i >= 3) break;
    }
    // close() must not throw "Cannot close while reading in progress".
    await snap.close();
    expect(i).toBe(3);
  });
});
