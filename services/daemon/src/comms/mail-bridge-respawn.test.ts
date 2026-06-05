import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestDb, type TestDbHandle } from "@friday/shared";

/**
 * FRI-154 mail-bridge integration with the respawn anti-loop:
 *
 *   - The dead-letter sentinel filters mail OUT of `maybeSpawnFromMail`'s
 *     dispatched prompt — once dead-lettered, the orphan rows do not silently
 *     re-spawn even on the next fresh-mail event.
 *   - A fresh mail arrival during the backoff window cancels the pending
 *     respawn timer (the fresh-mail path supersedes; no double-spawn).
 *   - `maybeSpawnFromMail` no-regression: an archived recipient still skips
 *     (FRI-151's existing gate), with or without dead-lettered rows.
 *
 * Tests live on the boundary the bug crossed (mail-bridge ↔ respawn module)
 * so a future refactor that moves the dead-letter filter elsewhere fails
 * loudly.
 */

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "mail_bridge_respawn" });
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
  vi.restoreAllMocks();
});

describe("maybeSpawnFromMail dead-letter filter (FRI-154)", () => {
  it("excludes dead-lettered rows from the dispatched prompt", async () => {
    const registry = await import("../agent/registry.js");
    const { sendMail, markMailDeadLetter, inbox } = await import("@friday/shared/services");

    await registry.registerAgent({ name: "filter-bare-1", type: "bare" });
    const m1 = await sendMail({
      fromAgent: "user",
      toAgent: "filter-bare-1",
      type: "message",
      body: "orphan that already dead-lettered",
    });
    const m2 = await sendMail({
      fromAgent: "user",
      toAgent: "filter-bare-1",
      type: "message",
      body: "fresh mail just arrived",
    });
    await markMailDeadLetter(m1.id, {
      agent: "filter-bare-1",
      at: Date.now() - 60_000,
      attempts: 3,
    });

    // Stub `dispatchTurn` so we can inspect the prompt body passed in
    // without spawning a real worker.
    const lifecycle = await import("../agent/lifecycle.js");
    const dispatchSpy = vi.spyOn(lifecycle, "dispatchTurn").mockImplementation(() => {});

    const { maybeSpawnFromMail } = await import("./mail-bridge.js");
    await maybeSpawnFromMail("filter-bare-1");

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const dispatchInput = dispatchSpy.mock.calls[0]?.[0] as { options: { prompt: string } };
    // The dead-lettered row's body MUST NOT appear; the fresh one's body MUST.
    expect(dispatchInput.options.prompt).not.toContain("orphan that already dead-lettered");
    expect(dispatchInput.options.prompt).toContain("fresh mail just arrived");

    // The dead-lettered row stays at pending in the DB — preserve over delete.
    const rows = await inbox("filter-bare-1");
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.id === m1.id)?.meta?.dead_letter).toBeDefined();
  });

  it("does NOT spawn when every pending row is dead-lettered", async () => {
    const registry = await import("../agent/registry.js");
    const { sendMail, markMailDeadLetter } = await import("@friday/shared/services");

    await registry.registerAgent({ name: "filter-bare-2", type: "bare" });
    const m = await sendMail({
      fromAgent: "user",
      toAgent: "filter-bare-2",
      type: "message",
      body: "only dead-lettered",
    });
    await markMailDeadLetter(m.id, {
      agent: "filter-bare-2",
      at: Date.now() - 60_000,
      attempts: 3,
    });

    const lifecycle = await import("../agent/lifecycle.js");
    const dispatchSpy = vi.spyOn(lifecycle, "dispatchTurn").mockImplementation(() => {});

    const { maybeSpawnFromMail } = await import("./mail-bridge.js");
    await maybeSpawnFromMail("filter-bare-2");

    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

describe("maybeSpawnFromMail existing-path no-regression (FRI-151 gate)", () => {
  it("skips an archived recipient even with pending mail", async () => {
    const registry = await import("../agent/registry.js");
    const { sendMail } = await import("@friday/shared/services");

    await registry.registerAgent({ name: "archived-bare-1", type: "bare" });
    await sendMail({
      fromAgent: "user",
      toAgent: "archived-bare-1",
      type: "message",
      body: "stranded after archive",
    });
    await registry.archiveAgent("archived-bare-1", { reason: "completed" });

    const lifecycle = await import("../agent/lifecycle.js");
    const dispatchSpy = vi.spyOn(lifecycle, "dispatchTurn").mockImplementation(() => {});

    const { maybeSpawnFromMail } = await import("./mail-bridge.js");
    await maybeSpawnFromMail("archived-bare-1");

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("skips a scheduled-type recipient (driven by cron, not mail)", async () => {
    const registry = await import("../agent/registry.js");
    const { sendMail } = await import("@friday/shared/services");

    await registry.registerAgent({ name: "sched-1", type: "scheduled" });
    await sendMail({
      fromAgent: "user",
      toAgent: "sched-1",
      type: "message",
      body: "should not auto-spawn a scheduled agent",
    });

    const lifecycle = await import("../agent/lifecycle.js");
    const dispatchSpy = vi.spyOn(lifecycle, "dispatchTurn").mockImplementation(() => {});

    const { maybeSpawnFromMail } = await import("./mail-bridge.js");
    await maybeSpawnFromMail("sched-1");

    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

describe("maybeSpawnFromMail cancels pending respawn timers (FRI-154 race-avoidance)", () => {
  it("cancels an in-flight respawn timer for the same agent on entry", async () => {
    const registry = await import("../agent/registry.js");
    const { sendMail } = await import("@friday/shared/services");

    await registry.registerAgent({ name: "race-bare-1", type: "bare" });
    await sendMail({
      fromAgent: "user",
      toAgent: "race-bare-1",
      type: "message",
      body: "queued during force-kill",
    });

    const lifecycle = await import("../agent/lifecycle.js");
    vi.spyOn(lifecycle, "dispatchTurn").mockImplementation(() => {});

    const { noteForceKillForRespawn, __peekTrackerForTest } =
      await import("./respawn-orphan-mail.js");
    // First force-kill schedules a timer.
    await noteForceKillForRespawn("race-bare-1", { code: null, signal: "SIGKILL" });
    const beforeTimer = __peekTrackerForTest("race-bare-1")?.pendingTimer;
    expect(beforeTimer).toBeDefined();

    // Fresh-mail path runs maybeSpawnFromMail — cancels the timer.
    const { maybeSpawnFromMail } = await import("./mail-bridge.js");
    await maybeSpawnFromMail("race-bare-1");

    const afterTimer = __peekTrackerForTest("race-bare-1")?.pendingTimer;
    expect(afterTimer).toBeUndefined();
  });
});
