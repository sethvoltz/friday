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

export interface ServiceState {
  service: ServiceName;
  /** Set for tmux-supervised services (daemon, dashboard, zero-cache). */
  tmuxSession?: string;
  /** Set for pid-supervised services (tunnel). */
  pid?: number;
  startedAt: string;
}

/**
 * Pre-2026-05 state files carried a `mode: "dev" | "prod"` field — the
 * concept was retired with the path-to-prod work (FRI-83), since prod is
 * now the only thing the CLI launches. Older files load without error
 * because JSON.parse keeps the extra property in memory; this interface
 * just omits it so callers can't reference it. `writeState` doesn't
 * emit `mode` so the field disappears on the next rewrite.
 */
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
