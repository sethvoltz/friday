import { readFileSync, existsSync } from "node:fs";
import { defineCommand } from "citty";
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

export const inspectCommandCitty = defineCommand({
  meta: {
    name: "inspect",
    description:
      "Inspect an agent's recent transcript. Shows the last N turns from the Claude Code session.",
  },
  args: {
    agent: {
      type: "positional",
      required: true,
      description: "Agent name",
    },
    turns: {
      type: "string",
      description: "Number of recent turns to show (default: 5)",
    },
    full: {
      type: "boolean",
      description: "Show the entire transcript",
      default: false,
    },
    follow: {
      type: "boolean",
      alias: "f",
      description: "Tail the transcript live",
      default: false,
    },
    "no-tools": {
      type: "boolean",
      description: "Hide tool call details",
      default: false,
    },
  },
  async run({ args }) {
    const argv: string[] = [];
    if (typeof args.agent === "string") argv.push(args.agent);
    if (typeof args.turns === "string" && args.turns.length > 0) {
      argv.push("--turns", args.turns);
    }
    if (args.full) argv.push("--full");
    if (args.follow) argv.push("--follow");
    if (args["no-tools"]) argv.push("--no-tools");
    await inspectCommand(argv);
  },
});

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
