/**
 * Cross-boundary tests for "archive an agent → close its linked ticket".
 *
 * Test layer: this drives the gap between `archiveAgent` and the ticket
 * table — exactly where the original bug lived (no closer mechanism at
 * all). The closer is fire-and-forget (`void closeTicketForArchive`);
 * tests `settle()` briefly after archiveAgent before reading ticket state.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

// Don't leak Linear API calls in tests that don't install a fetch mock.
delete process.env.LINEAR_API_KEY;

let handle: TestDbHandle;
let createTicket: typeof import("@friday/shared/services")["createTicket"];
let getTicket: typeof import("@friday/shared/services")["getTicket"];
let linkExternal: typeof import("@friday/shared/services")["linkExternal"];
let listComments: typeof import("@friday/shared/services")["listComments"];
let registry: typeof import("./registry.js");
let archiveAgent: typeof import("./lifecycle.js")["archiveAgent"];
let forceWorkerRefork: typeof import("./lifecycle.js")["forceWorkerRefork"];

beforeAll(async () => {
  handle = await createTestDb({ label: "lc_ticket_close" });
  ({ createTicket, getTicket, linkExternal, listComments } = await import(
    "@friday/shared/services"
  ));
  registry = await import("./registry.js");
  ({ archiveAgent, forceWorkerRefork } = await import("./lifecycle.js"));
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function registerBuilderWithTicket(
  name: string,
  ticketId?: string,
): Promise<void> {
  await registry.registerAgent({
    name,
    type: "builder",
    parentName: "orchestrator",
    worktreePath: `/tmp/${name}-workspace`,
    branch: `friday/${name}`,
    ticketId,
  });
}

describe("archiveAgent → ticket-close cross-boundary", () => {
  it("reason='completed' moves the linked ticket to 'done'", async () => {
    const t = await createTicket({ title: "alpha-task", status: "in_progress" });
    await registerBuilderWithTicket("alpha", t.id);

    await archiveAgent("alpha", { reason: "completed" });
    await vi.waitFor(
      async () => {
        expect((await getTicket(t.id))?.status).toBe("done");
      },
      { timeout: 5000, interval: 25 },
    );
    expect((await registry.getAgent("alpha"))?.status).toBe("archived");
  });

  it("reason='abandoned' moves the linked ticket to 'closed'", async () => {
    const t = await createTicket({ title: "beta-task", status: "in_progress" });
    await registerBuilderWithTicket("beta", t.id);

    await archiveAgent("beta", { reason: "abandoned" });
    await vi.waitFor(
      async () => {
        expect((await getTicket(t.id))?.status).toBe("closed");
      },
      { timeout: 5000, interval: 25 },
    );
  });

  it("reason='failed' closes the ticket AND adds a failure comment authored by the agent", async () => {
    const t = await createTicket({ title: "gamma-task", status: "in_progress" });
    await registerBuilderWithTicket("gamma", t.id);

    await archiveAgent("gamma", { reason: "failed" });
    await vi.waitFor(
      async () => {
        expect((await getTicket(t.id))?.status).toBe("closed");
        const comments = await listComments(t.id);
        expect(comments).toHaveLength(1);
        expect(comments[0]).toMatchObject({
          author: "gamma",
          body: "agent archived: failed",
        });
      },
      { timeout: 5000, interval: 25 },
    );
  });

  it("forceWorkerRefork leaves the linked ticket AND the agent row untouched (watchdog invariant)", async () => {
    const t = await createTicket({ title: "delta-task", status: "in_progress" });
    await registerBuilderWithTicket("delta", t.id);

    await forceWorkerRefork("delta");
    // The refork path doesn't go through `closeTicketForArchive` at all,
    // and the row stays at the lifecycle-owned 'idle' (not 'archived') —
    // that's the point of replacing the prior `archiveAgent(..., refork)`
    // call. Wait briefly to catch any stray fire-and-forget writes.
    await new Promise((r) => setTimeout(r, 200));
    expect((await getTicket(t.id))?.status).toBe("in_progress");
    expect((await registry.getAgent("delta"))?.status).toBe("idle");
  });

  it("forceWorkerRefork converges a 'working' row to 'idle'", async () => {
    // The whole point: post-refork, the agent is dispatchable again — not
    // stranded at 'working' (would block another POST in the queued state)
    // and not 'archived' (the prior polite-lie behavior). No live worker,
    // so this exercises the "no w" branch's explicit setStatus('idle').
    await registerBuilderWithTicket("theta", undefined);
    await registry.setStatus("theta", "working");

    await forceWorkerRefork("theta");
    await new Promise((r) => setTimeout(r, 50));
    expect((await registry.getAgent("theta"))?.status).toBe("idle");
  });

  it("archive of an agent with no ticketId is a no-op on tickets, archive still happens", async () => {
    await registerBuilderWithTicket("epsilon", undefined);

    await archiveAgent("epsilon", { reason: "completed" });

    expect((await registry.getAgent("epsilon"))?.status).toBe("archived");
  });

  it("archive with stale ticketId (pointing at a deleted row) succeeds without throwing", async () => {
    await registerBuilderWithTicket("zeta", "FRI-stale-and-gone");

    await expect(
      archiveAgent("zeta", { reason: "completed" }),
    ).resolves.toBeDefined();
    expect((await registry.getAgent("zeta"))?.status).toBe("archived");
  });

  it("ticketId is read BEFORE registry.archiveAgent runs (invariant pin)", async () => {
    const t = await createTicket({ title: "eta-task", status: "in_progress" });
    await registerBuilderWithTicket("eta", t.id);

    let readBeforeArchive = false;
    const origArchive = registry.archiveAgent;
    const archiveSpy = vi.fn(async (name: string) => {
      const row = await registry.getAgent(name);
      if (row && "ticketId" in row) readBeforeArchive = row.ticketId === t.id;
      return origArchive(name);
    });
    vi.spyOn(registry, "archiveAgent").mockImplementation(archiveSpy);

    await archiveAgent("eta", { reason: "completed" });
    vi.restoreAllMocks();
    await vi.waitFor(
      async () => {
        expect((await getTicket(t.id))?.status).toBe("done");
      },
      { timeout: 5000, interval: 25 },
    );

    expect(readBeforeArchive).toBe(true);
  });

  it("orchestrator-type agent (no ticketId field on row) archives cleanly without ticket effects", async () => {
    await registry.registerAgent({ name: "main", type: "orchestrator" });
    const t = await createTicket({ title: "unrelated", status: "in_progress" });

    await archiveAgent("main", { reason: "abandoned" });
    // Wait for the archive to land before asserting the unrelated ticket
    // was untouched.
    await vi.waitFor(
      async () => {
        expect((await registry.getAgent("main"))?.status).toBe("archived");
      },
      { timeout: 5000, interval: 25 },
    );
    // Unrelated ticket must not be touched.
    expect((await getTicket(t.id))?.status).toBe("in_progress");
  });

  it("LINEAR_API_KEY missing: local ticket close still happens; no external attempt", async () => {
    // Linked ticket with a Linear external link, but no API key set —
    // local close must still flip the ticket; Linear write is skipped.
    delete process.env.LINEAR_API_KEY;
    const t = await createTicket({
      title: "no-linear-key",
      status: "in_progress",
    });
    await linkExternal({
      ticketId: t.id,
      system: "linear",
      externalId: "FRI-999",
    });
    await registerBuilderWithTicket("theta", t.id);

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await archiveAgent("theta", { reason: "completed" });
    await vi.waitFor(
      async () => {
        expect((await getTicket(t.id))?.status).toBe("done");
      },
      { timeout: 5000, interval: 25 },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
