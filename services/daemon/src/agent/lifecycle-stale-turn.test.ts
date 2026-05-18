import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// FRI-33: stale-turn ceiling and IPC error boundary.
//
// Observed in prod: a worker stays on the same turn for ~12.5h before the
// daemon process exits with a `daemon.fatal`. The stall watchdog
// (`worker.turn.stalled`) misses these because the worker emits periodic
// block-stops; only the *turn* never ends. Two scoped defenses:
//
//   1. Hard ceiling on `msSinceTurnStart`. Any inbound IPC from a worker
//      whose turn has run past the ceiling triggers a force-kill and a
//      structured `worker.turn.stale-killed` log line.
//   2. Try/catch around the `status-change` IPC branch so a malformed
//      payload can't escape into the unhandled `child.on("message")`
//      listener and crash the daemon.

const dataDir = mkdtempSync(join(tmpdir(), "friday-lifecycle-stale-"));
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
  vi.restoreAllMocks();
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
    // pgid 0 → killPgrp no-ops, so we don't actually SIGTERM the test runner.
    pgid: 0,
    agentName: "stale-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    turnId: "turn-stale-1",
    sessionId: "sess-stale-1",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now(),
    spawnedAt: Date.now(),
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
  code?: string;
  message?: string;
}

describe("lifecycle: stale-turn ceiling (FRI-33)", () => {
  it("force-kills worker when an inbound IPC reports msSinceTurnStart > 4h, emits structured log", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");
    const { logger } = await import("../log.js");
    const { getRawDb } = await import("@friday/shared");

    const FIVE_HOURS = 5 * 60 * 60 * 1000;
    const { worker } = makeFakeWorker({
      turnId: "turn-stale-old",
      turnStart: Date.now() - FIVE_HOURS,
    });
    __putLiveWorkerForTest("stale-agent", worker as never);

    const captured: CapturedEvent[] = [];
    const unsub = eventBus.subscribe((e) => captured.push(e as CapturedEvent));

    const logSpy = vi.spyOn(logger, "log");

    // Heartbeats are a valid trigger per the proposal — any inbound IPC
    // gives the daemon a chance to notice the wedge.
    handleEvent(worker as never, { type: "heartbeat" });
    unsub();

    // Structured log emitted with exact event name + agentId + msSinceTurnStart.
    const staleLog = logSpy.mock.calls.find(
      ([, event]) => event === "worker.turn.stale-killed",
    );
    expect(staleLog).toBeDefined();
    const [level, , payload] = staleLog!;
    expect(level).toBe("warn");
    const p = payload as { agentId: string; msSinceTurnStart: number; turnId: string };
    expect(p.agentId).toBe("stale-agent");
    expect(p.turnId).toBe("turn-stale-old");
    expect(p.msSinceTurnStart).toBeGreaterThanOrEqual(FIVE_HOURS);

    // Force-kill ran: error block persisted with turn_timed_out code.
    const rows = getRawDb()
      .prepare("SELECT content_json, kind FROM blocks WHERE turn_id = ?")
      .all("turn-stale-old") as Array<{ content_json: string; kind: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe("error");
    const errPayload = JSON.parse(rows[0].content_json) as { code: string; headline: string };
    expect(errPayload.code).toBe("turn_timed_out");
    expect(errPayload.headline).toContain("Turn timed out");

    // turn_done emitted with status=error (timed-out, not a clean abort).
    const done = captured.find((e) => e.type === "turn_done" && e.turn_id === "turn-stale-old");
    expect(done).toBeDefined();
    expect(done!.status).toBe("error");

    // Worker is now marked force-killed so subsequent IPC is ignored.
    expect((worker as { forceKilled?: boolean }).forceKilled).toBe(true);

    __deleteLiveWorkerForTest("stale-agent");
  });

  it("does NOT force-kill when msSinceTurnStart is well under the ceiling", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { logger } = await import("../log.js");

    const { worker } = makeFakeWorker({
      turnId: "turn-fresh",
      turnStart: Date.now() - 60_000, // 1 minute in
    });
    __putLiveWorkerForTest("stale-agent", worker as never);

    const logSpy = vi.spyOn(logger, "log");
    handleEvent(worker as never, { type: "heartbeat" });

    expect(
      logSpy.mock.calls.find(([, event]) => event === "worker.turn.stale-killed"),
    ).toBeUndefined();
    expect((worker as { forceKilled?: boolean }).forceKilled).toBeFalsy();

    __deleteLiveWorkerForTest("stale-agent");
  });

  it("ceiling check is idempotent: a second IPC after force-kill does not re-fire", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { logger } = await import("../log.js");

    const { worker } = makeFakeWorker({
      turnId: "turn-stale-idem",
      turnStart: Date.now() - 10 * 60 * 60 * 1000, // 10h
    });
    __putLiveWorkerForTest("stale-agent", worker as never);

    const logSpy = vi.spyOn(logger, "log");
    handleEvent(worker as never, { type: "heartbeat" });
    handleEvent(worker as never, { type: "heartbeat" });
    handleEvent(worker as never, {
      type: "status-change",
      status: "idle",
    });

    const staleLogs = logSpy.mock.calls.filter(
      ([, event]) => event === "worker.turn.stale-killed",
    );
    expect(staleLogs.length).toBe(1);

    __deleteLiveWorkerForTest("stale-agent");
  });
});

describe("lifecycle: IPC handler error boundary (FRI-33)", () => {
  it("logs worker.ipc.error and does not rethrow when status-change handling throws", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const { eventBus } = await import("../events/bus.js");
    const { logger } = await import("../log.js");

    const { worker } = makeFakeWorker({ turnId: "turn-ipc-err" });
    __putLiveWorkerForTest("stale-agent", worker as never);

    // Force the inner `eventBus.publish` to throw on the agent_status emit.
    // This simulates a downstream subscriber blowing up (the real-world
    // crash shape: any sync exception in publish() bubbles out of
    // child.on("message") into Node's default uncaughtException handler).
    const publishSpy = vi.spyOn(eventBus, "publish").mockImplementation(((e: unknown) => {
      const ev = e as { type?: string };
      if (ev.type === "agent_status") {
        throw new Error("synthetic publish failure");
      }
    }) as never);

    const logSpy = vi.spyOn(logger, "log");

    // Must NOT throw.
    expect(() =>
      handleEvent(worker as never, {
        type: "status-change",
        // Cast through unknown so we can feed a deliberately-malformed payload
        // shape past TS without disabling type checking globally.
        status: "working",
      }),
    ).not.toThrow();

    const ipcErr = logSpy.mock.calls.find(
      ([, event]) => event === "worker.ipc.error",
    );
    expect(ipcErr).toBeDefined();
    const [level, , payload] = ipcErr!;
    expect(level).toBe("error");
    const p = payload as { agentId: string; type: string; err: string };
    expect(p.agentId).toBe("stale-agent");
    expect(p.type).toBe("status-change");
    expect(p.err).toContain("synthetic publish failure");

    publishSpy.mockRestore();
    __deleteLiveWorkerForTest("stale-agent");
  });
});
