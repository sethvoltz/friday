import { describe, it, expect } from "vitest";
import { ChatAbortError } from "./llm.js";

describe("ChatAbortError", () => {
  it("carries the reason and message", () => {
    const err = new ChatAbortError("timeout", "enrichment timed out after 90s");
    expect(err.reason).toBe("timeout");
    expect(err.message).toBe("enrichment timed out after 90s");
    expect(err.name).toBe("ChatAbortError");
    expect(err instanceof Error).toBe(true);
  });

  it("distinguishes all four reasons", () => {
    const reasons = ["timeout", "interrupted", "api-error", "unknown"] as const;
    for (const reason of reasons) {
      const err = new ChatAbortError(reason, `test ${reason}`);
      expect(err.reason).toBe(reason);
    }
  });
});
