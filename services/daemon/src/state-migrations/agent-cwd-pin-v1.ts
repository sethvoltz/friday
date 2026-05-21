/**
 * FRI-61: rename SDK session JSONL transcripts (and their sidecar dirs)
 * from the old daemon-cwd-encoded layout to the new per-agent-home
 * encoded layout.
 *
 * Pre-FRI-61, the daemon ran with `process.cwd()` as the workingDirectory
 * for orchestrator/helper/scheduled agents. Post-FRI-61, those agents'
 * cwd is `~/.friday/agents/<name>/`. The Claude SDK keys session JSONLs
 * by `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, so the path
 * shift makes prior `agents.session_id` rows unreachable to the SDK's
 * resume path until the transcripts move.
 *
 * Approach (per ticket §3c):
 *   1. List every `~/.claude/projects/<dir>/` candidate.
 *   2. For every registry row with `session_id IS NOT NULL`, compute the
 *      new path and look up its old siblings across candidate dirs.
 *   3. Rename JSONL + sidecar dir (the SDK's `<sessionId>/tool-results/`
 *      overflow store) into place; EXDEV → copy + unlink fallback.
 *   4. Skip silently when destination exists (idempotent) or no source
 *      found (a row whose transcript never landed on disk).
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  encodeProjectDir,
  sessionFilePath,
  sessionSidecarDir,
} from "../agent/jsonl-paths.js";
import * as registry from "../agent/registry.js";
import { logger } from "../log.js";
import type { StateMigration } from "./runner.js";

interface MoveError {
  agent: string;
  session: string;
  message: string;
}

interface MoveOutcome {
  moved: boolean;
  sidecarMoved: boolean;
  from?: string;
  to?: string;
}

function projectsDir(): string {
  return join(homedir(), ".claude", "projects");
}

/**
 * Rename a file or directory across the filesystem. On EXDEV (cross-device
 * link, e.g. when `~/.claude` lives on a different volume than `~/.friday`),
 * falls back to copy + unlink. Non-atomic on the fallback path —
 * documented in the FRI-61 ticket.
 *
 * `realRename` is a seam for tests: production code uses `renameSync` and
 * the EXDEV fallback fires only when the kernel actually returns EXDEV.
 * Tests inject a throwing stub to exercise the fallback without needing
 * two real volumes.
 */
export function renameWithExdevFallback(
  from: string,
  to: string,
  realRename: (a: string, b: string) => void = renameSync,
): void {
  try {
    realRename(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  const isDir = statSync(from).isDirectory();
  if (isDir) {
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  } else {
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/** Visible for tests. */
export async function migrateOneAgent(
  agentName: string,
  sessionId: string,
  newCwd: string,
  errors: MoveError[],
): Promise<MoveOutcome> {
  const newJsonl = sessionFilePath(newCwd, sessionId);
  if (existsSync(newJsonl)) {
    logger.log("debug", "cwd-migration.skip.dest-exists", {
      agent: agentName,
      sessionId,
      to: newJsonl,
    });
    return { moved: false, sidecarMoved: false };
  }

  const root = projectsDir();
  if (!existsSync(root)) return { moved: false, sidecarMoved: false };
  const candidates = readdirSync(root);
  const newEncoded = encodeProjectDir(newCwd);

  for (const dir of candidates) {
    // Skip the destination dir; a partially-migrated dest would land here
    // and we'd loop on ourselves.
    if (dir === newEncoded) continue;
    const oldJsonl = join(root, dir, `${sessionId}.jsonl`);
    if (!existsSync(oldJsonl)) continue;
    const oldSidecar = join(root, dir, sessionId);

    try {
      mkdirSync(dirname(newJsonl), { recursive: true });
      renameWithExdevFallback(oldJsonl, newJsonl);
      let sidecarMoved = false;
      if (existsSync(oldSidecar) && statSync(oldSidecar).isDirectory()) {
        const newSidecar = sessionSidecarDir(newCwd, sessionId);
        renameWithExdevFallback(oldSidecar, newSidecar);
        sidecarMoved = true;
      }
      logger.log("info", "cwd-migration.moved", {
        agent: agentName,
        sessionId,
        from: oldJsonl,
        to: newJsonl,
        sidecarMoved,
      });
      return { moved: true, sidecarMoved, from: oldJsonl, to: newJsonl };
    } catch (err) {
      errors.push({
        agent: agentName,
        session: sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
      // Continue to next candidate — the failure may be transient (e.g.
      // permission), but if there's another copy of the JSONL under a
      // different prior cwd we may still succeed.
    }
  }
  return { moved: false, sidecarMoved: false };
}

export const agentCwdPinV1: StateMigration = {
  id: "agent-cwd-pin-v1",
  async run() {
    const root = projectsDir();
    if (!existsSync(root)) {
      return { movedSessions: 0, errors: [], note: "no ~/.claude/projects" };
    }

    const agents = await registry.listAgents();
    const errors: MoveError[] = [];
    let movedSessions = 0;

    for (const a of agents) {
      if (!a.sessionId) continue;
      const newCwd = await registry.workingDirectoryFor(a);
      const outcome = await migrateOneAgent(
        a.name,
        a.sessionId,
        newCwd,
        errors,
      );
      if (outcome.moved) movedSessions++;
    }

    return { movedSessions, errors };
  },
};
