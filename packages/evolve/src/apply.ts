/**
 * Programmatic proposal application. Used by the scheduled meta-agent's
 * batch-apply path; the orchestrator's `evolve_apply` MCP tool already does
 * its own application via the daemon API. Both end at the same place — a
 * proposal marked `applied`, with a memory entry or a ticket created.
 *
 * Adapted from the old SlackAgents Friday. The old `dispatch.ts` (beads-
 * based) is gone; code/prompt/config types now route through
 * `@friday/shared/services/tickets.createTicket` so they end up as
 * trackable Friday tickets the orchestrator (or human) reviews and applies
 * manually. Memory proposals still apply automatically.
 */

import { saveEntry } from "@friday/memory";
import { createTicket, type Ticket } from "@friday/shared/services";
import { getProposal, updateProposal } from "./store.js";
import type { Proposal } from "./types.js";

export type ApplyOutcome =
  | {
      ok: true;
      proposal: Proposal;
      appliedRef: string;
      ticket?: Ticket;
      restartHint?: string;
    }
  | { ok: false; reason: string };

const SELF_MOD_GUARD = "scheduled-meta-";

export interface ApplyOptions {
  appliedBy: string;
}

export async function applyProposal(
  id: string,
  opts: ApplyOptions,
): Promise<ApplyOutcome> {
  const proposal = getProposal(id);
  if (!proposal) return { ok: false, reason: `proposal not found: ${id}` };
  if (proposal.status === "applied")
    return { ok: false, reason: `proposal already applied: ${id}` };
  if (proposal.status === "rejected")
    return { ok: false, reason: `proposal was rejected: ${id}` };

  if (proposal.type === "memory") {
    const id = slugify(proposal.title);
    saveEntry({
      id,
      title: proposal.title,
      content: buildMemoryBody(proposal),
      tags: ["evolve", ...proposal.appliesTo],
      createdBy: opts.appliedBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      recallCount: 0,
      lastRecalledAt: null,
    });
    return markApplied(proposal, opts.appliedBy, `memory:${id}`);
  }

  // prompt / config / code: file as a ticket the orchestrator (or human)
  // reviews and applies manually. Self-modification guard blocks proposals
  // that would touch the meta-agent's own surfaces.
  if (touchesMetaAgent(proposal)) {
    return {
      ok: false,
      reason: `self-modification guard: ${proposal.type} proposals targeting \`scheduled-meta-*\` agents must be applied manually`,
    };
  }

  const ticket = createTicket({
    title: proposal.title,
    body: buildTicketBody(proposal),
    kind:
      proposal.type === "code"
        ? "task"
        : proposal.type === "config"
          ? "chore"
          : "task",
    meta: {
      evolveProposalId: proposal.id,
      proposalType: proposal.type,
      blastRadius: proposal.blastRadius,
    },
  });
  const applied = markApplied(
    proposal,
    opts.appliedBy,
    `ticket:${ticket.id}`,
    ticket,
  );
  return {
    ...applied,
    restartHint:
      proposal.type === "prompt"
        ? "Prompt change filed as a ticket. Review and edit `~/.friday/SOUL.md` or the relevant agent prompt, then restart."
        : proposal.type === "config"
          ? "Config change filed as a ticket. Review the proposed body and apply via `~/.friday/config.json` or the dashboard settings page."
          : "Code change filed as a ticket. Spawn a builder when ready.",
  };
}

function markApplied(
  proposal: Proposal,
  appliedBy: string,
  appliedRef: string,
  ticket?: Ticket,
): { ok: true; proposal: Proposal; appliedRef: string; ticket?: Ticket } {
  const updated = updateProposal(proposal.id, {
    status: "applied",
    appliedAt: new Date().toISOString(),
    appliedBy,
    appliedTicketId: ticket?.id ?? null,
  });
  return { ok: true, proposal: updated ?? proposal, appliedRef, ticket };
}

function touchesMetaAgent(proposal: Proposal): boolean {
  if (proposal.appliesTo.some((target) => target.includes(SELF_MOD_GUARD)))
    return true;
  return proposal.signals.some(
    (s) => s.agent?.startsWith(SELF_MOD_GUARD) ?? false,
  );
}

export function rejectProposal(
  id: string,
  opts: { rejectedBy: string; reason?: string },
): Proposal | null {
  const proposal = getProposal(id);
  if (!proposal) return null;
  if (proposal.status === "rejected") return proposal;
  return updateProposal(id, {
    status: "rejected",
    appliedAt: new Date().toISOString(),
    appliedBy: opts.reason
      ? `${opts.rejectedBy}: ${opts.reason}`
      : opts.rejectedBy,
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

function buildTicketBody(proposal: Proposal): string {
  const sections = [proposal.proposedChange.trim()];
  if (proposal.signals.length > 0) {
    const lines = proposal.signals.map(
      (s) =>
        `- \`${s.source}/${s.key}\` (${s.severity}, count=${s.count})`,
    );
    sections.push(`## Evidence\n\n${lines.join("\n")}`);
  }
  sections.push(
    `*Filed from evolve proposal \`${proposal.id}\` (${proposal.type}, blast: ${proposal.blastRadius}, score: ${proposal.score}).*`,
  );
  return sections.join("\n\n");
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
