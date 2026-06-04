/**
 * Constructs the per-worker MCP server set given the caller's identity.
 * Called inside a forked worker process — never on the parent — because
 * `McpSdkServerConfigWithInstance` carries a live `McpServer` instance that
 * cannot cross the IPC boundary.
 *
 * Hard-gates which servers/tools each agent type sees. The model receives
 * tools as `mcp__<server-name>__<tool-name>`.
 */

import type { AgentType, ManifestMcpServer, McpServerConfig } from "@friday/shared";
import type {
  McpSdkServerConfigWithInstance,
  McpStdioServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { accessSync, constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { logger } from "../log.js";
import { getResolvedShellEnv } from "../shell-env.js";
import { buildAppsServer, APPS_SERVER_NAME } from "./apps.js";
import { buildEchoServer, ECHO_SERVER_NAME } from "./echo.js";
import { buildMailServer, MAIL_SERVER_NAME } from "./mail.js";
import { buildAgentsServer, AGENTS_SERVER_NAME } from "./agents.js";
import { buildMemoryServer, MEMORY_SERVER_NAME } from "./memory.js";
import { buildTicketsServer, TICKETS_SERVER_NAME } from "./tickets.js";
import { buildScheduleServer, SCHEDULE_SERVER_NAME } from "./schedule.js";
import { buildReminderServer, REMINDER_SERVER_NAME } from "./reminder.js";
import { buildEvolveServer, EVOLVE_SERVER_NAME } from "./evolve.js";
import { buildIntegrationsServer, INTEGRATIONS_SERVER_NAME } from "./integrations.js";

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
  /**
   * FRI-78: per-app context. Set by the spawn site when the caller agent
   * belongs to an installed app. The wiring loop appends each declared
   * stdio MCP server with `cwd = appContext.folderPath` and substitutes
   * `${VAR}` references in `env` from the app's `.env`. Per-app servers
   * are visible only to the app's own agents; the orchestrator (which has
   * no `appId`, so no `appContext`) never sees them.
   */
  appContext?: {
    appId: string;
    folderPath: string;
    mcpServers: ManifestMcpServer[];
    /** Parsed `.env` contents, when the app folder has one. */
    envFile?: Record<string, string>;
  };
}

export type AssembledMcpServers = Record<
  string,
  McpSdkServerConfigWithInstance | McpStdioServerConfig
>;

export function buildMcpServers(opts: BuildMcpServersOptions): AssembledMcpServers {
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

  // agent_create / agent_list / agent_archive / etc.: orchestrator + builder +
  // helper (ADR-022). The daemon-side guard at POST /api/agents enforces the
  // structural rule that only the orchestrator can spawn Builders, and that
  // builders/helpers must supply a non-empty `reason`. `bare` and `scheduled`
  // stay excluded — they don't manage sub-agents.
  if (
    opts.callerType === "orchestrator" ||
    opts.callerType === "builder" ||
    opts.callerType === "helper"
  ) {
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

  // friday-reminder: ALL caller types. Reminders are user-facing chat
  // nudges that fire without waking any agent; an app sub-agent (e.g. the
  // kitchen agent) must be able to set one. Contrast friday-schedule, which
  // is orchestrator-only.
  servers[REMINDER_SERVER_NAME] = buildReminderServer(ctx);

  // friday-evolve: orchestrator only. Sub-agents shouldn't be applying or
  // dismissing proposals — the meta-agent surfaces them via the orchestrator.
  if (opts.callerType === "orchestrator") {
    servers[EVOLVE_SERVER_NAME] = buildEvolveServer(ctx);
  }

  // friday-apps: orchestrator only. App install/uninstall/reload + listing.
  // Sub-agents under an app can't pull the rug out from under themselves.
  if (opts.callerType === "orchestrator") {
    servers[APPS_SERVER_NAME] = buildAppsServer(ctx);
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
      command: resolveStdioCommand("npx"),
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
      env: shellEnvForStdio(),
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
    const inScope = !s.scope || s.scope.length === 0 || s.scope.includes(opts.callerType);
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
      command: resolveStdioCommand(s.command),
      args: s.args ?? [],
      // FRI-150: thread the daemon's captured shell env into per-server
      // `env`; manifest entries still win on top via spread order. The
      // SDK then merges `{...allowlist, ...config.env}`, so the manifest
      // and captured env both supersede the allowlist filter.
      env: { ...shellEnvForStdio(), ...(s.env ?? {}) },
    };
  }

  // FRI-78: per-app stdio MCP servers. Only visible to the declaring
  // app's agents; the orchestrator never has `appContext` set. Resolved
  // relative to `appContext.folderPath`, with `${VAR}` substitution from
  // the app's own `.env`.
  if (opts.appContext) {
    const { appId, folderPath, mcpServers, envFile } = opts.appContext;
    for (const srv of mcpServers) {
      if (srv.name.startsWith("friday-") || RESERVED_NAMES.has(srv.name)) {
        logger.log("warn", "mcp.app.shadows-builtin", {
          name: srv.name,
          appId,
          callerName: opts.callerName,
        });
        continue;
      }
      if (servers[srv.name]) {
        logger.log("warn", "mcp.app.name-collision", {
          name: srv.name,
          appId,
          callerName: opts.callerName,
        });
        continue;
      }
      const resolvedArgs = srv.args.map((a) =>
        isLikelyAppPath(a) && !isAbsolute(a) ? join(folderPath, a) : a,
      );
      // FRI-36: the SDK's `McpStdioServerConfig` type doesn't declare `cwd`,
      // so any value we set is silently dropped and the spawned MCP inherits
      // the daemon's cwd. Apps must read their folder from `FRIDAY_APP_DIR`
      // (injected after manifest substitution so a manifest can't shadow it).
      // The `cwd` field below is kept as a forward-compatible hint in case
      // the SDK ever grows the field; it is a no-op today.
      servers[srv.name] = {
        type: "stdio",
        command: resolveStdioCommand(srv.command),
        args: resolvedArgs,
        // FRI-150: captured shell env carries the user's PATH + toolchain
        // (FNM_DIR, NVM_DIR, …) into the spawned MCP child. Manifest env
        // (after ${VAR} substitution) wins via the spread order, and
        // FRIDAY_APP_DIR is still injected last so a manifest can't
        // shadow it (FRI-36).
        env: {
          ...shellEnvForStdio(),
          ...substituteEnv(srv.env ?? {}, envFile ?? {}),
          FRIDAY_APP_DIR: folderPath,
        },
        cwd: folderPath,
      } as McpStdioServerConfig;
    }
  }

  return servers;
}

function isLikelyAppPath(arg: string): boolean {
  if (arg.startsWith("-")) return false;
  return arg.includes("/") || /\.(m?js|cjs|ts)$/i.test(arg);
}

/**
 * Substitute `${VAR}` references in env values from the app's `.env` (with
 * `process.env` as a fallback). Unmatched references collapse to empty
 * string — a missing-secret bug surfaces as "tool can't authenticate"
 * rather than a crash at spawn time.
 */
function substituteEnv(
  env: Record<string, string>,
  envFile: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
      return envFile[name] ?? process.env[name] ?? "";
    });
  }
  return out;
}

/**
 * FRI-150: rewrite `node` / `npx` to the daemon's pinned-Node absolute
 * paths so a clean-install MCP child (no brew Node, no globally-resolvable
 * `npx`) still spawns. `process.execPath` is the fnm-resolved pinned Node
 * we're running under (per FRI-146 supervisor shim); its sibling `npx`
 * ships with the same Node install. If the sibling is missing (some
 * exotic Node install), we pass `npx` through bare — the per-server env
 * merge above carries the captured shell PATH, so the SDK's
 * `cross-spawn` can still find it via PATH lookup.
 *
 * User-supplied absolute paths in manifests (anything not literally
 * `node` or `npx`) are untouched.
 */
export function resolveStdioCommand(command: string): string {
  if (command === "node") return process.execPath;
  if (command === "npx") {
    const sibling = join(dirname(process.execPath), "npx");
    // NIT-4: `existsSync` is not enough — a `.npx` placeholder file or a
    // non-executable script would pass it and then ENOEXEC at spawn time.
    // `accessSync(…, X_OK)` confirms the kernel will let us execute it.
    try {
      accessSync(sibling, fsConstants.X_OK);
      return sibling;
    } catch {
      return command;
    }
  }
  return command;
}

/**
 * FRI-150: return the captured shell env (PATH, FNM_DIR, NVM_DIR, …) for
 * use as the per-server stdio `env` base. The SDK does
 * `{...getDefaultEnvironment(), ...config.env}`, so spreading this here
 * means our captured env wholesale supersedes the SDK's HOME/PATH/SHELL/
 * LOGNAME/TERM/USER allowlist filter
 * (`@modelcontextprotocol/sdk@1.29.0/dist/esm/client/stdio.js:8-24`).
 */
function shellEnvForStdio(): Record<string, string> {
  return getResolvedShellEnv().env;
}

export const BROWSER_SERVER_NAME = "playwright";

/** Names that user config cannot use (built-in stdio MCPs). The `friday-`
 * prefix check covers all in-process built-ins separately. */
const RESERVED_NAMES = new Set<string>([BROWSER_SERVER_NAME]);
