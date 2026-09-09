/**
 * stderr-only logging.
 *
 * Both entry points in this package speak a line protocol on stdout — the
 * bridge speaks MCP, the supervisor is spawned detached with stdout redirected
 * to a log file. Nothing may ever write diagnostics to stdout, so every logger
 * here goes to stderr (or to an explicitly opened file).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): LogLevel {
  const raw = (process.env["AGENT_WORKERS_LOG"] ?? "info").toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

function format(level: LogLevel, scope: string, args: unknown[]): string {
  const parts = args.map((a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  });
  return `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${parts.join(" ")}\n`;
}

/** A logger bound to a scope name. Writes to stderr, never stdout. */
export function createLogger(scope: string): Record<LogLevel, (...args: unknown[]) => void> {
  const min = ORDER[envLevel()];
  const emit = (level: LogLevel) => (...args: unknown[]): void => {
    if (ORDER[level] < min) return;
    try {
      process.stderr.write(format(level, scope, args));
    } catch {
      /* a closed stderr must never take the process down */
    }
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}
