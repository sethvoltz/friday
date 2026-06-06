/**
 * FRI-16 AC #14b — the workspace-guard gate inside the worker's PreToolUse
 * adapter (`buildPreToolUseHooks`). Registration is unconditional at HEAD
 * (the adapter also carries the FRI-152 built-in `AskUserQuestion` deny),
 * so these tests assert whether the guard CHAIN EXECUTES, not whether the
 * hook is registered:
 *
 *   (a) builder                          → chain runs (strict mode)
 *   (b) planner inside a builder worktree → chain runs (middle mode)
 *   (c) planner elsewhere                → chain skipped
 *   (d) helper                           → chain skipped
 *
 * The `before_tool_call` registry is populated by worker.ts's own
 * `import "../hooks/register.js"` side effect — the same wiring a real
 * forked worker gets — so a denied Write here proves the full
 * worker → runHooks → workspaceGuardHook → checkToolCall chain.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Bind the data dir BEFORE any @friday/shared machinery loads —
// `workspacesRoot()` (which the gate's `isInsideBuilderWorkspace` reads)
// derives from DATA_DIR at import time.
process.env.FRIDAY_DATA_DIR = mkdtempSync(join(tmpdir(), "fri16-guard-gate-"));

const { buildPreToolUseHooks, isInsideBuilderWorkspace } = await import("./worker.js");
const { workspacesRoot } = await import("./workspace.js");
const { ASK_USER_QUESTION_BUILTIN_DENY_REASON } =
  await import("../hooks/block-builtin-ask-user-question.js");
type WorkerSpawnOptions = import("./worker-protocol.js").WorkerSpawnOptions;
type AgentType = import("@friday/shared").AgentType;

// A real builder-style worktree under ~/.friday/workspaces/ and a
// non-workspace home (where a planner spawned by the orchestrator lands).
const builderWorktree = join(workspacesRoot(), "builder-x");
const plannerHome = join(process.env.FRIDAY_DATA_DIR, "agents", "planner-1");
mkdirSync(builderWorktree, { recursive: true });
mkdirSync(plannerHome, { recursive: true });
writeFileSync(join(builderWorktree, "inside.txt"), "ok");

function makeOpts(agentType: AgentType, workingDirectory: string): WorkerSpawnOptions {
  return {
    agentName: `a-${agentType}`,
    agentType,
    workingDirectory,
    systemPrompt: "sys",
    prompt: "do thing",
    turnId: "t_1",
    model: "claude-opus-4-7",
    daemonPort: 8765,
    mode: "long-lived",
  };
}

interface HookResponse {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

async function fire(
  agentType: AgentType,
  cwd: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<HookResponse> {
  const hooks = buildPreToolUseHooks(makeOpts(agentType, cwd));
  const handler = hooks.PreToolUse[0].hooks[0];
  return (await handler({
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
  })) as HookResponse;
}

describe("worker PreToolUse guard gate (FRI-16 AC #14b)", () => {
  it("(a) builder: guard chain RUNS — an out-of-workspace Write is denied", async () => {
    const res = await fire("builder", builderWorktree, "Write", { file_path: "/etc/passwd" });
    expect(res.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(res.hookSpecificOutput?.permissionDecisionReason).toContain("outside workspace");
    expect(res.hookSpecificOutput?.permissionDecisionReason).toContain("/etc/passwd");
  });

  it("(a') builder runs in STRICT mode — an out-of-workspace Read is denied too", async () => {
    const res = await fire("builder", builderWorktree, "Read", { file_path: "/etc/passwd" });
    expect(res.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(res.hookSpecificOutput?.permissionDecisionReason).toContain("outside workspace");
  });

  it("(b) planner inside a builder worktree: guard chain RUNS — an out-of-workspace Write is denied", async () => {
    const res = await fire("planner", builderWorktree, "Write", { file_path: "/etc/passwd" });
    expect(res.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(res.hookSpecificOutput?.permissionDecisionReason).toContain("outside workspace");
  });

  it("(b') planner inside a builder worktree runs in MIDDLE mode — an out-of-workspace Read passes", async () => {
    const res = await fire("planner", builderWorktree, "Read", { file_path: "/etc/passwd" });
    expect(res).toEqual({});
  });

  it("(c) planner with a non-workspace cwd (orchestrator-inherited): guard chain does NOT run — the same Write passes", async () => {
    const res = await fire("planner", plannerHome, "Write", { file_path: "/etc/passwd" });
    expect(res).toEqual({});
  });

  it("(d) helper: guard chain does NOT run — the same Write passes (even with a workspace cwd)", async () => {
    const res = await fire("helper", builderWorktree, "Write", { file_path: "/etc/passwd" });
    expect(res).toEqual({});
  });

  it("the FRI-152 built-in AskUserQuestion deny still fires for ALL agent types, planner included", async () => {
    for (const t of [
      "orchestrator",
      "builder",
      "helper",
      "scheduled",
      "bare",
      "planner",
    ] as const) {
      const res = await fire(t, plannerHome, "AskUserQuestion", {});
      expect(res.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(res.hookSpecificOutput?.permissionDecisionReason).toBe(
        ASK_USER_QUESTION_BUILTIN_DENY_REASON,
      );
    }
  });

  it("non-PreToolUse hook events fall through to {} without running the chain", async () => {
    const hooks = buildPreToolUseHooks(makeOpts("builder", builderWorktree));
    const handler = hooks.PreToolUse[0].hooks[0];
    const res = await handler({
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/etc/passwd" },
    });
    expect(res).toEqual({});
  });
});

describe("isInsideBuilderWorkspace (FRI-16)", () => {
  it("returns true for the workspaces root itself and any path under it", () => {
    expect(isInsideBuilderWorkspace(workspacesRoot())).toBe(true);
    expect(isInsideBuilderWorkspace(builderWorktree)).toBe(true);
    expect(isInsideBuilderWorkspace(join(builderWorktree, "deep", "nested"))).toBe(true);
  });

  it("returns false for a sibling path that merely shares the root as a string prefix", () => {
    expect(isInsideBuilderWorkspace(`${workspacesRoot()}-evil/x`)).toBe(false);
  });

  it("returns false for a per-agent home outside the workspaces root", () => {
    expect(isInsideBuilderWorkspace(plannerHome)).toBe(false);
  });
});
