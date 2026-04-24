import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { MEMORY_DIR } from "./store.js";

const EVENTS_FILE = join(MEMORY_DIR, "events.jsonl");

export type MemoryEventType = "save" | "update" | "forget" | "search" | "recall";

export interface MemoryEvent {
  timestamp: string;
  event: MemoryEventType;
  actor: string;
  entryId?: string;
  query?: string;
  resultCount?: number;
  tags?: string[];
}

/**
 * Log a memory operation event to the events JSONL file.
 */
export function logEvent(event: MemoryEvent): void {
  mkdirSync(dirname(EVENTS_FILE), { recursive: true });
  appendFileSync(EVENTS_FILE, JSON.stringify(event) + "\n");
}
