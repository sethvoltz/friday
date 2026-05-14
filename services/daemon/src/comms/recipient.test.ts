/**
 * FRI-11 F2: mail recipient validation.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

const dataRoot = mkdtempSync(join(tmpdir(), "friday-recipient-"));
process.env.FRIDAY_DATA_DIR = dataRoot;

const { runMigrations, closeDb } = await import("@friday/shared");
const registry = await import("../agent/registry.js");
const { validateRecipient, levenshtein, resolveRecipient } = await import(
  "./recipient.js"
);

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  closeDb();
  rmSync(dataRoot, { recursive: true, force: true });
});

afterEach(() => {
  for (const a of registry.listAgents()) registry.archiveAgent(a.name);
});

describe("validateRecipient", () => {
  it("accepts a known non-archived agent", () => {
    registry.registerAgent({ name: "friday", type: "orchestrator" });
    const r = validateRecipient("friday");
    expect(r).toEqual({ ok: true, agent: "friday" });
  });

  it("rejects an unknown recipient with a useful error", () => {
    registry.registerAgent({ name: "friday", type: "orchestrator" });
    const r = validateRecipient("nobody");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("unknown recipient");
    expect(r.error).toContain("nobody");
  });

  it("suggests the closest live agent on a typo", () => {
    registry.registerAgent({ name: "friday", type: "orchestrator" });
    const r = validateRecipient("fridya");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.suggestion).toBe("friday");
    expect(r.error).toContain('did you mean "friday"');
  });

  it("does not suggest the role name 'orchestrator' for someone named 'friday'", () => {
    // The original bug: builder sent to "orchestrator". That's not close to
    // any real agent name in Levenshtein terms, so no false-positive suggestion.
    registry.registerAgent({ name: "friday", type: "orchestrator" });
    const r = validateRecipient("orchestrator");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.suggestion).toBeUndefined();
  });

  it("rejects an archived agent and says so explicitly", () => {
    registry.registerAgent({ name: "friday", type: "orchestrator" });
    registry.registerAgent({
      name: "old-builder",
      type: "builder",
      parentName: "friday",
      worktreePath: "/tmp/old",
    });
    registry.archiveAgent("old-builder");
    const r = validateRecipient("old-builder");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("archived");
  });

  it("rejects empty input", () => {
    const r = validateRecipient("");
    expect(r.ok).toBe(false);
  });
});

describe("resolveRecipient (FRI-11 F3)", () => {
  it("passes literal names through unchanged", () => {
    registry.registerAgent({ name: "friday", type: "orchestrator" });
    const r = resolveRecipient("friday", "some-other-agent");
    expect(r).toEqual({ ok: true, agent: "some-other-agent" });
  });

  it("resolves 'parent' to the caller's registered parentName", () => {
    registry.registerAgent({ name: "friday", type: "orchestrator" });
    registry.registerAgent({
      name: "builder-1",
      type: "builder",
      parentName: "friday",
      worktreePath: "/tmp/b1",
    });
    const r = resolveRecipient("builder-1", "parent");
    expect(r).toEqual({ ok: true, agent: "friday" });
  });

  it("resolves 'self' to the caller's own name", () => {
    registry.registerAgent({ name: "friday", type: "orchestrator" });
    const r = resolveRecipient("friday", "self");
    expect(r).toEqual({ ok: true, agent: "friday" });
  });

  it("rejects 'parent' when caller has no parent", () => {
    registry.registerAgent({ name: "friday", type: "orchestrator" });
    const r = resolveRecipient("friday", "parent");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("no registered parent");
  });

  it("rejects symbolic recipients when caller is not registered", () => {
    const r = resolveRecipient("ghost", "parent");
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
