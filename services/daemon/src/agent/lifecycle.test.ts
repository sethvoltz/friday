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
  it("recordUserBlock writes the row before publishing block_complete", async () => {
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

    const { blockId, seq } = recordUserBlock({
      turnId: "turn-adr-1",
      agentName: "alpha",
      text: "hello adr",
      source: "user_chat",
    });
    unsub();

    // The DB row exists and its last_event_seq matches the published seq.
    const row = getBlockById(blockId);
    expect(row).not.toBeNull();
    expect(row!.lastEventSeq).toBe(seq);

    // The SSE event was published and carries the same seq + block_id.
    const evt = captured.find(
      (e) => e.type === "block_complete" && e.block_id === blockId,
    );
    expect(evt).toBeDefined();
    expect(evt!.seq).toBe(seq);
  });

  it("seq returned by recordUserBlock matches eventBus' actual assignment", async () => {
    const { recordUserBlock } = await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    const before = eventBus.currentSeq();
    const { seq } = recordUserBlock({
      turnId: "turn-adr-2",
      agentName: "alpha",
      text: "seq lock",
      source: "user_chat",
    });
    const after = eventBus.currentSeq();

    // Exactly one event was published; seq advanced by 1; the returned seq
    // is the published seq.
    expect(after).toBe(before + 1);
    expect(seq).toBe(after);
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

  it("two back-to-back recordUserBlock calls produce strictly monotonic seqs and rows", async () => {
    const { recordUserBlock } = await import("./lifecycle.js");
    const { getBlockById } = await import("@friday/shared/services");

    const r1 = recordUserBlock({
      turnId: "t1",
      agentName: "alpha",
      text: "first",
      source: "user_chat",
    });
    const r2 = recordUserBlock({
      turnId: "t2",
      agentName: "alpha",
      text: "second",
      source: "user_chat",
    });

    expect(r2.seq).toBe(r1.seq + 1);
    expect(getBlockById(r1.blockId)!.lastEventSeq).toBe(r1.seq);
    expect(getBlockById(r2.blockId)!.lastEventSeq).toBe(r2.seq);
  });
});
