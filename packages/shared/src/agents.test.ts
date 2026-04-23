import { describe, it, expect } from "vitest";
import { isValidAgentName, buildAgentName } from "./agents.js";

describe("isValidAgentName", () => {
  it("accepts valid names", () => {
    expect(isValidAgentName("builder-auth")).toBe(true);
    expect(isValidAgentName("agent-auth-tests")).toBe(true);
    expect(isValidAgentName("orchestrator")).toBe(true);
    expect(isValidAgentName("ab")).toBe(true);
  });

  it("rejects single character", () => {
    expect(isValidAgentName("a")).toBe(false);
  });

  it("rejects names with uppercase", () => {
    expect(isValidAgentName("Builder-Auth")).toBe(false);
  });

  it("rejects leading/trailing hyphens", () => {
    expect(isValidAgentName("-builder")).toBe(false);
    expect(isValidAgentName("builder-")).toBe(false);
  });

  it("rejects names with special characters", () => {
    expect(isValidAgentName("builder_auth")).toBe(false);
    expect(isValidAgentName("builder.auth")).toBe(false);
    expect(isValidAgentName("builder auth")).toBe(false);
  });
});

describe("buildAgentName", () => {
  it("builds builder names", () => {
    expect(buildAgentName("builder", "orchestrator", "auth refactor")).toBe(
      "builder-auth-refactor"
    );
    expect(buildAgentName("builder", "orchestrator", "My Blog")).toBe(
      "builder-my-blog"
    );
  });

  it("builds agent names namespaced to parent", () => {
    expect(
      buildAgentName("agent", "builder-auth-refactor", "unit tests")
    ).toBe("agent-auth-refactor-unit-tests");
  });

  it("strips builder- prefix from parent for agent names", () => {
    expect(buildAgentName("agent", "builder-blog", "deploy")).toBe(
      "agent-blog-deploy"
    );
  });

  it("handles special characters in descriptor", () => {
    expect(buildAgentName("builder", "orchestrator", "Fix Bug #123!")).toBe(
      "builder-fix-bug-123"
    );
  });
});
