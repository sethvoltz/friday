// Friday Zero custom mutators (ADR-023, Phase 4).
//
// Zero 1.5's mutator model: a mutator is a function that runs once on
// the client (optimistic, against the local store) and once on the
// server (canonical, against Postgres) with the SAME implementation.
// The server's run is the source of truth; the client's run produces
// the optimistic UX. The framework guarantees:
//   - Idempotency on `mutation_id` — a retried mutator runs once at
//     the server.
//   - Server replay reproducible — given the same args + DB state, the
//     mutator must produce the same write set.
//
// Friday's mutators MUST also satisfy plan §5's race-condition contract:
//   - Every mutator idempotent on row primary key (not just
//     `mutation_id`). A duplicate insert with the same PK MUST collapse
//     to a no-op or UPSERT, not throw.
//   - Every fast-path endpoint (Phase 4.9+) idempotent against the
//     LISTEN-path equivalent. The mutator writes the row; the daemon's
//     LISTEN handler executes the side effect at most once even if
//     boot-recovery re-scans the row.
//
// Each mutator lives next to its plan checkbox in §4 of the plan file.
// Phase 4.1 ships `markRead`; subsequent sub-phases extend this file.

import type { CustomMutatorDefs, Transaction } from "@rocicorp/zero";
import type { Schema } from "./schema.js";

/* ---------------- Phase 4.1: markRead ---------------- */
// Per-device read cursor for unread-badge derivation. UPSERT on
// (device_id, agent_name) PK — multiple calls with the same args are
// no-ops, multiple calls advancing the cursor monotonically converge
// to the highest-seen block. The dashboard's unread badge derives:
//   `unread(agent) = blocks.count where agent_name=agent AND id > cursor`
// so a cursor update reactively zeroes the badge for that agent on the
// current device (per ADR-023's per-device default).
//
// No daemon side effect. The mutator is the entire operation: write the
// row, end. The mutator-framework idempotency lines up with the
// natural PK idempotency — multiple calls with the same blockId leave
// the row unchanged after the first, multiple calls with different
// blockIds converge on the most recent.

export interface MarkReadArgs {
  /** Sync target — Zero's WS-bound device id (from the JWT). */
  deviceId: string;
  /** Agent whose chat the user just viewed. */
  agentName: string;
  /** The id of the newest block the user has seen for this agent. */
  lastSeenBlockId: string;
  /** Client-side wall-clock ms. Server overwrites with its own clock
   *  to keep the diagnostic timestamp authoritative — see comments in
   *  the mutator body. */
  ts: number;
}

// Return type intentionally inferred — annotating with the generic
// `CustomMutatorDefs` collapses the specific shape, leaving
// `zero.mutate.markRead` etc. typed as `never` at the call site. The
// `satisfies` clause below verifies compatibility with the framework
// type while preserving the literal shape.

type FridayTx = Transaction<Schema>;

export const createMutators = () => ({
  markRead: async (tx: FridayTx, args: MarkReadArgs): Promise<void> => {
    // Zero's `tx.mutate.<table>.upsert` is the load-bearing primitive
    // here: it produces a single optimistic write on the client and a
    // single canonical UPSERT on the server, both keyed by the table's
    // PK (device_id, agent_name). Re-executing this mutator with the
    // same args is a guaranteed no-op (Postgres ON CONFLICT path).
    //
    // The server-side run overwrites `ts` with its own clock —
    // strictly speaking the client's `args.ts` is advisory because
    // device clocks drift. The diagnostic value comes from the
    // server-side ts.
    await tx.mutate.read_cursors.upsert({
      device_id: args.deviceId,
      agent_name: args.agentName,
      last_seen_block_id: args.lastSeenBlockId,
      ts: args.ts,
    });
  },
}) satisfies CustomMutatorDefs;

export type Mutators = ReturnType<typeof createMutators>;

// Convenience type alias to keep Zero<Schema, Mutators> readable at
// the call sites — the long generic argument is otherwise repeated
// across the dashboard's Zero client construction + tests.
export type FridaySchema = Schema;
