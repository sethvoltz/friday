import { spawn } from "node:child_process";
import { join } from "node:path";
import { getLogPath } from "@friday/shared";
import { SERVICES, type ServiceName } from "./services.js";
import { writeState, type ServiceState } from "./state.js";
import {
  hasSession,
  killSession,
  newSession,
  getPanePid,
  getInnerPid,
  hasTmuxAvailable,
} from "./tmux.js";
import { assertArtifactFresh } from "./freshness.js";

/**
 * Spawn a service's prod artifact (`node <dist>/index.js`), write the
 * resulting state file, and return the PID. Throws on freshness failure
 * or spawn failure — caller decides whether to log+exit or surface up.
 */
export function launchProd(service: ServiceName, root: string): number {
  const info = SERVICES[service];
  const artifactPath = join(root, info.artifactPath);
  const srcDir = join(root, info.srcDir);

  assertArtifactFresh({
    artifactPath,
    srcDir,
    buildCommand: `pnpm --filter ${info.package} build`,
  });

  const child = spawn("node", [artifactPath], {
    cwd: root,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, FRIDAY_LOG_STDOUT: "off" },
  });
  if (!child.pid) throw new Error(`Failed to start ${info.label}`);

  const state: ServiceState = {
    pid: child.pid,
    mode: "prod",
    startedAt: new Date().toISOString(),
    command: ["friday", "start", service],
    logPath: getLogPath(service),
  };
  writeState(service, state);
  child.unref();
  return child.pid;
}

/**
 * Create a tmux session for the dev script of a service, capture the inner
 * PID, write state, and return the inner PID. Throws on missing tmux or
 * pane-pid resolution failure.
 */
export function launchDev(service: ServiceName, root: string): { innerPid: number; sessionName: string } {
  const info = SERVICES[service];

  if (!hasTmuxAvailable()) {
    throw new Error("tmux is not installed. Install via: brew bundle --file=Brewfile");
  }

  const sessionName = `friday-${service}`;
  if (hasSession(sessionName)) killSession(sessionName);

  const cwd = join(root, info.cwd);
  newSession(sessionName, `exec pnpm exec ${info.devCommand}`, cwd);

  const panePid = getPanePid(sessionName);
  if (!panePid) throw new Error(`Failed to read pane PID for ${sessionName}`);
  const innerPid = getInnerPid(panePid) ?? panePid;

  const state: ServiceState = {
    pid: innerPid,
    panePid,
    mode: "dev",
    startedAt: new Date().toISOString(),
    command: ["friday", "start", service, "--dev"],
    tmuxSession: sessionName,
    logPath: getLogPath(service),
  };
  writeState(service, state);
  return { innerPid, sessionName };
}
