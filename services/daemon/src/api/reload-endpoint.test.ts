import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestDb,
  getDaemonSecret,
  DAEMON_SECRET_HEADER,
  type TestDbHandle,
} from "@friday/shared";

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

vi.mock("../apps/installer.js", async (importActual) => {
  const actual = await importActual<typeof import("../apps/installer.js")>();
  return { ...actual, reloadApp: vi.fn() };
});

vi.mock("../agent/lifecycle.js", async (importActual) => {
  const actual = await importActual<typeof import("../agent/lifecycle.js")>();
  return { ...actual, stopWorkersForApp: vi.fn() };
});

let handle: TestDbHandle;
let server: Server;
let port: number;
let secret: string;

beforeAll(async () => {
  handle = await createTestDb({ label: "reload_endpoint" });
  const { startServer } = await import("./server.js");
  server = startServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port assigned");
  port = addr.port;
  secret = getDaemonSecret();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  const { reloadApp } = await import("../apps/installer.js");
  const { stopWorkersForApp } = await import("../agent/lifecycle.js");
  vi.mocked(reloadApp).mockReset();
  vi.mocked(stopWorkersForApp).mockReset();
});

function reloadUrl(appId: string): string {
  return `http://127.0.0.1:${port}/api/apps/${encodeURIComponent(appId)}/reload`;
}

function authHeaders(): Record<string, string> {
  return { [DAEMON_SECRET_HEADER]: secret };
}

describe("POST /api/apps/:id/reload", () => {
  it("returns 200 with { id, changed, stoppedWorkers } on success", async () => {
    const { reloadApp } = await import("../apps/installer.js");
    const { stopWorkersForApp } = await import("../agent/lifecycle.js");
    vi.mocked(reloadApp).mockResolvedValueOnce({ id: "my-app", changed: true });
    vi.mocked(stopWorkersForApp).mockResolvedValueOnce(2);

    const res = await fetch(reloadUrl("my-app"), { method: "POST", headers: authHeaders() });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: "my-app", changed: true, stoppedWorkers: 2 });
  });

  it("when reloadApp throws, stopWorkersForApp is not called", async () => {
    const { reloadApp } = await import("../apps/installer.js");
    const { stopWorkersForApp } = await import("../agent/lifecycle.js");
    vi.mocked(reloadApp).mockRejectedValueOnce(new Error("disk read failure"));

    const res = await fetch(reloadUrl("bad-app"), { method: "POST", headers: authHeaders() });

    expect(res.status).toBe(400);
    expect(vi.mocked(stopWorkersForApp)).not.toHaveBeenCalled();
  });

  it("when manifest is unchanged (changed: false), stopWorkersForApp is still called", async () => {
    const { reloadApp } = await import("../apps/installer.js");
    const { stopWorkersForApp } = await import("../agent/lifecycle.js");
    vi.mocked(reloadApp).mockResolvedValueOnce({ id: "stable-app", changed: false });
    vi.mocked(stopWorkersForApp).mockResolvedValueOnce(0);

    const res = await fetch(reloadUrl("stable-app"), { method: "POST", headers: authHeaders() });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean; stoppedWorkers: number };
    expect(body.changed).toBe(false);
    expect(body.stoppedWorkers).toBe(0);
    expect(vi.mocked(stopWorkersForApp)).toHaveBeenCalledWith("stable-app");
  });

  it("returns 401 when the daemon secret is missing", async () => {
    const res = await fetch(reloadUrl("any-app"), { method: "POST" });
    expect(res.status).toBe(401);
  });
});
