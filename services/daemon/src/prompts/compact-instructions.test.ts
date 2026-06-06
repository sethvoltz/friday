/**
 * FRI-156 §C — golden + structural pins for COMPACT_CUSTOM_INSTRUCTIONS.
 *
 * The value is static (no DB, no hooks, no I/O), so there is no createTestDb
 * here. The load-bearing `.toContain()` directive pins run FIRST and guard the
 * four continuity directives the persona-compaction policy requires:
 * open commitments, in-flight tasks + state, relationship tone, and decisions
 * WITH their reasoning. They matter because `toMatchFileSnapshot` auto-writes
 * the golden on first run — without these pins the golden would be a tautology
 * that any `-u` re-baseline could silently hollow out.
 *
 * Regenerate the golden after an intentional copy change:
 *   pnpm --filter @friday/daemon exec vitest run -u src/prompts/compact-instructions.test.ts
 */

import { describe, expect, it } from "vitest";
import { COMPACT_CUSTOM_INSTRUCTIONS } from "./compact-instructions.js";

describe("COMPACT_CUSTOM_INSTRUCTIONS (FRI-156 §C)", () => {
  it("pins the four continuity directives, then matches the golden", async () => {
    // Load-bearing structural pins — these run BEFORE the snapshot so a silent
    // -u re-baseline can't strip a directive without a test author noticing.
    expect(COMPACT_CUSTOM_INSTRUCTIONS).toContain("Open commitments to the user");
    expect(COMPACT_CUSTOM_INSTRUCTIONS).toContain("In-flight tasks and their current state");
    expect(COMPACT_CUSTOM_INSTRUCTIONS).toContain("Relationship tone and voice");
    expect(COMPACT_CUSTOM_INSTRUCTIONS).toContain("Recent decisions AND their reasoning");
    // The summary REPLACES older turns — the policy's core framing.
    expect(COMPACT_CUSTOM_INSTRUCTIONS).toContain("The summary you produce REPLACES");

    await expect(COMPACT_CUSTOM_INSTRUCTIONS).toMatchFileSnapshot(
      "./__golden__/compact-instructions.txt",
    );
  });
});
