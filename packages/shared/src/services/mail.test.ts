import Database from "better-sqlite3";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

let raw: Database.Database;

vi.mock("../db/client.js", async () => {
  const drizzleMod = await import("drizzle-orm/better-sqlite3");
  const schema = await import("../db/schema.js");
  return {
    getRawDb: () => raw,
    getDb: () => drizzleMod.drizzle(raw, { schema }),
    closeDb: () => {
      raw.close();
    },
  };
});

beforeEach(async () => {
  raw = new Database(":memory:");
  raw.pragma("journal_mode = MEMORY");
  raw.pragma("foreign_keys = ON");
  const { runMigrations } = await import("../db/migrate.js");
  runMigrations();
});

afterEach(() => {
  raw.close();
});

describe("mail priority (FIX_FORWARD 2.3)", () => {
  it("sendMail defaults priority to 'normal'", async () => {
    const { sendMail } = await import("./mail.js");
    const row = sendMail({
      fromAgent: "alpha",
      toAgent: "beta",
      type: "message",
      body: "default priority",
    });
    expect(row.priority).toBe("normal");
  });

  it("sendMail persists priority='critical' when set", async () => {
    const { sendMail, inbox } = await import("./mail.js");
    sendMail({
      fromAgent: "alpha",
      toAgent: "beta",
      type: "message",
      body: "urgent reply",
      priority: "critical",
    });
    const rows = inbox("beta");
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

    sendMail({
      fromAgent: "alpha",
      toAgent: "beta",
      type: "message",
      body: "normal",
    });
    sendMail({
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
