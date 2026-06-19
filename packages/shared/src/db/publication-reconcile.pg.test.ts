// Integration test for reconcileSyncPublication against a per-file scratch
// `friday_test_*` database (createTestDb), NEVER the host `friday` DB.
//
// This is the unit that closes the upgrade gap: a `friday update` deploy runs
// migrations (which create a new replicated table) but historically nothing
// added that table to `friday_pub`, so clients reload-looped on
// SchemaVersionNotSupported. reconcileSyncPublication now runs on every daemon
// boot to align the publication. The test pins the three reconcile paths and,
// critically, the "new table added after the publication already exists"
// path — the exact shape of the FRI-169 habits incident.
//
// Skipped when Postgres is unreachable (mirrors the other *.pg.test.ts files).
// When skipped the assertions below have NOT run.

import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDb,
  findPgIsReady,
  newTestClient,
  reconcileSyncPublication,
  type TestDbHandle,
} from "../index.js";

function pgReachable(): boolean {
  return (
    spawnSync(findPgIsReady(), ["-h", "localhost", "-p", "5432"], { encoding: "utf8" }).status === 0
  );
}

const skip = !pgReachable();

const PUB = "friday_pub";

describe.skipIf(skip)("reconcileSyncPublication (scratch PG)", () => {
  let handle: TestDbHandle;
  let url: string;

  beforeAll(async () => {
    handle = await createTestDb({ label: "pub-reconcile" });
    url = handle.databaseUrl;
  });

  afterAll(async () => {
    await handle.drop();
  });

  beforeEach(async () => {
    // Start each test from a known-clean publication state. DROP IF EXISTS so
    // the create-path test and the reconcile-path tests don't bleed into each
    // other; the scratch tables themselves (created by the migration chain)
    // are left in place.
    const c = newTestClient({ connectionString: url });
    await c.connect();
    try {
      await c.query(`DROP PUBLICATION IF EXISTS ${PUB}`);
    } finally {
      await c.end();
    }
  });

  async function publishedTables(): Promise<Set<string>> {
    const c = newTestClient({ connectionString: url });
    await c.connect();
    try {
      const r = await c.query<{ tablename: string }>(
        `SELECT tablename FROM pg_publication_tables WHERE pubname = $1`,
        [PUB],
      );
      return new Set(r.rows.map((row) => row.tablename));
    } finally {
      await c.end();
    }
  }

  it("creates the publication from scratch with exactly the desired tables that exist", async () => {
    // `usage` exists in the schema but is deliberately NOT a sync table — pass
    // a desired list that names a non-existent table to prove the existence
    // filter (we never try to ADD a table that isn't there).
    const res = await reconcileSyncPublication(() => {}, {
      connectionString: url,
      tables: ["habits", "habit_checkins", "does_not_exist"],
    });

    expect(res.created).toBe(true);
    expect(res.dropped).toEqual([]);
    expect(new Set(res.added)).toEqual(new Set(["habits", "habit_checkins"]));
    expect(await publishedTables()).toEqual(new Set(["habits", "habit_checkins"]));
  });

  it("adds a newly-shipped table to an existing publication (the FRI-169 habits path)", async () => {
    // Publication already exists from a prior release that knew only `habits`.
    await reconcileSyncPublication(() => {}, { connectionString: url, tables: ["habits"] });
    expect(await publishedTables()).toEqual(new Set(["habits"]));

    // Next release adds `habit_checkins` to the desired set — the reconcile
    // must ALTER PUBLICATION ADD it without dropping `habits` or recreating.
    const res = await reconcileSyncPublication(() => {}, {
      connectionString: url,
      tables: ["habits", "habit_checkins"],
    });

    expect(res.created).toBe(false);
    expect(res.added).toEqual(["habit_checkins"]);
    expect(res.dropped).toEqual([]);
    expect(await publishedTables()).toEqual(new Set(["habits", "habit_checkins"]));
  });

  it("drops a table no longer in the desired set", async () => {
    await reconcileSyncPublication(() => {}, {
      connectionString: url,
      tables: ["habits", "habit_checkins"],
    });

    const res = await reconcileSyncPublication(() => {}, {
      connectionString: url,
      tables: ["habits"],
    });

    expect(res.created).toBe(false);
    expect(res.added).toEqual([]);
    expect(res.dropped).toEqual(["habit_checkins"]);
    expect(await publishedTables()).toEqual(new Set(["habits"]));
  });

  it("is idempotent — a second run on an aligned publication is a no-op", async () => {
    await reconcileSyncPublication(() => {}, {
      connectionString: url,
      tables: ["habits", "habit_checkins"],
    });

    const res = await reconcileSyncPublication(() => {}, {
      connectionString: url,
      tables: ["habits", "habit_checkins"],
    });

    expect(res).toEqual({ created: false, added: [], dropped: [], noTables: false });
    expect(await publishedTables()).toEqual(new Set(["habits", "habit_checkins"]));
  });

  it("reports noTables when not one desired table exists (e.g. before migrations)", async () => {
    const res = await reconcileSyncPublication(() => {}, {
      connectionString: url,
      tables: ["table_that_is_not_in_the_schema"],
    });

    expect(res.noTables).toBe(true);
    expect(res.created).toBe(false);
    expect(res.added).toEqual([]);
    // No publication should have been created for a desired set with no
    // existing tables.
    expect(await publishedTables()).toEqual(new Set());
  });
});
