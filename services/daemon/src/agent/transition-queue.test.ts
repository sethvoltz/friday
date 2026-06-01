/**
 * FRI-145 M1 — agent-keyed Transition queue.
 *
 * The queue is the agent-keyed successor to the per-worker `ipcChain`. These
 * tests pin the three invariants the rest of the refactor depends on:
 *
 *   (a) concurrent enqueues for ONE agent name apply in strict submission
 *       order, even when each Transition resolves asynchronously and out of
 *       wall-clock order (a fast Transition enqueued second must NOT overtake
 *       a slow one enqueued first);
 *   (b) enqueues for DIFFERENT agent names run independently — a slow
 *       Transition on name A does not head-of-line-block name B;
 *   (c) a throwing/rejecting Transition does not wedge the queue for its key —
 *       the next Transition for that name still runs.
 *
 * Plus the AC #1 cross-generation case: two worker generations for the SAME
 * agent name serialize their Transitions in strict enqueue order
 * (genA-exit then genB-spawn), which is the whole point of keying by name
 * instead of by worker instance.
 *
 * These exercise the real control flow of `enqueueTransition` — no mock of the
 * function under test. The Transitions themselves are fakes that record their
 * effect onto a shared log; assertions pin the exact ordered log.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  enqueueTransition,
  enqueueTransitionResult,
  transitionQueues,
  _resetTransitionQueuesForTest,
} from "./transition-queue.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  _resetTransitionQueuesForTest();
});

describe("transition-queue (FRI-145 M1)", () => {
  it("(a) concurrent enqueues for ONE agent name apply in strict submission order", async () => {
    const order: string[] = [];
    const name = "alpha";

    // Enqueue four Transitions whose async durations are DESCENDING, so if the
    // queue let them race, wall-clock completion would be the reverse of
    // submission order. Strict serialization must produce submission order.
    const p1 = enqueueTransition(name, async () => {
      await delay(40);
      order.push("t1");
    });
    const p2 = enqueueTransition(name, async () => {
      await delay(30);
      order.push("t2");
    });
    const p3 = enqueueTransition(name, async () => {
      await delay(20);
      order.push("t3");
    });
    const p4 = enqueueTransition(name, async () => {
      await delay(10);
      order.push("t4");
    });

    await Promise.all([p1, p2, p3, p4]);

    expect(order).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("(b) enqueues for DIFFERENT agent names run concurrently (interleaving allowed)", async () => {
    const order: string[] = [];

    // A's Transition is slow; B's is fast. If the two names shared a chain, B
    // would have to wait for A (order would be ["A","B"]). Independent chains
    // let B's fast Transition finish first → ["B","A"]. We assert B-before-A
    // to prove they are NOT serialized against each other.
    const pA = enqueueTransition("agent-A", async () => {
      await delay(40);
      order.push("A");
    });
    const pB = enqueueTransition("agent-B", async () => {
      await delay(5);
      order.push("B");
    });

    await Promise.all([pA, pB]);

    expect(order).toEqual(["B", "A"]);
  });

  it("(c) a throwing transition does not wedge the queue for that key", async () => {
    const order: string[] = [];
    const name = "gamma";

    // First Transition throws synchronously; second rejects asynchronously;
    // third must still run. The queue catches + logs both failures and
    // proceeds. enqueueTransition never re-throws, so awaiting the failing
    // links resolves (does not reject) — assert that directly.
    const pThrowSync = enqueueTransition(name, () => {
      order.push("before-throw");
      throw new Error("boom-sync");
    });
    const pRejectAsync = enqueueTransition(name, async () => {
      await delay(5);
      throw new Error("boom-async");
    });
    const pSurvivor = enqueueTransition(name, () => {
      order.push("survivor");
    });

    await expect(pThrowSync).resolves.toBeUndefined();
    await expect(pRejectAsync).resolves.toBeUndefined();
    await pSurvivor;

    // The throwing Transition's pre-throw side effect happened, the survivor
    // ran AFTER both failures, and the failures did not stop the chain.
    expect(order).toEqual(["before-throw", "survivor"]);
  });

  it("AC #1: two generations for the same name serialize in strict enqueue order", async () => {
    const order: string[] = [];
    const name = "delta";

    // Generation A's `exit` Transition is enqueued first and is slow (mimics a
    // late exit IPC whose DB writes take a while). Generation B's `spawn`
    // Transition is enqueued after and is fast. Because both are keyed by the
    // same agent NAME, gen-B-spawn must NOT overtake gen-A-exit — this is the
    // cross-generation guarantee the old per-worker `ipcChain` could not give.
    const genAExit = enqueueTransition(name, async () => {
      await delay(30);
      order.push("genA-exit");
    });
    const genBSpawn = enqueueTransition(name, async () => {
      await delay(0);
      order.push("genB-spawn");
    });

    await Promise.all([genAExit, genBSpawn]);

    expect(order).toEqual(["genA-exit", "genB-spawn"]);
  });

  it("self-prunes the map entry once a name's chain fully settles", async () => {
    const name = "epsilon";

    const p = enqueueTransition(name, async () => {
      await delay(5);
    });

    // While in flight, the chain tail is resident.
    expect(transitionQueues.has(name)).toBe(true);

    await p;
    // The self-prune runs in a microtask chained off the settle; flush it.
    await Promise.resolve();
    await Promise.resolve();

    expect(transitionQueues.has(name)).toBe(false);
  });

  it("FRI-145 M4: enqueueTransitionResult resolves with the transition's real value", async () => {
    const name = "result-ok";
    const value = await enqueueTransitionResult(name, async () => {
      await delay(5);
      return 42;
    });
    expect(value).toBe(42);
  });

  it("FRI-145 M4: enqueueTransitionResult REJECTS with the real error (caller sees the FSM throw)", async () => {
    const name = "result-throws";
    const order: string[] = [];

    // The archive channel relies on this: an orchestrator-not-archivable
    // IllegalTransitionError must propagate to the awaiting caller, NOT be
    // swallowed like the fire-and-forget enqueueTransition does.
    const failing = enqueueTransitionResult(name, async () => {
      order.push("failing");
      throw new Error("ORCHESTRATOR_NOT_ARCHIVABLE");
    });
    await expect(failing).rejects.toThrow(/ORCHESTRATOR_NOT_ARCHIVABLE/);

    // …and the rejection does NOT wedge the chain: a later Transition for the
    // same key still runs serialized after the failing one.
    const survivor = enqueueTransitionResult(name, async () => {
      order.push("survivor");
      return "ok";
    });
    await expect(survivor).resolves.toBe("ok");
    expect(order).toEqual(["failing", "survivor"]);
  });

  it("FRI-145 M4: enqueueTransitionResult serializes behind a prior enqueueTransition for the same key", async () => {
    const name = "result-serialize";
    const order: string[] = [];

    // A fire-and-forget enqueueTransition (slow) then a result-bearing enqueue
    // (fast) for the SAME key: the result-bearing one must wait — proving the
    // two enqueue variants share one chain per key.
    const first = enqueueTransition(name, async () => {
      await delay(30);
      order.push("first");
    });
    const second = enqueueTransitionResult(name, async () => {
      await delay(0);
      order.push("second");
      return "done";
    });

    const [, secondVal] = await Promise.all([first, second]);
    expect(secondVal).toBe("done");
    expect(order).toEqual(["first", "second"]);
  });

  it("does NOT prune a name whose chain has a later pending Transition", async () => {
    const name = "zeta";
    const order: string[] = [];

    const first = enqueueTransition(name, async () => {
      await delay(10);
      order.push("first");
    });
    // Enqueue a second BEFORE the first settles: the first's self-prune must
    // see the tail is no longer its own link and leave the entry alone so the
    // second still runs serialized after the first.
    const second = enqueueTransition(name, async () => {
      await delay(10);
      order.push("second");
    });

    // Entry stays resident while work is pending.
    expect(transitionQueues.has(name)).toBe(true);

    await Promise.all([first, second]);
    await Promise.resolve();
    await Promise.resolve();

    // Both ran, in order, and only after the whole chain drained did it prune.
    expect(order).toEqual(["first", "second"]);
    expect(transitionQueues.has(name)).toBe(false);
  });
});
