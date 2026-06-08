/**
 * stopWorkersForApp: stops all live workers belonging to an app's agents and
 * leaves workers from other apps untouched.
 *
 * Uses __putLiveWorkerForTest to inject synthetic workers (pgid=0 → killPgrp
 * is a no-op; exitCode=0 → drainLiveWorker resolves immediately via the
 * early-exit branch rather than hanging on the "exit" event).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;
let lifecycle: typeof import("./lifecycle.js");
let registry: typeof import("./registry.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "lifecycle_stop_workers" });
  lifecycle = await import("./lifecycle.js");
  registry = await import("./registry.js");
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeFakeWorker(overrides: Record<string, unknown> = {}): {
  worker: unknown;
  child: { send: ReturnType<typeof vi.fn>; exitCode: number | null; killed: boolean };
} {
  const child = { send: vi.fn(), exitCode: 0 as number | null, killed: false };
  const w = {
    child,
    pgid: 0,
    agentName: "sw-agent",
    agentType: "bare",
    model: "claude-opus-4-7",
    turnId: "turn-sw-1",
    sessionId: "sess-sw-1",
    workingDirectory: "/tmp/fake",
    abortRequested: false,
    lastHeartbeat: Date.now(),
    turnStart: Date.now(),
    spawnedAt: Date.now(),
    lastBlockStop: Date.now(),
    status: "idle",
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
  return { worker: w, child };
}

describe("stopWorkersForApp", () => {
  it("stops live workers for the target app and returns the stopped count", async () => {
    await registry.registerAgent({ name: "app1-agent-a", type: "bare", appId: "app-one" });
    await registry.registerAgent({ name: "app1-agent-b", type: "bare", appId: "app-one" });
    await registry.setStatus("app1-agent-a", "working");
    await registry.setStatus("app1-agent-b", "working");

    const { worker: wa } = makeFakeWorker({ agentName: "app1-agent-a" });
    const { worker: wb } = makeFakeWorker({ agentName: "app1-agent-b" });
    lifecycle.__putLiveWorkerForTest("app1-agent-a", wa as never);
    lifecycle.__putLiveWorkerForTest("app1-agent-b", wb as never);

    const stopped = await lifecycle.stopWorkersForApp("app-one");

    expect(stopped).toBe(2);
    expect(lifecycle.isAgentLive("app1-agent-a")).toBe(false);
    expect(lifecycle.isAgentLive("app1-agent-b")).toBe(false);
    expect((await registry.getAgent("app1-agent-a"))?.status).toBe("idle");
    expect((await registry.getAgent("app1-agent-b"))?.status).toBe("idle");
  });

  it("leaves workers from other apps untouched", async () => {
    await registry.registerAgent({ name: "app2-agent", type: "bare", appId: "app-two" });
    await registry.setStatus("app2-agent", "working");
    const { worker: wo } = makeFakeWorker({ agentName: "app2-agent" });
    lifecycle.__putLiveWorkerForTest("app2-agent", wo as never);

    const stopped = await lifecycle.stopWorkersForApp("app-one");

    expect(stopped).toBe(0);
    expect(lifecycle.isAgentLive("app2-agent")).toBe(true);
    expect((await registry.getAgent("app2-agent"))?.status).toBe("working");

    lifecycle.__deleteLiveWorkerForTest("app2-agent");
  });

  it("returns 0 and does not error when no workers are live for the app", async () => {
    await registry.registerAgent({ name: "app3-agent", type: "bare", appId: "app-three" });

    const stopped = await lifecycle.stopWorkersForApp("app-three");

    expect(stopped).toBe(0);
    expect(lifecycle.isAgentLive("app3-agent")).toBe(false);
  });
});
