import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// FRI-12: Stop force-kill safety net. The d5b1f6e commit made Stop's UX
// correct *when the worker is responsive* — but in the wedge case (SDK
// stuck on a 529, the abort IPC silently ignored), the bubble would hang
// in 'stopping' forever waiting for a turn_done that never comes.
//
// `abortTurn` now schedules a 2s deadline. If the worker doesn't ack
// (turn-complete or error IPC) in time, `forceKillStuckWorker` finalizes
// the turn (error block + turn_done aborted) and SIGTERMs the process
// group. A worker that responds in time clears the deadline.

const dataDir = mkdtempSync(join(tmpdir(), "friday-lifecycle-fk-"));
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
  vi.useRealTimers();
});

interface FakeChild {
  send: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  killed: boolean;
}

function makeFakeWorker(overrides: Record<string, unknown> = {}): {
  worker: unknown;
  child: FakeChild;
} {
  const child: FakeChild = {
    send: vi.fn(),
    exitCode: null,
    killed: false,
  };
  const w = {
    child,
    // pgid 0 makes killPgrp a no-op — we don't want the test to actually
    // SIGTERM anything in the test runner.
    pgid: 0,
    agentName: "fk-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "turn-fk-1",
    sessionId: "sess-fk-1",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now() - 1000,
    spawnedAt: Date.now() - 5000,
    lastBlockStop: Date.now(),
    status: "working",
    nextPrompts: [],
    mode: "long-lived",
    lastExitStatus: "complete",
    completedAtLeastOnce: false,
    ...overrides,
  };
  return { worker: w, child };
}

interface CapturedEvent {
  type: string;
  turn_id?: string;
  agent?: string;
  status?: string;
  block_id?: string;
  kind?: string;
  code?: string;
}

describe("lifecycle: stop force-kill safety net (FRI-12)", () => {
  it("force-kills the worker when abort IPC is ignored for 2s", async () => {
    const { abortTurn, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");
    const { getRawDb } = await import("@friday/shared");

    vi.useFakeTimers();
    const { worker, child } = makeFakeWorker();
    __putLiveWorkerForTest("fk-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    expect(abortTurn("fk-agent")).toBe(true);
    expect(child.send).toHaveBeenCalledWith({ type: "abort" });

    // Before the deadline, no force-kill yet.
    vi.advanceTimersByTime(1500);
    expect(captured.find((e) => e.type === "turn_done")).toBeUndefined();

    // After the 2s deadline, force-kill fires.
    vi.advanceTimersByTime(600);
    unsub();

    // Error block was inserted with stopped_forced.
    const rows = getRawDb()
      .prepare("SELECT content_json, kind FROM blocks WHERE turn_id = ?")
      .all("turn-fk-1") as Array<{ content_json: string; kind: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("error");
    const payload = JSON.parse(rows[0].content_json) as Record<string, unknown>;
    expect(payload.code).toBe("stopped_forced");
    expect(payload.headline).toContain("worker did not respond");

    // turn_done aborted was published.
    const done = captured.find((e) => e.type === "turn_done" && e.turn_id === "turn-fk-1");
    expect(done).toBeDefined();
    expect(done!.status).toBe("aborted");

    // TurnErrorEvent with the stopped_forced code published too.
    const err = captured.find((e) => e.type === "error" && e.code === "stopped_forced");
    expect(err).toBeDefined();

    __deleteLiveWorkerForTest("fk-agent");
  });

  it("does NOT force-kill when worker emits turn-complete before the deadline", async () => {
    const { abortTurn, handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");
    const { getRawDb } = await import("@friday/shared");

    vi.useFakeTimers();
    const { worker } = makeFakeWorker({ turnId: "turn-fk-2" });
    __putLiveWorkerForTest("fk-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    abortTurn("fk-agent");

    // Worker responds at 500ms with turn-complete (the SDK aborted cleanly).
    vi.advanceTimersByTime(500);
    handleEvent(worker as never, {
      type: "turn-complete",
      sessionId: "sess-fk-1",
    });

    // Advance well past the original 2s deadline.
    vi.advanceTimersByTime(3000);
    unsub();

    // No stopped_forced block — the worker cleaned up.
    const rows = getRawDb()
      .prepare("SELECT content_json FROM blocks WHERE turn_id = ?")
      .all("turn-fk-2") as Array<{ content_json: string }>;
    const stoppedForced = rows.find((r) => {
      try {
        const p = JSON.parse(r.content_json);
        return p && (p as { code?: string }).code === "stopped_forced";
      } catch {
        return false;
      }
    });
    expect(stoppedForced).toBeUndefined();

    // No stopped_forced TurnErrorEvent.
    expect(captured.find((e) => e.type === "error" && e.code === "stopped_forced")).toBeUndefined();

    __deleteLiveWorkerForTest("fk-agent");
  });

  it("does NOT force-kill when worker emits error IPC before the deadline", async () => {
    const { abortTurn, handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    vi.useFakeTimers();
    const { worker } = makeFakeWorker({ turnId: "turn-fk-3" });
    __putLiveWorkerForTest("fk-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    abortTurn("fk-agent");

    vi.advanceTimersByTime(800);
    // Worker emits error IPC because SDK threw an AbortError.
    handleEvent(worker as never, {
      type: "error",
      message: "aborted",
      recoverable: true,
    });

    vi.advanceTimersByTime(3000);
    unsub();

    // The worker's error path emits TurnErrorEvent with code='aborted'
    // (because abortRequested is true). No stopped_forced anywhere.
    const aborted = captured.find((e) => e.type === "error" && e.code === "aborted");
    expect(aborted).toBeDefined();
    expect(captured.find((e) => e.code === "stopped_forced")).toBeUndefined();

    __deleteLiveWorkerForTest("fk-agent");
  });

  it("force-kill at 1.9s race: late turn-complete after force-kill is ignored", async () => {
    // Pathological: worker responds RIGHT after the 2s timer fires. The
    // force-kill flow already ran; the late turn-complete must be a no-op
    // so we don't double-publish turn_done.
    const { abortTurn, handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");

    vi.useFakeTimers();
    const { worker } = makeFakeWorker({ turnId: "turn-fk-4" });
    __putLiveWorkerForTest("fk-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    abortTurn("fk-agent");
    vi.advanceTimersByTime(2100);
    // Now force-kill has run. The worker, dying, emits one final turn-complete.
    handleEvent(worker as never, {
      type: "turn-complete",
      sessionId: "sess-fk-1",
    });
    unsub();

    const turnDoneEvents = captured.filter((e) => e.type === "turn_done" && e.turn_id === "turn-fk-4");
    expect(turnDoneEvents.length).toBe(1);
    expect(turnDoneEvents[0].status).toBe("aborted");

    __deleteLiveWorkerForTest("fk-agent");
  });

  it("abortTurn returns false when no live worker matches", async () => {
    const { abortTurn } = await import("./lifecycle.js");
    expect(abortTurn("not-a-real-agent")).toBe(false);
  });
});
