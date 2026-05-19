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
  createSchema,
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

// Explicit annotation: `createSchema`'s inferred return type references a
// private path inside @rocicorp/zero's `out/zero-types/src/schema`, which
// TS rejects with TS2742 ("not portable"). Annotating with the exported
// `Schema` (renamed to `ZeroSchema` at import) keeps consumers' .d.ts
// emit clean.
export const schema: ZeroSchema = createSchema({
  tables: [agents],
});

export type Schema = typeof schema;
