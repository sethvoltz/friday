/**
 * FRI-118: mail prune — hard-deletes pending rows older than 30d whose
 * recipient is archived OR missing from `agents`.
 *
 * Seeds the four matrix corners and asserts each separately:
 *   1. archived recipient + >30d → delete
 *   2. missing recipient + >30d → delete
 *   3. archived recipient + <30d → keep
 *   4. read/closed delivery + >30d → keep regardless of recipient
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, schema, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;

beforeAll(async () => {
  handle = await createTestDb({ label: "mail_prune" });
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

const D = 24 * 60 * 60 * 1000;

async function seedAgent(opts: {
  name: string;
  type?: "orchestrator" | "builder" | "helper" | "scheduled" | "bare";
  status: "idle" | "working" | "stalled" | "error" | "archived";
}): Promise<void> {
  const { getDb } = await import("@friday/shared");
  const now = new Date();
  await getDb()
    .insert(schema.agents)
    .values({
      name: opts.name,
      type: opts.type ?? "builder",
      status: opts.status,
      parentName: opts.type === "builder" || !opts.type ? "friday" : null,
      worktreePath: opts.type === "builder" || !opts.type ? `/tmp/${opts.name}` : null,
      createdAt: now,
      updatedAt: now,
    });
}

async function seedMail(opts: {
  fromAgent: string;
  toAgent: string;
  delivery: "pending" | "read" | "closed";
  ageDays: number;
  body?: string;
}): Promise<number> {
  const { getDb } = await import("@friday/shared");
  const ts = new Date(Date.now() - opts.ageDays * D);
  const rows = await getDb()
    .insert(schema.mail)
    .values({
      fromAgent: opts.fromAgent,
      toAgent: opts.toAgent,
      type: "message",
      delivery: opts.delivery,
      body: opts.body ?? "test",
      ts,
      priority: "normal",
    })
    .returning({ id: schema.mail.id });
  return rows[0].id;
}

async function mailCount(id: number): Promise<number> {
  const { getDb } = await import("@friday/shared");
  const rows = await getDb().select().from(schema.mail).where(eq(schema.mail.id, id));
  return rows.length;
}

describe("mail prune (FRI-118)", () => {
  it("prunes pending older than 30d whose recipient is archived", async () => {
    await seedAgent({ name: "friday", type: "orchestrator", status: "idle" });
    await seedAgent({ name: "old-builder", status: "archived" });
    const stale = await seedMail({
      fromAgent: "friday",
      toAgent: "old-builder",
      delivery: "pending",
      ageDays: 31,
      body: "stale-archived-recipient",
    });
    const fresh = await seedMail({
      fromAgent: "friday",
      toAgent: "old-builder",
      delivery: "pending",
      ageDays: 29,
      body: "fresh-archived-recipient",
    });

    const { prune } = await import("./mail-prune.js");
    const result = await prune();

    expect(result.deleted).toBe(1);
    expect(await mailCount(stale)).toBe(0);
    expect(await mailCount(fresh)).toBe(1);
  });

  it("prunes pending older than 30d whose recipient does not exist in agents", async () => {
    const stale = await seedMail({
      fromAgent: "friday",
      toAgent: "never-existed",
      delivery: "pending",
      ageDays: 35,
      body: "stale-missing-recipient",
    });

    const { prune } = await import("./mail-prune.js");
    const result = await prune();

    expect(result.deleted).toBe(1);
    expect(await mailCount(stale)).toBe(0);
  });

  it("does NOT prune pending older than 30d whose recipient is still active (idle)", async () => {
    await seedAgent({ name: "still-active", status: "idle" });
    const stale = await seedMail({
      fromAgent: "friday",
      toAgent: "still-active",
      delivery: "pending",
      ageDays: 31,
      body: "stale-active-recipient",
    });

    const { prune } = await import("./mail-prune.js");
    const result = await prune();

    expect(result.deleted).toBe(0);
    expect(await mailCount(stale)).toBe(1);
  });

  it("does NOT touch read/closed mail regardless of age or recipient state", async () => {
    await seedAgent({ name: "old-recipient", status: "archived" });
    const veryOldRead = await seedMail({
      fromAgent: "friday",
      toAgent: "old-recipient",
      delivery: "read",
      ageDays: 100,
    });
    const veryOldClosed = await seedMail({
      fromAgent: "friday",
      toAgent: "old-recipient",
      delivery: "closed",
      ageDays: 100,
    });

    const { prune } = await import("./mail-prune.js");
    const result = await prune();

    expect(result.deleted).toBe(0);
    expect(await mailCount(veryOldRead)).toBe(1);
    expect(await mailCount(veryOldClosed)).toBe(1);
  });

  it("startMailPruner is idempotent and clean-shutdown via stopMailPruner", async () => {
    const { startMailPruner, stopMailPruner } = await import("./mail-prune.js");
    const t1 = startMailPruner();
    const t2 = startMailPruner();
    expect(t1).toBe(t2);
    stopMailPruner();
    // After stop, a fresh start hands back a NEW timer; the test just
    // pins the idempotency contract on the start side.
    const t3 = startMailPruner();
    expect(t3).not.toBe(t1);
    stopMailPruner();
  });
});
