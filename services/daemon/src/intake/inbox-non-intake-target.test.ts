/**
 * FRI-142 / ADR-048 (Layer 3) — AC8 end-to-end falsification gate.
 *
 * A FABRICATED, NON-Intake producer's row — `raw_text = null`, a non-Intake
 * `source`, and a non-Intake `target_id` (`system:cert_renew`, NOT in Intake's
 * `RouteTargetId` taxonomy) — resolves `approveInbox`/`undoInbox` through the
 * PRODUCER-AGNOSTIC registry: `target.execute` runs, the row promotes to
 * `kind='done'`, and the inverse reverses via the target's OWN `undo`.
 *
 * Before the Layer-3 lift this threw "route target … is no longer available"
 * (Intake's `assembleRegistry().find(...)` couldn't see a non-Intake id). This
 * test does NOT ship a real new producer — it injects a fabricated `RouteTarget`
 * into the resolver, the readiness-only contract the ADR pins.
 *
 * Stateful: a real in-memory `inbox_items` table behind the mocked `getDb()`;
 * the registry resolver is mocked to surface the fabricated target; the action
 * functions (`approveInbox`/`undoInbox`) run for real and we assert observable
 * post-state (executor ran, row kind flipped, undo dispatched).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  createdAt: Date;
  source: string;
  rawText: string | null;
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
// Keep the notify producer seam inert in this unit (intake.ts fires
// capture_attention on writes; not under test here).
vi.mock("../notifications/notify.js", () => ({ notify: vi.fn() }));

// The FABRICATED non-Intake target. Its executor + inverse are spies.
import type { ResultReference } from "../inbox/route-registry.js";

const executeSpy = vi.fn<(payload: unknown) => Promise<ResultReference>>(async () => ({
  undoable: true,
  inverseLabel: "Roll back the cert",
  deepLink: "/system/certs?undo=cert-1",
}));
const undoSpy = vi.fn(async () => true);

const fabricatedTarget = {
  id: "system:cert_renew",
  guidance: "renew the cert",
  payloadSchema: { safeParse: (data: unknown) => ({ success: true as const, data }) },
  execute: executeSpy,
  undo: undoSpy,
};

// Resolve ONLY the fabricated non-Intake id (proves no Intake coupling).
vi.mock("../inbox/route-registry.js", () => ({
  resolveTarget: vi.fn(async (id: string) =>
    id === "system:cert_renew" ? fabricatedTarget : null,
  ),
}));
// `registerIntakeTargets` is a no-op here (the resolver is mocked outright).
vi.mock("./registry.js", () => ({
  registerIntakeTargets: vi.fn(),
  assembleRegistry: vi.fn(async () => []),
}));

import { approveInbox, undoInbox } from "./intake.js";

function baseRow(over: Partial<Row>): Row {
  return {
    id: "row-1",
    createdAt: new Date("2026-06-21T10:00:00Z"),
    source: "system",
    rawText: null, // a non-Intake producer writes no raw human input
    cleanedText: null,
    targetId: "system:cert_renew",
    payload: { domain: "example.com" },
    rationale: null,
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
  undoSpy.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("approveInbox — a non-Intake target resolves + executes (AC8)", () => {
  it("runs the fabricated target's executor and promotes the row to kind='done'", async () => {
    rows = [
      baseRow({
        id: "n1",
        source: "system",
        rawText: null,
        targetId: "system:cert_renew",
        payload: { domain: "example.com" },
      }),
    ];

    const result = await approveInbox("n1");

    // The fabricated (non-Intake) executor ran with the stored payload — proving
    // the producer-agnostic resolver, not Intake's assembleRegistry, drove it.
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledWith({ domain: "example.com" });
    expect(result).toMatchObject({
      ok: true,
      undoable: true,
      inverseLabel: "Roll back the cert",
      deepLink: "/system/certs?undo=cert-1",
    });

    // The row promoted to Done, stamping the executor's artifact reference.
    const row = rows.find((r) => r.id === "n1")!;
    expect(row.kind).toBe("done");
    expect(row.undoable).toBe(true);
    expect(row.deepLink).toBe("/system/certs?undo=cert-1");
  });
});

describe("undoInbox — a non-Intake Done item reverses via its OWN undo (AC8)", () => {
  it("dispatches the resolved target's inverse with the row's deep-link", async () => {
    rows = [
      baseRow({
        id: "n2",
        kind: "done",
        state: "open",
        undoable: true,
        targetId: "system:cert_renew",
        deepLink: "/system/certs?undo=cert-1",
      }),
    ];

    const result = await undoInbox("n2");

    expect(undoSpy).toHaveBeenCalledTimes(1);
    expect(undoSpy).toHaveBeenCalledWith("/system/certs?undo=cert-1");
    expect(result).toEqual({ ok: true });
  });
});
