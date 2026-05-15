/**
 * Closer dispatched from `archiveAgent` when an agent owns a Friday ticket.
 * Maps the archive `reason` to a local ticket status, then propagates the
 * state change to every external system listed in `ticket_external_links`
 * (Linear today; extensible for future GitHub/Jira/etc.).
 *
 * Read-side architecture (ADR-006) is preserved everywhere else; this module
 * is the deliberate, narrow write path — invoked only on archive transitions,
 * driven by Friday's authoritative local status.
 *
 * All failures are logged and swallowed. The closer must never bubble an
 * error into the lifecycle path that called it.
 */

import { setIssueStateByType } from "@friday/integrations-linear";
import {
  addComment,
  externalLinks,
  getTicket,
  type TicketStatus,
  updateTicket,
} from "@friday/shared/services";
import { logger } from "../log.js";

export type ArchiveReason = "completed" | "abandoned" | "failed" | "refork";

interface CloseInput {
  ticketId: string | null | undefined;
  reason: ArchiveReason;
  agentName: string;
}

function reasonToStatus(reason: ArchiveReason): TicketStatus | null {
  switch (reason) {
    case "completed":
      return "done";
    case "abandoned":
    case "failed":
      return "closed";
    case "refork":
      return null;
  }
}

// Linear's enum maps cleanly: done→completed, closed→canceled.
function statusToLinearStateType(
  status: TicketStatus,
): "completed" | "canceled" | null {
  switch (status) {
    case "done":
      return "completed";
    case "closed":
      return "canceled";
    default:
      return null;
  }
}

export async function closeTicketForArchive(input: CloseInput): Promise<void> {
  const { ticketId, reason, agentName } = input;
  if (!ticketId) return;

  const status = reasonToStatus(reason);
  if (status === null) return; // refork — leave the ticket alone

  try {
    const existing = getTicket(ticketId);
    if (!existing) {
      logger.log("warn", "ticket.close.stale", { ticketId, agentName, reason });
      return;
    }

    try {
      updateTicket(ticketId, { status });
    } catch (err) {
      logger.log("warn", "ticket.close.local.fail", {
        ticketId,
        agentName,
        reason,
        message: err instanceof Error ? err.message : String(err),
      });
      return; // don't try external propagation if local write failed
    }

    if (reason === "failed") {
      try {
        addComment(ticketId, agentName, "agent archived: failed");
      } catch (err) {
        logger.log("warn", "ticket.close.comment.fail", {
          ticketId,
          agentName,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await propagateExternal({ ticketId, status, agentName });
  } catch (err) {
    logger.log("warn", "ticket.close.fail", {
      ticketId,
      agentName,
      reason,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function propagateExternal(opts: {
  ticketId: string;
  status: TicketStatus;
  agentName: string;
}): Promise<void> {
  const links = externalLinks(opts.ticketId);
  if (links.length === 0) return;

  for (const link of links) {
    if (link.system === "linear") {
      await propagateLinear({
        ticketId: opts.ticketId,
        externalId: link.externalId,
        status: opts.status,
        agentName: opts.agentName,
      });
    } else {
      logger.log("info", "ticket.close.external.skip", {
        ticketId: opts.ticketId,
        system: link.system,
      });
    }
  }
}

async function propagateLinear(opts: {
  ticketId: string;
  externalId: string;
  status: TicketStatus;
  agentName: string;
}): Promise<void> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    logger.log("info", "ticket.close.external.linear.skip", {
      ticketId: opts.ticketId,
      externalId: opts.externalId,
      reason: "LINEAR_API_KEY not set",
    });
    return;
  }
  const stateType = statusToLinearStateType(opts.status);
  if (!stateType) {
    logger.log("info", "ticket.close.external.linear.skip", {
      ticketId: opts.ticketId,
      externalId: opts.externalId,
      reason: `no Linear stateType for status=${opts.status}`,
    });
    return;
  }
  try {
    await setIssueStateByType({
      apiKey,
      issueIdentifier: opts.externalId,
      stateType,
    });
    logger.log("info", "ticket.close.external.linear.ok", {
      ticketId: opts.ticketId,
      externalId: opts.externalId,
      stateType,
    });
  } catch (err) {
    logger.log("warn", "ticket.close.external.linear.fail", {
      ticketId: opts.ticketId,
      externalId: opts.externalId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
