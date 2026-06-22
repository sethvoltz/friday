/**
 * FRI-171 / ADR-047 — UNDO inverse-executor dispatch gap test (AC10 lifecycle).
 *
 * The lifecycle ACs are covered piecemeal elsewhere: `inbox-actions.test.ts`
 * pins approve/reject/dismiss + the open→resolved flips, and the dashboard
 * `inbox.svelte.test.ts` pins the store calling `/api/intake/undo` then the
 * `inboxUndo` mutator. But NEITHER exercises the actual INVERSE EXECUTOR — the
 * server-side dispatch that reverses the artifact a Done item created. That is
 * the bug class for Undo: dispatching `undoArtifact` on the wrong `target_id`
 * (deleting the wrong kind of artifact), parsing the wrong id out of the
 * deep-link, or flipping the row resolved BEFORE the inverse runs.
 *
 * This tests at the layer the inverse lives in:
 *   - `parseUndoId` extracts the `?undo=<id>` token the undoable executors stamp.
 *   - `undoArtifact` dispatches the correct delete primitive PER target id
 *     (reminder→deleteSchedule, habit→deleteCheckin, memory→forgetEntry) and is
 *     a no-op for the non-undoable targets (ticket / agent mail).
 *   - `undoInbox` runs the inverse for an open undoable Done row and is an
 *     idempotent no-op for a non-undoable / non-open / non-done row.
 *   - `actInbox("undo")` runs the inverse THEN flips state open→resolved (the
 *     orchestrator path that has no Zero mutator).
 *
 * The delete primitives are mocked at their module boundary (the IO boundary);
 * the dispatch + ordering logic under test is real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Declared via vi.hoisted so the (hoisted) vi.mock factories below can
// reference these spies without tripping the TDZ — vi.mock is lifted above
// plain top-level `const`s, but vi.hoisted runs first.
const { deleteSchedule, deleteCheckin, forgetEntry } = vi.hoisted(() => ({
  deleteSchedule: vi.fn<(name: string) => Promise<boolean>>(async () => true),
  deleteCheckin: vi.fn<(id: string) => Promise<boolean>>(async () => true),
  forgetEntry: vi.fn<(id: string) => Promise<void>>(async () => {}),
}));

vi.mock("../scheduler/scheduler.js", () => ({
  deleteSchedule,
  upsertSchedule: vi.fn(),
}));
vi.mock("../habits/store.js", () => ({
  deleteCheckin,
  insertCheckin: vi.fn(),
  listHabits: vi.fn(async () => []),
}));
// Spread the real module so any export the import graph pulls in transitively
// (e.g. `@friday/evolve`'s dreaming-pipeline → `searchMemories`) stays defined;
// only the IO-boundary writes this test exercises are overridden with spies.
vi.mock("@friday/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@friday/memory")>()),
  forgetEntry,
  saveEntry: vi.fn(),
}));

import { undoArtifact, parseUndoId } from "./executors.js";

describe("parseUndoId", () => {
  it("extracts the undo token an undoable executor stamps into its deepLink", () => {
    expect(parseUndoId("/schedules?undo=intake_123_ab")).toBe("intake_123_ab");
    expect(parseUndoId("/habits?undo=checkin-9")).toBe("checkin-9");
  });

  it("returns null when the deepLink carries no undo token", () => {
    expect(parseUndoId("/tickets/FRI-12")).toBeNull();
    expect(parseUndoId("/schedules")).toBeNull();
    expect(parseUndoId("/schedules?other=x")).toBeNull();
  });
});

describe("undoArtifact — dispatches the correct inverse per target id", () => {
  beforeEach(() => {
    deleteSchedule.mockClear();
    deleteCheckin.mockClear();
    forgetEntry.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it("core:reminder → deleteSchedule with the id parsed from the deep-link", async () => {
    const removed = await undoArtifact("core:reminder", "/schedules?undo=intake_42_zz");
    expect(deleteSchedule).toHaveBeenCalledTimes(1);
    expect(deleteSchedule).toHaveBeenCalledWith("intake_42_zz");
    expect(deleteCheckin).not.toHaveBeenCalled();
    expect(forgetEntry).not.toHaveBeenCalled();
    expect(removed).toBe(true);
  });

  it("core:habit → deleteCheckin with the check-in id", async () => {
    const removed = await undoArtifact("core:habit", "/habits?undo=checkin-7");
    expect(deleteCheckin).toHaveBeenCalledTimes(1);
    expect(deleteCheckin).toHaveBeenCalledWith("checkin-7");
    expect(deleteSchedule).not.toHaveBeenCalled();
    expect(removed).toBe(true);
  });

  it("core:memory → forgetEntry with the memory id", async () => {
    const removed = await undoArtifact("core:memory", "/memory?undo=intake-9-abc");
    expect(forgetEntry).toHaveBeenCalledTimes(1);
    expect(forgetEntry).toHaveBeenCalledWith("intake-9-abc");
    expect(removed).toBe(true);
  });

  it("non-undoable targets (ticket / agent mail) reverse NOTHING", async () => {
    expect(await undoArtifact("core:ticket", "/tickets/FRI-1")).toBe(false);
    expect(await undoArtifact("agent:kitchen", "/mail?id=m1")).toBe(false);
    expect(deleteSchedule).not.toHaveBeenCalled();
    expect(deleteCheckin).not.toHaveBeenCalled();
    expect(forgetEntry).not.toHaveBeenCalled();
  });

  it("a deep-link with no undo token reverses nothing (idempotent re-undo)", async () => {
    expect(await undoArtifact("core:reminder", "/schedules")).toBe(false);
    expect(deleteSchedule).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------
 * undoInbox / actInbox("undo") — the inverse runs server-side, THEN the row
 * flips open→resolved. Driven through a stateful in-memory inbox_items table
 * (mirrors inbox-actions.test.ts) so the ordering + state flip are observable.
 * ----------------------------------------------------------------------- */

interface Row {
  id: string;
  createdAt: Date;
  source: string;
  rawText: string;
  cleanedText: string | null;
  targetId: string | null;
  payload: unknown;
  rationale: string | null;
  kind: string;
  state: string;
  resolvedAt: Date | null;
  undoable: boolean;
  inverseLabel: string | null;
  deepLink: string | null;
}

let rows: Row[] = [];

function makeDb() {
  return {
    select: () => ({
      from: () => ({
        where: (p: { col: string; val: unknown }) =>
          Promise.resolve(rows.filter((r) => (r as Record<string, unknown>)[p.col] === p.val)),
      }),
    }),
    update: () => ({
      set: (patch: Partial<Row>) => ({
        where: (p: { col: string; val: unknown }) => {
          for (const r of rows) {
            if ((r as Record<string, unknown>)[p.col] === p.val) Object.assign(r, patch);
          }
          return Promise.resolve(undefined);
        },
      }),
    }),
  };
}

vi.mock("@friday/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@friday/shared")>();
  return {
    ...actual,
    getDb: () => makeDb(),
    schema: {
      ...actual.schema,
      inboxItems: { id: { key: "id" }, state: { key: "state" }, createdAt: { key: "createdAt" } },
    },
  };
});

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return {
    ...actual,
    eq: (col: { key: string }, val: unknown) => ({ col: col.key, val }),
    desc: (col: { key: string }) => ({ col: col.key, dir: "desc" as const }),
  };
});

vi.mock("../log.js", () => ({ logger: { log: vi.fn() } }));

import { undoInbox, actInbox } from "./intake.js";

function baseRow(over: Partial<Row>): Row {
  return {
    id: "row-1",
    createdAt: new Date("2026-06-21T10:00:00Z"),
    source: "quick_add",
    rawText: "raw",
    cleanedText: "cleaned",
    targetId: null,
    payload: null,
    rationale: null,
    kind: "done",
    state: "open",
    resolvedAt: null,
    undoable: false,
    inverseLabel: null,
    deepLink: null,
    ...over,
  };
}

describe("undoInbox — runs the inverse for an open undoable Done row", () => {
  beforeEach(() => {
    rows = [];
    deleteSchedule.mockClear();
    deleteCheckin.mockClear();
    forgetEntry.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it("reverses the reminder artifact via deleteSchedule for an open undoable Done reminder", async () => {
    rows = [
      baseRow({
        id: "d1",
        kind: "done",
        state: "open",
        undoable: true,
        targetId: "core:reminder",
        deepLink: "/schedules?undo=intake_55_qq",
      }),
    ];

    const result = await undoInbox("d1");

    expect(deleteSchedule).toHaveBeenCalledTimes(1);
    expect(deleteSchedule).toHaveBeenCalledWith("intake_55_qq");
    expect(result).toEqual({ ok: true });
  });

  it("is a no-op (no inverse) for a non-undoable Done row", async () => {
    rows = [
      baseRow({
        id: "t1",
        kind: "done",
        state: "open",
        undoable: false,
        targetId: "core:ticket",
        deepLink: "/tickets/FRI-3",
      }),
    ];
    const result = await undoInbox("t1");
    expect(deleteSchedule).not.toHaveBeenCalled();
    expect(deleteCheckin).not.toHaveBeenCalled();
    expect(forgetEntry).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it("is a no-op for an already-resolved row (idempotent re-undo)", async () => {
    rows = [
      baseRow({
        id: "d2",
        kind: "done",
        state: "resolved",
        undoable: true,
        targetId: "core:memory",
        deepLink: "/memory?undo=m9",
      }),
    ];
    const result = await undoInbox("d2");
    expect(forgetEntry).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });
});

describe("actInbox(undo) — inverse runs THEN the row flips open→resolved", () => {
  beforeEach(() => {
    rows = [];
    deleteCheckin.mockClear();
  });
  afterEach(() => vi.clearAllMocks());

  it("runs the habit inverse and resolves the row (orchestrator path)", async () => {
    rows = [
      baseRow({
        id: "h1",
        kind: "done",
        state: "open",
        undoable: true,
        targetId: "core:habit",
        deepLink: "/habits?undo=checkin-33",
      }),
    ];

    const result = await actInbox("h1", "undo");

    // The inverse executor ran with the artifact id from the deep-link.
    expect(deleteCheckin).toHaveBeenCalledTimes(1);
    expect(deleteCheckin).toHaveBeenCalledWith("checkin-33");
    expect(result).toEqual({ ok: true });

    // ...AND the row was flipped resolved by actInbox (the step the Zero mutator
    // does on the dashboard, which the orchestrator has no session for).
    const row = rows.find((r) => r.id === "h1")!;
    expect(row.state).toBe("resolved");
    expect(row.resolvedAt).toBeInstanceOf(Date);
  });
});
