import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

/**
 * Round-trip coverage for the habits route family. Before the cascade→table
 * migration these arms had NO daemon HTTP test — they would have moved without a
 * regression net. This pins the things the migration could break: method+path
 * routing, the load-bearing ORDER (the `/checkin/<id>`, `/<id>/checkin`,
 * `/<id>/archive` paths must resolve before the bare `/<id>` regex), the
 * required-field 400, and the 404s. Full HTTP round-trip against a scratch DB,
 * mirroring the existing endpoint tests.
 */

let handle: TestDbHandle;
let server: Server;
let port: number;

beforeAll(async () => {
  handle = await createTestDb({ label: "habits_endpoint" });
  const { startServer } = await import("./server.js");
  server = startServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port assigned");
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

const base = () => `http://127.0.0.1:${port}`;

async function createHabit(body: Record<string, unknown>) {
  return fetch(`${base()}/api/habits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("habits route family (cascade→table migration net)", () => {
  it("POST /api/habits 400s when name/mode/period are missing", async () => {
    const res = await createHabit({ name: "only-name" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("name, mode, and period are required");
  });

  it("POST then GET round-trips a habit and lists it with a streak", async () => {
    const created = await createHabit({ name: "floss", mode: "ongoing", period: "day" });
    expect(created.status).toBe(200);
    const habit = (await created.json()) as { id: string; name: string };
    expect(habit).toMatchObject({ name: "floss" });
    // bigserial id is serialized as a string (pg returns bigint as text).
    expect(typeof habit.id).toBe("string");

    const list = await fetch(`${base()}/api/habits`);
    expect(list.status).toBe(200);
    const habits = (await list.json()) as Array<{ id: string; streak?: unknown }>;
    expect(habits).toHaveLength(1);
    expect(habits[0].id).toBe(habit.id);
    expect(habits[0]).toHaveProperty("streak");
  });

  it("ORDER: /<id>/checkin and /checkin/<id> resolve to the check-in routes, not the bare /<id> route", async () => {
    const created = await createHabit({ name: "pushups", mode: "ongoing", period: "day" });
    const { id } = (await created.json()) as { id: string };

    // POST /<id>/checkin — would be swallowed by the bare /<id> regex if mis-ordered.
    const checkin = await fetch(`${base()}/api/habits/${id}/checkin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "done" }),
    });
    expect(checkin.status).toBe(200);
    const checkinRow = (await checkin.json()) as { id: string };
    expect(typeof checkinRow.id).toBe("string");

    // GET /<id> — the bare route returns the habit + its check-ins.
    const got = await fetch(`${base()}/api/habits/${id}`);
    expect(got.status).toBe(200);
    const detail = (await got.json()) as { id: string; checkins: unknown[] };
    expect(detail.id).toBe(id);
    expect(detail.checkins).toHaveLength(1);

    // DELETE /checkin/<id> — the single allowed check-in delete. Must NOT be
    // read as DELETE /habits/<id> (there is no such route → would 404).
    const del = await fetch(`${base()}/api/habits/checkin/${checkinRow.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
  });

  it("POST /<id>/archive flips the habit to archived (and 404s an unknown id)", async () => {
    const created = await createHabit({ name: "meditate", mode: "ongoing", period: "day" });
    const { id } = (await created.json()) as { id: string };

    const archived = await fetch(`${base()}/api/habits/${id}/archive`, { method: "POST" });
    expect(archived.status).toBe(200);
    expect((await archived.json()) as { status: string }).toMatchObject({ status: "archived" });

    // A numeric-but-unknown id matches no row → 404 (the id column is bigserial).
    const missing = await fetch(`${base()}/api/habits/99999999/archive`, { method: "POST" });
    expect(missing.status).toBe(404);
  });
});
