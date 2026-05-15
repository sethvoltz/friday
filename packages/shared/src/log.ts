import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlink,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { createGzip } from "node:zlib";
import { getLogPath } from "./config.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface CreateLoggerOptions {
  service: string;
  /** "json" writes structured JSON to stdout; "off" suppresses stdout. */
  stdoutMode?: "json" | "off";
  /** Override the path; defaults to `getLogPath(service)`. */
  logPath?: string;
  /** Bytes before rotating; default 1 MiB. */
  rotateBytes?: number;
}

export interface Logger {
  log(level: LogLevel, event: string, data?: Record<string, unknown>): void;
  close(): void;
}

const DEFAULT_ROTATE_BYTES = 1024 * 1024;

export function createLogger(opts: CreateLoggerOptions): Logger {
  const path = opts.logPath ?? getLogPath(opts.service);
  const rotateBytes = opts.rotateBytes ?? DEFAULT_ROTATE_BYTES;
  const stdoutMode =
    opts.stdoutMode ??
    (process.env.FRIDAY_LOG_STDOUT === "off" ? "off" : "json");

  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });

  let fd = openSync(path, "a");

  function rotate(): void {
    closeSync(fd);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const rand = Math.random().toString(36).slice(2, 6);
    const rotated = path.replace(/\.jsonl$/, `-${ts}-${rand}.jsonl`);
    renameSync(path, rotated);
    // Compress async; we don't block log writes on it.
    const gzPath = `${rotated}.gz`;
    const src = createReadStream(rotated);
    const dest = createWriteStream(gzPath);
    dest.on("finish", () => {
      unlink(rotated, () => {
        // best-effort; leave the file if unlink fails
      });
    });
    src.pipe(createGzip()).pipe(dest);
    fd = openSync(path, "a");
  }

  function write(line: string): void {
    try {
      const stat = fstatSync(fd);
      if (stat.size >= rotateBytes) rotate();
    } catch {
      // ignore stat errors; just write
    }
    writeSync(fd, line);
  }

  function log(
    level: LogLevel,
    event: string,
    data?: Record<string, unknown>,
  ): void {
    const entry = {
      ts: new Date().toISOString(),
      level,
      service: opts.service,
      event,
      ...data,
    };
    const line = JSON.stringify(entry) + "\n";
    write(line);
    if (stdoutMode === "json") {
      process.stdout.write(line);
    }
  }

  function close(): void {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }

  return { log, close };
}
