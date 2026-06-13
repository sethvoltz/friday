/**
 * ADR-024 leak backstop (MEDIUM finding): `spawn()` can emit an async `error`
 * event (ENOENT — bad interpreter, EMFILE — fd exhaustion) with NO matching
 * `exit` event, so `child.on("exit")` never runs. Before the fix the worker
 * stayed in the live map and any external bookkeeping the caller opened (the
 * scheduler's `schedule_runs` row) leaked `running` forever. `spawnTurn` now
 * registers `child.on("error")` that demotes the Generation and fires `onExit`
 * with status `error` (single-fire, so a later `exit` is a no-op).
 *
 * We mock `node:child_process.spawn` to return a fake child we can drive, plus
 * the DB-touching pre-fork deps, so the test exercises ONLY the new error-event
 * wiring in spawnTurn without forking a real process.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  pid = 4242;
  send = vi.fn();
}
const fakeChild = new FakeChild();
const spawnMock = vi.fn(() => fakeChild);

vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));
vi.mock("./registry.js", () => ({
  setStatus: vi.fn(async () => {}),
  getAgent: vi.fn(async () => ({ name: "sched-err", type: "scheduled" })),
  registerAgent: vi.fn(async () => {}),
}));
vi.mock("../apps/installer.js", () => ({ appContextForAgent: vi.fn(async () => undefined) }));
vi.mock("./sandbox-profile.js", () => ({
  sandboxExecAvailable: vi.fn(() => ({ available: false, reason: "test" })),
  profileInputsFor: vi.fn(() => ({})),
  writeProfile: vi.fn(() => "/tmp/profile.sb"),
  removeProfile: vi.fn(() => {}),
}));

let spawnTurn: (typeof import("./lifecycle.js"))["spawnTurn"];
let __deleteLiveWorkerForTest: (typeof import("./lifecycle.js"))["__deleteLiveWorkerForTest"];

beforeEach(async () => {
  vi.clearAllMocks();
  ({ spawnTurn, __deleteLiveWorkerForTest } = await import("./lifecycle.js"));
});

afterEach(() => {
  __deleteLiveWorkerForTest("sched-err");
});

describe("spawnTurn child.on('error') leak backstop", () => {
  it("fires onExit with status 'error' when spawn emits an error event (no exit)", async () => {
    const onExit = vi.fn();
    await spawnTurn({
      agentName: "sched-err",
      onExit,
      options: {
        agentName: "sched-err",
        agentType: "scheduled",
        workingDirectory: "/tmp",
        systemPrompt: "sys",
        prompt: "p",
        turnId: "t_err",
        model: "claude-opus-4-8",
        daemonPort: 4319,
        stateDir: "/tmp/state",
        mode: "one-shot",
        userMcpServers: [],
      } as never,
    });

    // No 'exit' — only the async 'error' event (ENOENT/EMFILE shape).
    fakeChild.emit("error", new Error("spawn /bin/bash ENOENT"));

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit.mock.calls[0]![0].status).toBe("error");
  });

  it("onExit is single-fire — a later exit after an error event does not re-fire it", async () => {
    const onExit = vi.fn();
    await spawnTurn({
      agentName: "sched-err",
      onExit,
      options: {
        agentName: "sched-err",
        agentType: "scheduled",
        workingDirectory: "/tmp",
        systemPrompt: "sys",
        prompt: "p",
        turnId: "t_err2",
        model: "claude-opus-4-8",
        daemonPort: 4319,
        stateDir: "/tmp/state",
        mode: "one-shot",
        userMcpServers: [],
      } as never,
    });

    fakeChild.emit("error", new Error("EMFILE"));
    // A late exit (some platforms emit both) must not double-close the row.
    fakeChild.emit("exit", 1, null);

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit.mock.calls[0]![0].status).toBe("error");
  });
});
