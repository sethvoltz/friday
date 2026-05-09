import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MEMORY_DIR } from "@friday/shared";
import type { MemoryEntry } from "./store.js";

export type MemoryEventType = "created" | "updated" | "deleted" | "recalled";

export interface MemoryEvent {
  ts: string;
  type: MemoryEventType;
  id: string;
  entry?: Partial<MemoryEntry>;
}

const EVENTS_PATH = join(MEMORY_DIR, "events.jsonl");

export function logEvent(
  type: MemoryEventType,
  id: string,
  entry?: Partial<MemoryEntry>,
): void {
  const dir = dirname(EVENTS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const event: MemoryEvent = { ts: new Date().toISOString(), type, id, entry };
  appendFileSync(EVENTS_PATH, JSON.stringify(event) + "\n");
}
