/**
 * Pin the boot-time self-heal for SDK sessions wedged on an
 * unresolved `tool_use`. The failure mode this exists to catch:
 * worker dies mid-tool-call, conversation stuck, every next turn
 * returns empty. See `dangling-tool-use-recovery.ts` for the design.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";
import { insertBlock } from "@friday/shared/services";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "dangling_tool_use" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

interface SeedTurn {
  agentName: string;
  sessionId: string;
  /** `tool_use` blocks that will be inserted. If `resolvedBy` is set,
   *  a matching `tool_result` row is also seeded so the tool_use is
   *  NOT dangling. */
  toolUses: Array<{ id: string; resolvedBy?: boolean }>;
}

async function seed(turn: SeedTurn): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db.insert(schema.agents).values({
    name: turn.agentName,
    type: "helper",
    status: "idle",
    sessionId: turn.sessionId,
    createdAt: now,
    updatedAt: now,
  });
  const turnId = `t_${randomUUID()}`;
  let ts = Date.now();
  for (const tu of turn.toolUses) {
    await insertBlock({
      blockId: randomUUID(),
      turnId,
      agentName: turn.agentName,
      sessionId: turn.sessionId,
      blockIndex: 0,
      role: "assistant",
      kind: "tool_use",
      contentJson: JSON.stringify({
        tool_use_id: tu.id,
        name: "Agent",
        input: {},
      }),
      status: "complete",
      ts: ts++,
      lastEventSeq: 0,
    });
    if (tu.resolvedBy) {
      await insertBlock({
        blockId: randomUUID(),
        turnId,
        agentName: turn.agentName,
        sessionId: turn.sessionId,
        blockIndex: 0,
        role: "user",
        kind: "tool_result",
        contentJson: JSON.stringify({
          tool_use_id: tu.id,
          content: "ok",
          is_error: false,
        }),
        status: "complete",
        ts: ts++,
        lastEventSeq: 0,
      });
    }
  }
}

async function countDanglingFor(agentName: string): Promise<number> {
  const db = getDb();
  const r = await db.execute<{ n: number }>(drizzleSql`
    SELECT COUNT(*)::int AS n FROM blocks b
    WHERE b.agent_name = ${agentName}
      AND b.kind = 'tool_use'
      AND NOT EXISTS (
        SELECT 1 FROM blocks r
        WHERE r.kind = 'tool_result'
          AND r.content_json->>'tool_use_id' = b.content_json->>'tool_use_id'
          AND r.agent_name = b.agent_name
      )
  `);
  const rows = Array.isArray(r) ? r : ((r as { rows: { n: number }[] }).rows ?? []);
  return rows[0]?.n ?? 0;
}

describe("recoverDanglingToolUses", () => {
  it("heals an agent wedged on one dangling tool_use: inserts a synthetic tool_result and clears the session", async () => {
    await seed({
      agentName: "wedged-helper",
      sessionId: "session-AAA",
      toolUses: [{ id: "toolu_dangling_1" }],
    });

    expect(await countDanglingFor("wedged-helper")).toBe(1);

    const { recoverDanglingToolUses } = await import("./dangling-tool-use-recovery.js");
    await recoverDanglingToolUses();

    // Post-condition #1: no more dangling tool_use for this agent.
    expect(await countDanglingFor("wedged-helper")).toBe(0);

    // Post-condition #2: the synthetic tool_result is in place,
    // carries `source='recovery_heal'`, and references the original
    // tool_use_id.
    const db = getDb();
    const heals = await db
      .select()
      .from(schema.blocks)
      .where(
        and(
          eq(schema.blocks.agentName, "wedged-helper"),
          eq(schema.blocks.kind, "tool_result"),
          eq(schema.blocks.source, "recovery_heal"),
        ),
      );
    expect(heals.length).toBe(1);
    const healContent = heals[0]!.contentJson as { tool_use_id: string; is_error: boolean };
    expect(healContent.tool_use_id).toBe("toolu_dangling_1");
    expect(healContent.is_error).toBe(true);

    // Post-condition #3: the agent's session_id is cleared so the
    // next dispatched turn forks fresh.
    const agent = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.name, "wedged-helper"));
    expect(agent[0]!.sessionId).toBeNull();
  });

  it("heals multiple dangling tool_uses for one agent in a single pass", async () => {
    await seed({
      agentName: "multi-wedge",
      sessionId: "session-BBB",
      toolUses: [{ id: "toolu_one" }, { id: "toolu_two" }, { id: "toolu_three" }],
    });

    expect(await countDanglingFor("multi-wedge")).toBe(3);

    const { recoverDanglingToolUses } = await import("./dangling-tool-use-recovery.js");
    await recoverDanglingToolUses();

    expect(await countDanglingFor("multi-wedge")).toBe(0);

    // Three synthetic heals, one per dangling tool_use.
    const db = getDb();
    const heals = await db
      .select()
      .from(schema.blocks)
      .where(
        and(eq(schema.blocks.agentName, "multi-wedge"), eq(schema.blocks.source, "recovery_heal")),
      );
    expect(heals.length).toBe(3);
    const healIds = new Set(
      heals.map((h) => (h.contentJson as { tool_use_id: string }).tool_use_id),
    );
    expect(healIds).toEqual(new Set(["toolu_one", "toolu_two", "toolu_three"]));
  });

  it("does not heal agents whose tool_uses are all resolved", async () => {
    await seed({
      agentName: "healthy-helper",
      sessionId: "session-CCC",
      toolUses: [
        { id: "toolu_resolved_1", resolvedBy: true },
        { id: "toolu_resolved_2", resolvedBy: true },
      ],
    });

    expect(await countDanglingFor("healthy-helper")).toBe(0);

    const { recoverDanglingToolUses } = await import("./dangling-tool-use-recovery.js");
    await recoverDanglingToolUses();

    // No new synthetic blocks; original session preserved.
    const db = getDb();
    const heals = await db
      .select()
      .from(schema.blocks)
      .where(
        and(
          eq(schema.blocks.agentName, "healthy-helper"),
          eq(schema.blocks.source, "recovery_heal"),
        ),
      );
    expect(heals.length).toBe(0);
    const agent = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.name, "healthy-helper"));
    expect(agent[0]!.sessionId).toBe("session-CCC");
  });

  it("skips archived agents — dangling state is inert when no one will dispatch a turn", async () => {
    const db = getDb();
    const now = new Date();
    await db.insert(schema.agents).values({
      name: "old-archived",
      type: "helper",
      status: "archived",
      sessionId: "session-DDD",
      createdAt: now,
      updatedAt: now,
    });
    await insertBlock({
      blockId: randomUUID(),
      turnId: `t_${randomUUID()}`,
      agentName: "old-archived",
      sessionId: "session-DDD",
      blockIndex: 0,
      role: "assistant",
      kind: "tool_use",
      contentJson: JSON.stringify({
        tool_use_id: "toolu_archived_dangling",
        name: "Agent",
        input: {},
      }),
      status: "complete",
      ts: Date.now(),
      lastEventSeq: 0,
    });

    expect(await countDanglingFor("old-archived")).toBe(1);

    const { recoverDanglingToolUses } = await import("./dangling-tool-use-recovery.js");
    await recoverDanglingToolUses();

    // Dangling block left in place; no synthetic heal inserted.
    expect(await countDanglingFor("old-archived")).toBe(1);
    const heals = await db
      .select()
      .from(schema.blocks)
      .where(
        and(eq(schema.blocks.agentName, "old-archived"), eq(schema.blocks.source, "recovery_heal")),
      );
    expect(heals.length).toBe(0);
    // Session_id left intact too — we don't disturb the archived
    // agent's record.
    const agent = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.name, "old-archived"));
    expect(agent[0]!.sessionId).toBe("session-DDD");
  });

  it("is idempotent — running the heal twice doesn't double-insert tool_results", async () => {
    await seed({
      agentName: "double-heal",
      sessionId: "session-EEE",
      toolUses: [{ id: "toolu_only" }],
    });

    const { recoverDanglingToolUses } = await import("./dangling-tool-use-recovery.js");
    await recoverDanglingToolUses();
    // After first heal: 1 synthetic tool_result.
    const db = getDb();
    const after1 = await db
      .select()
      .from(schema.blocks)
      .where(
        and(eq(schema.blocks.agentName, "double-heal"), eq(schema.blocks.source, "recovery_heal")),
      );
    expect(after1.length).toBe(1);

    // Second heal: the tool_use now has a matching tool_result (our
    // synthetic one), so it's no longer dangling — the second pass
    // should be a no-op.
    await recoverDanglingToolUses();
    const after2 = await db
      .select()
      .from(schema.blocks)
      .where(
        and(eq(schema.blocks.agentName, "double-heal"), eq(schema.blocks.source, "recovery_heal")),
      );
    expect(after2.length).toBe(1);
  });
});
