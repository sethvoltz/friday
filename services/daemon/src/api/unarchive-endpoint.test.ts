/**
 * Contract tests for the REST unarchive endpoint:
 *   POST /api/agents/:name/unarchive
 *
 * Covers 404 (no such agent), 409 (not_archived), happy path for helper and
 * builder (worktree already gone — just a status reset), and idempotency guard
 * (already idle → 409).
 *
 * Uses a real HTTP server bound to port 0 to get a free port. No
 * authorization needed — the unarchive endpoint isn't behind same-host auth.
 */

import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

vi.mock("@friday/shared", async (importActual) => {
  const actual = await importActual<typeof import("@friday/shared")>();
  return {
    ...actual,
    loadFridayConfig: () => ({
      betterAuthSecret: "test-better-auth",
      zeroAuthSecret: "test-zero-auth",
      zeroAdminPassword: "test-zero-admin",
      databaseUrl: process.env.DATABASE_URL,
      zeroUpstreamDb: undefined,
      zeroReplicaFile: undefined,
      linearApiKey: undefined,
      anthropicApiKey: undefined,
      cloudflareTunnelToken: undefined,
      posthogApiKey: undefined,
      posthogHost: undefined,
    }),
  };
});

let handle: TestDbHandle;
let server: Server;
let port: number;
let registry: typeof import("../agent/registry.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "unarchive_rest" });
  registry = await import("../agent/registry.js");
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

function unarchiveUrl(name: string): string {
  return `http://127.0.0.1:${port}/api/agents/${encodeURIComponent(name)}/unarchive`;
}

async function post(name: string) {
  return fetch(unarchiveUrl(name), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

describe("POST /api/agents/:name/unarchive — contract", () => {
  it("returns 404 when agent doesn't exist", async () => {
    const res = await post("does-not-exist");
    expect(res.status).toBe(404);
  });

  it("returns 409 with code=not_archived when agent is idle (not archived)", async () => {
    await registry.registerAgent({
      name: "unarchive-idle",
      type: "helper",
      parentName: "orchestrator",
    });

    const res = await post("unarchive-idle");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("not_archived");
    expect(body.error).toContain("unarchive-idle");
  });

  it("returns 200 and sets status=idle for an archived helper", async () => {
    await registry.registerAgent({
      name: "unarchive-helper",
      type: "helper",
      parentName: "orchestrator",
    });
    // Archive it first so we can unarchive it.
    await registry.archiveAgent("unarchive-helper", { reason: "completed" });
    expect((await registry.getAgent("unarchive-helper"))?.status).toBe("archived");

    const res = await post("unarchive-helper");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect((await registry.getAgent("unarchive-helper"))?.status).toBe("idle");
  });

  it("returns 200 for a builder whose worktree is already gone — just a status reset", async () => {
    await registry.registerAgent({
      name: "unarchive-builder",
      type: "builder",
      parentName: "orchestrator",
      worktreePath: "/tmp/unarchive-builder",
      branch: "friday/unarchive-builder",
    });
    await registry.archiveAgent("unarchive-builder", { reason: "completed" });
    expect((await registry.getAgent("unarchive-builder"))?.status).toBe("archived");

    const res = await post("unarchive-builder");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect((await registry.getAgent("unarchive-builder"))?.status).toBe("idle");
  });

  it("returns 409 (idempotency guard) when unarchive is called on an already-idle agent", async () => {
    await registry.registerAgent({
      name: "unarchive-already-idle",
      type: "helper",
      parentName: "orchestrator",
    });
    // Archive then immediately unarchive via registry so status is idle.
    await registry.archiveAgent("unarchive-already-idle", { reason: "completed" });
    await registry.unarchiveAgent("unarchive-already-idle");
    expect((await registry.getAgent("unarchive-already-idle"))?.status).toBe("idle");

    // Second unarchive call must be blocked.
    const res = await post("unarchive-already-idle");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_archived");
  });
});
