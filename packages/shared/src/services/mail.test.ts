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

describe("searchMail (FRI-153)", () => {
  type SeedRow = {
    fromAgent?: string;
    toAgent?: string;
    type?: "message" | "notification" | "task";
    delivery?: "pending" | "read" | "closed";
    body: string;
    subject?: string;
    priority?: "normal" | "critical";
    ts?: Date;
  };

  async function seed(rows: SeedRow[]) {
    const { getDb } = await import("../db/client.js");
    const schema = await import("../db/schema.js");
    const now = Date.now();
    await getDb()
      .insert(schema.mail)
      .values(
        rows.map((r, i) => ({
          fromAgent: r.fromAgent ?? "alpha",
          toAgent: r.toAgent ?? "beta",
          type: r.type ?? "message",
          delivery: r.delivery ?? "pending",
          body: r.body,
          subject: r.subject ?? null,
          priority: r.priority ?? "normal",
          ts: r.ts ?? new Date(now - i * 1000),
        })),
      );
  }

  it("returns all rows when no filters applied", async () => {
    const { searchMail } = await import("./mail.js");
    await seed([{ body: "first" }, { body: "second" }, { body: "third" }]);
    const result = await searchMail({});
    expect(result.total).toBe(3);
    expect(result.results).toHaveLength(3);
  });

  it("FTS query filters to matching rows only", async () => {
    const { searchMail } = await import("./mail.js");
    await seed([
      { body: "deploy the dashboard hotfix", subject: "deploy" },
      { body: "weekly standup notes" },
      { body: "dashboard performance report" },
    ]);
    const result = await searchMail({ q: "dashboard" });
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    for (const r of result.results) {
      const text = `${r.subject ?? ""} ${r.body}`.toLowerCase();
      expect(text).toMatch(/dashboard/);
    }
  });

  it("FTS orders results by ts_rank descending", async () => {
    const { searchMail } = await import("./mail.js");
    await seed([
      { body: "dashboard dashboard dashboard dashboard" },
      { body: "dashboard mentioned once here" },
    ]);
    const result = await searchMail({ q: "dashboard" });
    expect(result.results.length).toBe(2);
    // Row with higher term density should rank first
    expect(result.results[0].body).toContain("dashboard dashboard");
  });

  it("filters by from agent", async () => {
    const { searchMail } = await import("./mail.js");
    await seed([
      { fromAgent: "orchestrator", toAgent: "builder", body: "task assigned" },
      { fromAgent: "builder", toAgent: "orchestrator", body: "task complete" },
    ]);
    const result = await searchMail({ from: "orchestrator" });
    expect(result.total).toBe(1);
    expect(result.results[0].fromAgent).toBe("orchestrator");
  });

  it("filters by to agent", async () => {
    const { searchMail } = await import("./mail.js");
    await seed([
      { fromAgent: "orchestrator", toAgent: "builder", body: "task assigned" },
      { fromAgent: "builder", toAgent: "orchestrator", body: "task complete" },
    ]);
    const result = await searchMail({ to: "builder" });
    expect(result.total).toBe(1);
    expect(result.results[0].toAgent).toBe("builder");
  });

  it("filters by involves (matches from OR to)", async () => {
    const { searchMail } = await import("./mail.js");
    await seed([
      { fromAgent: "orchestrator", toAgent: "builder", body: "task assigned" },
      { fromAgent: "builder", toAgent: "orchestrator", body: "task complete" },
      { fromAgent: "helper", toAgent: "helper2", body: "unrelated" },
    ]);
    const result = await searchMail({ involves: "orchestrator" });
    expect(result.total).toBe(2);
    for (const r of result.results) {
      expect(r.fromAgent === "orchestrator" || r.toAgent === "orchestrator").toBe(true);
    }
  });

  it("filters by delivery status (single)", async () => {
    const { searchMail } = await import("./mail.js");
    await seed([
      { body: "pending one", delivery: "pending" },
      { body: "already read", delivery: "read" },
      { body: "closed out", delivery: "closed" },
    ]);
    const result = await searchMail({ delivery: ["read"] });
    expect(result.total).toBe(1);
    expect(result.results[0].delivery).toBe("read");
  });

  it("filters by multiple delivery statuses", async () => {
    const { searchMail } = await import("./mail.js");
    await seed([
      { body: "pending one", delivery: "pending" },
      { body: "already read", delivery: "read" },
      { body: "closed out", delivery: "closed" },
    ]);
    const result = await searchMail({ delivery: ["pending", "read"] });
    expect(result.total).toBe(2);
  });

  it("filters by priority", async () => {
    const { searchMail } = await import("./mail.js");
    await seed([
      { body: "urgent", priority: "critical" },
      { body: "routine", priority: "normal" },
    ]);
    const result = await searchMail({ priority: ["critical"] });
    expect(result.total).toBe(1);
    expect(result.results[0].priority).toBe("critical");
  });

  it("filters by time range (since)", async () => {
    const { searchMail } = await import("./mail.js");
    const { getDb } = await import("../db/client.js");
    const schema = await import("../db/schema.js");
    const now = Date.now();
    await getDb()
      .insert(schema.mail)
      .values([
        {
          fromAgent: "a",
          toAgent: "b",
          type: "message",
          delivery: "pending",
          body: "recent",
          priority: "normal",
          ts: new Date(now - 1 * 60 * 60 * 1000), // 1 hour ago
        },
        {
          fromAgent: "a",
          toAgent: "b",
          type: "message",
          delivery: "pending",
          body: "old",
          priority: "normal",
          ts: new Date(now - 10 * 24 * 60 * 60 * 1000), // 10 days ago
        },
      ]);
    const since = new Date(now - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
    const result = await searchMail({ since });
    expect(result.total).toBe(1);
    expect(result.results[0].body).toBe("recent");
  });

  it("filters by time range (until)", async () => {
    const { searchMail } = await import("./mail.js");
    const { getDb } = await import("../db/client.js");
    const schema = await import("../db/schema.js");
    const now = Date.now();
    await getDb()
      .insert(schema.mail)
      .values([
        {
          fromAgent: "a",
          toAgent: "b",
          type: "message",
          delivery: "pending",
          body: "recent",
          priority: "normal",
          ts: new Date(now - 1 * 60 * 60 * 1000),
        },
        {
          fromAgent: "a",
          toAgent: "b",
          type: "message",
          delivery: "pending",
          body: "old",
          priority: "normal",
          ts: new Date(now - 10 * 24 * 60 * 60 * 1000),
        },
      ]);
    const until = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    const result = await searchMail({ until });
    expect(result.total).toBe(1);
    expect(result.results[0].body).toBe("old");
  });

  it("combines FTS query with metadata filters", async () => {
    const { searchMail } = await import("./mail.js");
    await seed([
      {
        body: "deploy the dashboard",
        delivery: "pending",
        fromAgent: "orchestrator",
        toAgent: "builder",
      },
      { body: "dashboard report", delivery: "read", fromAgent: "orchestrator", toAgent: "builder" },
      {
        body: "deploy the scheduler",
        delivery: "pending",
        fromAgent: "orchestrator",
        toAgent: "builder",
      },
    ]);
    const result = await searchMail({ q: "dashboard", delivery: ["pending"] });
    expect(result.total).toBe(1);
    expect(result.results[0].body).toContain("dashboard");
    expect(result.results[0].delivery).toBe("pending");
  });

  it("empty query returns rows ordered by ts desc without FTS", async () => {
    const { searchMail } = await import("./mail.js");
    const { getDb } = await import("../db/client.js");
    const schema = await import("../db/schema.js");
    const now = Date.now();
    await getDb()
      .insert(schema.mail)
      .values([
        {
          fromAgent: "a",
          toAgent: "b",
          type: "message",
          delivery: "pending",
          body: "oldest",
          priority: "normal",
          ts: new Date(now - 3000),
        },
        {
          fromAgent: "a",
          toAgent: "b",
          type: "message",
          delivery: "pending",
          body: "newest",
          priority: "normal",
          ts: new Date(now - 1000),
        },
        {
          fromAgent: "a",
          toAgent: "b",
          type: "message",
          delivery: "pending",
          body: "middle",
          priority: "normal",
          ts: new Date(now - 2000),
        },
      ]);
    const result = await searchMail({});
    expect(result.results[0].body).toBe("newest");
    expect(result.results[2].body).toBe("oldest");
  });

  it("limit and offset paginate results", async () => {
    const { searchMail } = await import("./mail.js");
    await seed([{ body: "a" }, { body: "b" }, { body: "c" }, { body: "d" }, { body: "e" }]);
    const page1 = await searchMail({ limit: 2, offset: 0 });
    const page2 = await searchMail({ limit: 2, offset: 2 });
    expect(page1.results).toHaveLength(2);
    expect(page2.results).toHaveLength(2);
    expect(page1.total).toBe(5);
    // Pages should not overlap
    const ids1 = page1.results.map((r) => r.id);
    const ids2 = page2.results.map((r) => r.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });
});

describe("replayPending age cap (FRI-118)", () => {
  it("emits only pending rows younger than 7 days", async () => {
    const { mailBus, replayPending, REPLAY_PENDING_MAX_AGE_MS } = await import("./mail.js");
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
