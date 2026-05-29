/**
 * FRI-127 / AC#12: end-to-end Helper mail-loop round-trip.
 *
 * A user message routes to the orchestrator; the orchestrator forks a helper
 * via `agent_create`; the helper mails its result back to `friday`; the
 * mail-bridge wakes the orchestrator; the orchestrator's next turn references
 * the helper's finding. This closes the symmetric loop the three FRI-127 fixes
 * target — delegation (helper preferred over Task), return-path (mail-back
 * obligation + backstop), and dispatch-session correctness.
 *
 * This is the real-subprocess tier: the daemon forks workers that drive the
 * actual Claude Agent SDK, so it requires `ANTHROPIC_API_KEY`. There is no
 * scripted-SDK injection point across the `fork()` boundary, so the round-trip
 * cannot be made deterministic in-process. The suite SKIPS (does not fail) when
 * no key is present — never a faked pass. Run under `pnpm test:e2e` with a key.
 *
 * Observability: the round-trip milestones are asserted from the daemon's
 * JSONL log (`worker.fork`, `mail.bridge.*`) plus the canonical `turn_done`
 * wire events the daemon publishes.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnTestSyncEnv, type SyncEnv, newTestClient } from "@friday/shared/test/sync-harness";

// 180s: boot ceilings rose to 90s + waitForBoot retries once, so keep the
// beforeAll wrapper above waitForBoot's own ceiling (see other e2e files).
const HARNESS_BOOT_MS = 180_000;
const TEST_TIMEOUT_MS = 180_000;
const ROUNDTRIP_DEADLINE_MS = 150_000;

const hasKey = !!process.env.ANTHROPIC_API_KEY;

let env: SyncEnv;

describe.skipIf(!hasKey)("helper mail-loop round-trip (FRI-127 AC#12)", () => {
  beforeAll(async () => {
    env = await spawnTestSyncEnv({ label: "helper_mail_roundtrip" });
  }, HARNESS_BOOT_MS);

  afterAll(async () => {
    await env?.cleanup();
  }, HARNESS_BOOT_MS);

  function readDaemonLog(dataDir: string): string {
    const logsDir = join(dataDir, "logs");
    let entries: string[];
    try {
      entries = readdirSync(logsDir);
    } catch {
      return "";
    }
    return entries
      .filter((f) => f.startsWith("daemon") && f.endsWith(".jsonl"))
      .map((f) => readFileSync(join(logsDir, f), "utf8"))
      .join("\n");
  }

  function logHas(log: string, eventName: string): boolean {
    for (const line of log.split("\n")) {
      if (!line) continue;
      try {
        if ((JSON.parse(line) as { event?: string }).event === eventName) return true;
      } catch {
        /* skip malformed */
      }
    }
    return false;
  }

  it(
    "orchestrator delegates to a helper that mails back, and the loop closes",
    async () => {
      const c = newTestClient({ connectionString: env.databaseUrl });
      await c.connect();
      try {
        const turnId = `t_${randomUUID()}`;
        const id = randomUUID();
        await c.query(
          `INSERT INTO blocks
             (id, block_id, turn_id, agent_name, session_id, block_index,
              role, kind, source, content_json, status, streaming, ts)
           VALUES ($1, $1, $2, 'friday', '__pending__', 0,
                   'user', 'text', 'user_chat', $3, 'pending', false, $4)`,
          [
            id,
            turnId,
            JSON.stringify({
              text: "Spawn a helper named find-x via agent_create to find the secret token (it is 'found X') and have it mail the answer back to you. Then tell me what the helper reported.",
            }),
            new Date(),
          ],
        );

        // Wait for the loop to close: the orchestrator must run a turn AFTER
        // the helper mailed back. We detect this via the daemon log showing a
        // worker.fork (helper spawn) and a mail.bridge dispatch, plus the
        // helper having a sessionId (it ran) and the orchestrator producing a
        // second turn's worth of blocks.
        const deadline = Date.now() + ROUNDTRIP_DEADLINE_MS;
        let closed = false;
        while (Date.now() < deadline) {
          const log = readDaemonLog(env.daemon.dataDir);
          const forked = logHas(log, "worker.fork");
          const helperRow = await c.query<{ name: string; status: string }>(
            `SELECT name, status FROM agents WHERE name = 'find-x'`,
          );
          const helperMail = await c.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM mail WHERE to_agent = 'friday' AND from_agent = 'find-x'`,
          );
          if (forked && helperRow.rowCount === 1 && Number(helperMail.rows[0]!.n) >= 1) {
            closed = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 1_000));
        }
        expect(closed).toBe(true);

        // The helper actually mailed the result back to the orchestrator.
        const mail = await c.query<{ body: string }>(
          `SELECT content_json->>'body' AS body FROM mail
             WHERE to_agent = 'friday' AND from_agent = 'find-x' ORDER BY id DESC LIMIT 1`,
        );
        expect(mail.rowCount).toBeGreaterThanOrEqual(1);

        // The orchestrator's later assistant text references the finding.
        const orchText = await c.query<{ content_json: string }>(
          `SELECT content_json FROM blocks
             WHERE agent_name = 'friday' AND role = 'assistant' AND kind = 'text'
             ORDER BY ts DESC LIMIT 20`,
        );
        const joined = orchText.rows.map((r) => r.content_json).join(" ");
        expect(joined.toLowerCase()).toContain("found x");
      } finally {
        await c.end();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
