/**
 * FRI-24: one-shot embedding backfill state-migration.
 *
 * Migration 0036 added the `memory_entries.embedding vector(384)` column NULL
 * for every pre-existing row. New saves embed inline; the historical rows need
 * a one-time pass. {@link backfillEmbeddings} walks every `status='ready'` entry
 * with a NULL embedding and fills it.
 *
 * This runs as a `_friday_state_migrations` row (the runner records
 * `embed-backfill-v1` on success and short-circuits on every later boot), so the
 * backfill executes AT MOST ONCE per install. Per-entry fail-open lives inside
 * `backfillEmbeddings` itself: an entry whose embed returns null (model/runtime
 * not yet provisioned) is counted as `skipped` and left NULL. Because the
 * state-migration sentinel is written regardless of skips, a fully-skipped run
 * (e.g. on a daemon that booted before `friday update` fetched the embedding
 * runtime) is NOT re-attempted by this migration — the inline save path and a
 * future `embed-backfill-v2` cover the remainder. That matches the runner's
 * documented "applied rows are immutable history; re-runs ship a new id" rule.
 */

import { backfillEmbeddings } from "@friday/memory";
import { logger } from "../log.js";
import type { StateMigration } from "./runner.js";

export const embedBackfillV1: StateMigration = {
  id: "embed-backfill-v1",
  async run() {
    const { embedded, skipped } = await backfillEmbeddings({
      log: (m) => logger.log("info", "embed-backfill.progress", { message: m }),
    });
    // The runner records the sentinel once run() resolves, so a fully-skipped
    // pass (embedding runtime/model not yet on disk — e.g. a daemon that booted
    // before `friday update` finished fetching the model) is NOT retried by
    // this one-shot. We must NOT throw to force a retry: the runner aborts boot
    // on a throw, which would turn a fail-open feature into a boot-blocker.
    // Instead surface the FTS-only-forever state so it's observable; those rows
    // re-embed on their next save, or via a future embed-backfill-v2.
    if (skipped > 0) {
      logger.log("warn", "embed-backfill.incomplete", {
        embedded,
        skipped,
        note: "entries left FTS-only (embedding model/runtime unavailable at backfill time); re-embedded on next save or a future embed-backfill-v2",
      });
    }
    return { embedded, skipped };
  },
};
