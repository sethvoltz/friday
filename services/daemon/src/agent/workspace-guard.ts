/**
 * Defense-in-depth path-guard for builder workspaces. The builder's system
 * prompt says "do not modify files outside your worktree"; this layer
 * actually enforces it as a Claude SDK PreToolUse hook so a misbehaving
 * model can't escape the worktree.
 *
 * Ported from the old SlackAgents Friday at
 * `services/friday/src/agent/workspace-guard.ts`.
 */

import { normalize } from "node:path";

/**
 * Meta-commands that are workspace-agnostic — skip path checks for these.
 * Friday's CLI auto-discovers its data dir from any cwd.
 */
const EXEMPT_COMMANDS = ["friday"];

/**
 * System-owned prefixes that are safe to reference in Bash command strings.
 * These are executables and system resources, not user data.
 */
const SYSTEM_PATH_PREFIXES = [
  "/usr/",
  "/bin/",
  "/sbin/",
  "/lib/",
  "/opt/",
  "/System/",
  "/Library/",
  "/Applications/",
  "/dev/",
  "/proc/",
  "/run/",
  "/private/",
  "/nix/",
  "/tmp/",
];

function isSystemPath(p: string): boolean {
  return SYSTEM_PATH_PREFIXES.some((prefix) => p.startsWith(prefix));
}

function makeIsOutside(workspace: string): (p: unknown) => boolean {
  return function isOutside(p: unknown): boolean {
    if (typeof p !== "string" || !p.startsWith("/")) return false;
    const norm = normalize(p).replace(/\/+$/, "");
    return norm !== workspace && !norm.startsWith(workspace + "/");
  };
}

/**
 * Returns null if the tool call is permitted; a human-readable reason string
 * if it should be blocked.
 */
export function checkToolCall(
  workspacePath: string,
  toolName: string | undefined,
  toolInput: Record<string, unknown>,
): string | null {
  const workspace = normalize(workspacePath).replace(/\/+$/, "");
  const isOutside = makeIsOutside(workspace);

  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      if (isOutside(toolInput.file_path)) {
        return `${toolName} blocked — "${toolInput.file_path}" is outside workspace "${workspace}"`;
      }
      break;

    case "Glob":
    case "Grep":
      if (isOutside(toolInput.path)) {
        return `${toolName} blocked — path "${toolInput.path}" is outside workspace "${workspace}"`;
      }
      break;

    case "Bash": {
      const cmd =
        typeof toolInput.command === "string" ? toolInput.command : "";

      // git worktree commands are always allowed — builders use these to set up repos.
      if (/\bgit\s+worktree\b/.test(cmd)) break;

      // Exempt meta-commands that are workspace-agnostic.
      const firstToken = cmd.trimStart().split(/\s+/)[0] ?? "";
      if (EXEMPT_COMMANDS.includes(firstToken)) break;

      // Check explicit cwd override.
      if (isOutside(toolInput.cwd)) {
        return `Bash blocked — cwd "${toolInput.cwd}" is outside workspace "${workspace}"`;
      }

      // Scan command string for absolute paths to user data outside workspace.
      // Lookbehind excludes slashes inside relative paths like dist/index.js.
      const matches =
        cmd.match(/(?<![a-zA-Z0-9_.])\/[^\s'"`;&|<>()\\]+/g) ?? [];
      for (const p of matches) {
        if (!isSystemPath(p) && isOutside(p)) {
          return `Bash blocked — command references "${p}" outside workspace "${workspace}"`;
        }
      }
      break;
    }
  }

  return null;
}
