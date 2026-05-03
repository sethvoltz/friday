import { describe, it, expect, beforeEach } from "vitest";
import {
  enqueueTurn,
  isProcessing,
  _resetTurnQueue,
} from "./turn-queue.js";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
}

function defer(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yield enough microtasks for the queue's drainLoop to advance. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("turn-queue — serialization", () => {
  beforeEach(() => {
    _resetTurnQueue();
  });

  it("two enqueues for the same channel run sequentially", async () => {
    const order: string[] = [];
    const d1 = defer();
    const d2 = defer();

    enqueueTurn({
      channelId: "C1",
      source: "slack",
      run: async () => {
        order.push("t1-start");
        await d1.promise;
        order.push("t1-end");
      },
    });
    enqueueTurn({
      channelId: "C1",
      source: "mail",
      run: async () => {
        order.push("t2-start");
        await d2.promise;
        order.push("t2-end");
      },
    });

    await flush();
    expect(order).toEqual(["t1-start"]);
    expect(isProcessing("C1")).toBe(true);

    d1.resolve();
    await flush();
    expect(order).toEqual(["t1-start", "t1-end", "t2-start"]);

    d2.resolve();
    await flush();
    expect(order).toEqual(["t1-start", "t1-end", "t2-start", "t2-end"]);
    expect(isProcessing("C1")).toBe(false);
  });

  it("enqueues for different channels run in parallel", async () => {
    const order: string[] = [];
    const d1 = defer();
    const d2 = defer();

    enqueueTurn({
      channelId: "A",
      source: "slack",
      run: async () => {
        order.push("a-start");
        await d1.promise;
        order.push("a-end");
      },
    });
    enqueueTurn({
      channelId: "B",
      source: "slack",
      run: async () => {
        order.push("b-start");
        await d2.promise;
        order.push("b-end");
      },
    });

    await flush();
    expect(order).toEqual(["a-start", "b-start"]);

    d2.resolve();
    await flush();
    expect(order).toEqual(["a-start", "b-start", "b-end"]);

    d1.resolve();
    await flush();
    expect(order).toEqual(["a-start", "b-start", "b-end", "a-end"]);
  });
});

describe("turn-queue — coalescing", () => {
  beforeEach(() => {
    _resetTurnQueue();
  });

  it("same-source same-priority queued triggers coalesce to one run", async () => {
    const runs: string[] = [];
    const inflight = defer();

    // First trigger occupies the in-flight slot
    enqueueTurn({
      channelId: "C1",
      source: "slack",
      label: "first",
      run: async () => {
        runs.push("first");
        await inflight.promise;
      },
    });
    await flush();

    // These two are queued — second should coalesce against the first queued one
    enqueueTurn({
      channelId: "C1",
      source: "slack",
      label: "second",
      run: async () => {
        runs.push("second");
      },
    });
    enqueueTurn({
      channelId: "C1",
      source: "slack",
      label: "third",
      run: async () => {
        runs.push("third");
      },
    });

    inflight.resolve();
    await flush();

    expect(runs).toEqual(["first", "second"]);
  });

  it("different sources do not coalesce", async () => {
    const runs: string[] = [];
    const inflight = defer();

    enqueueTurn({
      channelId: "C1",
      source: "slack",
      run: async () => {
        runs.push("slack-1");
        await inflight.promise;
      },
    });
    await flush();

    enqueueTurn({
      channelId: "C1",
      source: "mail",
      run: async () => {
        runs.push("mail");
      },
    });
    enqueueTurn({
      channelId: "C1",
      source: "slack",
      run: async () => {
        runs.push("slack-2");
      },
    });

    inflight.resolve();
    await flush();

    expect(runs).toEqual(["slack-1", "mail", "slack-2"]);
  });
});

describe("turn-queue — urgent priority", () => {
  beforeEach(() => {
    _resetTurnQueue();
  });

  it("urgent enqueue front-inserts but does not preempt the in-flight run", async () => {
    const runs: string[] = [];
    const inflight = defer();

    // In-flight trigger
    enqueueTurn({
      channelId: "C1",
      source: "slack",
      run: async () => {
        runs.push("inflight");
        await inflight.promise;
      },
    });
    await flush();

    // Queue normal mail and normal slack behind
    enqueueTurn({
      channelId: "C1",
      source: "mail",
      run: async () => {
        runs.push("normal-mail");
      },
    });
    enqueueTurn({
      channelId: "C1",
      source: "slack",
      run: async () => {
        runs.push("normal-slack");
      },
    });

    // Urgent mail arrives — should front-insert
    enqueueTurn({
      channelId: "C1",
      source: "mail",
      priority: "urgent",
      run: async () => {
        runs.push("urgent-mail");
      },
    });

    // In-flight is NOT preempted
    expect(runs).toEqual(["inflight"]);

    inflight.resolve();
    await flush();

    expect(runs).toEqual([
      "inflight",
      "urgent-mail",
      "normal-mail",
      "normal-slack",
    ]);
  });

  it("urgent triggers are never coalesced", async () => {
    const runs: string[] = [];
    const inflight = defer();

    enqueueTurn({
      channelId: "C1",
      source: "slack",
      run: async () => {
        runs.push("inflight");
        await inflight.promise;
      },
    });
    await flush();

    enqueueTurn({
      channelId: "C1",
      source: "mail",
      priority: "urgent",
      label: "u1",
      run: async () => {
        runs.push("u1");
      },
    });
    enqueueTurn({
      channelId: "C1",
      source: "mail",
      priority: "urgent",
      label: "u2",
      run: async () => {
        runs.push("u2");
      },
    });

    inflight.resolve();
    await flush();

    expect(runs).toContain("u1");
    expect(runs).toContain("u2");
  });
});

describe("turn-queue — error handling", () => {
  beforeEach(() => {
    _resetTurnQueue();
  });

  it("a throwing run does not deadlock the lane", async () => {
    const runs: string[] = [];

    enqueueTurn({
      channelId: "C1",
      source: "slack",
      run: async () => {
        runs.push("first");
        throw new Error("boom");
      },
    });
    enqueueTurn({
      channelId: "C1",
      source: "mail",
      run: async () => {
        runs.push("second");
      },
    });

    await flush();
    expect(runs).toEqual(["first", "second"]);
    expect(isProcessing("C1")).toBe(false);
  });
});
