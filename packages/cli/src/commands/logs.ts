import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { dirname, basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { defineCommand } from "citty";
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

function readTailActive(path: string, lines: number): string[] {
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

/**
 * Find rotated siblings for an active log path: same directory, names of the
 * form `<base>-<timestamp>.jsonl.gz` where `<base>` is the active file's stem.
 * Returns paths sorted oldest-first by filename (timestamps are ISO and sort
 * lexicographically).
 */
function listRotated(activePath: string): string[] {
  const dir = dirname(activePath);
  const base = basename(activePath).replace(/\.jsonl$/, "");
  if (!existsSync(dir)) return [];
  const prefix = `${base}-`;
  const suffix = ".jsonl.gz";
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Tail across the active log + any rotated gzip siblings. Walks newest-first
 * and stops once `lines` lines are accumulated. Decompresses lazily — only
 * reads as far back into the rotated history as needed.
 */
function readTail(activePath: string, lines: number): string[] {
  const fromActive = readTailActive(activePath, lines);
  if (fromActive.length >= lines) return fromActive.slice(-lines);

  const rotated = listRotated(activePath); // oldest-first
  let collected = fromActive;
  for (let i = rotated.length - 1; i >= 0 && collected.length < lines; i--) {
    try {
      const text = gunzipSync(readFileSync(rotated[i])).toString("utf-8");
      const fileLines = text.split("\n").filter(Boolean);
      collected = [...fileLines, ...collected];
    } catch {
      // Corrupted gz — skip and keep walking. Don't fail the whole tail.
    }
  }
  return collected.slice(-lines);
}

import pc from "picocolors";

const COLORIZE: Record<string, (s: string) => string> = {
  debug: pc.dim,
  info: (s) => s,
  warn: pc.yellow,
  error: pc.red,
  fatal: (s) => pc.bold(pc.red(s)),
};

function formatPretty(line: string): string {
  try {
    const obj = JSON.parse(line) as { ts?: string; level?: string; event?: string };
    const colorize = COLORIZE[obj.level ?? "info"] ?? ((s: string) => s);
    const ts = obj.ts ?? "";
    const level = (obj.level ?? "info").padEnd(5);
    const event = obj.event ?? "";
    const rest: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
    delete rest.ts;
    delete rest.level;
    delete rest.event;
    const tail = Object.keys(rest).length > 0 ? " " + JSON.stringify(rest) : "";
    return colorize(`${ts}  ${level}  ${event}${tail}`);
  } catch {
    return line;
  }
}

function emit(line: string, opts: LogsOptions): void {
  console.log(opts.pretty ? formatPretty(line) : line);
}

async function followLog(path: string, opts: LogsOptions): Promise<void> {
  let position = existsSync(path) ? statSync(path).size : 0;
  let inode = existsSync(path) ? statSync(path).ino : 0;

  while (true) {
    if (!existsSync(path)) {
      await setTimeoutPromise(500);
      continue;
    }
    const st = statSync(path);
    // Rotation: gzip+rename created a new file at this path. Inode differs;
    // start tailing the new file from offset 0. The just-rotated file is
    // not followed (it's frozen and gzip'd).
    if (st.ino !== inode) {
      inode = st.ino;
      position = 0;
    } else if (st.size < position) {
      // Truncation without inode change (rare) — start over from the top.
      position = 0;
    }
    if (st.size > position) {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(st.size - position);
        readSync(fd, buf, 0, st.size - position, position);
        position = st.size;
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

export const logsCommandCitty = defineCommand({
  meta: {
    name: "logs",
    description:
      "Tail a service's structured JSONL log from ~/.friday/logs/<service>.jsonl. Works in both prod and dev modes.",
  },
  args: {
    service: {
      type: "positional",
      required: true,
      description: "daemon | dashboard",
    },
    follow: {
      type: "boolean",
      alias: "f",
      description: "Tail and follow new lines",
      default: false,
    },
    lines: {
      type: "string",
      alias: "n",
      description: "Print the last N lines (default: 50)",
    },
    pretty: {
      type: "boolean",
      description: "Colorize and pretty-print",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Force raw JSON output",
      default: false,
    },
  },
  async run({ args }) {
    const argv: string[] = [];
    if (typeof args.service === "string") argv.push(args.service);
    if (args.follow) argv.push("-f");
    if (args.pretty) argv.push("--pretty");
    if (args.json) argv.push("--json");
    if (typeof args.lines === "string" && args.lines.length > 0) {
      argv.push("-n", args.lines);
    }
    await logsCommand(argv);
  },
});

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
