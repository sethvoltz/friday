import {
  openSync,
  writeSync,
  closeSync,
  mkdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { dirname, basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { randomBytes } from "node:crypto";
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
  /** Rotation threshold in bytes. Defaults to 1 MiB (DEFAULT_ROTATE_BYTES).
   *  Tune this if rotated files start piling up — eventually move to a
   *  config-file setting. */
  rotateBytes?: number;
}

/** 1 MiB. Single source of truth for the default rotation threshold. */
export const DEFAULT_ROTATE_BYTES = 1024 * 1024;

function resolveStdoutMode(override?: StdoutMode): StdoutMode {
  if (override) return override;
  const env = process.env.FRIDAY_LOG_STDOUT;
  if (env === "off") return "off";
  return "json";
}

/** Filename-safe ISO 8601 timestamp + random suffix.
 *  Two rotations within the same millisecond would otherwise overwrite each
 *  other; the random suffix makes collisions practically impossible. The
 *  timestamp prefix preserves chronological sortability. */
function rotatedSuffix(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = randomBytes(2).toString("hex");
  return `${ts}-${rand}`;
}

/**
 * Rotate the log file: gzip its current contents into a timestamped sibling
 * (`<svc>-<ts>.jsonl.gz`), then unlink the original. Synchronous because at
 * the 1 MiB default threshold gzip takes ~30ms — fine to block the calling
 * write. Caller is responsible for closing the FD before calling and
 * re-opening after.
 *
 * Crash window: between writeFileSync(rotatedPath) and unlinkSync(path) we
 * briefly have both files. On the next boot the new logger writes append-
 * only to `path` and the rotated file stays — no duplication, no loss.
 */
function rotateFile(path: string): void {
  if (!existsSync(path)) return;
  const data = readFileSync(path);
  if (data.length === 0) return;
  const dir = dirname(path);
  const base = basename(path).replace(/\.jsonl$/, "");
  const rotatedPath = join(dir, `${base}-${rotatedSuffix()}.jsonl.gz`);
  writeFileSync(rotatedPath, gzipSync(data));
  unlinkSync(path);
}

/**
 * Build a structured JSONL logger. The file descriptor is lazy — opened on
 * first write — so test runs of consumers (vitest loading hooks.server.ts,
 * for instance) don't create empty log files just by importing the module.
 *
 * Size-based rotation: when the current file passes `rotateBytes` (default
 * 1 MiB), the in-process write path closes the FD, gzips the file to a
 * timestamped sibling, deletes the original, and re-opens a fresh FD on
 * the next write. Rotated files are kept forever (no retention sweep).
 */
export function createLogger(opts: CreateLoggerOptions): Logger {
  const path = opts.logPath ?? getLogPath(opts.service);
  const stdoutMode = resolveStdoutMode(opts.stdoutMode);
  const rotateBytes = opts.rotateBytes ?? DEFAULT_ROTATE_BYTES;

  let fd: number | null = null;
  let closed = false;
  /** Current file size in bytes. Updated on open and after each write so we
   *  don't statSync per line. Resets to 0 after rotation. */
  let bytesOnDisk = 0;

  function open(): number {
    mkdirSync(dirname(path), { recursive: true });
    const handle = openSync(path, "a");
    try {
      bytesOnDisk = statSync(path).size;
    } catch {
      bytesOnDisk = 0;
    }
    return handle;
  }

  function ensureOpen(): number {
    if (fd !== null) return fd;
    if (closed) throw new Error(`Logger for ${opts.service} is already closed`);
    fd = open();
    return fd;
  }

  function rotateAndReopen(): void {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
      fd = null;
    }
    rotateFile(path);
    bytesOnDisk = 0;
    fd = open();
  }

  function write(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...data,
    };
    const line = JSON.stringify(entry) + "\n";
    const buf = Buffer.from(line, "utf-8");

    // Open (or pick up the existing FD) and check size FIRST so the active
    // file stays under threshold — the line we're about to write goes into
    // the fresh post-rotation file, not the soon-to-be-rotated one.
    ensureOpen();
    if (bytesOnDisk >= rotateBytes) {
      rotateAndReopen();
    }

    const written = writeSync(fd!, buf);
    bytesOnDisk += written;

    if (stdoutMode === "json") {
      if (level === "error" || level === "fatal") {
        console.error(line.trimEnd());
      } else {
        console.log(line.trimEnd());
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
