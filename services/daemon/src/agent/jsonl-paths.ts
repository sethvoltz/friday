/**
 * Path math for the Claude SDK's session-transcript layout.
 *
 * The SDK CLI writes `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` for
 * every session, plus a sibling `<sessionId>/tool-results/` directory for any
 * tool output too large to inline. Encoding is `replace(/[^a-zA-Z0-9]/g, "-")`
 * applied to the absolute cwd — every non-alphanumeric ASCII char becomes a
 * single `-`. Verified against the CLI binary's behaviour 2026-05-21.
 *
 * This module is the single source of truth for that encoding so callers can't
 * drift (the regex was duplicated across three files in production code prior
 * to FRI-61).
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Encode an absolute cwd to the project-dir basename under `~/.claude/projects/`. */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Absolute path to a session's JSONL transcript on disk. */
export function sessionFilePath(cwd: string, sessionId: string): string {
  return join(homedir(), ".claude", "projects", encodeProjectDir(cwd), `${sessionId}.jsonl`);
}

/**
 * Absolute path to a session's sidecar directory on disk — the SDK writes
 * `<sidecar>/tool-results/<toolName>-<ts>.txt` files here for tool output
 * that's too large for the inline transcript. Friday cannot suppress this
 * (the literal `tool-results` lives inside the SDK CLI binary), so any
 * migration that moves a JSONL must move this dir alongside it.
 */
export function sessionSidecarDir(cwd: string, sessionId: string): string {
  return join(homedir(), ".claude", "projects", encodeProjectDir(cwd), sessionId);
}
