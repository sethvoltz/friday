/**
 * FRI-145 M5 — `stalled` Status projection (AC #7, AC #8).
 *
 * REGRESSION: before this milestone NOTHING in daemon+shared wrote
 * `agents.status="stalled"` (the `agent_status` SSE was retired in Phase 5,
 * leaving the dashboard's warn-colored dot a dead consumer). M5 restores the
 * producer: the per-agent watchdog enqueues a `stall` Transition, and the
 * Turn-state machine projects `stalled` through the single DB door.
 *
 * These are stateful, layer-correct tests: they drive the REAL `stallAgent`
 * lifecycle producer AND the REAL watchdog `tick` control flow against the real
 * live map + a real test Postgres, so the durable `agents.status` write is
 * observable on the actual row. The collaborator `registry.setStatus` is spied
 * to pin the exact `(name, "stalled")` call; the row read pins the durable
 * post-state. Nothing under test is mocked.
 *
 * AC #7's failing-first premise: this `(name, "stalled")` write does not exist
 * on `main` (no producer), so the assertion is red there and green here.
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle, writeConfig, loadConfig } from "@friday/shared";

let handle: TestDbHandle;
let lifecycle: typeof import("./lifecycle.js");
let registry: typeof import("./registry.js");
let watchdog: typeof import("./watchdog.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_stalled" });
  lifecycle = await import("./lifecycle.js");
  registry = await import("./registry.js");
  watchdog = await import("./watchdog.js");
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  vi.restoreAllMocks();
  watchdog.__resetFlaggedForTest();
});

afterEach(() => {
  // Drop any synthetic live workers so they don't leak across cases.
  for (const name of lifecycle.liveAgentNames()) {
    lifecycle.__deleteLiveWorkerForTest(name);
  }
});

interface FakeChild {
  send: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  killed: boolean;
  pid?: number;
}

function makeFakeWorker(overrides: Record<string, unknown> = {}): unknown {
  const child: FakeChild = { send: vi.fn(), exitCode: null, killed: false, pid: 0 };
  return {
    child,
    pgid: 0,
    agentName: "stalled-agent",
    agentType: "builder",
    model: "claude-opus-4-7",
    turnId: "turn-stall-1",
    sessionId: "sess-stall-1",
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
    blocksThisTurn: 0,
    zeroBlockTurnStreak: 0,
    mailSendToParentThisTurn: 0,
    noMailBackNudgedThisTurn: false,
    noMailBackStreak: 0,
    ...overrides,
  };
}

describe("FRI-145 M5: stalled Status projection (AC #7)", () => {
  it("stallAgent projects agents.status='stalled' via the single DB door", async () => {
    const NAME = "stalled-direct";
    await registry.registerAgent({ name: NAME, type: "builder", parentName: "friday" });
    await registry.setStatus(NAME, "working");
    const w = makeFakeWorker({ agentName: NAME, status: "working" });
    lifecycle.__putLiveWorkerForTest(NAME, w as never);

    const setStatusSpy = vi.spyOn(registry, "setStatus");

    await lifecycle.stallAgent(NAME);

    // The load-bearing producer guard: the Turn-state machine wrote
    // `(name, "stalled")` through registry.setStatus (the only DB door).
    expect(setStatusSpy).toHaveBeenCalledWith(NAME, "stalled");
    // Durable post-state — the row actually reads `stalled`.
    expect((await registry.getAgent(NAME))?.status).toBe("stalled");
  });

  it("a stall enqueued against a Generation superseded BEFORE it drains is a no-op", async () => {
    const NAME = "stalled-superseded";
    // gen-A is the live worker the watchdog observes when it enqueues the stall.
    await registry.registerAgent({ name: NAME, type: "builder", parentName: "friday" });
    await registry.setStatus(NAME, "working");
    const genA = makeFakeWorker({ agentName: NAME, turnId: "turn-genA", status: "working" });
    lifecycle.__putLiveWorkerForTest(NAME, genA as never);

    const setStatusSpy = vi.spyOn(registry, "setStatus");

    // Enqueue the stall (captures genA) but DON'T await yet — then supersede:
    // a refork/replacement swaps gen-A out for gen-B before the queued closure
    // runs. The closure's `isCurrentGeneration(genA)` re-check must no-op so a
    // stale `stalled` doesn't clobber gen-B's `working`. This is the V2
    // Generation no-op interleaving (stale producer arrives post-supersession).
    const pending = lifecycle.stallAgent(NAME);
    lifecycle.__deleteLiveWorkerForTest(NAME); // genA demoted
    const genB = makeFakeWorker({ agentName: NAME, turnId: "turn-genB", status: "working" });
    lifecycle.__putLiveWorkerForTest(NAME, genB as never); // genB is now current
    await pending;

    // The stale stall against genA wrote NO `stalled` projection.
    expect(setStatusSpy).not.toHaveBeenCalledWith(NAME, "stalled");
    // Durable projection unchanged — still `working` (genB is live, untouched).
    expect((await registry.getAgent(NAME))?.status).toBe("working");
  });

  it("stallAgent is a no-op when the agent isn't live (worker already exited)", async () => {
    const NAME = "stalled-offline";
    await registry.registerAgent({ name: NAME, type: "builder", parentName: "friday" });
    await registry.setStatus(NAME, "working");
    // No live worker inserted.
    const setStatusSpy = vi.spyOn(registry, "setStatus");

    await lifecycle.stallAgent(NAME);

    // No live worker → no stall flag to set; the row stays `working` (the exit
    // handler, not the stall flag, owns the resting projection of a dead worker).
    expect(setStatusSpy).not.toHaveBeenCalledWith(NAME, "stalled");
    expect((await registry.getAgent(NAME))?.status).toBe("working");
  });
});

describe("FRI-145 M5: watchdog tick → stall producer (AC #7 end-to-end)", () => {
  it("a working worker past its heartbeat budget gets agents.status='stalled'", async () => {
    const NAME = "stalled-watchdog";
    // Disable refork so the tick projects `stalled` WITHOUT tearing down the
    // worker — isolates the stalled-producer behavior the AC pins.
    const cfg = loadConfig();
    writeConfig({ ...cfg, watchdog: { ...cfg.watchdog, refork: false } });

    await registry.registerAgent({ name: NAME, type: "builder", parentName: "friday" });
    await registry.setStatus(NAME, "working");

    // lastHeartbeat far in the past → blows the builder stall threshold.
    const w = makeFakeWorker({
      agentName: NAME,
      status: "working",
      lastHeartbeat: Date.now() - 2 * 60 * 60 * 1000, // 2h ago
    });
    lifecycle.__putLiveWorkerForTest(NAME, w as never);

    const setStatusSpy = vi.spyOn(registry, "setStatus");

    // Drive ONE real watchdog tick (stall detect → fire-and-forget stallAgent).
    watchdog.__tickForTest();
    // The stall enqueue is fire-and-forget (V3 — never awaited inside the tick);
    // drain the microtask + transition queue before asserting the durable write.
    await vi.waitFor(async () => {
      expect((await registry.getAgent(NAME))?.status).toBe("stalled");
    });

    expect(setStatusSpy).toHaveBeenCalledWith(NAME, "stalled");
    // Reset config to default for other suites in this worker.
    writeConfig(cfg);
  });

  it("an idle (mail-waiting) worker is NOT flagged stalled", async () => {
    const NAME = "stalled-idle-skip";
    const cfg = loadConfig();
    writeConfig({ ...cfg, watchdog: { ...cfg.watchdog, refork: false } });

    await registry.registerAgent({ name: NAME, type: "builder", parentName: "friday" });
    await registry.setStatus(NAME, "idle");

    // Idle worker with a stale heartbeat — idle is explicitly NOT a stall.
    const w = makeFakeWorker({
      agentName: NAME,
      status: "idle",
      lastHeartbeat: Date.now() - 2 * 60 * 60 * 1000,
    });
    lifecycle.__putLiveWorkerForTest(NAME, w as never);

    const setStatusSpy = vi.spyOn(registry, "setStatus");
    watchdog.__tickForTest();
    // Give any erroneous enqueue a chance to run.
    await new Promise((r) => setTimeout(r, 50));

    expect(setStatusSpy).not.toHaveBeenCalledWith(NAME, "stalled");
    expect((await registry.getAgent(NAME))?.status).toBe("idle");
    writeConfig(cfg);
  });
});
