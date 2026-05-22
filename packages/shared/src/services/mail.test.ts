import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "../db/test-pg.js";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "mail" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

describe("mail priority (FIX_FORWARD 2.3)", () => {
  it("sendMail defaults priority to 'normal'", async () => {
    const { sendMail } = await import("./mail.js");
    const row = await sendMail({
      fromAgent: "alpha",
      toAgent: "beta",
      type: "message",
      body: "default priority",
    });
    expect(row.priority).toBe("normal");
  });

  it("sendMail persists priority='critical' when set", async () => {
    const { sendMail, inbox } = await import("./mail.js");
    await sendMail({
      fromAgent: "alpha",
      toAgent: "beta",
      type: "message",
      body: "urgent reply",
      priority: "critical",
    });
    const rows = await inbox("beta");
    expect(rows.length).toBe(1);
    expect(rows[0].priority).toBe("critical");
  });

  it("emits mail:critical:<recipient> for critical mail (FIX_FORWARD 2.4 hook)", async () => {
    const { sendMail, mailBus } = await import("./mail.js");
    const seen: string[] = [];
    mailBus.on("mail:critical:beta", (row: { id: number }) => {
      seen.push(`critical-${row.id}`);
    });
    mailBus.on("mail:to:beta", (row: { id: number }) => {
      seen.push(`normal-${row.id}`);
    });

    await sendMail({
      fromAgent: "alpha",
      toAgent: "beta",
      type: "message",
      body: "normal",
    });
    await sendMail({
      fromAgent: "alpha",
      toAgent: "beta",
      type: "message",
      body: "critical",
      priority: "critical",
    });

    // Both emit the catch-all `mail:to:beta`; only the critical one fires
    // `mail:critical:beta`.
    const normalCount = seen.filter((s) => s.startsWith("normal-")).length;
    const criticalCount = seen.filter((s) => s.startsWith("critical-")).length;
    expect(normalCount).toBe(2);
    expect(criticalCount).toBe(1);
  });
});

describe("replayPending age cap (FRI-118)", () => {
  it("emits only pending rows younger than 7 days", async () => {
    const { mailBus, replayPending, REPLAY_PENDING_MAX_AGE_MS } = await import(
      "./mail.js"
    );
    const { getDb } = await import("../db/client.js");
    const schema = await import("../db/schema.js");

    // Seed two pending rows: one 6 days old (should emit), one 8 days
    // old (should NOT emit).
    const now = Date.now();
    await getDb()
      .insert(schema.mail)
      .values([
        {
          fromAgent: "alpha",
          toAgent: "beta",
          type: "message",
          delivery: "pending",
          body: "fresh",
          ts: new Date(now - 6 * 24 * 60 * 60 * 1000),
          priority: "normal",
        },
        {
          fromAgent: "alpha",
          toAgent: "beta",
          type: "message",
          delivery: "pending",
          body: "stale",
          ts: new Date(now - 8 * 24 * 60 * 60 * 1000),
          priority: "normal",
        },
      ]);

    const seen: string[] = [];
    const handler = (row: { body: string }): void => {
      seen.push(row.body);
    };
    mailBus.on("mail:to:beta", handler);
    try {
      await replayPending();
    } finally {
      mailBus.off("mail:to:beta", handler);
    }

    expect(seen).toEqual(["fresh"]);
    // Sanity: cap value matches the documented 7 days.
    expect(REPLAY_PENDING_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("emits no rows when all pending are older than 7 days", async () => {
    const { mailBus, replayPending } = await import("./mail.js");
    const { getDb } = await import("../db/client.js");
    const schema = await import("../db/schema.js");

    const now = Date.now();
    await getDb()
      .insert(schema.mail)
      .values({
        fromAgent: "alpha",
        toAgent: "beta",
        type: "message",
        delivery: "pending",
        body: "ancient",
        ts: new Date(now - 30 * 24 * 60 * 60 * 1000),
        priority: "normal",
      });

    const seen: string[] = [];
    const handler = (row: { body: string }): void => {
      seen.push(row.body);
    };
    mailBus.on("mail:to:beta", handler);
    try {
      await replayPending();
    } finally {
      mailBus.off("mail:to:beta", handler);
    }

    expect(seen).toEqual([]);
  });
});
