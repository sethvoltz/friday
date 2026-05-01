import { existsSync, readFileSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FRIDAY_DIR, atomicWriteFileSync } from "@friday/shared";

export const STATE_DIR = join(FRIDAY_DIR, "state");

export type ServiceMode = "dev" | "prod";

export interface ServiceState {
  /** Inner process to SIGTERM on stop. For dev (tmux): the process inside
   *  the pane (vite/tsx); for prod: the spawned `node`/`pnpm`. */
  pid: number;
  /** Tmux pane's foreground process — typically the shell or `pnpm exec`
   *  parent of `pid`. Only set in dev. Used to discover children when
   *  `pid` itself dies but its children leak. */
  panePid?: number;
  mode: ServiceMode;
  /** ISO 8601 timestamp of the start invocation. */
  startedAt: string;
  /** Argv as the user invoked it, e.g. ["friday", "start", "dashboard", "--dev"].
   *  Used by `restart` to relaunch with the same shape. */
  command: string[];
  /** Tmux session name (always `friday-<svc>` in dev). Absent in prod. */
  tmuxSession?: string;
  /** Path to the structured JSONL log for this service. */
  logPath: string;
}

function statePath(service: string): string {
  return join(STATE_DIR, `${service}.json`);
}

export function readState(service: string): ServiceState | null {
  const path = statePath(service);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ServiceState;
  } catch {
    return null;
  }
}

export function writeState(service: string, state: ServiceState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  atomicWriteFileSync(statePath(service), JSON.stringify(state, null, 2) + "\n");
}

export function removeState(service: string): void {
  const path = statePath(service);
  if (existsSync(path)) unlinkSync(path);
}

export function listStates(): string[] {
  if (!existsSync(STATE_DIR)) return [];
  return readdirSync(STATE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}
