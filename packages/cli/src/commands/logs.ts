import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { getLogPath, SERVICES } from "@friday/shared";

export const logsCommand = defineCommand({
  meta: {
    name: "logs",
    description: `Tail logs (${SERVICES.join("|")})`,
  },
  args: {
    service: {
      type: "positional",
      required: false,
      description: `${SERVICES.join(" | ")} (default: daemon)`,
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
