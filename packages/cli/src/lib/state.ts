import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  STATE_DIR,
  statePathFor,
  type ServiceName,
} from "@friday/shared";

export type ServiceMode = "dev" | "prod";

export interface ServiceState {
  service: ServiceName;
  mode: ServiceMode;
  tmuxSession: string;
  startedAt: string;
}

export function readState(service: ServiceName): ServiceState | null {
  const path = statePathFor(service);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ServiceState;
  } catch {
    return null;
  }
}

export function writeState(state: ServiceState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const path = statePathFor(state.service);
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

export function clearState(service: ServiceName): void {
  const path = statePathFor(service);
  if (existsSync(path)) unlinkSync(path);
}

export function tmuxSessionFor(service: ServiceName): string {
  return `friday-${service}`;
}
