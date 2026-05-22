import { createInterface } from "node:readline";
import { once } from "node:events";
import * as yauzl from "yauzl-promise";

export interface TableEntry {
  /** Directory path under the ZIP root (e.g. "rulers", "_components/aggregateShows/btree"). */
  path: string;
  /** Last segment of `path`. */
  name: string;
  /** True for "_"-prefixed top-level dirs (e.g. _storage, _tables) and anything under "_components/". */
  system: boolean;
  /** Compressed size of the documents.jsonl entry in the ZIP. Cheap to read for "is this table empty?" checks. */
  compressedSize: number;
}

export interface Snapshot {
  path: string;
  tables: TableEntry[];
  readDocuments(table: TableEntry): AsyncIterable<unknown>;
  close(): Promise<void>;
}

const DOCS_SUFFIX = "/documents.jsonl";

function isSystemPath(path: string): boolean {
  // Top-level "_<x>" or anything under "_components/".
  if (path.startsWith("_components/")) return true;
  return path.startsWith("_");
}

export async function openSnapshot(zipPath: string): Promise<Snapshot> {
  const zip = await yauzl.open(zipPath);
  // Collect all documents.jsonl entries up front. We keep the yauzl.Entry
  // objects around so openReadStream() can be called later without re-walking
  // the central directory.
  const entries = new Map<string, yauzl.Entry>();
  for await (const entry of zip) {
    const fn = entry.filename;
    if (fn.endsWith(DOCS_SUFFIX)) {
      const dir = fn.slice(0, -DOCS_SUFFIX.length);
      entries.set(dir, entry);
    }
  }

  const tables: TableEntry[] = [...entries.entries()]
    .map(([path, entry]) => ({
      path,
      name: path.split("/").pop() ?? path,
      system: isSystemPath(path),
      compressedSize: Number(entry.compressedSize),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    path: zipPath,
    tables,
    async *readDocuments(table: TableEntry): AsyncIterable<unknown> {
      const entry = entries.get(table.path);
      if (!entry) throw new Error(`Table not found in snapshot: ${table.path}`);
      const stream = await entry.openReadStream();
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          if (line.length === 0) continue;
          yield JSON.parse(line);
        }
      } finally {
        // Early break (or thrown error) leaves yauzl's read counter incremented
        // and blocks zip.close(). Destroy the stream and wait for the 'close'
        // event so yauzl's release-handler runs before any later zip.close().
        rl.close();
        if (!stream.destroyed) {
          stream.destroy();
          await once(stream, "close");
        }
      }
    },
    async close() {
      await zip.close();
    },
  };
}
