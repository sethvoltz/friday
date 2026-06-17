/**
 * FRI-167: every turn body (including resumed turns) is prefixed with a
 * freshly-rendered `<current-time>` line so the model sees the current local
 * time, not the session-frozen value baked into the systemPrompt append.
 * Slash-command bodies are passed through verbatim.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTurnDatetime } from "./worker.js";

describe("applyTurnDatetime (FRI-167)", () => {
  beforeEach(() => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T17:58:00-07:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("injects fresh datetime on resumed-turn body, not the session-start value", () => {
    const a = applyTurnDatetime("hello");
    vi.setSystemTime(new Date("2026-06-09T09:00:00-07:00"));
    const b = applyTurnDatetime("hello");

    expect(a).toContain("June 8 2026");
    expect(b).toContain("June 9 2026");
    expect(b).not.toContain("June 8 2026");
    expect(b.startsWith("<current-time>")).toBe(true);
  });

  it("does not prefix slash-command bodies", () => {
    expect(applyTurnDatetime("/compact do the thing")).toBe("/compact do the thing");
  });

  it("prefixes non-slash bodies and leaves slash bodies untouched for both ternary arms (AC6)", () => {
    // The promptInput chokepoint feeds this single guarded string to BOTH the
    // attachment arm (buildAttachmentPromptStream's first arg) and the plain
    // string arm, so a direct test of the guard covers both paths.
    const nonSlash = applyTurnDatetime("describe the screenshot");
    expect(nonSlash.startsWith("<current-time>")).toBe(true);
    expect(nonSlash.endsWith("describe the screenshot")).toBe(true);

    expect(applyTurnDatetime("/attach something")).toBe("/attach something");
  });
});
