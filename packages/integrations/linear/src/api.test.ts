import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getStateIdByType,
  LinearApiError,
  setIssueStateByType,
} from "./api.js";

interface MockCall {
  query: string;
  variables: Record<string, unknown>;
}

interface MockResponse {
  data?: unknown;
  errors?: Array<{ message: string }>;
  status?: number;
  rawBody?: string;
}

function installFetchMock(responses: MockResponse[]): {
  calls: MockCall[];
  restore: () => void;
} {
  const calls: MockCall[] = [];
  let i = 0;
  const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}")) as MockCall;
    calls.push({ query: body.query, variables: body.variables });
    const r = responses[i++] ?? { data: {} };
    if (r.status && r.status >= 400) {
      return new Response(r.rawBody ?? "", { status: r.status });
    }
    return new Response(JSON.stringify({ data: r.data, errors: r.errors }), {
      status: 200,
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return {
    calls,
    restore: () => vi.unstubAllGlobals(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getStateIdByType", () => {
  it("returns the first matching workflow state id", async () => {
    const { calls } = installFetchMock([
      {
        data: {
          workflowStates: {
            nodes: [
              { id: "state-uuid-1", type: "completed" },
              { id: "state-uuid-2", type: "completed" },
            ],
          },
        },
      },
    ]);
    const id = await getStateIdByType({
      apiKey: "key",
      teamKey: "FRI",
      stateType: "completed",
    });
    expect(id).toBe("state-uuid-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].variables).toMatchObject({
      filter: {
        team: { key: { eq: "FRI" } },
        type: { eq: "completed" },
      },
    });
  });

  it("returns null when Linear has no matching state for that team+type", async () => {
    installFetchMock([{ data: { workflowStates: { nodes: [] } } }]);
    const id = await getStateIdByType({
      apiKey: "key",
      teamKey: "FRI",
      stateType: "completed",
    });
    expect(id).toBeNull();
  });
});

describe("setIssueStateByType", () => {
  it("resolves team from identifier, looks up state, posts issueUpdate mutation", async () => {
    const { calls } = installFetchMock([
      // getIssueByIdentifier
      {
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
      },
      // getStateIdByType
      {
        data: {
          workflowStates: {
            nodes: [{ id: "done-state-uuid", type: "completed" }],
          },
        },
      },
      // issueUpdate
      { data: { issueUpdate: { success: true } } },
    ]);

    await setIssueStateByType({
      apiKey: "key",
      issueIdentifier: "FRI-42",
      stateType: "completed",
    });

    expect(calls).toHaveLength(3);
    // Mutation call shape
    expect(calls[2].query).toContain("mutation IssueUpdate");
    expect(calls[2].variables).toEqual({
      id: "issue-uuid",
      input: { stateId: "done-state-uuid" },
    });
  });

  it("throws LinearApiError on malformed identifier", async () => {
    await expect(
      setIssueStateByType({
        apiKey: "key",
        issueIdentifier: "not-a-real-id",
        stateType: "completed",
      }),
    ).rejects.toBeInstanceOf(LinearApiError);
  });

  it("throws LinearApiError when issue is not found", async () => {
    installFetchMock([{ data: { issues: { nodes: [] } } }]);
    await expect(
      setIssueStateByType({
        apiKey: "key",
        issueIdentifier: "FRI-999",
        stateType: "completed",
      }),
    ).rejects.toBeInstanceOf(LinearApiError);
  });

  it("throws LinearApiError when team has no state of that type", async () => {
    installFetchMock([
      {
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
      },
      { data: { workflowStates: { nodes: [] } } },
    ]);

    await expect(
      setIssueStateByType({
        apiKey: "key",
        issueIdentifier: "FRI-42",
        stateType: "completed",
      }),
    ).rejects.toBeInstanceOf(LinearApiError);
  });

  it("throws LinearApiError when issueUpdate returns success=false", async () => {
    installFetchMock([
      {
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
      },
      { data: { workflowStates: { nodes: [{ id: "state-uuid", type: "completed" }] } } },
      { data: { issueUpdate: { success: false } } },
    ]);

    await expect(
      setIssueStateByType({
        apiKey: "key",
        issueIdentifier: "FRI-42",
        stateType: "completed",
      }),
    ).rejects.toBeInstanceOf(LinearApiError);
  });
});
