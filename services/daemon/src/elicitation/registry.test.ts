/**
 * FRI-152 registry behavior. Pins the turn-pause property (the load-
 * bearing invariant per the ticket): `register` returns a Promise that
 * stays unresolved until `resolve` fires for the matching id; concurrent
 * waiters are independent; worker abort via `cancel` rejects cleanly.
 *
 * These tests run in the node pool (no daemon, no HTTP). The registry is
 * pure in-memory state, which is exactly the layer the SDK's MCP handler
 * blocks on — so pinning it here pins the architecture invariant without
 * needing to drive a real `query()`.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  __clearForTests,
  cancel,
  hasWaiter,
  pendingCount,
  register,
  resolve,
  type ElicitationAnswer,
} from "./registry.js";

afterEach(() => {
  __clearForTests();
});

const SAMPLE_ANSWER: ElicitationAnswer = {
  answers: {
    "Which size?": { kind: "option", value: "Small" },
  },
};

describe("turn-pause invariant", () => {
  it("register() returns a Promise that does NOT resolve until resolve() fires", async () => {
    const id = "toolu_abc";
    const promise = register(id);
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // Give the microtask queue a chance — the promise must STILL be
    // pending (this is the property the architecture rests on).
    await Promise.resolve();
    await Promise.resolve();
    expect(settled, "promise must stay pending until resolve() is called").toBe(false);
    expect(hasWaiter(id)).toBe(true);
    expect(pendingCount()).toBe(1);

    const ok = resolve(id, SAMPLE_ANSWER);
    expect(ok).toBe(true);
    await expect(promise).resolves.toEqual(SAMPLE_ANSWER);
    expect(hasWaiter(id)).toBe(false);
    expect(pendingCount()).toBe(0);
  });

  it("resolve() returns false for an unknown id (orphaned submit)", () => {
    expect(resolve("never-registered", SAMPLE_ANSWER)).toBe(false);
  });

  it("cancel() rejects the waiter cleanly (worker death path)", async () => {
    const id = "toolu_dead";
    const promise = register(id);
    const cancelled = cancel(id, new Error("client_aborted"));
    expect(cancelled).toBe(true);
    await expect(promise).rejects.toThrow("client_aborted");
    expect(hasWaiter(id)).toBe(false);
  });

  it("cancel() returns false when the id has no waiter (cancel-after-resolve race)", () => {
    const id = "toolu_settled";
    const promise = register(id);
    resolve(id, SAMPLE_ANSWER);
    // Promise has already resolved; the cancel below is a no-op.
    void promise;
    expect(cancel(id, new Error("late"))).toBe(false);
  });
});

describe("concurrent elicitations", () => {
  it("two distinct ids resolve independently in arbitrary order", async () => {
    const a = "toolu_A";
    const b = "toolu_B";
    const pa = register(a);
    const pb = register(b);
    expect(pendingCount()).toBe(2);

    const answerB: ElicitationAnswer = {
      answers: { "Q B?": { kind: "option", value: "B-pick" } },
    };
    expect(resolve(b, answerB)).toBe(true);
    await expect(pb).resolves.toEqual(answerB);
    // A is still pending.
    expect(hasWaiter(a)).toBe(true);
    expect(pendingCount()).toBe(1);

    const answerA: ElicitationAnswer = {
      answers: { "Q A?": { kind: "other", value: "freeform A" } },
    };
    expect(resolve(a, answerA)).toBe(true);
    await expect(pa).resolves.toEqual(answerA);
    expect(pendingCount()).toBe(0);
  });

  it("re-registering the same id rejects the prior waiter (no silent loss)", async () => {
    const id = "toolu_dup";
    const first = register(id);
    const second = register(id);
    await expect(first).rejects.toThrow("re-registered");
    // The second waiter still works; resolving it must not affect anyone else.
    expect(resolve(id, SAMPLE_ANSWER)).toBe(true);
    await expect(second).resolves.toEqual(SAMPLE_ANSWER);
  });
});
