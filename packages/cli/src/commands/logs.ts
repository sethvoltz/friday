import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getLogPath } from "@friday/shared";

export const logsCommand = defineCommand({
  meta: { name: "logs", description: "Tail logs (daemon|dashboard)" },
  args: {
    service: {
      type: "positional",
      required: false,
      description: "daemon | dashboard (default: daemon)",
    },
    follow: { type: "boolean", alias: "f", default: false },
  },
  run({ args }) {
    const svc = (args.service as string) ?? "daemon";
    const path = getLogPath(svc);
    if (!existsSync(path)) {
      console.error(`no log at ${path}`);
      process.exit(1);
    }
    const tailArgs = args.follow ? ["-f", path] : [path];
    spawnSync("tail", tailArgs, { stdio: "inherit" });
  },
});
