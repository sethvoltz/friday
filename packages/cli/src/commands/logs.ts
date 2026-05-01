import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { getLogPath } from "@friday/shared";
import { type ServiceName, parseServiceArg } from "../services.js";
import { readState } from "../state.js";

interface LogsOptions {
  follow: boolean;
  pretty: boolean;
  lines: number;
}

const DEFAULT_LINES = 50;

function parseLogsArgs(args: string[]): { service: string | undefined; opts: LogsOptions } {
  const opts: LogsOptions = { follow: false, pretty: false, lines: DEFAULT_LINES };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-f" || a === "--follow") opts.follow = true;
    else if (a === "--pretty") opts.pretty = true;
    else if (a === "--json") opts.pretty = false;
    else if (a === "-n" || a === "--lines") {
      const n = parseInt(args[++i] ?? "", 10);
      if (!isNaN(n) && n > 0) opts.lines = n;
    } else {
      positional.push(a);
    }
  }
  return { service: positional[0], opts };
}

function readTail(path: string, lines: number): string[] {
  if (!existsSync(path)) return [];
  // Read in 64 KiB chunks from the end until we have enough newlines.
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    let position = size;
    let collected = "";
    const chunk = 64 * 1024;
    while (position > 0 && collected.split("\n").length <= lines + 1) {
      const toRead = Math.min(chunk, position);
      position -= toRead;
      const buf = Buffer.alloc(toRead);
      readSync(fd, buf, 0, toRead, position);
      collected = buf.toString("utf-8") + collected;
    }
    const allLines = collected.split("\n").filter(Boolean);
    return allLines.slice(Math.max(0, allLines.length - lines));
  } finally {
    closeSync(fd);
  }
}

const COLORS: Record<string, string> = {
  debug: "\x1b[2m",   // dim
  info: "\x1b[39m",   // default
  warn: "\x1b[33m",   // yellow
  error: "\x1b[31m",  // red
  fatal: "\x1b[1;31m", // bold red
};
const RESET = "\x1b[0m";

function formatPretty(line: string): string {
  try {
    const obj = JSON.parse(line) as { ts?: string; level?: string; event?: string };
    const color = COLORS[obj.level ?? "info"] ?? "";
    const ts = obj.ts ?? "";
    const level = (obj.level ?? "info").padEnd(5);
    const event = obj.event ?? "";
    const rest: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
    delete rest.ts;
    delete rest.level;
    delete rest.event;
    const tail = Object.keys(rest).length > 0 ? " " + JSON.stringify(rest) : "";
    return `${color}${ts}  ${level}  ${event}${tail}${RESET}`;
  } catch {
    return line;
  }
}

function emit(line: string, opts: LogsOptions): void {
  console.log(opts.pretty ? formatPretty(line) : line);
}

async function followLog(path: string, opts: LogsOptions): Promise<void> {
  let position = existsSync(path) ? statSync(path).size : 0;
  while (true) {
    if (!existsSync(path)) {
      await setTimeoutPromise(500);
      continue;
    }
    const size = statSync(path).size;
    if (size < position) {
      // Truncated/rotated
      position = 0;
    }
    if (size > position) {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(size - position);
        readSync(fd, buf, 0, size - position, position);
        position = size;
        const text = buf.toString("utf-8");
        for (const line of text.split("\n")) {
          if (line.length > 0) emit(line, opts);
        }
      } finally {
        closeSync(fd);
      }
    }
    await setTimeoutPromise(250);
  }
}

export async function logsCommand(args: string[]): Promise<void> {
  const { service: serviceArg, opts } = parseLogsArgs(args);
  const target = parseServiceArg(serviceArg);
  if (target === "all") {
    console.error("Specify a single service: friday logs <daemon|dashboard>");
    process.exit(1);
  }
  const service: ServiceName = target;

  // Prefer the path captured in state (so users get the canonical location
  // even if defaults change later), fall back to the convention.
  const state = readState(service);
  const path = state?.logPath ?? getLogPath(service);

  if (!existsSync(path)) {
    if (!opts.follow) {
      console.error(`No log file at ${path}`);
      process.exit(1);
    }
    // -f: wait for the file to appear
  } else {
    const tail = readTail(path, opts.lines);
    for (const line of tail) emit(line, opts);
  }

  if (opts.follow) {
    await followLog(path, opts);
  }
}
