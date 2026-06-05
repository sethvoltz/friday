import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDbHandle } from "@friday/shared";

/**
 * FRI-154 respawn-orphan-mail unit tests.
 *
 * Pins each load-bearing behavior with exact assertions:
 *   - The anti-loop gate trips at exactly `RESPAWN_MAX_ATTEMPTS` and
 *     dead-letters (NOT a 4th respawn).
 *   - Backoff progression matches `2^attempts * base, capped`.
 *   - `noteTurnComplete` resets the counter so a long-lived agent that
 *     survived earlier respawns doesn't dead-letter on the next unrelated
 *     death (FRI-154 §"Anti-loop reset condition" in the implementation plan).
 *   - Dead-letter event shape matches the FRI-154 spec.
 *   - The sentinel is persisted into `mail.meta_json.dead_letter`.
 *   - Back-to-back force-kills are idempotent (one timer, not two).
 *
 * Tests at the layer the bug can live in: the in-memory tracker map +
 * dispatch decision. The lifecycle wiring (the `child.on("exit")` hook) is
 * exercised separately in `lifecycle-respawn-on-exit.test.ts`.
 */

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "respawn_orphan_mail" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

afterEach(async () => {
  const mod = await import("./respawn-orphan-mail.js");
  mod.__resetForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("decideRespawn (pure)", () => {
  const baseCfg = {
    maxAttempts: 3,
    windowMs: 10 * 60 * 1000,
    backoffBaseMs: 1_000,
    backoffCapMs: 30_000,
  };

  it("skips when the agent is already live", async () => {
    const { decideRespawn } = await import("./respawn-orphan-mail.js");
    expect(
      decideRespawn({
        now: 1_000_000,
        isLive: true,
        isArchived: false,
        unprocessedCount: 5,
        tracker: null,
        config: baseCfg,
        lastSuccessfulTurnCompleteAt: null,
      }),
    ).toEqual({ kind: "skip", reason: "agent-live" });
  });

  it("skips when the agent is archived", async () => {
    const { decideRespawn } = await import("./respawn-orphan-mail.js");
    expect(
      decideRespawn({
        now: 1_000_000,
        isLive: false,
        isArchived: true,
        unprocessedCount: 5,
        tracker: null,
        config: baseCfg,
        lastSuccessfulTurnCompleteAt: null,
      }),
    ).toEqual({ kind: "skip", reason: "agent-archived" });
  });

  it("skips when a respawn timer is already pending (idempotent against back-to-back kills)", async () => {
    const { decideRespawn } = await import("./respawn-orphan-mail.js");
    const fakeTimer = setTimeout(() => {}, 1_000_000) as NodeJS.Timeout;
    fakeTimer.unref();
    try {
      expect(
        decideRespawn({
          now: 1_000_000,
          isLive: false,
          isArchived: false,
          unprocessedCount: 5,
          tracker: { attempts: 1, firstAttemptAt: 999_000, pendingTimer: fakeTimer },
          config: baseCfg,
          lastSuccessfulTurnCompleteAt: null,
        }),
      ).toEqual({ kind: "skip", reason: "timer-pending" });
    } finally {
      clearTimeout(fakeTimer);
    }
  });

  it("skips when unprocessed mail count is zero", async () => {
    const { decideRespawn } = await import("./respawn-orphan-mail.js");
    expect(
      decideRespawn({
        now: 1_000_000,
        isLive: false,
        isArchived: false,
        unprocessedCount: 0,
        tracker: null,
        config: baseCfg,
        lastSuccessfulTurnCompleteAt: null,
      }),
    ).toEqual({ kind: "skip", reason: "no-unprocessed-mail" });
  });

  it("skips when the agent has been dead-lettered", async () => {
    const { decideRespawn } = await import("./respawn-orphan-mail.js");
    expect(
      decideRespawn({
        now: 1_000_000,
        isLive: false,
        isArchived: false,
        unprocessedCount: 5,
        tracker: { attempts: 3, firstAttemptAt: 990_000, deadLetteredAt: 995_000 },
        config: baseCfg,
        lastSuccessfulTurnCompleteAt: null,
      }),
    ).toEqual({ kind: "skip", reason: "dead-lettered" });
  });

  it("schedules at base delay on first attempt (attempts=0 → 1s)", async () => {
    const { decideRespawn } = await import("./respawn-orphan-mail.js");
    expect(
      decideRespawn({
        now: 1_000_000,
        isLive: false,
        isArchived: false,
        unprocessedCount: 1,
        tracker: null,
        config: baseCfg,
        lastSuccessfulTurnCompleteAt: null,
      }),
    ).toEqual({ kind: "schedule", delayMs: 1_000, attemptsAfter: 1 });
  });

  it("schedules at 2x delay on second attempt", async () => {
    const { decideRespawn } = await import("./respawn-orphan-mail.js");
    expect(
      decideRespawn({
        now: 1_000_000,
        isLive: false,
        isArchived: false,
        unprocessedCount: 1,
        tracker: { attempts: 1, firstAttemptAt: 990_000 },
        config: baseCfg,
        lastSuccessfulTurnCompleteAt: null,
      }),
    ).toEqual({ kind: "schedule", delayMs: 2_000, attemptsAfter: 2 });
  });

  it("schedules at 4x delay on third attempt", async () => {
    const { decideRespawn } = await import("./respawn-orphan-mail.js");
    expect(
      decideRespawn({
        now: 1_000_000,
        isLive: false,
        isArchived: false,
        unprocessedCount: 1,
        tracker: { attempts: 2, firstAttemptAt: 990_000 },
        config: baseCfg,
        lastSuccessfulTurnCompleteAt: null,
      }),
    ).toEqual({ kind: "schedule", delayMs: 4_000, attemptsAfter: 3 });
  });

  it("backoff caps at backoffCapMs", async () => {
    const { decideRespawn } = await import("./respawn-orphan-mail.js");
    // attempts=5 → 2^5 * 1000 = 32_000 > cap 30_000
    expect(
      decideRespawn({
        now: 1_000_000,
        isLive: false,
        isArchived: false,
        unprocessedCount: 1,
        tracker: { attempts: 5, firstAttemptAt: 990_000 },
        config: { ...baseCfg, maxAttempts: 100 },
        lastSuccessfulTurnCompleteAt: null,
      }),
    ).toEqual({ kind: "schedule", delayMs: 30_000, attemptsAfter: 6 });
  });

  it("dead-letters when attempts >= maxAttempts inside the window", async () => {
    const { decideRespawn } = await import("./respawn-orphan-mail.js");
    expect(
      decideRespawn({
        now: 1_000_000,
        isLive: false,
        isArchived: false,
        unprocessedCount: 7,
        tracker: { attempts: 3, firstAttemptAt: 990_000 },
        config: baseCfg,
        lastSuccessfulTurnCompleteAt: 980_000,
      }),
    ).toEqual({
      kind: "dead-letter",
      attempts: 3,
      windowMs: 10 * 60 * 1000,
      unprocessedMailCount: 7,
      lastSuccessfulTurnCompleteAt: 980_000,
    });
  });

  it("resets streak when prior firstAttemptAt is older than the window", async () => {
    const { decideRespawn } = await import("./respawn-orphan-mail.js");
    // attempts=3 + firstAttemptAt 20 min ago → should reset to attempts=0,
    // schedule at base delay (1s), NOT dead-letter.
    const now = 1_000_000;
    expect(
      decideRespawn({
        now,
        isLive: false,
        isArchived: false,
        unprocessedCount: 1,
        tracker: { attempts: 3, firstAttemptAt: now - 20 * 60 * 1000 },
        config: baseCfg,
        lastSuccessfulTurnCompleteAt: null,
      }),
    ).toEqual({ kind: "schedule", delayMs: 1_000, attemptsAfter: 1 });
  });
});

describe("noteForceKillForRespawn — anti-loop gate end-to-end", () => {
  /**
   * The full hook running against a real DB + spy on `maybeSpawnFromMail`.
   * Exercises the in-process state machine: 3 force-kills in quick succession
   * schedule timers; the 4th force-kill (after timers fire) trips the gate
   * and dead-letters.
   */
  async function setupAgentWithMail(): Promise<void> {
    const registry = await import("../agent/registry.js");
    const { sendMail } = await import("@friday/shared/services");
    await registry.registerAgent({ name: "respawn-bare-1", type: "bare" });
    await sendMail({
      fromAgent: "user",
      toAgent: "respawn-bare-1",
      type: "message",
      body: "orphan mail #1",
    });
    await sendMail({
      fromAgent: "user",
      toAgent: "respawn-bare-1",
      type: "message",
      body: "orphan mail #2",
    });
  }

  it("third force-kill (attempts === maxAttempts) dead-letters and writes sentinel onto every pending mail row", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    await setupAgentWithMail();

    // Stub maybeSpawnFromMail to track invocations without spawning a real
    // worker. We don't assert on it firing here — that's the schedule
    // surface's job; this test pins the dead-letter branch.
    const bridgeMod = await import("./mail-bridge.js");
    const spawnSpy = vi.spyOn(bridgeMod, "maybeSpawnFromMail").mockImplementation(async () => {});

    const eventsMod = await import("../events/bus.js");
    const published: unknown[] = [];
    const sub = eventsMod.eventBus.subscribe((e) => published.push(e));

    const { noteForceKillForRespawn, __peekTrackerForTest } =
      await import("./respawn-orphan-mail.js");

    // Attempts 1, 2, 3: each force-kill schedules a respawn. We fire the
    // timer between each attempt so the previous attempt completes before
    // the next force-kill arrives (a back-to-back without firing would be
    // idempotent and short-circuit).
    for (let i = 0; i < 3; i++) {
      await noteForceKillForRespawn("respawn-bare-1", { code: null, signal: "SIGKILL" });
      await vi.runOnlyPendingTimersAsync();
    }
    expect(__peekTrackerForTest("respawn-bare-1")?.attempts).toBe(3);
    expect(__peekTrackerForTest("respawn-bare-1")?.deadLetteredAt).toBeUndefined();

    // Fourth force-kill: attempts >= maxAttempts → dead-letter.
    await noteForceKillForRespawn("respawn-bare-1", { code: null, signal: "SIGKILL" });

    const tracker = __peekTrackerForTest("respawn-bare-1");
    expect(tracker?.attempts).toBe(3);
    expect(tracker?.deadLetteredAt).toBeGreaterThan(0);
    expect(tracker?.pendingTimer).toBeUndefined();

    // The dead-letter event published with the spec'd shape.
    const dl = published.find(
      (e): e is { type: "worker.force-kill.dead-letter" } & Record<string, unknown> =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "worker.force-kill.dead-letter",
    );
    expect(dl).toMatchObject({
      v: 1,
      type: "worker.force-kill.dead-letter",
      agent: "respawn-bare-1",
      attempts: 3,
      window_ms: 10 * 60 * 1000,
      unprocessed_mail_count: 2,
      last_successful_turn_complete_at: null,
    });
    expect(typeof (dl as { ts?: unknown }).ts).toBe("number");

    // Sentinel was stamped on every pending row.
    const { inbox, isMailDeadLettered } = await import("@friday/shared/services");
    const rows = await inbox("respawn-bare-1");
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(isMailDeadLettered(r)).toBe(true);
      expect(r.meta?.dead_letter).toMatchObject({
        agent: "respawn-bare-1",
        attempts: 3,
      });
    }

    // After dead-letter, the next force-kill is a no-op (does NOT schedule
    // a fifth respawn).
    spawnSpy.mockClear();
    await noteForceKillForRespawn("respawn-bare-1", { code: null, signal: "SIGKILL" });
    expect(__peekTrackerForTest("respawn-bare-1")?.pendingTimer).toBeUndefined();
    expect(spawnSpy).not.toHaveBeenCalled();

    sub();
  });

  it("noteTurnComplete resets the tracker so the next force-kill starts at attempts=0", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    await setupAgentWithMail();

    const bridgeMod = await import("./mail-bridge.js");
    vi.spyOn(bridgeMod, "maybeSpawnFromMail").mockImplementation(async () => {});

    const { noteForceKillForRespawn, noteTurnComplete, __peekTrackerForTest } =
      await import("./respawn-orphan-mail.js");

    await noteForceKillForRespawn("respawn-bare-1", { code: null, signal: "SIGKILL" });
    await vi.runOnlyPendingTimersAsync();
    await noteForceKillForRespawn("respawn-bare-1", { code: null, signal: "SIGKILL" });
    await vi.runOnlyPendingTimersAsync();
    expect(__peekTrackerForTest("respawn-bare-1")?.attempts).toBe(2);

    // Worker finished a turn — gate clears.
    noteTurnComplete("respawn-bare-1");
    expect(__peekTrackerForTest("respawn-bare-1")).toBeNull();

    // Next force-kill starts a fresh streak (attempts=1).
    await noteForceKillForRespawn("respawn-bare-1", { code: null, signal: "SIGKILL" });
    expect(__peekTrackerForTest("respawn-bare-1")?.attempts).toBe(1);
  });

  it("back-to-back force-kills without firing the timer are idempotent (one timer, not two)", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    await setupAgentWithMail();

    const bridgeMod = await import("./mail-bridge.js");
    const spawnSpy = vi.spyOn(bridgeMod, "maybeSpawnFromMail").mockImplementation(async () => {});

    const { noteForceKillForRespawn, __peekTrackerForTest } =
      await import("./respawn-orphan-mail.js");

    await noteForceKillForRespawn("respawn-bare-1", { code: null, signal: "SIGKILL" });
    const timerA = __peekTrackerForTest("respawn-bare-1")?.pendingTimer;
    expect(timerA).toBeDefined();

    // Second kill while the timer is still pending — gate says "already
    // scheduled". The same timer reference must survive (no leak / no
    // double-fire).
    await noteForceKillForRespawn("respawn-bare-1", { code: null, signal: "SIGKILL" });
    const timerB = __peekTrackerForTest("respawn-bare-1")?.pendingTimer;
    expect(timerB).toBe(timerA);

    // One scheduled timer → one maybeSpawnFromMail call.
    await vi.runOnlyPendingTimersAsync();
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it("skips silently when there is no unprocessed mail (no timer, no dead-letter)", async () => {
    const registry = await import("../agent/registry.js");
    await registry.registerAgent({ name: "respawn-quiet-1", type: "bare" });

    const { noteForceKillForRespawn, __peekTrackerForTest } =
      await import("./respawn-orphan-mail.js");

    await noteForceKillForRespawn("respawn-quiet-1", { code: null, signal: "SIGKILL" });
    expect(__peekTrackerForTest("respawn-quiet-1")).toBeNull();
  });

  it("skips when the agent is archived (no respawn even with pending mail)", async () => {
    const registry = await import("../agent/registry.js");
    const { sendMail } = await import("@friday/shared/services");
    await registry.registerAgent({ name: "respawn-arch-1", type: "bare" });
    await sendMail({
      fromAgent: "user",
      toAgent: "respawn-arch-1",
      type: "message",
      body: "stranded after archive",
    });
    await registry.archiveAgent("respawn-arch-1", { reason: "completed" });

    const bridgeMod = await import("./mail-bridge.js");
    const spawnSpy = vi.spyOn(bridgeMod, "maybeSpawnFromMail").mockImplementation(async () => {});

    const { noteForceKillForRespawn, __peekTrackerForTest } =
      await import("./respawn-orphan-mail.js");

    await noteForceKillForRespawn("respawn-arch-1", { code: null, signal: "SIGKILL" });
    expect(__peekTrackerForTest("respawn-arch-1")).toBeNull();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("includes lastSuccessfulTurnCompleteAt in the dead-letter event when present", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    await setupAgentWithMail();

    const bridgeMod = await import("./mail-bridge.js");
    vi.spyOn(bridgeMod, "maybeSpawnFromMail").mockImplementation(async () => {});

    const eventsMod = await import("../events/bus.js");
    const published: unknown[] = [];
    const sub = eventsMod.eventBus.subscribe((e) => published.push(e));

    const { noteForceKillForRespawn, noteTurnComplete } = await import("./respawn-orphan-mail.js");

    // Stamp the success timestamp once, then force a dead-letter (NOT a
    // reset — we want the timestamp to survive the streak).
    noteTurnComplete("respawn-bare-1");
    const expectedTs = Date.now();

    for (let i = 0; i < 3; i++) {
      await noteForceKillForRespawn("respawn-bare-1", { code: null, signal: "SIGKILL" });
      await vi.runOnlyPendingTimersAsync();
    }
    await noteForceKillForRespawn("respawn-bare-1", { code: null, signal: "SIGKILL" });

    const dl = published.find(
      (e): e is Record<string, unknown> & { type: string } =>
        typeof e === "object" &&
        e !== null &&
        (e as { type?: string }).type === "worker.force-kill.dead-letter",
    );
    expect(dl?.last_successful_turn_complete_at).toBe(expectedTs);
    sub();
  });
});

describe("respawn-orphan-mail tunables via env", () => {
  it("respawnConfig reads FRIDAY_RESPAWN_* overrides", async () => {
    const { respawnConfig } = await import("./respawn-orphan-mail.js");
    const prev = {
      FRIDAY_RESPAWN_MAX_ATTEMPTS: process.env.FRIDAY_RESPAWN_MAX_ATTEMPTS,
      FRIDAY_RESPAWN_WINDOW_MS: process.env.FRIDAY_RESPAWN_WINDOW_MS,
      FRIDAY_RESPAWN_BACKOFF_BASE_MS: process.env.FRIDAY_RESPAWN_BACKOFF_BASE_MS,
      FRIDAY_RESPAWN_BACKOFF_CAP_MS: process.env.FRIDAY_RESPAWN_BACKOFF_CAP_MS,
    };
    try {
      process.env.FRIDAY_RESPAWN_MAX_ATTEMPTS = "5";
      process.env.FRIDAY_RESPAWN_WINDOW_MS = "15000";
      process.env.FRIDAY_RESPAWN_BACKOFF_BASE_MS = "500";
      process.env.FRIDAY_RESPAWN_BACKOFF_CAP_MS = "60000";
      expect(respawnConfig()).toEqual({
        maxAttempts: 5,
        windowMs: 15_000,
        backoffBaseMs: 500,
        backoffCapMs: 60_000,
      });
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("respawnConfig falls back to defaults for unset / invalid env", async () => {
    const { respawnConfig } = await import("./respawn-orphan-mail.js");
    const prev = process.env.FRIDAY_RESPAWN_MAX_ATTEMPTS;
    try {
      process.env.FRIDAY_RESPAWN_MAX_ATTEMPTS = "not-a-number";
      const cfg = respawnConfig();
      expect(cfg.maxAttempts).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.FRIDAY_RESPAWN_MAX_ATTEMPTS;
      else process.env.FRIDAY_RESPAWN_MAX_ATTEMPTS = prev;
    }
  });
});
