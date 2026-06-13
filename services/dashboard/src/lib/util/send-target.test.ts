import { describe, expect, it } from "vitest";
import { resolveSendTargetAgent } from "./send-target";

describe("resolveSendTargetAgent", () => {
  it("maps the root route to the default friday agent", () => {
    expect(resolveSendTargetAgent("/")).toBe("friday");
  });

  it("resolves the agent from a live /sessions/<agent> route", () => {
    expect(resolveSendTargetAgent("/sessions/reading-friend")).toBe("reading-friend");
  });

  it("resolves the agent from a /sessions/<agent>/<session> route", () => {
    expect(resolveSendTargetAgent("/sessions/reading-friend/2026-W24")).toBe("reading-friend");
  });

  it("decodes URL-encoded agent names", () => {
    expect(resolveSendTargetAgent("/sessions/scheduled%2Dmeta%2Ddaily")).toBe(
      "scheduled-meta-daily",
    );
  });

  it("is the URL agent, not a previously-focused one — the FRI-72 invariant", () => {
    // The whole point: viewing /sessions/A resolves to A regardless of any
    // lagging focusedAgent signal the caller might otherwise have read.
    expect(resolveSendTargetAgent("/sessions/A")).toBe("A");
    expect(resolveSendTargetAgent("/sessions/B")).toBe("B");
  });

  it("returns null for non-chat routes so callers fall back", () => {
    expect(resolveSendTargetAgent("/settings")).toBeNull();
    expect(resolveSendTargetAgent("/builders/foo")).toBeNull();
  });

  it("returns null for a malformed /sessions/ route with no agent segment", () => {
    expect(resolveSendTargetAgent("/sessions/")).toBeNull();
  });

  it("rejects a resolved agent name that decodes to contain a slash", () => {
    // Defensive guard: `a%2Fb` decodes to `a/b`, which is not a valid
    // single-segment agent name. Refuse it rather than stamping a send with
    // a bogus, slash-bearing agent. Not reachable as a chat route today.
    expect(resolveSendTargetAgent("/sessions/a%2Fb")).toBeNull();
  });
});
