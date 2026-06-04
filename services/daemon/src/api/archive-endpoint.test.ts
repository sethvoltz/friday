/**
 * Contract tests for the REST archive endpoint:
 *   POST /api/agents/:name/archive { "reason": "completed" | "abandoned" | "failed" }
 *
 * The endpoint validates `reason` and forwards to `archiveAgent`, which in
 * turn triggers the ticket-close service. We exercise both the validation
 * (400 without reason) and the end-to-end happy path (archive → linked
 * ticket flipped).
 *
 * Uses a real HTTP server bound to port 0 to get a free port. No
 * authorization needed — the archive endpoint isn't behind same-host auth.
 */

import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

// FRI-150 (pivot, ADR-037): production code reads LINEAR_API_KEY via
// loadFridayConfig(). Mock the loader to return undefined so the archive
// endpoint takes the no-Linear-key code path.
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
let createTicket: (typeof import("@friday/shared/services"))["createTicket"];
let getTicket: (typeof import("@friday/shared/services"))["getTicket"];
let registry: typeof import("../agent/registry.js");

beforeAll(async () => {
  handle = await createTestDb({ label: "archive_rest" });
  ({ createTicket, getTicket } = await import("@friday/shared/services"));
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

function archiveUrl(name: string): string {
  return `http://127.0.0.1:${port}/api/agents/${encodeURIComponent(name)}/archive`;
}

describe("POST /api/agents/:name/archive — contract", () => {
  it("returns 400 when reason is missing from the request body", async () => {
    await registry.registerAgent({
      name: "rest-missing-reason",
      type: "builder",
      parentName: "orchestrator",
      worktreePath: "/tmp/rest-missing-reason",
      branch: "friday/rest-missing-reason",
    });

    const res = await fetch(archiveUrl("rest-missing-reason"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("reason");
    // Agent must not have been archived on a 400.
    expect((await registry.getAgent("rest-missing-reason"))?.status).not.toBe("archived");
  });

  it("returns 400 when reason is not one of the allowed values", async () => {
    await registry.registerAgent({
      name: "rest-bad-reason",
      type: "builder",
      parentName: "orchestrator",
      worktreePath: "/tmp/rest-bad-reason",
      branch: "friday/rest-bad-reason",
    });

    const res = await fetch(archiveUrl("rest-bad-reason"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "garbage" }),
    });

    expect(res.status).toBe(400);
  });

  it("with reason='completed' moves the linked ticket to 'done' end-to-end", async () => {
    const t = await createTicket({ title: "rest-happy", status: "in_progress" });
    await registry.registerAgent({
      name: "rest-completed",
      type: "builder",
      parentName: "orchestrator",
      worktreePath: "/tmp/rest-completed",
      branch: "friday/rest-completed",
      ticketId: t.id,
    });

    const res = await fetch(archiveUrl("rest-completed"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "completed" }),
    });

    expect(res.status).toBe(200);
    // ticket-close is fire-and-forget; poll until it lands.
    await vi.waitFor(
      async () => {
        expect((await getTicket(t.id))?.status).toBe("done");
      },
      { timeout: 5000, interval: 25 },
    );
    expect((await registry.getAgent("rest-completed"))?.status).toBe("archived");
  });

  it("with reason='abandoned' moves the linked ticket to 'closed'", async () => {
    const t = await createTicket({
      title: "rest-abandoned",
      status: "in_progress",
    });
    await registry.registerAgent({
      name: "rest-abandoned",
      type: "builder",
      parentName: "orchestrator",
      worktreePath: "/tmp/rest-abandoned",
      branch: "friday/rest-abandoned",
      ticketId: t.id,
    });

    const res = await fetch(archiveUrl("rest-abandoned"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "abandoned" }),
    });

    expect(res.status).toBe(200);
    await vi.waitFor(
      async () => {
        expect((await getTicket(t.id))?.status).toBe("closed");
      },
      { timeout: 5000, interval: 25 },
    );
  });

  it("returns 404 when the agent doesn't exist (before reason validation)", async () => {
    const res = await fetch(archiveUrl("does-not-exist"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "completed" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 with code=app_agent_protected when archiving a bare agent with an appId", async () => {
    await registry.registerAgent({
      name: "kitchen",
      type: "bare",
      appId: "kitchen",
    });

    const res = await fetch(archiveUrl("kitchen"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "completed" }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("app_agent_protected");
    expect(body.error).toContain("kitchen");
    // Agent must not have been archived.
    expect((await registry.getAgent("kitchen"))?.status).not.toBe("archived");
  });

  it("allows archiving a bare agent that has no appId", async () => {
    await registry.registerAgent({
      name: "bare-no-app",
      type: "bare",
    });

    const res = await fetch(archiveUrl("bare-no-app"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "completed" }),
    });

    expect(res.status).toBe(200);
    expect((await registry.getAgent("bare-no-app"))?.status).toBe("archived");
  });
});
