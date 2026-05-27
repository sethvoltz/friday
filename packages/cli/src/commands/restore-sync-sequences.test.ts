// Regression test for the bigserial sequence sync that runs at the
// end of a legacy_sqlite restore. The bug: inserting rows via raw
// `INSERT INTO mail (id, ...) VALUES (150, ...)` (which is what the
// legacy restore path does) leaves the `mail_id_seq` sequence at 1.
// The next normal-path INSERT (the daemon mail send) then picks
// `nextval = 2` and immediately collides with the restored row at id=2.
//
// In production this manifested as: scheduled agent fires → sends mail →
// duplicate-key error → unhandled rejection → daemon dies silently.
// The cure is `syncBigserialSequences` advancing every public-schema
// sequence to MAX(id) after the raw-INSERT loop.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";
import { getPool } from "@friday/shared/db";
import { syncBigserialSequences } from "./restore.js";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "restore_seqsync" });
});

afterAll(async () => {
  await handle.drop();
});

describe("syncBigserialSequences", () => {
  test("after raw INSERT with explicit id=150, sequence advances so next nextval > 150", async () => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      // Simulate the legacy restore path: insert a mail row with an
      // explicit id that the sequence hasn't reached yet. NOT NULL
      // columns: from_agent, to_agent, type, delivery, body, ts.
      await client.query(
        `INSERT INTO mail
             (id, from_agent, to_agent, type, delivery, body, ts)
           VALUES (150, 'a', 'b', 'message', 'pending', 'restored', NOW())`,
      );

      // Pre-condition: sequence is still untouched (last_value = 1,
      // is_called = false) — the raw INSERT bypassed it.
      const seqBefore = await client.query("SELECT last_value, is_called FROM mail_id_seq");
      expect(seqBefore.rows[0]).toMatchObject({
        last_value: "1",
        is_called: false,
      });

      // Run the function under test.
      await syncBigserialSequences(client);

      // Post-condition: the next nextval must yield a value strictly
      // greater than the restored row's id. Use nextval() instead of
      // peeking at last_value because that's what the production
      // INSERT path actually consumes.
      const nextval = await client.query<{ nextval: string }>(
        "SELECT nextval('mail_id_seq')::text AS nextval",
      );
      expect(Number(nextval.rows[0]!.nextval)).toBeGreaterThan(150);

      // Concrete: a fresh INSERT through the normal path (no explicit
      // id) lands at a non-colliding id — this is the bug the user
      // would actually hit. Pin the column shape.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO mail
             (from_agent, to_agent, type, delivery, body, ts)
           VALUES ('a', 'b', 'message', 'pending', 'fresh', NOW())
           RETURNING id::text`,
      );
      expect(Number(inserted.rows[0]!.id)).toBeGreaterThan(150);
    } finally {
      client.release();
    }
  }, 30_000);

  test("empty table: sequence stays at 1, next nextval returns 1", async () => {
    // Truncate from the prior test so we're starting empty.
    await handle.truncate();
    const pool = getPool();
    const client = await pool.connect();
    try {
      // Nothing in the table — sync should be a no-op (well, a setval
      // to 1 with is_called=false, which is the canonical "untouched"
      // sequence state).
      await syncBigserialSequences(client);

      const nextval = await client.query<{ nextval: string }>(
        "SELECT nextval('mail_id_seq')::text AS nextval",
      );
      expect(nextval.rows[0]!.nextval).toBe("1");
    } finally {
      client.release();
    }
  }, 30_000);
});
