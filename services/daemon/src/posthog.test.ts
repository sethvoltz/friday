import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pin the per-originator attribution mapping in `captureFor`: a user id
// becomes the PostHog `distinct_id` (matching the dashboard's identify, so
// daemon events merge into the same person) with email/name `$set`; a null
// originator falls back to the `friday-daemon` service actor; every event
// carries `server_side: true`. The PostHog client and DB are mocked so the
// test asserts the mapping, not network/IO.

const captureSpy = vi.fn();

vi.mock("posthog-node", () => ({
  // Must be a real constructor — posthog.ts does `new PostHog(...)`.
  PostHog: class {
    capture = captureSpy;
    captureException = vi.fn();
    shutdown = vi.fn();
  },
}));

vi.mock("drizzle-orm", () => ({ eq: vi.fn(() => ({})) }));

vi.mock("@friday/shared", () => ({
  schema: { users: { id: {}, email: {}, name: {} } },
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ email: "seth@designgods.net", name: "Seth" }],
        }),
      }),
    }),
  }),
}));

describe("captureFor", () => {
  beforeEach(() => {
    captureSpy.mockClear();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("attributes to the friday-daemon service actor when there is no originator", async () => {
    const { captureFor } = await import("./posthog.js");
    captureFor(null, "schedule_fired", { schedule_name: "nightly" });
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy).toHaveBeenCalledWith({
      distinctId: "friday-daemon",
      event: "schedule_fired",
      properties: { schedule_name: "nightly", server_side: true },
    });
  });

  it("attributes to the originating user id and $sets their identity", async () => {
    const { captureFor } = await import("./posthog.js");
    captureFor("RccSi68oUrZw4eTVmRllOtoJRsriJv4D", "turn_completed", { agent_name: "friday" });
    // Identity resolution is async (DB lookup) before the capture fires.
    await vi.waitFor(() => expect(captureSpy).toHaveBeenCalledTimes(1));
    expect(captureSpy).toHaveBeenCalledWith({
      distinctId: "RccSi68oUrZw4eTVmRllOtoJRsriJv4D",
      event: "turn_completed",
      properties: {
        agent_name: "friday",
        $set: { email: "seth@designgods.net", name: "Seth" },
        server_side: true,
      },
    });
  });
});
