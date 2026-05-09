/**
 * Filesystem-backed continuity for scheduled agents.
 *
 * Each scheduled agent has a `~/.friday/schedules/<name>/` directory with
 * two files used to carry information across one-shot fires:
 *
 *  - `state.md` — agent-written. Cursors, partial results, "where I left
 *    off" notes. Auto-injected into the next run's first-turn prompt under
 *    a "State from your previous run" heading.
 *  - `last-run.md` — daemon-written. Timestamp / status / duration /
 *    session id of the previous run. Also auto-injected.
 *
 * Both files are capped at 64 KiB on injection. Ports the convention from
 * the old SlackAgents Friday at `services/friday/src/scheduler/trigger.ts`
 * + `agent/prime.ts`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "@friday/shared";

export const MAX_INJECTED_STATE_BYTES = 64 * 1024;

const SCHEDULES_ROOT = join(DATA_DIR, "schedules");

export function scheduleStateDir(scheduleName: string): string {
  return join(SCHEDULES_ROOT, scheduleName);
}

export function ensureScheduleStateDir(scheduleName: string): string {
  const dir = scheduleStateDir(scheduleName);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function truncateForInjection(raw: string): string {
  if (raw.length <= MAX_INJECTED_STATE_BYTES) return raw.trim();
  const head = raw.slice(0, MAX_INJECTED_STATE_BYTES);
  return (
    head.trim() +
    `\n\n[truncated at ${MAX_INJECTED_STATE_BYTES} bytes — original was ${raw.length} bytes]`
  );
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export interface BuildScheduledFirstTurnInput {
  scheduleName: string;
  taskPrompt: string;
}

export function buildFirstTurnWithState(
  input: BuildScheduledFirstTurnInput,
): string {
  const dir = ensureScheduleStateDir(input.scheduleName);
  const state = readIfExists(join(dir, "state.md"));
  const lastRun = readIfExists(join(dir, "last-run.md"));

  const sections: string[] = [input.taskPrompt.trim()];

  if (state && state.trim().length > 0) {
    sections.push(
      "## State from your previous run\n\n" + truncateForInjection(state),
    );
  }
  if (lastRun && lastRun.trim().length > 0) {
    sections.push(
      "## Last run metadata\n\n" + truncateForInjection(lastRun),
    );
  }

  sections.push(
    `## State directory\n\nYour stateDir is \`${dir}\`. Before you finish this run, write any cursors, progress markers, or partial results that the next run will need to \`${dir}/state.md\`. Be concise but complete; previous content is overwritten on each run.`,
  );

  return sections.join("\n\n");
}

export interface LastRunMetadata {
  timestamp: string;
  status: "complete" | "aborted" | "error";
  durationMs: number;
  sessionId?: string;
  summary?: string;
}

export function writeLastRun(
  scheduleName: string,
  meta: LastRunMetadata,
): void {
  const dir = ensureScheduleStateDir(scheduleName);
  const lines = [
    `- timestamp: ${meta.timestamp}`,
    `- status: ${meta.status}`,
    `- duration_ms: ${meta.durationMs}`,
    meta.sessionId ? `- session_id: ${meta.sessionId}` : null,
    meta.summary ? `- summary: ${meta.summary}` : null,
  ].filter((l): l is string => l !== null);
  writeFileSync(join(dir, "last-run.md"), lines.join("\n") + "\n");
}
