#!/usr/bin/env node
import { showHelp, hasHelpFlag } from "./help.js";
import { usageCommand } from "./commands/usage.js";
import { configCommand } from "./commands/config.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { restartCommand } from "./commands/restart.js";
import { statusCommand } from "./commands/status.js";
import { attachCommand } from "./commands/attach.js";
import { logsCommand } from "./commands/logs.js";
import { resetOrchestratorCommand } from "./commands/reset-orchestrator.js";
import { mailCommand } from "./commands/mail.js";
import { inspectCommand } from "./commands/inspect.js";
import { transcriptCommand } from "./commands/transcript.js";
import { doctorCommand } from "./commands/doctor.js";
import { setupCommand } from "./commands/setup.js";
import { scheduleCommand } from "./commands/schedule.js";
import { migratePidsToState } from "./migrate.js";

migratePidsToState();

const args = process.argv.slice(2);
const command = args[0];
const commandArgs = args.slice(1);

// Top-level help (only when no command, or explicit help/--help as the command itself)
if (!command || command === "help" || command === "--help" || command === "-h") {
  showHelp("main");
  process.exit(0);
}

// Route commands — async commands use .catch for top-level error handling
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
    statusCommand(commandArgs);
    break;

  case "attach":
    if (hasHelpFlag(commandArgs)) { showHelp("attach"); break; }
    attachCommand(commandArgs);
    break;

  case "logs":
    if (hasHelpFlag(commandArgs)) { showHelp("logs"); break; }
    logsCommand(commandArgs).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
    break;

  case "reset-orchestrator":
    if (hasHelpFlag(commandArgs)) { showHelp("reset-orchestrator"); break; }
    resetOrchestratorCommand();
    break;

  case "mail":
    if (hasHelpFlag(commandArgs)) { showHelp("mail"); break; }
    mailCommand(commandArgs);
    break;

  case "send":
    if (hasHelpFlag(commandArgs)) { showHelp("mail"); break; }
    mailCommand(["send", ...commandArgs]);
    break;

  case "inspect":
    if (hasHelpFlag(commandArgs)) { showHelp("inspect"); break; }
    inspectCommand(commandArgs).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
    break;

  case "transcript":
    if (hasHelpFlag(commandArgs)) { showHelp("transcript"); break; }
    transcriptCommand(commandArgs).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
    break;

  case "doctor":
    if (hasHelpFlag(commandArgs)) { showHelp("doctor"); break; }
    doctorCommand().catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
    break;

  case "setup":
    if (hasHelpFlag(commandArgs)) { showHelp("setup"); break; }
    setupCommand(commandArgs).catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
    break;

  case "schedule":
    if (hasHelpFlag(commandArgs)) { showHelp("schedule"); break; }
    scheduleCommand(commandArgs);
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.error();
    showHelp("main");
    process.exit(1);
}
