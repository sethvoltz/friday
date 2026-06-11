// Pins the Claude SDK session-transcript path encoding. This is a CONTRACT with
// the SDK CLI binary (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`): if
// this encoding drifts, the daemon's `resume` looks in the wrong place and every
// session silently starts cold — and backup/restore would capture/place sessions
// where resume won't find them. Both the daemon (resume + jsonl recovery) and the
// CLI (full backup/restore) depend on these producing identical paths.

import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  encodeProjectDir,
  claudeProjectDir,
  sessionFilePath,
  sessionSidecarDir,
} from "./claude-sessions.js";

describe("claude-sessions path encoding (SDK contract)", () => {
  it("replaces every non-alphanumeric char with a single hyphen", () => {
    expect(encodeProjectDir("/a/b.c")).toBe("-a-b-c");
    // The orchestrator's real home: note the single leading `-` (one slash) and
    // the `--` from `/.` in `/.friday`.
    expect(encodeProjectDir("/Users/seth/.friday/agents/friday")).toBe(
      "-Users-seth--friday-agents-friday",
    );
  });

  it("leaves alphanumerics untouched and collapses nothing", () => {
    // Each non-alnum maps to exactly one hyphen — same length out as in.
    const cwd = "/Users/seth/.friday/agents/friday";
    expect(encodeProjectDir(cwd)).toHaveLength(cwd.length);
    expect(encodeProjectDir(cwd)).not.toMatch(/[^a-zA-Z0-9-]/);
  });

  it("builds the project dir + jsonl + sidecar under ~/.claude/projects", () => {
    const cwd = "/Users/seth/.friday/agents/friday";
    const sid = "abc123";
    const projDir = join(homedir(), ".claude", "projects", "-Users-seth--friday-agents-friday");
    expect(claudeProjectDir(cwd)).toBe(projDir);
    expect(sessionFilePath(cwd, sid)).toBe(join(projDir, "abc123.jsonl"));
    expect(sessionSidecarDir(cwd, sid)).toBe(join(projDir, "abc123"));
  });
});
