/**
 * FRI-171 (ADR-047) — Inbox store: the reactive read model + lifecycle
 * orchestration behind the header bell and the Inbox review panel.
 *
 * READ side (pure derivations over `zeroSync.inboxItems`):
 *   - `open` / `openByKind` — the open items, partitioned by kind.
 *   - `openCount` — the bell badge count (= number of open items).
 *   - `tone` — the two-tone bell signal: `"attention"` iff any open
 *     Proposed/Unsorted item exists; `"low"` when only open Done items remain;
 *     `null` when the bell is empty.
 *
 * WRITE side (lifecycle, each a Zero state flip + optional daemon side effect):
 *   - `approve(id)` — runs the SAME Route-target executor the intake act-path
 *     would, SERVER-SIDE (await `/api/intake/approve`), THEN flips state via the
 *     `inboxApprove` mutator. The executor logic is NEVER duplicated here.
 *   - `reject(id)` / `dismiss(id)` — pure state flips (no side effect).
 *   - `undo(id)` — runs the inverse executor server-side (await
 *     `/api/intake/undo`), THEN flips state via `inboxUndo`.
 *   - `resolveOnView()` — bell-open auto-resolve: flips every OPEN Done item to
 *     resolved (leaving open Proposed/Unsorted untouched). Pure state flip.
 *
 * Testability: the Zero mutators and the network `fetch` are reached through an
 * injectable {@link InboxDeps} seam. Production wires the real `zeroSync` +
 * `fetch`; the store-level test injects a fake `zeroSync` whose `inboxItems` is
 * a `$state` array (real reactivity) and spy mutators/fetch (mocked IO). This
 * lets the test drive the state machine — bell-open resolves Done, approve
 * calls the approve mutator after the executor, two-tone reflects kinds —
 * without a live Zero connection.
 */

import type { InboxItem, InboxKind } from "@friday/shared";
import { zeroSync } from "./zero.svelte";

/** Minimal surface of the Zero store the inbox store needs — so a test can
 *  substitute a fake with a reactive `inboxItems` and spy mutators. */
export interface InboxZeroLike {
  inboxItems: InboxItem[];
  inboxApprove(id: string): unknown;
  inboxReject(id: string): unknown;
  inboxDismiss(id: string): unknown;
  inboxUndo(id: string): unknown;
  inboxResolveOnView(ids: string[]): unknown;
}

export interface InboxDeps {
  zero: InboxZeroLike;
  fetch: typeof fetch;
}

/** The two-tone bell signal (see class docstring). */
export type BellTone = "attention" | "low" | null;

export class InboxStore {
  #deps: InboxDeps;

  constructor(deps: InboxDeps) {
    this.#deps = deps;
  }

  /** Every OPEN item, newest-first (the bind already orders desc). */
  get open(): InboxItem[] {
    return this.#deps.zero.inboxItems.filter((i) => i.state === "open");
  }

  /** Open items partitioned by kind, for the panel's three sections. */
  get openByKind(): Record<InboxKind, InboxItem[]> {
    const out: Record<InboxKind, InboxItem[]> = { done: [], proposed: [], unsorted: [] };
    for (const i of this.open) out[i.kind].push(i);
    return out;
  }

  /** The bell badge count — number of open items. */
  get openCount(): number {
    return this.open.length;
  }

  /**
   * FRI-142 (ADR-048): the open ATTENTION-worthy count — open items whose
   * `kind` needs a DECISION (`proposed` / `unsorted`). This is the single
   * source the home-screen app-icon badge (`navigator.setAppBadge`) mirrors
   * while the app is foregrounded, and it MUST equal the daemon's
   * `computeBadgeCount()` (`state='open' AND kind IN ('proposed','unsorted')`,
   * `notifications/badge.ts`) so the open-app and closed-app (push-stamped)
   * badge agree. `done` items are FYI (auto-resolve on view) and excluded —
   * the same partition the bell's `tone === 'attention'` signal uses.
   */
  get attentionCount(): number {
    return this.open.filter((i) => i.kind === "proposed" || i.kind === "unsorted").length;
  }

  /**
   * The two-tone bell signal:
   *   - `"attention"` when ANY open Proposed/Unsorted item needs a decision;
   *   - `"low"` when only open Done items (FYI-with-undo) remain;
   *   - `null` when the bell is empty.
   */
  get tone(): BellTone {
    const open = this.open;
    if (open.length === 0) return null;
    const needsDecision = open.some((i) => i.kind === "proposed" || i.kind === "unsorted");
    return needsDecision ? "attention" : "low";
  }

  /** The ids of OPEN Done items — the set `resolveOnView` flips on bell-open. */
  get openDoneIds(): string[] {
    return this.open.filter((i) => i.kind === "done").map((i) => i.id);
  }

  /**
   * Bell-open auto-resolve: flip every OPEN Done item to resolved. Open
   * Proposed/Unsorted are left untouched (they need an explicit decision).
   * A no-op when there are no open Done items.
   */
  resolveOnView(): void {
    const ids = this.openDoneIds;
    if (ids.length === 0) return;
    this.#deps.zero.inboxResolveOnView(ids);
  }

  /**
   * Approve a Proposed item: run its executor SERVER-SIDE first, then flip
   * state. Returns the daemon's result; throws on a non-ok proxy response so
   * the caller can surface the error and leave the item Proposed.
   */
  async approve(id: string): Promise<void> {
    const r = await this.#deps.fetch("/api/intake/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!r.ok || body.ok === false) {
      throw new Error(body.error ?? `approve failed (${r.status})`);
    }
    // Executor ran cleanly server-side — now flip the row resolved.
    this.#deps.zero.inboxApprove(id);
  }

  /** Reject a Proposed item: pure state flip, no executor. */
  reject(id: string): void {
    this.#deps.zero.inboxReject(id);
  }

  /** Dismiss an Unsorted item: pure state flip, no executor. */
  dismiss(id: string): void {
    this.#deps.zero.inboxDismiss(id);
  }

  /**
   * Triage an Unsorted item to a chosen `agent:<name>` target: run the mail
   * executor SERVER-SIDE (await `/api/intake/triage`), then flip state. The row
   * is promoted to Done server-side; the `inboxApprove` mutator resolves it.
   * Throws on a non-ok proxy response (the item stays Unsorted).
   */
  async triage(id: string, targetId: string): Promise<void> {
    const r = await this.#deps.fetch("/api/intake/triage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, targetId }),
    });
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!r.ok || body.ok === false) {
      throw new Error(body.error ?? `triage failed (${r.status})`);
    }
    this.#deps.zero.inboxApprove(id);
  }

  /**
   * Undo a Done item: run the inverse executor SERVER-SIDE first, then flip
   * state. Throws on a non-ok proxy response (the item stays in the bell).
   */
  async undo(id: string): Promise<void> {
    const r = await this.#deps.fetch("/api/intake/undo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!r.ok || body.ok === false) {
      throw new Error(body.error ?? `undo failed (${r.status})`);
    }
    this.#deps.zero.inboxUndo(id);
  }
}

/** The production singleton — wired to the live `zeroSync` + global `fetch`. */
export const inbox = new InboxStore({
  zero: zeroSync as unknown as InboxZeroLike,
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
});
