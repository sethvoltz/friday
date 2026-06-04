/**
 * FRI-66 regression coverage: when a PR with `Closes FRI-N` merges, the
 * full chain
 *
 *   Linear (`completed` via GitHub integration)
 *     → reconcile() detects stale link, back-propagates to Friday ticket
 *     → proposal-sync flips originating evolve proposal to `applied`
 *
 * fires automatically without manual intervention. Exhibits A & B were
 * FRI-56 and FRI-57 in the live system — both stayed `open` after PR
 * merge until the 2026-05-31 audit closed them by hand.
 *
 * Three test groups:
 *   1. reconcile() back-prop in isolation (Linear → Friday ticket).
 *   2. syncProposalForClosedTicket in isolation (ticket → proposal).
 *   3. Full chain: open ticket + linked Linear + linked proposal →
 *      reconcile() + cascade → both terminal.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

// FRI-150 (pivot, ADR-037): production code reads LINEAR_API_KEY via
// `loadFridayConfig()` (object). The mock replaces the loader; tests
// flip `mockLinearApiKey.current` to drive presence/absence.
const mockLinearApiKey: { current: string | undefined } = { current: "test-key" };
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
      linearApiKey: mockLinearApiKey.current,
      anthropicApiKey: undefined,
      cloudflareTunnelToken: undefined,
      posthogApiKey: undefined,
      posthogHost: undefined,
    }),
  };
});

// Vitest's shared setup file (`packages/shared/src/test/vitest-setup.ts`)
// pinned FRIDAY_DATA_DIR to a fresh tmpdir before any module evaluated, so
// `EVOLVE_PROPOSALS_DIR` already resolves under it. Reuse that tmpdir for
// per-test FS cleanup of proposal markdown files.
const dataDir = process.env.FRIDAY_DATA_DIR!;

let handle: TestDbHandle;
let createTicket: (typeof import("@friday/shared/services"))["createTicket"];
let getTicket: (typeof import("@friday/shared/services"))["getTicket"];
let updateTicket: (typeof import("@friday/shared/services"))["updateTicket"];
let linkExternal: (typeof import("@friday/shared/services"))["linkExternal"];
let saveProposal: (typeof import("@friday/evolve"))["saveProposal"];
let updateProposal: (typeof import("@friday/evolve"))["updateProposal"];
let getProposal: (typeof import("@friday/evolve"))["getProposal"];
let listProposals: (typeof import("@friday/evolve"))["listProposals"];
let reconcile: (typeof import("@friday/integrations-linear"))["reconcile"];
let syncProposalForClosedTicket: (typeof import("./proposal-sync.js"))["syncProposalForClosedTicket"];
let syncProposalsForClosedTickets: (typeof import("./proposal-sync.js"))["syncProposalsForClosedTickets"];

interface FetchCall {
  query: string;
  variables: Record<string, unknown>;
}

function installLinearFetch(
  responses: Array<{ data?: unknown; errors?: Array<{ message: string }> }>,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}")) as FetchCall;
    calls.push({ query: body.query, variables: body.variables });
    const r = responses[i++] ?? { data: {} };
    return new Response(JSON.stringify({ data: r.data, errors: r.errors }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return { calls };
}

function activeIssuesEmpty() {
  return {
    data: {
      issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    },
  };
}

function issueLookup(opts: {
  id?: string;
  identifier: string;
  stateType: "completed" | "canceled" | "started" | "backlog" | "triage" | "unstarted";
  stateName?: string;
}) {
  return {
    data: {
      issues: {
        nodes: [
          {
            id: opts.id ?? `issue-uuid-${opts.identifier}`,
            identifier: opts.identifier,
            title: `Issue ${opts.identifier}`,
            description: null,
            url: `https://linear.app/x/issue/${opts.identifier}`,
            updatedAt: "2026-05-24T00:00:00Z",
            state: { name: opts.stateName ?? opts.stateType, type: opts.stateType },
          },
        ],
      },
    },
  };
}

beforeAll(async () => {
  handle = await createTestDb({ label: "fri66_evolve_autoclose" });
  ({ createTicket, getTicket, updateTicket, linkExternal } =
    await import("@friday/shared/services"));
  ({ saveProposal, updateProposal, getProposal, listProposals } = await import("@friday/evolve"));
  ({ reconcile } = await import("@friday/integrations-linear"));
  ({ syncProposalForClosedTicket, syncProposalsForClosedTickets } =
    await import("./proposal-sync.js"));
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
  // Clear the FS proposal store between tests by removing only its
  // contents (the dir itself is reused).
  for (const p of listProposals()) {
    rmSync(join(dataDir, "evolve", "proposals", `${p.id}.md`), { force: true });
  }
  mockLinearApiKey.current = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Layer 1: reconcile() back-prop ────────────────────────────────────────

describe("reconcile() back-propagation: Linear → Friday", () => {
  it("Linear issue moved to 'completed' → Friday ticket flips to 'done'", async () => {
    const t = await createTicket({ title: "back-prop completed", status: "open" });
    await linkExternal({ ticketId: t.id, system: "linear", externalId: "FRI-100" });

    installLinearFetch([
      activeIssuesEmpty(),
      issueLookup({ identifier: "FRI-100", stateType: "completed" }),
    ]);

    const result = await reconcile();

    expect(result.ran).toBe(true);
    expect(result.closedTicketIds).toEqual([t.id]);
    expect((await getTicket(t.id))?.status).toBe("done");
  });

  it("Linear issue moved to 'canceled' → Friday ticket flips to 'closed'", async () => {
    const t = await createTicket({ title: "back-prop canceled", status: "in_progress" });
    await linkExternal({ ticketId: t.id, system: "linear", externalId: "FRI-101" });

    installLinearFetch([
      activeIssuesEmpty(),
      issueLookup({ identifier: "FRI-101", stateType: "canceled" }),
    ]);

    const result = await reconcile();

    expect(result.closedTicketIds).toEqual([t.id]);
    expect((await getTicket(t.id))?.status).toBe("closed");
  });

  it("Linear issue bounced back to 'backlog' → Friday ticket UNCHANGED (Friday authoritative for in-progress)", async () => {
    const t = await createTicket({ title: "bounced to backlog", status: "in_progress" });
    await linkExternal({ ticketId: t.id, system: "linear", externalId: "FRI-102" });

    installLinearFetch([
      activeIssuesEmpty(),
      issueLookup({ identifier: "FRI-102", stateType: "backlog" }),
    ]);

    const result = await reconcile();

    expect(result.closedTicketIds).toEqual([]);
    expect((await getTicket(t.id))?.status).toBe("in_progress");
  });

  it("local ticket already 'done' → no overwrite, not re-counted", async () => {
    const t = await createTicket({ title: "already done", status: "done" });
    await linkExternal({ ticketId: t.id, system: "linear", externalId: "FRI-103" });

    // No issue lookup expected — guard short-circuits before calling out.
    const { calls } = installLinearFetch([activeIssuesEmpty()]);

    const result = await reconcile();

    expect(result.closedTicketIds).toEqual([]);
    expect((await getTicket(t.id))?.status).toBe("done");
    // Only the listActiveIssues call should have fired; no per-issue lookup.
    expect(calls).toHaveLength(1);
  });

  it("Linear issue still active → not stale, no back-prop", async () => {
    const t = await createTicket({ title: "still active", status: "in_progress" });
    await linkExternal({ ticketId: t.id, system: "linear", externalId: "FRI-104" });

    installLinearFetch([
      {
        data: {
          issues: {
            nodes: [
              {
                id: "u-104",
                identifier: "FRI-104",
                title: "still active",
                description: null,
                url: "https://linear.app/x/issue/FRI-104",
                updatedAt: "2026-05-24T00:00:00Z",
                state: { name: "In Progress", type: "started" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ]);

    const result = await reconcile();

    expect(result.staleLinks).toEqual([]);
    expect(result.closedTicketIds).toEqual([]);
    expect((await getTicket(t.id))?.status).toBe("in_progress");
  });
});

// ── Layer 2: syncProposalForClosedTicket ──────────────────────────────────

describe("syncProposalForClosedTicket: ticket → proposal", () => {
  it("forward link (proposal.appliedTicketId === ticketId) → flips to 'applied'", async () => {
    const t = await createTicket({ title: "fwd link", status: "done" });
    const p = saveProposal({
      title: "fwd-link proposal",
      type: "code",
      proposedChange: "fix the thing",
      createdBy: "test",
    });
    updateProposal(p.id, { appliedTicketId: t.id });

    await syncProposalForClosedTicket(t.id);

    const next = getProposal(p.id);
    expect(next?.status).toBe("applied");
    expect(next?.appliedTicketId).toBe(t.id);
    expect(next?.appliedBy).toBe("auto:ticket-close");
    expect(next?.appliedAt).toBeTruthy();
  });

  it("backward link only (ticket.meta.evolveProposalId, no appliedTicketId on proposal) → flips via fallback", async () => {
    const p = saveProposal({
      title: "back-link proposal",
      type: "code",
      proposedChange: "fix the other thing",
      createdBy: "test",
    });
    // Intentionally do NOT set appliedTicketId — exercises meta fallback.
    const t = await createTicket({
      title: "back link",
      status: "done",
      meta: { evolveProposalId: p.id },
    });

    await syncProposalForClosedTicket(t.id);

    const next = getProposal(p.id);
    expect(next?.status).toBe("applied");
    expect(next?.appliedTicketId).toBe(t.id);
  });

  it("proposal already 'applied' → no overwrite (idempotent)", async () => {
    const t = await createTicket({ title: "idempotent", status: "done" });
    const p = saveProposal({
      title: "already applied",
      type: "code",
      proposedChange: "x",
      createdBy: "test",
    });
    updateProposal(p.id, {
      status: "applied",
      appliedTicketId: t.id,
      appliedBy: "human",
      appliedAt: "2026-05-01T00:00:00Z",
    });

    await syncProposalForClosedTicket(t.id);

    const next = getProposal(p.id);
    expect(next?.status).toBe("applied");
    expect(next?.appliedBy).toBe("human"); // unchanged
    expect(next?.appliedAt).toBe("2026-05-01T00:00:00Z");
  });

  it("proposal 'rejected' → not flipped (terminal decision preserved)", async () => {
    const t = await createTicket({ title: "rejected stays", status: "done" });
    const p = saveProposal({
      title: "rejected",
      type: "code",
      proposedChange: "x",
      createdBy: "test",
    });
    updateProposal(p.id, { status: "rejected", appliedTicketId: t.id });

    await syncProposalForClosedTicket(t.id);

    expect(getProposal(p.id)?.status).toBe("rejected");
  });

  it("ticket has no proposal link at all → silent no-op (builder-PR regression case)", async () => {
    const t = await createTicket({ title: "builder pr no proposal", status: "done" });
    saveProposal({
      title: "unrelated proposal",
      type: "code",
      proposedChange: "x",
      createdBy: "test",
    });

    await expect(syncProposalForClosedTicket(t.id)).resolves.toBeUndefined();
    // No proposal touched.
    const all = listProposals();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("open");
  });

  it("approved proposal also flips to applied", async () => {
    const t = await createTicket({ title: "approved", status: "done" });
    const p = saveProposal({
      title: "approved",
      type: "code",
      proposedChange: "x",
      createdBy: "test",
      status: "approved",
    });
    updateProposal(p.id, { appliedTicketId: t.id });

    await syncProposalForClosedTicket(t.id);

    expect(getProposal(p.id)?.status).toBe("applied");
  });
});

// ── Full chain regression (FRI-56/FRI-57 exhibit pattern) ─────────────────

describe("FRI-66 full chain: PR merge → Linear close → reconcile → ticket+proposal applied", () => {
  it("open ticket + linked proposal + Closes-FRI-N PR merged → both terminal", async () => {
    // Set up like FRI-56 was on 2026-05-24: ticket promoted from a proposal
    // (forward link + backward link both present), linked to Linear FRI-N.
    const p = saveProposal({
      title: "auto-close-roundtrip",
      type: "code",
      proposedChange: "fix the bug",
      createdBy: "scheduled-meta",
    });
    const t = await createTicket({
      title: "auto-close-roundtrip",
      status: "open",
      meta: { evolveProposalId: p.id },
    });
    updateProposal(p.id, { appliedTicketId: t.id });
    await linkExternal({ ticketId: t.id, system: "linear", externalId: "FRI-200" });

    // PR-merge scenario: Linear's GitHub integration parsed `Closes FRI-200`
    // and moved the issue to `completed`. Mock the reconcile fetch chain:
    // (1) listActiveIssues now returns empty for that issue;
    // (2) per-stale lookup returns state.type = completed.
    installLinearFetch([
      activeIssuesEmpty(),
      issueLookup({ identifier: "FRI-200", stateType: "completed" }),
    ]);

    const result = await reconcile();
    expect(result.closedTicketIds).toEqual([t.id]);

    // Cascade — exactly what daemon/src/index.ts and api/server.ts now do.
    await syncProposalsForClosedTickets(result.closedTicketIds);

    // Both sides MUST be terminal.
    expect((await getTicket(t.id))?.status).toBe("done");
    const next = getProposal(p.id);
    expect(next?.status).toBe("applied");
    expect(next?.appliedTicketId).toBe(t.id);
    expect(next?.appliedBy).toBe("auto:ticket-close");
  });

  it("closeTicketForArchive (agent-archive path) also cascades to the proposal", async () => {
    mockLinearApiKey.current = undefined; // isolate from Linear propagation in this case
    const { closeTicketForArchive } = await import("./ticket-close.js");

    const p = saveProposal({
      title: "agent-archive cascade",
      type: "code",
      proposedChange: "fix",
      createdBy: "scheduled-meta",
    });
    const t = await createTicket({
      title: "agent-archive cascade",
      status: "in_progress",
      meta: { evolveProposalId: p.id },
    });
    updateProposal(p.id, { appliedTicketId: t.id });

    await closeTicketForArchive({
      ticketId: t.id,
      reason: "completed",
      agentName: "builder-x",
    });

    expect((await getTicket(t.id))?.status).toBe("done");
    expect(getProposal(p.id)?.status).toBe("applied");
  });

  it("ticket update without proposal link — closeTicketForArchive regression (builder-PR scenario)", async () => {
    mockLinearApiKey.current = undefined;
    const { closeTicketForArchive } = await import("./ticket-close.js");

    const t = await createTicket({ title: "builder PR no proposal", status: "in_progress" });

    await expect(
      closeTicketForArchive({ ticketId: t.id, reason: "completed", agentName: "builder-y" }),
    ).resolves.toBeUndefined();

    expect((await getTicket(t.id))?.status).toBe("done");
  });
});
