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

/* ---------------- agents (sidebar) ---------------- */
// Mirrors `db/schema.ts:agents`. Columns kept in lock-step with the
// Drizzle table. `created_at` / `updated_at` are sent over the wire as
// epoch-millis numbers; the dashboard reconstructs `Date` objects on
// the client side.

const agents = table("agents")
  .columns({
    name: string(),
    type: string<"orchestrator" | "builder" | "helper" | "scheduled" | "bare">(),
    status: string<
      | "idle"
      | "working"
      | "stalled"
      | "error"
      | "archived"
      | "archive_requested"
    >(),
    session_id: string().optional(),
    parent_name: string().optional(),
    worktree_path: string().optional(),
    branch: string().optional(),
    ticket_id: string().optional(),
    meta_json: json().optional(),
    spawn_reason: string().optional(),
    app_id: string().optional(),
    archive_reason: string().optional(),
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
    status: string<
      "open" | "in_progress" | "done" | "blocked" | "closed"
    >(),
    kind: string<"task" | "epic" | "bug" | "chore">(),
    assignee: string().optional(),
    meta_json: json().optional(),
    created_at: number(),
    updated_at: number(),
  })
  .primaryKey("id");

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
      "active" | "pending_register" | "reload_requested" | "deleted" | "paused"
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
    status: string<"ready" | "pending_file" | "deleted">(),
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
    id: number(),
    block_id: string(),
    turn_id: string(),
    agent_name: string(),
    session_id: string(),
    message_id: string().optional(),
    block_index: number(),
    role: string<"user" | "assistant" | "system">(),
    kind: string<
      "text" | "thinking" | "tool_use" | "tool_result" | "error" | "mail"
    >(),
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
    delivery: string<"pending" | "delivered" | "read" | "closed">(),
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
// TS rejects with TS2742 ("not portable"). Annotating with the exported
// `Schema` (renamed to `ZeroSchema` at import) keeps consumers' .d.ts
// emit clean.
export const schema: ZeroSchema = createSchema({
  tables: [agents, tickets, schedules, memoryEntries, apps, mail, blocks],
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
  tickets: { row: { select: ANYONE_CAN } },
  schedules: { row: { select: ANYONE_CAN } },
  memory_entries: { row: { select: ANYONE_CAN } },
  apps: { row: { select: ANYONE_CAN } },
  mail: { row: { select: ANYONE_CAN } },
  blocks: { row: { select: ANYONE_CAN } },
}));
