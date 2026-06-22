/**
 * @vitest-environment jsdom
 *
 * FRI-171 (ADR-047) — Inbox store: stateful behavior at the layer the bugs
 * live in. The store is a reactive read model over `zeroSync.inboxItems` plus
 * the lifecycle orchestration (approve runs the executor server-side, then
 * flips state; bell-open auto-resolves Done). We exercise it with a FAKE Zero
 * whose `inboxItems` is a real `$state` array (reactivity is REAL) and spy
 * mutators + a spy `fetch` (the network/IO boundary is mocked) — per the
 * stateful-store testing discipline: mock the IO boundary, leave reactivity
 * real, assert observable behavior.
 *
 * Behaviors pinned:
 *   1. Two-tone bell reflects kinds: attention iff any open Proposed/Unsorted;
 *      low when only open Done; null when empty. Count == open-item count.
 *   2. Opening the bell (resolveOnView) flips OPEN Done → resolved and leaves
 *      open Proposed/Unsorted untouched — asserted via the exact ids passed to
 *      the resolve mutator AND the recomputed selectors after the flip.
 *   3. approve() awaits the executor proxy, then calls the inboxApprove mutator
 *      with the item id; a failed proxy throws and does NOT flip state.
 *   4. triage(id, targetId) awaits the mail-executor proxy (POST
 *      /api/intake/triage with { id, targetId }), then flips state via
 *      inboxApprove; a failed proxy throws and does NOT flip state.
 *   5. undo() awaits the inverse proxy, then calls inboxUndo.
 *   6. reject/dismiss are pure flips (no fetch).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { InboxItem } from "@friday/shared";
import { InboxStore, type InboxZeroLike } from "./inbox.svelte";

/** Build an InboxItem with sensible defaults; override per-test. */
function item(over: Partial<InboxItem> & Pick<InboxItem, "id" | "kind">): InboxItem {
  return {
    id: over.id,
    created_at: over.created_at ?? Date.now(),
    source: over.source ?? "quick_add",
    raw_text: over.raw_text ?? "raw",
    cleaned_text: over.cleaned_text ?? "cleaned",
    target_id: over.target_id ?? null,
    payload: over.payload ?? null,
    rationale: over.rationale ?? null,
    kind: over.kind,
    state: over.state ?? "open",
    resolved_at: over.resolved_at ?? null,
    undoable: over.undoable ?? false,
    inverse_label: over.inverse_label ?? null,
    deep_link: over.deep_link ?? null,
  };
}

/** A fake Zero store with REAL reactivity ($state) + spy mutators. The
 *  mutators emulate the canonical state flip so post-action selectors are
 *  observable, exactly as the real Zero optimistic write would. */
class FakeZero implements InboxZeroLike {
  inboxItems = $state<InboxItem[]>([]);

  inboxApprove = vi.fn((id: string) => this.#resolve(id, { kind: "done" }));
  inboxReject = vi.fn((id: string) => this.#resolve(id));
  inboxDismiss = vi.fn((id: string) => this.#resolve(id));
  inboxUndo = vi.fn((id: string) => this.#resolve(id));
  inboxResolveOnView = vi.fn((ids: string[]) => {
    for (const id of ids) this.#resolve(id);
  });

  #resolve(id: string, extra?: Partial<InboxItem>): void {
    this.inboxItems = this.inboxItems.map((i) =>
      i.id === id ? { ...i, ...extra, state: "resolved", resolved_at: Date.now() } : i,
    );
  }
}

/** Spy fetch returning a JSON body with the given status. */
function okFetch(body: unknown = { ok: true }): typeof fetch {
  return vi.fn(async () =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
  ) as unknown as typeof fetch;
}
function failFetch(status = 409, body: unknown = { ok: false, error: "boom" }): typeof fetch {
  return vi.fn(async () =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  ) as unknown as typeof fetch;
}

describe("InboxStore", () => {
  let zero: FakeZero;

  beforeEach(() => {
    zero = new FakeZero();
  });

  it("count + two-tone reflect open-item kinds", () => {
    const store = new InboxStore({ zero, fetch: okFetch() });

    // Empty bell.
    expect(store.openCount).toBe(0);
    expect(store.tone).toBe(null);

    // Only open Done → low-priority tone.
    zero.inboxItems = [
      item({ id: "d1", kind: "done", undoable: true }),
      item({ id: "d2", kind: "done", undoable: true }),
    ];
    expect(store.openCount).toBe(2);
    expect(store.tone).toBe("low");

    // Add an open Proposed → attention tone (a decision is needed).
    zero.inboxItems = [...zero.inboxItems, item({ id: "p1", kind: "proposed" })];
    expect(store.openCount).toBe(3);
    expect(store.tone).toBe("attention");

    // An open Unsorted alone is also attention.
    zero.inboxItems = [item({ id: "u1", kind: "unsorted" })];
    expect(store.openCount).toBe(1);
    expect(store.tone).toBe("attention");

    // Resolved items never count toward the bell.
    zero.inboxItems = [item({ id: "r1", kind: "proposed", state: "resolved" })];
    expect(store.openCount).toBe(0);
    expect(store.tone).toBe(null);
  });

  it("openByKind partitions only open items", () => {
    const store = new InboxStore({ zero, fetch: okFetch() });
    zero.inboxItems = [
      item({ id: "d1", kind: "done" }),
      item({ id: "p1", kind: "proposed" }),
      item({ id: "p2", kind: "proposed" }),
      item({ id: "u1", kind: "unsorted" }),
      item({ id: "d2", kind: "done", state: "resolved" }), // excluded
    ];
    expect(store.openByKind.done.map((i) => i.id)).toEqual(["d1"]);
    expect(store.openByKind.proposed.map((i) => i.id)).toEqual(["p1", "p2"]);
    expect(store.openByKind.unsorted.map((i) => i.id)).toEqual(["u1"]);
  });

  it("opening the bell resolves OPEN Done and leaves Proposed/Unsorted open", () => {
    const store = new InboxStore({ zero, fetch: okFetch() });
    zero.inboxItems = [
      item({ id: "d1", kind: "done", undoable: true }),
      item({ id: "d2", kind: "done", undoable: true }),
      item({ id: "p1", kind: "proposed" }),
      item({ id: "u1", kind: "unsorted" }),
    ];

    store.resolveOnView();

    // The resolve mutator was called with EXACTLY the open-Done ids.
    expect(zero.inboxResolveOnView).toHaveBeenCalledTimes(1);
    expect(zero.inboxResolveOnView).toHaveBeenCalledWith(["d1", "d2"]);

    // After the flip: Done items are gone from the bell; Proposed/Unsorted stay.
    expect(store.openByKind.done).toEqual([]);
    expect(store.openByKind.proposed.map((i) => i.id)).toEqual(["p1"]);
    expect(store.openByKind.unsorted.map((i) => i.id)).toEqual(["u1"]);
    expect(store.openCount).toBe(2);
    // Two-tone is still attention — a Proposed/Unsorted decision remains.
    expect(store.tone).toBe("attention");
  });

  it("resolveOnView is a no-op when there are no open Done items", () => {
    const store = new InboxStore({ zero, fetch: okFetch() });
    zero.inboxItems = [item({ id: "p1", kind: "proposed" })];
    store.resolveOnView();
    expect(zero.inboxResolveOnView).not.toHaveBeenCalled();
    expect(store.openCount).toBe(1);
  });

  it("approve runs the executor proxy THEN flips state via the approve mutator", async () => {
    const fetchSpy = okFetch({ ok: true, undoable: true, deepLink: "/schedules?undo=x" });
    const store = new InboxStore({ zero, fetch: fetchSpy });
    zero.inboxItems = [
      item({ id: "p1", kind: "proposed", target_id: "core:ticket", payload: { title: "Fix" } }),
    ];

    await store.approve("p1");

    // Executor ran server-side at the loopback proxy with the row id.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("/api/intake/approve");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ id: "p1" });

    // ONLY THEN the state flip — the approve mutator fired with the id.
    expect(zero.inboxApprove).toHaveBeenCalledTimes(1);
    expect(zero.inboxApprove).toHaveBeenCalledWith("p1");

    // The item left the open set (canonical flip applied by the fake mutator).
    expect(store.open.find((i) => i.id === "p1")).toBeUndefined();
    expect(store.openCount).toBe(0);
  });

  it("approve does NOT flip state when the executor proxy fails", async () => {
    const fetchSpy = failFetch(409, { ok: false, error: "payload no longer valid" });
    const store = new InboxStore({ zero, fetch: fetchSpy });
    zero.inboxItems = [item({ id: "p1", kind: "proposed", target_id: "core:ticket" })];

    await expect(store.approve("p1")).rejects.toThrow("payload no longer valid");

    // The state flip mutator was NEVER called — the item stays Proposed/open.
    expect(zero.inboxApprove).not.toHaveBeenCalled();
    expect(store.openByKind.proposed.map((i) => i.id)).toEqual(["p1"]);
    expect(store.openCount).toBe(1);
  });

  it("triage runs the mail executor proxy THEN flips state via the approve mutator", async () => {
    const fetchSpy = okFetch({ ok: true, undoable: false, deepLink: "/mail?msg=x" });
    const store = new InboxStore({ zero, fetch: fetchSpy });
    zero.inboxItems = [item({ id: "u1", kind: "unsorted", raw_text: "ping ops about the deploy" })];

    await store.triage("u1", "agent:foo");

    // The mail executor ran server-side at the triage proxy with id + target.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("/api/intake/triage");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      id: "u1",
      targetId: "agent:foo",
    });

    // ONLY THEN the state flip — the row is promoted to Done + resolved.
    expect(zero.inboxApprove).toHaveBeenCalledTimes(1);
    expect(zero.inboxApprove).toHaveBeenCalledWith("u1");

    // The item left the open set.
    expect(store.open.find((i) => i.id === "u1")).toBeUndefined();
    expect(store.openCount).toBe(0);
  });

  it("triage does NOT flip state when the mail executor proxy fails", async () => {
    const fetchSpy = failFetch(409, { ok: false, error: "target unavailable" });
    const store = new InboxStore({ zero, fetch: fetchSpy });
    zero.inboxItems = [item({ id: "u1", kind: "unsorted" })];

    await expect(store.triage("u1", "agent:foo")).rejects.toThrow("target unavailable");

    // The state flip mutator was NEVER called — the item stays Unsorted/open.
    expect(zero.inboxApprove).not.toHaveBeenCalled();
    expect(store.openByKind.unsorted.map((i) => i.id)).toEqual(["u1"]);
    expect(store.openCount).toBe(1);
  });

  it("undo runs the inverse proxy THEN flips state via the undo mutator", async () => {
    const fetchSpy = okFetch({ ok: true });
    const store = new InboxStore({ zero, fetch: fetchSpy });
    zero.inboxItems = [
      item({
        id: "d1",
        kind: "done",
        undoable: true,
        target_id: "core:reminder",
        deep_link: "/schedules?undo=intake_1",
      }),
    ];

    await store.undo("d1");

    const [url] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("/api/intake/undo");
    expect(zero.inboxUndo).toHaveBeenCalledTimes(1);
    expect(zero.inboxUndo).toHaveBeenCalledWith("d1");
    expect(store.open.find((i) => i.id === "d1")).toBeUndefined();
  });

  it("reject and dismiss are pure state flips with no executor proxy", () => {
    const fetchSpy = okFetch();
    const store = new InboxStore({ zero, fetch: fetchSpy });
    zero.inboxItems = [item({ id: "p1", kind: "proposed" }), item({ id: "u1", kind: "unsorted" })];

    store.reject("p1");
    store.dismiss("u1");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(zero.inboxReject).toHaveBeenCalledWith("p1");
    expect(zero.inboxDismiss).toHaveBeenCalledWith("u1");
    expect(store.openCount).toBe(0);
  });
});
