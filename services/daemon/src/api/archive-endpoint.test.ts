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

import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

const dataRoot = mkdtempSync(join(tmpdir(), "friday-archive-rest-"));
process.env.FRIDAY_DATA_DIR = dataRoot;
delete process.env.LINEAR_API_KEY;

const { runMigrations, closeDb } = await import("@friday/shared");
const { createTicket, getTicket } = await import("@friday/shared/services");
const registry = await import("../agent/registry.js");
const { startServer } = await import("./server.js");

let server: Server;
let port: number;

beforeAll(async () => {
  runMigrations();
  server = startServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port assigned");
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  rmSync(dataRoot, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test uses a unique agent name so registry rows don't collide.
});

afterEach(() => {
  // No global side effects to clean up between tests.
});

function archiveUrl(name: string): string {
  return `http://127.0.0.1:${port}/api/agents/${encodeURIComponent(name)}/archive`;
}

describe("POST /api/agents/:name/archive — contract", () => {
  it("returns 400 when reason is missing from the request body", async () => {
    registry.registerAgent({
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
    expect(registry.getAgent("rest-missing-reason")?.status).not.toBe(
      "archived",
    );
  });

  it("returns 400 when reason is not one of the allowed values", async () => {
    registry.registerAgent({
      name: "rest-bad-reason",
      type: "builder",
      parentName: "orchestrator",
      worktreePath: "/tmp/rest-bad-reason",
      branch: "friday/rest-bad-reason",
    });

    const res = await fetch(archiveUrl("rest-bad-reason"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "refork" }), // refork is internal only
    });

    expect(res.status).toBe(400);
  });

  it("with reason='completed' moves the linked ticket to 'done' end-to-end", async () => {
    const t = createTicket({ title: "rest-happy", status: "in_progress" });
    registry.registerAgent({
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
    expect(getTicket(t.id)?.status).toBe("done");
    expect(registry.getAgent("rest-completed")?.status).toBe("archived");
  });

  it("with reason='abandoned' moves the linked ticket to 'closed'", async () => {
    const t = createTicket({ title: "rest-abandoned", status: "in_progress" });
    registry.registerAgent({
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
    expect(getTicket(t.id)?.status).toBe("closed");
  });

  it("returns 404 when the agent doesn't exist (before reason validation)", async () => {
    const res = await fetch(archiveUrl("does-not-exist"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "completed" }),
    });
    expect(res.status).toBe(404);
  });
});
