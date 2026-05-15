import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIssue,
  findTeamByKey,
  getStateIdByType,
  LinearApiError,
  listTeams,
  resolveIssueIdByIdentifier,
  setIssueStateByType,
  updateIssue,
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

describe("createIssue", () => {
  it("posts the issueCreate mutation with the given input and returns the created issue", async () => {
    const { calls } = installFetchMock([
      {
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: "uuid-123",
              identifier: "FRI-42",
              url: "https://linear.app/team/issue/FRI-42",
            },
          },
        },
      },
    ]);

    const result = await createIssue({
      apiKey: "lin_test_key",
      input: {
        teamId: "team-uuid",
        title: "Mirror FRI-13",
        description: "## Body\nhello",
      },
    });

    expect(result).toEqual({
      id: "uuid-123",
      identifier: "FRI-42",
      url: "https://linear.app/team/issue/FRI-42",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("issueCreate");
    expect(calls[0].variables).toEqual({
      input: {
        teamId: "team-uuid",
        title: "Mirror FRI-13",
        description: "## Body\nhello",
      },
    });
  });

  it("throws LinearApiError when issueCreate returns success=false", async () => {
    installFetchMock([
      { data: { issueCreate: { success: false, issue: null } } },
    ]);

    await expect(
      createIssue({
        apiKey: "lin_test_key",
        input: { teamId: "team-uuid", title: "X" },
      }),
    ).rejects.toBeInstanceOf(LinearApiError);
  });

  it("throws LinearApiError when GraphQL returns errors", async () => {
    installFetchMock([
      { data: undefined, errors: [{ message: "team not found" }] },
    ]);

    await expect(
      createIssue({
        apiKey: "lin_test_key",
        input: { teamId: "bad", title: "X" },
      }),
    ).rejects.toThrow(/team not found/);
  });
});

describe("resolveIssueIdByIdentifier", () => {
  it("returns the issue UUID for a matching identifier", async () => {
    const { calls } = installFetchMock([
      { data: { issues: { nodes: [{ id: "issue-uuid-7" }] } } },
    ]);
    const id = await resolveIssueIdByIdentifier({
      apiKey: "k",
      identifier: "FRI-75",
    });
    expect(id).toBe("issue-uuid-7");
    expect(calls).toHaveLength(1);
    expect(calls[0].variables).toMatchObject({
      filter: {
        number: { eq: 75 },
        team: { key: { eq: "FRI" } },
      },
    });
  });

  it("returns null when no issue matches", async () => {
    installFetchMock([{ data: { issues: { nodes: [] } } }]);
    const id = await resolveIssueIdByIdentifier({
      apiKey: "k",
      identifier: "FRI-999",
    });
    expect(id).toBeNull();
  });

  it("throws LinearApiError on malformed identifier", async () => {
    await expect(
      resolveIssueIdByIdentifier({ apiKey: "k", identifier: "not-an-id" }),
    ).rejects.toBeInstanceOf(LinearApiError);
  });
});

describe("updateIssue", () => {
  it("posts the issueUpdate mutation with the given input and returns the updated issue", async () => {
    const { calls } = installFetchMock([
      {
        data: {
          issueUpdate: {
            success: true,
            issue: {
              id: "issue-uuid",
              identifier: "FRI-75",
              title: "New title",
              url: "https://linear.app/team/issue/FRI-75",
            },
          },
        },
      },
    ]);

    const result = await updateIssue({
      apiKey: "k",
      id: "issue-uuid",
      input: { title: "New title", description: "## body" },
    });

    expect(result).toEqual({
      id: "issue-uuid",
      identifier: "FRI-75",
      title: "New title",
      url: "https://linear.app/team/issue/FRI-75",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("mutation IssueUpdate");
    expect(calls[0].variables).toEqual({
      id: "issue-uuid",
      input: { title: "New title", description: "## body" },
    });
  });

  it("throws LinearApiError when issueUpdate returns success=false", async () => {
    installFetchMock([
      { data: { issueUpdate: { success: false, issue: null } } },
    ]);
    await expect(
      updateIssue({
        apiKey: "k",
        id: "issue-uuid",
        input: { title: "x" },
      }),
    ).rejects.toBeInstanceOf(LinearApiError);
  });

  it("throws LinearApiError when GraphQL returns errors", async () => {
    installFetchMock([
      { data: undefined, errors: [{ message: "issue not found" }] },
    ]);
    await expect(
      updateIssue({
        apiKey: "k",
        id: "bad",
        input: { title: "x" },
      }),
    ).rejects.toThrow(/issue not found/);
  });
});

describe("findTeamByKey", () => {
  it("matches case-insensitively on team key and returns the team", async () => {
    installFetchMock([
      {
        data: {
          teams: {
            nodes: [
              { id: "u1", key: "ENG", name: "Engineering" },
              { id: "u2", key: "FRI", name: "Friday" },
            ],
          },
        },
      },
    ]);

    const team = await findTeamByKey({ apiKey: "k", key: "fri" });
    expect(team).toEqual({ id: "u2", key: "FRI", name: "Friday" });
  });

  it("returns null when no team matches", async () => {
    installFetchMock([
      {
        data: {
          teams: {
            nodes: [{ id: "u1", key: "ENG", name: "Engineering" }],
          },
        },
      },
    ]);
    const team = await findTeamByKey({ apiKey: "k", key: "FRI" });
    expect(team).toBeNull();
  });
});

describe("listTeams", () => {
  it("returns the full teams list from the teams query", async () => {
    installFetchMock([
      {
        data: {
          teams: {
            nodes: [
              { id: "u1", key: "ENG", name: "Engineering" },
              { id: "u2", key: "FRI", name: "Friday" },
            ],
          },
        },
      },
    ]);
    const teams = await listTeams({ apiKey: "k" });
    expect(teams).toHaveLength(2);
    expect(teams[0].key).toBe("ENG");
  });
});
