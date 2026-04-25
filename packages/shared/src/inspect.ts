import { homedir } from "node:os";
import { join, basename } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { RegistryEntry } from "./agents.js";
import {
  parseTranscript,
  parseLastTurns,
  formatTurns,
  formatTurn,
  type Turn,
} from "./transcript.js";

// ── Types ──────────────────────────────────────────────────────

export interface InspectResult {
  agentName: string;
  agentType: string;
  status: string;
  parent?: string;
  sessionId: string | null;
  jsonlPath: string | null;
  turns: Turn[];
  totalTurns: number;
}

export interface InspectOptions {
  /** Number of recent turns to return (default: 5) */
  lastN?: number;
  /** Include tool call details (default: true) */
  includeTools?: boolean;
  /** Return all turns instead of just lastN */
  full?: boolean;
  /** Override CWD for path resolution (needed for orchestrator) */
  cwdOverride?: string;
}

// ── Path resolution ────────────────────────────────────────────

/**
 * Derive the session JSONL path from a registry entry.
 *
 * Claude Code stores session files at:
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * where encoded-cwd is the agent's working directory with `/` → `-`.
 *
 * Returns null if the entry has no sessionId or no determinable CWD.
 */
export function resolveTranscriptPath(
  entry: RegistryEntry,
  cwdOverride?: string
): string | null {
  if (!entry.sessionId) return null;

  const cwd =
    cwdOverride ??
    (entry.type === "builder" ? entry.workspace : null) ??
    (entry.type === "helper" ? entry.cwd : null);

  if (!cwd) return null;

  const encodedCwd = cwd.replace(/\//g, "-");
  return join(
    homedir(),
    ".claude",
    "projects",
    encodedCwd,
    `${entry.sessionId}.jsonl`
  );
}

/**
 * Resolve the transcript directory for a given CWD.
 * Returns `~/.claude/projects/<encoded-cwd>/` or null if it doesn't exist.
 */
export function resolveTranscriptDir(cwd: string): string | null {
  const encodedCwd = cwd.replace(/\//g, "-");
  const dir = join(homedir(), ".claude", "projects", encodedCwd);
  return existsSync(dir) ? dir : null;
}

/**
 * Discover all session JSONL files in a transcript directory.
 * Returns session IDs sorted by file mtime (most recent first).
 */
export function discoverSessions(cwd: string): Array<{ sessionId: string; mtime: Date }> {
  const dir = resolveTranscriptDir(cwd);
  if (!dir) return [];

  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const sessionId = basename(f, ".jsonl");
        const mtime = statSync(join(dir, f)).mtime;
        return { sessionId, mtime };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  } catch {
    return [];
  }
}

/**
 * Get the first and last timestamp from a session JSONL file.
 * Reads only the first and last lines for efficiency.
 */
export function getSessionDateRange(
  sessionId: string,
  cwd: string
): { firstAt: string; lastAt: string } | null {
  const dir = resolveTranscriptDir(cwd);
  if (!dir) return null;

  const jsonlPath = join(dir, `${sessionId}.jsonl`);
  if (!existsSync(jsonlPath)) return null;

  try {
    const content = readFileSync(jsonlPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;

    let firstAt = "";
    let lastAt = "";

    // Scan from start for first timestamp
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.timestamp) { firstAt = entry.timestamp; break; }
      } catch { /* skip */ }
    }

    // Scan from end for last timestamp
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.timestamp) { lastAt = entry.timestamp; break; }
      } catch { /* skip */ }
    }

    if (!firstAt) return null;
    return { firstAt, lastAt: lastAt || firstAt };
  } catch {
    return null;
  }
}

// ── Inspection ─────────────────────────────────────────────────

/**
 * Build a structured inspection result for an agent.
 *
 * Resolves the transcript path, parses turns, and returns metadata + turns.
 * Throws if the JSONL file does not exist.
 */
export async function buildInspectResult(
  agentName: string,
  entry: RegistryEntry,
  opts?: InspectOptions
): Promise<InspectResult> {
  const jsonlPath = resolveTranscriptPath(entry, opts?.cwdOverride);

  const base: InspectResult = {
    agentName,
    agentType: entry.type,
    status: entry.status,
    parent:
      "parent" in entry ? (entry.parent as string) : undefined,
    sessionId: entry.sessionId,
    jsonlPath,
    turns: [],
    totalTurns: 0,
  };

  if (!jsonlPath || !existsSync(jsonlPath)) {
    return base;
  }

  if (opts?.full) {
    const all = await parseTranscript(jsonlPath);
    base.turns = all;
    base.totalTurns = all.length;
  } else {
    const lastN = opts?.lastN ?? 5;
    // parseTranscript gives us totalTurns, parseLastTurns only gives the slice
    const all = await parseTranscript(jsonlPath);
    base.totalTurns = all.length;
    base.turns = all.slice(-lastN);
  }

  return base;
}

// ── Plain-text formatting ──────────────────────────────────────

/**
 * Format an inspection result as plain text (for CLI and MCP tool output).
 */
export function formatInspectPlain(
  result: InspectResult,
  opts?: { includeTools?: boolean }
): string {
  const lines: string[] = [];

  lines.push(`Agent: ${result.agentName} (${result.agentType})`);
  lines.push(`Status: ${result.status}`);
  if (result.parent) lines.push(`Parent: ${result.parent}`);

  if (result.turns.length === 0) {
    lines.push("", "No turns in transcript.");
    return lines.join("\n");
  }

  const showing =
    result.turns.length < result.totalTurns
      ? `Showing last ${result.turns.length} of ${result.totalTurns} turns:`
      : `${result.totalTurns} turns:`;
  lines.push(showing);
  lines.push("");

  lines.push(formatTurns(result.turns, { includeTools: opts?.includeTools ?? true }));

  return lines.join("\n");
}

// ── Markdown formatting ────────────────────────────────────────

/**
 * Format an inspection result as a full markdown document (for transcript export).
 */
export function formatInspectMarkdown(result: InspectResult): string {
  const lines: string[] = [];

  lines.push(`# Transcript: ${result.agentName}`);
  lines.push("");
  lines.push(`- **Type:** ${result.agentType}`);
  lines.push(`- **Status:** ${result.status}`);
  if (result.parent) lines.push(`- **Parent:** ${result.parent}`);
  if (result.sessionId) lines.push(`- **Session:** \`${result.sessionId}\``);
  lines.push(`- **Turns:** ${result.totalTurns}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const turn of result.turns) {
    lines.push(`## Turn ${turn.index + 1}`);
    if (turn.timestamp) lines.push(`_${turn.timestamp}_`);
    lines.push("");

    lines.push("### Prompt");
    lines.push("");
    lines.push(turn.prompt || "_empty_");
    lines.push("");

    if (turn.toolCalls.length > 0) {
      lines.push("### Tool Calls");
      lines.push("");
      for (const tc of turn.toolCalls) {
        const status = tc.isError ? " **[ERROR]**" : "";
        lines.push(`- \`${tc.name}\`${status}`);
        if (tc.input && Object.keys(tc.input).length > 0) {
          // Show a compact summary of input
          const inputStr = JSON.stringify(tc.input);
          const truncated =
            inputStr.length > 200
              ? inputStr.slice(0, 200) + "..."
              : inputStr;
          lines.push(`  \`\`\`json`);
          lines.push(`  ${truncated}`);
          lines.push(`  \`\`\``);
        }
      }
      lines.push("");
    }

    lines.push("### Response");
    lines.push("");
    lines.push(turn.response || "_no text response_");
    lines.push("");

    if (turn.usage.input_tokens || turn.usage.output_tokens) {
      lines.push(
        `> Tokens: ${turn.usage.input_tokens ?? 0} in / ${turn.usage.output_tokens ?? 0} out`
      );
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}
