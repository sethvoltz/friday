// Friday Zero sync schema (ADR-024, Phase 2).
//
// This file declares the subset of the Postgres canonical store that
// zero-cache replicates to clients. Tables defined here are:
//   - replicated via Postgres logical replication (publication `friday_pub`),
//   - exposed to clients as reactive queries through @rocicorp/zero,
//   - bound to the same physical table name as in `db/schema.ts`.
//
// Phase 2 ships exactly one table — `agents` — so the first reactive
// sidebar query has something concrete to bind. Phase 3 layers in
// additional slices one at a time (tickets, schedules, memory, apps,
// evolve proposals, mail, blocks), mirroring the Drizzle schema's
// shape. Tables explicitly excluded from sync:
//   - `user` / `session` / `account` / `verification` (BetterAuth state,
//     server-only — protected by the dashboard's session middleware).
//   - `db_meta` (server-internal kv: rate-limit buckets, schema version).
//   - `usage` (large append-only telemetry; surfaced via REST when needed).
//
// Permissions land in Phase 3 per-slice — Phase 2's `agents` table is
// readable by any authenticated session (the dashboard's WS bridge
// gates that via short-lived JWTs, not by Zero permissions).

import {
  ANYONE_CAN,
  boolean,
  createSchema,
  definePermissions,
  json,
  number,
  type Schema as ZeroSchema,
  string,
  table,
} from "@rocicorp/zero";

/* ---------------- evolve_proposals (item #54) ---------------- */
// Mirrors `db/schema.ts:evolveProposals`. The dashboard's /evolve page
// reads from this slice reactively; the daemon's evolve store dual-
// writes to PG + filesystem during the migration window.

const evolveProposals = table("evolve_proposals")
  .columns({
    id: string(),
    title: string(),
    proposal_type: string(),
    status: string(),
    cluster_id: string().optional(),
    score: number(),
    blast_radius: string(),
    applies_to: json(),
    signals: json(),
    body: string(),
    created_by: string(),
    created_at: number(),
    updated_at: number(),
    applied_at: number().optional(),
    applied_by: string().optional(),
    enriched_at: number().optional(),
    enriched_by: string().optional(),
    last_enrich_error: string().optional(),
    last_enrich_failed_at: number().optional(),
    applied_ticket_id: string().optional(),
  })
  .primaryKey("id");

/* ---------------- agents (sidebar) ---------------- */
// Mirrors `db/schema.ts:agents`. Columns kept in lock-step with the
// Drizzle table. `created_at` / `updated_at` are sent over the wire as
// epoch-millis numbers; the dashboard reconstructs `Date` objects on
// the client side.

const agents = table("agents")
  .columns({
    name: string(),
    type: string<"orchestrator" | "builder" | "helper" | "scheduled" | "bare">(),
    status: string<"idle" | "working" | "stalled" | "error" | "archived" | "archive_requested">(),
    session_id: string().optional(),
    parent_name: string().optional(),
    worktree_path: string().optional(),
    branch: string().optional(),
    ticket_id: string().optional(),
    meta_json: json().optional(),
    spawn_reason: string().optional(),
    app_id: string().optional(),
    archive_reason: string().optional(),
    session_count: number(),
    created_at: number(),
    updated_at: number(),
  })
  .primaryKey("name");

/* ---------------- tickets (Phase 3.1) ---------------- */
// Mirrors `db/schema.ts:tickets`. First Phase 3 read-path slice.
// `ticket_comments` / `ticket_relations` / `ticket_external_links`
// ride on the same friday_pub publication but aren't yet exposed as
// reactive queries — future Phase 3 slices add them as relationships
// when the dashboard surfaces (e.g., the detail-page comment thread)
// switch over from REST.

const tickets = table("tickets")
  .columns({
    id: string(), // "FRI-1234"
    title: string(),
    body: string().optional(),
    status: string<"open" | "in_progress" | "done" | "blocked" | "closed">(),
    kind: string<"task" | "epic" | "bug" | "chore">(),
    assignee: string().optional(),
    meta_json: json().optional(),
    created_at: number(),
    updated_at: number(),
  })
  .primaryKey("id");

/* ---------------- ticket_comments (Phase 4.4) ---------------- */
// Mirrors `db/schema.ts:ticketComments`. PK flipped from bigserial
// to text-uuid in migration 0003 so the Zero mutator can pass the
// id at INSERT time (Zero requires the PK in the args for the
// optimistic client write).

const ticketComments = table("ticket_comments")
  .columns({
    id: string(),
    ticket_id: string(),
    author: string(),
    body: string(),
    ts: number(),
  })
  .primaryKey("id");

/* ---------------- ticket_relations (Phase 4.4) ---------------- */
// Mirrors `db/schema.ts:ticketRelations`. Composite PK
// (parent_id, child_id, kind) — multiple relation kinds per pair.

const ticketRelations = table("ticket_relations")
  .columns({
    parent_id: string(),
    child_id: string(),
    kind: string<"depends_on" | "child_of" | "blocks" | "relates_to">(),
  })
  .primaryKey("parent_id", "child_id", "kind");

/* ---------------- ticket_external_links (Phase 4.4) ---------------- */
// Mirrors `db/schema.ts:ticketExternalLinks`. Composite PK
// (ticket_id, system, external_id). One Friday ticket can link to
// multiple external systems (Linear + GitHub + …).

const ticketExternalLinks = table("ticket_external_links")
  .columns({
    ticket_id: string(),
    system: string(),
    external_id: string(),
    url: string().optional(),
    meta_json: json().optional(),
    linked_at: number(),
  })
  .primaryKey("ticket_id", "system", "external_id");

/* ---------------- schedules (Phase 3.2) ---------------- */
// Mirrors `db/schema.ts:schedules`. The `paused` column ships as a
// boolean (Drizzle column is `boolean`, jsonb wouldn't apply). Other
// nullable fields stay `.optional()` so the Zero row shape matches
// what Postgres returns under logical replication.

const schedules = table("schedules")
  .columns({
    name: string(),
    cron: string().optional(),
    run_at: string().optional(),
    task_prompt: string(),
    paused: boolean(),
    next_run_at: number().optional(),
    last_run_at: number().optional(),
    last_run_id: string().optional(),
    meta_json: json().optional(),
    app_id: string().optional(),
    status: string<
      | "active"
      | "pending_register"
      | "reload_requested"
      | "deleted"
      | "paused"
      | "trigger_requested"
    >(),
    created_at: number(),
    updated_at: number(),
  })
  .primaryKey("name");

/* ---------------- memory_entries (Phase 3.3) ---------------- */
// Mirrors `db/schema.ts:memoryEntries`. `tagsJson` is a `jsonb` array
// of strings in Postgres; Zero exposes it as `json` and the dashboard
// reshapes to MemoryEntry.tags. Search (FTS) still flows through the
// REST endpoint at `/api/memory/search` — Zero doesn't replicate
// the generated tsvector column.

const memoryEntries = table("memory_entries")
  .columns({
    id: string(),
    title: string(),
    content: string(),
    tags_json: json(),
    created_by: string(),
    created_at: number(),
    updated_at: number(),
    file_mtime: number(),
    recall_count: number(),
    last_recalled_at: number().optional(),
    status: string<"ready" | "pending_file" | "pending_delete" | "deleted">(),
  })
  .primaryKey("id");

/* ---------------- apps (Phase 3.4) ---------------- */
// Mirrors `db/schema.ts:apps`. The Settings page's installed-apps
// panel reads from this slice; mutators that install / uninstall /
// reload an app live on the daemon side (Phase 4).

const apps = table("apps")
  .columns({
    id: string(),
    name: string(),
    version: string(),
    manifest_version: number(),
    folder_path: string(),
    manifest_json: json(),
    status: string<
      | "installed"
      | "orphaned"
      | "error"
      | "pending_install"
      | "uninstall_requested"
      | "reload_requested"
    >(),
    installed_at: number(),
    upgraded_at: number().optional(),
    meta_json: json().optional(),
  })
  .primaryKey("id");

/* ---------------- settings (Phase 4.3) ---------------- */
// Single-row table — primary key is the literal string "singleton".
// Daemon's `loadConfig()` reads `~/.friday/config.json`; the
// `updateSettings` mutator writes to this Postgres table AND the
// daemon's LISTEN handler keeps `~/.friday/config.json` in sync so
// worker spawns pick up the new model/watchdog values via the
// existing read path. The dashboard's Settings page (Phase 4.3+)
// reads from this table via Zero so multiple browser tabs converge
// within a second of any mutation.

// FRI-124: theme_* columns mirror the Drizzle schema additions. Zero
// would otherwise silently drop them from its SELECT projection and
// the dashboard's runtime store would always read `undefined` for
// theme_kind / theme_palette_*, breaking AC #27 cross-tab sync. Each
// column is `.optional()` because the DB column is NULLable (an unset
// pick falls back to the resolver's default at runtime).
const settings = table("settings")
  .columns({
    id: string(),
    model: string().optional(),
    watchdog_refork: boolean().optional(),
    theme_kind: string().optional(),
    theme_palette_single: string().optional(),
    theme_palette_light: string().optional(),
    theme_palette_dark: string().optional(),
    updated_at: number(),
  })
  .primaryKey("id");

/* ---------------- client_devices (Phase 4.2) ---------------- */
// Per-browser-install device registry. ADR-023's "device-scoped read
// cursors + per-device storage telemetry + 'Forget this device'
// button" model — Phase 4.2 brings it under Zero so the Settings
// page (Phase 6) can render a live list of every device that has
// touched this account, including itself.
//
// Two mutators write here (Phase 4.2):
//   - `reportClientStats` — UPSERT storage stats from
//     `navigator.storage.estimate()` every 5 minutes when the tab is
//     active.
//   - `forgetDevice` — DELETE by device_id. The next
//     `/api/sync/refresh` from that browser re-creates the row;
//     production usage couples this with a sign-out on the affected
//     device to actually evict it.

const clientDevices = table("client_devices")
  .columns({
    device_id: string(),
    user_id: string(),
    user_agent: string().optional(),
    label: string().optional(),
    first_seen_at: number(),
    last_seen_at: number(),
    storage_used_bytes: number().optional(),
    storage_quota_bytes: number().optional(),
    last_sync_at: number().optional(),
    // Plan §41: non-null means the device has been forgotten;
    // `/api/sync/refresh` denies JWT minting for revoked rows.
    revoked_at: number().optional(),
  })
  .primaryKey("device_id");

/* ---------------- read_cursors (Phase 4.1) ---------------- */
// Per-device, per-agent last-seen marker. Drives the unread badge:
// `unread(agent) = count(blocks where agent_name=agent AND id > last_seen)`.
// The `markRead` mutator UPSERTs a row keyed by (device_id, agent_name).
// Per-device by default (ADR-023 open question; mark-read on phone does
// NOT clear the badge on laptop). `ts` is purely diagnostic — the
// authoritative "what have I seen" cursor is `last_seen_block_id`.

const readCursors = table("read_cursors")
  .columns({
    device_id: string(),
    agent_name: string(),
    last_seen_block_id: string(),
    ts: number(),
    // Item #52: server-computed unread badge counter. Increments via
    // a Postgres trigger on `blocks` INSERT; the `markRead` mutator
    // resets to 0 alongside the last_seen_block_id update.
    unread_count: number(),
  })
  .primaryKey("device_id", "agent_name");

/* ---------------- blocks (Phase 3.7) ---------------- */
// Mirrors `db/schema.ts:blocks`. The chat scroller is the largest read
// surface in the dashboard — the Zero subscription is *per focused agent
// + last 50 rows* (bound dynamically by `zeroSync.bindBlocksFor`), not
// global, because the global blocks history grows unbounded and Zero's
// client-side cache would otherwise hold every agent's transcript in
// every browser session. Scroll-back beyond the synced window stays on
// the REST endpoint (`GET /api/agents/:name/blocks?before=…`); the
// dashboard merges those rows into the chat alongside the Zero rows.
//
// In-flight in-flight blocks (`status='streaming'`, ADR-024 phrasing
// `streaming=1`) are filtered out at the client query layer — they
// should be invisible until the daemon flips them to `complete` or
// `aborted`. Phase 5 narrows this further once the daemon stops writing
// the streaming row entirely (ADR-024: row written only on
// `block_complete`); the Phase 3.7 contract is "what the daemon writes
// today, minus the streaming placeholder."
//
// Columns mirror Drizzle's `blocks` table; `content_json` is jsonb
// (replicated as a parsed object) and `ts` is epoch-ms. `id` is the
// Postgres bigserial primary key — used by parseBlocks's chronological
// tiebreak for blocks sharing a millisecond.

const blocks = table("blocks")
  .columns({
    // Phase 4.11: flipped from `number()` → `string()` alongside
    // the Drizzle bigserial→text(uuid) migration. The mutator
    // INSERT path (sendUserMessage) requires the client to
    // pre-generate the PK; existing daemon writes use
    // `gen_random_uuid()::text` as the column default.
    id: string(),
    block_id: string(),
    turn_id: string(),
    agent_name: string(),
    session_id: string(),
    message_id: string().optional(),
    block_index: number(),
    role: string<"user" | "assistant" | "system">(),
    kind: string<"text" | "thinking" | "tool_use" | "tool_result" | "error" | "mail">(),
    source: string().optional(),
    content_json: json(),
    status: string<
      | "pending"
      | "streaming"
      | "complete"
      | "aborted"
      | "error"
      | "queued"
      | "abort_requested"
      | "dispatched"
      | "cancel_requested"
    >(),
    streaming: boolean(),
    origin_mutation_id: string().optional(),
    ts: number(),
    last_event_seq: number(),
  })
  .primaryKey("id");

/* ---------------- mail (Phase 3.6) ---------------- */
// Mail items don't have a dedicated dashboard surface — they render
// inline in the chat scroller as user-role blocks with
// `source = "mail"` (Phase 3.7 covers blocks). Phase 3.6 lands the
// table in the Zero schema so the Phase 5 SSE-event retirement
// (`mail_delivered` → reactive unread badge derived from `delivery`)
// + the Phase 6 multi-device inbox surface have something to bind to
// without a follow-on schema change.

const mail = table("mail")
  .columns({
    id: number(),
    from_agent: string(),
    to_agent: string(),
    type: string<"message" | "notification" | "task">(),
    delivery: string<"pending" | "read" | "closed">(),
    subject: string().optional(),
    thread_id: string().optional(),
    body: string(),
    meta_json: json().optional(),
    ts: number(),
    read_at: number().optional(),
    closed_at: number().optional(),
    priority: string<"normal" | "critical">(),
  })
  .primaryKey("id");

// Explicit annotation: `createSchema`'s inferred return type references a
// private path inside @rocicorp/zero's `out/zero-types/src/schema`, which
// TS rejects with TS2742 ("not portable"). Annotating keeps consumers'
// .d.ts emit clean. The intersection with `{ enableLegacyQueries: true }`
// preserves that flag as a LITERAL — without it, `ZeroSchema`'s widening
// to `boolean` makes `ConditionalSchemaQuery<S>` resolve to `undefined`,
// and every `this.#zero.query.<table>` site downstream fails with
// "Object is possibly 'undefined'" at type-check time. The flag is
// load-bearing at runtime (Phase 3 entrance gate); pinning it in the
// type matches the runtime contract.
export const schema: ZeroSchema & { readonly enableLegacyQueries: true } = createSchema({
  tables: [
    agents,
    tickets,
    ticketComments,
    ticketRelations,
    ticketExternalLinks,
    schedules,
    memoryEntries,
    apps,
    mail,
    blocks,
    readCursors,
    clientDevices,
    settings,
    evolveProposals,
  ],
  // Phase 3: enable the deprecated `z.query.<table>` field. The
  // createBuilder() path returns query objects that aren't bound to a
  // Zero connection, so `zero.materialize(builder.agents)` registers
  // 0 desired queries with zero-cache (the dashboard's symptoms in
  // Phase 3.2: client gets "Loaded 0 row records" even when the
  // replica contains rows). With `enableLegacyQueries: true`,
  // `zero.query.<table>` returns connection-bound builders that
  // actually wire the query up to the WS.
  enableLegacyQueries: true,
});

export type Schema = typeof schema;

/* ---------------- permissions ---------------- */
// Zero 1.5+ defaults to "deny all" for tables without an explicit
// permissions rule — queries against an undeployed schema return zero
// rows with the server-side log line "No upstream permissions deployed."
// Friday is single-user (the dashboard's BetterAuth session gates
// access at the WS handshake), so every authenticated client reads
// every row. `ANYONE_CAN` translates to "select allowed for any
// authenticated principal." Phase 4 layers in cell-level or
// row-conditional rules if the auth model grows.

export const permissions = definePermissions(schema, () => ({
  agents: { row: { select: ANYONE_CAN } },
  evolve_proposals: { row: { select: ANYONE_CAN } },
  tickets: { row: { select: ANYONE_CAN } },
  // Ticket sub-tables — writes flow through Phase 4.4 mutators.
  ticket_comments: { row: { select: ANYONE_CAN } },
  ticket_relations: { row: { select: ANYONE_CAN } },
  ticket_external_links: { row: { select: ANYONE_CAN } },
  schedules: { row: { select: ANYONE_CAN } },
  memory_entries: { row: { select: ANYONE_CAN } },
  apps: { row: { select: ANYONE_CAN } },
  mail: { row: { select: ANYONE_CAN } },
  blocks: { row: { select: ANYONE_CAN } },
  // Writes to `read_cursors` flow through the `markRead` mutator
  // (Phase 4.1) — Zero 1.5+ deprecates insert/update/delete row
  // permissions in favor of mutator-defined authz. Only `select` is
  // configured here so the client's reactive unread-derivation query
  // can read the row.
  read_cursors: { row: { select: ANYONE_CAN } },
  // Writes flow through `reportClientStats` + `forgetDevice` mutators
  // (Phase 4.2). Only `select` is configured for the Settings-page
  // device-list reactive query.
  client_devices: { row: { select: ANYONE_CAN } },
  // Writes via the `updateSettings` mutator (Phase 4.3). Select-only
  // here; the daemon's LISTEN handler runs `~/.friday/config.json`
  // resync on every UPDATE.
  settings: { row: { select: ANYONE_CAN } },
}));
