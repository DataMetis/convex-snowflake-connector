declare module "yauzl-promise" {
  import type { Readable } from "node:stream";

  export interface Entry {
    filename: string;
    compressedSize: number;
    uncompressedSize: number;
    openReadStream(): Promise<Readable>;
  }

  export interface Zip extends AsyncIterable<Entry> {
    close(): Promise<void>;
  }

  export function open(path: string, options?: unknown): Promise<Zip>;
  export function fromBuffer(buffer: Buffer, options?: unknown): Promise<Zip>;
}
