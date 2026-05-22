import pino from "pino";

// Default level is `warn` — this is a CLI tool, not a server, so we don't
// want connection-lifecycle chatter on stderr unless the user opted in via
// `LOG_LEVEL=info` (or lower). pino-pretty stays on for TTY readability.
export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "warn",
  transport: {
    target: "pino-pretty",
    options: { colorize: true, translateTime: "HH:MM:ss.l" },
  },
});
