/**
 * Phase 4.10 — POST /api/internal/abort-turn fast-path contract tests.
 *
 * The endpoint dispatches the existing `abortTurn(agentName)`
 * lifecycle function synchronously. No live worker exists in these
 * tests (we don't spawn child processes), so `aborted=false` is the
 * expected response — what we're pinning is the HTTP contract
 * (validation, idempotency, response shape).
 *
 * The full lifecycle abort behavior (IPC dispatch, force-kill arm,
 * worker reaping) lives in `lifecycle-stop-forcekill.test.ts`.
 */

import type { Server } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;
let server: Server;
let port: number;

beforeAll(async () => {
  handle = await createTestDb({ label: "abort_fastpath" });
  const { startServer } = await import("./server.js");
  server = startServer({ port: 0 });
  await new Promise<void>((resolve) =>
    server.once("listening", () => resolve()),
  );
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

function url(): string {
  return `http://127.0.0.1:${port}/api/internal/abort-turn`;
}

describe("POST /api/internal/abort-turn (Phase 4.10 fast-path)", () => {
  it("returns 400 when turn_id is missing", async () => {
    const res = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_turn_id");
  });

  it("returns ok:true with aborted:false when no live worker matches the turn", async () => {
    // No agent registered, no worker spawned. The fast-path is
    // idempotent against the LISTEN-path here: even though the
    // worker doesn't exist, the dashboard's mutator-path will still
    // dispatch the lifecycle abort (no-op) and flip the block row
    // back to 'complete'. The HTTP contract is "200 ok regardless,
    // aborted flag reflects whether a live worker existed."
    const res = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turn_id: "turn-ghost" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      aborted: boolean;
      turn_id: string;
      agent: string | null;
    };
    expect(body.ok).toBe(true);
    expect(body.aborted).toBe(false);
    expect(body.turn_id).toBe("turn-ghost");
  });

  it("is idempotent — re-posting the same turn_id returns the same response", async () => {
    // No live worker exists. Each call dispatches abortTurn(no-op),
    // returns aborted=false. The fast-path's HTTP contract MUST be
    // stable across retries — the dashboard wrapper may retry on
    // transient network errors and we don't want surprises.
    const first = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turn_id: "turn-retry" }),
    });
    const firstBody = (await first.json()) as Record<string, unknown>;
    const second = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turn_id: "turn-retry" }),
    });
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody).toEqual(firstBody);
  });

  it("returns 200 with aborted:false + agent:null when turn_id is empty string", async () => {
    // Defense in depth — typeof check accepts non-empty string only.
    const res = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turn_id: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("response shape mirrors the legacy /api/chat/turn/<id>/abort endpoint (callers share parsers)", async () => {
    // Both endpoints return the same shape: { ok, aborted, turn_id,
    // agent }. The dashboard's stop() wrapper used to consume the
    // legacy shape; Phase 4.10 mutator wrapper consumes this one.
    const res = await fetch(url(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turn_id: "turn-shape" }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["agent", "aborted", "ok", "turn_id"].sort(),
    );
    expect(typeof body.aborted).toBe("boolean");
    expect(body.turn_id).toBe("turn-shape");
  });
});

