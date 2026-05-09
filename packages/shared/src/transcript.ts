/**
 * Parser for Claude Agent SDK session JSONL files at
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
 *
 * Each line is a self-contained JSON message representing one entry in the
 * session. We surface a typed view + a turn-grouping helper.
 */

export type EntryRole =
  | "user"
  | "assistant"
  | "system"
  | "tool_use"
  | "tool_result";

export interface RawEntry {
  type?: string;
  role?: string;
  message?: {
    role?: string;
    content?: unknown[];
  };
  uuid?: string;
  parentUuid?: string;
  sessionId?: string;
  timestamp?: string;
  /** Anything else the SDK emits. */
  [k: string]: unknown;
}

export function parseLine(line: string): RawEntry | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as RawEntry;
  } catch {
    return null;
  }
}

export function* parseEntries(jsonl: string): Generator<RawEntry> {
  for (const line of jsonl.split("\n")) {
    const e = parseLine(line);
    if (e) yield e;
  }
}

export interface ParsedTurn {
  index: number;
  role: EntryRole;
  ts: number;
  /** The raw JSON line for content_json storage. */
  rawJson: string;
  byteOff: number;
}

/**
 * Read raw entries with their byte offsets in the file. The byte offset is
 * useful for resumable tail-watching (start from offset N on restart).
 */
export interface EntryWithOffset {
  entry: RawEntry;
  rawJson: string;
  byteOff: number;
}

export function parseEntriesWithOffsets(
  jsonl: string,
): EntryWithOffset[] {
  const out: EntryWithOffset[] = [];
  let off = 0;
  for (const line of jsonl.split("\n")) {
    const lineLen = Buffer.byteLength(line, "utf8") + 1; // +1 for the newline
    const trimmed = line.trim();
    if (trimmed) {
      const entry = parseLine(line);
      if (entry) out.push({ entry, rawJson: line, byteOff: off });
    }
    off += lineLen;
  }
  return out;
}

export function entryRole(entry: RawEntry): EntryRole {
  const r = entry.role ?? entry.message?.role ?? entry.type;
  if (
    r === "user" ||
    r === "assistant" ||
    r === "system" ||
    r === "tool_use" ||
    r === "tool_result"
  ) {
    return r;
  }
  return "system";
}

export function entryTs(entry: RawEntry): number {
  if (typeof entry.timestamp === "string") {
    const t = Date.parse(entry.timestamp);
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}
