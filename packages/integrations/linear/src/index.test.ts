import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTeamId } from "./index.js";

function mockFetch(response: unknown) {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => response,
    text: async () => JSON.stringify(response),
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("resolveTeamId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("treats a UUID-shaped team value as already resolved (no API call)", async () => {
    const fn = mockFetch({});
    const team = await resolveTeamId({
      apiKey: "k",
      team: "abcdef01-2345-6789-abcd-ef0123456789",
    });
    expect(team.id).toBe("abcdef01-2345-6789-abcd-ef0123456789");
    expect(fn).not.toHaveBeenCalled();
  });

  it("resolves a team key via findTeamByKey", async () => {
    mockFetch({
      data: {
        teams: {
          nodes: [
            { id: "u1", key: "ENG", name: "Engineering" },
            { id: "u2", key: "FRI", name: "Friday" },
          ],
        },
      },
    });
    const team = await resolveTeamId({ apiKey: "k", team: "FRI" });
    expect(team.id).toBe("u2");
  });

  it("throws when a configured key has no matching team", async () => {
    mockFetch({ data: { teams: { nodes: [] } } });
    await expect(
      resolveTeamId({ apiKey: "k", team: "FRI" }),
    ).rejects.toThrow(/Linear team "FRI" not found/);
  });

  it("falls back to the first team and warns when team is unset", async () => {
    mockFetch({
      data: {
        teams: {
          nodes: [
            { id: "u1", key: "ENG", name: "Engineering" },
            { id: "u2", key: "FRI", name: "Friday" },
          ],
        },
      },
    });
    const warn = vi.fn();
    const team = await resolveTeamId({ apiKey: "k", warn });
    expect(team.id).toBe("u1");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/linear\.team not configured/);
  });

  it("throws when the API key has access to no teams", async () => {
    mockFetch({ data: { teams: { nodes: [] } } });
    await expect(resolveTeamId({ apiKey: "k", warn: () => {} })).rejects.toThrow(
      /no teams/,
    );
  });
});
