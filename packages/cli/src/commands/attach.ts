import { defineCommand } from "citty";
import pc from "picocolors";
import { attachSession, hasSession } from "../lib/tmux.js";
import { tmuxSessionFor } from "../lib/state.js";

export const attachCommand = defineCommand({
  meta: {
    name: "attach",
    description: "Attach the tmux session for a service",
  },
  args: {
    service: {
      type: "positional",
      required: true,
      description: "daemon | dashboard",
    },
  },
  run({ args }) {
    const target = (args.service as string).toLowerCase();
    if (target === "tunnel") {
      console.error(
        pc.red(`tunnel runs as a background daemon, not a tmux session.`),
      );
      console.error(
        `  watch it: ${pc.cyan(`friday logs tunnel -f`)}`,
      );
      process.exit(1);
    }
    if (!validateService(target)) {
      console.error(
        pc.red(`unknown service: ${target}`) + ` (expected: daemon | dashboard)`,
      );
      process.exit(1);
    }
    const session = tmuxSessionFor(target);
    if (!hasSession(session)) {
      console.error(pc.red(`${target} is not running.`));
      console.error(`  start it: ${pc.cyan(`friday start ${target} --dev`)}`);
      process.exit(1);
    }
    attachSession(session);
  },
});

function validateService(s: string): s is "daemon" | "dashboard" {
  return s === "daemon" || s === "dashboard";
}
