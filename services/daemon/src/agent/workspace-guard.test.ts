import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
