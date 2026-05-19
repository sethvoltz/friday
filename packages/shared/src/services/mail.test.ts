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
