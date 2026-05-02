import { spawnSync } from "node:child_process";
import { defineCommand } from "citty";
import { SERVICES, parseServiceArg, type ServiceName } from "../services.js";
import { readState } from "../state.js";
import { hasSession, hasTmuxAvailable, isPaneDead } from "../tmux.js";

export const attachCommandCitty = defineCommand({
  meta: {
    name: "attach",
    description:
      "Attach to a dev-mode service's tmux session. Detach with the standard tmux prefix + d (Ctrl-b d). Errors if the service is in prod mode — use 'friday logs <service> -f' instead.",
  },
  args: {
    service: {
      type: "positional",
      required: true,
      description: "daemon | dashboard",
    },
  },
  run({ args }) {
    const argv: string[] = [];
    if (typeof args.service === "string") argv.push(args.service);
    attachCommand(argv);
  },
});

export function attachCommand(args: string[]): void {
  const target = parseServiceArg(args[0]);
  if (target === "all") {
    console.error("Specify a single service to attach to (daemon or dashboard).");
    process.exit(1);
  }

  const service: ServiceName = target;
  const info = SERVICES[service];
  const state = readState(service);

  if (!state) {
    console.error(`${info.label} is not running.`);
    console.error(`Start it with: friday start ${service} --dev`);
    process.exit(1);
  }

  if (state.mode !== "dev") {
    console.error(`${info.label} is running in prod mode (no tmux session to attach to).`);
    console.error(`To stream logs:        friday logs ${service} -f`);
    console.error(`To switch to dev mode: friday stop ${service} && friday start ${service} --dev`);
    process.exit(1);
  }

  const sessionName = state.tmuxSession ?? `friday-${service}`;
  if (!hasTmuxAvailable()) {
    console.error("tmux is not installed. Install via: brew bundle --file=Brewfile");
    process.exit(1);
  }
  if (!hasSession(sessionName)) {
    console.error(`tmux session ${sessionName} does not exist (state is stale).`);
    console.error(`Recover with: friday start ${service} --dev`);
    process.exit(1);
  }

  if (isPaneDead(sessionName)) {
    console.error(`Note: the dev process has exited. Attaching to inspect the post-mortem.`);
    console.error(`Press Ctrl-b d to detach, then \`friday restart ${service}\` to relaunch.`);
  }

  // Hand off to tmux. stdio: "inherit" so we get a real interactive session;
  // detach with the standard prefix + d (Ctrl-b d by default).
  const r = spawnSync("tmux", ["attach", "-t", sessionName], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}
