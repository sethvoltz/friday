import pc from "picocolors";

export const BANNER = pc.cyan(`
     ▄▄                              ▄▄▄▄▄▄▄
   ▄█▀▀█▄                     █▄    █▀██▀▀▀          █▄
   ██  ██      ▄▄       ▄    ▄██▄     ██  ▄    ▀▀    ██
   ██▀▀██   ▄████ ▄█▀█▄ ████▄ ██      ███▀████▄██ ▄████ ▄▀▀█▄ ██ ██
 ▄ ██  ██   ██ ██ ██▄█▀ ██ ██ ██    ▄ ██  ██   ██ ██ ██ ▄█▀██ ██▄██
 ▀██▀  ▀█▄█▄▀████▄▀█▄▄▄▄██ ▀█▄██    ▀██▀ ▄█▀  ▄██▄█▀███▄▀█▄██▄▄▀██▀
               ██                                               ██
             ▀▀▀                                              ▀▀▀
`);

export const dim = pc.dim;
export const cyan = pc.cyan;
export const green = pc.green;
export const yellow = pc.yellow;
export const red = pc.red;
export const bold = pc.bold;

/**
 * Static manifest of subcommands for completion generation. Kept hand-maintained
 * (not generated from the citty tree) so completion never triggers lazy imports
 * at Tab-time.
 */
export const COMPLETION_MANIFEST: { name: string; subs?: string[] }[] = [
  { name: "usage" },
  { name: "config" },
  { name: "start", subs: ["daemon", "dashboard"] },
  { name: "stop", subs: ["daemon", "dashboard"] },
  { name: "restart", subs: ["daemon", "dashboard"] },
  { name: "status" },
  { name: "attach", subs: ["daemon", "dashboard"] },
  { name: "logs", subs: ["daemon", "dashboard"] },
  { name: "reset-orchestrator" },
  { name: "mail", subs: ["list", "read", "send"] },
  { name: "send" },
  { name: "inspect" },
  { name: "transcript" },
  { name: "doctor" },
  { name: "setup" },
  { name: "schedule", subs: ["list", "create", "pause", "resume", "trigger", "delete"] },
  { name: "evolve", subs: ["scan", "enrich", "cluster", "list", "show"] },
  { name: "completion", subs: ["zsh", "bash"] },
];
