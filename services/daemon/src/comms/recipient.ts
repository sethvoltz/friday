/**
 * Mail recipient validation (FRI-11 F2).
 *
 * Before mail_send writes a row, the daemon resolves the `to` field against
 * the agent registry. An unknown / archived recipient is rejected with a
 * useful error — and, when possible, a Levenshtein-nearest suggestion for
 * typo recovery. Prevents the silent-drop failure mode where mail addressed
 * to a nonexistent agent ("orchestrator" instead of "friday") sat in the DB
 * with nobody to deliver it to.
 */

import * as registry from "../agent/registry.js";

/**
 * Reserved symbolic recipients resolved at the daemon (FRI-11 F3).
 *
 * `parent` — the registered parentName of the calling agent.
 * `self`   — the calling agent itself (symmetric, rarely useful).
 */
export const SYMBOLIC_RECIPIENTS = new Set(["parent", "self"]);

export type RecipientResolution =
  | { ok: true; agent: string }
  | { ok: false; error: string };

/**
 * Resolve a symbolic recipient (`parent` / `self`) against the calling
 * agent's registry row. Literal names pass through unchanged.
 */
export function resolveRecipient(
  fromAgent: string,
  to: string,
): RecipientResolution {
  if (!SYMBOLIC_RECIPIENTS.has(to)) return { ok: true, agent: to };
  const caller = registry.getAgent(fromAgent);
  if (!caller) {
    return {
      ok: false,
      error: `cannot resolve "${to}": calling agent "${fromAgent}" is not registered`,
    };
  }
  if (to === "self") return { ok: true, agent: caller.name };
  // to === "parent"
  const parent = "parentName" in caller ? caller.parentName : undefined;
  if (!parent) {
    return {
      ok: false,
      error: `cannot resolve "parent": agent "${fromAgent}" has no registered parent`,
    };
  }
  return { ok: true, agent: parent };
}

export type RecipientCheck =
  | { ok: true; agent: string }
  | { ok: false; error: string; suggestion?: string };

/**
 * Verify the recipient name corresponds to a known, non-archived agent.
 * Falls back to a Levenshtein-nearest hint when the name is close to a real
 * one (distance ≤ 3, and strictly less than half the candidate's length).
 */
export function validateRecipient(name: string): RecipientCheck {
  if (!name || typeof name !== "string") {
    return { ok: false, error: "recipient name is required" };
  }
  const all = registry.listAgents();
  const live = all.filter((a) => a.status !== "archived");
  const match = live.find((a) => a.name === name);
  if (match) return { ok: true, agent: match.name };

  const archived = all.find((a) => a.name === name);
  if (archived) {
    return {
      ok: false,
      error: `recipient "${name}" exists but is archived`,
    };
  }

  const suggestion = nearestName(
    name,
    live.map((a) => a.name),
  );
  return {
    ok: false,
    error: suggestion
      ? `unknown recipient: "${name}" (did you mean "${suggestion}"?)`
      : `unknown recipient: "${name}"`,
    suggestion,
  };
}

function nearestName(target: string, candidates: string[]): string | undefined {
  let best: { name: string; dist: number } | undefined;
  for (const c of candidates) {
    const d = levenshtein(target, c);
    if (!best || d < best.dist) best = { name: c, dist: d };
  }
  if (!best) return undefined;
  // Reject far-off suggestions — anything beyond ~half the candidate length
  // is more noise than help.
  const threshold = Math.max(1, Math.floor(best.name.length / 2));
  if (best.dist > Math.min(3, threshold)) return undefined;
  return best.name;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}
