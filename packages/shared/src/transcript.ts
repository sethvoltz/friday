import { createReadStream, statSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { watch, type FSWatcher } from "node:fs";

// ── Types ──────────────────────────────────────────────────────

/** Top-level JSONL entry types emitted by Claude Code sessions */
export type EntryType =
  | "user"
  | "assistant"
  | "queue-operation"
  | "last-prompt"
  | "attachment"
  | "ai-title";

/** A content block inside a message */
export interface ContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "tool_reference";
  /** Text content (type=text or type=thinking) */
  text?: string;
  /** Thinking content (type=thinking) */
  thinking?: string;
  /** Tool name (type=tool_use) */
  name?: string;
  /** Tool call ID (type=tool_use or type=tool_result) */
  id?: string;
  /** Tool input params (type=tool_use) */
  input?: Record<string, unknown>;
  /** Tool use ID for result correlation (type=tool_result) */
  tool_use_id?: string;
  /** Nested content in tool_result */
  content?: ContentBlock[] | string;
  /** Whether the tool errored (type=tool_result) */
  is_error?: boolean;
}

/** Token usage info from an assistant message */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** A raw JSONL entry from a Claude Code session */
export interface RawEntry {
  type: EntryType;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  message?: {
    role: "user" | "assistant";
    content: ContentBlock[];
    model?: string;
    usage?: TokenUsage;
    stop_reason?: string;
  };
  /** Queue operation type */
  operation?: "enqueue" | "dequeue";
  /** Attachment payload */
  attachment?: Record<string, unknown>;
  /** Last prompt text */
  lastPrompt?: string;
  /** Whether this is a sidechain message */
  isSidechain?: boolean;
}

/** A parsed turn — a user prompt followed by assistant response(s) */
export interface Turn {
  /** Turn index (0-based) */
  index: number;
  /** Timestamp of the user message that started this turn */
  timestamp: string;
  /** The user's prompt text (empty for tool_result-only user messages) */
  prompt: string;
  /** Assistant text responses concatenated */
  response: string;
  /** Tool calls made during this turn */
  toolCalls: ToolCallSummary[];
  /** Token usage for this turn */
  usage: TokenUsage;
  /** Model used */
  model: string | null;
}

/** Summary of a tool call within a turn */
export interface ToolCallSummary {
  /** Tool name */
  name: string;
  /** Tool call ID */
  id: string;
  /** Tool input (may be large — consumers can truncate) */
  input: Record<string, unknown>;
  /** Whether the result was an error */
  isError: boolean;
}

// ── Parsing ────────────────────────────────────────────────────

/**
 * Parse a single JSONL line into a RawEntry.
 * Returns null for unparseable lines.
 */
export function parseLine(line: string): RawEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as RawEntry;
  } catch {
    return null;
  }
}

/**
 * Parse all JSONL lines into RawEntry objects.
 * Skips blank/malformed lines.
 */
export function parseEntries(jsonl: string): RawEntry[] {
  return jsonl
    .split("\n")
    .map(parseLine)
    .filter((e): e is RawEntry => e !== null);
}

/**
 * Group raw entries into turns.
 *
 * A turn starts with a `user` entry whose message contains a `text` content
 * block (i.e., an actual user prompt, not a tool_result). Subsequent entries
 * (assistant responses, tool_use, tool_result round-trips) belong to that
 * turn until the next user text prompt.
 */
export function groupIntoTurns(entries: RawEntry[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const entry of entries) {
    // Skip non-message types
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (!entry.message) continue;

    if (entry.type === "user") {
      const textBlocks = entry.message.content.filter((b) => b.type === "text");
      const hasUserText = textBlocks.length > 0;

      if (hasUserText) {
        // Start a new turn
        current = {
          index: turns.length,
          timestamp: entry.timestamp ?? "",
          prompt: textBlocks.map((b) => b.text ?? "").join("\n"),
          response: "",
          toolCalls: [],
          usage: {},
          model: null,
        };
        turns.push(current);
      }
      // tool_result user messages belong to current turn (no new turn)
    }

    if (entry.type === "assistant" && current) {
      for (const block of entry.message.content) {
        if (block.type === "text" && block.text) {
          if (current.response) current.response += "\n\n";
          current.response += block.text;
        }
        if (block.type === "tool_use" && block.name && block.id) {
          current.toolCalls.push({
            name: block.name,
            id: block.id,
            input: block.input ?? {},
            isError: false,
          });
        }
      }

      // Capture usage from the last assistant message with usage
      if (entry.message.usage) {
        const u = entry.message.usage;
        current.usage = {
          input_tokens: (current.usage.input_tokens ?? 0) + (u.input_tokens ?? 0),
          output_tokens: (current.usage.output_tokens ?? 0) + (u.output_tokens ?? 0),
          cache_creation_input_tokens:
            (current.usage.cache_creation_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0),
          cache_read_input_tokens:
            (current.usage.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        };
      }

      if (entry.message.model && !current.model) {
        current.model = entry.message.model;
      }
    }

    // Mark tool errors on corresponding tool calls
    if (entry.type === "user" && current) {
      for (const block of entry.message.content) {
        if (block.type === "tool_result" && block.is_error && block.tool_use_id) {
          const tc = current.toolCalls.find((t) => t.id === block.tool_use_id);
          if (tc) tc.isError = true;
        }
      }
    }
  }

  return turns;
}

// ── File-level helpers ─────────────────────────────────────────

/**
 * Parse a session JSONL file into turns.
 * Reads the entire file — use `parseLastTurns` for large files.
 */
export async function parseTranscript(filePath: string): Promise<Turn[]> {
  const entries: RawEntry[] = [];

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }

  return groupIntoTurns(entries);
}

/**
 * Parse the last N turns from a JSONL file.
 *
 * Strategy: read the entire file but only keep the last N turns from the
 * grouped result. For truly large files, a reverse-read approach would be
 * better, but session files are typically <10MB so this is fine for V1.
 */
export async function parseLastTurns(filePath: string, n: number): Promise<Turn[]> {
  const all = await parseTranscript(filePath);
  return all.slice(-n);
}

// ── Streaming / tailing ────────────────────────────────────────

export interface TranscriptTailOptions {
  /** Callback for each new entry */
  onEntry: (entry: RawEntry) => void;
  /** Optional: also emit grouped turns as they complete */
  onTurn?: (turn: Turn) => void;
  /** Start from this byte offset (default: end of file) */
  startOffset?: number;
}

export interface TranscriptTailHandle {
  /** Stop watching */
  stop: () => void;
}

/**
 * Tail a session JSONL file, emitting new entries as they're appended.
 *
 * Uses `fs.watch` + readline on the new bytes. Optionally groups entries
 * into turns and emits completed turns.
 */
export function tailTranscript(
  filePath: string,
  opts: TranscriptTailOptions
): TranscriptTailHandle {
  let offset = opts.startOffset ?? (existsSync(filePath) ? statSync(filePath).size : 0);
  let watcher: FSWatcher | null = null;
  let processing = false;

  // For turn grouping
  const pendingEntries: RawEntry[] = [];

  const processNewData = async () => {
    if (processing) return;
    processing = true;

    try {
      if (!existsSync(filePath)) return;
      const currentSize = statSync(filePath).size;
      if (currentSize <= offset) return;

      const stream = createReadStream(filePath, {
        encoding: "utf-8",
        start: offset,
        end: currentSize - 1,
      });

      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        const entry = parseLine(line);
        if (entry) {
          opts.onEntry(entry);

          if (opts.onTurn) {
            pendingEntries.push(entry);

            // Check if this completes a turn (a new user text prompt starts the next turn)
            if (
              entry.type === "user" &&
              entry.message?.content.some((b) => b.type === "text")
            ) {
              // The new user message starts a new turn — emit the previous one
              const turns = groupIntoTurns(pendingEntries.slice(0, -1));
              for (const turn of turns) {
                opts.onTurn(turn);
              }
              // Keep only the new user message for the next turn
              pendingEntries.length = 0;
              pendingEntries.push(entry);
            }
          }
        }
      }

      offset = currentSize;
    } finally {
      processing = false;
    }
  };

  watcher = watch(filePath, { persistent: false }, (eventType) => {
    if (eventType === "change") {
      processNewData();
    }
  });

  // Process any data already past startOffset
  processNewData();

  return {
    stop: () => {
      watcher?.close();
      watcher = null;

      // Flush any remaining entries as a final turn
      if (opts.onTurn && pendingEntries.length > 0) {
        const turns = groupIntoTurns(pendingEntries);
        for (const turn of turns) {
          opts.onTurn(turn);
        }
        pendingEntries.length = 0;
      }
    },
  };
}

// ── Formatting ─────────────────────────────────────────────────

/**
 * Format a turn into a human-readable string.
 */
export function formatTurn(turn: Turn, opts?: { includeTools?: boolean }): string {
  const lines: string[] = [];

  lines.push(`── Turn ${turn.index + 1} (${turn.timestamp || "unknown time"}) ──`);
  lines.push(`User: ${turn.prompt}`);
  lines.push("");

  if (opts?.includeTools && turn.toolCalls.length > 0) {
    for (const tc of turn.toolCalls) {
      const status = tc.isError ? " [ERROR]" : "";
      lines.push(`  → ${tc.name}${status}`);
    }
    lines.push("");
  }

  lines.push(`Assistant: ${turn.response || "(no text response)"}`);

  if (turn.usage.input_tokens || turn.usage.output_tokens) {
    lines.push(
      `  Tokens: ${turn.usage.input_tokens ?? 0} in / ${turn.usage.output_tokens ?? 0} out`
    );
  }

  return lines.join("\n");
}

/**
 * Format multiple turns for display (e.g., `agent_inspect` output).
 */
export function formatTurns(
  turns: Turn[],
  opts?: { includeTools?: boolean }
): string {
  return turns.map((t) => formatTurn(t, opts)).join("\n\n");
}
