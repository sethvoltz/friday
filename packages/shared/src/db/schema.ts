// Friday — Postgres schema (ADR-023).
//
// This file replaces `schema.ts` once Phase 1 of the Postgres+Zero cutover
// completes. During Phase 0 it lives side-by-side so migrations can be
// generated and inspected without breaking the live SQLite code path.
//
// Conventions:
//   * Snake_case column names (existing convention).
//   * Timestamps are `timestamptz` (microsecond precision). Old ms-since-epoch
//     ints are converted on import via the legacy-sqlite migrator.
//   * JSON columns are `jsonb`. The Drizzle types reflect that — callers stop
//     hand-rolling JSON.stringify/parse in Phase 1.
//   * Booleans are real `boolean` (no more integer-as-bool).
//   * Status columns are `text` with CHECK constraints (ADR-023: prefer
//     CHECK over Postgres enums for ergonomic adding-values later).
//   * Full-text search uses generated `tsvector` columns + GIN indexes; the
//     migration adds the column + index via a raw SQL step (Drizzle doesn't
//     model generated columns as a first-class primitive yet).

import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* ---------------- Embedding vector type (FRI-24) ---------------- */
// pgvector column dimensionality — single source of truth shared with
// @friday/memory (it imports EMBEDDING_DIM to size the embedder output).
// The local embedding model (all-MiniLM-L6-v2) emits 384-dim vectors.
export const EMBEDDING_DIM = 384;

/**
 * Drizzle custom type mapping a pgvector `vector(N)` column. Postgres
 * serializes the vector as a bracketed string (`[1,2,3]`); we marshal a
 * `number[]` on the app side. The `vector` extension is created
 * pre-migration via an admin connection (see `ensureVectorExtension` in
 * pg-provision.ts) — pgvector 0.8.2 is NOT a trusted extension, so the
 * non-superuser `friday` role can't `CREATE EXTENSION` itself.
 */
const vectorType = (dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(",")}]`;
    },
    fromDriver(value: string): number[] {
      return JSON.parse(value) as number[];
    },
  });

/* ---------------- BetterAuth tables ---------------- */
// BetterAuth's Postgres adapter expects these exact shapes (singular table
// names, camelCase columns). The authoritative shape is whatever BetterAuth's
// runtime writes; this typed declaration is for app-side use.

export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
});

export const sessions = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId").notNull(),
});

export const accounts = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId").notNull(),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", {
    withTimezone: true,
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
});

export const verifications = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true }),
  updatedAt: timestamp("updatedAt", { withTimezone: true }),
});

// FRI-171 (ADR-047): the `apikey` table backs the BetterAuth API Key
// plugin (`@better-auth/api-key@1.6.9`) that issues Capture keys for the
// stateless `/api/capture` endpoint. Server-only — NOT in SYNC_TABLES,
// gated the same way as `user`/`session`/`account`/`verification`.
//
// The exact field set is the plugin's `apiKeySchema` (probed from the
// installed 1.6.9 `dist/index.mjs` `apiKeySchema(...)` factory). The
// BetterAuth Drizzle adapter resolves a column by indexing this table
// object with the plugin's *field key* (`field.fieldName || key`, no
// snake_case conversion — see `@better-auth/drizzle-adapter` `getSchema`),
// so the JS PROPERTY KEYS below MUST match the plugin field names verbatim
// (camelCase). A key mismatch makes `verifyApiKey` silently fail. Physical
// column names are kept camelCase to match the existing BetterAuth tables
// above. Two fields differ from the FRI-171 contract §5 draft and are
// load-bearing:
//   * `configId` — required (default 'default'); the 1.6.9 plugin moved
//     rate-limit/permission knobs under a config system and writes this
//     column on every key. Omitting it breaks key creation.
//   * `referenceId` — the owner id (the plugin's 1.6.9 name for what older
//     docs called `userId`); conceptually references `user.id`. Declared as
//     plain `text` with no Drizzle `.references()` to match how `session`/
//     `account` declare their `userId` columns in this repo.
export const apikeys = pgTable("apikey", {
  id: text("id").primaryKey(),
  // Owner of the key — the BetterAuth user id (references user.id; the
  // existing BA tables don't declare a Drizzle FK, so neither does this).
  referenceId: text("referenceId").notNull(),
  // Config bucket the key belongs to (rate-limit/permission profile).
  configId: text("configId").notNull().default("default"),
  name: text("name"),
  // First few chars of the plaintext key, shown in management UIs.
  start: text("start"),
  prefix: text("prefix"),
  // The hashed key (SHA-256 base64url). Never the plaintext.
  key: text("key").notNull(),
  refillInterval: integer("refillInterval"),
  refillAmount: integer("refillAmount"),
  lastRefillAt: timestamp("lastRefillAt", { withTimezone: true }),
  enabled: boolean("enabled").notNull().default(true),
  rateLimitEnabled: boolean("rateLimitEnabled").notNull().default(true),
  rateLimitTimeWindow: integer("rateLimitTimeWindow"),
  rateLimitMax: integer("rateLimitMax"),
  requestCount: integer("requestCount").notNull().default(0),
  // null ⇒ unlimited remaining; a number ⇒ remaining quota.
  remaining: integer("remaining"),
  lastRequest: timestamp("lastRequest", { withTimezone: true }),
  expiresAt: timestamp("expiresAt", { withTimezone: true }),
  // JSON-stringified Record<string,string[]> (e.g. {"capture":["write"]}).
  permissions: text("permissions"),
  // JSON-stringified arbitrary metadata; the plugin transforms in/out.
  metadata: text("metadata"),
  createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull(),
});

/* ---------------- Agents registry (ADR-013, ADR-022) ---------------- */

export const agents = pgTable(
  "agents",
  {
    name: text("name").primaryKey(),
    type: text("type").notNull(), // orchestrator|builder|helper|scheduled|bare
    status: text("status").notNull(), // idle|working|stalled|archived|archive_requested
    sessionId: text("session_id"),
    parentName: text("parent_name"), // for builder/helper/bare
    worktreePath: text("worktree_path"), // for builder
    branch: text("branch"),
    ticketId: text("ticket_id"),
    metaJson: jsonb("meta_json"),
    // ADR-022: rationale recorded when a non-orchestrator spawned this agent.
    spawnReason: text("spawn_reason"),
    // ADR-021: owning app id; null for unaffiliated agents (orchestrator,
    // ad-hoc bare, builders, helpers). Tombstoned on app uninstall so a
    // reinstall can un-archive the same row.
    appId: text("app_id"),
    // ADR-023: when archive was requested by a mutator (before the daemon
    // picked it up). Used to drive the daemon's archive side-effect handler.
    archiveReason: text("archive_reason"),
    // Durable compaction-in-progress signal. Stamped `now()` by the daemon
    // (sole writer) on the SDK's `compacting` start frame and cleared to NULL
    // on the matching `done` frame; also nulled on any transition out of
    // `working` and on boot reconcile so a worker that dies mid-compaction
    // can't wedge it on. NULL = not compacting. Replicated via Zero so the
    // dashboard's "Compacting context…" indicator RECONSTRUCTS on
    // reload/reconnect — the transient `compacting` SSE event alone is
    // in-memory and lost across the daemon-restart window. Drives the sidebar
    // dot, the chat-pane indicator, and the elapsed-time readout.
    compactingSince: timestamp("compacting_since", { withTimezone: true }),
    // Distinct session count across this agent's `blocks` rows. Maintained
    // by an AFTER INSERT trigger on `blocks` (see migration
    // `0020_session_count_trigger.sql`) so the sidebar's expand-history
    // button can render off a live-replicated column without paying a
    // per-row `COUNT(DISTINCT)` from the dashboard. Default 0 covers the
    // pre-first-turn window before any block has been recorded.
    sessionCount: integer("session_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    typeIdx: index("agents_type").on(t.type),
    statusIdx: index("agents_status").on(t.status, t.updatedAt),
    appIdx: index("agents_app").on(t.appId),
    typeCheck: check(
      "agents_type_check",
      sql`${t.type} IN ('orchestrator','builder','helper','scheduled','bare','planner')`,
    ),
    statusCheck: check(
      "agents_status_check",
      sql`${t.status} IN ('idle','working','stalled','archived','archive_requested')`,
    ),
  }),
);

/* ---------------- Blocks (per-content-block chat persistence) ---------------- */
// One row per content block (text / thinking / tool_use / tool_result, plus
// user-typed and mail-delivered user-role blocks). `block_id` is a daemon-
// or dashboard-mutator-minted UUID and the stable client-facing identity.
// `turn_id` groups blocks belonging to one user-prompt cycle.
//
// ADR-024 change from the SQLite era: rows are written *only on
// block_complete* with `streaming=false`. Zero replicates rows scoped to
// `WHERE streaming=false`. In-flight bytes live in the daemon's `blockStream`
// in-memory accumulator and ride per-agent SSE.

export const blocks = pgTable(
  "blocks",
  {
    // Phase 4.11: flipped from bigserial → text (UUID). Zero
    // mutators require the row's PK in the INSERT args so the
    // optimistic client write and the canonical server write land
    // on the same row. `gen_random_uuid()::text` default keeps the
    // existing daemon-side `recordUserBlock` callsites working
    // without supplying an id. `blockId` (text UUID) is retained
    // as a separate column for the daemon-side write path; new
    // mutator-driven writes set both columns to the same UUID.
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    blockId: text("block_id").notNull().unique(),
    turnId: text("turn_id").notNull(),
    agentName: text("agent_name").notNull(),
    sessionId: text("session_id").notNull(),
    messageId: text("message_id"),
    blockIndex: integer("block_index").notNull(),
    role: text("role").notNull(), // user|assistant|system
    kind: text("kind").notNull(), // text|thinking|tool_use|tool_result|error|mail|compaction
    source: text("source"), // user_chat|mail|queue_inject|sdk|scratch|agent_spawn|schedule|refork_notice|dashboard-mutator
    // BetterAuth user id of the human who authored this block, when there is
    // one. Stamped by the `sendUserMessage` mutator from the verified JWT
    // (zero-cache forwards it; the dashboard verifies the token server-side),
    // so the identity survives the process hop to the daemon, which reads it
    // to attribute PostHog events to the originating user. NULL for
    // daemon/agent/autonomous writes (mail, schedule, agent_spawn, …), which
    // attribute to the `friday-daemon` service actor instead. Nullable +
    // forward-only: existing rows stay NULL.
    userId: text("user_id"),
    contentJson: jsonb("content_json").notNull(),
    status: text("status").notNull(), // pending|streaming|complete|aborted|error|queued|abort_requested|dispatched|cancel_requested|resume_requested
    streaming: boolean("streaming").notNull().default(false),
    // ADR-023 mutator origin (for Zero idempotency cross-check + diagnostics).
    originMutationId: text("origin_mutation_id"),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
  },
  (t) => ({
    agentTsIdx: index("blocks_agent_ts").on(t.agentName, t.ts),
    sessionMsgIdx: index("blocks_session_msg").on(t.sessionId, t.messageId, t.blockIndex),
    turnIdx: index("blocks_turn").on(t.turnId),
    // ADR-023: daemon LISTENs on (source='dashboard-mutator', status='pending')
    // and similar — speed those scans up.
    pendingIdx: index("blocks_pending")
      .on(t.status, t.ts)
      .where(sql`${t.status} IN ('pending','abort_requested')`),
    roleCheck: check("blocks_role_check", sql`${t.role} IN ('user','assistant','system')`),
    kindCheck: check(
      "blocks_kind_check",
      sql`${t.kind} IN ('text','thinking','tool_use','tool_result','error','mail','compaction')`,
    ),
    statusCheck: check(
      "blocks_status_check",
      sql`${t.status} IN ('pending','streaming','complete','aborted','error','queued','abort_requested','dispatched','cancel_requested','resume_requested')`,
    ),
  }),
);

/* ---------------- Mail (inter-agent messaging) ---------------- */

export const mail = pgTable(
  "mail",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    fromAgent: text("from_agent").notNull(),
    toAgent: text("to_agent").notNull(),
    type: text("type").notNull(), // message|notification|task
    // FRI-117: TS unions AND DB check constraint both restricted to
    // {pending, read, closed}. The legacy `delivered` value is fully
    // retired (FRI-116 narrowed the TS union, FRI-119 #2 / migration
    // 0022 tightens the DB constraint).
    delivery: text("delivery").notNull(), // pending|read|closed
    subject: text("subject"),
    threadId: text("thread_id"),
    body: text("body").notNull(),
    metaJson: jsonb("meta_json"),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // ADR-014: 'normal' drains at next turn boundary; 'critical' mid-turn.
    priority: text("priority").notNull().default("normal"),
    originMutationId: text("origin_mutation_id"),
  },
  (t) => ({
    inboxIdx: index("mail_inbox").on(t.toAgent, t.delivery, t.ts),
    threadIdx: index("mail_thread").on(t.threadId, t.ts),
    priorityCheck: check("mail_priority_check", sql`${t.priority} IN ('normal','critical')`),
    deliveryCheck: check("mail_delivery_check", sql`${t.delivery} IN ('pending','read','closed')`),
  }),
);

/* ---------------- Tickets ---------------- */

export const tickets = pgTable(
  "tickets",
  {
    id: text("id").primaryKey(), // FRI-1234
    title: text("title").notNull(),
    body: text("body"),
    status: text("status").notNull(), // open|in_progress|done|blocked|closed
    kind: text("kind").notNull(), // task|epic|bug|chore
    assignee: text("assignee"),
    metaJson: jsonb("meta_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    statusIdx: index("tickets_status").on(t.status, t.updatedAt),
    assigneeIdx: index("tickets_assignee").on(t.assignee),
    statusCheck: check(
      "tickets_status_check",
      sql`${t.status} IN ('open','in_progress','done','blocked','closed')`,
    ),
  }),
);

export const ticketRelations = pgTable(
  "ticket_relations",
  {
    parentId: text("parent_id").notNull(),
    childId: text("child_id").notNull(),
    kind: text("kind").notNull(), // depends_on|child_of|blocks|relates_to
  },
  (t) => ({
    pk: primaryKey({ columns: [t.parentId, t.childId, t.kind] }),
  }),
);

export const ticketComments = pgTable(
  "ticket_comments",
  {
    // Phase 4.4: id flipped from bigserial → text(uuid). The Zero
    // mutator framework requires the row's PK in the args so the
    // optimistic client write and the canonical server write target
    // the same row; bigserial's server-assigned values broke that
    // round-trip. Default is server-side `gen_random_uuid()::text`
    // so the legacy `addComment` REST service path continues to
    // work without changes.
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    ticketId: text("ticket_id").notNull(),
    author: text("author").notNull(),
    body: text("body").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
  },
  (t) => ({
    ticketIdx: index("ticket_comments_ticket").on(t.ticketId, t.ts),
  }),
);

export const ticketExternalLinks = pgTable(
  "ticket_external_links",
  {
    ticketId: text("ticket_id").notNull(),
    system: text("system").notNull(), // linear|github|...
    externalId: text("external_id").notNull(),
    url: text("url"),
    metaJson: jsonb("meta_json"),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticketId, t.system, t.externalId] }),
    bySystemIdx: index("ticket_external_by_system").on(t.system, t.externalId),
  }),
);

/* ---------------- Attachments ---------------- */
// Metadata only — content-addressed bytes live on the daemon's filesystem
// at ~/.friday/uploads/<sha-bucket>/<sha>.<ext> (ADR-007). Clients fetch
// bytes via an authed URL when they need them.

export const attachments = pgTable("attachments", {
  sha256: text("sha256").primaryKey(),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull(),
  firstTurnId: text("first_turn_id"),
});

/* ---------------- Schedules ---------------- */

export const schedules = pgTable(
  "schedules",
  {
    name: text("name").primaryKey(),
    cron: text("cron"),
    runAt: text("run_at"),
    taskPrompt: text("task_prompt").notNull(),
    paused: boolean("paused").notNull().default(false),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunId: text("last_run_id"),
    metaJson: jsonb("meta_json"),
    appId: text("app_id"),
    kind: text("kind").notNull().default("agent-run"),
    deliveryJson: jsonb("delivery_json"),
    // ADR-023: mutator-driven status transitions for register/unregister/pause.
    // active|pending_register|reload_requested|deleted|trigger_requested
    // (trigger_requested = dashboard wants the schedule to fire NOW;
    // daemon's listener calls fireSchedule then flips status back to
    // 'active'.)
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    nextRunIdx: index("schedules_next_run").on(t.nextRunAt),
    appIdx: index("schedules_app").on(t.appId),
    statusCheck: check(
      "schedules_status_check",
      sql`${t.status} IN ('active','pending_register','reload_requested','deleted','paused','trigger_requested')`,
    ),
    kindCheck: check("schedules_kind_check", sql`${t.kind} IN ('agent-run','reminder')`),
  }),
);

/* ---------------- ADR-024: schedule_runs (replaces SSE schedule_fired event) ---------------- */

export const scheduleRuns = pgTable(
  "schedule_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scheduleName: text("schedule_name").notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull(),
    status: text("status").notNull(), // running|complete|error
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
  },
  (t) => ({
    scheduleTsIdx: index("schedule_runs_schedule_ts").on(t.scheduleName, t.firedAt),
    statusCheck: check(
      "schedule_runs_status_check",
      sql`${t.status} IN ('running','complete','error')`,
    ),
  }),
);

/* ---------------- Habits (FRI-169) ---------------- */
// A Habit is a recurring thing the user checks off; a Check-in is one
// timestamped completion. The Streak (run of consecutive Satisfied
// periods) is DERIVED ON READ from the habit_checkins log against now()
// and is never stored — see packages/shared/src/habits/streak.ts.
//
// `id` is text-uuid (gen_random_uuid()::text) — NOT bigserial — because
// the `habitCheckin` Zero mutator does tx.mutate.habit_checkins.insert()
// and the client must supply the PK at INSERT so the optimistic write and
// the canonical write land on the same row (same convention as
// `blocks`:170-172 and `ticket_comments`:299-301). `habits.id` matches
// for consistency and to keep habit-CRUD-via-mutator open as a future
// option.

export const habits = pgTable(
  "habits",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    name: text("name").notNull(),
    description: text("description"),
    // Habit mode (Ongoing|Bounded) — Ongoing never archives on its own;
    // Bounded runs against a window (window_start/window_end) and archives
    // completed|expired when the window closes.
    mode: text("mode").notNull(),
    // Target: Check-ins required within one Period to satisfy it (default 1).
    target: integer("target").notNull().default(1),
    // Period: the recurrence window the Target is measured over.
    period: text("period").notNull(),
    // days_of_week: weekday bitmask (Sun=bit0 … Sat=bit6), nullable. Only
    // meaningful for period='day' (e.g. Mon/Wed/Fri). NULL otherwise — the
    // orthogonality check() below enforces that invariant.
    daysOfWeek: integer("days_of_week"),
    // Time-of-day bucket: optional display/scheduling attribute; metadata
    // only (NOT a Streak determinant in v1). Nullable.
    bucket: text("bucket"),
    // Habit color: stored as an index (1–7), never a hex. The active
    // Palette supplies the actual color via its --habit-{N} ramp.
    colorIndex: integer("color_index"),
    // Bounded-mode window (NULL for Ongoing habits).
    windowStart: timestamp("window_start", { withTimezone: true }),
    windowEnd: timestamp("window_end", { withTimezone: true }),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    statusIdx: index("habits_status").on(t.status, t.updatedAt),
    bucketIdx: index("habits_bucket").on(t.bucket),
    modeCheck: check("habits_mode_check", sql`${t.mode} IN ('ongoing','bounded')`),
    periodCheck: check("habits_period_check", sql`${t.period} IN ('day','week','month','year')`),
    bucketCheck: check(
      "habits_bucket_check",
      sql`${t.bucket} IS NULL OR ${t.bucket} IN ('morning','afternoon','evening','anytime')`,
    ),
    colorIndexCheck: check(
      "habits_color_index_check",
      sql`${t.colorIndex} IS NULL OR ${t.colorIndex} BETWEEN 1 AND 7`,
    ),
    statusCheck: check(
      "habits_status_check",
      sql`${t.status} IN ('active','archived','completed','expired')`,
    ),
    // Orthogonality guard (AC3): days_of_week is only meaningful for a
    // day-Period habit. Reject a non-null mask on any other period.
    daysOfWeekPeriodCheck: check(
      "habits_days_of_week_period_check",
      sql`${t.daysOfWeek} IS NULL OR ${t.period} = 'day'`,
    ),
  }),
);

// Append-only Check-in log. One row per logged completion. Backdating is
// supported by accepting a past `ts`. The single allowed mutation beyond
// INSERT is the `habitCheckinUndo` mutator's single-row DELETE.
export const habitCheckins = pgTable(
  "habit_checkins",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    habitId: text("habit_id")
      .notNull()
      .references(() => habits.id),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    note: text("note"),
    // Server-stamped insert clock. Defaulted via now() so the optimistic
    // `habitCheckin` Zero mutator (which writes only id/habit_id/ts/note)
    // and the MCP/daemon HTTP write path both land a valid row without
    // having to synthesize this value client-side. `ts` (the completion
    // time, which backdating moves) stays distinct from `created_at` (when
    // the row was logged). Matches the now()-default convention used by
    // `secrets_fetch_log.ts` and `_friday_state_migrations.applied_at`.
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    habitTsIdx: index("habit_checkins_habit_ts").on(t.habitId, t.ts),
  }),
);

/* ---------------- Inbox (FRI-171, ADR-047) ---------------- */
// Stateless Capture & Intake routing. Each Capture (Watch quick-add, etc.)
// is classified by a single-turn daemon-side classifier into an Intake
// verdict; the daemon writes ONE `inbox_items` row recording the outcome:
//   * kind='done'      — the executor ran (act path); `undoable`/`inverse_label`/
//                        `deep_link` reference the created artifact.
//   * kind='proposed'  — staged for review (propose path, or payload failed
//                        validation and degraded — never dropped); `payload`
//                        carries the executable verdict for approve/triage.
//   * kind='unsorted'  — Gate 1 failure (no confident route); `target_id` null.
// `state` (open|resolved) — NOT `status` (`status` is reserved per the glossary).
// open Done items auto-resolve on bell view; Proposed/Unsorted resolve on an
// explicit user action (approve/reject/dismiss/triage). Replicated to Zero.
export const inboxItems = pgTable(
  "inbox_items",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    // Capture provenance (watch | quick_add | …). Open set — no CHECK.
    source: text("source").notNull(),
    // The original Capture text, verbatim.
    rawText: text("raw_text").notNull(),
    // The classifier's faithfully-cleaned form (null until classified).
    cleanedText: text("cleaned_text"),
    // Chosen Route target id (e.g. 'core:reminder', 'agent:foo'); null ⇒ Unsorted.
    targetId: text("target_id"),
    // The executable payload for the target's executor (approve/triage use it).
    payload: jsonb("payload"),
    // One-line human-readable reason for the route/disposition.
    rationale: text("rationale"),
    // FIXED at creation: which lane this Capture landed in.
    kind: text("kind").notNull(),
    // Lifecycle state. Defaults to 'open'; flips to 'resolved' on view/action.
    state: text("state").notNull().default("open"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // Drives the Undo-vs-View CTA on a Done item.
    undoable: boolean("undoable").notNull().default(false),
    // Human label for the inverse action (e.g. 'Delete the reminder').
    inverseLabel: text("inverse_label"),
    // Deep-link to the created artifact (e.g. '/habits', '/tickets/<id>').
    deepLink: text("deep_link"),
  },
  (t) => ({
    // Open-items / bell query: filter by state, order by recency.
    stateCreatedIdx: index("inbox_items_state_created").on(t.state, t.createdAt),
    kindCheck: check("inbox_items_kind_check", sql`${t.kind} IN ('done','proposed','unsorted')`),
    stateCheck: check("inbox_items_state_check", sql`${t.state} IN ('open','resolved')`),
  }),
);

/* ---------------- Apps registry (ADR-021) ---------------- */

export const apps = pgTable(
  "apps",
  {
    id: text("id").primaryKey(), // [a-z][a-z0-9-]{1,63}; matches folder name
    name: text("name").notNull(),
    version: text("version").notNull(),
    manifestVersion: integer("manifest_version").notNull(),
    folderPath: text("folder_path").notNull(),
    manifestJson: jsonb("manifest_json").notNull(),
    status: text("status").notNull(), // installed | orphaned | error | pending_install | uninstall_requested | reload_requested
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull(),
    upgradedAt: timestamp("upgraded_at", { withTimezone: true }),
    metaJson: jsonb("meta_json"),
  },
  (t) => ({
    statusCheck: check(
      "apps_status_check",
      sql`${t.status} IN ('installed','orphaned','error','pending_install','uninstall_requested','reload_requested')`,
    ),
  }),
);

/* ---------------- Memory entries ---------------- */
// Bodies live as markdown files in ~/.friday/memory/entries/. We mirror them
// here for fast lookup, FTS, and recall counters. The tsvector column is
// added via raw SQL post-migration (Drizzle doesn't model generated columns
// natively today).

export const memoryEntries = pgTable(
  "memory_entries",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    tagsJson: jsonb("tags_json")
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    fileMtime: timestamp("file_mtime", { withTimezone: true }).notNull(),
    recallCount: integer("recall_count").notNull().default(0),
    lastRecalledAt: timestamp("last_recalled_at", { withTimezone: true }),
    // ADR-023: pending_file → ready; daemon-side mutator writes the markdown
    // file on filesystem and flips status.
    status: text("status").notNull().default("ready"),
    // FRI-24: pgvector embedding for semantic recall. NULLABLE — populated
    // by app code (the daemon's embedder), not a generated column. Server-
    // side only: like content_tsv it is NOT replicated to Zero (ADR-025);
    // it never appears in the sync schema or the publication.
    embedding: vectorType(EMBEDDING_DIM)("embedding"),
  },
  (t) => ({
    statusCheck: check(
      "memory_entries_status_check",
      sql`${t.status} IN ('ready','pending_file','pending_delete','deleted')`,
    ),
  }),
);

/* ---------------- Item #54: evolve proposals ---------------- */
// Mirrors the YAML frontmatter at `~/.friday/evolve/proposals/<id>.md`.
// Dashboard /evolve reads from Zero reactively (replaces the REST
// proxy). The daemon's existing evolve store dual-writes to PG + FS
// during the transition; FS stays as the audit trail.

export const evolveProposals = pgTable(
  "evolve_proposals",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    // memory | docs | code | prompts | tooling (open string; the
    // evolve store doesn't enforce a closed enum)
    proposalType: text("proposal_type").notNull(),
    // open | applied | dismissed | critical
    status: text("status").notNull().default("open"),
    clusterId: text("cluster_id"),
    score: doublePrecision("score").notNull().default(0),
    // low | medium | high
    blastRadius: text("blast_radius").notNull().default("low"),
    appliesTo: jsonb("applies_to")
      .notNull()
      .default(sql`'[]'::jsonb`),
    signals: jsonb("signals")
      .notNull()
      .default(sql`'[]'::jsonb`),
    body: text("body").notNull(), // the markdown proposedChange
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    appliedBy: text("applied_by"),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
    enrichedBy: text("enriched_by"),
    lastEnrichError: text("last_enrich_error"),
    lastEnrichFailedAt: timestamp("last_enrich_failed_at", {
      withTimezone: true,
    }),
    appliedTicketId: text("applied_ticket_id"),
    // Set when the proposal was auto-resolved at creation because a sibling
    // proposal with the same signal-family key (event name) was applied
    // within the family-resolution window. References that sibling's id.
    // See `@friday/evolve` `findRecentlyAppliedByFamilyKey`.
    familyResolvedBy: text("family_resolved_by"),
  },
  (t) => ({
    statusIdx: index("evolve_proposals_status_updated").on(t.status, t.updatedAt),
    clusterIdx: index("evolve_proposals_cluster").on(t.clusterId),
  }),
);

/* ---------------- Usage (Claude API call accounting) ---------------- */

export const usage = pgTable(
  "usage",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    sessionId: text("session_id").notNull(),
    agentName: text("agent_name"),
    agentType: text("agent_type"), // orchestrator|builder|helper|scheduled|bare
    model: text("model"),
    costUsd: doublePrecision("cost_usd"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    turnNumber: integer("turn_number"),
    durationMs: integer("duration_ms"),
  },
  (t) => ({
    sessionTsIdx: index("usage_session_ts").on(t.sessionId, t.timestamp),
    agentTsIdx: index("usage_agent_ts").on(t.agentName, t.timestamp),
    tsIdx: index("usage_ts").on(t.timestamp),
  }),
);

/* ---------------- Per-request usage (live-context back-compute) ---------------- */
// One row per API request WITHIN a turn. The per-turn `usage` row above stores
// the SDK's CUMULATIVE `result.usage` for the whole turn — correct for cost but
// wrong for live-context estimation: `cache_read_input_tokens` is re-counted on
// every API round-trip in a multi-tool-call turn, so the cumulative figure
// inflates to a large multiple of the true window.
//
// The true live context window = the prompt size of the LAST (max-`seq`) request
// in the turn = that single request's `input + cache_read + cache_creation`. The
// SDK streams a per-request `usage` on each `assistant` message; we persist each
// here so the nightly compaction sweep (and any later consumer) can back-compute
// the real window. Like `usage`, this is high-volume append-only telemetry and is
// NOT in SYNC_TABLES (server-side reads only).
export const usageRequest = pgTable(
  "usage_request",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    agentName: text("agent_name"),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    /** Request index within the turn (0-based, in arrival order). The max-`seq`
     *  row is the turn's final request — the one whose prompt size IS the live
     *  context window. */
    seq: integer("seq").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  },
  (t) => ({
    // The live-window query: latest turn for an agent (scoped to session),
    // then its max-`seq` row. Covered by an (agent, session, ts, turn, seq) sort.
    agentSessionTsIdx: index("usage_request_agent_session_ts").on(
      t.agentName,
      t.sessionId,
      t.timestamp,
    ),
    turnSeqIdx: index("usage_request_turn_seq").on(t.turnId, t.seq),
  }),
);

/* ---------------- ADR-023: client_devices ---------------- */
// First-class device tracking. Created on first bootstrap. Storage telemetry
// reported via the reportClientStats mutator; `Forget this device` mutator
// deletes the row + invalidates future JWT minting.

export const clientDevices = pgTable(
  "client_devices",
  {
    deviceId: text("device_id").primaryKey(),
    userId: text("user_id").notNull(),
    userAgent: text("user_agent"),
    label: text("label"), // user-editable
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    // bigint: browser storage quotas routinely exceed Postgres
    // `integer`'s 2 GB ceiling (10–50 GB is normal on desktop). Mode
    // `number` lets JS handle them as numbers as long as the value
    // stays ≤ Number.MAX_SAFE_INTEGER (9 PB), which storage estimates
    // always will.
    storageUsedBytes: bigint("storage_used_bytes", { mode: "number" }),
    storageQuotaBytes: bigint("storage_quota_bytes", { mode: "number" }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    // Plan §41: meaningful "Forget this device" revokes JWT minting.
    // Non-null means the device has been forgotten; `/api/sync/refresh`
    // returns 401 on any further mint attempt for this deviceId. The
    // user has to clear the local `friday-device-id` cookie (or sign
    // out + back in, which the dashboard does automatically when
    // forgetting the current tab) to mint under a fresh device row.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("client_devices_user").on(t.userId, t.lastSeenAt),
    // Fast deny-list lookup keyed by (deviceId, revokedAt IS NOT NULL).
    // The refresh handler queries by deviceId already; the partial
    // index lets the planner read just revoked rows without a seq scan.
    revokedIdx: index("client_devices_revoked").on(t.deviceId, t.revokedAt),
  }),
);

/* ---------------- ADR-023: read_cursors (per-device, per-agent) ---------------- */
// Replaces today's per-device localStorage badge state. Synced via Zero so
// reads on one device update unread badges on all others.

export const readCursors = pgTable(
  "read_cursors",
  {
    deviceId: text("device_id").notNull(),
    agentName: text("agent_name").notNull(),
    lastSeenBlockId: text("last_seen_block_id").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    // Item #52: server-computed unread badge counter. A Postgres
    // trigger on `blocks` INSERT increments this for every row whose
    // (deviceId, agentName) matches the new block's agent. The
    // `markRead` mutator resets it to 0 atomically with the
    // last_seen_block_id update. Drives the sidebar badge reactively
    // via Zero — replaces the prior SSE-`agent_message`-driven
    // `chat.unreadByAgent` derivation.
    unreadCount: integer("unread_count").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.deviceId, t.agentName] }),
  }),
);

/* ---------------- ADR-024: system_banners (replaces SSE system_banner event) ---------------- */

export const systemBanners = pgTable(
  "system_banners",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    level: text("level").notNull(), // info|warn|error
    text: text("text").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  },
  (t) => ({
    activeIdx: index("system_banners_active")
      .on(t.ts)
      .where(sql`${t.dismissedAt} IS NULL`),
    levelCheck: check("system_banners_level_check", sql`${t.level} IN ('info','warn','error')`),
  }),
);

/* ---------------- ADR-023: settings (user-toggleable config) ---------------- */
// Per ADR-023 line 565: `updateSettings` mutator writes here. Daemon
// LISTENs and re-syncs `~/.friday/config.json` so worker spawns see
// the new values via the existing `loadConfig()` reads. The set of
// columns here is exactly the user-toggleable subset of FridayConfig;
// structural fields (ports, mcpServers, etc.) stay in config.json
// and aren't user-edited from the dashboard.
//
// Single-row table — primary key is the literal string "singleton".
// Postgres ON CONFLICT (id) on UPSERT collapses a duplicate insert
// to a no-op; the mutator's race-condition contract holds.
//
// `updated_at` is server-stamped (the mutator's clock-of-record) so
// the daemon's LISTEN handler can dedup duplicate notifications.

// FRI-124: theme columns are NULLable; the dashboard's resolver treats
// NULL as "user hasn't picked for this slot yet" and falls back to a
// built-in default. The daemon's LISTEN handler ignores these columns —
// theme state is dashboard-only and is not synced into config.json.

// FRI-16: `models` / `evolve_models` mirror `cfg.models` /
// `cfg.evolve.models` (per-role and per-evolve-task model overrides).
// `~/.friday/config.json` is canonical; the row is a cache for Zero
// replication. `updateSettings` is a pure DB patch; the daemon's
// listener owns the canonical merge into config.json (deep-equal
// guarded so byte-identical rows don't rewrite the file). The
// inherited clobber-race between a hand-edited file and a stale row
// write is unchanged in scope — tracked as a follow-up.
export const settings = pgTable("settings", {
  id: text("id").primaryKey(),
  model: text("model"),
  watchdogRefork: boolean("watchdog_refork"),
  themeKind: text("theme_kind"),
  themePaletteSingle: text("theme_palette_single"),
  themePaletteLight: text("theme_palette_light"),
  themePaletteDark: text("theme_palette_dark"),
  /** Partial<Record<AgentTypeName, string | ModelConfig>> — see config.ts */
  models: jsonb("models"),
  /** Partial<Record<EvolveTaskName, string | ModelConfig>> — see config.ts */
  evolveModels: jsonb("evolve_models"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

/* ---------------- Secrets audit (ADR-038) ---------------- */

export const secretsFetchLog = pgTable(
  "secrets_fetch_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    secretName: text("secret_name").notNull(),
    callerName: text("caller_name").notNull(),
    callerType: text("caller_type").notNull(),
    appId: text("app_id"),
    reason: text("reason").notNull(),
    source: text("source").notNull(),
    ts: timestamp("ts", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("secrets_fetch_log_caller_ts_idx").on(t.callerName, t.ts),
    check("secrets_fetch_log_source_check", sql`${t.source} IN ('mcp', 'cli')`),
  ],
);

/* ---------------- Generic key/value store ---------------- */

export const dbMeta = pgTable("db_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/* ---------------- One-shot daemon-side state migrations ---------------- */
// Distinct from Drizzle's schema migrations (`drizzle.__drizzle_migrations`).
// Tracks imperative data/filesystem migrations the daemon runs once at
// boot — e.g. renaming SDK JSONL paths after FRI-61's cwd pin. Versioned
// by ID; a re-run with patched logic ships a new ID (`*-v2`) rather than
// mutating the existing row, mirroring Drizzle's "preserve over delete"
// stance for migration history.
export const fridayStateMigrations = pgTable("_friday_state_migrations", {
  id: text("id").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  metaJson: jsonb("meta_json"),
});

/* ---------------- FTS setup SQL ---------------- */
// Postgres tsvector + GIN indexes. Run after the Drizzle migration creates
// the base tables. The generated `*_tsv` columns are populated by trigger;
// queries do `SELECT … WHERE *_tsv @@ plainto_tsquery(?)`.

/**
 * Static SQL string applied via raw `client.query()` after the Drizzle
 * migration creates the base tables. Drizzle's `sql` template literal would
 * need parameterization rebuilding for multi-statement raw application; we
 * keep this as a plain string for clarity and to avoid the round-trip.
 */
export const FTS_SETUP_SQL = `
  -- blocks: search across the text payload portion of content_json.
  -- content_json is jsonb; we extract a 'text' field if present, else
  -- the whole thing serialized as text.
  ALTER TABLE blocks
    ADD COLUMN IF NOT EXISTS content_tsv tsvector
    GENERATED ALWAYS AS (
      to_tsvector('english', coalesce(content_json->>'text', content_json::text))
    ) STORED;
  CREATE INDEX IF NOT EXISTS blocks_content_tsv_idx ON blocks USING GIN (content_tsv);

  -- memory_entries: search across title + content + tags.
  ALTER TABLE memory_entries
    ADD COLUMN IF NOT EXISTS content_tsv tsvector
    GENERATED ALWAYS AS (
      to_tsvector(
        'english',
        coalesce(title, '') || ' ' ||
        coalesce(content, '') || ' ' ||
        coalesce(tags_json::text, '')
      )
    ) STORED;
  CREATE INDEX IF NOT EXISTS memory_entries_content_tsv_idx
    ON memory_entries USING GIN (content_tsv);

  -- memory_entries: HNSW index for pgvector cosine-distance similarity
  -- search over the embedding column (FRI-24). The vector extension is
  -- ensured pre-migration (ensureVectorExtension) so the type + opclass
  -- exist by the time this runs; CREATE INDEX by the table owner (friday)
  -- needs no superuser.
  CREATE INDEX IF NOT EXISTS memory_entries_embedding_idx
    ON memory_entries USING hnsw (embedding vector_cosine_ops);

  -- mail: search across subject + body.
  ALTER TABLE mail
    ADD COLUMN IF NOT EXISTS content_tsv tsvector
    GENERATED ALWAYS AS (
      to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(body, ''))
    ) STORED;
  CREATE INDEX IF NOT EXISTS mail_content_tsv_idx ON mail USING GIN (content_tsv);
`;

/* ---------------- LISTEN/NOTIFY channels (ADR-023) ---------------- */
// Channel names the daemon listens on. The dashboard mutator (or daemon-
// internal writers) does NOTIFY <channel> after a relevant INSERT/UPDATE.
// Boot recovery scans the same WHERE clauses.

export const LISTEN_CHANNELS = {
  /** New user-block written with status='pending' by a dashboard mutator. */
  newPendingBlock: "friday_new_pending_block",
  /** Block UPDATE status='abort_requested' — fast-path-supplemented. */
  abortRequested: "friday_abort_requested",
  /** New mail row inserted (daemon-internal OR dashboard mutator). */
  newMail: "friday_new_mail",
  /** Agent status='archive_requested' — daemon archives + closes tickets. */
  archiveRequested: "friday_archive_requested",
  /** Schedule status changes (pending_register, reload_requested,
   *  deleted). Daemon registers/re-registers cron entries +
   *  optional registry-stub cleanup. */
  scheduleChanged: "friday_schedule_changed",
  /** Apps status changes (pending_install, uninstall_requested, reload_requested). */
  appChanged: "friday_app_changed",
  /** Memory entry status='pending_file' or 'pending_delete'. Daemon
   *  writes or moves the markdown file under
   *  `~/.friday/memory/entries/`, then flips the row to 'ready' or
   *  'deleted' respectively. */
  memoryFileChanged: "friday_memory_file_changed",
  /** Settings table UPDATE — daemon re-syncs `~/.friday/config.json`. */
  settingsChanged: "friday_settings_changed",
  /** Blocks row UPDATEd to status='cancel_requested' — the dashboard
   *  cancelQueued mutator's signal that a queued user-chat prompt
   *  should be yanked from the worker's `nextPrompts` and the row
   *  deleted. Fast-path (`POST /api/internal/cancel-queued`) splices
   *  nextPrompts synchronously; LISTEN-path performs the canonical
   *  row delete. */
  blockCancelRequested: "friday_block_canceled",
  /** Blocks row UPDATEd to status='resume_requested' — the dashboard
   *  resumeTurn mutator's signal that an errored turn's original user
   *  prompt should be re-dispatched under the SAME turn_id (FRI-12
   *  visual-grouping contract). The daemon's resume-listener reads the
   *  block, validates, rebuilds the dispatch prompt, and dispatches. */
  resumeRequested: "friday_resume_requested",
} as const;

export type ListenChannel = (typeof LISTEN_CHANNELS)[keyof typeof LISTEN_CHANNELS];

/* ---------------- Re-exports for callsites ---------------- */
// uniqueIndex is intentionally imported above for future use; suppress
// unused-import noise during Phase 0 when the call site is empty.
export type _Reserved = typeof uniqueIndex;
