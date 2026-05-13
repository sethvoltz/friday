/**
 * Unit test for M5's turn-stall detector. Decoupled from the real live map
 * and from real subprocesses — we pass synthetic StallCandidate rows and
 * a spy `kill` callback. Verifies the predicate matches the plan: workers
 * in `working` status that haven't seen a block-stop within the threshold
 * get SIGTERM'd; idle workers don't; recently-progressing workers don't.
 */

import { describe, expect, it, vi } from "vitest";
import { checkStalledWorkers, type StallCandidate } from "./lifecycle.js";

const MIN = 60_000;

describe("M5: checkStalledWorkers", () => {
  it("kills a working worker that hasn't progressed within threshold", () => {
    const now = 10 * MIN;
    const w: StallCandidate = {
      agentName: "alpha",
      turnId: "t-1",
      pgid: 12345,
      status: "working",
      lastBlockStop: now - 31 * MIN, // 31 min ago > 30 min threshold
    };
    const kill = vi.fn();
    const terminated = checkStalledWorkers([w], now, 30 * MIN, kill);
    expect(terminated).toEqual(["alpha"]);
    expect(kill).toHaveBeenCalledWith(12345, "SIGTERM");
  });

  it("does not kill a working worker that progressed recently", () => {
    const now = 10 * MIN;
    const w: StallCandidate = {
      agentName: "alpha",
      turnId: "t-1",
      pgid: 12345,
      status: "working",
      lastBlockStop: now - 1 * MIN,
    };
    const kill = vi.fn();
    const terminated = checkStalledWorkers([w], now, 30 * MIN, kill);
    expect(terminated).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not kill an idle worker even if it hasn't progressed in hours", () => {
    const now = 10 * MIN;
    const w: StallCandidate = {
      agentName: "alpha",
      turnId: "t-1",
      pgid: 12345,
      status: "idle", // idle workers aren't running anything to stall
      lastBlockStop: now - 24 * 60 * MIN,
    };
    const kill = vi.fn();
    const terminated = checkStalledWorkers([w], now, 30 * MIN, kill);
    expect(terminated).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("resets lastBlockStop after firing so we don't re-fire on the next tick", () => {
    const now = 10 * MIN;
    const w: StallCandidate = {
      agentName: "alpha",
      turnId: "t-1",
      pgid: 12345,
      status: "working",
      lastBlockStop: now - 31 * MIN,
    };
    const kill = vi.fn();
    checkStalledWorkers([w], now, 30 * MIN, kill);
    expect(w.lastBlockStop).toBe(now);
  });

  it("processes multiple workers and only kills the stalled ones", () => {
    const now = 10 * MIN;
    const ws: StallCandidate[] = [
      {
        agentName: "stuck",
        turnId: "t-1",
        pgid: 1001,
        status: "working",
        lastBlockStop: now - 31 * MIN,
      },
      {
        agentName: "fine",
        turnId: "t-2",
        pgid: 1002,
        status: "working",
        lastBlockStop: now - 5 * MIN,
      },
      {
        agentName: "idle",
        turnId: "t-3",
        pgid: 1003,
        status: "idle",
        lastBlockStop: now - 99 * MIN,
      },
      {
        agentName: "stuck2",
        turnId: "t-4",
        pgid: 1004,
        status: "working",
        lastBlockStop: now - 60 * MIN,
      },
    ];
    const kill = vi.fn();
    const terminated = checkStalledWorkers(ws, now, 30 * MIN, kill);
    expect(terminated.sort()).toEqual(["stuck", "stuck2"]);
    const terminatedPgids = kill.mock.calls
      .filter((c) => c[1] === "SIGTERM")
      .map((c) => c[0])
      .sort((a, b) => a - b);
    expect(terminatedPgids).toEqual([1001, 1004]);
  });
});
