/**
 * FRI-142 / ADR-048 producer seam #4 — mail_delivered.
 *
 * The mail bridge fires `notify({ type: "mail_delivered" })` ONLY for
 * ORCHESTRATOR-bound mail (the user's chat) — inter-agent internal mail is
 * plumbing and must not raise a Notification. A `priority='critical'` mail
 * opts into the DND critical class via `priority: "critical"` on the event.
 *
 * Mocks the IO boundary (the block write, registry, lifecycle wake/spawn, and
 * the router) and emits `mail:any` directly on the real `mailBus`, then asserts
 * which `notify` event the bridge fired (and that non-orchestrator mail fires
 * none). The bridge handler is fire-and-forget async, so we `vi.waitFor` the
 * effect.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORCHESTRATOR = "friday";

vi.mock("@friday/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@friday/shared")>();
  return {
    ...actual,
    loadConfig: () => ({ ...actual.loadConfig(), orchestratorName: ORCHESTRATOR }),
  };
});

// The bridge writes a mail-as-block + reads the recipient; stub both so no DB
// is touched and the handler reaches the notify seam + the wake branch.
vi.mock("../agent/block-injectors.js", () => ({ recordUserBlock: vi.fn(async () => undefined) }));
vi.mock("../agent/registry.js", () => ({
  getAgent: vi.fn(async () => ({ name: ORCHESTRATOR, type: "orchestrator", sessionId: null })),
}));
vi.mock("../agent/lifecycle.js", () => ({
  isAgentLive: vi.fn(() => true), // live ⇒ wake branch, no spawn
  wakeAgent: vi.fn(),
  wakeAgentCritical: vi.fn(),
  dispatchTurn: vi.fn(),
}));
vi.mock("./respawn-orphan-mail.js", () => ({ cancelPendingRespawn: vi.fn() }));
vi.mock("../log.js", () => ({ logger: { log: vi.fn() } }));

const notifySpy = vi.fn();
vi.mock("../notifications/notify.js", () => ({ notify: (e: unknown) => notifySpy(e) }));

import { mailBus } from "@friday/shared/services";
import { startMailBridge } from "./mail-bridge.js";

function mailRow(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    fromAgent: "kitchen",
    toAgent: ORCHESTRATOR,
    type: "message" as const,
    delivery: "pending" as const,
    subject: "Dinner",
    threadId: null,
    body: "we skipped dinner",
    meta: null,
    ts: Date.now(),
    readAt: null,
    closedAt: null,
    priority: "normal" as const,
    ...over,
  };
}

beforeEach(() => {
  startMailBridge(); // idempotent (guarded by an internal `started` latch)
  notifySpy.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("mail-bridge — mail_delivered seam", () => {
  it("fires mail_delivered for ORCHESTRATOR-bound mail with the subject + sender", async () => {
    mailBus.emit("mail:any", mailRow({ id: 42 }));

    await vi.waitFor(() => expect(notifySpy).toHaveBeenCalledTimes(1), {
      timeout: 2000,
      interval: 20,
    });
    expect(notifySpy.mock.calls[0]![0]).toMatchObject({
      type: "mail_delivered",
      title: "Mail: Dinner",
      body: "Mail from kitchen.",
      deepLink: "/mail?id=42",
    });
    // A normal-priority mail carries no critical flag.
    expect("priority" in (notifySpy.mock.calls[0]![0] as object)).toBe(false);
  });

  it("flags priority:'critical' on a critical-priority mail (DND bypass class)", async () => {
    mailBus.emit("mail:any", mailRow({ id: 43, priority: "critical" }));

    await vi.waitFor(() => expect(notifySpy).toHaveBeenCalledTimes(1), {
      timeout: 2000,
      interval: 20,
    });
    expect(notifySpy.mock.calls[0]![0]).toMatchObject({
      type: "mail_delivered",
      priority: "critical",
    });
  });

  it("does NOT fire for inter-agent mail not bound to the orchestrator", async () => {
    mailBus.emit("mail:any", mailRow({ id: 44, toAgent: "garage" }));

    // Give the fire-and-forget handler time to run; assert it stayed silent.
    await new Promise((r) => setTimeout(r, 100));
    expect(notifySpy).not.toHaveBeenCalled();
  });
});
