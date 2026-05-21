/**
 * Boot-time memory seeds (FRI-61).
 *
 * `seedRepoPins` writes friday's `pin-repo-agent-friday` memory entry if it
 * doesn't already exist. The entry tells the orchestrator where its own
 * source repo lives — pinned so it surfaces deterministically in every
 * system prompt assembly (auto-recall is FTS-keyed and wouldn't fire on
 * a mail wake-up).
 *
 * Resolution order:
 *   1. Explicit `path` argument (used by `friday memory pin-repo <path>`).
 *   2. `process.env.FRIDAY_REPO_PATH`.
 *   3. `loadConfig().fridayRepoPath` from `~/.friday/config.json`.
 *
 * If none of the above resolves, the seed silently no-ops — friday will
 * operate without direct repo affordance and the user can run the CLI
 * command later. No auto-detect from the daemon's install path: that
 * would land at the Homebrew Cellar, which is read-only and recreated
 * on every `brew upgrade`.
 *
 * Idempotent: keyed on the well-known id `pin-repo-agent-friday`. If the
 * entry already exists, the seed leaves it alone (the user / CLI may have
 * customized it).
 */

import { getEntry, saveEntry } from "@friday/memory";
import { loadConfig } from "@friday/shared";
import { logger } from "../log.js";

const REPO_PIN_ID = "pin-repo-agent-friday";

export function resolveAgentFridayRepo(explicit?: string): string | null {
  if (explicit) return explicit;
  const envRaw = process.env.FRIDAY_REPO_PATH;
  if (envRaw && envRaw.trim().length > 0) return envRaw.trim();
  try {
    const cfg = loadConfig();
    if (cfg.fridayRepoPath && cfg.fridayRepoPath.trim().length > 0) {
      return cfg.fridayRepoPath.trim();
    }
  } catch {
    // loadConfig() throws on malformed config.json; treat as "unset".
  }
  return null;
}

export async function seedRepoPins(opts?: {
  /** Override resolution — bypasses env and config. CLI hook. */
  path?: string;
  /** Force re-seed even if the entry exists. CLI hook. */
  force?: boolean;
}): Promise<void> {
  const repoPath = resolveAgentFridayRepo(opts?.path);
  if (!repoPath) {
    logger.log("debug", "memory.seed.repo-pin.skip", {
      reason: "no FRIDAY_REPO_PATH env or fridayRepoPath in config.json",
    });
    return;
  }

  const existing = await getEntry(REPO_PIN_ID);
  if (existing && !opts?.force) {
    logger.log("debug", "memory.seed.repo-pin.exists", { id: REPO_PIN_ID });
    return;
  }

  const now = new Date().toISOString();
  await saveEntry({
    id: REPO_PIN_ID,
    title: "agent-friday repo path",
    content:
      `The agent-friday repo lives at \`${repoPath}\`. Use this path when ` +
      `you need to Read, Edit, or run Bash against Friday's own source; ` +
      `open PRs against it; or hand a worktree off to a builder. Same ` +
      `pattern applies to any other repos pinned for you — each is on ` +
      `equal footing.`,
    tags: ["pinned", "repo"],
    createdBy: "friday",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    recallCount: existing?.recallCount ?? 0,
    lastRecalledAt: existing?.lastRecalledAt ?? null,
  });
  logger.log("info", "memory.seed.repo-pin.applied", {
    id: REPO_PIN_ID,
    path: repoPath,
    overwrote: !!existing,
  });
}
