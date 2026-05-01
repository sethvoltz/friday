import { openSync, writeSync, closeSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getLogPath } from "./config.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Stdout sink behavior. The CLI launcher controls this via FRIDAY_LOG_STDOUT:
 *   "json" — also write each JSONL line to stdout/stderr (dev mode default)
 *   "off"  — file only (prod mode default)
 * Unset env var falls back to "json" so the daemon's pre-existing
 * "tee everything to console" behavior is preserved when launched outside
 * the CLI (e.g. `pnpm dev` directly).
 */
export type StdoutMode = "json" | "off";

export interface Logger {
  log(level: LogLevel, event: string, data?: Record<string, unknown>): void;
  close(): void;
}

export interface CreateLoggerOptions {
  service: string;
  /** Override env-var-derived stdout mode; mainly for tests. */
  stdoutMode?: StdoutMode;
  /** Override the log path; mainly for tests. */
  logPath?: string;
}

function resolveStdoutMode(override?: StdoutMode): StdoutMode {
  if (override) return override;
  const env = process.env.FRIDAY_LOG_STDOUT;
  if (env === "off") return "off";
  return "json";
}

/**
 * Build a structured JSONL logger. The file descriptor is lazy — opened on
 * first write — so test runs of consumers (vitest loading hooks.server.ts,
 * for instance) don't create empty log files just by importing the module.
 */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const path = opts.logPath ?? getLogPath(opts.service);
  const stdoutMode = resolveStdoutMode(opts.stdoutMode);

  let fd: number | null = null;
  let closed = false;

  function ensureOpen(): number {
    if (fd !== null) return fd;
    if (closed) throw new Error(`Logger for ${opts.service} is already closed`);
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(path, "a");
    return fd;
  }

  function write(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...data,
    };
    const line = JSON.stringify(entry);

    writeSync(ensureOpen(), line + "\n");

    if (stdoutMode === "json") {
      if (level === "error" || level === "fatal") {
        console.error(line);
      } else {
        console.log(line);
      }
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore — already closed by OS, etc.
      }
      fd = null;
    }
  }

  return { log: write, close };
}
