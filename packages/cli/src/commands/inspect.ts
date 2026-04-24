import { readFileSync, existsSync } from "node:fs";
import {
  AGENTS_PATH,
  loadConfig,
  resolveTranscriptPath,
  buildInspectResult,
  formatInspectPlain,
  tailTranscript,
  formatTurn,
  type AgentRegistry,
  type RegistryEntry,
} from "@friday/shared";

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function loadRegistry(): AgentRegistry {
  if (!existsSync(AGENTS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(AGENTS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function getCwdOverride(entry: RegistryEntry): string | undefined {
  if (entry.type === "orchestrator") {
    const config = loadConfig();
    return config.agent.workingDirectory;
  }
  return undefined;
}

export async function inspectCommand(args: string[]): Promise<void> {
  const agentName = args.find((a) => !a.startsWith("-"));
  if (!agentName) {
    console.error("Usage: friday inspect <agent-name> [--turns N] [--full] [--follow] [--tools]");
    process.exit(1);
  }

  const registry = loadRegistry();
  const entry = registry[agentName];
  if (!entry) {
    const names = Object.keys(registry);
    console.error(`Agent "${agentName}" not found.`);
    if (names.length > 0) {
      console.error(`Available agents: ${names.join(", ")}`);
    }
    process.exit(1);
  }

  const cwdOverride = getCwdOverride(entry);
  const turnsFlag = flagValue(args, "--turns");
  const lastN = turnsFlag ? parseInt(turnsFlag, 10) : 5;
  const full = args.includes("--full");
  const follow = args.includes("--follow") || args.includes("-f");
  const includeTools = !args.includes("--no-tools");

  if (follow) {
    const jsonlPath = resolveTranscriptPath(entry, cwdOverride);
    if (!jsonlPath) {
      console.error(`Cannot resolve transcript path for "${agentName}".`);
      process.exit(1);
    }

    console.log(`Tailing ${agentName} (${entry.type}) — Ctrl-C to stop\n`);

    const handle = tailTranscript(jsonlPath, {
      onEntry: () => {},
      onTurn: (turn) => {
        console.log(formatTurn(turn, { includeTools }));
        console.log();
      },
    });

    // Block until Ctrl-C
    process.on("SIGINT", () => {
      handle.stop();
      process.exit(0);
    });

    // Keep the process alive
    await new Promise(() => {});
    return;
  }

  const result = await buildInspectResult(agentName, entry, {
    lastN,
    full,
    includeTools,
    cwdOverride,
  });

  console.log(formatInspectPlain(result, { includeTools }));
}
