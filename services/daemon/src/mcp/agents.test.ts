/**
 * FRI-127 §3 / AC#4: the `agent_create` tool description must lead with the
 * delegation value-proposition and explicitly steer away from the built-in
 * `Task` tool. At tool-choice time the model picks on semantic match; a
 * description that frames the async return as a constraint ("Returns
 * immediately; do NOT wait") loses to `Task`'s value-led description. Leading
 * with "Delegate scoped work …" + "PREFER this over the built-in Task tool"
 * flips that.
 */

import { describe, expect, it } from "vitest";
import { AGENT_CREATE_DESCRIPTION, AGENT_CREATE_SPAWNABLE_TYPES } from "./agents.js";

// FRI-16 AC #23 (wire-schema half): `agent_create`'s `type` enum must agree
// with the spawn matrix's columns — builder/helper/bare/planner, never
// scheduled (cron-only). The caller-side gate (which CALLERS may request
// which types) lives in spawn-permissions.test.ts.
describe("agent_create spawnable-type enum (FRI-16)", () => {
  it("accepts exactly builder/helper/bare/planner", () => {
    expect([...AGENT_CREATE_SPAWNABLE_TYPES]).toEqual(["builder", "helper", "bare", "planner"]);
  });
});

describe("agent_create description (FRI-127 §3)", () => {
  it("leads with the delegation value-proposition", () => {
    expect(AGENT_CREATE_DESCRIPTION.startsWith("Delegate scoped work")).toBe(true);
  });

  it("explicitly prefers itself over the built-in Task tool", () => {
    expect(AGENT_CREATE_DESCRIPTION).toContain("PREFER this over the built-in Task tool");
  });

  it("still states the async (non-blocking) return contract", () => {
    expect(AGENT_CREATE_DESCRIPTION).toContain("Returns immediately; do not wait synchronously");
  });
});
