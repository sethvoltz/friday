import { defineCommand } from "citty";
import pc from "picocolors";
import { SERVICES, type ServiceName } from "@friday/shared";
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
      description: `daemon | dashboard`,
    },
  },
  run({ args }) {
    const target = (args.service as string).toLowerCase();
    if (!validateService(target)) {
      console.error(
        pc.red(`unknown service: ${target}`) + ` (expected: ${SERVICES.join(" | ")})`,
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

function validateService(s: string): s is ServiceName {
  return s === "daemon" || s === "dashboard";
}
