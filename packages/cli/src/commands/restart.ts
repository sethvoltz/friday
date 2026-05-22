import { defineCommand } from "citty";
import pc from "picocolors";
import { spawnSync } from "node:child_process";

/**
 * `friday restart` — thin alias over `brew services restart friday`.
 *
 * launchd stops the supervisor (which cascade-stops every child's
 * process group — FRI-88 §0), waits for the process tree to settle,
 * then restarts the supervisor. The supervisor re-forks its three
 * children in order (daemon → zero-cache → dashboard) with the same
 * KeepAlive semantics as a cold boot.
 *
 * Single-service restarts error out — the whole-stack restart is the
 * v1 contract.
 */

export const restartCommand = defineCommand({
  meta: {
    name: "restart",
    description: "Restart Friday's prod stack (delegates to `brew services restart friday`).",
  },
  args: {
    service: {
      type: "positional",
      required: false,
      description: "(unused — single-service ops not supported under launchd supervision)",
    },
  },
  async run({ args }) {
    if (args.service) {
      console.error(pc.red(`single-service operations not supported under launchd supervision.`));
      console.error(`  ${pc.cyan("friday restart")} restarts the whole stack atomically.`);
      console.error(
        `  per-service IPC (e.g. ${pc.cyan("friday restart zero-cache")}) is an explicit follow-up ticket.`,
      );
      process.exit(1);
    }

    console.log(pc.dim("restarting friday stack via brew services"));
    const r = spawnSync("brew", ["services", "restart", "friday"], {
      stdio: "inherit",
    });
    if (r.status !== 0) process.exit(r.status ?? 1);
  },
});
