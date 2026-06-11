/**
 * Path math for the Claude SDK's session-transcript layout — the single source
 * of truth for the `~/.claude/projects/<encoded-cwd>/` encoding, shared by the
 * daemon (session resume + jsonl recovery) and the CLI (backup/restore capture).
 *
 * The SDK CLI writes `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` for
 * every session, plus a sibling `<sessionId>/tool-results/` directory for any
 * tool output too large to inline. Encoding is `replace(/[^a-zA-Z0-9]/g, "-")`
 * applied to the absolute cwd — every non-alphanumeric ASCII char becomes a
 * single `-`. Verified against the CLI binary's behaviour 2026-05-21.
 *
 * Migration note: these paths are derived from the worker's cwd, which for
 * non-builder agents is `~/.friday/agents/<name>` — so the encoding is identical
 * across machines that share a `$HOME`. `friday restore` RE-DERIVES the target
 * path from the target machine's cwd rather than reusing the source hash, so a
 * migration to a different `$HOME`/user still lands sessions where resume looks.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Encode an absolute cwd to the project-dir basename under `~/.claude/projects/`. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Absolute path to the `~/.claude/projects/<encoded-cwd>/` dir for a cwd. */
export function claudeProjectDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", encodeProjectDir(cwd));
}

/** Absolute path to a session's JSONL transcript on disk. */
export function sessionFilePath(cwd: string, sessionId: string): string {
  return join(claudeProjectDir(cwd), `${sessionId}.jsonl`);
}

/**
 * Absolute path to a session's sidecar directory on disk — the SDK writes
 * `<sidecar>/tool-results/<toolName>-<ts>.txt` files here for tool output
 * that's too large for the inline transcript. Friday cannot suppress this
 * (the literal `tool-results` lives inside the SDK CLI binary), so any
 * migration that moves a JSONL must move this dir alongside it.
 */
export function sessionSidecarDir(cwd: string, sessionId: string): string {
  return join(claudeProjectDir(cwd), sessionId);
}
