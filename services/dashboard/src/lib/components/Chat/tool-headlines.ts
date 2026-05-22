// Synthesize a one-line headline for a tool card when `input.description`
// is not provided. Falls back to `undefined` so the caller can render the
// tool name as a last resort.

export interface SynthesizeOpts {
  homeDir?: string | null;
  dataDir?: string | null;
}

export function aliasPath(p: string, homeDir?: string | null, dataDir?: string | null): string {
  if (!p) return p;
  if (dataDir) {
    const wsPrefix = dataDir + "/workspaces/";
    if (p.startsWith(wsPrefix)) return "@workspaces/" + p.slice(wsPrefix.length);
    const appsPrefix = dataDir + "/apps/";
    if (p.startsWith(appsPrefix)) return "@apps/" + p.slice(appsPrefix.length);
  }
  if (homeDir && (p === homeDir || p.startsWith(homeDir + "/"))) {
    const rest = p.slice(homeDir.length);
    return "~" + rest;
  }
  return p;
}

function trunc(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const FRIDAY_MCP_FRIENDLY: Record<string, string> = {
  agent_status: "Agent status",
  agent_list: "List agents",
  agent_inspect: "Inspect agent",
  agent_create: "Create agent",
  agent_archive: "Archive agent",
  linear_import: "Import from Linear",
  linear_create_issue: "Create Linear issue",
  linear_update_issue: "Update Linear issue",
  linear_reconcile: "Reconcile Linear",
  linear_create_relation: "Link Linear issues",
  app_list: "List apps",
  app_inspect: "Inspect app",
  app_install: "Install app",
  app_reload: "Reload app",
  app_uninstall: "Uninstall app",
  evolve_list: "List proposals",
  evolve_get: "Get proposal",
  evolve_save: "Save proposal",
  evolve_update: "Update proposal",
  evolve_apply: "Apply proposal",
  evolve_dismiss: "Dismiss proposal",
  evolve_scan: "Scan for proposals",
  evolve_enrich: "Enrich proposals",
  evolve_cluster: "Cluster proposals",
  echo: "Echo",
};

export function friendlyToolName(toolName: string): string {
  const fridayMatch = /^mcp__friday-[^_]+__(.+)$/.exec(toolName);
  if (fridayMatch) {
    const short = fridayMatch[1];
    if (FRIDAY_MCP_FRIENDLY[short]) return FRIDAY_MCP_FRIENDLY[short];
    return short;
  }
  const mcpMatch = /^mcp__[^_]+__(.+)$/.exec(toolName);
  if (mcpMatch) return mcpMatch[1];
  return toolName;
}

const SCHEDULE_VERBS: Record<string, string> = {
  create: "Creating",
  delete: "Deleting",
  list: "Listing",
  update: "Updating",
  run: "Running",
  get: "Getting",
};
const EVOLVE_VERBS: Record<string, string> = {
  propose: "Proposing",
  accept: "Accepting",
  reject: "Rejecting",
  list: "Listing",
  get: "Getting",
};

export function synthesizeHeadline(
  name: string,
  input: unknown,
  opts: SynthesizeOpts = {},
): string | undefined {
  const inp = asObj(input);
  if (!inp) return undefined;
  const home = opts.homeDir ?? null;
  const data = opts.dataDir ?? null;
  const alias = (p: string) => aliasPath(p, home, data);

  try {
    switch (name) {
      case "Read": {
        const p = asString(inp.file_path) ?? asString(inp.path);
        return p ? `Reading ${alias(p)}` : undefined;
      }
      case "Edit": {
        const p = asString(inp.file_path) ?? asString(inp.path);
        return p ? `Editing ${alias(p)}` : undefined;
      }
      case "Write": {
        const p = asString(inp.file_path) ?? asString(inp.path);
        return p ? `Writing ${alias(p)}` : undefined;
      }
      case "NotebookEdit": {
        const p = asString(inp.notebook_path) ?? asString(inp.file_path);
        return p ? `Editing ${alias(p)}` : undefined;
      }
      case "Glob": {
        const pat = asString(inp.pattern);
        return pat ? `Finding ${pat}` : undefined;
      }
      case "Grep": {
        const pat = asString(inp.pattern);
        if (!pat) return undefined;
        const path = asString(inp.path);
        return path ? `Grepping ${pat} in ${alias(path)}` : `Grepping ${pat}`;
      }
      case "WebFetch": {
        const url = asString(inp.url);
        if (!url) return undefined;
        try {
          return `Fetching ${new URL(url).host}`;
        } catch {
          return `Fetching ${trunc(url)}`;
        }
      }
      case "WebSearch": {
        const q = asString(inp.query);
        return q ? `Searching: ${trunc(q)}` : undefined;
      }
      case "TodoWrite": {
        const n = Array.isArray(inp.todos) ? inp.todos.length : undefined;
        return n !== undefined ? `Updating todos (${n})` : undefined;
      }
      case "ToolSearch": {
        const q = asString(inp.query);
        return q ? `Searching tools: ${trunc(q)}` : undefined;
      }
    }

    const mcp = /^mcp__friday-[^_]+__(.+)$/.exec(name);
    const short = mcp ? mcp[1] : null;

    if (short)
      switch (short) {
        case "mail_read": {
          const id = asString(inp.id) ?? asString(inp.mailId);
          return id ? `Reading mail #${id}` : "Reading mail";
        }
        case "mail_close": {
          const id = asString(inp.id) ?? asString(inp.mailId);
          return id ? `Closing mail #${id}` : "Closing mail";
        }
        case "mail_send": {
          const to = asString(inp.to);
          return to ? `Sending mail to ${to}` : "Sending mail";
        }
        case "mail_inbox":
          return "Checking mail inbox";

        case "agent_status": {
          const n = asString(inp.name);
          return n ? `Checking agent ${n}` : "Checking agent";
        }
        case "agent_list":
          return "Listing agents";
        case "agent_inspect": {
          const n = asString(inp.name);
          return n ? `Inspecting agent ${n}` : "Inspecting agent";
        }
        case "agent_create": {
          const n = asString(inp.name);
          const t = asString(inp.type) ?? asString(inp.kind);
          if (t && n) return `Spawning ${t} ${n}`;
          if (n) return `Spawning ${n}`;
          return "Spawning agent";
        }
        case "agent_kill": {
          const n = asString(inp.name);
          return n ? `Killing agent ${n}` : "Killing agent";
        }
        case "agent_archive": {
          const n = asString(inp.name);
          return n ? `Archiving ${n}` : "Archiving agent";
        }
        case "agent_delete_workspace": {
          const n = asString(inp.name);
          return n ? `Deleting workspace ${n}` : "Deleting workspace";
        }

        case "ticket_get": {
          const id = asString(inp.id);
          return id ? `Getting ticket ${id}` : "Getting ticket";
        }
        case "ticket_create": {
          const title = asString(inp.title);
          return title ? `Creating ticket: ${trunc(title)}` : "Creating ticket";
        }
        case "ticket_update": {
          const id = asString(inp.id);
          return id ? `Updating ticket ${id}` : "Updating ticket";
        }
        case "ticket_list":
          return "Listing tickets";
        case "ticket_comment": {
          const id = asString(inp.id);
          return id ? `Commenting on ${id}` : "Commenting on ticket";
        }

        case "memory_save": {
          const title = asString(inp.title);
          return title ? `Saving memory: ${trunc(title)}` : "Saving memory";
        }
        case "memory_search": {
          const q = asString(inp.query);
          return q ? `Searching memory: ${trunc(q)}` : "Searching memory";
        }
        case "memory_get": {
          const id = asString(inp.id);
          return id ? `Getting memory ${id}` : "Getting memory";
        }
        case "memory_update": {
          const id = asString(inp.id);
          return id ? `Updating memory ${id}` : "Updating memory";
        }
        case "memory_forget": {
          const id = asString(inp.id);
          return id ? `Forgetting memory ${id}` : "Forgetting memory";
        }

        case "linear_import":
          return "Importing from Linear";
        case "linear_reconcile":
          return "Reconciling Linear links";
      }

    if (short) {
      const sched = /^schedule_(.+)$/.exec(short);
      if (sched) {
        const verb = SCHEDULE_VERBS[sched[1]] ?? cap(sched[1]);
        const n = asString(inp.name) ?? asString(inp.id);
        return n ? `${verb} schedule ${n}` : `${verb} schedules`;
      }
      const ev = /^evolve_(.+)$/.exec(short);
      if (ev) {
        const verb = EVOLVE_VERBS[ev[1]] ?? cap(ev[1]);
        const id = asString(inp.id) ?? asString(inp.proposalId);
        return id ? `${verb} evolve proposal ${id}` : `${verb} evolve proposals`;
      }
    }

    const fridayMatch = name.match(/^mcp__friday-[^_]+__(.+)$/);
    if (fridayMatch) return `Friday MCP: ${fridayMatch[1]}`;
    const mcpMatch = name.match(/^mcp__[^_]+__(.+)$/);
    if (mcpMatch) return `MCP: ${mcpMatch[1]}`;
  } catch {
    return undefined;
  }
  return undefined;
}
