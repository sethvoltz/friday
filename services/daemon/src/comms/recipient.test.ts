/**
 * FRI-11 F2: mail recipient validation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDbHandle } from "@friday/shared";

let handle: TestDbHandle;
let registry: typeof import("../agent/registry.js");
let validateRecipient: typeof import("./recipient.js")["validateRecipient"];
let levenshtein: typeof import("./recipient.js")["levenshtein"];
let resolveRecipient: typeof import("./recipient.js")["resolveRecipient"];

beforeAll(async () => {
  handle = await createTestDb({ label: "recipient" });
  registry = await import("../agent/registry.js");
  ({ validateRecipient, levenshtein, resolveRecipient } = await import(
    "./recipient.js"
  ));
});

afterAll(async () => {
  await handle.drop();
});

beforeEach(async () => {
  await handle.truncate();
});

describe("validateRecipient", () => {
  it("accepts a known non-archived agent", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    const r = await validateRecipient("friday");
    expect(r).toEqual({ ok: true, agent: "friday" });
  });

  it("rejects an unknown recipient with a useful error", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    const r = await validateRecipient("nobody");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("unknown recipient");
    expect(r.error).toContain("nobody");
  });

  it("suggests the closest live agent on a typo", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    const r = await validateRecipient("fridya");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.suggestion).toBe("friday");
    expect(r.error).toContain('did you mean "friday"');
  });

  it("does not suggest the role name 'orchestrator' for someone named 'friday'", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    const r = await validateRecipient("orchestrator");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.suggestion).toBeUndefined();
  });

  it("rejects an archived agent and says so explicitly", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    await registry.registerAgent({
      name: "old-builder",
      type: "builder",
      parentName: "friday",
      worktreePath: "/tmp/old",
    });
    await registry.archiveAgent("old-builder");
    const r = await validateRecipient("old-builder");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("archived");
  });

  it("rejects empty input", async () => {
    const r = await validateRecipient("");
    expect(r.ok).toBe(false);
  });
});

describe("resolveRecipient (FRI-11 F3)", () => {
  it("passes literal names through unchanged", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    const r = await resolveRecipient("friday", "some-other-agent");
    expect(r).toEqual({ ok: true, agent: "some-other-agent" });
  });

  it("resolves 'parent' to the caller's registered parentName", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    await registry.registerAgent({
      name: "builder-1",
      type: "builder",
      parentName: "friday",
      worktreePath: "/tmp/b1",
    });
    const r = await resolveRecipient("builder-1", "parent");
    expect(r).toEqual({ ok: true, agent: "friday" });
  });

  it("resolves 'self' to the caller's own name", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    const r = await resolveRecipient("friday", "self");
    expect(r).toEqual({ ok: true, agent: "friday" });
  });

  it("rejects 'parent' when caller has no parent", async () => {
    await registry.registerAgent({ name: "friday", type: "orchestrator" });
    const r = await resolveRecipient("friday", "parent");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("no registered parent");
  });

  it("rejects symbolic recipients when caller is not registered", async () => {
    const r = await resolveRecipient("ghost", "parent");
    expect(r.ok).toBe(false);
  });
});

describe("levenshtein", () => {
  it("computes basic distances", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("friday", "fridya")).toBe(2);
  });
});
