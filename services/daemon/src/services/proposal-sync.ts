/**
 * FRI-66: when a Friday ticket transitions to a terminal status (`done`
 * or `closed`), find the evolve proposal that originated it and flip
 * the proposal to `applied`.
 *
 * Two valid linkage directions exist between ticket ↔ proposal:
 *
 *   - forward: `proposal.appliedTicketId === ticketId` (set by both
 *     `applyProposal()` in `@friday/evolve` and the daemon HTTP
 *     `/api/evolve/proposals/<id>/apply` endpoint).
 *   - backward: `ticket.meta.evolveProposalId === proposal.id` (set
 *     by the same two paths). Kept as a fallback because pre-existing
 *     proposals predating the `appliedTicketId` field still only have
 *     the backward link on the ticket side.
 *
 * The forward link is canonical and tried first; the backward link is
 * a fallback for tickets older than the schema field.
 *
 * Only `open` / `critical` / `approved` proposals are flipped. Terminal
 * (`applied` / `rejected` / `superseded`) statuses are left untouched
 * so this cascade can't overwrite a deliberate decision.
 */

import { getProposal, listProposals, updateProposal } from "@friday/evolve";
import { getTicket } from "@friday/shared/services";
import { syncProposalToPg } from "../evolve/projector.js";
import { logger } from "../log.js";

const APPLIED_BY_AUTO = "auto:ticket-close";

/**
 * Cascade-flip the originating evolve proposal to `applied` when its
 * linked ticket transitioned to a terminal status. Best-effort: any
 * failure is logged and swallowed so callers in close paths (agent
 * archive, Linear reconcile) are never blocked.
 */
export async function syncProposalForClosedTicket(ticketId: string): Promise<void> {
  try {
    const proposal = await findLinkedProposal(ticketId);
    if (!proposal) return;

    if (
      proposal.status !== "open" &&
      proposal.status !== "critical" &&
      proposal.status !== "approved"
    ) {
      // Already terminal — don't overwrite a deliberate decision.
      return;
    }

    const now = new Date().toISOString();
    const next = updateProposal(proposal.id, {
      status: "applied",
      appliedAt: now,
      appliedBy: APPLIED_BY_AUTO,
      appliedTicketId: ticketId,
    });
    if (!next) return;
    await syncProposalToPg(proposal.id);
    logger.log("info", "proposal.sync.applied", {
      proposalId: proposal.id,
      ticketId,
      priorStatus: proposal.status,
    });
  } catch (err) {
    logger.log("warn", "proposal.sync.error", {
      ticketId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function findLinkedProposal(ticketId: string) {
  // Forward link first: scan proposals for an exact appliedTicketId match.
  for (const p of listProposals()) {
    if (p.appliedTicketId === ticketId) return p;
  }
  // Fallback: read the ticket's meta.evolveProposalId.
  const ticket = await getTicket(ticketId);
  const proposalId =
    ticket?.meta && typeof ticket.meta === "object"
      ? (ticket.meta as Record<string, unknown>).evolveProposalId
      : null;
  if (typeof proposalId !== "string" || proposalId.length === 0) return null;
  return getProposal(proposalId);
}

export async function syncProposalsForClosedTickets(ticketIds: readonly string[]): Promise<void> {
  for (const id of ticketIds) {
    await syncProposalForClosedTicket(id);
  }
}
