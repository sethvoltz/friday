import { saveEntry } from "@friday/memory";
import { readRawConfig, writeConfig, type FridayConfig } from "@friday/shared";
import { getProposal, updateProposal, type Proposal } from "./store.js";
import { dispatchCodeProposal } from "./dispatch.js";

export type ApplyOutcome =
  | {
      ok: true;
      proposal: Proposal;
      appliedRef: string;
      restartHint?: string;
      /** Phase 5: set when a code proposal seeds a Beads epic. */
      epicId?: string;
    }
  | { ok: false; reason: string };

/**
 * Substring that, when present in any `appliesTo` entry, blocks auto-apply
 * for prompt/config proposals. Matches the same prefix used to gate the
 * scanner against feedback loops — letting evolve silently rewrite its own
 * brain (or its own thresholds) is the same anti-pattern as letting it scan
 * its own logs.
 */
const SELF_MOD_GUARD = "scheduled-meta-";

export interface ApplyOptions {
  /** Identifier of who's applying — "orchestrator", "dashboard", "cli", etc. */
  appliedBy: string;
  /** Inject a custom bd runner — used by tests so we don't spawn real bd. */
  runBd?: (args: string[]) => string;
  /** Override Beads workspace — used by tests. */
  beadsWorkspace?: string;
}

/**
 * Apply an approved proposal to the system. Each type lands on a different
 * surface:
 *   - memory  → `@friday/memory.saveEntry`
 *   - prompt  → writes `agent.systemPrompt` in `~/.friday/config.json`
 *   - config  → deep-merges JSON body into `~/.friday/config.json`
 *   - code    → seeds a Beads epic + mails the orchestrator to dispatch a Builder
 *
 * For code proposals, "applied" means the work is queued — we never spawn a
 * Builder ourselves because Builder creation is high-blast-radius and always
 * goes through the user-approval flow the orchestrator already owns.
 */
export function applyProposal(id: string, opts: ApplyOptions): ApplyOutcome {
  const proposal = getProposal(id);
  if (!proposal) return { ok: false, reason: `proposal not found: ${id}` };
  if (proposal.status === "applied") {
    return { ok: false, reason: `proposal already applied: ${id}` };
  }
  if (proposal.status === "rejected") {
    return { ok: false, reason: `proposal was rejected: ${id}` };
  }

  if (proposal.type === "memory") {
    const entry = saveEntry({
      title: proposal.title,
      content: buildMemoryBody(proposal),
      tags: ["evolve", ...proposal.appliesTo],
      createdBy: opts.appliedBy,
    });
    return markApplied(proposal, opts.appliedBy, `memory:${entry.id}`);
  }

  if (proposal.type === "prompt") {
    if (touchesMetaAgent(proposal)) {
      return {
        ok: false,
        reason:
          "self-modification guard: prompt proposals targeting `scheduled-meta-*` agents must be applied manually in the dashboard",
      };
    }
    const body = proposal.proposedChange.trim();
    if (!body) return { ok: false, reason: "prompt proposal has empty body" };

    const current = readRawConfig();
    const next: Partial<FridayConfig> = {
      ...current,
      agent: { ...(current.agent ?? {}), systemPrompt: body } as FridayConfig["agent"],
    };
    writeConfig(next);
    const applied = markApplied(proposal, opts.appliedBy, "config:agent.systemPrompt");
    return {
      ...applied,
      restartHint: "Restart the orchestrator to pick up the new system prompt.",
    };
  }

  if (proposal.type === "config") {
    if (touchesMetaAgent(proposal)) {
      return {
        ok: false,
        reason:
          "self-modification guard: config proposals targeting `scheduled-meta-*` agents must be applied manually in the dashboard",
      };
    }
    const body = proposal.proposedChange.trim();
    let patch: Partial<FridayConfig>;
    try {
      patch = JSON.parse(body) as Partial<FridayConfig>;
    } catch {
      return {
        ok: false,
        reason: "config proposal body must be JSON parseable as Partial<FridayConfig>",
      };
    }
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return { ok: false, reason: "config proposal must be a JSON object" };
    }

    const current = readRawConfig();
    const next = mergeConfig(current, patch);
    writeConfig(next);
    const keys = Object.keys(patch).join(", ") || "(none)";
    const applied = markApplied(proposal, opts.appliedBy, `config:${keys}`);
    return {
      ...applied,
      restartHint: "Some config changes only take effect after restarting affected services.",
    };
  }

  if (proposal.type === "code") {
    let dispatched: { epicId: string; mailId: string };
    try {
      dispatched = dispatchCodeProposal(proposal, {
        appliedBy: opts.appliedBy,
        runBd: opts.runBd,
        workspace: opts.beadsWorkspace,
      });
    } catch (err) {
      return {
        ok: false,
        reason: `code dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const applied = markApplied(proposal, opts.appliedBy, `epic:${dispatched.epicId}`);
    return {
      ...applied,
      epicId: dispatched.epicId,
      restartHint:
        `Mail ${dispatched.mailId} sent to orchestrator. ` +
        `Confirm scope before the Builder is dispatched.`,
    };
  }

  return { ok: false, reason: `unknown proposal type: ${proposal.type}` };
}

function markApplied(
  proposal: Proposal,
  appliedBy: string,
  appliedRef: string
): { ok: true; proposal: Proposal; appliedRef: string } {
  const updated = updateProposal(proposal.id, {
    status: "applied",
    appliedAt: new Date().toISOString(),
    appliedBy,
  });
  return { ok: true, proposal: updated ?? proposal, appliedRef };
}

function touchesMetaAgent(proposal: Proposal): boolean {
  if (proposal.appliesTo.some((target) => target.includes(SELF_MOD_GUARD))) return true;
  return proposal.signals.some((s) => s.agent?.startsWith(SELF_MOD_GUARD) ?? false);
}

/**
 * Shallow merge by top-level config section. Top-level fields are merged
 * key-by-key (so `agent.model` patches don't wipe `agent.workingDirectory`)
 * but emoji subobjects under slack_formatting are merged one level deeper
 * to match how loadConfig() composes defaults.
 */
function mergeConfig(
  current: Partial<FridayConfig>,
  patch: Partial<FridayConfig>
): Partial<FridayConfig> {
  const out: Partial<FridayConfig> = { ...current };
  for (const [key, value] of Object.entries(patch) as [keyof FridayConfig, any][]) {
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (current as any)[key] === "object" &&
      (current as any)[key] !== null
    ) {
      (out as any)[key] = { ...(current as any)[key], ...value };
    } else {
      (out as any)[key] = value;
    }
  }
  return out;
}

/**
 * Mark a proposal rejected with an optional reason recorded in appliedBy.
 * Rejection is terminal — the next scan won't merge new occurrences into it
 * because findProposalBySignalHash skips rejected proposals.
 */
export function rejectProposal(id: string, opts: { rejectedBy: string; reason?: string }): Proposal | null {
  const proposal = getProposal(id);
  if (!proposal) return null;
  if (proposal.status === "rejected") return proposal;

  return updateProposal(id, {
    status: "rejected",
    appliedAt: new Date().toISOString(),
    appliedBy: opts.reason ? `${opts.rejectedBy}: ${opts.reason}` : opts.rejectedBy,
  });
}

function buildMemoryBody(proposal: Proposal): string {
  const signalLines = proposal.signals
    .map((s) => {
      const agent = s.agent ? ` agent=${s.agent}` : "";
      return `- ${s.key}${agent} (${s.count}x, severity=${s.severity})`;
    })
    .join("\n");

  return [
    proposal.proposedChange.trim(),
    "",
    "---",
    `Recorded from evolve proposal \`${proposal.id}\`.`,
    "Signals:",
    signalLines,
  ].join("\n");
}
