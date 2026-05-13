import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// FIX_FORWARD 1.10: DB-before-SSE invariant. Every block-tied SSE event must
// be preceded by a `blocks` row write at the same `last_event_seq` it
// carries. We drive `recordUserBlock` end-to-end against a real DB and
// confirm the row matches the published event.

const dataDir = mkdtempSync(join(tmpdir(), "friday-lifecycle-"));
process.env.FRIDAY_DATA_DIR = dataDir;

beforeAll(async () => {
  const { runMigrations } = await import("@friday/shared");
  runMigrations();
});

afterAll(async () => {
  const { closeDb } = await import("@friday/shared");
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { getRawDb } = await import("@friday/shared");
  getRawDb().prepare("DELETE FROM blocks").run();
});

describe("ADR-004 ordering at block level (FIX_FORWARD 1.10)", () => {
  it("user_chat source persists the row but does NOT publish SSE", async () => {
    // The `user_chat` path collides with the dashboard's optimistic bubble
    // (the POST /api/chat/turn response would race the SSE frame). The
    // row still has to land in the blocks table — reload hydrates the
    // chat from /api/agents/:name/blocks — but no SSE event must fire.
    const { recordUserBlock } = await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");
    const { getBlockById } = await import("@friday/shared/services");

    const captured: Array<{
      type?: string;
      block_id?: string;
      seq?: number;
    }> = [];
    const unsub = eventBus.subscribe((e) =>
      captured.push(e as { type?: string; block_id?: string; seq?: number }),
    );

    const before = eventBus.currentSeq();
    const { blockId, seq } = recordUserBlock({
      turnId: "turn-adr-1",
      agentName: "alpha",
      text: "hello adr",
      source: "user_chat",
    });
    unsub();

    // Row landed.
    const row = getBlockById(blockId);
    expect(row).not.toBeNull();
    expect(row!.source).toBe("user_chat");
    expect(JSON.parse(row!.contentJson)).toEqual({ text: "hello adr" });
    // No SSE event was published.
    expect(captured.find((e) => e.block_id === blockId)).toBeUndefined();
    expect(eventBus.currentSeq()).toBe(before);
    // The returned seq is the sentinel 0 (no event → no seq).
    expect(seq).toBe(0);
  });

  it("mail source publishes SSE and the row's seq matches the event seq", async () => {
    // Non-user_chat paths have no upstream optimistic bubble, so the SSE
    // emit is the canonical materialization signal. The row's
    // last_event_seq must match the published event's seq (ADR-004).
    const { recordUserBlock } = await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");
    const { getBlockById } = await import("@friday/shared/services");

    const captured: Array<{
      type?: string;
      block_id?: string;
      seq?: number;
    }> = [];
    const unsub = eventBus.subscribe((e) =>
      captured.push(e as { type?: string; block_id?: string; seq?: number }),
    );

    const before = eventBus.currentSeq();
    const { blockId, seq } = recordUserBlock({
      turnId: "turn-adr-2",
      agentName: "alpha",
      text: "mail body",
      source: "mail",
      fromAgent: "beta",
    });
    unsub();

    // The bus advanced at least once (block_complete). `maybeEmitAgentMessage`
    // also fires for mail sources, so >1 is acceptable; the load-bearing
    // claim is that the block_complete carried the returned seq.
    expect(eventBus.currentSeq()).toBeGreaterThan(before);
    expect(seq).toBe(before + 1);

    const evt = captured.find(
      (e) => e.type === "block_complete" && e.block_id === blockId,
    );
    expect(evt).toBeDefined();
    expect(evt!.seq).toBe(seq);

    const row = getBlockById(blockId);
    expect(row!.lastEventSeq).toBe(seq);
  });

  it("mail-derived blocks include from_agent in content_json", async () => {
    const { recordUserBlock } = await import("./lifecycle.js");
    const { getBlockById } = await import("@friday/shared/services");

    const { blockId } = recordUserBlock({
      turnId: "turn-adr-3",
      agentName: "alpha",
      text: "ping",
      source: "mail",
      fromAgent: "beta",
    });
    const row = getBlockById(blockId);
    const parsed = JSON.parse(row!.contentJson) as {
      text: string;
      from_agent?: string;
    };
    expect(parsed.text).toBe("ping");
    expect(parsed.from_agent).toBe("beta");
    expect(row!.source).toBe("mail");
  });

  it("two back-to-back mail recordUserBlock calls produce strictly monotonic seqs", async () => {
    const { recordUserBlock } = await import("./lifecycle.js");
    const { getBlockById } = await import("@friday/shared/services");

    const r1 = recordUserBlock({
      turnId: "t1",
      agentName: "alpha",
      text: "first",
      source: "mail",
      fromAgent: "beta",
    });
    const r2 = recordUserBlock({
      turnId: "t2",
      agentName: "alpha",
      text: "second",
      source: "mail",
      fromAgent: "beta",
    });

    // Monotonic, but `maybeEmitAgentMessage` interleaves an agent_message
    // event between the two block_completes for mail-derived blocks, so the
    // gap isn't necessarily exactly 1.
    expect(r2.seq).toBeGreaterThan(r1.seq);
    expect(getBlockById(r1.blockId)!.lastEventSeq).toBe(r1.seq);
    expect(getBlockById(r2.blockId)!.lastEventSeq).toBe(r2.seq);
  });
});
