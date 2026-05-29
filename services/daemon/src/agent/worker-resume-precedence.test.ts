/**
 * FRI-127 §6 / AC#9: the worker's drain path must prefer its own observed
 * `lastSessionId` over the POST/NOTIFY-time `p.resumeSessionId`. The latter is
 * captured when the dispatch is queued and goes stale once the just-finished
 * turn moves the SDK session on; resuming it drops a queued prompt into an
 * obsolete session JSONL and surfaces as "Agent didn't respond". Only fall
 * back to the parent-provided value on first-turn-after-spawn, where the
 * worker has no observed session yet.
 */

import { describe, expect, it } from "vitest";
import { resolveSessionId } from "./worker.js";

describe("resolveSessionId (FRI-127 §6)", () => {
  it("prefers the live lastSessionId over a stale p.resumeSessionId", () => {
    expect(resolveSessionId({ resumeSessionId: "sess-OLD" }, "sess-NEW")).toBe("sess-NEW");
  });

  it("falls back to p.resumeSessionId when lastSessionId is undefined (first turn)", () => {
    expect(resolveSessionId({ resumeSessionId: "sess-OLD" }, undefined)).toBe("sess-OLD");
  });

  it("returns undefined when neither is present (fresh spawn, brand-new session)", () => {
    expect(resolveSessionId({}, undefined)).toBeUndefined();
  });
});
