import { defineCommand } from "citty";
import pc from "picocolors";
import { SERVICES, type ServiceName } from "@friday/shared";
import { hasSession, killSession } from "../lib/tmux.js";
import { clearState, tmuxSessionFor } from "../lib/state.js";

export const stopCommand = defineCommand({
  meta: {
    name: "stop",
    description: "Stop a service. `stop` (no arg) stops both daemon + dashboard.",
  },
  args: {
    service: {
      type: "positional",
      required: false,
      description: "daemon | dashboard (default: both)",
    },
  },
  run({ args }) {
    const target = (args.service as string | undefined)?.toLowerCase();
    const services: ServiceName[] = target
      ? validateService(target)
        ? [target as ServiceName]
        : ((): ServiceName[] => {
            console.error(
              pc.red(`unknown service: ${target}`) + ` (expected: ${SERVICES.join(" | ")})`,
            );
            process.exit(1);
          })()
      : [...SERVICES];

    let stopped = 0;
    for (const svc of services) {
      const session = tmuxSessionFor(svc);
      if (hasSession(session)) {
        killSession(session);
        clearState(svc);
        console.log(`  ${pc.green("✓")} stopped ${svc} (${session})`);
        stopped++;
      } else {
        console.log(pc.dim(`  · ${svc} not running`));
      }
    }

    // Legacy single-session cleanup: a previous version of the CLI used
    // a unified `friday` session with two windows. If anyone's mid-migration
    // and that session is still alive, kill it too — otherwise it holds the
    // ports and new per-service starts crash silently.
    if (!target && hasSession("friday")) {
      killSession("friday");
      console.log(`  ${pc.green("✓")} stopped legacy unified session`);
      stopped++;
    }

    if (stopped === 0) console.log(pc.dim("nothing to stop."));
  },
});

function validateService(s: string): s is ServiceName {
  return s === "daemon" || s === "dashboard";
}
