#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { setupCommand } from "./commands/setup.js";
import { doctorCommand } from "./commands/doctor.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { restartCommand } from "./commands/restart.js";
import { statusCommand } from "./commands/status.js";
import { logsCommand } from "./commands/logs.js";
import { attachCommand } from "./commands/attach.js";
import { agentsCommand } from "./commands/agents.js";
import { sessionsCommand } from "./commands/sessions.js";
import { mailCommand } from "./commands/mail.js";
import { ticketsCommand } from "./commands/tickets.js";
import { memoryCommand } from "./commands/memory.js";
import { evolveCommand } from "./commands/evolve.js";
import { schedulesCommand } from "./commands/schedules.js";

const main = defineCommand({
  meta: {
    name: "friday",
    version: "0.0.1",
    description: "Friday — local-first AI orchestrator",
  },
  subCommands: {
    setup: setupCommand,
    doctor: doctorCommand,
    start: startCommand,
    stop: stopCommand,
    restart: restartCommand,
    status: statusCommand,
    logs: logsCommand,
    attach: attachCommand,
    agents: agentsCommand,
    sessions: sessionsCommand,
    mail: mailCommand,
    tickets: ticketsCommand,
    memory: memoryCommand,
    evolve: evolveCommand,
    schedules: schedulesCommand,
  },
});

runMain(main);
