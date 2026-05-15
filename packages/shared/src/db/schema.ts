import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/* ---------------- BetterAuth tables ---------------- */
// Match BetterAuth's expected schema exactly: singular table names, camelCase
// columns. We declare them in our Drizzle schema for typed app access, but the
// authoritative shape is what BetterAuth's adapter writes/reads.

export const users = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "boolean" })
    .notNull()
    .default(false),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

export const sessions = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId").notNull(),
});

export const accounts = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId").notNull(),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: integer("accessTokenExpiresAt", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refreshTokenExpiresAt", {
    mode: "timestamp_ms",
  }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
});

export const verifications = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expiresAt", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }),
});

/* ---------------- Agents registry ---------------- */

export const agents = sqliteTable(
  "agents",
  {
    name: text("name").primaryKey(),
    type: text("type").notNull(), // orchestrator|builder|helper|scheduled|bare
    status: text("status").notNull(), // idle|working|stalled|error|archived
    sessionId: text("session_id"),
    parentName: text("parent_name"), // for builder/helper/bare
    worktreePath: text("worktree_path"), // for builder
    branch: text("branch"),
    ticketId: text("ticket_id"),
    metaJson: text("meta_json"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    typeIdx: index("agents_type").on(t.type),
    statusIdx: index("agents_status").on(t.status, t.updatedAt),
  }),
);

/* ---------------- Turns (legacy; superseded by blocks) ---------------- */
// The turns table is kept here until WS-1 items 1.2–1.10 migrate every caller
// onto the new blocks model. After the one-time user data migration runs
// (scripts/migrate-turns-to-blocks.ts), the physical table is dropped; this
// schema export becomes dead code at that point and a follow-up removal will
// land alongside the last caller cleanup.

export const turns = sqliteTable(
  "turns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sessionId: text("session_id").notNull(),
    agentName: text("agent_name"),
    turnIndex: integer("turn_index").notNull(),
    ts: integer("ts").notNull(),
    role: text("role").notNull(), // user|assistant|system|tool_use|tool_result
    kind: text("kind").notNull(), // text|tool_call|tool_result|stream
    contentJson: text("content_json").notNull(),
    sourceFile: text("source_file").notNull(),
    sourceByteOff: integer("source_byte_off").notNull(),
    /** Cursor for race-free SSE resume — the last seq applied to this row. */
    lastEventSeq: integer("last_event_seq").notNull().default(0),
  },
  (t) => ({
    sessionTurnUniq: uniqueIndex("turns_session_turn").on(
      t.sessionId,
      t.turnIndex,
    ),
    agentTsIdx: index("turns_agent_ts").on(t.agentName, t.ts),
  }),
);

/* ---------------- Blocks (per-content-block chat persistence) ---------------- */
// One row per content block (text / thinking / tool_use / tool_result, plus
// user-typed and mail-delivered user-role blocks). `block_id` is a
// daemon-minted UUID and the stable client-facing identity. `turn_id` groups
// blocks belonging to one user-prompt cycle. `last_event_seq` enforces the
// ADR-004 ordering invariant at block granularity (see FIX_FORWARD 1.10).

export const blocks = sqliteTable(
  "blocks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    blockId: text("block_id").notNull().unique(),
    turnId: text("turn_id").notNull(),
    agentName: text("agent_name").notNull(),
    sessionId: text("session_id").notNull(),
    messageId: text("message_id"),
    blockIndex: integer("block_index").notNull(),
    role: text("role").notNull(), // user|assistant|system
    kind: text("kind").notNull(), // text|thinking|tool_use|tool_result|error
    source: text("source"), // user_chat|mail|queue_inject|sdk (null for assistant)
    contentJson: text("content_json").notNull(),
    status: text("status").notNull(), // streaming|complete|aborted|error|queued (user blocks awaiting worker dispatch)
    ts: integer("ts").notNull(),
    lastEventSeq: integer("last_event_seq").notNull(),
  },
  (t) => ({
    agentTsIdx: index("blocks_agent_ts").on(t.agentName, t.ts),
    sessionMsgIdx: index("blocks_session_msg").on(
      t.sessionId,
      t.messageId,
      t.blockIndex,
    ),
    turnIdx: index("blocks_turn").on(t.turnId),
  }),
);

/* ---------------- Mail (inter-agent messaging) ---------------- */

export const mail = sqliteTable(
  "mail",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fromAgent: text("from_agent").notNull(),
    toAgent: text("to_agent").notNull(),
    type: text("type").notNull(), // message|notification|task
    delivery: text("delivery").notNull(), // pending|delivered|read|closed
    /** Optional short subject. Senders include it for inbox-scanning UX. */
    subject: text("subject"),
    /** Optional thread id; messages with the same id render grouped. */
    threadId: text("thread_id"),
    body: text("body").notNull(),
    metaJson: text("meta_json"),
    ts: integer("ts").notNull(),
    readAt: integer("read_at"),
    closedAt: integer("closed_at"),
    /** 'normal' drains at the next turn boundary; 'critical' drains at the
     *  next SDK iteration boundary inside the worker (FIX_FORWARD 2.3/2.4). */
    priority: text("priority").notNull().default("normal"),
  },
  (t) => ({
    inboxIdx: index("mail_inbox").on(t.toAgent, t.delivery, t.ts),
    threadIdx: index("mail_thread").on(t.threadId, t.ts),
  }),
);

/* ---------------- Tickets ---------------- */

export const tickets = sqliteTable(
  "tickets",
  {
    id: text("id").primaryKey(), // FRI-1234
    title: text("title").notNull(),
    body: text("body"),
    status: text("status").notNull(), // open|in_progress|done|blocked|closed
    kind: text("kind").notNull(), // task|epic|bug|chore
    assignee: text("assignee"),
    metaJson: text("meta_json"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    statusIdx: index("tickets_status").on(t.status, t.updatedAt),
    assigneeIdx: index("tickets_assignee").on(t.assignee),
  }),
);

export const ticketRelations = sqliteTable(
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

export const ticketComments = sqliteTable(
  "ticket_comments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ticketId: text("ticket_id").notNull(),
    author: text("author").notNull(),
    body: text("body").notNull(),
    ts: integer("ts").notNull(),
  },
  (t) => ({
    ticketIdx: index("ticket_comments_ticket").on(t.ticketId, t.ts),
  }),
);

export const ticketExternalLinks = sqliteTable(
  "ticket_external_links",
  {
    ticketId: text("ticket_id").notNull(),
    system: text("system").notNull(), // linear|github|...
    externalId: text("external_id").notNull(),
    url: text("url"),
    metaJson: text("meta_json"),
    linkedAt: integer("linked_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticketId, t.system, t.externalId] }),
    bySystemIdx: index("ticket_external_by_system").on(t.system, t.externalId),
  }),
);

/* ---------------- Attachments ---------------- */

export const attachments = sqliteTable("attachments", {
  sha256: text("sha256").primaryKey(),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedAt: integer("uploaded_at").notNull(),
  firstTurnId: integer("first_turn_id"),
});

/* ---------------- Schedules ---------------- */

export const schedules = sqliteTable(
  "schedules",
  {
    name: text("name").primaryKey(),
    cron: text("cron"),
    runAt: text("run_at"),
    taskPrompt: text("task_prompt").notNull(),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    nextRunAt: integer("next_run_at"),
    lastRunAt: integer("last_run_at"),
    lastRunId: text("last_run_id"),
    metaJson: text("meta_json"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    nextRunIdx: index("schedules_next_run").on(t.nextRunAt),
  }),
);

/* ---------------- Memory + Evolve indexes ---------------- */
// Memory entries themselves live as markdown files in ~/.friday/memory/entries/.
// We mirror them into this table for the FTS5 index + recall counters.

export const memoryEntries = sqliteTable("memory_entries", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  tagsJson: text("tags_json").notNull().default("[]"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  fileMtime: integer("file_mtime").notNull(),
  recallCount: integer("recall_count").notNull().default(0),
  lastRecalledAt: text("last_recalled_at"),
});

/* ---------------- Usage (Claude API call accounting) ---------------- */
// One row per turn / model invocation. Populated from `turn_done` events in
// the daemon and via a one-time backfill from any legacy ~/.friday/usage.jsonl
// the user carried over from old Friday.

export const usage = sqliteTable(
  "usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    timestamp: text("timestamp").notNull(), // ISO 8601
    sessionId: text("session_id").notNull(),
    agentName: text("agent_name"),
    agentType: text("agent_type"), // orchestrator|builder|helper|scheduled|bare
    model: text("model"),
    costUsd: real("cost_usd"),
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

/* ---------------- Generic key/value store ---------------- */

export const dbMeta = sqliteTable("db_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/* ---------------- FTS5 trigger SQL ---------------- */
// Drizzle doesn't natively model FTS5 virtual tables; we issue these as raw
// SQL after migrations in `migrate.ts`.

export const FTS_SETUP_SQL = sql`
  CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
    content_json, content='turns', content_rowid='id'
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
    content_json, content='blocks', content_rowid='id'
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    title, content, tags_json,
    content='memory_entries', content_rowid='rowid'
  );
`;
