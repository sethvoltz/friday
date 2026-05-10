import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { SERVICES, type ServiceName } from "@friday/shared";
import { hasSession, paneCommand } from "../lib/tmux.js";
import { readState, tmuxSessionFor, type ServiceMode } from "../lib/state.js";

export const restartCommand = defineCommand({
  meta: {
    name: "restart",
    description:
      "Restart a service in the same mode it was started in. With no arg restarts the daemon only; pass `all` to also bounce dashboard + tunnel. Does not accept --dev/--prod.",
  },
  args: {
    service: {
      type: "positional",
      required: false,
      description: `${SERVICES.join(" | ")} | all (default: daemon only)`,
    },
  },
  async run({ args, rawArgs }) {
    for (const a of rawArgs) {
      if (a === "--dev" || a === "--prod") {
        console.error(
          pc.red(`restart does not accept ${a} — it preserves the current mode.`),
        );
        console.error(
          `To switch modes: friday stop <svc> && friday start <svc>${a === "--dev" ? " --dev" : ""}`,
        );
        process.exit(1);
      }
    }

    const target = (args.service as string | undefined)?.toLowerCase();
    // The historical default was "all services". In dev that bounces vite,
    // and vite's HMR client triggers a full browser reload on reconnect —
    // which throws away any unsent chat draft, scroll position, and stream
    // state for what is in practice almost always a "restart the daemon"
    // request. Default to daemon-only; `friday restart all` keeps the old
    // behavior for the rare case the user actually wants everything bounced.
    const services: ServiceName[] =
      !target
        ? ["daemon"]
        : target === "all"
          ? [...SERVICES]
          : validateService(target)
            ? [target as ServiceName]
            : ((): ServiceName[] => {
                console.error(
                  pc.red(`unknown service: ${target}`) +
                    ` (expected: ${SERVICES.join(" | ")} | all)`,
                );
                process.exit(1);
              })();

    const self = fileURLToPath(import.meta.url).replace(
      /restart\.[jt]s$/,
      "../index.js",
    );

    for (const svc of services) {
      const mode = detectMode(svc);
      if (!mode) {
        console.error(
          pc.red(`${svc}: cannot determine mode (not running, no state).`),
        );
        console.error(`  start it: ${pc.cyan(`friday start ${svc} [--dev]`)}`);
        continue;
      }
      console.log(pc.dim(`restarting ${svc} in ${mode} mode`));
      spawnSync("node", [self, "stop", svc], { stdio: "inherit" });
      spawnSync(
        "node",
        [self, "start", svc, ...(mode === "dev" ? ["--dev"] : [])],
        { stdio: "inherit" },
      );
    }
  },
});

function validateService(s: string): s is ServiceName {
  return (SERVICES as readonly string[]).includes(s);
}

function detectMode(service: ServiceName): ServiceMode | null {
  const state = readState(service);
  if (state?.mode === "dev" || state?.mode === "prod") return state.mode;

  const session = tmuxSessionFor(service);
  if (hasSession(session)) {
    const cmd = paneCommand(session).toLowerCase();
    if (cmd.includes("tsx") || cmd.includes("vite") || cmd.includes("pnpm")) {
      return "dev";
    }
    if (cmd.includes("node")) return "prod";
  }
  return null;
}
