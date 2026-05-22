import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
        expect(rows.map((r) => r.turnId)).toEqual([
          "mail_200",
          "mail_201",
          "mail_202",
        ]);
      },
      { timeout: 5000, interval: 25 },
    );
  });
});
