/**
 * Defense-in-depth path-guard for builder workspaces. The builder's system
 * prompt says "do not modify files outside your worktree"; this layer
 * actually enforces it as a Claude SDK PreToolUse hook so a misbehaving
 * model can't escape the worktree.
 *
 * FIX_FORWARD 5.3: containment is checked via `fs.realpathSync`, not bare
 * `path.normalize`. A symlink inside the workspace pointing at /etc/passwd
 * now resolves to /etc/passwd before the containment check fires, so the
 * symlink trick can't bypass the guard.
 *
 * Ported from the old SlackAgents Friday at
 * `services/friday/src/agent/workspace-guard.ts`.
 */

import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { realpathSync } from "node:fs";

/**
 * Meta-commands that are workspace-agnostic — skip path checks for these.
 * Friday's CLI auto-discovers its data dir from any cwd.
 */
const EXEMPT_COMMANDS = ["friday"];

/**
 * System-owned prefixes that are safe to reference in Bash command strings.
 * These are executables and system resources, not user data.
 */
// FIX_FORWARD 6.4 follow-up: do NOT exempt `/private/` here. On macOS,
// `/private/var/folders/<hash>/T/` is the per-user temp directory and
// `/private/var/folders/<hash>/C/` is per-user caches — exempting the
// whole `/private/` prefix lets a builder Bash-read any user's tempfiles
// without hitting the workspace containment check. System paths like
// `/etc`, `/usr`, `/bin` are unaffected: macOS surfaces them under their
// canonical (non-/private) names, and the realpath check in
// `isOutside` handles the rare cases that resolve into `/private/etc`.
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
  "/nix/",
  "/tmp/",
];

function isSystemPath(p: string): boolean {
  return SYSTEM_PATH_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Resolve `candidate` to its real filesystem path, following symlinks. If
 * the path doesn't exist yet (typical for Write to a new file), walks up
 * to the nearest existing parent and re-attaches the original tail. This
 * is the canonical form we compare against the workspace's real root.
 *
 * Returns null if no part of the path resolves (e.g. an entirely
 * non-existent absolute path under a missing root); callers treat null
 * as "outside" since we have no anchor to bound the check.
 */
function resolveReal(candidate: string): string | null {
  let cur = normalize(candidate).replace(/\/+$/, "");
  // Strip any trailing slash, then try to realpath. On ENOENT walk up.
  // The leftover (basename) is preserved so we get a deterministic full
  // path even when the leaf doesn't exist yet.
  let tail = "";
  for (let i = 0; i < 256; i++) {
    try {
      const real = realpathSync(cur);
      return tail ? join(real, tail) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return null;
      const leaf = basename(cur);
      tail = tail ? join(leaf, tail) : leaf;
      cur = parent;
    }
  }
  return null;
}

function inside(root: string, p: string): boolean {
  return p === root || p.startsWith(root + "/");
}

interface Guard {
  workspaceReal: string;
  isOutside: (p: unknown) => boolean;
}

function makeGuard(workspacePath: string): Guard {
  // realpath the workspace once. If the worktree itself doesn't exist
  // (unusual) we fall back to the normalized path — the per-call checks
  // will still reject anything that can't anchor inside it.
  const workspaceReal =
    resolveReal(workspacePath) ??
    normalize(workspacePath).replace(/\/+$/, "");
  return {
    workspaceReal,
    isOutside(p: unknown): boolean {
      if (typeof p !== "string") return false;
      if (!isAbsolute(p)) return false;
      const resolved = resolveReal(p);
      if (resolved === null) return true;
      return !inside(workspaceReal, resolved);
    },
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
  const { workspaceReal, isOutside } = makeGuard(workspacePath);

  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      if (isOutside(toolInput.file_path)) {
        return `${toolName} blocked — "${toolInput.file_path}" resolves outside workspace "${workspaceReal}"`;
      }
      break;

    case "Glob":
    case "Grep":
      if (isOutside(toolInput.path)) {
        return `${toolName} blocked — path "${toolInput.path}" resolves outside workspace "${workspaceReal}"`;
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
        return `Bash blocked — cwd "${toolInput.cwd}" resolves outside workspace "${workspaceReal}"`;
      }

      // Scan command string for absolute paths to user data outside workspace.
      // Lookbehind excludes slashes inside relative paths like dist/index.js.
      const matches =
        cmd.match(/(?<![a-zA-Z0-9_.])\/[^\s'"`;&|<>()\\]+/g) ?? [];
      for (const p of matches) {
        if (!isSystemPath(p) && isOutside(p)) {
          return `Bash blocked — command references "${p}" outside workspace "${workspaceReal}"`;
        }
      }
      break;
    }
  }

  return null;
}
