/**
 * FRI-145 M3 — Turn-state machine ports/executor unit tests.
 *
 * `executeIntents` interprets the machine's intents against the ports bag. The
 * machine decides WHAT; the executor decides HOW; the ports bag is the only
 * place real side effects live. These tests pass FAKE collaborators (not mocks
 * of the function under test) and assert the recorded calls + ordering — the
 * cross-boundary contract that, in prod, reaches `registry.setStatus` (the DB
 * door), the `eventBus`, the block-stream pipeline, and `forceKillStuckWorker`.
 */

import { describe, expect, it, vi } from "vitest";
import { apply, type ApplyDeps, type TurnContext } from "./turn-state-machine.js";
import { executeIntents, type PortWorker, type TurnStatePorts } from "./turn-state-ports.js";

const DEPS: ApplyDeps = { wedgeThreshold: 10, now: 5_000, uuid: () => "U" };

function ctx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    agentName: "agent-1",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    parentName: undefined,
    turnId: "turn-1",
    sessionId: undefined,
    workingDirectory: "/tmp/wd",
    abortRequested: false,
    turnStart: 4_000,
    blocksThisTurn: 1,
    zeroBlockTurnStreak: 0,
    mailSendToParentThisTurn: 0,
    noMailBackNudgedThisTurn: false,
    noMailBackStreak: 0,
    nextPrompts: [],
    ...overrides,
  };
}

interface Recorder {
  ports: TurnStatePorts<PortWorker>;
  setStatusCalls: [string, string][];
  published: { type: string; status?: string; turn_id?: string; streak?: number }[];
  finalizeCalls: string[];
  recordErrorCalls: number;
  endTurnCalls: string[];
  sendPromptCalls: { turnId: string }[];
  forceKillCalls: { reason: string; zeroBlockTurnStreak: number }[];
  usageInserts: number;
  recoverCalls: { sessionId: string }[];
  posthogEvents: string[];
}

function makeRecorder(): Recorder {
  // Build the recorder object first so the port closures mutate THE SAME
  // object the test reads (a spread would snapshot the numeric counters at 0).
  const rec: Recorder = {
    ports: undefined as unknown as TurnStatePorts<PortWorker>,
    setStatusCalls: [],
    published: [],
    finalizeCalls: [],
    recordErrorCalls: 0,
    endTurnCalls: [],
    sendPromptCalls: [],
    forceKillCalls: [],
    usageInserts: 0,
    recoverCalls: [],
    posthogEvents: [],
  };
  rec.ports = {
    setStatus: async (name, status) => {
      rec.setStatusCalls.push([name, status]);
    },
    publish: (event) => {
      rec.published.push(event as Recorder["published"][number]);
    },
    blockStream: {
      recordError: async () => {
        rec.recordErrorCalls++;
        return { blockId: "b" };
      },
      finalize: async (_w, status) => {
        rec.finalizeCalls.push(status);
      },
      endTurn: (turnId) => {
        rec.endTurnCalls.push(turnId);
      },
    },
    recoverFromJsonl: async (inputs) => {
      rec.recoverCalls.push({ sessionId: inputs[0].sessionId });
    },
    insertUsage: async () => {
      rec.usageInserts++;
    },
    captureTurnEvent: (_turnId, event) => {
      rec.posthogEvents.push(event);
    },
    sendPrompt: (_w, p) => {
      rec.sendPromptCalls.push({ turnId: p.turnId });
    },
    forceKill: async (_w, opts) => {
      rec.forceKillCalls.push(opts);
    },
    logWarn: () => {},
    logInfo: () => {},
  };
  return rec;
}

const fakeWorker: PortWorker = { agentName: "agent-1", turnId: "turn-1" };

describe("turn-state-ports: complete → executor wires the DB door + fan-out", () => {
  it("writes idle via setStatus (the DB door), publishes turn_done, finalizes, ends the turn", async () => {
    const r = apply(ctx({ blocksThisTurn: 1 }), { kind: "complete", payload: {} }, DEPS);
    const rec = makeRecorder();
    await executeIntents(fakeWorker, r.intents, rec.ports);

    // The single agents.status write goes through the setStatus port.
    expect(rec.setStatusCalls).toEqual([["agent-1", "idle"]]);
    // turn_done published with status complete.
    expect(rec.published).toContainEqual({
      v: 1,
      type: "turn_done",
      turn_id: "turn-1",
      agent: "agent-1",
      status: "complete",
      usage: undefined,
    });
    expect(rec.finalizeCalls).toEqual(["aborted"]);
    expect(rec.endTurnCalls).toEqual(["turn-1"]);
    expect(rec.posthogEvents).toEqual(["turn_completed"]);
  });

  it("(b) a queued prompt drains via sendPrompt exactly once", async () => {
    const queued = { prompt: "next", turnId: "turn-2" };
    const r = apply(
      ctx({ blocksThisTurn: 1, nextPrompts: [queued] }),
      { kind: "complete", payload: {} },
      DEPS,
    );
    const rec = makeRecorder();
    await executeIntents(fakeWorker, r.intents, rec.ports);
    expect(rec.sendPromptCalls).toEqual([{ turnId: "turn-2" }]);
  });

  it("fires insert-usage when usage + session are present", async () => {
    const usage = {
      input_tokens: 1,
      output_tokens: 2,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      cost_usd: 0.001,
    };
    const r = apply(
      ctx({ blocksThisTurn: 1, sessionId: "s" }),
      { kind: "complete", payload: { usage } },
      DEPS,
    );
    const rec = makeRecorder();
    await executeIntents(fakeWorker, r.intents, rec.ports);
    expect(rec.usageInserts).toBe(1);
  });
});

describe("turn-state-ports: fail → executor records the error block + error turn_done", () => {
  it("non-abort error records the block, finalizes error, publishes error + turn_done(error), heals idle", async () => {
    const r = apply(
      ctx({ blocksThisTurn: 1 }),
      { kind: "fail", payload: { message: "boom", recoverable: false, code: "x" } },
      DEPS,
    );
    const rec = makeRecorder();
    await executeIntents(fakeWorker, r.intents, rec.ports);

    expect(rec.recordErrorCalls).toBe(1);
    expect(rec.finalizeCalls).toEqual(["error"]);
    expect(rec.setStatusCalls).toEqual([["agent-1", "idle"]]);
    const done = rec.published.find((p) => p.type === "turn_done");
    expect(done?.status).toBe("error");
    expect(rec.posthogEvents).toEqual(["turn_errored"]);
  });
});

describe("turn-state-ports: (a) wedge escalation calls the forceKill port, not setStatus", () => {
  it("a tripped wedge invokes forceKill with the streak and writes NO idle via setStatus", async () => {
    const deps: ApplyDeps = { ...DEPS, wedgeThreshold: 2 };
    const r = apply(
      ctx({ blocksThisTurn: 0, zeroBlockTurnStreak: 1 }),
      { kind: "complete", payload: {} },
      deps,
    );
    const rec = makeRecorder();
    await executeIntents(fakeWorker, r.intents, rec.ports);

    expect(rec.forceKillCalls).toEqual([{ reason: "wedge", zeroBlockTurnStreak: 2 }]);
    // The wedge path does not write idle through the executor — forceKill owns it.
    expect(rec.setStatusCalls).toEqual([]);
    // turn_done(complete) still went out before the escalation.
    expect(rec.published.find((p) => p.type === "turn_done")?.status).toBe("complete");
  });
});

describe("turn-state-ports: (c) mail-back Option B nudge dispatches via sendPrompt", () => {
  it("Option B emits a nudge prompt via sendPrompt and SKIPS the queued drain", async () => {
    const queued = { prompt: "queued", turnId: "turn-q" };
    const r = apply(
      ctx({
        agentType: "builder",
        parentName: "orch",
        blocksThisTurn: 2,
        mailSendToParentThisTurn: 0,
        nextPrompts: [queued],
      }),
      { kind: "complete", payload: {} },
      DEPS,
    );
    const rec = makeRecorder();
    await executeIntents(fakeWorker, r.intents, rec.ports);

    // Exactly one sendPrompt — the nudge, NOT the queued prompt.
    expect(rec.sendPromptCalls).toEqual([{ turnId: "t_U" }]);
  });

  it("Option C publishes the no-mail-back SSE and STILL drains the queued prompt", async () => {
    const queued = { prompt: "queued", turnId: "turn-q" };
    const r = apply(
      ctx({
        agentType: "builder",
        parentName: "orch",
        blocksThisTurn: 2,
        mailSendToParentThisTurn: 0,
        noMailBackNudgedThisTurn: true,
        noMailBackStreak: 1,
        nextPrompts: [queued],
      }),
      { kind: "complete", payload: {} },
      DEPS,
    );
    const rec = makeRecorder();
    await executeIntents(fakeWorker, r.intents, rec.ports);

    expect(rec.published).toContainEqual({
      v: 1,
      type: "worker.no-mail-back",
      agent: "agent-1",
      turn_id: "turn-1",
      streak: 2,
    });
    // The queued prompt drains (Option C does not own the next turn).
    expect(rec.sendPromptCalls).toEqual([{ turnId: "turn-q" }]);
  });
});

describe("turn-state-ports: set-status error is swallowed (self-healing)", () => {
  it("a throwing setStatus is logged, not re-thrown, so executeIntents settles", async () => {
    const r = apply(ctx({ blocksThisTurn: 1 }), { kind: "complete", payload: {} }, DEPS);
    const rec = makeRecorder();
    const logWarn = vi.fn();
    rec.ports.setStatus = async () => {
      throw new Error("DB down");
    };
    rec.ports.logWarn = logWarn;
    await expect(executeIntents(fakeWorker, r.intents, rec.ports)).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith(
      "registry.set-status.error",
      expect.objectContaining({ agent: "agent-1", status: "idle", message: "DB down" }),
    );
  });
});
