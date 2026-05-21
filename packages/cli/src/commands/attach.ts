import { defineCommand } from "citty";
import pc from "picocolors";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { getLogPath } from "@friday/shared";

/**
 * `friday attach <service>` — tail the service's log file.
 *
 * Post-FRI-88, tmux is gone from the prod supervision tree (§0 design
 * constraint). The supervisor pipes each child's stdout + stderr to
 * `~/.friday/logs/<service>.jsonl`, replacing tmux's pane scrollback
 * as the durable log channel. This command opens an interactive
 * `tail -F` on that file — same ergonomic as `tmux attach`, durable
 * across supervisor restarts, no pane state to recover.
 *
 * Ctrl-C exits the tail cleanly; the underlying service is untouched.
 */

const SERVICES_ATTACHABLE = ["daemon", "dashboard", "zero-cache"] as const;
type AttachableService = (typeof SERVICES_ATTACHABLE)[number];

function isAttachable(s: string): s is AttachableService {
  return (SERVICES_ATTACHABLE as readonly string[]).includes(s);
}

export const attachCommand = defineCommand({
  meta: {
    name: "attach",
    description: "Tail a service's log (~/.friday/logs/<service>.jsonl) interactively. Ctrl-C exits.",
  },
  args: {
    service: {
      type: "positional",
      required: true,
      description: SERVICES_ATTACHABLE.join(" | "),
    },
  },
  run({ args }) {
    const target = (args.service as string).toLowerCase();
    if (target === "tunnel") {
      console.error(
        pc.red(`cloudflared runs as its own user launch agent (com.cloudflare.cloudflared).`),
      );
      console.error(
        `  tail its log: ${pc.cyan(`friday logs tunnel -f`)}`,
      );
      console.error(
        `  inspect job: ${pc.cyan(`launchctl print gui/$(id -u)/com.cloudflare.cloudflared`)}`,
      );
      process.exit(1);
    }
    if (!isAttachable(target)) {
      console.error(
        pc.red(`unknown service: ${target}`) +
          ` (expected: ${SERVICES_ATTACHABLE.join(" | ")})`,
      );
      process.exit(1);
    }

    const logPath = getLogPath(target);
    if (!existsSync(logPath)) {
      console.error(pc.red(`no log at ${logPath}`));
      console.error(
        `  start the stack first: ${pc.cyan("friday start")} (or ${pc.cyan("brew services start friday")}).`,
      );
      console.error(
        `  the supervisor creates the log on first child spawn — it won't exist before that.`,
      );
      process.exit(1);
    }

    console.log(pc.dim(`tailing ${logPath} (Ctrl-C to exit; service keeps running)`));
    // `tail -F` follows the file even across rotation / re-creation,
    // which is how the supervisor handles log rolls (it reopens the
    // write stream on each child respawn). `-n 50` shows recent
    // context on attach.
    const tail = spawn("tail", ["-n", "50", "-F", logPath], {
      stdio: "inherit",
    });
    tail.on("exit", (code) => process.exit(code ?? 0));
  },
});
