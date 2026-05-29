/**
 * Pin the boot-time self-heal for SDK sessions wedged on an
 * unresolved `tool_use`. Two failure modes are covered:
 *
 *  1. Worker dies mid-tool-call in the *current* session → the heal
 *     must insert a synthetic tool_result in Postgres AND append a
 *     matching line to the SDK JSONL transcript so the SDK can resume
 *     the same session on the next turn. The agent's `session_id`
 *     must be preserved (continuity is non-negotiable).
 *
 *  2. A tool_use from a prior, already-cleared session lingers in
 *     Postgres → the heal must IGNORE it. The pre-FRI-89 query found
 *     these stale rows and cleared the agent's current healthy
 *     session, fragmenting the orchestrator chat on every brew
 *     restart that happened to surface a historical stray.
 *
 * See `dangling-tool-use-recovery.ts` for the design.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { createTestDb, getDb, parseEntries, schema, type TestDbHandle } from "@friday/shared";
import { insertBlock } from "@friday/shared/services";
import { getAgent, workingDirectoryFor } from "./registry.js";
import { sessionFilePath } from "./jsonl-paths.js";

let handle: TestDbHandle;
let fakeHome: string | null = null;

beforeAll(async () => {
  handle = await createTestDb({ label: "dangling_tool_use" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  // Each test gets a fresh fake $HOME so SDK JSONL writes from the
  // heal land in a scratch dir instead of touching the operator's real
  // ~/.claude. The setup file forces FRIDAY_DATA_DIR to a tmpdir, so
  // workingDirectoryFor() also writes inside a scratch tree.
  fakeHome = mkdtempSync(join(tmpdir(), "friday-jsonl-heal-"));
  vi.stubEnv("HOME", fakeHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (fakeHome) {
    try {
      rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    fakeHome = null;
  }
});

interface SeedTurn {
  agentName: string;
  sessionId: string | null;
  /** `tool_use` blocks that will be inserted. If `resolvedBy` is set,
   *  a matching `tool_result` row is also seeded so the tool_use is
   *  NOT dangling. `inSession` overrides the block-level session_id —
   *  used to seed stale tool_uses from a prior cleared session while
   *  the agent's current session_id is different. */
  toolUses: Array<{ id: string; resolvedBy?: boolean; inSession?: string }>;
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
    const sessionForBlock = tu.inSession ?? turn.sessionId ?? "session-unknown";
    await insertBlock({
      blockId: randomUUID(),
      turnId,
      agentName: turn.agentName,
      sessionId: sessionForBlock,
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
    });
    if (tu.resolvedBy) {
      await insertBlock({
        blockId: randomUUID(),
        turnId,
        agentName: turn.agentName,
        sessionId: sessionForBlock,
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

/** Build a stub SDK JSONL transcript ending on an unresolved tool_use
 *  for the given agent and session. The path is resolved through the
 *  same `workingDirectoryFor` + `sessionFilePath` chain the heal uses,
 *  so the heal will find and append to this file rather than writing
 *  to a divergent location. Returns the path so the test can re-read. */
async function stubDanglingTranscript(opts: {
  agentName: string;
  sessionId: string;
  /** Each entry produces one assistant/tool_use line. The last entry's
   *  uuid is returned so the test can verify the synthetic tool_result's
   *  parentUuid chains correctly. */
  toolUses: string[];
}): Promise<{ path: string; lastToolUseUuid: string; cwd: string }> {
  const agent = await getAgent(opts.agentName);
  if (!agent) throw new Error(`stubDanglingTranscript: no agent ${opts.agentName} seeded`);
  const cwd = await workingDirectoryFor(agent);
  const path = sessionFilePath(cwd, opts.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const lines: string[] = [];
  let parentUuid: string | null = null;
  let lastUuid = "";
  for (const id of opts.toolUses) {
    const uuid = randomUUID();
    lines.push(
      JSON.stringify({
        parentUuid,
        isSidechain: false,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id, name: "Agent", input: {} }],
        },
        uuid,
        timestamp: new Date().toISOString(),
        sessionId: opts.sessionId,
        cwd,
        userType: "external",
        entrypoint: "sdk-ts",
        version: "test",
        gitBranch: "HEAD",
      }),
    );
    parentUuid = uuid;
    lastUuid = uuid;
  }
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return { path, lastToolUseUuid: lastUuid, cwd };
}

function readToolResultIdsFromJsonl(path: string): Set<string> {
  const ids = new Set<string>();
  for (const entry of parseEntries(readFileSync(path, "utf8"))) {
    const content = entry.message?.content as unknown[] | undefined;
    const first = content?.[0] as { type?: string; tool_use_id?: string } | undefined;
    if (first?.type === "tool_result" && first.tool_use_id) {
      ids.add(first.tool_use_id);
    }
  }
  return ids;
}

describe("recoverDanglingToolUses", () => {
  it("heals a current-session dangling: writes synthetic tool_result to PG AND appends to SDK JSONL, preserving session_id", async () => {
    await seed({
      agentName: "wedged-helper",
      sessionId: "session-AAA",
      toolUses: [{ id: "toolu_dangling_1" }],
    });
    const { path, lastToolUseUuid } = await stubDanglingTranscript({
      agentName: "wedged-helper",
      sessionId: "session-AAA",
      toolUses: ["toolu_dangling_1"],
    });

    expect(await countDanglingFor("wedged-helper")).toBe(1);

    const { recoverDanglingToolUses } = await import("./dangling-tool-use-recovery.js");
    await recoverDanglingToolUses();

    // PG: no more dangling, synthetic tool_result is in place.
    expect(await countDanglingFor("wedged-helper")).toBe(0);
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

    // Session continuity: the agent's session_id MUST be preserved.
    // Pre-FRI-89 this was nulled; the regression is what fragmented
    // the orchestrator chat on brew restarts.
    const agent = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.name, "wedged-helper"));
    expect(agent[0]!.sessionId).toBe("session-AAA");

    // JSONL: a user/tool_result line for the same tool_use_id is
    // appended at EOF, parentUuid'd to the dangling tool_use entry.
    const entries = [...parseEntries(readFileSync(path, "utf8"))];
    const tail = entries.at(-1)!;
    expect(tail.type).toBe("user");
    const tailContent = (tail.message?.content as unknown[])?.[0] as {
      type: string;
      tool_use_id: string;
      is_error: boolean;
    };
    expect(tailContent.type).toBe("tool_result");
    expect(tailContent.tool_use_id).toBe("toolu_dangling_1");
    expect(tailContent.is_error).toBe(true);
    expect(tail.parentUuid).toBe(lastToolUseUuid);
  });

  it("ignores a stale tool_use from a prior cleared session — regression pin for the FRI-89 fragmentation bug", async () => {
    // Setup: agent has CURRENT session "session-NEW". A stale tool_use
    // sits in Postgres tagged to OLD session "session-OLD" that the
    // user `/clear`'d earlier. The old tool_use is inert (its SDK
    // transcript was discarded on /clear) — the heal must leave it
    // alone and not disturb the agent's current session.
    await seed({
      agentName: "current-clean",
      sessionId: "session-NEW",
      toolUses: [{ id: "toolu_old_dangling", inSession: "session-OLD" }],
    });

    // The unscoped query would find the orphan; the scoped query must not.
    expect(await countDanglingFor("current-clean")).toBe(1);

    const { recoverDanglingToolUses } = await import("./dangling-tool-use-recovery.js");
    await recoverDanglingToolUses();

    // No synthetic heal inserted: the stale row is left as-is, the
    // agent's session is untouched.
    const db = getDb();
    const heals = await db
      .select()
      .from(schema.blocks)
      .where(
        and(
          eq(schema.blocks.agentName, "current-clean"),
          eq(schema.blocks.source, "recovery_heal"),
        ),
      );
    expect(heals.length).toBe(0);
    const agent = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.name, "current-clean"));
    expect(agent[0]!.sessionId).toBe("session-NEW");
  });

  it("ignores dangling tool_uses when the agent has no current session (session_id=null)", async () => {
    // An agent that's been `/clear`'d has session_id=null. Any tool_use
    // rows in Postgres are inert. The heal must not resurrect them.
    await seed({
      agentName: "post-clear",
      sessionId: null,
      toolUses: [{ id: "toolu_post_clear", inSession: "session-GHOST" }],
    });

    const { recoverDanglingToolUses } = await import("./dangling-tool-use-recovery.js");
    await recoverDanglingToolUses();

    const db = getDb();
    const heals = await db
      .select()
      .from(schema.blocks)
      .where(
        and(eq(schema.blocks.agentName, "post-clear"), eq(schema.blocks.source, "recovery_heal")),
      );
    expect(heals.length).toBe(0);
    const agent = await db.select().from(schema.agents).where(eq(schema.agents.name, "post-clear"));
    expect(agent[0]!.sessionId).toBeNull();
  });

  it("heals multiple dangling tool_uses in the current session in a single pass", async () => {
    await seed({
      agentName: "wedged-helper",
      sessionId: "session-BBB",
      toolUses: [{ id: "toolu_one" }, { id: "toolu_two" }, { id: "toolu_three" }],
    });
    const { path } = await stubDanglingTranscript({
      agentName: "wedged-helper",
      sessionId: "session-BBB",
      toolUses: ["toolu_one", "toolu_two", "toolu_three"],
    });

    const { recoverDanglingToolUses } = await import("./dangling-tool-use-recovery.js");
    await recoverDanglingToolUses();

    expect(await countDanglingFor("wedged-helper")).toBe(0);

    const db = getDb();
    const heals = await db
      .select()
      .from(schema.blocks)
      .where(
        and(
          eq(schema.blocks.agentName, "wedged-helper"),
          eq(schema.blocks.source, "recovery_heal"),
        ),
      );
    expect(heals.length).toBe(3);
    const healIds = new Set(
      heals.map((h) => (h.contentJson as { tool_use_id: string }).tool_use_id),
    );
    expect(healIds).toEqual(new Set(["toolu_one", "toolu_two", "toolu_three"]));

    // JSONL: three appended tool_result lines, one per tool_use_id.
    expect(readToolResultIdsFromJsonl(path)).toEqual(
      new Set(["toolu_one", "toolu_two", "toolu_three"]),
    );

    // Session preserved.
    const agent = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.name, "wedged-helper"));
    expect(agent[0]!.sessionId).toBe("session-BBB");
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

  it("is idempotent — running the heal twice doesn't double-insert tool_results in PG or JSONL", async () => {
    await seed({
      agentName: "wedged-helper",
      sessionId: "session-EEE",
      toolUses: [{ id: "toolu_only" }],
    });
    const { path } = await stubDanglingTranscript({
      agentName: "wedged-helper",
      sessionId: "session-EEE",
      toolUses: ["toolu_only"],
    });

    const { recoverDanglingToolUses } = await import("./dangling-tool-use-recovery.js");
    await recoverDanglingToolUses();

    const db = getDb();
    const after1 = await db
      .select()
      .from(schema.blocks)
      .where(
        and(
          eq(schema.blocks.agentName, "wedged-helper"),
          eq(schema.blocks.source, "recovery_heal"),
        ),
      );
    expect(after1.length).toBe(1);
    expect(readToolResultIdsFromJsonl(path).size).toBe(1);

    // Second pass: the synthetic tool_result we inserted in pass 1
    // now matches the orphan, so the SQL returns 0 rows. Nothing new
    // should be written.
    await recoverDanglingToolUses();
    const after2 = await db
      .select()
      .from(schema.blocks)
      .where(
        and(
          eq(schema.blocks.agentName, "wedged-helper"),
          eq(schema.blocks.source, "recovery_heal"),
        ),
      );
    expect(after2.length).toBe(1);
    expect(readToolResultIdsFromJsonl(path).size).toBe(1);
  });

  it("no-ops gracefully on the JSONL side when the transcript file is missing", async () => {
    // No transcript stub — the heal looks at the resolved JSONL path
    // and finds nothing. The PG side still heals (the synthetic
    // tool_result is independent), but the JSONL append must not
    // throw and the session must remain preserved.
    await seed({
      agentName: "wedged-helper",
      sessionId: "session-FFF",
      toolUses: [{ id: "toolu_no_jsonl" }],
    });

    const { recoverDanglingToolUses } = await import("./dangling-tool-use-recovery.js");
    await expect(recoverDanglingToolUses()).resolves.toBeUndefined();

    const db = getDb();
    const heals = await db
      .select()
      .from(schema.blocks)
      .where(
        and(
          eq(schema.blocks.agentName, "wedged-helper"),
          eq(schema.blocks.source, "recovery_heal"),
        ),
      );
    expect(heals.length).toBe(1);
    // Session still preserved.
    const agent = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.name, "wedged-helper"));
    expect(agent[0]!.sessionId).toBe("session-FFF");
  });
});
