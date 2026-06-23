/**
 * FRI-142 / ADR-048 producer seam #2 — builder_archive.
 *
 * `archiveAgent` fires `notify({ type: "builder_archive" })` AFTER the archived
 * projection lands — but ONLY for builders (a "your branch is ready" event).
 * Bare/scheduled/helper archives are routine lifecycle churn and raise nothing.
 *
 * Driven against a real test DB (archiveAgent reads + writes the agent row) with
 * the router mocked, so we assert exactly which event fires per agent type and
 * per reason. The notify call is fire-and-forget; archiveAgent awaits the
 * archive transition first, so the spy is observable synchronously after the
 * await.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

// Mock the router so we observe WHICH event archiveAgent fires.
const notifySpy = vi.fn();
vi.mock("../notifications/notify.js", () => ({ notify: (e: unknown) => notifySpy(e) }));
// Keep the ticket-closer (fire-and-forget) from reaching for a Linear key.
vi.mock("@friday/shared", async (importActual) => {
  const actual = await importActual<typeof import("@friday/shared")>();
  return {
    ...actual,
    loadFridayConfig: () => ({
      betterAuthSecret: "test",
      zeroAuthSecret: "test",
      zeroAdminPassword: "test",
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
let registry: typeof import("./registry.js");
let archiveAgent: (typeof import("./lifecycle.js"))["archiveAgent"];

beforeAll(async () => {
  handle = await createTestDb({ label: "lc_archive_notify" });
  registry = await import("./registry.js");
  ({ archiveAgent } = await import("./lifecycle.js"));
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  notifySpy.mockClear();
});

afterEach(() => vi.clearAllMocks());

describe("archiveAgent — builder_archive seam", () => {
  it("fires builder_archive with a 'finished' framing for a completed BUILDER", async () => {
    await registry.registerAgent({
      name: "builder-x",
      type: "builder",
      branch: "friday/builder-x",
    });

    await archiveAgent("builder-x", { reason: "completed" });

    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0]![0]).toMatchObject({
      type: "builder_archive",
      title: "A builder finished",
      deepLink: "/agents/builder-x",
    });
    expect(notifySpy.mock.calls[0]![0]).toMatchObject({
      body: expect.stringContaining("completed"),
    });
  });

  it("fires builder_archive with a 'stopped' framing for a failed BUILDER", async () => {
    await registry.registerAgent({
      name: "builder-y",
      type: "builder",
      branch: "friday/builder-y",
    });

    await archiveAgent("builder-y", { reason: "failed" });

    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0]![0]).toMatchObject({
      type: "builder_archive",
      title: "A builder stopped",
    });
  });

  it("does NOT fire for a non-builder (bare) archive — routine lifecycle churn", async () => {
    await registry.registerAgent({ name: "kitchen", type: "bare" });

    await archiveAgent("kitchen", { reason: "completed" });

    expect(notifySpy).not.toHaveBeenCalled();
  });
});
