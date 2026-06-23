/**
 * FRI-171 / ADR-047 — Intake verdict→executor dispatch (Gate 1 / Gate 2).
 *
 * Tests the HEART of intake at the layer the gating bug would live in:
 * `dispatchVerdict(source, rawText, verdict, targets)`. The classifier (the
 * `query()` call) and the real executors are NOT exercised here — `targets` is
 * passed in with `vi.fn()` executors + real zod schemas, and the DB write is
 * captured via a mocked `getDb()`. So these assertions pin the gate logic, not
 * Postgres and not the model:
 *
 *   - act + valid payload  → executor RAN, a kind='done' row written (undoable
 *     reflects the ResultReference). (AC7)
 *   - propose              → executor did NOT run, a kind='proposed' row written
 *     carrying the payload.
 *   - act + INVALID payload→ executor did NOT run, degrades to a kind='proposed'
 *     row carrying the (unexecuted) payload — never dropped. (AC8)
 *   - act + executor THROWS→ degrades to a kind='proposed' row — never dropped.
 *   - targetId === null    → kind='unsorted' row, no executor (Gate 1).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { IntakeVerdict } from "@friday/shared";

// Capture every inserted inbox row. `db.insert(table).values(obj)` records obj.
const insertedRows: Record<string, unknown>[] = [];
const insertSpy = vi.fn(() => ({
  values: (obj: Record<string, unknown>) => {
    insertedRows.push(obj);
    return Promise.resolve(undefined);
  },
}));

vi.mock("@friday/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@friday/shared")>();
  return {
    ...actual,
    // Only getDb is mocked; `schema` (used as the insert target) stays real so
    // `schema.inboxItems` is a stable object the spy is keyed on.
    getDb: () => ({ insert: insertSpy }),
  };
});

// Keep the dispatcher's logger calls from touching the real log sink.
vi.mock("../log.js", () => ({
  logger: { log: vi.fn() },
}));

// FRI-142 / ADR-048 producer seam #1: capture_attention. Mock the router so we
// can assert WHICH event the dispatcher fires (and that it does NOT fire on the
// Done/act path — a Done item is FYI and never raises a Notification).
const notifySpy = vi.fn();
vi.mock("../notifications/notify.js", () => ({ notify: (e: unknown) => notifySpy(e) }));

import { dispatchVerdict } from "./intake.js";
import type { RouteTarget } from "./registry.js";
import type { ResultReference } from "./executors.js";

/** A fake reminder-shaped target whose executor is a spy. Real zod schema so
 *  the act-path validation actually runs (the AC8 failure mode). */
function makeTarget(execImpl: (payload: unknown) => Promise<ResultReference>): {
  target: RouteTarget;
  exec: ReturnType<typeof vi.fn>;
} {
  const exec = vi.fn(execImpl);
  const target: RouteTarget = {
    id: "core:reminder",
    guidance: "test reminder target",
    payloadSchema: z.object({ text: z.string().min(1), dueDate: z.string().optional() }).strict(),
    execute: exec,
  };
  return { target, exec };
}

const REMINDER_REF: ResultReference = {
  undoable: true,
  inverseLabel: "Delete the reminder",
  deepLink: "/schedules",
};

beforeEach(() => {
  insertedRows.length = 0;
  insertSpy.mockClear();
  notifySpy.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("dispatchVerdict — Gate 2 act path (AC7)", () => {
  it("runs the executor with the mapped payload and writes a Done row with undoable from the result reference", async () => {
    const { target, exec } = makeTarget(async () => REMINDER_REF);
    const verdict: IntakeVerdict = {
      cleaned: "remind me to thaw the chicken Thursday",
      targetId: "core:reminder",
      payload: { text: "thaw the chicken", dueDate: "2026-06-25" },
      disposition: "act",
      rationale: "time-anchored nudge",
    };

    const result = await dispatchVerdict(
      "watch",
      "uh remind me to thaw the chicken Thursday",
      verdict,
      [target],
    );

    // Executor ran exactly once with the validated payload.
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith({ text: "thaw the chicken", dueDate: "2026-06-25" });

    // Exactly one Done row, carrying the ResultReference fields + the payload.
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      source: "watch",
      rawText: "uh remind me to thaw the chicken Thursday",
      cleanedText: "remind me to thaw the chicken Thursday",
      targetId: "core:reminder",
      payload: { text: "thaw the chicken", dueDate: "2026-06-25" },
      kind: "done",
      state: "open",
      undoable: true,
      inverseLabel: "Delete the reminder",
      deepLink: "/schedules",
    });

    expect(result).toMatchObject({ kind: "done", disposition: "act" });

    // Seam: a Done item is FYI and never bumps the badge — NO capture_attention.
    expect(notifySpy).not.toHaveBeenCalled();
  });
});

describe("dispatchVerdict — propose path", () => {
  it("does NOT run the executor and writes a Proposed row carrying the payload", async () => {
    const { target, exec } = makeTarget(async () => REMINDER_REF);
    const verdict: IntakeVerdict = {
      cleaned: "fix the leaky faucet",
      targetId: "core:reminder",
      payload: { text: "fix the leaky faucet" },
      disposition: "propose",
      rationale: "higher-stakes, stage for review",
    };

    const result = await dispatchVerdict("quick_add", "fix the leaky faucet", verdict, [target]);

    expect(exec).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      kind: "proposed",
      state: "open",
      targetId: "core:reminder",
      payload: { text: "fix the leaky faucet" },
      undoable: false,
    });
    expect(result).toMatchObject({ kind: "proposed", disposition: "propose" });

    // Seam: a Proposed item needs an approve/reject — capture_attention fires.
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0]![0]).toMatchObject({ type: "capture_attention" });
  });
});

describe("dispatchVerdict — payload-validation failure degrades act→propose (AC8)", () => {
  it("does NOT run the executor and writes a Proposed row carrying the (unexecuted) payload", async () => {
    const { target, exec } = makeTarget(async () => REMINDER_REF);
    // disposition is 'act' but the payload is missing the required `text` —
    // fails the target's payloadSchema. Must degrade to Proposed, never run.
    const verdict: IntakeVerdict = {
      cleaned: "something vague",
      targetId: "core:reminder",
      payload: { dueDate: "2026-06-25" }, // no `text`
      disposition: "act",
      rationale: "model said act but payload is incomplete",
    };

    const result = await dispatchVerdict("watch", "something vague", verdict, [target]);

    expect(exec).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      kind: "proposed",
      state: "open",
      targetId: "core:reminder",
      // The payload is preserved verbatim for later approve/triage — not dropped.
      payload: { dueDate: "2026-06-25" },
      undoable: false,
    });
    // The recorded disposition reflects the degrade.
    expect(result).toMatchObject({ kind: "proposed", disposition: "propose" });
  });
});

describe("dispatchVerdict — executor throw degrades act→propose", () => {
  it("writes a Proposed row when the executor throws (e.g. unresolved habit) — never drops", async () => {
    const { target, exec } = makeTarget(async () => {
      throw new Error('no active habit named "pushups"');
    });
    const verdict: IntakeVerdict = {
      cleaned: "did my pushups",
      targetId: "core:reminder", // target id matches the fake target
      payload: { text: "did my pushups" },
      disposition: "act",
      rationale: "habit check-in",
    };

    const result = await dispatchVerdict("quick_add", "did my pushups", verdict, [target]);

    expect(exec).toHaveBeenCalledTimes(1);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      kind: "proposed",
      payload: { text: "did my pushups" },
      undoable: false,
    });
    expect(result).toMatchObject({ kind: "proposed", disposition: "propose" });
  });
});

describe("dispatchVerdict — Gate 1 Unsorted (null target)", () => {
  it("writes an Unsorted row and runs no executor when targetId is null", async () => {
    const { target, exec } = makeTarget(async () => REMINDER_REF);
    const verdict: IntakeVerdict = {
      cleaned: "blue mountain seventeen",
      targetId: null,
      payload: null,
      disposition: "propose",
      rationale: "could not classify",
    };

    const result = await dispatchVerdict("watch", "blue mountain seventeen", verdict, [target]);

    expect(exec).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      kind: "unsorted",
      state: "open",
      targetId: null,
      payload: null,
      undoable: false,
    });
    expect(result).toMatchObject({ kind: "unsorted" });

    // Seam: an Unsorted item needs triage — capture_attention fires.
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0]![0]).toMatchObject({ type: "capture_attention" });
  });
});

describe("dispatchVerdict — unknown target degrades to Proposed", () => {
  it("stages a Proposed row when the verdict's targetId is not in the registry", async () => {
    const { target, exec } = makeTarget(async () => REMINDER_REF);
    const verdict: IntakeVerdict = {
      cleaned: "send to the kitchen app",
      targetId: "agent:nonexistent",
      payload: { body: "hello" },
      disposition: "act",
      rationale: "route to app agent",
    };

    const result = await dispatchVerdict("quick_add", "send to the kitchen app", verdict, [target]);

    expect(exec).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      kind: "proposed",
      targetId: "agent:nonexistent",
      payload: { body: "hello" },
    });
    expect(result).toMatchObject({ kind: "proposed", disposition: "propose" });
  });
});
