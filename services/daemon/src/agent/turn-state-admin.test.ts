/**
 * FRI-145 M4 — administrative Transitions (archive / heal / set-projection).
 *
 * These pin the PURE machine's admin channel and its executor against FAKE
 * collaborators (not mocks of the function under test). The three non-turn-
 * boundary channels — archive, boot-recovery, auditor — all funnel
 * `applyAdmin`, so the Status-projection decision lives in exactly one place
 * and we assert the INTENTS + their ordering, not internal state.
 *
 * The load-bearing pin is AC #6: the `archive` transition emits `close-ticket`
 * BEFORE `archive`, so in prod the linked ticket closes strictly before the
 * agents row goes terminal. We assert both the intent order AND the executor's
 * observed call order against fakes.
 */

import { describe, expect, it } from "vitest";
import { applyAdmin } from "./turn-state-machine.js";
import { executeIntents, type PortWorker, type TurnStatePorts } from "./turn-state-ports.js";

const fakeWorker: PortWorker = { agentName: "agent-1", turnId: "" };

interface AdminRecorder {
  ports: TurnStatePorts<PortWorker>;
  order: string[];
  setStatusCalls: [string, string][];
  archiveCalls: { name: string; reason: string }[];
  healCalls: { name: string; status: string; clearArchiveReason: boolean }[];
  closeTicketCalls: { ticketId: string | null; reason: string; agentName: string }[];
  archiveShouldThrow?: Error;
}

function makeAdminRecorder(archiveShouldThrow?: Error): AdminRecorder {
  const rec: AdminRecorder = {
    ports: undefined as unknown as TurnStatePorts<PortWorker>,
    order: [],
    setStatusCalls: [],
    archiveCalls: [],
    healCalls: [],
    closeTicketCalls: [],
    archiveShouldThrow,
  };
  rec.ports = {
    setStatus: async (name, status) => {
      rec.order.push("set-status");
      rec.setStatusCalls.push([name, status]);
    },
    archive: async (name, opts) => {
      rec.order.push("archive");
      rec.archiveCalls.push({ name, reason: opts.reason });
      if (rec.archiveShouldThrow) throw rec.archiveShouldThrow;
    },
    heal: async (name, status, opts) => {
      rec.order.push("heal");
      rec.healCalls.push({ name, status, clearArchiveReason: opts.clearArchiveReason });
    },
    closeTicket: async (opts) => {
      rec.order.push("close-ticket");
      rec.closeTicketCalls.push(opts);
    },
    publish: () => {},
    blockStream: {
      recordError: async () => ({ blockId: "b" }),
      finalize: async () => {},
      endTurn: () => {},
    },
    recoverFromJsonl: async () => {},
    insertUsage: async () => {},
    captureTurnEvent: () => {},
    sendPrompt: () => {},
    forceKill: async () => {},
    logWarn: () => {},
    logInfo: () => {},
  };
  return rec;
}

describe("FRI-145 M4: applyAdmin returns the right intents (no I/O in core)", () => {
  it("archive → [close-ticket, archive] in that order, projects archived", () => {
    const r = applyAdmin("alpha", { kind: "archive", reason: "completed", ticketId: "FRI-1" });
    expect(r.projection).toBe("archived");
    expect(r.intents).toEqual([
      { kind: "close-ticket", name: "alpha", ticketId: "FRI-1", reason: "completed" },
      { kind: "archive", name: "alpha", reason: "completed" },
    ]);
  });

  it("archive with null ticketId still emits close-ticket (executor no-ops it)", () => {
    const r = applyAdmin("beta", { kind: "archive", reason: "abandoned", ticketId: null });
    expect(r.intents).toEqual([
      { kind: "close-ticket", name: "beta", ticketId: null, reason: "abandoned" },
      { kind: "archive", name: "beta", reason: "abandoned" },
    ]);
  });

  it("heal → single heal intent carrying the target + clearArchiveReason", () => {
    const r = applyAdmin("friday", { kind: "heal", target: "idle", clearArchiveReason: true });
    expect(r.projection).toBe("idle");
    expect(r.intents).toEqual([
      { kind: "heal", name: "friday", status: "idle", clearArchiveReason: true },
    ]);
  });

  it("set-projection → single set-status intent", () => {
    const r = applyAdmin("gamma", { kind: "set-projection", status: "idle" });
    expect(r.projection).toBe("idle");
    expect(r.intents).toEqual([{ kind: "set-status", name: "gamma", status: "idle" }]);
  });
});

describe("FRI-145 M4: executeIntents runs the admin DB doors in order", () => {
  it("AC #6: close-ticket runs BEFORE archive (call-order array)", async () => {
    const r = applyAdmin("alpha", { kind: "archive", reason: "failed", ticketId: "FRI-7" });
    const rec = makeAdminRecorder();
    await executeIntents(fakeWorker, r.intents, rec.ports);

    expect(rec.order).toEqual(["close-ticket", "archive"]);
    expect(rec.closeTicketCalls).toEqual([
      { ticketId: "FRI-7", reason: "failed", agentName: "alpha" },
    ]);
    expect(rec.archiveCalls).toEqual([{ name: "alpha", reason: "failed" }]);
  });

  it("archive intent rejection PROPAGATES (FSM gate must reach the caller)", async () => {
    const r = applyAdmin("main", { kind: "archive", reason: "abandoned", ticketId: null });
    const boom = new Error("IllegalTransitionError[ORCHESTRATOR_NOT_ARCHIVABLE]");
    const rec = makeAdminRecorder(boom);

    // close-ticket still ran (the executor reached the archive intent),
    // but the archive's throw is NOT swallowed — it propagates.
    await expect(executeIntents(fakeWorker, r.intents, rec.ports)).rejects.toThrow(
      /ORCHESTRATOR_NOT_ARCHIVABLE/,
    );
    expect(rec.order).toEqual(["close-ticket", "archive"]);
  });

  it("heal intent reaches the heal port with clearArchiveReason", async () => {
    const r = applyAdmin("friday", { kind: "heal", target: "idle", clearArchiveReason: true });
    const rec = makeAdminRecorder();
    await executeIntents(fakeWorker, r.intents, rec.ports);

    expect(rec.healCalls).toEqual([{ name: "friday", status: "idle", clearArchiveReason: true }]);
    // Heal does NOT go through the gated setStatus door.
    expect(rec.setStatusCalls).toEqual([]);
  });

  it("set-projection reaches the gated setStatus door", async () => {
    const r = applyAdmin("gamma", { kind: "set-projection", status: "idle" });
    const rec = makeAdminRecorder();
    await executeIntents(fakeWorker, r.intents, rec.ports);

    expect(rec.setStatusCalls).toEqual([["gamma", "idle"]]);
    expect(rec.archiveCalls).toEqual([]);
    expect(rec.healCalls).toEqual([]);
  });
});
