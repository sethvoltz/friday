/**
 * FS → Postgres projector for evolve proposals (item #54).
 *
 * Proposals are canonically stored as markdown files at
 * `~/.friday/evolve/proposals/<id>.md` (managed by `@friday/evolve`'s
 * store). The dashboard's `/evolve` page reads from a Zero reactive
 * query — which means the rows must also exist in Postgres so Zero
 * can replicate them.
 *
 * This module is the bridge:
 *   - `runEvolveBootSync()`: at daemon boot, walks every FS proposal
 *     and UPSERTs it into `evolve_proposals`. Idempotent (ON CONFLICT
 *     DO UPDATE), so a re-run after a daemon restart converges.
 *   - `syncProposalToPg(id)`: called by the daemon's HTTP/MCP handlers
 *     after every save/update; rebuilds the PG row from the FS file.
 *   - `deleteProposalFromPg(id)`: called after FS delete.
 *
 * The filesystem stays the source of truth during the transition
 * window. Future work (out of scope for this commit) lets the
 * dashboard issue create/update/dismiss mutators that the daemon
 * picks up via LISTEN/NOTIFY and applies to both stores — same
 * template as memory / schedule / apps. For now, dashboard /evolve
 * stays read-only and writes flow through MCP tools.
 */

import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@friday/shared";
import { getProposal, listProposals } from "@friday/evolve";
import { logger } from "../log.js";
import type { Proposal } from "@friday/evolve";

function proposalToRow(
  p: Proposal,
): typeof schema.evolveProposals.$inferInsert {
  return {
    id: p.id,
    title: p.title,
    proposalType: p.type,
    status: p.status,
    clusterId: p.clusterId,
    score: p.score,
    blastRadius: p.blastRadius,
    appliesTo: p.appliesTo as unknown as schema.evolveProposals["$inferInsert"]["appliesTo"],
    signals:
      p.signals as unknown as schema.evolveProposals["$inferInsert"]["signals"],
    body: p.proposedChange,
    createdBy: p.createdBy,
    createdAt: new Date(p.createdAt),
    updatedAt: new Date(p.updatedAt),
    appliedAt: p.appliedAt ? new Date(p.appliedAt) : null,
    appliedBy: p.appliedBy,
    enrichedAt: p.enrichedAt ? new Date(p.enrichedAt) : null,
    enrichedBy: p.enrichedBy,
    lastEnrichError: p.lastEnrichError,
    lastEnrichFailedAt: p.lastEnrichFailedAt
      ? new Date(p.lastEnrichFailedAt)
      : null,
    appliedTicketId: p.appliedTicketId,
  };
}

/**
 * Boot-time FS → PG sync. Idempotent — every row UPSERTs by id, so a
 * second boot after no FS changes is a no-op write set. Logs a single
 * summary line so the daemon log shows the projector ran without
 * spamming one log per proposal.
 */
export async function runEvolveBootSync(): Promise<void> {
  try {
    const proposals = listProposals();
    if (proposals.length === 0) {
      logger.log("info", "evolve.projector.boot-sync.empty", {});
      return;
    }
    const db = getDb();
    for (const p of proposals) {
      const row = proposalToRow(p);
      await db
        .insert(schema.evolveProposals)
        .values(row)
        .onConflictDoUpdate({
          target: schema.evolveProposals.id,
          set: {
            title: row.title,
            proposalType: row.proposalType,
            status: row.status,
            clusterId: row.clusterId,
            score: row.score,
            blastRadius: row.blastRadius,
            appliesTo: row.appliesTo,
            signals: row.signals,
            body: row.body,
            createdBy: row.createdBy,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            appliedAt: row.appliedAt,
            appliedBy: row.appliedBy,
            enrichedAt: row.enrichedAt,
            enrichedBy: row.enrichedBy,
            lastEnrichError: row.lastEnrichError,
            lastEnrichFailedAt: row.lastEnrichFailedAt,
            appliedTicketId: row.appliedTicketId,
          },
        });
    }
    // Drop any PG rows whose FS file is gone (deletes during downtime).
    const fsIds = new Set(proposals.map((p) => p.id));
    const pgIds = await db
      .select({ id: schema.evolveProposals.id })
      .from(schema.evolveProposals);
    let dropped = 0;
    for (const r of pgIds) {
      if (!fsIds.has(r.id)) {
        await db
          .delete(schema.evolveProposals)
          .where(eq(schema.evolveProposals.id, r.id));
        dropped += 1;
      }
    }
    logger.log("info", "evolve.projector.boot-sync.done", {
      upserted: proposals.length,
      dropped,
    });
  } catch (err) {
    logger.log("warn", "evolve.projector.boot-sync.error", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Hook called after every FS save/update. Re-reads the FS file and
 * UPSERTs the PG row. Best-effort: PG errors don't fail the FS write
 * (FS stays canonical during this transition window).
 */
export async function syncProposalToPg(id: string): Promise<void> {
  try {
    const p = getProposal(id);
    if (!p) {
      await deleteProposalFromPg(id);
      return;
    }
    const row = proposalToRow(p);
    const db = getDb();
    await db
      .insert(schema.evolveProposals)
      .values(row)
      .onConflictDoUpdate({
        target: schema.evolveProposals.id,
        set: {
          title: row.title,
          proposalType: row.proposalType,
          status: row.status,
          clusterId: row.clusterId,
          score: row.score,
          blastRadius: row.blastRadius,
          appliesTo: row.appliesTo,
          signals: row.signals,
          body: row.body,
          updatedAt: row.updatedAt,
          appliedAt: row.appliedAt,
          appliedBy: row.appliedBy,
          enrichedAt: row.enrichedAt,
          enrichedBy: row.enrichedBy,
          lastEnrichError: row.lastEnrichError,
          lastEnrichFailedAt: row.lastEnrichFailedAt,
          appliedTicketId: row.appliedTicketId,
        },
      });
  } catch (err) {
    logger.log("warn", "evolve.projector.sync.error", {
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  void sql; // silence unused import in this code path
}

export async function deleteProposalFromPg(id: string): Promise<void> {
  try {
    const db = getDb();
    await db
      .delete(schema.evolveProposals)
      .where(eq(schema.evolveProposals.id, id));
  } catch (err) {
    logger.log("warn", "evolve.projector.delete.error", {
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
