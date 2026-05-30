/**
 * Lost-wakeup regression: a `prompt` IPC that lands while the worker is mid
 * inbox-poll must be serviced, never parked-over or clobbered by mail.
 *
 * The daemon drains its queue immediately on turn-complete and sends the next
 * prompt ~25ms later — almost always while the worker's between-turns loop is
 * inside `await fetchInboxQuiet()`. `wakeIdle()` is a no-op there (idleResolve
 * isn't set yet), so the wakeup is lost. Before the fix the loop then emitted
 * `status-change: idle` and parked on the 60s timeout, leaving `pendingPrompt`
 * unserviced; the user re-sent, the re-send overwrote `pendingPrompt`, and the
 * original turn ended with zero assistant blocks — the dashboard's "Agent
 * didn't respond" with the queued message absent from the model's context.
 *
 * Verified in prod from daemon.jsonl + the blocks table on 2026-05-29:
 * turn t_1ec20fa5 drained (`worker.status.transition … source:"sendPrompt"`),
 * the worker emitted `working` then `idle` 54ms later with NO turn-complete and
 * NO error IPC, and the turn's only block in Postgres was the user's text.
 */

import { describe, expect, it } from "vitest";
import { nextBetweenTurnsAction, resolveBetweenTurnsStep } from "./worker.js";

describe("nextBetweenTurnsAction (lost-wakeup guard)", () => {
  it("services a prompt that arrived during the poll, even with mail waiting", () => {
    // The core bug: mail in the inbox must NOT clobber a freshly-arrived
    // user prompt.
    expect(nextBetweenTurnsAction({ hasPendingPrompt: true, stopped: false, inboxCount: 3 })).toBe(
      "loop",
    );
  });

  it("does not park when a prompt is pending and the inbox is empty", () => {
    expect(nextBetweenTurnsAction({ hasPendingPrompt: true, stopped: false, inboxCount: 0 })).toBe(
      "loop",
    );
  });

  it("builds a mail turn when genuinely idle with mail waiting", () => {
    expect(nextBetweenTurnsAction({ hasPendingPrompt: false, stopped: false, inboxCount: 2 })).toBe(
      "mail",
    );
  });

  it("parks when genuinely idle: no pending prompt, no mail", () => {
    expect(nextBetweenTurnsAction({ hasPendingPrompt: false, stopped: false, inboxCount: 0 })).toBe(
      "park",
    );
  });

  it("loops (does not park 60s) when stop arrived during the poll", () => {
    // `stop` also wakes via wakeIdle and is lost the same way; parking would
    // delay shutdown by up to 60s. Returning "loop" lets `while (!stopped)`
    // exit promptly.
    expect(nextBetweenTurnsAction({ hasPendingPrompt: false, stopped: true, inboxCount: 0 })).toBe(
      "loop",
    );
  });

  it("prioritizes a pending prompt over both mail and stop", () => {
    expect(nextBetweenTurnsAction({ hasPendingPrompt: true, stopped: true, inboxCount: 5 })).toBe(
      "loop",
    );
  });
});

// These exercise the ORDERING, not just the decision table: a prompt/stop that
// arrives WHILE the inbox poll is in flight must still be observed. The pure
// table above can't catch a regression that snapshots the pending flag before
// the await — these can, because the injected `fetchInbox` flips the flag
// mid-poll exactly as a `prompt` IPC would.
describe("resolveBetweenTurnsStep (post-await read — the actual fix)", () => {
  it("services a prompt that lands DURING the inbox poll (not park)", async () => {
    let pending = false;
    const { action } = await resolveBetweenTurnsStep({
      isPromptPending: () => pending,
      isStopped: () => false,
      // Simulate the `prompt` IPC arriving mid-fetch: its handler sets
      // `pendingPrompt` but `wakeIdle()` is lost. Empty inbox so the only
      // signal is the freshly-set pending flag.
      fetchInbox: async () => {
        pending = true;
        return [];
      },
    });
    expect(action).toBe("loop");
  });

  it("does NOT clobber a mid-poll prompt with mail", async () => {
    let pending = false;
    const { action } = await resolveBetweenTurnsStep({
      isPromptPending: () => pending,
      isStopped: () => false,
      // Prompt lands mid-poll AND there's mail waiting — the prompt must win.
      fetchInbox: async () => {
        pending = true;
        return [{}, {}];
      },
    });
    expect(action).toBe("loop");
  });

  it("parks when no prompt arrives during an empty poll", async () => {
    const { action } = await resolveBetweenTurnsStep({
      isPromptPending: () => false,
      isStopped: () => false,
      fetchInbox: async () => [],
    });
    expect(action).toBe("park");
  });

  it("drains mail when idle and the poll returns mail", async () => {
    const { action, inbox } = await resolveBetweenTurnsStep({
      isPromptPending: () => false,
      isStopped: () => false,
      fetchInbox: async () => [{ id: "m1" }],
    });
    expect(action).toBe("mail");
    expect(inbox).toEqual([{ id: "m1" }]);
  });

  it("loops (prompt arriving) over draining mail even when both are present pre-poll", async () => {
    const { action } = await resolveBetweenTurnsStep({
      isPromptPending: () => true,
      isStopped: () => false,
      fetchInbox: async () => [{}],
    });
    expect(action).toBe("loop");
  });
});
