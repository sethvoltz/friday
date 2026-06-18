/**
 * One-time embedding backfill (FRI-24). Walks every `status='ready'` memory
 * entry that has no embedding yet, embeds its `title\ncontent`, and writes the
 * vector via the same raw `::vector` UPDATE path that {@link saveEntry} uses.
 *
 * FAIL-OPEN per entry: an entry whose embed returns null (model/runtime
 * unavailable, timeout, transformers error) is counted as `skipped` and left
 * NULL — a later run (or a future save) can fill it. The whole-run idempotency
 * ("run exactly once after the model is installed") is enforced by the daemon's
 * state-migration wrapper, NOT here; this function is safe to call repeatedly
 * and will simply re-attempt whatever is still NULL.
 *
 * Backfill embeds use the generous warm/long timeout: the first embed after a
 * cold child spawn pays the model-load cost, and backfill text can be long.
 */

import { EMBEDDING_DIM, getDb, getPool } from "@friday/shared";
import { sql } from "drizzle-orm";
import { EMBED_WARM_TIMEOUT_MS, embedText } from "./embed.js";

const DEFAULT_BATCH_SIZE = 32;

export interface BackfillResult {
  /** Entries that got a non-NULL embedding written this run. */
  embedded: number;
  /** Entries skipped this run (embed returned null / failed). */
  skipped: number;
}

export async function backfillEmbeddings(opts?: {
  log?: (m: string) => void;
  batchSize?: number;
}): Promise<BackfillResult> {
  const log = opts?.log ?? (() => {});
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
  const db = getDb();
  const pool = getPool();

  const rows = await pool.query<{ id: string; title: string; content: string }>(
    `SELECT id, title, content
       FROM memory_entries
      WHERE embedding IS NULL AND status = 'ready'`,
  );
  const targets = rows.rows;
  log(`backfill: ${targets.length} entr${targets.length === 1 ? "y" : "ies"} need embeddings`);

  let embedded = 0;
  let skipped = 0;

  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize);
    for (const row of batch) {
      const vec = await embedText(`${row.title}\n${row.content}`, {
        timeoutMs: EMBED_WARM_TIMEOUT_MS,
      });
      if (vec && vec.length === EMBEDDING_DIM) {
        const literal = `[${vec.join(",")}]`;
        await db.execute(
          sql`UPDATE memory_entries SET embedding = ${literal}::vector WHERE id = ${row.id}`,
        );
        embedded += 1;
      } else {
        // FAIL-OPEN: leave NULL, count as skipped. A later run fills it.
        skipped += 1;
      }
    }
    log(`backfill: progress ${Math.min(i + batchSize, targets.length)}/${targets.length}`);
  }

  log(`backfill: done — embedded=${embedded} skipped=${skipped}`);
  return { embedded, skipped };
}
