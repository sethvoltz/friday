/**
 * Constructs the per-worker MCP server set given the caller's identity.
 * Called inside a forked worker process — never on the parent — because
 * `McpSdkServerConfigWithInstance` carries a live `McpServer` instance that
 * cannot cross the IPC boundary.
 *
 * Hard-gates which servers/tools each agent type sees. The model receives
 * tools as `mcp__<server-name>__<tool-name>`.
 */

import type { AgentType, McpServerConfig } from "@friday/shared";
import type {
  McpSdkServerConfigWithInstance,
  McpStdioServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../log.js";
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
  /**
   * User-configured stdio MCP servers (`~/.friday/config.json` → `mcpServers`).
   * Filtered by `scope` against `callerType`; entries whose name shadows a
   * built-in (`friday-*`) are rejected.
   */
  userMcpServers?: McpServerConfig[];
}

export type AssembledMcpServers = Record<
  string,
  McpSdkServerConfigWithInstance | McpStdioServerConfig
>;

export function buildMcpServers(
  opts: BuildMcpServersOptions,
): AssembledMcpServers {
  const servers: AssembledMcpServers = {};
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

  // agent_create / agent_list / agent_archive / etc.: orchestrator only.
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

  // friday-integrations: every non-archived agent type. Cross-system imports
  // and writes (Linear today; future GH Issues, Jira). Sub-agents need this
  // so a builder can file a Linear follow-up directly instead of routing
  // every external write through the orchestrator. Gracefully no-ops if the
  // relevant API key isn't set on the daemon.
  servers[INTEGRATIONS_SERVER_NAME] = buildIntegrationsServer(ctx);

  // playwright: built-in browser automation via Microsoft's @playwright/mcp.
  // Excluded for orchestrator to keep it responsive — long-running browser
  // calls belong in a spawned sub-agent. Headless + isolated so background
  // and parallel agents don't clobber each other (Chromium's SingletonLock
  // prevents shared profiles across processes anyway).
  if (opts.callerType !== "orchestrator") {
    servers[BROWSER_SERVER_NAME] = {
      type: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
      env: {},
    };
  }

  // User-configured stdio MCP servers from `~/.friday/config.json`. Each is
  // gated by its `scope` against the caller's agent type (no/empty scope =
  // all types). Reserved names (`friday-*` and built-ins like `playwright`)
  // are rejected to keep built-in tool namespaces clean. Malformed entries
  // are skipped, not thrown — a typo in config shouldn't break a worker.
  for (const s of opts.userMcpServers ?? []) {
    if (s.name.startsWith("friday-") || RESERVED_NAMES.has(s.name)) {
      logger.log("warn", "mcp.user.shadows-builtin", {
        name: s.name,
        callerType: opts.callerType,
        callerName: opts.callerName,
      });
      continue;
    }
    const inScope =
      !s.scope || s.scope.length === 0 || s.scope.includes(opts.callerType);
    if (!inScope) continue;
    if (!s.command) {
      logger.log("warn", "mcp.user.missing-command", {
        name: s.name,
        callerType: opts.callerType,
        callerName: opts.callerName,
      });
      continue;
    }
    servers[s.name] = {
      type: "stdio",
      command: s.command,
      args: s.args ?? [],
      env: s.env ?? {},
    };
  }

  return servers;
}

export const BROWSER_SERVER_NAME = "playwright";

/** Names that user config cannot use (built-in stdio MCPs). The `friday-`
 * prefix check covers all in-process built-ins separately. */
const RESERVED_NAMES = new Set<string>([BROWSER_SERVER_NAME]);
