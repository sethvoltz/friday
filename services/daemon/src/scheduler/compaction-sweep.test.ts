/**
 * FRI-156 §B — nightly maintenance compaction sweep.
 *
 * Three layers, each tested where its bug would live:
 *   - `isSweepDue` — pure local-clock + per-day dedup; injected `now` +
 *     `lastSweepAt`, exact booleans per case (NO vitest fake timers, matching
 *     the repo's injected-`now` scheduler convention).
 *   - `selectSweepTargets` — pure policy; the EXACT candidate list + the
 *     estimate math, with every exclusion class (builder/scheduled/bare,
 *     non-idle, offline, below-threshold) provably excluded.
 *   - `__runSweepForTest` — the imperative tick against a real scratch
 *     Postgres (createTestDb) with seeded agents + usage rows + fake live
 *     workers: asserts dispatchTurn fires `/compact …` in long-lived mode for
 *     the right agent only, recordUserBlock carries `source:'compaction_sweep'`,
 *     and the `worker.compact.sweep.*` log lines fire.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestDb,
  type AgentEntry,
  type FridayConfig,
  type TestDbHandle,
} from "@friday/shared";
import { insertUsage } from "@friday/shared/services";

import {
  isSweepDue,
  selectSweepTargets,
  __runSweepForTest,
  __resetLastSweepForTest,
} from "./compaction-sweep.js";
import { COMPACT_CUSTOM_INSTRUCTIONS } from "../prompts/compact-instructions.js";

// Default config: no `compaction` block, so the resolvers fall to the code
// defaults (03:30 local, 60K threshold). Cast keeps the test honest about
// using the real resolver path rather than hand-poking fields.
const cfg = {} as FridayConfig;

/** A fixed local 03:30 on an arbitrary day — past the 03:30 sweep time. */
function at(hour: number, minute: number, day = 15): Date {
  return new Date(2026, 5, day, hour, minute, 0, 0);
}

describe("isSweepDue (pure local-clock + per-day dedup)", () => {
  it("true at exactly 03:30 with no prior sweep today", () => {
    expect(isSweepDue(at(3, 30), null, cfg)).toBe(true);
  });

  it("true after 03:30 (e.g. 04:00) with no prior sweep", () => {
    expect(isSweepDue(at(4, 0), null, cfg)).toBe(true);
  });

  it("false before 03:30 (03:29)", () => {
    expect(isSweepDue(at(3, 29), null, cfg)).toBe(false);
  });

  it("false at 02:00 (well before the window)", () => {
    expect(isSweepDue(at(2, 0), null, cfg)).toBe(false);
  });

  it("false when already swept earlier the same local day", () => {
    const lastSweep = at(3, 30).getTime();
    // Same day, 05:00 — already swept at 03:30, so no re-fire.
    expect(isSweepDue(at(5, 0), lastSweep, cfg)).toBe(false);
  });

  it("true again the next local day even though it swept yesterday", () => {
    const lastSweep = at(3, 30, 15).getTime();
    // Next day at 03:30 — re-arms.
    expect(isSweepDue(at(3, 30, 16), lastSweep, cfg)).toBe(true);
  });

  it("false at a daytime restart (14:00) with null lastSweepAt — must NOT mass-compact", () => {
    // A fresh process (in-memory lastSweepAt resets to null) booted at 14:00,
    // e.g. a `friday update` daytime restart. Outside the [03:30, 05:30)
    // window, so it waits for the next 03:30 rather than firing immediately.
    expect(isSweepDue(at(14, 0), null, cfg)).toBe(false);
  });

  it("false just past the catch-up window (05:30) with null lastSweepAt", () => {
    // 05:30 is exactly scheduled + 120min — the window is half-open, so it is
    // out. (A daemon down through the whole window waits for the next night.)
    expect(isSweepDue(at(5, 30), null, cfg)).toBe(false);
  });

  it("true near the end of the catch-up window (05:29) with null lastSweepAt", () => {
    // A daemon that was down at 03:30 and boots at 05:29 still catches the
    // nightly run (inside [03:30, 05:30)).
    expect(isSweepDue(at(5, 29), null, cfg)).toBe(true);
  });
});

/** Minimal AgentEntry builders for the pure selectSweepTargets cases. */
function orch(name: string, status: AgentEntry["status"] = "idle"): AgentEntry {
  return {
    name,
    type: "orchestrator",
    status,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}
function helper(name: string, status: AgentEntry["status"] = "idle"): AgentEntry {
  return {
    name,
    type: "helper",
    status,
    parentName: "friday",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}
function builder(name: string): AgentEntry {
  return {
    name,
    type: "builder",
    status: "idle",
    parentName: "friday",
    worktreePath: "/tmp/wt",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

describe("selectSweepTargets (pure policy)", () => {
  it("selects orchestrator + helper above threshold; excludes builder, below-threshold, non-idle, offline", () => {
    const agents: AgentEntry[] = [
      orch("friday"), // idle, above threshold -> SELECTED
      helper("scout"), // idle, above threshold -> SELECTED
      builder("bob"), // builder type -> EXCLUDED (even above threshold + idle)
      orch("busy"), // live status 'working' -> EXCLUDED
      orch("offline"), // no live worker (null) -> EXCLUDED
      orch("light"), // idle live, but below threshold -> EXCLUDED
      orch("stalled-reg", "stalled"), // registry status not idle -> EXCLUDED
    ];
    const liveStatus = new Map<string, "idle" | "working" | null>([
      ["friday", "idle"],
      ["scout", "idle"],
      ["bob", "idle"],
      ["busy", "working"],
      ["offline", null],
      ["light", "idle"],
      ["stalled-reg", null],
    ]);
    const usageByAgent = new Map<string, number>([
      ["friday", 75_000],
      ["scout", 90_000],
      ["bob", 120_000],
      ["busy", 200_000],
      ["offline", 150_000],
      ["light", 12_000], // below 60K
      ["stalled-reg", 99_000],
    ]);

    const targets = selectSweepTargets(agents, liveStatus, usageByAgent, cfg);

    // EXACT candidate list — order follows the agents array.
    expect(targets).toEqual([
      { name: "friday", type: "orchestrator", estimatedContext: 75_000 },
      { name: "scout", type: "helper", estimatedContext: 90_000 },
    ]);
  });

  it("excludes an agent exactly AT the threshold (strict `>` comparison)", () => {
    const agents = [orch("edge")];
    const liveStatus = new Map<string, "idle" | "working" | null>([["edge", "idle"]]);
    // 60_000 is the default threshold; estimate === threshold must NOT select.
    const usageByAgent = new Map<string, number>([["edge", 60_000]]);
    expect(selectSweepTargets(agents, liveStatus, usageByAgent, cfg)).toEqual([]);
  });

  it("treats a missing usage entry as 0 (never selected)", () => {
    const agents = [orch("no-usage")];
    const liveStatus = new Map<string, "idle" | "working" | null>([["no-usage", "idle"]]);
    const usageByAgent = new Map<string, number>(); // no entry
    expect(selectSweepTargets(agents, liveStatus, usageByAgent, cfg)).toEqual([]);
  });

  it("ISOLATES the registry-side gate: registry 'stalled' but live 'idle' + above threshold is EXCLUDED", () => {
    // The combined test above sets stalled-reg's liveStatus to null, so both
    // the registry gate and the live gate independently exclude it — deleting
    // the registry check would still pass. Here live IS idle, so ONLY the
    // registry-status gate can exclude it: this case fails if that gate is
    // removed.
    const agents = [orch("stalled-but-live-idle", "stalled")];
    const liveStatus = new Map<string, "idle" | "working" | null>([
      ["stalled-but-live-idle", "idle"],
    ]);
    const usageByAgent = new Map<string, number>([["stalled-but-live-idle", 99_000]]);
    expect(selectSweepTargets(agents, liveStatus, usageByAgent, cfg)).toEqual([]);
  });
});

/* ----------------------- imperative tick (integration) ----------------------- */

let handle: TestDbHandle;
let registry: typeof import("../agent/registry.js");
let lifecycle: typeof import("../agent/lifecycle.js");
let blockInjectors: typeof import("../agent/block-injectors.js");
let log: typeof import("../log.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "compaction_sweep" });
  registry = await import("../agent/registry.js");
  lifecycle = await import("../agent/lifecycle.js");
  blockInjectors = await import("../agent/block-injectors.js");
  log = await import("../log.js");
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  __resetLastSweepForTest();
});

afterEach(() => {
  // Drop any fake live workers + restore spies between cases.
  for (const name of lifecycle.liveAgentNames()) {
    lifecycle.__deleteLiveWorkerForTest(name);
  }
  vi.restoreAllMocks();
});

/** A partial LiveWorker sufficient for peekLiveWorker (reads status/
 *  lastHeartbeat/agentType/turnId only) — cast through `as never` to install. */
function fakeLiveWorker(
  agentName: string,
  status: "idle" | "working",
  agentType: AgentEntry["type"] = "orchestrator",
): void {
  lifecycle.__putLiveWorkerForTest(agentName, {
    agentName,
    agentType,
    status,
    turnId: `t_${agentName}`,
    lastHeartbeat: Date.now(),
  } as never);
}

async function seedUsage(
  agentName: string,
  sessionId: string,
  contextTokens: number,
): Promise<void> {
  // estimateContextTokens = input + cacheCreation + cacheRead. Spread the
  // tokens across the three so the SUM equals the intended estimate; output
  // is deliberately non-zero to prove it's NOT counted.
  await insertUsage({
    timestamp: new Date().toISOString(),
    sessionId,
    agentName,
    agentType: "orchestrator",
    model: "claude-opus-4-8",
    costUsd: 0.5,
    inputTokens: Math.floor(contextTokens / 3),
    outputTokens: 9_999, // must NOT enter the estimate
    cacheCreationTokens: Math.floor(contextTokens / 3),
    cacheReadTokens: contextTokens - 2 * Math.floor(contextTokens / 3),
  });
}

describe("__runSweepForTest (imperative tick against scratch Postgres)", () => {
  it("dispatches /compact to the eligible idle orchestrator only; skips builder/working/offline/below-threshold", async () => {
    // Eligible: idle orchestrator, session s-friday, ~90K context.
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    await registry.setSession("friday", "s-friday");
    await seedUsage("friday", "s-friday", 90_000);
    fakeLiveWorker("friday", "idle");

    // Builder — never swept regardless of context/idle.
    await registry.registerAgent({
      name: "bob",
      type: "builder",
      parentName: "friday",
      worktreePath: "/tmp/wt",
    });
    await registry.setSession("bob", "s-bob");
    await seedUsage("bob", "s-bob", 150_000);
    fakeLiveWorker("bob", "idle", "builder");

    // Working orchestrator — live status 'working' excludes it.
    await registry.registerAgent({ name: "busy", type: "orchestrator" });
    await registry.setSession("busy", "s-busy");
    await registry.setStatus("busy", "working");
    await seedUsage("busy", "s-busy", 200_000);
    fakeLiveWorker("busy", "working");

    // Offline orchestrator — registered + above threshold but no live worker.
    await registry.registerAgent({ name: "offline", type: "orchestrator" });
    await registry.setSession("offline", "s-offline");
    await seedUsage("offline", "s-offline", 180_000);
    // intentionally NO fakeLiveWorker

    // Idle orchestrator below threshold — excluded by the 60K gate.
    await registry.registerAgent({ name: "light", type: "orchestrator" });
    await registry.setSession("light", "s-light");
    await seedUsage("light", "s-light", 20_000);
    fakeLiveWorker("light", "idle");

    const dispatchSpy = vi.spyOn(lifecycle, "dispatchTurn").mockImplementation(() => {});
    const recordSpy = vi.spyOn(blockInjectors, "recordUserBlock");
    const logSpy = vi.spyOn(log.logger, "log");

    await __runSweepForTest(at(3, 30));

    // Exactly one dispatch — for `friday`.
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const dispatchArg = dispatchSpy.mock.calls[0]![0];
    expect(dispatchArg.agentName).toBe("friday");
    expect(dispatchArg.options.prompt.startsWith("/compact ")).toBe(true);
    expect(dispatchArg.options.prompt).toBe(`/compact ${COMPACT_CUSTOM_INSTRUCTIONS}`);
    expect(dispatchArg.options.mode).toBe("long-lived");
    expect(dispatchArg.options.resumeSessionId).toBe("s-friday");
    expect(dispatchArg.options.agentType).toBe("orchestrator");

    // Never dispatched for the excluded agents.
    const dispatchedNames = dispatchSpy.mock.calls.map((c) => c[0].agentName);
    expect(dispatchedNames).not.toContain("bob");
    expect(dispatchedNames).not.toContain("busy");
    expect(dispatchedNames).not.toContain("offline");
    expect(dispatchedNames).not.toContain("light");

    // The originating user block was recorded with the dedicated source and a
    // SHORT display label — NOT the full persona-instruction body. The worker
    // still receives the complete `/compact ${COMPACT_CUSTOM_INSTRUCTIONS}`
    // body (asserted on `dispatchArg.options.prompt` above); only the rendered
    // user bubble is abbreviated so the chat doesn't accumulate a verbose block
    // next to the divider every night.
    expect(recordSpy).toHaveBeenCalledTimes(1);
    const recordArg = recordSpy.mock.calls[0]![0];
    expect(recordArg).toMatchObject({
      agentName: "friday",
      sessionId: "s-friday",
      source: "compaction_sweep",
      text: "/compact (nightly maintenance)",
    });
    // The recorded short label must NOT carry the full instruction body.
    expect(recordArg.text).not.toContain(COMPACT_CUSTOM_INSTRUCTIONS);
    // The recorded block + the dispatched turn share a turn id (FRI-71).
    expect(recordArg.turnId).toBe(dispatchArg.options.turnId);

    // Log lines: started{targetCount:1} + dispatched{agent:'friday'}.
    const startedLog = logSpy.mock.calls.find((c) => c[1] === "worker.compact.sweep.started");
    expect(startedLog).toBeDefined();
    expect(startedLog![2]).toMatchObject({ targetCount: 1 });
    const dispatchedLog = logSpy.mock.calls.find((c) => c[1] === "worker.compact.sweep.dispatched");
    expect(dispatchedLog).toBeDefined();
    expect(dispatchedLog![2]).toMatchObject({
      agent: "friday",
      estimate: 90_000,
      threshold: 60_000,
    });
  });

  it("no-ops entirely (no dispatch, no started log) when the clock is before 03:30", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    await registry.setSession("friday", "s-friday");
    await seedUsage("friday", "s-friday", 90_000);
    fakeLiveWorker("friday", "idle");

    const dispatchSpy = vi.spyOn(lifecycle, "dispatchTurn").mockImplementation(() => {});
    const logSpy = vi.spyOn(log.logger, "log");

    await __runSweepForTest(at(2, 0)); // before the window

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.find((c) => c[1] === "worker.compact.sweep.started")).toBeUndefined();
  });

  it("excludes a working live agent end to end (live-idle gate): no dispatch, targetCount 0", async () => {
    // A working live worker — above threshold — must never be swept. This pins
    // the live-idle gate through the full runSweep pass (selection builds the
    // liveStatus map from peekLiveWorker, which reports 'working').
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    await registry.setSession("friday", "s-friday");
    await seedUsage("friday", "s-friday", 90_000);
    fakeLiveWorker("friday", "working");
    // Registry status must also be 'working' so the registry-side gate agrees
    // (idle→working is a legal transition).
    await registry.setStatus("friday", "working");

    const dispatchSpy = vi.spyOn(lifecycle, "dispatchTurn").mockImplementation(() => {});
    const recordSpy = vi.spyOn(blockInjectors, "recordUserBlock");
    const logSpy = vi.spyOn(log.logger, "log");

    await __runSweepForTest(at(3, 30));

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(recordSpy).not.toHaveBeenCalled();
    const startedLog = logSpy.mock.calls.find((c) => c[1] === "worker.compact.sweep.started");
    expect(startedLog).toBeDefined();
    expect(startedLog![2]).toMatchObject({ targetCount: 0 });
  });

  it("scopes the context estimate to the agent's CURRENT session (a stale old session can't trigger a sweep)", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    // Current session is fresh + small; an OLD session has huge tokens.
    await registry.setSession("friday", "s-current");
    await seedUsage("friday", "s-old", 500_000); // stale session, above threshold
    await seedUsage("friday", "s-current", 10_000); // current session, below threshold
    fakeLiveWorker("friday", "idle");

    const dispatchSpy = vi.spyOn(lifecycle, "dispatchTurn").mockImplementation(() => {});

    await __runSweepForTest(at(3, 30));

    // The sweep must read s-current (10K, below threshold) — NOT the 500K stale
    // session — so nothing dispatches.
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("re-entrancy guard: an overlapping pass is a clean no-op (no second selection/dispatch) until the first finishes", async () => {
    // `lastSweepAt` is written only at the END of a pass, so a second tick that
    // fires while the first is parked mid-flight would re-pass `isSweepDue` and
    // re-select/re-dispatch the same agent absent the guard. Park pass A inside
    // its first await (`listAgents`) via a deferred promise, run pass B fully
    // while A is suspended, then release A. The guard must make B a no-op.
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    await registry.setSession("friday", "s-friday");
    await seedUsage("friday", "s-friday", 90_000);
    fakeLiveWorker("friday", "idle");

    let releaseA: (v: AgentEntry[]) => void;
    const parkedA = new Promise<AgentEntry[]>((resolve) => {
      releaseA = resolve;
    });
    const realList = registry.listAgents;
    let listCalls = 0;
    const listSpy = vi.spyOn(registry, "listAgents").mockImplementation(async () => {
      listCalls += 1;
      // First call (pass A) parks until released; any later call resolves now.
      return listCalls === 1 ? parkedA : realList();
    });
    const dispatchSpy = vi.spyOn(lifecycle, "dispatchTurn").mockImplementation(() => {});
    const recordSpy = vi.spyOn(blockInjectors, "recordUserBlock");

    // Pass A: enters the guard, awaits the parked listAgents — do NOT await it.
    const passA = __runSweepForTest(at(3, 30));
    // Let A advance into its first await so `sweepRunning` is set.
    await Promise.resolve();

    // Pass B: fires while A is parked. The guard must bail it out BEFORE it
    // reaches its own `listAgents` — so listAgents is still called exactly once.
    await __runSweepForTest(at(3, 30));
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(recordSpy).not.toHaveBeenCalled();

    // Release A and let it finish: exactly one dispatch total.
    releaseA!(await realList());
    await passA;
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy.mock.calls[0]![0].agentName).toBe("friday");
    expect(recordSpy).toHaveBeenCalledTimes(1);
  });

  it("race re-check: a target idle at selection but working at dispatch is SKIPPED (logged, not dispatched)", async () => {
    // The agent is idle when `buildLiveStatus()` snapshots it (so it gets
    // selected), then a turn starts before the per-target dispatch — the
    // re-check sees 'working' and skips it. Drive the flip by stubbing
    // peekLiveWorker: idle for the selection-phase call, working thereafter.
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    await registry.setSession("friday", "s-friday");
    await seedUsage("friday", "s-friday", 90_000);
    fakeLiveWorker("friday", "idle");

    let calls = 0;
    vi.spyOn(lifecycle, "peekLiveWorker").mockImplementation((name: string) => {
      calls += 1;
      // First call (buildLiveStatus) → idle, so it's selected; subsequent
      // calls (the per-target race re-check) → working, so it's skipped.
      const status = calls === 1 ? "idle" : "working";
      return { status, lastHeartbeat: Date.now(), agentType: "orchestrator", turnId: `t_${name}` };
    });
    const dispatchSpy = vi.spyOn(lifecycle, "dispatchTurn").mockImplementation(() => {});
    const recordSpy = vi.spyOn(blockInjectors, "recordUserBlock");
    const logSpy = vi.spyOn(log.logger, "log");

    await __runSweepForTest(at(3, 30));

    // Selected (targetCount 1) but skipped at dispatch — no turn, no block.
    const startedLog = logSpy.mock.calls.find((c) => c[1] === "worker.compact.sweep.started");
    expect(startedLog![2]).toMatchObject({ targetCount: 1 });
    const skippedLog = logSpy.mock.calls.find((c) => c[1] === "worker.compact.sweep.skipped");
    expect(skippedLog).toBeDefined();
    expect(skippedLog![2]).toMatchObject({ agent: "friday", reason: "no-longer-idle" });
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(recordSpy).not.toHaveBeenCalled();
  });
});
