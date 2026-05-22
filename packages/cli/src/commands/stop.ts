import { defineCommand } from "citty";
import pc from "picocolors";
import { spawnSync } from "node:child_process";

/**
 * `friday stop` — thin alias over `brew services stop friday`.
 *
 * launchd + the supervisor handle cascade-stop (FRI-88 §0 design
 * constraint): SIGTERM to the supervisor signals every child's process
 * group, catching grandchildren. No more zombie zero-cache workers
 * after `friday stop` — that was the FRI-83 failure mode this entire
 * supervision rework exists to close.
 *
 * Single-service stops error out — the supervisor owns the whole stack.
 */

export const stopCommand = defineCommand({
  meta: {
    name: "stop",
    description: "Stop Friday's prod stack (delegates to `brew services stop friday`).",
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
      console.error(`  ${pc.cyan("friday stop")} stops the whole stack atomically.`);
      process.exit(1);
    }

    console.log(pc.dim("stopping friday stack via brew services"));
    const r = spawnSync("brew", ["services", "stop", "friday"], {
      stdio: "inherit",
    });
    if (r.status !== 0) process.exit(r.status ?? 1);
    // Don't auto-stop cloudflared — it's a separate user launch agent
    // (`com.cloudflare.cloudflared`) installed by `friday setup --cloudflare`.
    // Operators tear it down with `cloudflared service uninstall` when they
    // actually want the tunnel gone, not on every `friday stop`.
  },
});
