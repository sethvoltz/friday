import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetHooksForTest, registerHook, runHooks } from "@friday/shared";
import { builderTrailerHook } from "./builder-trailer.js";

beforeEach(() => {
  __resetHooksForTest();
  registerHook("agent:bootstrap", builderTrailerHook);
});

afterEach(() => {
  __resetHooksForTest();
});

describe("builder-trailer hook (FRI-109)", () => {
  it("returns appendSystemPrompt for agentType=builder with branch", async () => {
    const results = await runHooks("agent:bootstrap", {
      agentName: "b",
      agentType: "builder",
      workingDirectory: "/tmp/wt",
      branch: "main",
    });

    expect(results).toEqual([
      {
        appendSystemPrompt:
          "You are running in a git worktree at `/tmp/wt` on branch `main`. **Do not read, write, or modify files outside this directory.** All Bash commands run with this directory as cwd by default; do not `cd` outside it.",
      },
    ]);
  });

  it("returns appendSystemPrompt with <unknown> branch when ctx.branch is undefined", async () => {
    const results = await runHooks("agent:bootstrap", {
      agentName: "b",
      agentType: "builder",
      workingDirectory: "/tmp/wt",
    });

    expect(results).toHaveLength(1);
    expect(results[0].appendSystemPrompt).toContain("on branch `<unknown>`");
  });

  it("returns void (empty result array) for non-builder agentTypes", async () => {
    for (const agentType of ["orchestrator", "bare", "helper", "scheduled"] as const) {
      const results = await runHooks("agent:bootstrap", {
        agentName: "a",
        agentType,
        workingDirectory: "/tmp/wt",
        branch: "main",
      });
      expect(results).toEqual([]);
    }
  });

  it("returns void (empty result array) when workingDirectory is empty", async () => {
    const results = await runHooks("agent:bootstrap", {
      agentName: "b",
      agentType: "builder",
      workingDirectory: "",
      branch: "main",
    });

    expect(results).toEqual([]);
  });

  it("carries task scope + parent name + mail-back trailer for builders (FRI-127 §4)", async () => {
    const result = await builderTrailerHook({
      agentName: "b1",
      agentType: "builder",
      workingDirectory: "/tmp/wt",
      branch: "friday/x",
      parentName: "friday",
      spawnPrompt: "build the thing",
    });

    expect(result).not.toBeUndefined();
    const append = (result as { appendSystemPrompt: string }).appendSystemPrompt;
    expect(append).toContain("/tmp/wt");
    expect(append).toContain("friday/x");
    // The verbatim spawn prompt is recorded so a mail-woken builder retains
    // its original mission (closes the FRI-71 gap).
    expect(append).toContain("build the thing");
    // The mail-back reminder names the parent.
    expect(append).toContain('mail_send({to: "friday"');
  });

  it("non-builder agent types still return void even with parentName + spawnPrompt", async () => {
    for (const agentType of ["helper", "bare", "scheduled", "orchestrator"] as const) {
      const result = await builderTrailerHook({
        agentName: "a",
        agentType,
        workingDirectory: "/tmp/wt",
        branch: "friday/x",
        parentName: "friday",
        spawnPrompt: "build the thing",
      });
      expect(result).toBeUndefined();
    }
  });
});
