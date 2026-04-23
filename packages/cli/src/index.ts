#!/usr/bin/env node
import { showHelp, hasHelpFlag } from "./help.js";
import { usageCommand } from "./commands/usage.js";
import { configCommand } from "./commands/config.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { restartCommand } from "./commands/restart.js";
import { statusCommand } from "./commands/status.js";
import { devCommand } from "./commands/dev.js";

const args = process.argv.slice(2);
const command = args[0];
const commandArgs = args.slice(1);

// Top-level help (only when no command, or explicit help/--help as the command itself)
if (!command || command === "help" || command === "--help" || command === "-h") {
  showHelp("main");
  process.exit(0);
}

// Route commands
switch (command) {
  case "usage":
    if (hasHelpFlag(commandArgs)) { showHelp("usage"); break; }
    usageCommand(commandArgs);
    break;

  case "config":
    if (hasHelpFlag(commandArgs)) { showHelp("config"); break; }
    configCommand(commandArgs);
    break;

  case "start":
    if (hasHelpFlag(commandArgs)) { showHelp("start"); break; }
    startCommand(commandArgs);
    break;

  case "stop":
    if (hasHelpFlag(commandArgs)) { showHelp("stop"); break; }
    stopCommand(commandArgs);
    break;

  case "restart":
    if (hasHelpFlag(commandArgs)) { showHelp("restart"); break; }
    restartCommand(commandArgs);
    break;

  case "status":
    if (hasHelpFlag(commandArgs)) { showHelp("status"); break; }
    statusCommand();
    break;

  case "dev":
    if (hasHelpFlag(commandArgs)) { showHelp("dev"); break; }
    devCommand(commandArgs);
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.error();
    showHelp("main");
    process.exit(1);
}
