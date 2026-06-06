import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkToolCall } from "./workspace-guard.js";

// FIX_FORWARD 5.3: the guard must resolve symlinks before checking
// containment. A `ln -s /etc/passwd ./esc` inside the workspace must not
// trick `Read esc` into passing.

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "friday-guard-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("workspace-guard symlink protection (FIX_FORWARD 5.3)", () => {
  it("allows Read on a regular file inside the workspace", () => {
    const inside = join(workspace, "real.txt");
    writeFileSync(inside, "hello");
    const result = checkToolCall(workspace, "Read", { file_path: inside });
    expect(result).toBeNull();
  });

  it("blocks Read on a symlink that points outside the workspace", () => {
    const link = join(workspace, "esc");
    symlinkSync("/etc/passwd", link);
    const result = checkToolCall(workspace, "Read", { file_path: link });
    expect(result).not.toBeNull();
    expect(result).toMatch(/blocked/);
    expect(result).toMatch(/resolves outside workspace/);
  });

  it("blocks Write on an absolute path that escapes the workspace", () => {
    const result = checkToolCall(workspace, "Write", {
      file_path: "/etc/passwd",
    });
    expect(result).not.toBeNull();
  });

  it("allows Write to a not-yet-existing file inside the workspace", () => {
    const target = join(workspace, "nested", "new.txt");
    mkdirSync(join(workspace, "nested"), { recursive: true });
    const result = checkToolCall(workspace, "Write", { file_path: target });
    expect(result).toBeNull();
  });

  it("blocks Bash referencing an absolute path outside the workspace", () => {
    const result = checkToolCall(workspace, "Bash", {
      command: "cat /Users/someone/secrets.env",
    });
    expect(result).not.toBeNull();
    expect(result).toMatch(/Bash blocked/);
  });

  it("allows Bash with a system-path command (e.g. /usr/bin/git)", () => {
    const result = checkToolCall(workspace, "Bash", {
      command: "/usr/bin/git status",
    });
    expect(result).toBeNull();
  });

  it("blocks Glob with a symlinked subdir pointing outside", () => {
    const linkDir = join(workspace, "outdir");
    symlinkSync("/etc", linkDir);
    const result = checkToolCall(workspace, "Glob", { path: linkDir });
    expect(result).not.toBeNull();
    expect(result).toMatch(/resolves outside workspace/);
  });

  it("allows Glob with a path inside the workspace", () => {
    const sub = join(workspace, "src");
    mkdirSync(sub);
    const result = checkToolCall(workspace, "Glob", { path: sub });
    expect(result).toBeNull();
  });
});

// FRI-16 §4d: the planner middle path. `mode: "middle"` bypasses ONLY the
// Read arm and the Glob/Grep arm; Write/Edit containment and the Bash +
// disaster checks are unchanged. `mode: "strict"` (and absent opts) stays
// byte-identical to today.
describe("workspace-guard middle mode (FRI-16)", () => {
  it("allows Read outside the workspace in middle mode", () => {
    const result = checkToolCall(
      workspace,
      "Read",
      { file_path: "/etc/passwd" },
      { mode: "middle" },
    );
    expect(result).toBeNull();
  });

  it("allows Grep outside the workspace in middle mode", () => {
    const result = checkToolCall(workspace, "Grep", { path: "/etc" }, { mode: "middle" });
    expect(result).toBeNull();
  });

  it("allows Glob outside the workspace in middle mode", () => {
    const result = checkToolCall(workspace, "Glob", { path: "/etc" }, { mode: "middle" });
    expect(result).toBeNull();
  });

  it("still blocks Write outside the workspace in middle mode, with the same rejection string as strict", () => {
    const middle = checkToolCall(
      workspace,
      "Write",
      { file_path: "/etc/passwd" },
      { mode: "middle" },
    );
    const strict = checkToolCall(workspace, "Write", { file_path: "/etc/passwd" });
    expect(middle).toContain("outside workspace");
    expect(middle).toBe(strict);
  });

  it("still blocks Edit outside the workspace in middle mode, with the same rejection string as strict", () => {
    const middle = checkToolCall(
      workspace,
      "Edit",
      { file_path: "/etc/hosts" },
      { mode: "middle" },
    );
    const strict = checkToolCall(workspace, "Edit", { file_path: "/etc/hosts" });
    expect(middle).toContain("outside workspace");
    expect(middle).toBe(strict);
  });

  it("still blocks Bash `rm -rf $HOME` in middle mode (catastrophe protection unchanged)", () => {
    const result = checkToolCall(
      workspace,
      "Bash",
      { command: "rm -rf $HOME" },
      { mode: "middle" },
    );
    expect(result).toContain("outside workspace");
  });

  it("still blocks Bash referencing an absolute path outside the workspace in middle mode", () => {
    const result = checkToolCall(
      workspace,
      "Bash",
      { command: "cat /Users/someone/secrets.env" },
      { mode: "middle" },
    );
    expect(result).toMatch(/Bash blocked/);
  });

  it("explicit strict mode behaves identically to omitting opts (Read outside is blocked with the same string)", () => {
    const explicit = checkToolCall(
      workspace,
      "Read",
      { file_path: "/etc/passwd" },
      { mode: "strict" },
    );
    const implicit = checkToolCall(workspace, "Read", { file_path: "/etc/passwd" });
    expect(explicit).toContain("resolves outside workspace");
    expect(explicit).toBe(implicit);
  });
});
