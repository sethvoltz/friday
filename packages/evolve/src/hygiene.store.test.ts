/**
 * FRI-26 — runHygiene against the REAL memory store on scratch Postgres (F7 /
 * AC8 layer). The fast hygiene.test.ts mocks `@friday/memory` with an in-memory
 * Map; THIS test exercises the genuine store: real `saveEntry` writes the `.md`
 * file + the canonical row, real Postgres FTS drives `searchMemories`, and real
 * `updateEntry` round-trips through disk. It is the load-bearing proof of two
 * things the mock can't fully establish:
 *
 *   1. F1 multi-loser fold preserves ALL absorbed content+tags — when ONE
 *      survivor absorbs TWO near-dups in a single pass the second fold no longer
 *      clobbers the first (cumulative accumulation against the live store).
 *
 *   2. AC8 preserve-over-delete on disk — the absorbed rows keep an `archived`
 *      tag, `getEntry` stays non-null, the `.md` files still exist, recall
 *      metadata on the survivor is preserved, and `forgetEntry` is NEVER called.
 *
 * Harness mirrors packages/memory/src/store.test.ts: createTestDb provisions a
 * scratch PG and points DATABASE_URL at it; FRIDAY_DATA_DIR is the vitest-setup
 * tmpdir (so `.md` files land in an isolated entries dir). The embedder is
 * forced fail-open (no onnxruntime fork) via an injected fake child transport
 * (DisabledEmbedChild) so search runs the production FTS-only path.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createTestDb, MEMORY_ENTRIES_DIR, type TestDbHandle } from "@friday/shared";
import {
  _resetEmbedForTests,
  _setSpawnChildForTests,
  getEntry,
  listEntries,
  saveEntry,
  type EmbedChildTransport,
  type MemoryEntry,
} from "@friday/memory";
import { runHygiene } from "./hygiene.js";

/**
 * A self-driving fake embed child: becomes `ready` once (after the manager has
 * attached its message listener) and answers every `embed` with an `error`
 * event. The manager then resolves `embedText` to `null` — exactly the
 * fail-open FTS-only path of a box with no model cached — WITHOUT forking the
 * real ~240MB onnxruntime child. (A throwing spawn factory would instead hang
 * the manager's ready-waiter, so we keep the child alive but useless.)
 */
class DisabledEmbedChild extends EventEmitter implements EmbedChildTransport {
  readonly pid = 424242;
  constructor() {
    super();
    // Fire after spawnNewChild() returns and wires up `on("message")`.
    setImmediate(() => this.emit("message", { type: "ready" }));
  }
  send(msg: { type: "embed"; id: string; text: string }): boolean {
    setImmediate(() =>
      this.emit("message", { type: "error", id: msg.id, message: "embedder disabled" }),
    );
    return true;
  }
  kill(): boolean {
    return true;
  }
}

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "hygiene_store" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  // Force the embedder fail-open WITHOUT forking the real onnxruntime child, so
  // searchMemories takes the production FTS-only path (same as a box with no
  // model cached on disk).
  _setSpawnChildForTests(() => new DisabledEmbedChild());
});

afterEach(() => {
  _resetEmbedForTests();
});

function nowIso(): string {
  return new Date().toISOString();
}

/** Set recall metadata directly in Postgres. `saveEntry`'s INSERT hardcodes
 *  recallCount=0/lastRecalledAt=null (recall is owned by touchRecall, never the
 *  caller), so seeding a survivor's recall stats requires a direct write. */
async function setRecall(
  id: string,
  recallCount: number,
  lastRecalledAt: string | null,
): Promise<void> {
  const { getDb, schema } = await import("@friday/shared");
  const { eq } = await import("drizzle-orm");
  const db = getDb();
  await db
    .update(schema.memoryEntries)
    .set({ recallCount, lastRecalledAt: lastRecalledAt ? new Date(lastRecalledAt) : null })
    .where(eq(schema.memoryEntries.id, id));
}

/** Seed a near-duplicate of the shared "Habits core tracker" memory. The
 *  shared title token + shared `habits` tag guarantee searchMemories scores
 *  every pair >= DREAM_DEDUP_MIN_SCORE (5): title hits +3 each + exact-tag +5. */
async function seedDup(
  id: string,
  opts: { content: string; uniqueTag: string; recallCount: number; lastRecalledAt?: string | null },
): Promise<MemoryEntry> {
  const entry: MemoryEntry = {
    id,
    title: "Habits core tracker",
    content: opts.content,
    tags: ["evolve", "habits", opts.uniqueTag],
    createdBy: "scheduled-meta-daily",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: nowIso(),
    recallCount: 0,
    lastRecalledAt: null,
  };
  await saveEntry(entry);
  await setRecall(id, opts.recallCount, opts.lastRecalledAt ?? null);
  // Return the entry as it now reads from the store (recall stats applied).
  return { ...entry, recallCount: opts.recallCount, lastRecalledAt: opts.lastRecalledAt ?? null };
}

describe("runHygiene on the real store — three near-dups fold into one survivor (F7 / AC8)", () => {
  it("survivor keeps ALL three contents + tags + recall; losers archived-by-tag with rows + .md intact; forgetEntry never called", async () => {
    // A is the survivor (highest recall + recently recalled). B and C are
    // lower-recall near-dups it must absorb in a SINGLE pass.
    const A = await seedDup("habits-core-a", {
      content: "ALPHA: streaks compute on read.",
      uniqueTag: "alpha",
      recallCount: 10,
      lastRecalledAt: "2026-06-20T00:00:00.000Z",
    });
    const B = await seedDup("habits-core-b", {
      content: "BRAVO: heatmap calendar reuse.",
      uniqueTag: "bravo",
      recallCount: 5,
    });
    const C = await seedDup("habits-core-c", {
      content: "CHARLIE: friday-habit MCP surface.",
      uniqueTag: "charlie",
      recallCount: 2,
    });

    // Spy forgetEntry through the store module's own binding so an internal
    // call would be observed. (Preserve-over-delete: must stay at 0.)
    const memory = await import("@friday/memory");
    const forgetSpy = vi.spyOn(memory, "forgetEntry");

    const report = await runHygiene(await listEntries());

    // Two merges, A survives both.
    expect(report.merged).toHaveLength(2);
    expect(report.merged.every((m) => m.survivorId === A.id)).toBe(true);
    expect(report.merged.map((m) => m.absorbedId).sort()).toEqual([B.id, C.id]);

    // (a) Survivor A's content contains ALL THREE bodies (F1: no clobber).
    const survivor = await getEntry(A.id);
    expect(survivor).not.toBeNull();
    expect(survivor!.content).toContain("ALPHA: streaks compute on read.");
    expect(survivor!.content).toContain("BRAVO: heatmap calendar reuse.");
    expect(survivor!.content).toContain("CHARLIE: friday-habit MCP surface.");

    // (b) Survivor's tags include BOTH losers' unique tags.
    expect(survivor!.tags).toContain("bravo");
    expect(survivor!.tags).toContain("charlie");
    // Its own + the shared tags survive; it is NOT archived.
    expect(survivor!.tags).toEqual(expect.arrayContaining(["evolve", "habits", "alpha"]));
    expect(survivor!.tags).not.toContain("archived");

    // (c) recallCount + lastRecalledAt preserved (omitted from the patch).
    expect(survivor!.recallCount).toBe(10);
    expect(survivor!.lastRecalledAt).toBe("2026-06-20T00:00:00.000Z");

    // (d) B and C: archived-by-tag, getEntry non-null, .md files still on disk.
    for (const loser of [B, C]) {
      const row = await getEntry(loser.id);
      expect(row, `${loser.id} row must survive`).not.toBeNull();
      expect(row!.tags, `${loser.id} must carry archived tag`).toContain("archived");
      expect(
        existsSync(join(MEMORY_ENTRIES_DIR, `${loser.id}.md`)),
        `${loser.id}.md must still exist on disk`,
      ).toBe(true);
    }

    // Exactly one active (non-archived) entry remains: the survivor.
    const active = (await listEntries()).filter((e) => !e.tags.includes("archived"));
    expect(active.map((e) => e.id)).toEqual([A.id]);
    // No rows hard-deleted: listEntries still returns all three.
    expect((await listEntries()).map((e) => e.id).sort()).toEqual([A.id, B.id, C.id].sort());

    // (e) forgetEntry NEVER called — hygiene archives by tag, never hard-deletes.
    expect(forgetSpy).toHaveBeenCalledTimes(0);
  });
});
