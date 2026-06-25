import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

/**
 * Round-trip coverage for the memory route family — another arm that migrated
 * without a daemon HTTP net. Pins: the load-bearing ORDER (`/api/memory/search`
 * MUST resolve before the bare `/api/memory/<id>` regex, else "search" is read
 * as an entry id), the new schema-validated 400 on POST (the one route where the
 * adapter's schema replaces the cascade's inline check), and the create→read→
 * update→delete round-trip with the 200-vs-201 upsert status.
 */

let handle: TestDbHandle;
let server: Server;
let port: number;

beforeAll(async () => {
  handle = await createTestDb({ label: "memory_endpoint" });
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

async function saveMemory(body: Record<string, unknown>) {
  return fetch(`${base()}/api/memory`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("memory route family (cascade→table migration net)", () => {
  it("POST /api/memory 400s via the schema when title/content are missing", async () => {
    const res = await saveMemory({ title: "no content here" });
    expect(res.status).toBe(400);
    // The adapter surfaces the schema's validation message, which names the
    // offending field.
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("content");
  });

  it("POST creates (201), a re-POST to the same id upserts (200)", async () => {
    const first = await saveMemory({ title: "Seth likes oat milk", content: "in coffee" });
    expect(first.status).toBe(201);
    const entry = (await first.json()) as { id: string; title: string };
    expect(entry).toMatchObject({ title: "Seth likes oat milk" });

    const second = await saveMemory({
      id: entry.id,
      title: "Seth likes oat milk",
      content: "in coffee and tea",
    });
    expect(second.status).toBe(200);
    expect((await second.json()) as { content: string }).toMatchObject({
      content: "in coffee and tea",
    });
  });

  it("ORDER: GET /api/memory/search resolves to search, not the bare /<id> route", async () => {
    await saveMemory({ title: "Friday ships nightly", content: "release-please drives it" });

    // If `/search` were swallowed by `^/api/memory/[^/]+$`, this would 404
    // (no entry with id "search") instead of running a query.
    const res = await fetch(`${base()}/api/memory/search?q=${encodeURIComponent("nightly")}`);
    expect(res.status).toBe(200);
    const results = (await res.json()) as unknown[];
    expect(Array.isArray(results)).toBe(true);

    // And the bare /<id> route still 404s a genuinely unknown id.
    const missing = await fetch(`${base()}/api/memory/no-such-entry`);
    expect(missing.status).toBe(404);
  });

  it("GET /api/memory/search 400s without a q parameter", async () => {
    const res = await fetch(`${base()}/api/memory/search`);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: "q parameter required" });
  });

  it("PATCH then DELETE round-trips an entry by id", async () => {
    const created = await saveMemory({ title: "temp note", content: "v1" });
    const { id } = (await created.json()) as { id: string };

    const patched = await fetch(`${base()}/api/memory/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "v2" }),
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()) as { content: string }).toMatchObject({ content: "v2" });

    const del = await fetch(`${base()}/api/memory/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    const gone = await fetch(`${base()}/api/memory/${id}`);
    expect(gone.status).toBe(404);
  });
});
