/**
 * FRI-171 / ADR-047 — Orchestrator Inbox surface (`listOpenInbox` / `actInbox`).
 *
 * These are the functions the orchestrator's `friday-inbox` MCP tools call
 * (via the daemon's /api/intake/inbox + /api/intake/act routes). The bug class
 * they own is: approve must run the SAME executor the act path does AND flip
 * the row's state open→resolved (the orchestrator has no Zero mutator to do the
 * flip), and the list must surface ONLY open items. So this tests at that layer
 * — a stateful in-memory `inbox_items` table + a real route-target executor spy
 * driven through `assembleRegistry` — not a pure helper.
 *
 *   - actInbox(approve) on an open Proposed row → executor RAN once with the
 *     stored payload AND the row flipped state='resolved' (the load-bearing
 *     assertion).
 *   - actInbox(reject)  → executor did NOT run, row flipped resolved.
 *   - actInbox(dismiss) → row flipped resolved.
 *   - listOpenInbox()   → returns ONLY state='open' rows (a resolved row is
 *     excluded), newest-first, projected with kind/text/target/rationale/age.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- In-memory `inbox_items` table the mocked getDb() reads/writes. --------
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

/**
 * Minimal chainable query mock matching the exact call shapes intake.ts uses:
 *   db.select().from(t).where(eq(id, X))               — by-id lookup
 *   db.select().from(t).where(eq(state,'open')).orderBy — open-list, newest-first
 *   db.update(t).set(patch).where(eq(id, X))           — state flip / promote
 * `eq`/`desc` are mocked to return tagged descriptors the mock interprets.
 */
function makeDb() {
  return {
    select: () => ({
      from: () => {
        let pred: { col: string; val: unknown } | null = null;
        const builder = {
          where: (p: { col: string; val: unknown }) => {
            pred = p;
            const runOnce = () =>
              rows.filter(
                (r) => pred == null || (r as Record<string, unknown>)[pred.col] === pred.val,
              );
            // Awaitable directly (by-id lookup), and chainable to .orderBy.
            return Object.assign(Promise.resolve(runOnce()), {
              orderBy: (o: { col: string; dir: "desc" }) => {
                const out = runOnce().sort((a, b) => {
                  const av = (a as Record<string, unknown>)[o.col] as Date;
                  const bv = (b as Record<string, unknown>)[o.col] as Date;
                  return o.dir === "desc"
                    ? bv.getTime() - av.getTime()
                    : av.getTime() - bv.getTime();
                });
                return Promise.resolve(out);
              },
            });
          },
        };
        return builder;
      },
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
    // schema.inboxItems columns map to tagged descriptors (carrying `key`) so
    // the mocked eq()/desc() can name the field the predicate filters on. Only
    // the columns intake.ts touches. Inlined here (not a top-level const) so the
    // hoisted vi.mock factory has no out-of-TDZ reference.
    schema: {
      ...actual.schema,
      inboxItems: {
        id: { key: "id" },
        state: { key: "state" },
        createdAt: { key: "createdAt" },
      },
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

// FRI-142 / ADR-048 (Layer 3): the approve path now re-validates the stored
// payload against the chosen target's schema and runs its executor through the
// PRODUCER-AGNOSTIC registry (`resolveTarget` in ../inbox/route-registry.js),
// not the Intake-bound `assembleRegistry`. Mock that resolver with a single
// reminder-shaped target whose executor is a spy; stub `registerIntakeTargets`
// (intake.ts calls it to populate the registry before resolving — a no-op here
// since the resolver itself is mocked).
import type { ResultReference } from "../inbox/route-registry.js";
import { z } from "zod";

const executeSpy = vi.fn<(payload: unknown) => Promise<ResultReference>>(async () => ({
  undoable: true,
  inverseLabel: "Delete the reminder",
  deepLink: "/schedules",
}));

const reminderTarget = {
  id: "core:reminder",
  guidance: "test",
  payloadSchema: z.object({ text: z.string().min(1) }).strict(),
  execute: executeSpy,
};

vi.mock("./registry.js", () => ({
  registerIntakeTargets: vi.fn(),
  assembleRegistry: vi.fn(async () => [reminderTarget]),
}));

vi.mock("../inbox/route-registry.js", () => ({
  resolveTarget: vi.fn(async (id: string) => (id === "core:reminder" ? reminderTarget : null)),
}));

import { listOpenInbox, actInbox } from "./intake.js";

function baseRow(over: Partial<Row>): Row {
  return {
    id: "row-1",
    createdAt: new Date("2026-06-21T10:00:00Z"),
    source: "quick_add",
    rawText: "raw",
    cleanedText: "cleaned",
    targetId: null,
    payload: null,
    rationale: "because",
    kind: "proposed",
    state: "open",
    resolvedAt: null,
    undoable: false,
    inverseLabel: null,
    deepLink: null,
    ...over,
  };
}

beforeEach(() => {
  rows = [];
  executeSpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("actInbox(approve)", () => {
  it("runs the target executor with the stored payload AND flips the row to state=resolved", async () => {
    rows = [
      baseRow({
        id: "p1",
        kind: "proposed",
        state: "open",
        targetId: "core:reminder",
        payload: { text: "thaw the chicken" },
      }),
    ];

    const result = await actInbox("p1", "approve");

    // The SAME executor the act path uses ran exactly once with the payload.
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith({ text: "thaw the chicken" });
    expect(result).toMatchObject({ ok: true, undoable: true, deepLink: "/schedules" });

    // Row was promoted to Done by approveInbox and resolved by actInbox.
    const row = rows.find((r) => r.id === "p1")!;
    expect(row.kind).toBe("done");
    expect(row.state).toBe("resolved");
    expect(row.resolvedAt).toBeInstanceOf(Date);
  });
});

describe("actInbox(reject)", () => {
  it("does NOT run the executor and flips the Proposed row to resolved (payload preserved)", async () => {
    rows = [
      baseRow({
        id: "p2",
        kind: "proposed",
        state: "open",
        targetId: "core:reminder",
        payload: { text: "keep me" },
      }),
    ];

    const result = await actInbox("p2", "reject");

    expect(executeSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
    const row = rows.find((r) => r.id === "p2")!;
    expect(row.state).toBe("resolved");
    expect(row.kind).toBe("proposed"); // not executed
    expect(row.payload).toEqual({ text: "keep me" }); // preserve-over-delete
  });
});

describe("actInbox(dismiss)", () => {
  it("flips any open item to resolved without running an executor", async () => {
    rows = [baseRow({ id: "u1", kind: "unsorted", state: "open", targetId: null })];

    const result = await actInbox("u1", "dismiss");

    expect(executeSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
    expect(rows.find((r) => r.id === "u1")!.state).toBe("resolved");
  });
});

describe("listOpenInbox", () => {
  it("returns ONLY open items, newest-first, projected with kind/text/target/rationale/age", async () => {
    rows = [
      baseRow({
        id: "open-old",
        state: "open",
        kind: "proposed",
        cleanedText: "older open item",
        targetId: "core:reminder",
        rationale: "r1",
        createdAt: new Date(Date.now() - 60_000),
      }),
      baseRow({
        id: "resolved-1",
        state: "resolved",
        kind: "done",
        cleanedText: "should NOT appear",
        createdAt: new Date(Date.now() - 30_000),
      }),
      baseRow({
        id: "open-new",
        state: "open",
        kind: "unsorted",
        cleanedText: "newer open item",
        targetId: null,
        rationale: "r2",
        createdAt: new Date(Date.now() - 1_000),
      }),
    ];

    const items = await listOpenInbox();

    // Resolved row excluded; exactly the two open rows, newest-first.
    expect(items.map((i) => i.id)).toEqual(["open-new", "open-old"]);

    expect(items[0]).toMatchObject({
      id: "open-new",
      kind: "unsorted",
      text: "newer open item",
      targetId: null,
      rationale: "r2",
    });
    expect(items[1]).toMatchObject({
      id: "open-old",
      kind: "proposed",
      text: "older open item",
      targetId: "core:reminder",
      rationale: "r1",
    });
    // Age is derived (whole seconds, non-negative).
    expect(items[0].ageSeconds).toBeGreaterThanOrEqual(0);
    expect(items[1].ageSeconds).toBeGreaterThanOrEqual(items[0].ageSeconds);
  });
});
