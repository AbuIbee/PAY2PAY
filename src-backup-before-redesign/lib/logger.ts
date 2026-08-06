/**
 * Minimal structured logger. Emits single-line JSON so log output is
 * machine-parseable (NFR-OBS-001, docs/deliverables/05-nonfunctional-requirements.md).
 *
 * Deliberately dependency-free for Phase 0 — swap the `write` function below
 * for a library like pino if/when richer transport (log shipping, sampling)
 * is needed; the `logger.info/warn/error/debug` call sites would not need
 * to change.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  [key: string]: unknown;
}

function write(level: LogLevel, message: string, context?: LogContext): void {
  const entry = {
    level,
    message,
    time: new Date().toISOString(),
    ...context,
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (message: string, context?: LogContext) => write("debug", message, context),
  info: (message: string, context?: LogContext) => write("info", message, context),
  warn: (message: string, context?: LogContext) => write("warn", message, context),
  error: (message: string, context?: LogContext) => write("error", message, context),
};
