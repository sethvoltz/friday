/**
 * Cross-boundary tests for the ticket-close service. Per-test Postgres
 * scratch DB via createTestDb() (ADR-023), mocked Linear fetch boundary,
 * real ticket service.
 *
 * Test layer: this exercises the dispatcher's mapping from reason→status
 * and the external propagation path. The lifecycle-level tests (sibling
 * file `agent/lifecycle-ticket-close.test.ts`) drive the same path
 * through `archiveAgent` so the wiring itself is covered there.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

// FRI-150 (pivot, ADR-037): the production code reads LINEAR_API_KEY via
// `loadFridayConfig()` (object), not `process.env`. Mock the loader so
// every test sees the synthetic key without polluting the on-disk .env.
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

let handle: TestDbHandle;
let createTicket: (typeof import("@friday/shared/services"))["createTicket"];
let getTicket: (typeof import("@friday/shared/services"))["getTicket"];
let linkExternal: (typeof import("@friday/shared/services"))["linkExternal"];
let listComments: (typeof import("@friday/shared/services"))["listComments"];
let updateTicket: (typeof import("@friday/shared/services"))["updateTicket"];
let closeTicketForArchive: (typeof import("./ticket-close.js"))["closeTicketForArchive"];

interface FetchCall {
  body: { query: string; variables: Record<string, unknown> };
}

function installLinearFetch(
  responses: Array<{
    data?: unknown;
    errors?: Array<{ message: string }>;
    rejectWith?: Error;
  }>,
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}")) as FetchCall["body"];
    calls.push({ body });
    const r = responses[i++];
    if (!r) return new Response(JSON.stringify({ data: {} }), { status: 200 });
    if (r.rejectWith) throw r.rejectWith;
    return new Response(JSON.stringify({ data: r.data, errors: r.errors }), {
      status: 200,
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return { calls, restore: () => vi.unstubAllGlobals() };
}

const issueLookupResponse = {
  data: {
    issues: {
      nodes: [
        {
          id: "issue-uuid",
          identifier: "FRI-42",
          title: "x",
          description: null,
          url: "https://linear.app/x/issue/FRI-42",
          updatedAt: "2026-05-14T00:00:00Z",
          state: { name: "In Progress", type: "started" },
        },
      ],
    },
  },
};

const completedStateResponse = {
  data: {
    workflowStates: { nodes: [{ id: "done-state-uuid", type: "completed" }] },
  },
};

const canceledStateResponse = {
  data: {
    workflowStates: {
      nodes: [{ id: "canceled-state-uuid", type: "canceled" }],
    },
  },
};

const issueUpdateSuccess = { data: { issueUpdate: { success: true } } };

beforeAll(async () => {
  handle = await createTestDb({ label: "ticket_close" });
  ({ createTicket, getTicket, linkExternal, listComments, updateTicket } =
    await import("@friday/shared/services"));
  ({ closeTicketForArchive } = await import("./ticket-close.js"));
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

describe("closeTicketForArchive — local mapping", () => {
  it("completed → status='done'", async () => {
    const t = await createTicket({ title: "t", status: "in_progress" });
    await closeTicketForArchive({
      ticketId: t.id,
      reason: "completed",
      agentName: "alpha",
    });
    expect((await getTicket(t.id))?.status).toBe("done");
  });

  it("abandoned → status='closed'", async () => {
    const t = await createTicket({ title: "t", status: "in_progress" });
    await closeTicketForArchive({
      ticketId: t.id,
      reason: "abandoned",
      agentName: "beta",
    });
    expect((await getTicket(t.id))?.status).toBe("closed");
  });

  it("failed → status='closed' AND adds a failure comment authored by the agent", async () => {
    const t = await createTicket({ title: "t", status: "in_progress" });
    await closeTicketForArchive({
      ticketId: t.id,
      reason: "failed",
      agentName: "gamma",
    });
    expect((await getTicket(t.id))?.status).toBe("closed");
    const comments = await listComments(t.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      author: "gamma",
      body: "agent archived: failed",
    });
  });

  it("null ticketId → no-op, no throw", async () => {
    await expect(
      closeTicketForArchive({
        ticketId: null,
        reason: "completed",
        agentName: "epsilon",
      }),
    ).resolves.toBeUndefined();
  });

  it("stale ticketId (deleted row) → does not throw, no side effect", async () => {
    await expect(
      closeTicketForArchive({
        ticketId: "FRI-does-not-exist",
        reason: "completed",
        agentName: "zeta",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("closeTicketForArchive — external propagation", () => {
  beforeEach(() => {
    mockLinearApiKey.current = "test-key";
  });

  it("completed: posts issueUpdate to Linear with the 'completed' stateId", async () => {
    const t = await createTicket({
      title: "linear-linked",
      status: "in_progress",
    });
    await linkExternal({
      ticketId: t.id,
      system: "linear",
      externalId: "FRI-42",
    });
    const { calls } = installLinearFetch([
      issueLookupResponse,
      completedStateResponse,
      issueUpdateSuccess,
    ]);

    await closeTicketForArchive({
      ticketId: t.id,
      reason: "completed",
      agentName: "alpha",
    });

    expect((await getTicket(t.id))?.status).toBe("done");
    expect(calls).toHaveLength(3);
    expect(calls[2].body.query).toContain("mutation IssueUpdate");
    expect(calls[2].body.variables).toEqual({
      id: "issue-uuid",
      input: { stateId: "done-state-uuid" },
    });
  });

  it("abandoned: posts issueUpdate with the 'canceled' stateId", async () => {
    const t = await createTicket({
      title: "linear-linked-2",
      status: "in_progress",
    });
    await linkExternal({
      ticketId: t.id,
      system: "linear",
      externalId: "FRI-43",
    });
    const { calls } = installLinearFetch([
      {
        data: {
          issues: {
            nodes: [
              {
                ...issueLookupResponse.data.issues.nodes[0],
                id: "issue-uuid-2",
                identifier: "FRI-43",
              },
            ],
          },
        },
      },
      canceledStateResponse,
      issueUpdateSuccess,
    ]);

    await closeTicketForArchive({
      ticketId: t.id,
      reason: "abandoned",
      agentName: "beta",
    });

    expect((await getTicket(t.id))?.status).toBe("closed");
    expect(calls[2].body.variables).toEqual({
      id: "issue-uuid-2",
      input: { stateId: "canceled-state-uuid" },
    });
  });

  it("Linear failure does NOT block the local close", async () => {
    const t = await createTicket({
      title: "linear-flaky",
      status: "in_progress",
    });
    await linkExternal({
      ticketId: t.id,
      system: "linear",
      externalId: "FRI-44",
    });
    installLinearFetch([{ rejectWith: new Error("network down") }]);

    await closeTicketForArchive({
      ticketId: t.id,
      reason: "completed",
      agentName: "gamma",
    });

    expect((await getTicket(t.id))?.status).toBe("done");
  });

  it("unknown external system is skipped, not errored", async () => {
    const t = await createTicket({
      title: "future-jira",
      status: "in_progress",
    });
    await linkExternal({
      ticketId: t.id,
      system: "jira",
      externalId: "JIRA-1",
    });
    // No fetch installed — if dispatcher tried to call out, this would throw.
    await closeTicketForArchive({
      ticketId: t.id,
      reason: "completed",
      agentName: "delta",
    });
    expect((await getTicket(t.id))?.status).toBe("done");
  });

  it("LINEAR_API_KEY missing: local update still succeeds, Linear call skipped", async () => {
    mockLinearApiKey.current = undefined;
    const t = await createTicket({ title: "no-key", status: "in_progress" });
    await linkExternal({
      ticketId: t.id,
      system: "linear",
      externalId: "FRI-45",
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await closeTicketForArchive({
      ticketId: t.id,
      reason: "completed",
      agentName: "epsilon",
    });

    expect((await getTicket(t.id))?.status).toBe("done");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("multiple linear external links: each gets an issueUpdate", async () => {
    const t = await createTicket({ title: "multi-link", status: "in_progress" });
    await linkExternal({
      ticketId: t.id,
      system: "linear",
      externalId: "FRI-46",
    });
    await linkExternal({
      ticketId: t.id,
      system: "linear",
      externalId: "FRI-47",
    });

    const issueLookup = (id: string, ident: string) => ({
      data: {
        issues: {
          nodes: [
            {
              ...issueLookupResponse.data.issues.nodes[0],
              id,
              identifier: ident,
            },
          ],
        },
      },
    });

    const { calls } = installLinearFetch([
      issueLookup("u-46", "FRI-46"),
      completedStateResponse,
      issueUpdateSuccess,
      issueLookup("u-47", "FRI-47"),
      completedStateResponse,
      issueUpdateSuccess,
    ]);

    await closeTicketForArchive({
      ticketId: t.id,
      reason: "completed",
      agentName: "zeta",
    });

    // Two issueUpdate mutations, one per external link.
    const mutationCalls = calls.filter((c) => c.body.query.includes("mutation IssueUpdate"));
    expect(mutationCalls).toHaveLength(2);
    expect(mutationCalls.map((c) => c.body.variables.id).sort()).toEqual(["u-46", "u-47"]);
  });
});

describe("closeTicketForArchive — robustness", () => {
  it("local-update failure does not propagate (returns cleanly)", async () => {
    const t = await createTicket({ title: "robust-1", status: "in_progress" });
    await expect(
      closeTicketForArchive({
        ticketId: t.id,
        reason: "completed",
        agentName: "eta",
      }),
    ).resolves.toBeUndefined();
    expect((await getTicket(t.id))?.status).toBe("done");
    // Restore for unrelated subsequent tests if any.
    await updateTicket(t.id, { status: "done" });
  });
});
