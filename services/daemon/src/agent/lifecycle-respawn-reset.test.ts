/**
 * FRI-154 lifecycle wiring: the `turn-complete` handler must invoke
 * `noteTurnComplete` so the per-agent respawn tracker resets. Without this,
 * a long-lived agent that survived two force-kill respawns over months would
 * dead-letter on the next unrelated death, even though it had a fully
 * successful turn in between.
 *
 * Tested by driving the real `handleEvent` for a `turn-complete` IPC and
 * inspecting the tracker afterward. The `child.on("exit")` side of the
 * wiring is covered by `respawn-orphan-mail.test.ts`'s anti-loop integration
 * tests — which exercise `noteForceKillForRespawn` end-to-end against the
 * real DB — plus the runtime daemon log on production agents.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_respawn_reset" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

afterEach(async () => {
  const lifecycle = await import("./lifecycle.js");
  for (const name of lifecycle.liveAgentNames()) {
    lifecycle.__deleteLiveWorkerForTest(name);
  }
  const respawn = await import("../comms/respawn-orphan-mail.js");
  respawn.__resetForTest();
  vi.restoreAllMocks();
});

function makeFakeWorker(agentName: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    child: { send: vi.fn(), exitCode: null, killed: false, pid: 0 },
    pgid: 0,
    agentName,
    agentType: "bare",
    model: "claude-sonnet-4-6",
    turnId: `t_${agentName}_1`,
    sessionId: `sess_${agentName}`,
    workingDirectory: `/tmp/${agentName}`,
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now() - 1_000,
    spawnedAt: Date.now() - 1_000,
    lastBlockStop: Date.now(),
    turnState: "working",
    status: "working",
    nextPrompts: [],
    mode: "long-lived",
    lastExitStatus: "complete",
    completedAtLeastOnce: true,
    blocksThisTurn: 1,
    illegalTransitionsThisTurn: 0,
    zeroBlockTurnStreak: 0,
    mailSendToParentThisTurn: 0,
    noMailBackNudgedThisTurn: false,
    noMailBackStreak: 0,
    ...overrides,
  };
}

describe("turn-complete invokes noteTurnComplete (FRI-154 reset)", () => {
  it("clears a per-agent respawn tracker after a successful turn-complete", async () => {
    const lifecycle = await import("./lifecycle.js");
    const registry = await import("./registry.js");
    const respawn = await import("../comms/respawn-orphan-mail.js");

    await registry.registerAgent({ name: "reset-bare-1", type: "bare" });
    await registry.setStatus("reset-bare-1", "working");

    // Stub maybeSpawnFromMail so noteForceKillForRespawn's timer callback is
    // a no-op when the timer fires (we don't care here — we want the
    // tracker state before turn-complete).
    const bridge = await import("../comms/mail-bridge.js");
    vi.spyOn(bridge, "maybeSpawnFromMail").mockImplementation(async () => {});

    // Seed the tracker with a non-trivial attempts value (simulates a
    // prior force-kill streak). Send mail so noteForceKillForRespawn
    // schedules a real timer rather than skipping for no-unprocessed.
    const { sendMail } = await import("@friday/shared/services");
    await sendMail({
      fromAgent: "user",
      toAgent: "reset-bare-1",
      type: "message",
      body: "orphan from a prior streak",
    });
    await respawn.noteForceKillForRespawn("reset-bare-1", { code: null, signal: "SIGKILL" });
    expect(respawn.__peekTrackerForTest("reset-bare-1")?.attempts).toBe(1);

    // Drive the real handleEvent for `turn-complete`. The reset call inside
    // the case body (right after `await runTransition`) must clear the
    // tracker.
    const worker = makeFakeWorker("reset-bare-1");
    lifecycle.__putLiveWorkerForTest("reset-bare-1", worker as never);

    await lifecycle.handleEvent(worker as never, {
      type: "turn-complete",
      sessionId: "sess_reset-bare-1",
      compactionThisTurn: false,
    });

    expect(respawn.__peekTrackerForTest("reset-bare-1")).toBeNull();
  });
});
