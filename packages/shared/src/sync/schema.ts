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

// Explicit annotation: `createSchema`'s inferred return type references a
// private path inside @rocicorp/zero's `out/zero-types/src/schema`, which
// TS rejects with TS2742 ("not portable"). Annotating with the exported
// `Schema` (renamed to `ZeroSchema` at import) keeps consumers' .d.ts
// emit clean.
export const schema: ZeroSchema = createSchema({
  tables: [agents, tickets, schedules],
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
}));
