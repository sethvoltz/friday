import { existsSync } from "node:fs";
import { defineCommand } from "citty";
import { loadConfig, CONFIG_PATH } from "@friday/shared";

export const configCommandCitty = defineCommand({
  meta: {
    name: "config",
    description: "Print current configuration (~/.friday/config.json merged with defaults).",
  },
  args: {
    validate: {
      type: "boolean",
      description: "Validate config and report issues",
      default: false,
    },
    path: {
      type: "boolean",
      description: "Print config file path only",
      default: false,
    },
  },
  run({ args }) {
    const argv: string[] = [];
    if (args.validate) argv.push("--validate");
    if (args.path) argv.push("--path");
    configCommand(argv);
  },
});

export function configCommand(args: string[]): void {
  if (args.includes("--path")) {
    console.log(CONFIG_PATH);
    return;
  }

  const exists = existsSync(CONFIG_PATH);

  if (args.includes("--validate")) {
    validateConfig(exists);
    return;
  }

  if (!exists) {
    console.log(`No config file found at ${CONFIG_PATH}`);
    console.log("Using default configuration:\n");
  } else {
    console.log(`Config: ${CONFIG_PATH}\n`);
  }

  const config = loadConfig();
  console.log(JSON.stringify(config, null, 2));
}

function validateConfig(exists: boolean): void {
  const issues: string[] = [];
  const warnings: string[] = [];

  if (!exists) {
    warnings.push(`No config file at ${CONFIG_PATH} — using defaults`);
  }

  const config = loadConfig();

  if (!config.slack.orchestratorChannelId) {
    issues.push("slack.orchestratorChannelId is not set");
  }

  if (!config.agent.workingDirectory) {
    issues.push("agent.workingDirectory is not set");
  } else if (!existsSync(config.agent.workingDirectory)) {
    warnings.push(`agent.workingDirectory does not exist: ${config.agent.workingDirectory}`);
  }

  if (!config.agent.model) {
    issues.push("agent.model is not set");
  }

  if (issues.length === 0 && warnings.length === 0) {
    console.log("Config is valid.");
    return;
  }

  if (issues.length > 0) {
    console.log("Issues:");
    for (const issue of issues) {
      console.log(`  \u2717 ${issue}`);
    }
  }

  if (warnings.length > 0) {
    console.log("Warnings:");
    for (const w of warnings) {
      console.log(`  ! ${w}`);
    }
  }

  if (issues.length > 0) {
    process.exit(1);
  }
}
