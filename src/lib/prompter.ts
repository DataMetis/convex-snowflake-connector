import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * Abstract over user prompting so `init` is testable headlessly. Interactive
 * impl uses readline; scripted impl replays a queue of answers.
 */
export interface Prompter {
  text(question: TextQuestion): Promise<string>;
  secret(question: TextQuestion): Promise<string>;
  confirm(question: ConfirmQuestion): Promise<boolean>;
  select<T extends string>(question: SelectQuestion<T>): Promise<T>;
  /** Write a status line. Not a prompt — used for "Looking for X..." output. */
  note(message: string): void;
}

export interface TextQuestion {
  message: string;
  default?: string;
  validate?: (value: string) => string | null;
}

export interface ConfirmQuestion {
  message: string;
  default?: boolean;
}

export interface SelectQuestion<T extends string> {
  message: string;
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
  default?: T;
}

export class PromptCancelledError extends Error {
  constructor() {
    super("prompt cancelled");
    this.name = "PromptCancelledError";
  }
}

const CTRL_C = "";
const BACKSPACE_CHARS = new Set(["", "\b"]);

function readSecretLine(message: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    stdout.write(`${message}: `);
    let buf = "";
    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\n" || ch === "\r") {
          stdin.removeListener("data", onData);
          stdin.pause();
          stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === CTRL_C) {
          stdin.removeListener("data", onData);
          stdin.pause();
          reject(new PromptCancelledError());
          return;
        }
        if (BACKSPACE_CHARS.has(ch)) {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

export class ReadlinePrompter implements Prompter {
  async text(q: TextQuestion): Promise<string> {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      while (true) {
        const suffix = q.default !== undefined ? ` [${q.default}]` : "";
        const raw = await rl.question(`${q.message}${suffix}: `);
        const value = raw.trim() === "" ? (q.default ?? "") : raw.trim();
        const err = q.validate?.(value) ?? null;
        if (err === null) return value;
        stdout.write(`  ✗ ${err}\n`);
      }
    } finally {
      rl.close();
    }
  }

  async secret(q: TextQuestion): Promise<string> {
    while (true) {
      const value = await readSecretLine(q.message);
      const err = q.validate?.(value) ?? null;
      if (err === null) return value;
      stdout.write(`  ✗ ${err}\n`);
    }
  }

  async confirm(q: ConfirmQuestion): Promise<boolean> {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const hint = q.default === false ? "[y/N]" : "[Y/n]";
      const raw = (await rl.question(`${q.message} ${hint} `))
        .trim()
        .toLowerCase();
      if (raw === "") return q.default ?? true;
      return raw === "y" || raw === "yes";
    } finally {
      rl.close();
    }
  }

  async select<T extends string>(q: SelectQuestion<T>): Promise<T> {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      stdout.write(`${q.message}\n`);
      q.options.forEach((opt, i) => {
        const hint = opt.hint !== undefined ? `  (${opt.hint})` : "";
        stdout.write(`  ${i + 1}) ${opt.label}${hint}\n`);
      });
      const defaultIdx =
        q.default !== undefined
          ? Math.max(
              0,
              q.options.findIndex((o) => o.value === q.default),
            )
          : 0;
      while (true) {
        const raw = (await rl.question(`Choose [${defaultIdx + 1}]: `)).trim();
        const idx = raw === "" ? defaultIdx : Number.parseInt(raw, 10) - 1;
        const chosen = q.options[idx];
        if (chosen) return chosen.value;
        stdout.write(`  ✗ pick a number 1–${q.options.length}\n`);
      }
    } finally {
      rl.close();
    }
  }

  note(message: string): void {
    stdout.write(`${message}\n`);
  }
}

/**
 * Test-only prompter. Pre-load a sequence of answers; each prompt consumes
 * the next one. Throws if you run out — tests should script every prompt.
 */
export class ScriptedPrompter implements Prompter {
  private readonly answers: unknown[];
  public readonly notes: string[] = [];

  constructor(answers: ReadonlyArray<unknown>) {
    this.answers = [...answers];
  }

  private next<T>(kind: string): T {
    if (this.answers.length === 0) {
      throw new Error(`ScriptedPrompter: ran out of answers (needed ${kind})`);
    }
    return this.answers.shift() as T;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async text(_q: TextQuestion): Promise<string> {
    return this.next<string>("text");
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async secret(_q: TextQuestion): Promise<string> {
    return this.next<string>("secret");
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async confirm(_q: ConfirmQuestion): Promise<boolean> {
    return this.next<boolean>("confirm");
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async select<T extends string>(_q: SelectQuestion<T>): Promise<T> {
    return this.next<T>("select");
  }
  note(message: string): void {
    this.notes.push(message);
  }

  /** True if every scripted answer was consumed — useful for test assertions. */
  drained(): boolean {
    return this.answers.length === 0;
  }
}
