export * from "./config.js";
export * from "./daemon-secret.js";
export * from "./env.js";
export * from "./secrets/index.js";
export * from "./log.js";
export * from "./agents.js";
export * from "./usage.js";
export * from "./transcript.js";
export * from "./atomic-write.js";
export * from "./cron.js";
export * from "./skills.js";
export * from "./claude-sessions.js";
export * from "./hooks/index.js";
export * from "./prompts/loader.js";
export * from "./apps/manifest.js";
export * from "./db/client.js";
export * from "./db/migrate.js";
export * as schema from "./db/schema.js";
// Phase 4.3: NOTIFY channel names are referenced from both client
// and daemon — re-export the constant + type so daemon-side LISTEN
// handlers don't have to drill through the schema namespace.
export { LISTEN_CHANNELS, type ListenChannel } from "./db/schema.js";
// FRI-24: pgvector column dimensionality. Surfaced as a top-level named
// export so @friday/memory's embedder can size its output vector against the
// same single source of truth the schema's `vector(N)` column uses.
export { EMBEDDING_DIM } from "./db/schema.js";
export {
  provisionPostgres,
  reconcileSyncPublication,
  probePostgresHealth,
  dropFridayDatabaseForTest,
  ensureVectorExtension,
  hasVectorExtension,
  findPgBin,
  findPgIsReady,
  FRIDAY_PG_CONSTANTS,
  type PgHealth,
  type ProvisionResult,
  type PublicationReconcileResult,
} from "./db/pg-provision.js";
export { createTestDb, newTestClient, withTestDb, type TestDbHandle } from "./db/test-pg.js";
// Item #50 scaffold. Subprocess-spawning extensions are TODO; the
// current export gives every e2e test a per-test scratch Postgres
// with migrations applied + a single shared cleanup hook.
export { spawnTestSyncEnv, type SyncEnv } from "./test/sync-harness.js";

export type {
  WireEvent,
  TurnStartedEvent,
  TurnErrorEvent,
  TurnDoneEvent,
  AgentMessageEvent,
  TurnUsage,
  BlockKind,
  BlockStartEvent,
  BlockDeltaEvent,
  BlockCompleteEvent,
  ConnectionEstablishedEvent,
  AppLifecycleEvent,
} from "./wire/events.js";

export { stringifyToolResult } from "./wire/tool-result.js";
