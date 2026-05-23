/**
 * ADR-022 spawn-permission gates and lineage telemetry for POST /api/agents.
 *
 * Two responsibilities, split out from `api/server.ts` so they are
 * independently testable:
 *
 *  1. `validateSpawnPermissions` — synchronous shape check. Given the
 *     caller's type (the agent that issued `agent_create`) and the spawn
 *     body, decide whether to reject up front. Orchestrator may spawn
 *     anything with no `reason`. Builder/helper may spawn helpers but
 *     not builders, and must include a non-empty `reason`. `bare` is
 *     only reachable when the orchestrator dispatches one — non-
 *     orchestrator callers that ask for `bare` fall through to the
 *     "only helper allowed" 403.
 *
 *  2. `computeSpawnDepth` — walk the parent chain up to the root,
 *     returning the new spawn's `depth` (1 = orchestrator, +1 per
 *     ancestor) and `parentChain` capped at the first 16 ancestors
 *     (oldest-first, orchestrator-rooted). Depth always counts the
 *     true distance even if the chain is truncated.
 */

import type { AgentEntry, AgentType } from "@friday/shared";

export const SPAWN_PARENT_CHAIN_CAP = 16;

export type CallerType = AgentType | "orchestrator";

export interface SpawnValidationInput {
  type: AgentType;
  reason?: string | null;
}

export interface SpawnRejection {
  status: 400 | 403;
  body: { error: string; code: "BUILDER_SPAWN_ORCHESTRATOR_ONLY" | "SPAWN_REASON_REQUIRED" };
}

/**
 * Returns null when the spawn is permitted. Returns a rejection envelope
 * (HTTP status + body) when it isn't. The caller is responsible for
 * sending that envelope back to the client.
 *
 * Implicit orchestrator: when no parent row exists, the daemon treats the
 * caller as the orchestrator (matches POST /api/chat/turn's implicit-
 * register path).
 */
export function validateSpawnPermissions(
  body: SpawnValidationInput,
  callerType: CallerType,
): SpawnRejection | null {
  if (callerType === "orchestrator") return null;

  // ADR-022 hard rule: builder→builder and helper→builder are forbidden.
  // Non-orchestrator callers may only spawn helpers; `bare` from a
  // non-orchestrator caller also falls through to this 403 (the existing
  // `agent_create` schema lets `bare` through, but only the orchestrator
  // is allowed to ask for one through this endpoint).
  if (body.type !== "helper") {
    return {
      status: 403,
      body: {
        error: "only the orchestrator can spawn builders",
        code: "BUILDER_SPAWN_ORCHESTRATOR_ONLY",
      },
    };
  }

  if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
    return {
      status: 400,
      body: {
        error: "reason required when spawner is not the orchestrator",
        code: "SPAWN_REASON_REQUIRED",
      },
    };
  }

  return null;
}

/**
 * Walks the parent chain up to the orchestrator (or until no parent row
 * is found, or the cap is hit). Returns `depth` (true distance: 1 for
 * orchestrator-rooted) and `parentChain` capped at SPAWN_PARENT_CHAIN_CAP
 * entries, oldest-first (so `[0]` is the orchestrator side, last entry
 * is the immediate parent).
 *
 * `getAgent` is injected to keep this function decoupled from the
 * registry module — the production caller passes `registry.getAgent`,
 * tests pass a fixture.
 */
export async function computeSpawnDepth(
  parentName: string | undefined | null,
  getAgent: (name: string) => Promise<AgentEntry | null>,
): Promise<{ depth: number; parentChain: string[] }> {
  if (!parentName) {
    // No parent: caller is the orchestrator. Depth 1 = orchestrator-rooted.
    return { depth: 1, parentChain: [] };
  }

  const chainNewestFirst: string[] = [];
  let cursor: string | null = parentName;
  const seen = new Set<string>();
  // Hard ceiling on the walk so a corrupted self-cycle can't spin
  // forever. SPAWN_PARENT_CHAIN_CAP * 2 is generous — the cap is
  // applied at the slice step below.
  const walkCeiling = SPAWN_PARENT_CHAIN_CAP * 64;
  let steps = 0;
  while (cursor && !seen.has(cursor) && steps < walkCeiling) {
    seen.add(cursor);
    chainNewestFirst.push(cursor);
    const row = await getAgent(cursor);
    if (!row) break;
    cursor = "parentName" in row ? (row.parentName ?? null) : null;
    steps++;
  }
  // chainNewestFirst is immediate-parent-first; flip so the orchestrator
  // sits at index 0 (matches the example in ADR-022 / the spec).
  const fullChain = chainNewestFirst.slice().reverse();
  const depth = fullChain.length + 1; // +1 for the new spawn itself
  const parentChain =
    fullChain.length > SPAWN_PARENT_CHAIN_CAP
      ? fullChain.slice(0, SPAWN_PARENT_CHAIN_CAP)
      : fullChain;
  return { depth, parentChain };
}
