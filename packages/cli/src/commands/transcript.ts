import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { defineCommand } from "citty";
import {
  AGENTS_PATH,
  loadConfig,
  buildInspectResult,
  formatInspectMarkdown,
  type AgentRegistry,
  type RegistryEntry,
} from "@friday/shared";

export const transcriptCommandCitty = defineCommand({
  meta: {
    name: "transcript",
    description: "Export an agent's full transcript as markdown.",
  },
  args: {
    agent: {
      type: "positional",
      required: true,
      description: "Agent name",
    },
    output: {
      type: "string",
      alias: "o",
      description: "Write to file instead of stdout",
    },
  },
  async run({ args }) {
    const argv: string[] = [];
    if (typeof args.agent === "string") argv.push(args.agent);
    if (typeof args.output === "string" && args.output.length > 0) {
      argv.push("--output", args.output);
    }
    await transcriptCommand(argv);
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

export async function transcriptCommand(args: string[]): Promise<void> {
  const agentName = args.find((a) => !a.startsWith("-"));
  if (!agentName) {
    console.error("Usage: friday transcript <agent-name> [--output <file>]");
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
  const result = await buildInspectResult(agentName, entry, {
    full: true,
    includeTools: true,
    cwdOverride,
  });

  const markdown = formatInspectMarkdown(result);

  const outputFile = flagValue(args, "--output") ?? flagValue(args, "-o");
  if (outputFile) {
    writeFileSync(outputFile, markdown);
    console.log(`Transcript written to ${outputFile}`);
  } else {
    console.log(markdown);
  }
}
