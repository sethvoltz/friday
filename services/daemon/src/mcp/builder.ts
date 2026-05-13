/**
 * Constructs the per-worker MCP server set given the caller's identity.
 * Called inside a forked worker process — never on the parent — because
 * `McpSdkServerConfigWithInstance` carries a live `McpServer` instance that
 * cannot cross the IPC boundary.
 *
 * Hard-gates which servers/tools each agent type sees. The model receives
 * tools as `mcp__<server-name>__<tool-name>`.
 */

import type { AgentType } from "@friday/shared";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { buildEchoServer, ECHO_SERVER_NAME } from "./echo.js";
import { buildMailServer, MAIL_SERVER_NAME } from "./mail.js";
import { buildAgentsServer, AGENTS_SERVER_NAME } from "./agents.js";
import { buildMemoryServer, MEMORY_SERVER_NAME } from "./memory.js";
import { buildTicketsServer, TICKETS_SERVER_NAME } from "./tickets.js";
import { buildScheduleServer, SCHEDULE_SERVER_NAME } from "./schedule.js";
import { buildEvolveServer, EVOLVE_SERVER_NAME } from "./evolve.js";
import {
  buildIntegrationsServer,
  INTEGRATIONS_SERVER_NAME,
} from "./integrations.js";

export interface BuildMcpServersOptions {
  callerType: AgentType;
  callerName: string;
  daemonPort: number;
  parentName?: string;
}

export function buildMcpServers(
  opts: BuildMcpServersOptions,
): Record<string, McpSdkServerConfigWithInstance> {
  const servers: Record<string, McpSdkServerConfigWithInstance> = {};
  const ctx = {
    callerName: opts.callerName,
    callerType: opts.callerType,
    daemonPort: opts.daemonPort,
  };

  // Echo stays for now as a sanity check; remove once the rest of the surface
  // is reliable.
  servers[ECHO_SERVER_NAME] = buildEchoServer();

  // Every agent type can send/receive mail. Mail is the universal delivery
  // primitive (FIX_FORWARD 2.1/2.2); there is no separate `chat_reply` tool.
  servers[MAIL_SERVER_NAME] = buildMailServer(ctx);

  // agent_create / agent_list / agent_kill / etc.: orchestrator only.
  // Builder/helper/bare/scheduled don't see agent_* tools at all.
  if (opts.callerType === "orchestrator") {
    servers[AGENTS_SERVER_NAME] = buildAgentsServer({
      callerName: opts.callerName,
      callerType: opts.callerType,
      daemonPort: opts.daemonPort,
      parentName: opts.parentName,
    });
  }

  // friday-memory: every caller. Builders get a read-only filtered subset
  // (handled inside buildMemoryServer based on callerType).
  servers[MEMORY_SERVER_NAME] = buildMemoryServer(ctx);

  // friday-tickets: orchestrator, builder, helper. Bare and scheduled don't
  // touch tickets directly.
  if (
    opts.callerType === "orchestrator" ||
    opts.callerType === "builder" ||
    opts.callerType === "helper"
  ) {
    servers[TICKETS_SERVER_NAME] = buildTicketsServer(ctx);
  }

  // friday-schedule: orchestrator only.
  if (opts.callerType === "orchestrator") {
    servers[SCHEDULE_SERVER_NAME] = buildScheduleServer(ctx);
  }

  // friday-evolve: orchestrator only. Sub-agents shouldn't be applying or
  // dismissing proposals — the meta-agent surfaces them via the orchestrator.
  if (opts.callerType === "orchestrator") {
    servers[EVOLVE_SERVER_NAME] = buildEvolveServer(ctx);
  }

  // friday-integrations: orchestrator only. Cross-system imports (Linear
  // today; future GH Issues, Jira). Gracefully no-ops if the relevant API
  // key isn't set on the daemon.
  if (opts.callerType === "orchestrator") {
    servers[INTEGRATIONS_SERVER_NAME] = buildIntegrationsServer(ctx);
  }

  return servers;
}
