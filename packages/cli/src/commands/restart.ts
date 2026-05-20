import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { SERVICES, type ServiceName } from "@friday/shared";

export const restartCommand = defineCommand({
  meta: {
    name: "restart",
    description:
      "Restart one service (or `all`). A target is required — there's no default.",
  },
  args: {
    service: {
      type: "positional",
      required: false,
      description: `${SERVICES.join(" | ")} | all (required)`,
    },
  },
  async run({ args }) {
    const target = (args.service as string | undefined)?.toLowerCase();
    // No silent default. Bouncing every service was a footgun (vite HMR
    // reloads the browser tab); silently restarting just the daemon would
    // surprise users who expected the old behavior. Force an explicit
    // target so the user always knows what they're restarting.
    if (!target) {
      console.error(pc.red("friday restart: a target is required."));
      console.error(
        `  usage: ${pc.cyan(`friday restart <${SERVICES.join("|")}|all>`)}`,
      );
      console.error(`    daemon     — restart just the API daemon`);
      console.error(`    dashboard  — restart just the SvelteKit dashboard`);
      console.error(`    zero-cache — restart just the Zero sync sidecar`);
      console.error(`    tunnel     — restart just the Cloudflare Tunnel`);
      console.error(`    all        — restart every running service`);
      process.exit(1);
    }
    const services: ServiceName[] =
      target === "all"
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
      console.log(pc.dim(`restarting ${svc}`));
      spawnSync("node", [self, "stop", svc], { stdio: "inherit" });
      spawnSync("node", [self, "start", svc], { stdio: "inherit" });
    }
  },
});

function validateService(s: string): s is ServiceName {
  return (SERVICES as readonly string[]).includes(s);
}
