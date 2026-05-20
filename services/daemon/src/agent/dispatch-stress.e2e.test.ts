/**
 * Dispatch stress / exactly-once contract (item #50, plan §4 step 4b).
 *
 * Fires 100 concurrent `sendUserMessage`-shaped INSERTs across 5
 * simulated clients, then waits for the daemon's NOTIFY+LISTEN loop
 * to drain. Verifies:
 *
 *   1. All 100 rows converge off `status='pending'` (no NOTIFY lost,
 *      no row stuck forever).
 *   2. Exactly 100 `block.dispatch.applied` log lines fire in the
 *      daemon's per-test JSONL — one per row, never more, never
 *      fewer (no duplicate dispatch, no missed row).
 *   3. No `block.dispatch.skip.shape-mismatch` or
 *      `block.dispatch-listen.process.error` lines surface in the
 *      log (the handler ran clean).
 *
 * This is the high-burst contract test that protects against bugs in
 * the LISTEN handler's race semantics: if the trigger fan-out OR the
 * Node `pg` LISTEN client OR the `processPendingBlockRow` idempotency
 * gate regress, exactly-one-of-{100,exactly} breaks here in a way no
 * unit test covers.
 *
 * The boot-recovery scan runs once at daemon start (against an empty
 * `blocks` table here), so every observed dispatch is from the LIVE
 * LISTEN handler — not a re-scan.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import {
  spawnTestSyncEnv,
  type SyncEnv,
} from "@friday/shared/test/sync-harness";

const HARNESS_BOOT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;
const ROW_COUNT = 100;
const CLIENT_COUNT = 5;
const PER_CLIENT_ROWS = ROW_COUNT / CLIENT_COUNT;
const CONVERGE_DEADLINE_MS = 20_000;

let env: SyncEnv;

beforeAll(async () => {
  env = await spawnTestSyncEnv({ label: "dispatch_stress" });
}, HARNESS_BOOT_MS);

afterAll(async () => {
  await env?.cleanup();
}, HARNESS_BOOT_MS);

interface PendingSpec {
  id: string;
  turnId: string;
  agentName: string;
  text: string;
}

function makeSpec(client: number, n: number): PendingSpec {
  const id = randomUUID();
  return {
    id,
    turnId: `t_${randomUUID()}`,
    // Spread across two agents so the test also covers the registry's
    // implicit-registration code path on a row that targets an agent
    // it hasn't seen yet. Both agents go through the same dispatch.
    agentName: client % 2 === 0 ? "friday" : "scratch",
    text: `stress c${client} n${n}`,
  };
}

/**
 * Single client: opens one Postgres connection and INSERTs `count`
 * pending rows back-to-back. Five of these run concurrently from the
 * test to mimic five browser tabs firing mutations at once.
 */
async function runSimClient(
  databaseUrl: string,
  client: number,
  count: number,
  specs: PendingSpec[],
): Promise<void> {
  const c = new Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    for (let i = 0; i < count; i++) {
      const s = makeSpec(client, i);
      specs.push(s);
      await c.query(
        `INSERT INTO blocks
           (id, block_id, turn_id, agent_name, session_id, block_index,
            role, kind, source, content_json, status, streaming, ts,
            last_event_seq)
         VALUES ($1, $1, $2, $3, '__pending__', 0,
                 'user', 'text', 'user_chat', $4, 'pending', false,
                 $5, 0)`,
        [s.id, s.turnId, s.agentName, JSON.stringify({ text: s.text }), new Date()],
      );
    }
  } finally {
    await c.end();
  }
}

async function countPending(databaseUrl: string): Promise<number> {
  const c = new Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    const r = await c.query<{ count: string }>(
      `SELECT count(*)::text FROM blocks WHERE status = 'pending'`,
    );
    return Number(r.rows[0]!.count);
  } finally {
    await c.end();
  }
}

async function readDaemonLog(dataDir: string): Promise<string> {
  const logsDir = join(dataDir, "logs");
  let entries: string[];
  try {
    entries = readdirSync(logsDir);
  } catch {
    return "";
  }
  // The daemon writes to a single JSONL file (daemon.jsonl); pick it
  // up, but tolerate rotation in case a future change adds it.
  const buf = entries
    .filter((f) => f.startsWith("daemon") && f.endsWith(".jsonl"))
    .map((f) => readFileSync(join(logsDir, f), "utf8"))
    .join("\n");
  return buf;
}

function countLogEvents(log: string, eventName: string): number {
  let n = 0;
  for (const line of log.split("\n")) {
    if (!line) continue;
    try {
      const j = JSON.parse(line) as { event?: string };
      if (j.event === eventName) n += 1;
    } catch {
      /* malformed line; skip */
    }
  }
  return n;
}

describe("dispatch stress / exactly-once (item #50 — plan §4 step 4b)", () => {
  it(
    `100 rapid INSERTs across ${CLIENT_COUNT} clients all converge off 'pending'`,
    async () => {
      const allSpecs: PendingSpec[] = [];
      // Fire all 5 client INSERT runs in parallel. Each opens its own
      // PG client so the writes truly race at the trigger / LISTEN
      // layer (vs. serializing through a shared connection).
      await Promise.all(
        Array.from({ length: CLIENT_COUNT }, (_, c) =>
          runSimClient(env.databaseUrl, c, PER_CLIENT_ROWS, allSpecs),
        ),
      );
      expect(allSpecs.length).toBe(ROW_COUNT);

      // Wait for the daemon's LISTEN handler to drain.
      const deadline = Date.now() + CONVERGE_DEADLINE_MS;
      let lastPending = ROW_COUNT;
      while (Date.now() < deadline) {
        lastPending = await countPending(env.databaseUrl);
        if (lastPending === 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(lastPending).toBe(0);

      // Exactly-once dispatch: count `block.dispatch.applied` log
      // events. Equal to ROW_COUNT means each row was processed once.
      const log = await readDaemonLog(env.daemon.dataDir);
      const applied = countLogEvents(log, "block.dispatch.applied");
      expect(applied).toBe(ROW_COUNT);

      // Negative-space assertions: no shape-mismatch (our INSERTs were
      // legal), no process errors (LISTEN handler ran clean).
      expect(countLogEvents(log, "block.dispatch.skip.shape-mismatch")).toBe(0);
      expect(countLogEvents(log, "block.dispatch-listen.process.error")).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
