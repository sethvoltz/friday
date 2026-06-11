/**
 * Path math for the Claude SDK's session-transcript layout.
 *
 * Moved to `@friday/shared` (full backup/restore) so the CLI's backup/restore
 * can capture + re-derive these paths using the EXACT same encoding the daemon
 * resumes against — re-exported here so existing daemon imports
 * (`sdk-jsonl-heal`, `jsonl-recovery`, `agent-cwd-pin-v1`) stay unchanged.
 */
export {
  encodeProjectDir,
  claudeProjectDir,
  sessionFilePath,
  sessionSidecarDir,
} from "@friday/shared";
