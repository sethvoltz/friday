import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, getDb, schema, type TestDbHandle } from "@friday/shared";

// FIX_FORWARD 2.2: mail-as-block invariant. On every mail:any event, the
// bridge materializes a `role='user'`, `kind='text'`, `source='mail'` block
// in the recipient's session and surfaces the sender via content_json.
//
// The mail-bridge handler is fire-and-forget async (ADR-023). Each test
// polls the recipient's blocks with vi.waitFor until the DB write lands.

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "mail_bridge" });
  const { startMailBridge } = await import("./mail-bridge.js");
  startMailBridge();
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

describe("mail-bridge → mail-as-block (FIX_FORWARD 2.2)", () => {
  it("a fresh mailBus event lands a user-role source='mail' block", async () => {
    const { mailBus } = await import("@friday/shared/services");
    const db = getDb();

    mailBus.emit("mail:any", {
      id: 101,
      fromAgent: "alpha",
      toAgent: "unknown-recipient-1",
      type: "message",
      delivery: "pending",
      subject: null,
      threadId: null,
      body: "hello via mail",
      meta: null,
      ts: Date.now(),
      readAt: null,
      closedAt: null,
      priority: "normal",
    });

    await vi.waitFor(
      async () => {
        const rows = await db
          .select()
          .from(schema.blocks)
          .where(eq(schema.blocks.agentName, "unknown-recipient-1"));
        expect(rows.length).toBe(1);
        expect(rows[0].role).toBe("user");
        expect(rows[0].kind).toBe("text");
        expect(rows[0].source).toBe("mail");
        // contentJson is jsonb; Drizzle returns the parsed object.
        const parsed = rows[0].contentJson as {
          text: string;
          from_agent?: string;
        };
        expect(parsed.text).toBe("hello via mail");
        expect(parsed.from_agent).toBe("alpha");
      },
      { timeout: 5000, interval: 25 },
    );
  });

  it("multiple mail deliveries each get their own block keyed by mail id", async () => {
    const { mailBus } = await import("@friday/shared/services");
    const db = getDb();

    for (let i = 0; i < 3; i++) {
      mailBus.emit("mail:any", {
        id: 200 + i,
        fromAgent: "bravo",
        toAgent: "unknown-recipient-2",
        type: "message",
        delivery: "pending",
        subject: null,
        threadId: null,
        body: `body-${i}`,
        meta: null,
        ts: Date.now() + i,
        readAt: null,
        closedAt: null,
        priority: "normal",
      });
    }

    await vi.waitFor(
      async () => {
        const rows = await db
          .select({ turnId: schema.blocks.turnId })
          .from(schema.blocks)
          .where(eq(schema.blocks.agentName, "unknown-recipient-2"))
          .orderBy(schema.blocks.turnId);
        expect(rows.map((r) => r.turnId)).toEqual(["mail_200", "mail_201", "mail_202"]);
      },
      { timeout: 5000, interval: 25 },
    );
  });
});

// FRI-16 AC #16: the wake / respawn paths do NOT branch on `row.type` — a
// `type: "handoff"` mail (the Planner→parent handoff envelope) must wake a
// live recipient and respawn a dead one exactly as `type: "message"` does.
// Both types run through the same it.each so any future type-switch in the
// bridge fails the handoff leg loudly.
describe("FRI-16 AC #16: type='handoff' mail wakes/respawns identically to type='message'", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["message", "handoff"] as const)(
    "wakes a live recipient on a %s mail without dispatching a new turn",
    async (type) => {
      const registry = await import("../agent/registry.js");
      const lifecycle = await import("../agent/lifecycle.js");
      const { sendMail } = await import("@friday/shared/services");

      const name = `wake-${type}`;
      await registry.registerAgent({ name, type: "bare" });

      vi.spyOn(lifecycle, "isAgentLive").mockReturnValue(true);
      const wakeSpy = vi.spyOn(lifecycle, "wakeAgent").mockReturnValue(true);
      const criticalSpy = vi.spyOn(lifecycle, "wakeAgentCritical").mockReturnValue(true);
      const dispatchSpy = vi.spyOn(lifecycle, "dispatchTurn").mockImplementation(() => {});

      await sendMail({
        fromAgent: "planner-parent",
        toAgent: name,
        type,
        subject: `[handoff] topic-${type}`,
        body: `${type} wake body`,
      });

      // The bridge handler is fire-and-forget async — poll until the wake
      // IPC fires for this recipient.
      await vi.waitFor(
        () => {
          expect(wakeSpy).toHaveBeenCalledWith(name);
        },
        { timeout: 5000, interval: 25 },
      );
      // Normal priority → plain wake, never the critical channel; live
      // recipient → no respawn dispatch.
      expect(criticalSpy).not.toHaveBeenCalled();
      expect(dispatchSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["message", "handoff"] as const)(
    "respawns a dead recipient on a %s mail via dispatchTurn with the mail body in the prompt",
    async (type) => {
      const registry = await import("../agent/registry.js");
      const lifecycle = await import("../agent/lifecycle.js");
      const { sendMail } = await import("@friday/shared/services");

      const name = `respawn-${type}`;
      await registry.registerAgent({ name, type: "bare" });

      // No live worker (isAgentLive is naturally false in tests) — the
      // bridge falls through to maybeSpawnFromMail.
      const dispatchSpy = vi.spyOn(lifecycle, "dispatchTurn").mockImplementation(() => {});

      await sendMail({
        fromAgent: "planner-parent",
        toAgent: name,
        type,
        subject: `[handoff] topic-${type}`,
        body: `revive on ${type}`,
      });

      await vi.waitFor(
        () => {
          expect(dispatchSpy).toHaveBeenCalledTimes(1);
        },
        { timeout: 5000, interval: 25 },
      );
      const input = dispatchSpy.mock.calls[0]?.[0] as {
        agentName: string;
        options: { agentType: string; mode: string; prompt: string };
      };
      expect(input.agentName).toBe(name);
      expect(input.options.agentType).toBe("bare");
      expect(input.options.mode).toBe("long-lived");
      expect(input.options.prompt).toContain(`revive on ${type}`);
    },
  );
});
