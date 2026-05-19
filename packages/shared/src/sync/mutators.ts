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

/* ---------------- Phase 4.2: reportClientStats ---------------- */
// Per-device storage telemetry. UPSERTs `client_devices` with the
// device's current `navigator.storage.estimate()` reading. PK is
// `device_id` — re-running with same args = no row-shape change;
// re-running with newer storage numbers advances the row. The
// client fires this every 5 minutes while active + on each Zero
// (re)connect.
//
// `first_seen_at` and `user_id` are pinned by the server-side
// `/api/sync/refresh` upsert path (the only place they originate);
// the client mutator only touches the fields it owns
// (storage_used_bytes, storage_quota_bytes, last_seen_at,
// last_sync_at). Postgres ON CONFLICT semantics preserve untouched
// columns so user_id / first_seen_at can't be clobbered by a stale
// client.
//
// No daemon side effect. Telemetry only.

export interface ReportClientStatsArgs {
  deviceId: string;
  /** From `navigator.storage.estimate().usage`. Optional — some
   *  browsers (older Safari) don't return it. */
  storageUsedBytes?: number;
  /** From `navigator.storage.estimate().quota`. */
  storageQuotaBytes?: number;
  ts: number;
}

/* ---------------- Phase 4.2: forgetDevice ---------------- */
// Remove a `client_devices` row by `device_id`. The Settings → Devices
// surface invokes this from the "Forget this device" button (Phase 6
// UI lands later; the mutator is in place now).
//
// Idempotency: re-running with the same deviceId is a no-op
// (the row is already gone — Drizzle DELETE WHERE NOT EXISTS is
// a 0-row outcome, not an error).
//
// Per ADR-023 line 564 + the comment in `forgetClientDevice`:
// "the next time that client tries to refresh its JWT, the mint
// endpoint will re-upsert and the user will need to manually
// forget again — so production usage couples this with a sign-out
// on the affected device." For Phase 4.2 the mutator is the entire
// operation; daemon-side credential revocation lives at the daemon
// LISTEN handler tier and is reserved for a future hardening pass
// (the row absence + sign-out is functionally sufficient for v1).

export interface ForgetDeviceArgs {
  deviceId: string;
}

/* ---------------- Phase 4.3: updateSettings ---------------- */
// UPSERTs the single-row `settings` table by the literal PK
// "singleton". Only fields the user explicitly provides are
// touched; omitted fields preserve their existing values (Zero's
// `upsert` semantic).
//
// Side effect (daemon): the daemon LISTENs for settings changes and
// re-syncs `~/.friday/config.json` so existing `loadConfig()` reads
// (worker spawns, mail-bridge, scheduler) pick up the new value. The
// LISTEN handler has a matching boot-recovery scan (plan §5): on
// daemon boot, scan the settings table and reconcile config.json.
//
// Idempotency: re-running with same args is a no-op at the table
// level (UPSERT to the same values produces the same row) AND at
// the side-effect layer (config.json rewrite is deterministic on
// the row contents — same row, same file output).

export interface UpdateSettingsArgs {
  /** Partial — omitted fields preserve their existing values. */
  model?: string;
  watchdogRefork?: boolean;
  /** Client-side wall clock for diagnostics; server overwrites. */
  ts: number;
}

/* ---------------- Phase 4.4: ticket mutators ---------------- */
// Five pure-data mutators per ADR-023 §Mutators. None has a daemon
// side effect — ticket writes are pure Postgres-state mutations
// (Linear push happens only in the daemon's `ticket-close.ts`
// path which is fired by archiveAgent, NOT by linkTicketExternal).
//
// `createTicket` requires the client to compute the id (FRI-N
// pattern) by reading the local `zeroSync.tickets` snapshot and
// finding max(numeric_suffix) + 1. Race: two simultaneous creates
// from different devices can pick the same id → PK conflict → the
// loser's mutator surfaces an error and the dashboard retries with
// the next id. Single-user, low-rate creation → acceptable.

export interface CreateTicketArgs {
  /** Pre-computed by `nextTicketIdFrom(localTickets)` — see helper. */
  id: string;
  title: string;
  body?: string;
  status?: "open" | "in_progress" | "done" | "blocked" | "closed";
  kind?: "task" | "epic" | "bug" | "chore";
  assignee?: string;
  meta?: Record<string, unknown>;
  ts: number;
}

export interface UpdateTicketArgs {
  id: string;
  title?: string;
  body?: string | null;
  status?: "open" | "in_progress" | "done" | "blocked" | "closed";
  kind?: "task" | "epic" | "bug" | "chore";
  assignee?: string | null;
  meta?: Record<string, unknown> | null;
  ts: number;
}

export interface AddTicketCommentArgs {
  /** Pre-computed UUID — see `clientCommentId()` helper. */
  id: string;
  ticketId: string;
  author: string;
  body: string;
  ts: number;
}

export interface AddTicketRelationArgs {
  parentId: string;
  childId: string;
  kind: "depends_on" | "child_of" | "blocks" | "relates_to";
}

export interface LinkTicketExternalArgs {
  ticketId: string;
  system: string;
  externalId: string;
  url?: string;
  meta?: Record<string, unknown>;
  ts: number;
}

/**
 * Compute the next FRI-N ticket id from a local Zero snapshot.
 * Multi-device race: if two clients call this simultaneously and
 * neither has the other's write yet, they pick the same id; the
 * loser gets a PK conflict from the server-side mutator and the
 * dashboard must retry with the incremented id.
 *
 * Exported (not inlined into the mutator) so dashboard call sites
 * can compute the id BEFORE invoking the mutator — Zero's
 * MutatorResult surfaces a server-side error and the caller needs
 * the id in scope to retry.
 */
export function nextTicketIdFrom(
  existing: ReadonlyArray<{ id: string }>,
): string {
  let max = 0;
  for (const t of existing) {
    const m = /^FRI-(\d+)$/.exec(t.id);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (n > max) max = n;
    }
  }
  return `FRI-${max + 1}`;
}

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
  reportClientStats: async (
    tx: FridayTx,
    args: ReportClientStatsArgs,
  ): Promise<void> => {
    // Upsert. Touches only the columns the client owns —
    // `last_seen_at`, `last_sync_at`, `storage_used_bytes`,
    // `storage_quota_bytes`. The PK is `device_id`; user_id /
    // first_seen_at are populated by `/api/sync/refresh` on first
    // mint and stay pinned afterward. Zero's `update` (vs `upsert`)
    // would refuse if the row didn't exist; we use `update` here
    // because the row is guaranteed to exist by the time the client
    // calls this (refresh creates it before the WS handshake even
    // completes).
    await tx.mutate.client_devices.update({
      device_id: args.deviceId,
      last_seen_at: args.ts,
      last_sync_at: args.ts,
      storage_used_bytes: args.storageUsedBytes,
      storage_quota_bytes: args.storageQuotaBytes,
    });
  },
  forgetDevice: async (
    tx: FridayTx,
    args: ForgetDeviceArgs,
  ): Promise<void> => {
    // Hard-delete. Re-running with the same args is a no-op on the
    // server (Postgres DELETE WHERE no row matches doesn't error).
    // Optimistic deletes on the client emit a sync notification so
    // multi-tab Settings views update in real time.
    await tx.mutate.client_devices.delete({
      device_id: args.deviceId,
    });
  },
  createTicket: async (
    tx: FridayTx,
    args: CreateTicketArgs,
  ): Promise<void> => {
    // INSERT — collides on PK if the client raced another device
    // picking the same FRI-N. The mutator framework surfaces that
    // collision as an application error to the caller. The id is
    // computed client-side via `nextTicketIdFrom(zeroSync.tickets)`.
    await tx.mutate.tickets.insert({
      id: args.id,
      title: args.title,
      body: args.body,
      status: args.status ?? "open",
      kind: args.kind ?? "task",
      assignee: args.assignee,
      meta_json: args.meta,
      created_at: args.ts,
      updated_at: args.ts,
    });
  },
  updateTicket: async (
    tx: FridayTx,
    args: UpdateTicketArgs,
  ): Promise<void> => {
    // UPDATE — omitted fields preserved via Zero's `update`
    // semantic (not `upsert`). `updated_at` always advances on
    // every patch.
    const patch: {
      id: string;
      title?: string;
      body?: string | null;
      status?: "open" | "in_progress" | "done" | "blocked" | "closed";
      kind?: "task" | "epic" | "bug" | "chore";
      assignee?: string | null;
      meta_json?: Record<string, unknown> | null;
      updated_at: number;
    } = { id: args.id, updated_at: args.ts };
    if (args.title !== undefined) patch.title = args.title;
    if (args.body !== undefined) patch.body = args.body;
    if (args.status !== undefined) patch.status = args.status;
    if (args.kind !== undefined) patch.kind = args.kind;
    if (args.assignee !== undefined) patch.assignee = args.assignee;
    if (args.meta !== undefined) patch.meta_json = args.meta;
    await tx.mutate.tickets.update(patch);
  },
  addTicketComment: async (
    tx: FridayTx,
    args: AddTicketCommentArgs,
  ): Promise<void> => {
    // INSERT comment AND bump the parent ticket's updated_at so
    // the list page's "sort by updated" re-orders correctly. Mirrors
    // the legacy `addComment` service (tickets.ts:130-144).
    await tx.mutate.ticket_comments.insert({
      id: args.id,
      ticket_id: args.ticketId,
      author: args.author,
      body: args.body,
      ts: args.ts,
    });
    await tx.mutate.tickets.update({
      id: args.ticketId,
      updated_at: args.ts,
    });
  },
  addTicketRelation: async (
    tx: FridayTx,
    args: AddTicketRelationArgs,
  ): Promise<void> => {
    // INSERT — composite PK (parent_id, child_id, kind) means a
    // duplicate relation is a PK conflict (acceptable: the UI
    // surfaces the error so the user knows the link already
    // exists).
    await tx.mutate.ticket_relations.insert({
      parent_id: args.parentId,
      child_id: args.childId,
      kind: args.kind,
    });
  },
  linkTicketExternal: async (
    tx: FridayTx,
    args: LinkTicketExternalArgs,
  ): Promise<void> => {
    // INSERT — composite PK (ticket_id, system, external_id). The
    // legacy REST path used `ON CONFLICT DO NOTHING`; the mutator's
    // `insert` raises on conflict so the UI must check first. The
    // ticket detail page already gates the form on
    // `!existingLink(system, externalId)` so the conflict path is
    // exercised only on a true race.
    await tx.mutate.ticket_external_links.insert({
      ticket_id: args.ticketId,
      system: args.system,
      external_id: args.externalId,
      url: args.url,
      meta_json: args.meta,
      linked_at: args.ts,
    });
  },
  updateSettings: async (
    tx: FridayTx,
    args: UpdateSettingsArgs,
  ): Promise<void> => {
    // UPSERT the singleton row. Only fields the user provided are
    // included in the patch — Zero's `update` semantics preserve
    // omitted columns. The 0002 migration ensures the row already
    // exists, so `update` rather than `upsert` is safe; using
    // `update` makes the omitted-fields-preserved invariant
    // explicit in the type signature.
    const patch: {
      id: string;
      model?: string;
      watchdog_refork?: boolean;
      updated_at: number;
    } = {
      id: "singleton",
      updated_at: args.ts,
    };
    if (args.model !== undefined) patch.model = args.model;
    if (args.watchdogRefork !== undefined) {
      patch.watchdog_refork = args.watchdogRefork;
    }
    await tx.mutate.settings.update(patch);
  },
}) satisfies CustomMutatorDefs;

export type Mutators = ReturnType<typeof createMutators>;

// Convenience type alias to keep Zero<Schema, Mutators> readable at
// the call sites — the long generic argument is otherwise repeated
// across the dashboard's Zero client construction + tests.
export type FridaySchema = Schema;
