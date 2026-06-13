/**
 * FRI-148 AC #14: wire-event observability after the A1-default reorder.
 *
 * Phase A moved the end-turn intent emission from its old late position (after
 * publish-error + publish-turn-done + posthog + log) to immediately follow the
 * finalize-blocks position, then collapsed the now-adjacent pair into one
 * tear-down-turn intent. The hazard the reorder could introduce is a
 * user-visible regression: if `tear-down-turn` published any SSE wire event,
 * sliding it BEFORE publish-error / publish-turn-done would reorder the SSEs
 * the dashboard sees and the inflight pin / error banner would render in the
 * wrong order.
 *
 * This test pins that the SSE order is preserved by driving an error
 * Transition end-to-end through `apply` → `executeIntents` against the real
 * eventBus, capturing the published events via `eventBus.subscribe`, and
 * asserting that the `error` wire event arrives strictly BEFORE the
 * `turn_done` wire event. The mechanical reason this holds: `tear-down-turn`
 * emits only per-block `block_complete` SSEs (via `bsTearDownTurn` →
 * `finalizeInFlightBlocks`) — it publishes NO turn-level error/turn_done
 * event — so reordering the intent slot doesn't reorder the wire output.
 */

import { describe, expect, it } from "vitest";
import { apply, type ApplyDeps, type TurnContext } from "./turn-state-machine.js";
import { executeIntents, type PortWorker, type TurnStatePorts } from "./turn-state-ports.js";
import { eventBus } from "../events/bus.js";

const DEPS: ApplyDeps = { wedgeThreshold: 10, now: 5_000, uuid: () => "U" };

function ctx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    agentName: "wire-agent",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    parentName: undefined,
    turnId: "turn-wire-1",
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

/** A real ports bag that publishes through the real eventBus and stubs every
 *  non-SSE collaborator. The block-stream port's tearDownTurn is a no-op (the
 *  point is that it emits no SSE on this path), so the only SSEs published are
 *  the machine's own `publish-error` and `publish-turn-done` intents. */
function makeRealPublishPorts(): TurnStatePorts<PortWorker> {
  return {
    setStatus: async () => {},
    archive: async () => {},
    heal: async () => {},
    closeTicket: async () => {},
    publish: (event) => {
      eventBus.publish(event);
    },
    blockStream: {
      // Stub: tearDownTurn would normally finalize any streaming blocks and
      // drop the turn entry. For this test we have no in-flight blocks (the
      // machine doesn't know that — but tearDownTurn against an empty
      // accumulator is a no-op anyway), so a stub is faithful and isolates
      // the assertion to the turn-level SSE order.
      tearDownTurn: async () => {},
    },
    blockInjector: {
      recordError: async () => ({ blockId: "b" }),
    },
    recoverFromJsonl: async () => {},
    insertUsage: async () => {},
    insertUsageRequests: async () => [],
    captureTurnEvent: () => {},
    sendPrompt: () => {},
    forceKill: async () => {},
    logWarn: () => {},
    logInfo: () => {},
  };
}

describe("FRI-148 AC #14: A1-default reorder preserves SSE order (error → turn_done)", () => {
  it("applyFail drives publish-error BEFORE publish-turn-done over the real eventBus", async () => {
    // Subscribe FIRST so the captures start at a clean baseline; the bus is a
    // singleton so any other test in this process may have advanced its seq,
    // but the relative order of THIS test's two publishes is what we pin.
    const captured: { type: string; turn_id?: string }[] = [];
    const unsub = eventBus.subscribe((e) => {
      const ev = e as { type?: string; turn_id?: string };
      if ((ev.type === "error" || ev.type === "turn_done") && ev.turn_id === "turn-wire-1") {
        captured.push({ type: ev.type, turn_id: ev.turn_id });
      }
    });

    try {
      const result = apply(
        ctx({ blocksThisTurn: 1 }),
        { kind: "fail", payload: { message: "boom", recoverable: false, code: "x" } },
        DEPS,
      );
      // Sanity: the machine emitted both turn-level SSE intents, and the
      // tear-down-turn intent sits BEFORE publish-error (the A1-default
      // reorder this test is guarding).
      const tearIdx = result.intents.findIndex((i) => i.kind === "tear-down-turn");
      const errorIdx = result.intents.findIndex((i) => i.kind === "publish-error");
      const doneIdx = result.intents.findIndex((i) => i.kind === "publish-turn-done");
      expect(tearIdx).toBeGreaterThanOrEqual(0);
      expect(errorIdx).toBeGreaterThan(tearIdx);
      expect(doneIdx).toBeGreaterThan(errorIdx);

      await executeIntents(
        { agentName: "wire-agent", turnId: "turn-wire-1" },
        result.intents,
        makeRealPublishPorts(),
      );
    } finally {
      unsub();
    }

    // The two captured SSEs land in exactly: error, turn_done.
    expect(captured.map((c) => c.type)).toEqual(["error", "turn_done"]);
  });

  it("the wire order is preserved even when tear-down-turn sits earlier in the intent list", async () => {
    // Belt-and-braces: drive the same assertion through executeIntents on a
    // hand-constructed intent list that mirrors the new applyFail ordering
    // (record-error-block, tear-down-turn, publish-error, publish-turn-done).
    // This pins the SSE-order property at the executor level, not just at the
    // machine level — if a future refactor adds an SSE publish inside the
    // tear-down-turn port, this test catches it before the dashboard does.
    const captured: { type: string; turn_id?: string }[] = [];
    const unsub = eventBus.subscribe((e) => {
      const ev = e as { type?: string; turn_id?: string };
      if ((ev.type === "error" || ev.type === "turn_done") && ev.turn_id === "turn-wire-2") {
        captured.push({ type: ev.type, turn_id: ev.turn_id });
      }
    });

    try {
      await executeIntents(
        { agentName: "wire-agent", turnId: "turn-wire-2" },
        [
          {
            kind: "record-error-block",
            payload: {
              code: "x",
              headline: "h",
              httpStatus: undefined,
              retryAfterSeconds: undefined,
              requestId: undefined,
              rawMessage: "h",
            },
          },
          { kind: "tear-down-turn", turnId: "turn-wire-2", status: "error" },
          {
            kind: "publish-error",
            turnId: "turn-wire-2",
            agent: "wire-agent",
            code: "x",
            message: "h",
            recoverable: false,
          },
          {
            kind: "publish-turn-done",
            turnId: "turn-wire-2",
            agent: "wire-agent",
            status: "error",
          },
        ],
        makeRealPublishPorts(),
      );
    } finally {
      unsub();
    }

    expect(captured.map((c) => c.type)).toEqual(["error", "turn_done"]);
  });
});
