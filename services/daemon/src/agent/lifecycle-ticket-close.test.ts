/**
 * Cross-boundary tests for "archive an agent → close its linked ticket".
 *
 * Test layer: this drives the gap between `archiveAgent` and the ticket
 * table — exactly where the original bug lived (no closer mechanism at
 * all). The closer is fire-and-forget (`void closeTicketForArchive`), but
 * the local DB update happens synchronously before the first `await` in
 * the closer, so `archiveAgent`'s observable effect on the ticket row is
 * deterministic without waiting for ticks.
 *
 * No live workers are forked: archiveAgent's `live.get(agentName)` returns
 * undefined for these registry rows, so the worker-stop path is skipped
 * and the function returns synchronously with an empty `drainedPrompts`
 * after running the registry/event/closer side-effects.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const dataRoot = mkdtempSync(join(tmpdir(), "friday-lc-ticket-close-"));
process.env.FRIDAY_DATA_DIR = dataRoot;
// Don't leak Linear API calls in tests that don't install a fetch mock.
delete process.env.LINEAR_API_KEY;

const { runMigrations, closeDb } = await import("@friday/shared");
const { createTicket, getTicket, linkExternal, listComments } = await import(
  "@friday/shared/services"
);
const registry = await import("./registry.js");
const { archiveAgent } = await import("./lifecycle.js");

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  closeDb();
  rmSync(dataRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function registerBuilderWithTicket(name: string, ticketId?: string): void {
  registry.registerAgent({
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
    const t = createTicket({ title: "alpha-task", status: "in_progress" });
    registerBuilderWithTicket("alpha", t.id);

    await archiveAgent("alpha", { reason: "completed" });

    expect(getTicket(t.id)?.status).toBe("done");
    expect(registry.getAgent("alpha")?.status).toBe("archived");
  });

  it("reason='abandoned' moves the linked ticket to 'closed'", async () => {
    const t = createTicket({ title: "beta-task", status: "in_progress" });
    registerBuilderWithTicket("beta", t.id);

    await archiveAgent("beta", { reason: "abandoned" });

    expect(getTicket(t.id)?.status).toBe("closed");
  });

  it("reason='failed' closes the ticket AND adds a failure comment authored by the agent", async () => {
    const t = createTicket({ title: "gamma-task", status: "in_progress" });
    registerBuilderWithTicket("gamma", t.id);

    await archiveAgent("gamma", { reason: "failed" });

    expect(getTicket(t.id)?.status).toBe("closed");
    const comments = listComments(t.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      author: "gamma",
      body: "agent archived: failed",
    });
  });

  it("reason='refork' leaves the linked ticket untouched (watchdog invariant)", async () => {
    const t = createTicket({ title: "delta-task", status: "in_progress" });
    registerBuilderWithTicket("delta", t.id);

    await archiveAgent("delta", { reason: "refork" });

    expect(getTicket(t.id)?.status).toBe("in_progress");
    expect(registry.getAgent("delta")?.status).toBe("archived");
  });

  it("archive of an agent with no ticketId is a no-op on tickets, archive still happens", async () => {
    registerBuilderWithTicket("epsilon", undefined);

    await archiveAgent("epsilon", { reason: "completed" });

    expect(registry.getAgent("epsilon")?.status).toBe("archived");
  });

  it("archive with stale ticketId (pointing at a deleted row) succeeds without throwing", async () => {
    registerBuilderWithTicket("zeta", "FRI-stale-and-gone");

    await expect(
      archiveAgent("zeta", { reason: "completed" }),
    ).resolves.toBeDefined();
    expect(registry.getAgent("zeta")?.status).toBe("archived");
  });

  it("ticketId is read BEFORE registry.archiveAgent runs (invariant pin)", async () => {
    // If a future refactor nulled fields on archive, reading ticketId after
    // would silently break the closer. We pin the read order by spying on
    // registry.archiveAgent: when the spy fires, the closer must have
    // already captured the ticketId (which we verify by checking that the
    // ticket later moved to "done").
    const t = createTicket({ title: "eta-task", status: "in_progress" });
    registerBuilderWithTicket("eta", t.id);

    let readBeforeArchive = false;
    const origArchive = registry.archiveAgent;
    const archiveSpy = vi.fn((name: string) => {
      // At this point, the closer has already been dispatched, which means
      // ticketId was captured before this call.
      const row = registry.getAgent(name);
      if (row && "ticketId" in row) readBeforeArchive = row.ticketId === t.id;
      return origArchive(name);
    });
    vi.spyOn(registry, "archiveAgent").mockImplementation(archiveSpy);

    await archiveAgent("eta", { reason: "completed" });
    vi.restoreAllMocks();

    expect(readBeforeArchive).toBe(true);
    expect(getTicket(t.id)?.status).toBe("done");
  });

  it("orchestrator-type agent (no ticketId field on row) archives cleanly without ticket effects", async () => {
    registry.registerAgent({ name: "main", type: "orchestrator" });
    const t = createTicket({ title: "unrelated", status: "in_progress" });

    await archiveAgent("main", { reason: "abandoned" });

    expect(registry.getAgent("main")?.status).toBe("archived");
    // Unrelated ticket must not be touched.
    expect(getTicket(t.id)?.status).toBe("in_progress");
  });

  it("LINEAR_API_KEY missing: local ticket close still happens; no external attempt", async () => {
    // Linked ticket with a Linear external link, but no API key set —
    // local close must still flip the ticket; Linear write is skipped.
    delete process.env.LINEAR_API_KEY;
    const t = createTicket({ title: "no-linear-key", status: "in_progress" });
    linkExternal({
      ticketId: t.id,
      system: "linear",
      externalId: "FRI-999",
    });
    registerBuilderWithTicket("theta", t.id);

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await archiveAgent("theta", { reason: "completed" });

    expect(getTicket(t.id)?.status).toBe("done");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
