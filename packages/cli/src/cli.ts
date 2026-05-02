import { defineCommand } from "citty";
import { migratePidsToState } from "./migrate.js";
import { statusCommandCitty } from "./commands/status.js";
import { usageCommandCitty } from "./commands/usage.js";
import { configCommandCitty } from "./commands/config.js";
import { startCommandCitty } from "./commands/start.js";
import { stopCommandCitty } from "./commands/stop.js";
import { restartCommandCitty } from "./commands/restart.js";
import { attachCommandCitty } from "./commands/attach.js";
import { logsCommandCitty } from "./commands/logs.js";
import { resetOrchestratorCommandCitty } from "./commands/reset-orchestrator.js";
import { inspectCommandCitty } from "./commands/inspect.js";
import { transcriptCommandCitty } from "./commands/transcript.js";
import { doctorCommandCitty } from "./commands/doctor.js";
import { setupCommandCitty } from "./commands/setup.js";
import { mailCommandCitty, mailSendCmd } from "./commands/mail.js";
import { scheduleCommandCitty } from "./commands/schedule.js";
import { evolveCommandCitty } from "./commands/evolve.js";
import { completionCommandCitty } from "./commands/completion.js";

export const cli = defineCommand({
  meta: {
    name: "friday",
    description: "CLI for the Friday Slack-to-Claude bridge",
  },
  setup() {
    migratePidsToState();
  },
  subCommands: {
    usage: usageCommandCitty,
    config: configCommandCitty,
    start: startCommandCitty,
    stop: stopCommandCitty,
    restart: restartCommandCitty,
    status: statusCommandCitty,
    attach: attachCommandCitty,
    logs: logsCommandCitty,
    "reset-orchestrator": resetOrchestratorCommandCitty,
    mail: mailCommandCitty,
    // `send` is a top-level shortcut for `mail send`. Reuses mailSendCmd's
    // arg schema and handler so help and parsing match exactly.
    send: mailSendCmd,
    inspect: inspectCommandCitty,
    transcript: transcriptCommandCitty,
    doctor: doctorCommandCitty,
    setup: setupCommandCitty,
    schedule: scheduleCommandCitty,
    evolve: evolveCommandCitty,
    completion: completionCommandCitty,
  },
});

export default cli;
