import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetHooksForTest, registerHook, runHooks } from "@friday/shared";
import { workspaceGuardHook } from "./workspace-guard.js";

let workspacePath: string;

beforeEach(() => {
  __resetHooksForTest();
  workspacePath = mkdtempSync(join(tmpdir(), "fri-108-ws-"));
  writeFileSync(join(workspacePath, "inside.txt"), "ok");
});

afterEach(() => {
  __resetHooksForTest();
});

describe("workspace-guard hook (FRI-108)", () => {
  it("registered handler denies a Read outside workspace", async () => {
    registerHook("before_tool_call", workspaceGuardHook);

    const results = await runHooks("before_tool_call", {
      workspacePath,
      toolName: "Read",
      toolInput: { file_path: "/etc/passwd" },
    });

    expect(results).toHaveLength(1);
    expect(results[0].deny).toBeDefined();
    expect(results[0].deny!.reason).toContain("outside workspace");
    expect(results[0].deny!.reason).toContain("/etc/passwd");
  });

  it("registered handler permits a Read inside workspace", async () => {
    registerHook("before_tool_call", workspaceGuardHook);

    const results = await runHooks("before_tool_call", {
      workspacePath,
      toolName: "Read",
      toolInput: { file_path: join(workspacePath, "inside.txt") },
    });

    expect(results).toEqual([]);
  });

  // FRI-16 AC #14b: the hook forwards `ctx.mode` to checkToolCall.
  it("forwards mode:'middle' — a Read outside the workspace is permitted", async () => {
    registerHook("before_tool_call", workspaceGuardHook);

    const results = await runHooks("before_tool_call", {
      workspacePath,
      toolName: "Read",
      toolInput: { file_path: "/etc/passwd" },
      mode: "middle",
    });

    expect(results).toEqual([]);
  });

  it("forwards mode:'middle' — a Write outside the workspace is still denied", async () => {
    registerHook("before_tool_call", workspaceGuardHook);

    const results = await runHooks("before_tool_call", {
      workspacePath,
      toolName: "Write",
      toolInput: { file_path: "/etc/passwd" },
      mode: "middle",
    });

    expect(results).toHaveLength(1);
    expect(results[0].deny!.reason).toContain("outside workspace");
    expect(results[0].deny!.reason).toContain("/etc/passwd");
  });

  it("absent mode defaults to strict — a Read outside the workspace is denied (pre-FRI-16 behavior preserved)", async () => {
    registerHook("before_tool_call", workspaceGuardHook);

    const results = await runHooks("before_tool_call", {
      workspacePath,
      toolName: "Read",
      toolInput: { file_path: "/etc/passwd" },
    });

    expect(results).toHaveLength(1);
    expect(results[0].deny!.reason).toContain("outside workspace");
  });

  it("registered handler short-circuits a second handler when first denies", async () => {
    registerHook("before_tool_call", workspaceGuardHook);
    const spy = vi.fn(async () => undefined);
    registerHook("before_tool_call", spy);

    const results = await runHooks("before_tool_call", {
      workspacePath,
      toolName: "Read",
      toolInput: { file_path: "/etc/passwd" },
    });

    expect(spy).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].deny).toBeDefined();
  });
});
