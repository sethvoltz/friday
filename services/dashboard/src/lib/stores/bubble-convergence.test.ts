import type { BlockKind } from "@friday/shared";
import { describe, expect, it } from "vitest";
import {
  mergeBubbles,
  mergeZeroSnapshot,
  overlayKey,
  pruneConverged,
  reconcileCanceled,
  reconcileComplete,
  type AgentInfo,
  type BlockCompleteEvent,
  type ChatMessage,
  type Focus,
  type OverlayEntry,
  type OverlayKey,
  type ReconcileSnapshot,
  type ZeroBlocksRow,
  type ZeroMergeInput,
} from "./bubble-convergence";

// Plain-object-literal fixtures satisfying the pure interfaces (NOT the
// `$state` StreamingEntry/OptimisticEntry classes — the convergence core is
// rune-free and tested without a reactive root). Paid once here.

function legacyMsg(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: "assistant",
    text: "",
    status: "complete",
    ts: 0,
    ...partial,
  };
}

function overlayEntry(
  partial: Partial<OverlayEntry> & { id: string; agent: string; sessionId: string | null },
): OverlayEntry {
  return {
    role: "assistant",
    text: "",
    status: "streaming",
    ts: 0,
    ...partial,
  };
}

function focus(agent: string, sessionId: string | null): Focus {
  return { agent, sessionId };
}

// Wrap an entry so every string-keyed property READ mergeBubbles performs is
// recorded in `sink`, while the real value is returned unchanged (behavior is
// identical). Used to pin the perf-subscription contract below.
function trackReads<T extends object>(obj: T, sink: Set<string>): T {
  return new Proxy(obj, {
    get(target, key, receiver) {
      if (typeof key === "string") sink.add(key);
      return Reflect.get(target, key, receiver);
    },
  });
}

describe("mergeBubbles", () => {
  it("orders [surviving legacy, streaming, optimistic], shadows legacy by overlay id, and returns entries by reference", () => {
    const La = legacyMsg({ id: "a", agent: "friday" });
    const Lb = legacyMsg({ id: "b", agent: "friday" });
    const Lshadow = legacyMsg({ id: "dup", agent: "friday", text: "stale-legacy" });
    const Sdup = overlayEntry({
      id: "dup",
      agent: "friday",
      sessionId: "s1",
      text: "live-overlay",
    });
    const Ss = overlayEntry({ id: "s", agent: "friday", sessionId: "s1" });
    const Oo = overlayEntry({ id: "o", agent: "friday", sessionId: "s1", role: "user" });

    const result = mergeBubbles([La, Lb, Lshadow], [Sdup, Ss], [Oo], focus("friday", "s1"));

    // Order: surviving legacy, then streaming, then optimistic.
    expect(result.map((m) => m.id)).toEqual(["a", "b", "dup", "s", "o"]);
    expect(result.length).toBe(5);

    // Reference identity — entries are passed through BY REFERENCE (never
    // cloned) so per-entry $state stays live in the rendered bubble.
    expect(result[0]).toBe(La);
    expect(result[1]).toBe(Lb);
    expect(result[2]).toBe(Sdup);
    expect(result[3]).toBe(Ss);
    expect(result[4]).toBe(Oo);

    // id-shadow: the legacy "dup" is dropped; the surviving "dup" is the
    // streaming overlay, not the stale legacy row.
    expect(result).not.toContain(Lshadow);
    expect(result.find((m) => m.id === "dup")).toBe(Sdup);
  });

  it("collapses overlay entries to the focused session with strict === equality (null after /clear)", () => {
    const Lfriday = legacyMsg({ id: "lf", agent: "friday" });
    const Ss1 = overlayEntry({ id: "s1", agent: "friday", sessionId: "s1" });
    const Snull = overlayEntry({ id: "snull", agent: "friday", sessionId: null });

    // Post-/clear: the agent's sessionId is null. Overlay entries stamped with
    // the now-dead session "s1" are dropped; a null-session entry survives.
    const cleared = mergeBubbles([Lfriday], [Ss1, Snull], [], focus("friday", null));
    expect(cleared.map((m) => m.id)).toEqual(["lf", "snull"]);
    expect(cleared).not.toContain(Ss1);

    // Inverse direction pins the strictness both ways: with session "s1"
    // focused, the "s1" entry survives and the null-session entry is dropped.
    const active = mergeBubbles([Lfriday], [Ss1, Snull], [], focus("friday", "s1"));
    expect(active.map((m) => m.id)).toEqual(["lf", "s1"]);
    expect(active).not.toContain(Snull);
  });

  it("passes untagged legacy bubbles through and isolates cross-agent legacy + overlay bubbles", () => {
    const Luntagged = legacyMsg({ id: "u" }); // no agent tag
    const Lfriday = legacyMsg({ id: "lf", agent: "friday" });
    const Lother = legacyMsg({ id: "lo", agent: "other" });
    const Sother = overlayEntry({ id: "so", agent: "other", sessionId: "s1" });
    const Sfriday = overlayEntry({ id: "sf", agent: "friday", sessionId: "s1" });

    const result = mergeBubbles(
      [Luntagged, Lfriday, Lother],
      [Sother, Sfriday],
      [],
      focus("friday", "s1"),
    );

    // Untagged legacy passes through; agent-tagged mismatch is dropped on both
    // the legacy and overlay sides.
    expect(result.map((m) => m.id)).toEqual(["u", "lf", "sf"]);
    expect(result).toContain(Luntagged);
    expect(result).not.toContain(Lother);
    expect(result).not.toContain(Sother);
  });

  it("reads ONLY identity fields (id/agent/sessionId) off entries — never a per-delta $state field — so #derivedMessages never subscribes to a streaming text/status mutation", () => {
    // The load-bearing perf-subscription contract (chat.svelte.ts
    // #derivedMessages, ~280-301; brief §6/§44). On the REAL
    // StreamingEntry/OptimisticEntry, id/agent/sessionId are plain `readonly`
    // fields, while text/status/toolName/input/output/inputPartialJson/
    // isRedacted/pending/failed are `$state`. If mergeBubbles read ANY $state
    // field, #derivedMessages would re-run on every `entry.text += delta` — a
    // perf cliff on long streams (the whole list re-derives per token).
    //
    // This repo's vitest compiles Svelte server-side (no reactive root reachable
    // — $effect never runs and $derived never memoizes), so the downstream
    // "chat.messages array identity is stable" symptom is UNOBSERVABLE in any
    // test here. We therefore pin the ROOT CAUSE directly: mergeBubbles must
    // touch no field outside the identity set. This is genuinely discriminating
    // — a buggy mergeBubbles that read `entry.text` trips the access tracker and
    // fails, where the structural/by-reference checks (in chat.test.ts and test
    // #1 above) would still pass (text affects neither cloning nor ordering).
    const reads = new Set<string>();
    const La = trackReads(
      legacyMsg({ id: "a", agent: "friday", text: "legacy-text", status: "complete" }),
      reads,
    );
    const Sdup = trackReads(
      overlayEntry({
        id: "dup",
        agent: "friday",
        sessionId: "s1",
        text: "live-overlay",
        status: "streaming",
      }),
      reads,
    );
    const Ss = trackReads(
      overlayEntry({
        id: "s",
        agent: "friday",
        sessionId: "s1",
        text: "more",
        status: "streaming",
      }),
      reads,
    );
    const Oo = trackReads(
      overlayEntry({ id: "o", agent: "friday", sessionId: "s1", role: "user", status: "complete" }),
      reads,
    );

    const result = mergeBubbles([La], [Sdup, Ss], [Oo], focus("friday", "s1"));
    // Snapshot the reads made DURING the merge, before behavioral assertions
    // below touch the (proxy) entries again.
    const accessedDuringMerge = new Set(reads);

    // The merge still behaves correctly through the tracking proxies.
    expect(result.map((m) => m.id)).toEqual(["a", "dup", "s", "o"]);

    // Discriminating: every property mergeBubbles read is an identity field.
    const IDENTITY = new Set(["id", "agent", "sessionId"]);
    const forbidden = [...accessedDuringMerge].filter((k) => !IDENTITY.has(k));
    expect(
      forbidden,
      `mergeBubbles read non-identity field(s): ${forbidden.join(", ") || "(none)"}`,
    ).toEqual([]);

    // Name the specific perf-subscription regression: the per-delta $state
    // fields must never be touched by the merge.
    for (const reactiveField of [
      "text",
      "status",
      "toolName",
      "input",
      "output",
      "inputPartialJson",
      "isRedacted",
      "pending",
      "failed",
    ]) {
      expect(
        accessedDuringMerge.has(reactiveField),
        `mergeBubbles read $state.${reactiveField}`,
      ).toBe(false);
    }
  });
});

describe("pruneConverged", () => {
  it("drops focus-agent overlay entries whose legacy twin reached a terminal status, keeps still-live ones, and is agent-scoped", () => {
    const legacy = [
      legacyMsg({ id: "done1", agent: "friday", status: "complete" }),
      legacyMsg({ id: "live1", agent: "friday", status: "streaming" }),
      legacyMsg({ id: "done-other", agent: "other", status: "complete" }),
    ];
    const Sdone = overlayEntry({ id: "done1", agent: "friday", sessionId: "s1" });
    const Slive = overlayEntry({ id: "live1", agent: "friday", sessionId: "s1" });
    const Sother = overlayEntry({ id: "done-other", agent: "other", sessionId: "s1" });

    const { keep, drop } = pruneConverged(legacy, [Sdone, Slive, Sother], "friday");

    // Converged (terminal legacy twin) → drop; still-streaming → keep. By ref.
    expect(drop).toEqual([Sdone]);
    expect(drop[0]).toBe(Sdone);
    expect(keep).toEqual([Slive]);
    expect(keep[0]).toBe(Slive);
    // Agent-scoped: the "other"-agent entry is in NEITHER list (the shell
    // leaves it untouched in the map) even though its legacy twin is terminal.
    expect(keep).not.toContain(Sother);
    expect(drop).not.toContain(Sother);
  });

  it("treats all four terminal statuses (complete/aborted/error/done) as converged and leaves non-terminal twins live", () => {
    const legacy = [
      legacyMsg({ id: "c", agent: "friday", status: "complete" }),
      legacyMsg({ id: "a", agent: "friday", status: "aborted" }),
      legacyMsg({ id: "e", agent: "friday", status: "error" }),
      legacyMsg({ id: "d", agent: "friday", status: "done" }),
      legacyMsg({ id: "r", agent: "friday", status: "running" }),
      legacyMsg({ id: "q", agent: "friday", status: "queued" }),
    ];
    const overlays = ["c", "a", "e", "d", "r", "q"].map((id) =>
      overlayEntry({ id, agent: "friday", sessionId: "s1" }),
    );

    const { keep, drop } = pruneConverged(legacy, overlays, "friday");
    expect(drop.map((e) => e.id)).toEqual(["c", "a", "e", "d"]);
    expect(keep.map((e) => e.id)).toEqual(["r", "q"]);
  });

  it("returns empty keep/drop for an empty overlay and drops nothing when no legacy twin is terminal", () => {
    const legacy = [legacyMsg({ id: "x", agent: "friday", status: "streaming" })];
    expect(pruneConverged(legacy, [], "friday")).toEqual({ keep: [], drop: [] });

    const Sx = overlayEntry({ id: "x", agent: "friday", sessionId: "s1" });
    const res = pruneConverged(legacy, [Sx], "friday");
    expect(res.drop).toEqual([]);
    expect(res.keep).toEqual([Sx]);
  });
});

// --- reconcileComplete builders --------------------------------------------

function overlayMap(entries: OverlayEntry[]): Map<OverlayKey, OverlayEntry> {
  const m = new Map<OverlayKey, OverlayEntry>();
  for (const e of entries) m.set(overlayKey(e.agent, e.id), e);
  return m;
}

function snapshot(opts: {
  merged?: ChatMessage[];
  overlay?: OverlayEntry[];
  focus: Focus;
}): ReconcileSnapshot {
  return {
    merged: opts.merged ?? [],
    overlay: overlayMap(opts.overlay ?? []),
    focus: opts.focus,
  };
}

function completeEvent(
  partial: Partial<BlockCompleteEvent> & { block_id: string; kind: BlockKind },
): BlockCompleteEvent {
  return {
    role: "assistant",
    turn_id: "turn-1",
    content_json: "{}",
    status: "complete",
    source: null,
    ts: 0,
    ...partial,
  };
}

describe("reconcileComplete — text", () => {
  it("finalizes the streaming overlay when an assistant b_<id> entry exists (text-string-guarded patch)", () => {
    const Soverlay = overlayEntry({
      id: "b_blk1",
      agent: "friday",
      sessionId: "s1",
      text: "partial",
      status: "streaming",
    });
    const plan = reconcileComplete(
      snapshot({ overlay: [Soverlay], merged: [Soverlay], focus: focus("friday", "s1") }),
      completeEvent({
        block_id: "blk1",
        kind: "text",
        role: "assistant",
        content_json: JSON.stringify({ text: "final text" }),
        status: "complete",
        turn_id: "turn-1",
      }),
    );
    expect(plan).toMatchObject({
      kind: "overlay-finalize",
      key: overlayKey("friday", "b_blk1"),
      patch: { text: "final text", status: "complete" },
    });
  });

  it("patches the live merged-view row IN PLACE by REFERENCE, with source/turn/block backfills", () => {
    const legacyRow = legacyMsg({ id: "b_blk2", agent: "friday", text: "", status: "streaming" });
    const plan = reconcileComplete(
      snapshot({ merged: [legacyRow], focus: focus("friday", "s1") }),
      completeEvent({
        block_id: "blk2",
        kind: "text",
        role: "assistant",
        content_json: JSON.stringify({ text: "done" }),
        status: "complete",
        turn_id: "turn-2",
        source: "sdk",
      }),
    );
    expect(plan.kind).toBe("inplace");
    if (plan.kind !== "inplace") throw new Error("unreachable");
    // fix #5: the plan carries the actual matched object reference.
    expect(plan.target).toBe(legacyRow);
    expect(plan.patch).toEqual({
      text: "done",
      status: "complete",
      source: "sdk",
      turnId: "turn-2",
      blockId: "blk2",
    });
  });

  it("does NOT backfill source/turn/block when the target already has them", () => {
    const legacyRow = legacyMsg({
      id: "b_blk2b",
      agent: "friday",
      text: "",
      status: "streaming",
      source: "user_chat",
      turnId: "turn-pre",
      blockId: "blk-pre",
    });
    const plan = reconcileComplete(
      snapshot({ merged: [legacyRow], focus: focus("friday", "s1") }),
      completeEvent({
        block_id: "blk2b",
        kind: "text",
        role: "assistant",
        content_json: JSON.stringify({ text: "done" }),
        status: "complete",
        turn_id: "turn-2b",
        source: "sdk",
      }),
    );
    expect(plan.kind).toBe("inplace");
    if (plan.kind !== "inplace") throw new Error("unreachable");
    // Only text + status — the pre-set source/turnId/blockId are untouched.
    expect(plan.patch).toEqual({ text: "done", status: "complete" });
  });

  it("late-mounts an assistant text row into legacy when neither overlay nor merged has it", () => {
    const plan = reconcileComplete(
      snapshot({ focus: focus("friday", "s1") }),
      completeEvent({
        block_id: "blk3",
        kind: "text",
        role: "assistant",
        content_json: JSON.stringify({ text: "fresh" }),
        status: "complete",
        turn_id: "turn-3",
        ts: 42,
      }),
    );
    expect(plan.kind).toBe("legacy-push");
    if (plan.kind !== "legacy-push") throw new Error("unreachable");
    expect(plan.row).toMatchObject({
      id: "b_blk3",
      role: "assistant",
      text: "fresh",
      status: "complete",
      agent: "friday",
      turnId: "turn-3",
      blockId: "blk3",
      ts: 42,
    });
  });

  it("user-role short-circuits to userBlockIdForTurn (never consults the overlay)", () => {
    const plan = reconcileComplete(
      snapshot({ focus: focus("friday", "s1") }),
      completeEvent({
        block_id: "blk4",
        kind: "text",
        role: "user",
        content_json: JSON.stringify({ text: "yo" }),
        status: "complete",
        turn_id: "turn-4",
      }),
    );
    expect(plan.kind).toBe("legacy-push");
    if (plan.kind !== "legacy-push") throw new Error("unreachable");
    expect(plan.row).toMatchObject({ id: "user_turn-4", role: "user", text: "yo" });
  });

  it("FRI-85 sentinel → no-response: pushRow set when nr absent, null when nr already present", () => {
    const planNew = reconcileComplete(
      snapshot({ focus: focus("friday", "s1") }),
      completeEvent({
        block_id: "blk5",
        kind: "text",
        role: "assistant",
        content_json: JSON.stringify({ text: "No response requested." }),
        status: "complete",
        turn_id: "turn-5",
        ts: 7,
      }),
    );
    expect(planNew.kind).toBe("no-response");
    if (planNew.kind !== "no-response") throw new Error("unreachable");
    expect(planNew.overlayKeyToDelete).toBe(overlayKey("friday", "b_blk5"));
    expect(planNew.legacyIdToSplice).toBe("b_blk5");
    expect(planNew.pushRow).toMatchObject({
      id: "nr_turn-5",
      role: "assistant",
      kind: "no-response",
      noResponseSentinel: true,
      status: "complete",
      ts: 7,
    });

    const existingNr = legacyMsg({
      id: "nr_turn-5",
      agent: "friday",
      kind: "no-response",
      noResponseSentinel: true,
    });
    const planDup = reconcileComplete(
      snapshot({ merged: [existingNr], focus: focus("friday", "s1") }),
      completeEvent({
        block_id: "blk5",
        kind: "text",
        role: "assistant",
        content_json: JSON.stringify({ text: "No response requested." }),
        status: "complete",
        turn_id: "turn-5",
      }),
    );
    expect(planDup.kind).toBe("no-response");
    if (planDup.kind !== "no-response") throw new Error("unreachable");
    expect(planDup.pushRow).toBeNull();
  });
});

describe("reconcileComplete — tool + thinking edges", () => {
  it("tool_result with no matching tool bubble → noop (orphan dropped)", () => {
    const plan = reconcileComplete(
      snapshot({ focus: focus("friday", "s1") }),
      completeEvent({
        block_id: "blkX",
        kind: "tool_result",
        content_json: JSON.stringify({ tool_use_id: "tool9", text: "out" }),
        status: "complete",
        turn_id: "t",
      }),
    );
    expect(plan).toEqual({ kind: "noop" });
  });

  it("tool_result is_error finalizes the tool overlay to status=error with output", () => {
    const Stool = overlayEntry({
      id: "t_tool9",
      agent: "friday",
      sessionId: "s1",
      role: "tool",
      status: "running",
    });
    const plan = reconcileComplete(
      snapshot({ overlay: [Stool], merged: [Stool], focus: focus("friday", "s1") }),
      completeEvent({
        block_id: "blkY",
        kind: "tool_result",
        content_json: JSON.stringify({ tool_use_id: "tool9", is_error: true, text: "boom" }),
        status: "complete",
        turn_id: "t",
      }),
    );
    expect(plan).toMatchObject({
      kind: "overlay-finalize",
      key: overlayKey("friday", "t_tool9"),
      patch: { status: "error", output: "boom" },
    });
  });

  it("thinking empty+complete → ghost-drop; empty+aborted is KEPT (legacy-push, status aborted)", () => {
    const ghost = reconcileComplete(
      snapshot({ focus: focus("friday", "s1") }),
      completeEvent({
        block_id: "blkT",
        kind: "thinking",
        content_json: JSON.stringify({ text: "" }),
        status: "complete",
        turn_id: "t",
      }),
    );
    expect(ghost).toMatchObject({
      kind: "ghost-drop",
      overlayKeyToDelete: overlayKey("friday", "th_blkT"),
      legacyIdToFilter: "th_blkT",
    });

    const aborted = reconcileComplete(
      snapshot({ focus: focus("friday", "s1") }),
      completeEvent({
        block_id: "blkU",
        kind: "thinking",
        content_json: JSON.stringify({ text: "" }),
        status: "aborted",
        turn_id: "t",
        ts: 3,
      }),
    );
    expect(aborted.kind).toBe("legacy-push");
    if (aborted.kind !== "legacy-push") throw new Error("unreachable");
    expect(aborted.row).toMatchObject({
      id: "th_blkU",
      role: "thinking",
      status: "aborted",
      text: "",
    });
  });

  it("tool_use sets input + clears inputPartialJson; toolName only when absent on the overlay", () => {
    // toolName already present → NOT overwritten.
    const SwithName = overlayEntry({
      id: "t_tool7",
      agent: "friday",
      sessionId: "s1",
      role: "tool",
      status: "running",
      toolName: "Bash",
    });
    const planPresent = reconcileComplete(
      snapshot({ overlay: [SwithName], merged: [SwithName], focus: focus("friday", "s1") }),
      completeEvent({
        block_id: "blkW",
        kind: "tool_use",
        content_json: JSON.stringify({ tool_use_id: "tool7", name: "Edit", input: { a: 1 } }),
        status: "complete",
        turn_id: "t",
      }),
    );
    expect(planPresent.kind).toBe("overlay-finalize");
    if (planPresent.kind !== "overlay-finalize") throw new Error("unreachable");
    expect(planPresent.patch).toEqual({ input: { a: 1 }, inputPartialJson: undefined });
    expect("toolName" in planPresent.patch).toBe(false);
    // status complete (not aborted/error) → status NOT in the patch (stays running).
    expect("status" in planPresent.patch).toBe(false);

    // toolName absent → filled from the event.
    const SnoName = overlayEntry({
      id: "t_tool8",
      agent: "friday",
      sessionId: "s1",
      role: "tool",
      status: "running",
    });
    const planAbsent = reconcileComplete(
      snapshot({ overlay: [SnoName], merged: [SnoName], focus: focus("friday", "s1") }),
      completeEvent({
        block_id: "blkW2",
        kind: "tool_use",
        content_json: JSON.stringify({ tool_use_id: "tool8", name: "Edit", input: { a: 1 } }),
        status: "error",
        turn_id: "t",
      }),
    );
    expect(planAbsent.kind).toBe("overlay-finalize");
    if (planAbsent.kind !== "overlay-finalize") throw new Error("unreachable");
    expect(planAbsent.patch).toMatchObject({
      input: { a: 1 },
      inputPartialJson: undefined,
      toolName: "Edit",
      status: "error",
    });
  });
});

describe("reconcileCanceled (fix #4: agent-agnostic)", () => {
  it("drops overlay entries AND legacy bubbles for a blockId across ALL agents", () => {
    const Sfriday = overlayEntry({
      id: "th_blk",
      agent: "friday",
      sessionId: "s1",
      role: "thinking",
      blockId: "blk",
    });
    const Sother = overlayEntry({
      id: "t_tool",
      agent: "other",
      sessionId: "s2",
      role: "tool",
      blockId: "blk",
      toolId: "tool",
    });
    const Skeep = overlayEntry({
      id: "b_keep",
      agent: "friday",
      sessionId: "s1",
      blockId: "other-blk",
    });
    const legacy = [
      legacyMsg({ id: "b_friday", agent: "friday", blockId: "blk" }),
      legacyMsg({ id: "b_other", agent: "other", blockId: "blk" }),
      legacyMsg({ id: "b_survive", agent: "friday", blockId: "survive-blk" }),
    ];

    const { nextLegacy, dropKeys } = reconcileCanceled(legacy, [Sfriday, Sother, Skeep], "blk");

    // Overlay keys reconstructed for BOTH agents' matching entries; the
    // non-matching blockId is left untouched.
    expect(dropKeys).toEqual([overlayKey("friday", "th_blk"), overlayKey("other", "t_tool")]);
    // Both agents' legacy bubbles for "blk" removed; the survivor stays.
    expect(nextLegacy.map((m) => m.id)).toEqual(["b_survive"]);
  });
});

// --- mergeZeroSnapshot builders --------------------------------------------

function zeroRow(partial: Partial<ZeroBlocksRow> & { block_id: string }): ZeroBlocksRow {
  return {
    id: partial.id ?? partial.block_id,
    turn_id: "t1",
    agent_name: "friday",
    session_id: "s1",
    message_id: null,
    block_index: 0,
    role: "assistant",
    kind: "text",
    source: null,
    content_json: {},
    status: "complete",
    streaming: false,
    origin_mutation_id: null,
    ts: 0,
    ...partial,
  };
}

function mergeInput(
  partial: Partial<ZeroMergeInput> & { rows: readonly ZeroBlocksRow[] },
): ZeroMergeInput {
  const agents: AgentInfo[] = [
    { name: "friday", type: "orchestrator", status: "idle", sessionId: "s1" },
  ];
  return {
    forAgent: "friday",
    agents,
    inflightTurnId: null,
    legacyMessages: [],
    zeroSeenBlockIds: new Set<string>(),
    noResponseGraceUntil: {},
    reconnectGraceUntil: 0,
    zeroBlockReasonByTurn: {},
    resultType: "complete",
    fullWindow: true,
    priorOldestBlockId: null,
    now: 1_000_000,
    ...partial,
  };
}

describe("mergeZeroSnapshot", () => {
  const rows = [
    zeroRow({ block_id: "b1", id: "1", ts: 100, content_json: { text: "hello" }, turn_id: "t1" }),
    zeroRow({ block_id: "b2", id: "2", ts: 200, content_json: { text: "world" }, turn_id: "t1" }),
  ];

  it("parses + merges rows in ts order, computes cursors, (ts,id) tuple-max read row, and reachedOldest", () => {
    const result = mergeZeroSnapshot(mergeInput({ rows }));

    expect(result.nextLegacyMessages.map((m) => m.id)).toEqual(["b_b1", "b_b2"]);
    expect(result.nextLegacyMessages.map((m) => m.text)).toEqual(["hello", "world"]);
    expect(result.newOldestCursor).toBe("b1");
    expect(result.oldestCursorChanged).toBe(true); // null → "b1"
    expect(result.reachedOldest).toBe(true); // complete && fullWindow
    expect(result.newestRowForReadCursor).toEqual({ block_id: "b2", ts: 200, id: "2" });
    expect([...result.snapshotBlockIds].sort()).toEqual(["b1", "b2"]);
  });

  it("oldestCursorChanged is FALSE when the prior cursor already equals the new one (pagination not reset)", () => {
    const result = mergeZeroSnapshot(mergeInput({ rows, priorOldestBlockId: "b1" }));
    expect(result.newOldestCursor).toBe("b1");
    expect(result.oldestCursorChanged).toBe(false);
  });

  it("a narrow-window 'complete' (fullWindow=false) returns reachedOldest=undefined", () => {
    const result = mergeZeroSnapshot(mergeInput({ rows, fullWindow: false }));
    expect(result.reachedOldest).toBeUndefined();
  });

  it("drops a previously-seen blockId that is absent from the new snapshot (upstream delete)", () => {
    const result = mergeZeroSnapshot(
      mergeInput({
        rows: [
          zeroRow({
            block_id: "b1",
            id: "1",
            ts: 100,
            content_json: { text: "hello" },
            turn_id: "t1",
          }),
        ],
        legacyMessages: [
          legacyMsg({ id: "b_b1", agent: "friday", blockId: "b1", text: "hello", turnId: "t1" }),
          legacyMsg({ id: "b_b2", agent: "friday", blockId: "b2", text: "world", turnId: "t1" }),
        ],
        zeroSeenBlockIds: new Set(["b1", "b2"]),
      }),
    );
    // b2 was seen but is absent now → dropped; b1 survives (re-parsed).
    expect(result.nextLegacyMessages.map((m) => m.id)).toEqual(["b_b1"]);
  });

  it("FRI-85 grace window is governed by the injected `now`, deterministically (no wall-clock read)", () => {
    // A user-only turn with no assistant block and no inflight match would
    // normally synthesize the "Agent didn't respond" safety-net bubble — UNLESS
    // it is still inside the per-turn grace window. The window is `now <
    // noResponseGraceUntil[turn]`. Because `now` is an explicit input, the same
    // rows yield opposite results purely from the clock value we pass.
    const userOnlyRows = [
      zeroRow({
        block_id: "u1",
        id: "1",
        ts: 100,
        role: "user",
        source: "user_chat", // only user_chat turns expect a reply → synth candidate
        content_json: { text: "ping" },
        turn_id: "t-grace",
      }),
    ];
    const grace = { "t-grace": 5_000 };
    const nrId = "nr_t-grace";

    // now (4_999) < deadline (5_000) → still in grace → sentinel suppressed.
    const inWindow = mergeZeroSnapshot(
      mergeInput({ rows: userOnlyRows, noResponseGraceUntil: grace, now: 4_999 }),
    );
    expect(inWindow.nextLegacyMessages.some((m) => m.id === nrId)).toBe(false);

    // now (5_001) > deadline → window expired → sentinel synthesized. Pin the
    // synthesized bubble's shape, not just its presence: it is the assistant
    // no-response affordance for this turn, stamped +1ms after the user row.
    const expired = mergeZeroSnapshot(
      mergeInput({ rows: userOnlyRows, noResponseGraceUntil: grace, now: 5_001 }),
    );
    const nr = expired.nextLegacyMessages.find((m) => m.id === nrId);
    expect(nr).toMatchObject({
      id: nrId,
      role: "assistant",
      kind: "no-response",
      agent: "friday",
      turnId: "t-grace",
      ts: 101, // user row ts (100) + 1ms
    });
  });

  it("is idempotent: re-running with the prior result fed back is a content no-op", () => {
    const first = mergeZeroSnapshot(mergeInput({ rows }));
    const second = mergeZeroSnapshot(
      mergeInput({
        rows,
        legacyMessages: first.nextLegacyMessages,
        zeroSeenBlockIds: first.snapshotBlockIds,
        priorOldestBlockId: first.newOldestCursor,
      }),
    );
    expect(second.nextLegacyMessages.map((m) => m.id)).toEqual(["b_b1", "b_b2"]);
    expect(second.nextLegacyMessages.map((m) => m.text)).toEqual(["hello", "world"]);
    expect(second.oldestCursorChanged).toBe(false);
  });
});
