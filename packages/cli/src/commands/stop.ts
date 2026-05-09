import { defineCommand } from "citty";
import pc from "picocolors";
import { SERVICES, type ServiceName } from "@friday/shared";
import { hasSession, killSession } from "../lib/tmux.js";
import { clearState, readState, tmuxSessionFor } from "../lib/state.js";
import { isAlive, stopPid } from "../lib/proc.js";

export const stopCommand = defineCommand({
  meta: {
    name: "stop",
    description: "Stop a service. `stop` (no arg) stops daemon, dashboard, and tunnel.",
  },
  args: {
    service: {
      type: "positional",
      required: false,
      description: `${SERVICES.join(" | ")} (default: all)`,
    },
  },
  async run({ args }) {
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
      if (svc === "tunnel") {
        const state = readState("tunnel");
        if (state?.pid && isAlive(state.pid)) {
          const ok = await stopPid(state.pid);
          clearState("tunnel");
          if (ok) {
            console.log(`  ${pc.green("✓")} stopped tunnel (pid ${state.pid})`);
            stopped++;
          } else {
            console.log(
              `  ${pc.red("✗")} tunnel pid ${state.pid} did not exit cleanly`,
            );
          }
        } else {
          // Stale state file (process gone but state lingered) — clear it.
          if (state) clearState("tunnel");
          console.log(pc.dim(`  · tunnel not running`));
        }
        continue;
      }

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

    // Migration cleanup: if a previous run created a tmux session for the
    // tunnel (now superseded by the daemon-style supervision), kill it.
    if (hasSession("friday-tunnel")) {
      killSession("friday-tunnel");
      console.log(`  ${pc.green("✓")} stopped legacy tunnel tmux session`);
      stopped++;
    }

    if (stopped === 0) console.log(pc.dim("nothing to stop."));
  },
});

function validateService(s: string): s is ServiceName {
  return (SERVICES as readonly string[]).includes(s);
}
