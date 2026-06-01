/**
 * FRI-145 M3 — Turn-state machine core (ports bag) unit tests.
 *
 * The machine (`turn-state-machine.ts`) is a PURE `apply(w, transition, deps)`
 * with NO side effects: it returns `{ state, projection, mutations, intents }`.
 * These tests drive it with a minimal `TurnContext` double + injected `deps`
 * (fixed clock, fixed wedge threshold, deterministic uuid) and pin the EXACT
 * intent payloads + the derived Status projection. Nothing is mocked — the
 * machine has no collaborators to mock; the assertions load-bear on the
 * returned intent list, which is what the executor (and thus prod) acts on.
 */

import { describe, expect, it } from "vitest";
import {
  apply,
  projectStatus,
  type ApplyDeps,
  type Intent,
  type TurnContext,
} from "./turn-state-machine.js";

const DEPS: ApplyDeps = {
  wedgeThreshold: 10,
  now: 5_000,
  uuid: () => "FIXED-UUID",
};

/** Minimal TurnContext double. Defaults are a healthy long-lived orchestrator
 *  turn that produced one block and a turn-start 1s before `DEPS.now`. */
function ctx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    agentName: "agent-1",
    agentType: "orchestrator",
    model: "claude-opus-4-7",
    parentName: undefined,
    turnId: "turn-1",
    sessionId: "sess-1",
    workingDirectory: "/tmp/wd",
    abortRequested: false,
    turnStart: 4_000, // DEPS.now - 1000 → durationMs 1000
    blocksThisTurn: 1,
    zeroBlockTurnStreak: 0,
    mailSendToParentThisTurn: 0,
    noMailBackNudgedThisTurn: false,
    noMailBackStreak: 0,
    nextPrompts: [],
    ...overrides,
  };
}

describe("turn-state-machine: projectStatus", () => {
  it("maps every Turn state onto its resting Status projection", () => {
    expect(projectStatus("working")).toBe("working");
    expect(projectStatus("idle")).toBe("idle");
    // aborting + force-killed are transient — they heal to idle.
    expect(projectStatus("aborting")).toBe("idle");
    expect(projectStatus("force-killed")).toBe("idle");
  });
});

describe("turn-state-machine: complete (AC #3 — intents + projection)", () => {
  it("a clean turn-complete with NO usage and NO queued prompt heals to idle", () => {
    const w = ctx({ blocksThisTurn: 1, sessionId: undefined, nextPrompts: [] });
    // No sessionId on the worker, none in payload → no recover-jsonl / usage.
    const r = apply(w, { kind: "complete", payload: {} }, DEPS);

    expect(r.state).toBe("idle");
    expect(r.projection).toBe("idle");
    // Exact intent list — turn_done, posthog, finalize, end-turn, set-status.
    expect(r.intents).toEqual<Intent[]>([
      {
        kind: "publish-turn-done",
        turnId: "turn-1",
        agent: "agent-1",
        status: "complete",
        usage: undefined,
      },
      {
        kind: "posthog",
        event: "turn_completed",
        properties: {
          agent_name: "agent-1",
          agent_type: "orchestrator",
          model: "claude-opus-4-7",
          turn_id: "turn-1",
          aborted: false,
          duration_ms: 1000,
          input_tokens: null,
          output_tokens: null,
          cache_creation_tokens: null,
          cache_read_tokens: null,
          cost_usd: null,
          zero_block_reason: null,
        },
      },
      { kind: "finalize-blocks", status: "aborted" },
      { kind: "end-turn", turnId: "turn-1" },
      { kind: "set-status", name: "agent-1", status: "idle" },
    ]);
    // Per-turn bookkeeping resets.
    expect(r.mutations).toMatchObject({
      turnStart: undefined,
      blocksThisTurn: 0,
      completedAtLeastOnce: true,
      lastExitStatus: "complete",
    });
  });

  it("a clean turn-complete WITH usage + session emits insert-usage and recover-jsonl in order", () => {
    const usage = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_tokens: 10,
      cache_read_tokens: 5,
      cost_usd: 0.012,
    };
    const r = apply(ctx({ blocksThisTurn: 2 }), { kind: "complete", payload: { usage } }, DEPS);

    // Pin the full ordered shape (AC #3 exact-payload).
    expect(r.intents).toEqual<Intent[]>([
      {
        kind: "publish-turn-done",
        turnId: "turn-1",
        agent: "agent-1",
        status: "complete",
        usage,
      },
      {
        kind: "insert-usage",
        sessionId: "sess-1",
        agentName: "agent-1",
        agentType: "orchestrator",
        model: "claude-opus-4-7",
        usage,
        durationMs: 1000,
      },
      {
        kind: "posthog",
        event: "turn_completed",
        properties: {
          agent_name: "agent-1",
          agent_type: "orchestrator",
          model: "claude-opus-4-7",
          turn_id: "turn-1",
          aborted: false,
          duration_ms: 1000,
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_tokens: 10,
          cache_read_tokens: 5,
          cost_usd: 0.012,
          zero_block_reason: null,
        },
      },
      { kind: "finalize-blocks", status: "aborted" },
      { kind: "end-turn", turnId: "turn-1" },
      { kind: "set-status", name: "agent-1", status: "idle" },
      {
        kind: "recover-jsonl",
        agentName: "agent-1",
        sessionId: "sess-1",
        workingDirectory: "/tmp/wd",
      },
    ]);
    expect(r.state).toBe("idle");
  });

  it("(b) a clean turn-complete with a queued prompt emits send-next as the LAST intent", () => {
    const queued = { prompt: "next please", turnId: "turn-2" };
    const r = apply(
      ctx({ blocksThisTurn: 1, sessionId: undefined, nextPrompts: [queued] }),
      { kind: "complete", payload: {} },
      DEPS,
    );

    // send-next is last and carries the queued prompt verbatim.
    expect(r.intents.at(-1)).toEqual<Intent>({ kind: "send-next", prompt: queued });
    // Exactly one send-next.
    expect(r.intents.filter((i) => i.kind === "send-next")).toHaveLength(1);
    // No force-kill on a healthy turn.
    expect(r.intents.some((i) => i.kind === "force-kill")).toBe(false);
    expect(r.state).toBe("idle");
    expect(r.projection).toBe("idle");
  });

  it("zero-block compaction turn carries zero_block_reason:compaction in turn_done", () => {
    const r = apply(
      ctx({ blocksThisTurn: 0, sessionId: undefined }),
      { kind: "complete", payload: { compactionThisTurn: true } },
      DEPS,
    );
    const done = r.intents.find((i) => i.kind === "publish-turn-done");
    expect(done).toMatchObject({ status: "complete", zeroBlockReason: "compaction" });
  });
});

describe("turn-state-machine: fail (AC #3 — turn_done status error)", () => {
  it("a non-abort error emits record-error-block, finalize error, publish-error, turn_done(error)", () => {
    const r = apply(
      ctx({ blocksThisTurn: 1, sessionId: undefined }),
      {
        kind: "fail",
        payload: { message: "SDK exploded", recoverable: false, code: "boom" },
      },
      DEPS,
    );

    expect(r.state).toBe("idle");
    expect(r.projection).toBe("idle");
    // turn_done status is error (AC #3 second assertion).
    const done = r.intents.find((i) => i.kind === "publish-turn-done");
    expect(done).toEqual<Intent>({
      kind: "publish-turn-done",
      turnId: "turn-1",
      agent: "agent-1",
      status: "error",
    });
    // Ordered prefix: record-error-block → finalize(error) → publish-error → turn_done.
    expect(r.intents.slice(0, 4)).toEqual<Intent[]>([
      {
        kind: "record-error-block",
        payload: {
          code: "boom",
          headline: "SDK exploded",
          httpStatus: undefined,
          retryAfterSeconds: undefined,
          requestId: undefined,
          rawMessage: "SDK exploded",
        },
      },
      { kind: "finalize-blocks", status: "error" },
      {
        kind: "publish-error",
        turnId: "turn-1",
        agent: "agent-1",
        code: "boom",
        message: "SDK exploded",
        recoverable: false,
      },
      {
        kind: "publish-turn-done",
        turnId: "turn-1",
        agent: "agent-1",
        status: "error",
      },
    ]);
    expect(r.mutations.lastExitStatus).toBe("error");
  });

  it("an abort-triggered error skips the error block and marks turn_done aborted+cooperative", () => {
    const r = apply(
      ctx({ blocksThisTurn: 0, sessionId: undefined, abortRequested: true }),
      { kind: "fail", payload: { message: "stopped", recoverable: true } },
      DEPS,
    );
    expect(r.intents.some((i) => i.kind === "record-error-block")).toBe(false);
    const done = r.intents.find((i) => i.kind === "publish-turn-done");
    expect(done).toEqual<Intent>({
      kind: "publish-turn-done",
      turnId: "turn-1",
      agent: "agent-1",
      status: "aborted",
      abortReason: "cooperative",
    });
    // No posthog turn_errored capture on a cooperative abort.
    expect(r.intents.some((i) => i.kind === "posthog")).toBe(false);
  });
});

describe("turn-state-machine: (a) wedge — two consecutive zero-block turns trip force-kill", () => {
  it("a zero-block complete at streak threshold-1 emits a force-kill intent and force-killed state", () => {
    // threshold 2 → the SECOND consecutive zero-block turn (streak goes 1→2)
    // trips. Drive it directly: prior streak 1, this turn zero-block.
    const deps: ApplyDeps = { ...DEPS, wedgeThreshold: 2 };
    // First zero-block turn: streak 0 → 1, NOT tripped.
    const first = apply(
      ctx({ blocksThisTurn: 0, sessionId: undefined, zeroBlockTurnStreak: 0 }),
      { kind: "complete", payload: {} },
      deps,
    );
    expect(first.state).toBe("idle");
    expect(first.mutations.zeroBlockTurnStreak).toBe(1);
    expect(first.intents.some((i) => i.kind === "force-kill")).toBe(false);

    // Second consecutive zero-block turn: streak 1 → 2, TRIPS.
    const second = apply(
      ctx({ blocksThisTurn: 0, sessionId: undefined, zeroBlockTurnStreak: 1 }),
      { kind: "complete", payload: {} },
      deps,
    );
    expect(second.state).toBe("force-killed");
    // No idle projection on the wedge escalation — the caller tears down.
    expect(second.projection).toBeNull();
    // The force-kill intent is present with the tripped streak.
    expect(second.intents).toContainEqual<Intent>({
      kind: "force-kill",
      reason: "wedge",
      zeroBlockTurnStreak: 2,
    });
    // turn_done(complete) still published BEFORE the escalation (the dashboard
    // unpins the in-flight turn; forceKillStuckWorker publishes a second
    // turn_done(error) on teardown).
    expect(second.intents.find((i) => i.kind === "publish-turn-done")).toMatchObject({
      status: "complete",
    });
    // No set-status idle on the wedge path (force-kill owns the idle write).
    expect(second.intents.some((i) => i.kind === "set-status")).toBe(false);
    // No send-next on the wedge path.
    expect(second.intents.some((i) => i.kind === "send-next")).toBe(false);
  });

  it("the wedge trips identically on consecutive zero-block fail Transitions", () => {
    const deps: ApplyDeps = { ...DEPS, wedgeThreshold: 2 };
    const second = apply(
      ctx({ blocksThisTurn: 0, sessionId: undefined, zeroBlockTurnStreak: 1 }),
      { kind: "fail", payload: { message: "empty result", recoverable: false } },
      deps,
    );
    expect(second.state).toBe("force-killed");
    expect(second.intents).toContainEqual<Intent>({
      kind: "force-kill",
      reason: "wedge",
      zeroBlockTurnStreak: 2,
    });
  });

  it("a single block resets the streak — no force-kill even at a high prior streak", () => {
    const deps: ApplyDeps = { ...DEPS, wedgeThreshold: 2 };
    const r = apply(
      ctx({ blocksThisTurn: 3, sessionId: undefined, zeroBlockTurnStreak: 9 }),
      { kind: "complete", payload: {} },
      deps,
    );
    expect(r.state).toBe("idle");
    expect(r.mutations.zeroBlockTurnStreak).toBe(0);
    expect(r.intents.some((i) => i.kind === "force-kill")).toBe(false);
  });
});

describe("turn-state-machine: (c) mail-back backstop Option B then Option C", () => {
  function childCtx(overrides: Partial<TurnContext> = {}): TurnContext {
    return ctx({
      agentType: "builder",
      parentName: "orch",
      blocksThisTurn: 2, // produced content
      mailSendToParentThisTurn: 0, // but did NOT mail home
      sessionId: undefined,
      ...overrides,
    });
  }

  it("first miss → Option B single-fire nudge intent, and the queue-drain is SKIPPED", () => {
    const queued = { prompt: "queued work", turnId: "turn-q" };
    const r = apply(
      childCtx({ noMailBackNudgedThisTurn: false, noMailBackStreak: 0, nextPrompts: [queued] }),
      { kind: "complete", payload: {} },
      DEPS,
    );

    // Exactly one mailback-nudge with the deterministic uuid turn id.
    const nudge = r.intents.find((i) => i.kind === "mailback-nudge");
    expect(nudge).toEqual<Intent>({
      kind: "mailback-nudge",
      agent: "agent-1",
      parent: "orch",
      streak: 1,
      prompt: {
        prompt:
          "You finished your turn without reporting back. Mail your parent " +
          "`orch` with your result now via " +
          '`mail_send({to: "orch", body: …})` so your parent learns you\'re done.',
        turnId: "t_FIXED-UUID",
      },
    });
    // The nudge owns the next turn — NO send-next for the queued prompt.
    expect(r.intents.some((i) => i.kind === "send-next")).toBe(false);
    // Guard + streak bookkeeping.
    expect(r.mutations).toMatchObject({ noMailBackNudgedThisTurn: true, noMailBackStreak: 1 });
  });

  it("second consecutive miss → Option C warn intent, no nudge, queue-drain RESUMES", () => {
    const queued = { prompt: "queued work", turnId: "turn-q" };
    const r = apply(
      childCtx({ noMailBackNudgedThisTurn: true, noMailBackStreak: 1, nextPrompts: [queued] }),
      { kind: "complete", payload: {} },
      DEPS,
    );

    expect(r.intents.some((i) => i.kind === "mailback-nudge")).toBe(false);
    expect(r.intents).toContainEqual<Intent>({
      kind: "mailback-warn",
      agent: "agent-1",
      parent: "orch",
      turnId: "turn-1",
      streak: 2,
    });
    // Option C does NOT own the next turn — the queued prompt drains.
    expect(r.intents.at(-1)).toEqual<Intent>({ kind: "send-next", prompt: queued });
    expect(r.mutations.noMailBackStreak).toBe(2);
  });

  it("a turn that DID mail home clears the backstop state and never nudges/warns", () => {
    const r = apply(
      childCtx({
        mailSendToParentThisTurn: 1,
        noMailBackNudgedThisTurn: true,
        noMailBackStreak: 1,
      }),
      { kind: "complete", payload: {} },
      DEPS,
    );
    expect(r.intents.some((i) => i.kind === "mailback-nudge")).toBe(false);
    expect(r.intents.some((i) => i.kind === "mailback-warn")).toBe(false);
    expect(r.mutations).toMatchObject({ noMailBackNudgedThisTurn: false, noMailBackStreak: 0 });
  });

  it("a non-child agent never triggers the mail-back backstop", () => {
    const r = apply(
      ctx({
        agentType: "orchestrator",
        parentName: undefined,
        blocksThisTurn: 2,
        sessionId: undefined,
      }),
      { kind: "complete", payload: {} },
      DEPS,
    );
    expect(r.intents.some((i) => i.kind === "mailback-nudge" || i.kind === "mailback-warn")).toBe(
      false,
    );
  });
});

describe("turn-state-machine: (d) abort projects aborting with no intents", () => {
  it("abort returns state=aborting, projection=null (heals to idle), no intents", () => {
    const r = apply(ctx({ abortRequested: true }), { kind: "abort" }, DEPS);
    expect(r.state).toBe("aborting");
    expect(r.projection).toBeNull();
    expect(r.intents).toEqual([]);
    // The derived Status projection of `aborting` is idle (the durable agents
    // row stays `working` until the cooperative terminal event heals it).
    expect(projectStatus(r.state)).toBe("idle");
  });
});

describe("turn-state-machine: (AC #4) both abort interleavings produce exactly one turn_done", () => {
  it("abort THEN cooperative turn-complete: one turn_done(aborted,cooperative), no force-kill", () => {
    // Interleaving A: the worker raced to a clean turn-complete after the abort.
    const w = ctx({ abortRequested: true, blocksThisTurn: 0, sessionId: undefined });
    // abort transition first (pins aborting).
    const ar = apply(w, { kind: "abort" }, DEPS);
    expect(ar.state).toBe("aborting");
    // then the cooperative turn-complete lands.
    const cr = apply(w, { kind: "complete", payload: {} }, DEPS);
    const dones = cr.intents.filter((i) => i.kind === "publish-turn-done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ status: "aborted", abortReason: "cooperative" });
    // Cooperative — the wedge never escalates (abort is excluded from the streak).
    expect(cr.intents.some((i) => i.kind === "force-kill")).toBe(false);
    expect(cr.state).toBe("idle");
  });

  it("abort THEN cooperative error: one turn_done(aborted,cooperative), no force-kill", () => {
    // Interleaving B: the worker emitted error IPC (its for-await closed) after
    // the abort — the other terminal shape.
    const w = ctx({ abortRequested: true, blocksThisTurn: 0, sessionId: undefined });
    apply(w, { kind: "abort" }, DEPS);
    const fr = apply(
      w,
      { kind: "fail", payload: { message: "aborted out", recoverable: true } },
      DEPS,
    );
    const dones = fr.intents.filter((i) => i.kind === "publish-turn-done");
    expect(dones).toHaveLength(1);
    expect(dones[0]).toMatchObject({ status: "aborted", abortReason: "cooperative" });
    expect(fr.intents.some((i) => i.kind === "force-kill")).toBe(false);
    expect(fr.state).toBe("idle");
  });
});
