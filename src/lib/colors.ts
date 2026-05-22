/**
 * Tiny ANSI color helper. We avoid pulling in chalk/picocolors because we
 * only need a handful of styles and the format is stable.
 *
 * Colors are auto-disabled when:
 *   - `NO_COLOR` is set (https://no-color.org/), or
 *   - stdout is not a TTY (e.g. when piped to `tee` or captured by CI).
 *
 * Set `FORCE_COLOR=1` to override the TTY check when you want colors in
 * captured output.
 */

function colorEnabled(): boolean {
  if (process.env["NO_COLOR"] !== undefined) return false;
  if (process.env["FORCE_COLOR"] !== undefined) return true;
  return process.stdout.isTTY === true;
}

const ENABLED = colorEnabled();

function wrap(open: string, close: string): (s: string) => string {
  return (s: string): string => (ENABLED ? `${open}${s}${close}` : s);
}

export const green = wrap("\x1b[32m", "\x1b[39m");
export const red = wrap("\x1b[31m", "\x1b[39m");
export const yellow = wrap("\x1b[33m", "\x1b[39m");
export const cyan = wrap("\x1b[36m", "\x1b[39m");
export const dim = wrap("\x1b[2m", "\x1b[22m");
export const bold = wrap("\x1b[1m", "\x1b[22m");
