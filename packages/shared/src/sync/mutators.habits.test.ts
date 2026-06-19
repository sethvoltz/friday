// FRI-169 AC14 / AC18 — habit check-off mutator behavior.
//
// Mocks ONLY the Zero `tx.mutate` boundary; the mutator bodies are the
// real `createMutators()` implementations. The assertions pin the write
// set: `habitCheckin` issues exactly one `habit_checkins.insert` with the
// supplied {id, habit_id, ts} (append-only — never an update/delete of a
// prior row), and `habitCheckinUndo` deletes exactly one row by id and
// touches no other table.

import { describe, expect, it, vi } from "vitest";
import { createMutators, type HabitCheckinArgs, type HabitCheckinUndoArgs } from "./mutators.js";

interface HabitCheckinInsertCall {
  id: string;
  habit_id: string;
  ts: number;
  note?: string;
}

interface HabitCheckinDeleteCall {
  id: string;
}

function makeMockTx(): {
  tx: Parameters<ReturnType<typeof createMutators>["habitCheckin"]>[0];
  inserts: HabitCheckinInsertCall[];
  deletes: HabitCheckinDeleteCall[];
  insertSpy: ReturnType<typeof vi.fn>;
  deleteSpy: ReturnType<typeof vi.fn>;
  otherTableSpy: ReturnType<typeof vi.fn>;
} {
  const inserts: HabitCheckinInsertCall[] = [];
  const deletes: HabitCheckinDeleteCall[] = [];
  const insertSpy = vi.fn(async (row: HabitCheckinInsertCall) => {
    inserts.push(row);
  });
  const deleteSpy = vi.fn(async (row: HabitCheckinDeleteCall) => {
    deletes.push(row);
  });
  // A sentinel for "some other table" — asserts the habit mutators don't
  // touch anything besides habit_checkins.
  const otherTableSpy = vi.fn(async () => {});
  const tx = {
    mutate: {
      habit_checkins: { insert: insertSpy, delete: deleteSpy },
      // Present so an accidental write to a sibling table would be
      // observable rather than throwing "undefined is not a function".
      habits: { insert: otherTableSpy, update: otherTableSpy, delete: otherTableSpy },
      schedules: { update: otherTableSpy },
    },
  } as unknown as Parameters<ReturnType<typeof createMutators>["habitCheckin"]>[0];
  return { tx, inserts, deletes, insertSpy, deleteSpy, otherTableSpy };
}

describe("habitCheckin (FRI-169 AC18 — append-only INSERT)", () => {
  it("issues exactly one habit_checkins.insert with the supplied {id, habit_id, ts} and no other mutate call", async () => {
    const mutators = createMutators();
    const { tx, inserts, insertSpy, deleteSpy, otherTableSpy } = makeMockTx();
    const args: HabitCheckinArgs = {
      id: "ck-uuid-1",
      habitId: "habit-uuid-9",
      ts: 1_700_000_000_000,
    };
    await mutators.habitCheckin(tx, args);
    expect(inserts).toEqual([
      {
        id: "ck-uuid-1",
        habit_id: "habit-uuid-9",
        ts: 1_700_000_000_000,
        note: undefined,
      },
    ]);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    // AC18: exactly one mutate call total — no delete, no sibling write.
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(otherTableSpy).not.toHaveBeenCalled();
  });

  it("threads an optional note through verbatim", async () => {
    const mutators = createMutators();
    const { tx, inserts } = makeMockTx();
    await mutators.habitCheckin(tx, {
      id: "ck-2",
      habitId: "h-2",
      ts: 42,
      note: "felt great",
    });
    expect(inserts[0]!.note).toBe("felt great");
  });

  it("backdates by honoring the supplied ts (never overwrites it with a fresh clock)", async () => {
    const mutators = createMutators();
    const { tx, inserts } = makeMockTx();
    const backdated = 1_600_000_000_000; // well in the past
    await mutators.habitCheckin(tx, { id: "ck-3", habitId: "h-3", ts: backdated });
    expect(inserts[0]!.ts).toBe(backdated);
  });

  it("is append-only on repeated calls — two check-ins produce two distinct INSERTs, never an update/delete", async () => {
    const mutators = createMutators();
    const { tx, inserts, insertSpy, deleteSpy } = makeMockTx();
    await mutators.habitCheckin(tx, { id: "ck-a", habitId: "h-1", ts: 1 });
    await mutators.habitCheckin(tx, { id: "ck-b", habitId: "h-1", ts: 2 });
    expect(insertSpy).toHaveBeenCalledTimes(2);
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(inserts.map((r) => r.id)).toEqual(["ck-a", "ck-b"]);
  });
});

describe("habitCheckinUndo (FRI-169 AC14 — single-row DELETE)", () => {
  it("deletes exactly one habit_checkins row by id and touches nothing else", async () => {
    const mutators = createMutators();
    const { tx, deletes, deleteSpy, insertSpy, otherTableSpy } = makeMockTx();
    const args: HabitCheckinUndoArgs = { id: "ck-to-undo" };
    await mutators.habitCheckinUndo(tx, args);
    expect(deletes).toEqual([{ id: "ck-to-undo" }]);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(otherTableSpy).not.toHaveBeenCalled();
  });

  it("is idempotent on PK — re-running with the same id produces an identical second delete", async () => {
    const mutators = createMutators();
    const { tx, deletes } = makeMockTx();
    const args: HabitCheckinUndoArgs = { id: "ck-x" };
    await mutators.habitCheckinUndo(tx, args);
    await mutators.habitCheckinUndo(tx, args);
    expect(deletes).toHaveLength(2);
    expect(deletes[0]).toEqual(deletes[1]);
  });

  it("AC14 sequence: check-in c then undo({id:c}) issues one insert(c) then one delete(c)", async () => {
    // Models AC14's [a,b] → checkin c → [a,b,c] → undo(c) → [a,b]
    // contract at the mutator-write-set level: the undo targets exactly
    // the id it was given (the sibling rows a,b are never named, so they
    // cannot be touched).
    const mutators = createMutators();
    const { tx, inserts, deletes } = makeMockTx();
    await mutators.habitCheckin(tx, { id: "c", habitId: "h", ts: 10 });
    await mutators.habitCheckinUndo(tx, { id: "c" });
    expect(inserts.map((r) => r.id)).toEqual(["c"]);
    expect(deletes.map((r) => r.id)).toEqual(["c"]);
  });
});
