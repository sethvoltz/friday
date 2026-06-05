import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

/**
 * Mail-triggered turn status tracking.
 *
 * When a live agent receives a `mail-wakeup` IPC the daemon wakes the worker
 * without calling sendPrompt/spawnTurn, so neither of those paths writes
 * "working" to the registry. The worker discovers mail in its own inbox,
 * calls runQuery, and emits `status-change: working` — that IPC event must
 * also mirror the transition to the DB so Zero can replicate it to the
 * dashboard (activity dot + wake lock).
 *
 * Stateful test at the right layer: the bug lived at the boundary between the
 * mail-wakeup path and the DB, so we exercise handleEvent with a registered
 * agent and assert registry.status after each IPC event.
 */

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_mail_status" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

/**
 * FRI-151: the default `lastBlockStop` is intentionally stale (2h ago, well
 * beyond the 30-min stall threshold). The previous default of `Date.now()`
 * silently masked the bug class where the worker-internal mail-fetch path
 * (FRI-127) drives idle→working without invoking the FRI-58 reset inside
 * `sendPrompt`, leaving the watchdog measuring against the previous turn's
 * end and SIGTERMing the worker. Tests that need a fresh value must opt in
 * explicitly via `overrides`.
 */
const STALE_LAST_BLOCK_STOP_MS = 2 * 60 * 60 * 1000;

function makeFakeWorker(agentName: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    child: { send: () => {} },
    pgid: 0,
    agentName,
    agentType: "bare",
    model: "claude-sonnet-4-6",
    turnId: `t_mail_${agentName}`,
    sessionId: `sess_${agentName}`,
    workingDirectory: `/tmp/${agentName}`,
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: undefined,
    spawnedAt: Date.now() - 1000,
    lastBlockStop: Date.now() - STALE_LAST_BLOCK_STOP_MS,
    turnState: "idle",
    status: "idle",
    nextPrompts: [],
    mode: "long-lived",
    lastExitStatus: "complete",
    completedAtLeastOnce: true,
    blocksThisTurn: 0,
    illegalTransitionsThisTurn: 0,
    zeroBlockTurnStreak: 0,
    mailSendToParentThisTurn: 0,
    noMailBackNudgedThisTurn: false,
    noMailBackStreak: 0,
    ...overrides,
  };
}

describe("status-change IPC mirrors to DB for mail-triggered turns", () => {
  // FRI-145 M2: the status-change / turn-complete cases now gate on the
  // Generation rule (`isCurrentGeneration(w)`) before writing the durable
  // Status projection — a superseded worker must not clobber `agents.status`.
  // The realistic mail-wakeup state is a LIVE worker, so each test registers
  // it in the live map; otherwise the projection write would be skipped.
  it("bare agent: status-change:working (mail path, no prior sendPrompt) transitions DB idle→working", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const registry = await import("./registry.js");

    await registry.registerAgent({ name: "mail-bare-1", type: "bare" });
    expect((await registry.getAgent("mail-bare-1"))?.status).toBe("idle");

    const worker = makeFakeWorker("mail-bare-1");
    __putLiveWorkerForTest("mail-bare-1", worker as never);

    // Simulate what happens when the worker wakes from mail-wakeup and
    // starts runQuery: it emits status-change:working with no prior
    // sendPrompt call from the daemon.
    await handleEvent(worker as never, { type: "status-change", status: "working" });

    expect((await registry.getAgent("mail-bare-1"))?.status).toBe("working");
    __deleteLiveWorkerForTest("mail-bare-1");
  });

  it("bare agent: turn-complete after mail-triggered turn transitions DB working→idle", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const registry = await import("./registry.js");

    await registry.registerAgent({ name: "mail-bare-2", type: "bare" });
    // Seed the DB as working (simulating the state after status-change:working
    // was processed with the fix applied).
    await registry.setStatus("mail-bare-2", "working");

    const worker = makeFakeWorker("mail-bare-2", {
      status: "working",
      turnStart: Date.now() - 500,
    });
    __putLiveWorkerForTest("mail-bare-2", worker as never);

    await handleEvent(worker as never, {
      type: "turn-complete",
      sessionId: "sess_mail-bare-2",
    });

    expect((await registry.getAgent("mail-bare-2"))?.status).toBe("idle");
    __deleteLiveWorkerForTest("mail-bare-2");
  });

  it("full mail-triggered turn cycle: idle→working→idle mirrors to DB", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const registry = await import("./registry.js");

    await registry.registerAgent({ name: "mail-bare-3", type: "bare" });
    expect((await registry.getAgent("mail-bare-3"))?.status).toBe("idle");

    const worker = makeFakeWorker("mail-bare-3") as { status: string; turnStart?: number };
    __putLiveWorkerForTest("mail-bare-3", worker as never);

    // Phase 1: worker wakes from mail-wakeup, starts runQuery.
    await handleEvent(worker as never, { type: "status-change", status: "working" });
    expect((await registry.getAgent("mail-bare-3"))?.status).toBe("working");

    // Phase 2: worker completes the turn.
    worker.status = "working";
    worker.turnStart = Date.now() - 500;
    await handleEvent(worker as never, {
      type: "turn-complete",
      sessionId: "sess_mail-bare-3",
    });
    expect((await registry.getAgent("mail-bare-3"))?.status).toBe("idle");
    __deleteLiveWorkerForTest("mail-bare-3");
  });

  it("dispatch-initiated turn: status-change:working is idempotent when DB already shows working", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const registry = await import("./registry.js");

    await registry.registerAgent({ name: "mail-builder-1", type: "builder", parentName: "friday" });
    // sendPrompt already wrote "working" — simulate that.
    await registry.setStatus("mail-builder-1", "working");

    const worker = makeFakeWorker("mail-builder-1", {
      agentType: "builder",
      status: "working",
      turnStart: Date.now() - 100,
    });
    __putLiveWorkerForTest("mail-builder-1", worker as never);

    // Worker emits status-change:working (from runQuery), same as it does for
    // all turns. With the fix, this calls registry.setStatus("working") again.
    // working→working is a legal same-status write (no-op per FSM) so it must
    // not throw and the row must remain "working".
    await handleEvent(worker as never, { type: "status-change", status: "working" });

    expect((await registry.getAgent("mail-builder-1"))?.status).toBe("working");
    __deleteLiveWorkerForTest("mail-builder-1");
  });
});

/**
 * FRI-151: the worker-internal mail-fetch path (FRI-127) drives a turn without
 * calling sendPrompt on the daemon side, so the FRI-58 lastBlockStop/turnStart
 * reset (which lives inside sendPrompt) never fires for mail-driven wakes.
 * After >30 min idle, the next watchdog tick measures the stalled-window
 * against the previous turn's turn-complete and SIGTERMs the worker before any
 * block-stop can refresh the bookkeeping.
 *
 * This suite pins the full interleaving: pre-fix watchdog SIGTERMs against a
 * stale `lastBlockStop`; the `status-change:working` IPC handler resets the
 * field on idle→working; the same watchdog logic against the post-reset value
 * does not SIGTERM. The pre-fix assertion is load-bearing — it would also fire
 * if anyone loosened the watchdog without removing this guard.
 */
describe("FRI-151: idle→working from worker-internal mail path resets watchdog bookkeeping", () => {
  it("status-change idle→working resets lastBlockStop+turnStart; watchdog tick no longer SIGTERMs", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest, checkStalledWorkers } =
      await import("./lifecycle.js");
    const registry = await import("./registry.js");

    await registry.registerAgent({ name: "mail-stale-1", type: "bare" });

    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const THIRTY_MIN_MS = 30 * 60 * 1000;
    const FAKE_PGID = 424242;
    const staleLastBlockStop = Date.now() - TWO_HOURS_MS;

    const worker = makeFakeWorker("mail-stale-1", {
      pgid: FAKE_PGID,
      status: "idle",
      turnState: "idle",
      turnStart: undefined,
      lastBlockStop: staleLastBlockStop,
    }) as { lastBlockStop: number; turnStart: number | undefined; status: string };
    __putLiveWorkerForTest("mail-stale-1", worker as never);

    // Pre-fix sanity: with the worker treated as `working` against the same
    // stale lastBlockStop the daemon actually had at 17:35:30 in the observed
    // bug, the watchdog SIGTERMs. Pins the failure mode so this test fails
    // loudly if the watchdog ever stops checking lastBlockStop without the
    // reset being removed too.
    const preKills: number[] = [];
    const preTerminated = checkStalledWorkers(
      [
        {
          agentName: "mail-stale-1",
          turnId: "t_old",
          pgid: FAKE_PGID,
          status: "working",
          lastBlockStop: staleLastBlockStop,
        },
      ],
      Date.now(),
      THIRTY_MIN_MS,
      (pgid) => preKills.push(pgid),
    );
    expect(preTerminated).toEqual(["mail-stale-1"]);
    expect(preKills).toEqual([FAKE_PGID]);

    // Drive the actual fix path: the worker emits status-change:working when
    // runQuery starts on the mail-fetch wake. With the fix, the handler resets
    // the watchdog bookkeeping before the next tick can fire.
    const beforeReset = Date.now();
    await handleEvent(worker as never, { type: "status-change", status: "working" });
    const afterReset = Date.now();

    expect(worker.status).toBe("working");
    expect(worker.lastBlockStop).toBeGreaterThanOrEqual(beforeReset);
    expect(worker.lastBlockStop).toBeLessThanOrEqual(afterReset);
    expect(worker.turnStart).toBeGreaterThanOrEqual(beforeReset);
    expect(worker.turnStart).toBeLessThanOrEqual(afterReset);

    // Post-fix: the next watchdog tick measures since=~0 against the threshold
    // and does NOT kill.
    const postKills: number[] = [];
    const postTerminated = checkStalledWorkers(
      [
        {
          agentName: "mail-stale-1",
          turnId: "t_new",
          pgid: FAKE_PGID,
          status: "working",
          lastBlockStop: worker.lastBlockStop,
        },
      ],
      Date.now(),
      THIRTY_MIN_MS,
      (pgid) => postKills.push(pgid),
    );
    expect(postTerminated).toEqual([]);
    expect(postKills).toEqual([]);

    __deleteLiveWorkerForTest("mail-stale-1");
  });

  it("dispatcher path (working→working same-status IPC) does NOT re-reset bookkeeping", async () => {
    // sendPrompt has already set status=working AND reset lastBlockStop on
    // its own; the subsequent status-change:working IPC from runQuery must
    // not stomp the dispatcher's freshly-set values. The guard is `wasIdle`,
    // and this test pins it.
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const registry = await import("./registry.js");

    await registry.registerAgent({
      name: "mail-dispatch-1",
      type: "builder",
      parentName: "friday",
    });
    await registry.setStatus("mail-dispatch-1", "working");

    // Simulate the post-sendPrompt snapshot: status already "working" and
    // lastBlockStop+turnStart already freshly stamped by FRI-58's reset. We
    // pick distinctive recent values (offset by an odd number of ms so a
    // bug that overwrote them with Date.now() would change them) and assert
    // they survive the IPC handler unchanged. Values must be recent enough
    // not to trip the FRI-33 4h stale-turn ceiling at `handleEvent`'s top.
    const SENTINEL_LAST_BLOCK_STOP = Date.now() - 1234;
    const SENTINEL_TURN_START = Date.now() - 5678;
    const worker = makeFakeWorker("mail-dispatch-1", {
      agentType: "builder",
      status: "working",
      turnState: "working",
      lastBlockStop: SENTINEL_LAST_BLOCK_STOP,
      turnStart: SENTINEL_TURN_START,
    }) as { lastBlockStop: number; turnStart: number | undefined };
    __putLiveWorkerForTest("mail-dispatch-1", worker as never);

    await handleEvent(worker as never, { type: "status-change", status: "working" });

    expect(worker.lastBlockStop).toBe(SENTINEL_LAST_BLOCK_STOP);
    expect(worker.turnStart).toBe(SENTINEL_TURN_START);

    __deleteLiveWorkerForTest("mail-dispatch-1");
  });
});

/**
 * FRI-151 F1: the worker-internal mail-fetch path mints a fresh `turnId`
 * worker-side (`worker.ts` mainLoop → `t_${randomUUID()}`). Before this fix the
 * `status-change` IPC didn't carry that id, so the daemon's `w.turnId` stayed
 * pinned to the previous turn for the entire mail-driven turn, mis-attributing
 * every per-turn payload (block-start / block-stop / usage / SSE / stall log)
 * to the wrong id. The IPC now carries the optional `turnId`; the daemon
 * refreshes `w.turnId` on the idle→working edge.
 */
describe("FRI-151 F1: status-change idle→working refreshes w.turnId from IPC payload", () => {
  it("mail-wake: status-change with new turnId updates w.turnId; previous id is overwritten", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const registry = await import("./registry.js");

    await registry.registerAgent({ name: "mail-turnid-1", type: "bare" });

    const PREV_TURN_ID = "t_prev_turn_long_completed";
    const NEW_TURN_ID = "t_mail_minted_by_worker";

    const worker = makeFakeWorker("mail-turnid-1", {
      status: "idle",
      turnState: "idle",
      turnId: PREV_TURN_ID,
    }) as { turnId: string };
    __putLiveWorkerForTest("mail-turnid-1", worker as never);

    await handleEvent(worker as never, {
      type: "status-change",
      status: "working",
      turnId: NEW_TURN_ID,
    });

    expect(worker.turnId).toBe(NEW_TURN_ID);

    __deleteLiveWorkerForTest("mail-turnid-1");
  });

  it("mail-wake: status-change without a turnId leaves w.turnId untouched (back-compat with pre-protocol workers)", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const registry = await import("./registry.js");

    await registry.registerAgent({ name: "mail-turnid-2", type: "bare" });

    const PREV_TURN_ID = "t_prev_no_protocol_upgrade";
    const worker = makeFakeWorker("mail-turnid-2", {
      status: "idle",
      turnState: "idle",
      turnId: PREV_TURN_ID,
    }) as { turnId: string; lastBlockStop: number };
    __putLiveWorkerForTest("mail-turnid-2", worker as never);

    const before = Date.now();
    await handleEvent(worker as never, { type: "status-change", status: "working" });

    // turnId stays put — the optional field is the only way to refresh it.
    expect(worker.turnId).toBe(PREV_TURN_ID);
    // But the bookkeeping reset still fires — pre-protocol workers still get
    // the watchdog-safety guarantee even though their stall logs misattribute.
    expect(worker.lastBlockStop).toBeGreaterThanOrEqual(before);

    __deleteLiveWorkerForTest("mail-turnid-2");
  });

  it("dispatcher path: status-change with turnId does not double-refresh (wasIdle gate covers turnId too)", async () => {
    const { handleEvent, __putLiveWorkerForTest, __deleteLiveWorkerForTest } =
      await import("./lifecycle.js");
    const registry = await import("./registry.js");

    await registry.registerAgent({
      name: "mail-turnid-3",
      type: "builder",
      parentName: "friday",
    });
    await registry.setStatus("mail-turnid-3", "working");

    const DISPATCHER_TURN_ID = "t_already_set_by_sendPrompt";
    const REDUNDANT_TURN_ID = "t_redundant_from_runQuery";

    const worker = makeFakeWorker("mail-turnid-3", {
      agentType: "builder",
      status: "working",
      turnState: "working",
      turnId: DISPATCHER_TURN_ID,
      lastBlockStop: Date.now() - 1234,
      turnStart: Date.now() - 5678,
    }) as { turnId: string };
    __putLiveWorkerForTest("mail-turnid-3", worker as never);

    // wasIdle=false (status was already "working" from sendPrompt) → gate
    // skips the entire reset block including the turnId refresh, so the
    // dispatcher's id wins. Same idempotency property as lastBlockStop /
    // turnStart in the existing dispatcher test.
    await handleEvent(worker as never, {
      type: "status-change",
      status: "working",
      turnId: REDUNDANT_TURN_ID,
    });

    expect(worker.turnId).toBe(DISPATCHER_TURN_ID);

    __deleteLiveWorkerForTest("mail-turnid-3");
  });
});

/**
 * FRI-151 NIT-1/NIT-2: cross-boundary integration. The helper-direct tests
 * above pin the watchdog logic in isolation; these pin the actual interleaving
 * the production bug hit — the REAL `setInterval` watchdog firing against the
 * REAL `live` map iterator while a real `status-change` IPC mutates the
 * worker's bookkeeping. Fake timers drive the interval; a `process.kill` spy
 * intercepts `killPgrp`'s underlying syscall so we observe the SIGTERM (or its
 * absence) without nuking a real pgrp.
 *
 * Both tests build a worker with `lastBlockStop = now - 2h`. The pre-fix test
 * pins the failure mode (real watchdog tick → real SIGTERM); the post-fix
 * test pins the recovery (real `status-change` IPC → real bookkeeping reset
 * → real watchdog tick → NO SIGTERM).
 */
describe("FRI-151 NIT-1/NIT-2: cross-boundary integration (real setInterval + real live map + process.kill spy)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pre-fix sanity: real setInterval tick SIGTERMs a worker with stale lastBlockStop and status=working", async () => {
    const {
      __putLiveWorkerForTest,
      __deleteLiveWorkerForTest,
      startTurnStallWatchdog,
      stopTurnStallWatchdog,
    } = await import("./lifecycle.js");
    const registry = await import("./registry.js");

    await registry.registerAgent({ name: "wd-pre-1", type: "bare" });

    const FAKE_PGID = 818181;
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

    const worker = makeFakeWorker("wd-pre-1", {
      pgid: FAKE_PGID,
      status: "working",
      turnState: "working",
      lastBlockStop: Date.now() - TWO_HOURS_MS,
    });
    __putLiveWorkerForTest("wd-pre-1", worker as never);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      startTurnStallWatchdog();
      // TURN_STALL_CHECK_MS = 60_000; one tick past it fires the callback.
      await vi.advanceTimersByTimeAsync(60_001);

      const sigtermCalls = killSpy.mock.calls.filter(
        (c) => c[0] === -FAKE_PGID && c[1] === "SIGTERM",
      );
      expect(sigtermCalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      stopTurnStallWatchdog();
      __deleteLiveWorkerForTest("wd-pre-1");
    }
  });

  it("post-fix: status-change idle→working reset prevents the SIGTERM the watchdog tick would have fired", async () => {
    const {
      handleEvent,
      __putLiveWorkerForTest,
      __deleteLiveWorkerForTest,
      startTurnStallWatchdog,
      stopTurnStallWatchdog,
    } = await import("./lifecycle.js");
    const registry = await import("./registry.js");

    await registry.registerAgent({ name: "wd-post-1", type: "bare" });

    const FAKE_PGID = 828282;
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

    const worker = makeFakeWorker("wd-post-1", {
      pgid: FAKE_PGID,
      status: "idle",
      turnState: "idle",
      lastBlockStop: Date.now() - TWO_HOURS_MS,
    });
    __putLiveWorkerForTest("wd-post-1", worker as never);

    // The mail-wake fix path runs under real timers — `registry.setStatus`
    // issues a real PG query that we don't want to interleave with the fake
    // clock. After the IPC settles, we switch to fake timers and drive the
    // real watchdog interval forward.
    await handleEvent(worker as never, {
      type: "status-change",
      status: "working",
      turnId: "t_wd_post_1_new",
    });

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      startTurnStallWatchdog();
      await vi.advanceTimersByTimeAsync(60_001);

      const sigtermCalls = killSpy.mock.calls.filter(
        (c) => c[0] === -FAKE_PGID && c[1] === "SIGTERM",
      );
      expect(sigtermCalls).toEqual([]);
    } finally {
      stopTurnStallWatchdog();
      __deleteLiveWorkerForTest("wd-post-1");
    }
  });
});
