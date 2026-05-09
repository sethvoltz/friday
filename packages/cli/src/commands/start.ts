import { defineCommand } from "citty";
import pc from "picocolors";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import {
  loadConfig,
  type ServiceName,
  SERVICES,
} from "@friday/shared";
import {
  hasSession,
  newSession,
  tmuxAvailable,
} from "../lib/tmux.js";
import {
  tmuxSessionFor,
  writeState,
  type ServiceMode,
} from "../lib/state.js";

interface ServiceSpec {
  cwd: string;
  prodCmd: string;
  devCmd: string;
}

function specs(repoRoot: string, dashboardPort: number): Record<ServiceName, ServiceSpec> {
  return {
    daemon: {
      cwd: join(repoRoot, "services", "daemon"),
      prodCmd: "node dist/index.js",
      devCmd: "exec pnpm exec tsx watch src/index.ts",
    },
    dashboard: {
      cwd: join(repoRoot, "services", "dashboard"),
      prodCmd: "node build/index.js",
      devCmd: `exec pnpm exec vite dev --port ${dashboardPort}`,
    },
  };
}

function startService(
  service: ServiceName,
  spec: ServiceSpec,
  mode: ServiceMode,
): { started: boolean; sessionName: string } {
  const sessionName = tmuxSessionFor(service);
  if (hasSession(sessionName)) {
    return { started: false, sessionName };
  }
  const cmd = mode === "dev" ? spec.devCmd : spec.prodCmd;
  newSession(sessionName, cmd, spec.cwd);
  writeState({
    service,
    mode,
    tmuxSession: sessionName,
    startedAt: new Date().toISOString(),
  });
  return { started: true, sessionName };
}

export const startCommand = defineCommand({
  meta: {
    name: "start",
    description:
      "Start a service in its own tmux session. `start` (no arg) starts both daemon + dashboard.",
  },
  args: {
    service: {
      type: "positional",
      required: false,
      description: "daemon | dashboard (default: both)",
    },
    dev: {
      type: "boolean",
      description: "Dev mode (tsx watch + vite dev with hot reload)",
      default: false,
    },
  },
  async run({ args }) {
    if (!tmuxAvailable()) {
      console.error(pc.red("tmux not found. `brew install tmux`"));
      process.exit(1);
    }

    const cfg = loadConfig();
    const repoRoot = findRepoRoot();
    const all = specs(repoRoot, cfg.dashboardPort);
    const mode: ServiceMode = args.dev ? "dev" : "prod";

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

    console.log(pc.green(`starting ${services.join(" + ")} in ${mode} mode`));
    for (const svc of services) {
      const r = startService(svc, all[svc], mode);
      if (r.started) {
        console.log(
          `  ${pc.green("✓")} ${svc.padEnd(10)} → tmux session ${pc.cyan(r.sessionName)}`,
        );
      } else {
        console.log(
          `  ${pc.yellow("·")} ${svc.padEnd(10)} already running (${r.sessionName})`,
        );
      }
    }

    console.log();
    console.log(pc.dim(`  daemon API     http://localhost:${cfg.daemonPort}`));
    console.log(pc.dim(`  dashboard      http://localhost:${cfg.dashboardPort}`));
    console.log(pc.dim(`  attach with:   friday attach <service>`));
  },
});

function validateService(s: string): s is ServiceName {
  return s === "daemon" || s === "dashboard";
}

function findRepoRoot(): string {
  let cur = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(cur, "pnpm-workspace.yaml"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return process.cwd();
}
