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

/* ---------------- Phase 4.5: memory mutators ---------------- */
// Three side-effect-bearing mutators. The dashboard's mutator writes
// only the Postgres row (status='pending_file' or 'pending_delete');
// the daemon's LISTEN handler (services/daemon/src/memory/listener.ts)
// picks up the row, writes or moves the markdown file under
// `~/.friday/memory/entries/`, and flips status to 'ready' or
// 'deleted'. Boot-recovery scan applies the same predicate to any
// pending rows that landed while the daemon was down (plan §5).
//
// MCP `memory_save` keeps the legacy synchronous path (writes file +
// inserts row with status='ready' in one step). Both paths must
// coexist because workers can't wait for a Postgres notification
// round-trip to complete their save.
//
// `createMemoryEntry` requires a pre-computed `id`: derive it from
// the title via `slugifyMemoryId(title)`. Same client/server
// determinism contract as `nextTicketIdFrom`: a multi-device race
// surfaces as a PK conflict the framework reports.

export interface CreateMemoryEntryArgs {
  /** Pre-computed by `slugifyMemoryId(title)`. */
  id: string;
  title: string;
  content: string;
  tags: string[];
  createdBy: string;
  ts: number;
}

export interface UpdateMemoryEntryArgs {
  id: string;
  title?: string;
  content?: string;
  tags?: string[];
  ts: number;
}

export interface DeleteMemoryEntryArgs {
  id: string;
  ts: number;
}

/**
 * Derive a memory-entry id from a title. Mirrors the daemon-side
 * `slugifyMemoryId` (which used to live in services/daemon/src/api/
 * server.ts) so the dashboard can compute the id locally without a
 * round-trip. Truncated to 64 chars (the column constraint).
 */
export function slugifyMemoryId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/* ---------------- Phase 4.6: schedule mutators ---------------- */
// Three mutators with a daemon-side side effect: cron registration.
//
// The dashboard mutator writes Postgres state with a pending status
// (`pending_register` for create, `reload_requested` for update,
// `deleted` for soft-delete). A Postgres trigger fires `NOTIFY
// friday_schedule_changed` on transition INTO any of those states;
// the daemon's LISTEN handler picks up, computes nextRunAt from the
// new cron expression, registers/unregisters the agent stub in
// the registry, and flips status to 'active' (or leaves at
// 'deleted' as a tombstone).
//
// Coexists with the legacy MCP/REST path (`upsertSchedule` in
// `services/daemon/src/scheduler/scheduler.ts`) which writes
// status='active' directly. The trigger predicate excludes 'active'
// so the legacy path doesn't reentry the daemon's LISTEN handler.
//
// Schedule PK is `name` (text); the dashboard requires the user to
// supply a name in the create form, so no slug helper is needed.

export interface CreateScheduleArgs {
  name: string;
  cron?: string;
  runAt?: string;
  taskPrompt: string;
  paused?: boolean;
  ts: number;
}

export interface UpdateScheduleArgs {
  name: string;
  cron?: string | null;
  runAt?: string | null;
  taskPrompt?: string;
  paused?: boolean;
  ts: number;
}

export interface DeleteScheduleArgs {
  name: string;
  ts: number;
}

/* ---------------- Phase 4.7: app mutators ---------------- */
// Three mutators that drive the daemon's transaction-wrapped
// installer (see `services/daemon/src/apps/installer.ts`).
//
// The dashboard mutator writes only Postgres state with a pending
// status. A Postgres trigger fires `NOTIFY friday_app_changed`; the
// daemon's LISTEN handler dispatches to the existing
// `installApp` / `uninstallApp` / `reloadApp` functions — the
// installer logic itself is unchanged from the pre-Phase-4 era.
//
// `installApp` is the asymmetric one: the daemon owns the manifest
// (it lives on the daemon's filesystem at
// `<folder_path>/manifest.json`). The mutator can't synthesize the
// canonical `name`/`version`/`manifest_json` fields client-side; it
// INSERTs a stub row at status='pending_install' with placeholder
// values that the daemon overwrites within milliseconds. The
// dashboard's reactive apps query filters status='pending_install'
// out so the placeholder is never user-visible (see
// `#bindApps` in zero.svelte.ts).
//
// `uninstallApp` and `reloadApp` are conventional status flips —
// the row already exists with canonical fields.

export interface InstallAppArgs {
  /** Folder name under `~/.friday/apps/` (also the PK). */
  id: string;
  /** Absolute or `~/.friday/apps/<id>/` path. The daemon reads the
   *  manifest from `<folderPath>/manifest.json`. */
  folderPath: string;
  ts: number;
}

export interface UninstallAppArgs {
  id: string;
  ts: number;
}

export interface ReloadAppArgs {
  id: string;
  ts: number;
}

/* ---------------- Phase 4.8: archiveAgent ---------------- */
// Mutator UPDATEs the agent row's status to 'archive_requested' and
// records the reason. A Postgres trigger fires
// `NOTIFY friday_archive_requested`; the daemon's LISTEN handler
// calls the existing `archiveAgent(name, {reason})` lifecycle
// function which:
//   1. Stops the live worker (graceful → SIGTERM pgrp → SIGKILL pgrp).
//   2. Archives the worktree to disk (builders only).
//   3. Closes any linked Linear ticket via `closeTicketForArchive`.
//   4. Sets status='archived' as its final write.
//
// The legacy `/api/commands` archive path remains untouched — it
// bypasses the mutator and calls `archiveAgent` directly. The
// trigger predicate (NEW.status = 'archive_requested') ensures
// only mutator-initiated archives fire the LISTEN handler.
//
// `reason` is required because the linked-ticket closer behaves
// differently per reason (e.g., 'completed' marks the ticket done;
// 'abandoned' marks it abandoned; 'refork' is a no-op for tickets).
// The dashboard's `/archive <name>` slash command surfaces a
// dropdown to pick the reason; the default is 'abandoned' to match
// the legacy slash-command default.

export type ArchiveReason = "completed" | "abandoned" | "failed" | "refork";

export interface ArchiveAgentArgs {
  name: string;
  reason: ArchiveReason;
  ts: number;
}

/* ---------------- Phase 4.9: cancelQueued ---------------- */
// First mutator with a *required* fast-path (plan §4.9). The daemon's
// `nextPrompts` deque is in-memory state — a Postgres NOTIFY round-trip
// is too slow to reliably outrun the worker dispatcher. Two paths run
// in parallel:
//
//   1. Fast-path (sync): `POST /api/internal/cancel-queued` calls
//      `removeQueuedPrompt(agent, turn)` on the daemon, returns the
//      recovered prompt text so the dashboard can stuff it back into
//      the input bar.
//   2. Mutator (durable + cross-device): UPDATEs the block row's
//      status from 'queued' to 'cancel_requested'. A Postgres trigger
//      fires `NOTIFY friday_block_canceled`; the daemon's LISTEN
//      handler:
//        - Calls `removeQueuedPrompt` (idempotent — no-op if the
//          fast-path already spliced the entry).
//        - Publishes a `block_meta_update` SSE event for legacy tabs.
//        - DELETEs the row (canonical delete path).
//
// Row-state pre/post (plan §5):
//   - Pre: blocks WHERE id = args.id AND status='queued'.
//   - Post (mutator): status='cancel_requested'.
//   - Post (daemon flip): row DELETEd.
//
// Idempotency contract (plan §5):
//   - Mutator: re-running on a row already at 'cancel_requested' is a
//     no-op (UPDATE with same value); re-running on a DELETEd row
//     surfaces a missing-PK error (the dashboard wrapper traps it).
//   - Fast-path: idempotent against the LISTEN-path — if the LISTEN
//     handler already ran (row DELETEd, prompt already spliced),
//     `removeQueuedPrompt` returns null and the fast-path returns
//     `text=""` with `already_canceled=true`.
//
// The Zero blocks PK is `id` (Postgres bigserial). The dashboard
// reads it from the local Zero snapshot before invoking the mutator.

export interface CancelQueuedArgs {
  /** Bigserial PK of the blocks row (read from local Zero snapshot). */
  id: number;
  ts: number;
}

/* ---------------- Phase 4.10: abortTurn ---------------- */
// Second mutator with a *required* fast-path (plan §4.10). The
// daemon's worker `AbortController` is in-memory state; a Postgres
// NOTIFY round-trip is too slow to reliably outrun the next SDK
// step. Two paths run in parallel:
//
//   1. Fast-path (sync): `POST /api/internal/abort-turn { turn_id }`
//      calls the existing `abortTurn(agentName)` lifecycle function
//      which sets `w.abortRequested=true`, sends `{type:'abort'}` IPC
//      to the worker, and arms the 2s force-kill safety net.
//   2. Mutator (durable + cross-device): UPDATEs the user block's
//      status from 'complete' to 'abort_requested'. A Postgres
//      trigger fires `NOTIFY friday_abort_requested`; the daemon's
//      LISTEN handler:
//        - Calls `abortTurn(agentName)` (idempotent: re-running
//          re-sends the IPC, which the worker tolerates; if the
//          worker is already gone, `abortTurn` returns false).
//        - UPDATEs the row back to status='complete' (the natural
//          terminal state for a user block) so the trigger doesn't
//          re-fire on subsequent lifecycle UPDATEs.
//
// Row-state pre/post (plan §5):
//   - Pre: blocks WHERE id = args.id AND status='complete' (user
//     block, written by `recordUserBlock` at status='complete').
//   - Post (mutator): status='abort_requested'.
//   - Post (daemon flip-back): status='complete'.
//
// Idempotency contract (plan §5):
//   - Mutator: re-running on a row already at 'abort_requested' is
//     a no-op (UPDATE with same value); re-running on a row at
//     'complete' (handler-flipped-back) is a fresh signal that
//     fires the trigger again — but the lifecycle `abortTurn` is
//     itself idempotent, so the eventual side effect is identical.
//   - Fast-path: idempotent against the LISTEN-path — both call the
//     same lifecycle function. Either path firing first is safe.
//
// The block row UI status doesn't gate the user message bubble's
// visibility — the dashboard's blocks Zero query does NOT filter
// 'abort_requested' (unlike Phase 4.9's 'cancel_requested'), so the
// user's typed message stays visible throughout. The transient
// 'abort_requested' status is purely the LISTEN signal.

export interface AbortTurnArgs {
  /** Bigserial PK of the user block whose turn is being aborted. */
  id: number;
  ts: number;
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
  createMemoryEntry: async (
    tx: FridayTx,
    args: CreateMemoryEntryArgs,
  ): Promise<void> => {
    // INSERT with status='pending_file' — the daemon's LISTEN
    // handler picks up the NOTIFY (fired by the trigger from
    // migration 0004) and writes the markdown file, then flips
    // status to 'ready'. PK conflict (e.g. two devices using the
    // same slug) is surfaced to the caller.
    //
    // `file_mtime` is mandatory in the schema but we don't know it
    // yet — the daemon writes the file and stamps mtime then.
    // Provide `ts` as a placeholder so the column has SOMETHING
    // until the daemon flips it.
    await tx.mutate.memory_entries.insert({
      id: args.id,
      title: args.title,
      content: args.content,
      tags_json: args.tags,
      created_by: args.createdBy,
      created_at: args.ts,
      updated_at: args.ts,
      file_mtime: args.ts,
      recall_count: 0,
      last_recalled_at: null,
      status: "pending_file",
    });
  },
  updateMemoryEntry: async (
    tx: FridayTx,
    args: UpdateMemoryEntryArgs,
  ): Promise<void> => {
    // UPDATE with status='pending_file' + advanced updated_at.
    // Omitted fields preserved (Zero's `update`). Daemon LISTEN
    // handler rewrites the file and flips back to 'ready'.
    const patch: {
      id: string;
      title?: string;
      content?: string;
      tags_json?: string[];
      updated_at: number;
      status: "pending_file";
    } = {
      id: args.id,
      updated_at: args.ts,
      status: "pending_file",
    };
    if (args.title !== undefined) patch.title = args.title;
    if (args.content !== undefined) patch.content = args.content;
    if (args.tags !== undefined) patch.tags_json = args.tags;
    await tx.mutate.memory_entries.update(patch);
  },
  deleteMemoryEntry: async (
    tx: FridayTx,
    args: DeleteMemoryEntryArgs,
  ): Promise<void> => {
    // Soft-delete: set status='pending_delete' + advance
    // updated_at. The dashboard's reactive query filters status
    // NOT IN ('pending_delete','deleted') so the row disappears
    // from the list immediately (optimistic). Daemon LISTEN
    // handler moves the file to ~/.friday/memory/trash/ and flips
    // status to 'deleted' (tombstone).
    await tx.mutate.memory_entries.update({
      id: args.id,
      updated_at: args.ts,
      status: "pending_delete",
    });
  },
  createSchedule: async (
    tx: FridayTx,
    args: CreateScheduleArgs,
  ): Promise<void> => {
    // INSERT with status='pending_register'. Daemon's LISTEN
    // handler reads the row, registers the agent stub in the
    // `agents` registry (mail-routing target), computes nextRunAt
    // from the cron expression, and flips status='active'.
    //
    // `next_run_at`, `last_run_at`, `last_run_id` left null on
    // initial insert — the daemon's LISTEN handler computes them.
    // PK is `name`; race-loss between devices → PK conflict.
    await tx.mutate.schedules.insert({
      name: args.name,
      cron: args.cron,
      run_at: args.runAt,
      task_prompt: args.taskPrompt,
      paused: args.paused ?? false,
      next_run_at: null,
      last_run_at: null,
      last_run_id: null,
      meta_json: null,
      app_id: null,
      status: "pending_register",
      created_at: args.ts,
      updated_at: args.ts,
    });
  },
  updateSchedule: async (
    tx: FridayTx,
    args: UpdateScheduleArgs,
  ): Promise<void> => {
    // UPDATE with status='reload_requested' + advanced updated_at.
    // Omitted fields preserved. Daemon LISTEN handler recomputes
    // nextRunAt (cron may have changed → fresh window) and flips
    // status='active'. `paused` updates flow through here too —
    // the daemon's recompute handles the paused-during-due-window
    // edge case (the existing `resumeSchedule` legacy path uses
    // the same recompute semantic).
    const patch: {
      name: string;
      cron?: string | null;
      run_at?: string | null;
      task_prompt?: string;
      paused?: boolean;
      updated_at: number;
      status: "reload_requested";
    } = {
      name: args.name,
      updated_at: args.ts,
      status: "reload_requested",
    };
    if (args.cron !== undefined) patch.cron = args.cron;
    if (args.runAt !== undefined) patch.run_at = args.runAt;
    if (args.taskPrompt !== undefined) patch.task_prompt = args.taskPrompt;
    if (args.paused !== undefined) patch.paused = args.paused;
    await tx.mutate.schedules.update(patch);
  },
  deleteSchedule: async (
    tx: FridayTx,
    args: DeleteScheduleArgs,
  ): Promise<void> => {
    // Soft-delete: status='deleted' + advance updated_at. The
    // dashboard's schedules query filters `status != 'deleted'` so
    // the row vanishes immediately. Daemon LISTEN handler cleans
    // up the registry agent stub if it's unused (no session, no
    // blocks); idempotent — re-running is safe. Row stays at
    // 'deleted' as a tombstone for cross-device convergence.
    await tx.mutate.schedules.update({
      name: args.name,
      updated_at: args.ts,
      status: "deleted",
    });
  },
  installApp: async (
    tx: FridayTx,
    args: InstallAppArgs,
  ): Promise<void> => {
    // INSERT a stub row at status='pending_install'. NOT NULL
    // columns (`name`, `version`, `manifest_version`,
    // `manifest_json`) get placeholders that the daemon overwrites
    // when it reads the manifest from disk. The dashboard's apps
    // query filters status='pending_install' so the placeholder is
    // never user-visible — the row appears in the list only after
    // the daemon flips status='installed'.
    //
    // PK collision (re-install of the same id) → caller surfaces
    // the error. The daemon's installer already handles
    // "previously archived agents under this app id" via the
    // re-attach path; users wanting to re-install should
    // uninstallApp first.
    await tx.mutate.apps.insert({
      id: args.id,
      name: "",
      version: "0.0.0",
      manifest_version: 0,
      folder_path: args.folderPath,
      manifest_json: {},
      status: "pending_install",
      installed_at: args.ts,
      upgraded_at: null,
      meta_json: null,
    });
  },
  uninstallApp: async (
    tx: FridayTx,
    args: UninstallAppArgs,
  ): Promise<void> => {
    // UPDATE status='uninstall_requested'. Daemon LISTEN handler
    // archives owned agents, drops schedules, optionally moves the
    // folder, then DELETEs the row. The row vanishing is the
    // user's "uninstall complete" signal across devices.
    await tx.mutate.apps.update({
      id: args.id,
      status: "uninstall_requested",
    });
  },
  reloadApp: async (
    tx: FridayTx,
    args: ReloadAppArgs,
  ): Promise<void> => {
    // UPDATE status='reload_requested'. Daemon LISTEN handler
    // re-reads the manifest from disk, reconciles agent/schedule
    // rows, and flips status='installed'. No-op when the manifest
    // hasn't changed (the daemon's reloadApp returns
    // {changed: false}).
    await tx.mutate.apps.update({
      id: args.id,
      status: "reload_requested",
    });
  },
  archiveAgent: async (
    tx: FridayTx,
    args: ArchiveAgentArgs,
  ): Promise<void> => {
    // UPDATE agents.status='archive_requested' + archive_reason.
    // The Postgres trigger fires NOTIFY; the daemon's LISTEN
    // handler calls the existing `archiveAgent(name, {reason})`
    // lifecycle function which kills the worker, archives the
    // worktree, closes linked tickets, and flips status='archived'.
    //
    // Idempotent: re-archiving an already-archived agent is a
    // no-op at the lifecycle level (the worker is gone, the
    // worktree is archived, the ticket is closed). The mutator
    // UPDATE itself produces another archive_request write — the
    // daemon's handler is structured to tolerate this.
    await tx.mutate.agents.update({
      name: args.name,
      status: "archive_requested",
      archive_reason: args.reason,
      updated_at: args.ts,
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
  cancelQueued: async (
    tx: FridayTx,
    args: CancelQueuedArgs,
  ): Promise<void> => {
    // UPDATE blocks.status='cancel_requested'. The dashboard's blocks
    // query filters this status out so the bubble disappears
    // optimistically. The Postgres trigger fires NOTIFY
    // `friday_block_canceled` and the daemon LISTEN handler then
    // performs the canonical row DELETE + nextPrompts splice.
    //
    // Touches only `status` (+ `last_event_seq` advance for the
    // existing SSE-block-cursor invariant). All other fields are
    // preserved so the daemon's LISTEN handler can read the original
    // agent_name / turn_id / content_json from the row before it
    // performs the delete.
    await tx.mutate.blocks.update({
      id: args.id,
      status: "cancel_requested",
    });
  },
  abortTurn: async (
    tx: FridayTx,
    args: AbortTurnArgs,
  ): Promise<void> => {
    // UPDATE blocks.status='abort_requested'. The Postgres trigger
    // fires NOTIFY `friday_abort_requested`; the daemon's LISTEN
    // handler dispatches the existing `abortTurn(agentName)`
    // lifecycle function and then flips the row back to 'complete'.
    //
    // Touches only `status` — agent_name / turn_id / content_json
    // must be preserved so the daemon's LISTEN handler can read them
    // before performing the abort + flip-back.
    await tx.mutate.blocks.update({
      id: args.id,
      status: "abort_requested",
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
