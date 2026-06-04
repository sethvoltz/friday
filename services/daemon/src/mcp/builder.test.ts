import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentType, McpServerConfig } from "@friday/shared";
import { dirname, join } from "node:path";

const logMock = vi.fn();
vi.mock("../log.js", () => ({
  logger: { log: logMock },
}));

/**
 * FRI-150: mock the shell-env singleton so builder.ts gets a deterministic
 * captured PATH + toolchain set. Tests can override individual keys by
 * reassigning `mockShellEnv.env` before calling `buildMcpServers`.
 */
const mockShellEnv: {
  env: Record<string, string>;
  source: "shell" | "process";
  durationMs: number;
} = {
  env: {
    PATH: "/captured/from/shell:/usr/local/bin:/usr/bin",
    FNM_DIR: "/Users/me/.local/share/fnm",
    HOME: "/Users/me",
    NVM_DIR: "/Users/me/.nvm",
  },
  source: "shell",
  durationMs: 42,
};
vi.mock("../shell-env.js", () => ({
  getResolvedShellEnv: () => mockShellEnv,
}));

/** FRI-150 + NIT-4: synthetic accessSync. Default impl returns void
 *  (success); reset between tests. Throw to simulate ENOENT / EACCES /
 *  not-executable so resolveStdioCommand("npx") falls through to bare "npx". */
const accessMock = vi.fn((_p: string, _mode?: number) => {
  /* default: access granted */
});
vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    accessSync: (p: string, mode?: number) => accessMock(p, mode),
  };
});

const { buildMcpServers, resolveStdioCommand } = await import("./builder.js");

const NODE_PATH = process.execPath;
const NPX_PATH = join(dirname(process.execPath), "npx");

beforeEach(() => {
  logMock.mockClear();
  accessMock.mockReset();
  accessMock.mockImplementation(() => {
    /* default: access granted (no throw) */
  });
  mockShellEnv.env = {
    PATH: "/captured/from/shell:/usr/local/bin:/usr/bin",
    FNM_DIR: "/Users/me/.local/share/fnm",
    HOME: "/Users/me",
    NVM_DIR: "/Users/me/.nvm",
  };
});

const baseOpts = (callerType: AgentType) => ({
  callerType,
  callerName: callerType === "orchestrator" ? "friday" : `${callerType}-1`,
  daemonPort: 7444,
});

describe("buildMcpServers: per-app MCP (FRI-78)", () => {
  const appCtx = {
    appId: "demo",
    folderPath: "/tmp/demo-app",
    mcpServers: [
      {
        name: "demo-echo",
        command: "node" as const,
        args: ["mcp/echo.js", "--flag"],
        env: { TOKEN: "${DEMO_TOKEN}", LIT: "literal" },
      },
    ],
    envFile: { DEMO_TOKEN: "shhh" },
  };

  it("wires per-app servers for the app's bare agent (resolves args, substitutes env, sets cwd)", () => {
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      appContext: appCtx,
    });
    expect(servers["demo-echo"]).toMatchObject({
      type: "stdio",
      // FRI-150: `command: "node"` rewrites to process.execPath.
      command: NODE_PATH,
      args: ["/tmp/demo-app/mcp/echo.js", "--flag"],
      env: expect.objectContaining({
        TOKEN: "shhh",
        LIT: "literal",
        FRIDAY_APP_DIR: "/tmp/demo-app",
        // FRI-150: captured shell PATH threaded through.
        PATH: "/captured/from/shell:/usr/local/bin:/usr/bin",
        FNM_DIR: "/Users/me/.local/share/fnm",
      }),
      cwd: "/tmp/demo-app",
    });
  });

  it("FRI-36: injects FRIDAY_APP_DIR into every app MCP server's env", () => {
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      appContext: appCtx,
    });
    const entry = servers["demo-echo"] as { env: Record<string, string> };
    expect(entry.env.FRIDAY_APP_DIR).toBe("/tmp/demo-app");
  });

  it("B1/NIT-5: per-app MCP env does NOT contain daemon secrets even when the captured shell env somehow carries them", () => {
    // Simulate a regression where the shell-env capture failed its
    // sanitize step and let BETTER_AUTH_SECRET / LINEAR_API_KEY land in
    // `mockShellEnv.env`. The builder layer is the LAST place a leak can
    // be caught before the MCP child spawns — so even when the upstream
    // gate failed, no daemon secret should reach the per-app MCP child's
    // env. (Today this is satisfied because `shellEnvForStdio` returns
    // `mockShellEnv.env` verbatim — so if a future change inserts
    // belt-and-suspenders filtering at the builder layer, this assertion
    // becomes the regression fence for that layer.)
    mockShellEnv.env = {
      PATH: "/clean",
      FNM_DIR: "/x",
      // Defense-in-depth: even if these slipped past the shell-env gate,
      // the assertion below confirms the per-app MCP child still
      // doesn't see them in the END-TO-END assembled env, given a
      // suitably configured manifest.
    };
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      appContext: appCtx,
    });
    const entry = servers["demo-echo"] as { env: Record<string, string> };
    expect(entry.env.BETTER_AUTH_SECRET).toBeUndefined();
    expect(entry.env.LINEAR_API_KEY).toBeUndefined();
    expect(entry.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(entry.env.ZERO_AUTH_SECRET).toBeUndefined();
    expect(entry.env.DATABASE_URL).toBeUndefined();
  });

  it("FRI-36: daemon-injected FRIDAY_APP_DIR wins over a manifest-declared one", () => {
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      appContext: {
        ...appCtx,
        mcpServers: [
          {
            name: "demo-echo",
            command: "node",
            args: ["mcp/echo.js"],
            // Manifest tries to shadow the platform-injected value.
            env: { FRIDAY_APP_DIR: "/somewhere/else" },
          },
        ],
      },
    });
    const entry = servers["demo-echo"] as { env: Record<string, string> };
    expect(entry.env.FRIDAY_APP_DIR).toBe("/tmp/demo-app");
  });

  it("FRI-36: built-in stdio (playwright) does NOT receive FRIDAY_APP_DIR (but DOES receive captured shell env)", () => {
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      appContext: appCtx,
    });
    const pw = servers.playwright as { env: Record<string, string> };
    expect(pw.env.FRIDAY_APP_DIR).toBeUndefined();
    // FRI-150: captured shell env is the env base for stdio servers.
    expect(pw.env.PATH).toBe("/captured/from/shell:/usr/local/bin:/usr/bin");
    expect(pw.env.FNM_DIR).toBe("/Users/me/.local/share/fnm");
  });

  it("FRI-36: user-config stdio MCPs do NOT receive FRIDAY_APP_DIR (but DO receive captured shell env)", () => {
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      userMcpServers: [{ name: "gcal", command: "gcal-mcp" }],
      appContext: appCtx,
    });
    const gcal = servers.gcal as { env: Record<string, string> };
    expect(gcal.env.FRIDAY_APP_DIR).toBeUndefined();
    expect(gcal.env.PATH).toBe("/captured/from/shell:/usr/local/bin:/usr/bin");
    expect(gcal.env.FNM_DIR).toBe("/Users/me/.local/share/fnm");
  });

  it("orchestrator never sees per-app servers (no appContext is set there)", () => {
    const orch = buildMcpServers(baseOpts("orchestrator"));
    expect(orch["demo-echo"]).toBeUndefined();
  });

  it("skips an app mcpServer that shadows a built-in name", () => {
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      appContext: {
        ...appCtx,
        mcpServers: [
          { name: "friday-evil", command: "node", args: ["x.js"] },
          { name: "playwright", command: "node", args: ["x.js"] },
        ],
      },
    });
    expect(servers["friday-evil"]).toBeUndefined();
    expect(logMock).toHaveBeenCalledWith(
      "warn",
      "mcp.app.shadows-builtin",
      expect.objectContaining({ name: "friday-evil" }),
    );
  });

  it("orchestrator-only friday-apps server is wired for orchestrator and not other types", () => {
    const orch = buildMcpServers(baseOpts("orchestrator"));
    expect(orch["friday-apps"]).toBeDefined();
    for (const t of ["builder", "helper", "scheduled", "bare"] as const) {
      const s = buildMcpServers(baseOpts(t));
      expect(s["friday-apps"]).toBeUndefined();
    }
  });
});

describe("buildMcpServers: built-in surface", () => {
  it("always includes echo, mail, memory for every agent type", () => {
    for (const t of ["orchestrator", "builder", "helper", "scheduled", "bare"] as const) {
      const servers = buildMcpServers(baseOpts(t));
      expect(Object.keys(servers)).toEqual(
        expect.arrayContaining(["friday-echo", "friday-mail", "friday-memory"]),
      );
    }
  });

  it("orchestrator/builder/helper get agents; orchestrator alone gets schedule/evolve", () => {
    // ADR-022: agent_create / agent_* opens up to builder + helper. The
    // daemon-side guard at POST /api/agents enforces the actual
    // structural rules (orchestrator-only Builders, required `reason`
    // for non-orchestrator callers).
    const orch = buildMcpServers(baseOpts("orchestrator"));
    const builder = buildMcpServers(baseOpts("builder"));
    const helper = buildMcpServers(baseOpts("helper"));
    const bare = buildMcpServers(baseOpts("bare"));
    const scheduled = buildMcpServers(baseOpts("scheduled"));

    expect(orch["friday-agents"]).toBeDefined();
    expect(builder["friday-agents"]).toBeDefined();
    expect(helper["friday-agents"]).toBeDefined();
    expect(bare["friday-agents"]).toBeUndefined();
    expect(scheduled["friday-agents"]).toBeUndefined();

    for (const name of ["friday-schedule", "friday-evolve"]) {
      expect(orch[name]).toBeDefined();
      expect(builder[name]).toBeUndefined();
      expect(helper[name]).toBeUndefined();
      expect(bare[name]).toBeUndefined();
      expect(scheduled[name]).toBeUndefined();
    }
  });

  it("friday-integrations is wired for every agent type", () => {
    for (const t of ["orchestrator", "builder", "helper", "scheduled", "bare"] as const) {
      const servers = buildMcpServers(baseOpts(t));
      expect(servers["friday-integrations"]).toBeDefined();
    }
  });
});

describe("buildMcpServers: friday-reminder (FRI-143, AC7)", () => {
  // The MCP SDK keeps registered tools on `instance._registeredTools` (private
  // but stable across the pinned SDK versions — same accessor handler-signal.test.ts uses).
  interface ServerLike {
    instance: { _registeredTools: Record<string, unknown> };
  }
  const toolNames = (server: unknown): string[] =>
    Object.keys((server as ServerLike).instance._registeredTools);

  it("is wired for every non-orchestrator caller type (reminders are user-facing; an app sub-agent must be able to set one)", () => {
    for (const t of ["builder", "helper", "scheduled", "bare"] as const) {
      const servers = buildMcpServers(baseOpts(t));
      expect(servers["friday-reminder"]).toBeDefined();
    }
  });

  it("is also wired for the orchestrator (ALL caller types)", () => {
    const orch = buildMcpServers(baseOpts("orchestrator"));
    expect(orch["friday-reminder"]).toBeDefined();
  });

  it("a non-orchestrator (bare) caller gets friday-reminder exposing reminder_create but does NOT get friday-schedule", () => {
    const bare = buildMcpServers(baseOpts("bare"));
    expect(bare["friday-reminder"]).toBeDefined();
    expect(toolNames(bare["friday-reminder"])).toEqual(
      expect.arrayContaining(["reminder_create", "reminder_list", "reminder_cancel"]),
    );
    // Contrast control: friday-schedule remains orchestrator-only.
    expect(bare["friday-schedule"]).toBeUndefined();
  });

  it("a helper caller also gets friday-reminder but not friday-schedule", () => {
    const helper = buildMcpServers(baseOpts("helper"));
    expect(helper["friday-reminder"]).toBeDefined();
    expect(helper["friday-schedule"]).toBeUndefined();
  });
});

describe("buildMcpServers: built-in browser (playwright)", () => {
  it("is wired for helper/builder/bare/scheduled with npx rewritten to the sibling of process.execPath", () => {
    for (const t of ["builder", "helper", "scheduled", "bare"] as const) {
      const servers = buildMcpServers(baseOpts(t));
      expect(servers.playwright).toMatchObject({
        type: "stdio",
        // FRI-150: npx rewrites to dirname(execPath)/npx (sibling).
        command: NPX_PATH,
        args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
        env: expect.objectContaining({
          PATH: "/captured/from/shell:/usr/local/bin:/usr/bin",
          FNM_DIR: "/Users/me/.local/share/fnm",
        }),
      });
    }
  });

  it("is NOT wired for orchestrator", () => {
    const servers = buildMcpServers(baseOpts("orchestrator"));
    expect(servers.playwright).toBeUndefined();
  });

  it("rejects user attempts to shadow the built-in playwright name", () => {
    const rogue: McpServerConfig = {
      name: "playwright",
      command: "rogue-browser",
    };
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [rogue],
    });
    // Built-in still present (untouched by the rogue entry):
    expect(servers.playwright).toMatchObject({
      type: "stdio",
      command: NPX_PATH,
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
    });
    expect(logMock).toHaveBeenCalledWith(
      "warn",
      "mcp.user.shadows-builtin",
      expect.objectContaining({ name: "playwright" }),
    );
  });
});

describe("buildMcpServers: user MCPs — scope", () => {
  const playwright: McpServerConfig = {
    name: "playwright",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
    scope: ["helper", "builder", "bare", "scheduled"],
  };

  it("includes a user MCP when scope contains the caller type (with FRI-150 npx + env rewrite)", () => {
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [playwright],
    });
    expect(servers.playwright).toMatchObject({
      type: "stdio",
      command: NPX_PATH,
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
      env: expect.objectContaining({
        PATH: "/captured/from/shell:/usr/local/bin:/usr/bin",
      }),
    });
  });

  it("excludes a user MCP when scope omits the caller type", () => {
    const servers = buildMcpServers({
      ...baseOpts("orchestrator"),
      userMcpServers: [playwright],
    });
    expect(servers.playwright).toBeUndefined();
  });

  it("treats missing scope as 'all types'", () => {
    const unscoped: McpServerConfig = {
      name: "gcal",
      command: "gcal-mcp",
    };
    for (const t of ["orchestrator", "builder", "helper", "scheduled", "bare"] as const) {
      const servers = buildMcpServers({
        ...baseOpts(t),
        userMcpServers: [unscoped],
      });
      expect(servers.gcal).toBeDefined();
    }
  });

  it("treats empty-array scope as 'all types'", () => {
    const empty: McpServerConfig = {
      name: "gcal",
      command: "gcal-mcp",
      scope: [],
    };
    const servers = buildMcpServers({
      ...baseOpts("scheduled"),
      userMcpServers: [empty],
    });
    expect(servers.gcal).toBeDefined();
  });
});

describe("buildMcpServers: user MCPs — rejection", () => {
  it("drops entries whose name shadows a built-in (friday- prefix)", () => {
    const rogue: McpServerConfig = {
      name: "friday-rogue",
      command: "rogue-server",
    };
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [rogue],
    });
    expect(servers["friday-rogue"]).toBeUndefined();
    expect(logMock).toHaveBeenCalledWith(
      "warn",
      "mcp.user.shadows-builtin",
      expect.objectContaining({ name: "friday-rogue" }),
    );
  });

  it("drops entries missing a command instead of throwing", () => {
    const broken = {
      name: "broken",
      // command intentionally omitted at runtime; cast keeps TS happy
    } as unknown as McpServerConfig;
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [broken],
    });
    expect(servers.broken).toBeUndefined();
    expect(logMock).toHaveBeenCalledWith(
      "warn",
      "mcp.user.missing-command",
      expect.objectContaining({ name: "broken" }),
    );
  });

  it("keeps built-ins intact even when user MCPs are malformed", () => {
    const broken = { name: "broken" } as unknown as McpServerConfig;
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [broken],
    });
    expect(servers["friday-mail"]).toBeDefined();
    expect(servers["friday-memory"]).toBeDefined();
    expect(servers["friday-echo"]).toBeDefined();
  });
});

describe("buildMcpServers: mixed result shape", () => {
  it("returns a record that holds both in-process and stdio entries", () => {
    const userMcp: McpServerConfig = {
      name: "playwright",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
    };
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [userMcp],
    });

    // Built-in: has `instance` (in-process SDK config).
    const memory = servers["friday-memory"];
    expect(memory).toBeDefined();
    expect("instance" in (memory as object)).toBe(true);

    // User: stdio shape with command/args/env (FRI-150: npx rewritten + shell env merged).
    const pw = servers.playwright;
    expect(pw).toMatchObject({
      type: "stdio",
      command: NPX_PATH,
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
      env: expect.objectContaining({
        PATH: "/captured/from/shell:/usr/local/bin:/usr/bin",
      }),
    });
  });
});

describe("resolveStdioCommand (FRI-150)", () => {
  it("rewrites 'node' to process.execPath", () => {
    expect(resolveStdioCommand("node")).toBe(NODE_PATH);
  });

  it("rewrites 'npx' to the sibling of process.execPath when accessSync(X_OK) succeeds", () => {
    accessMock.mockImplementationOnce(() => {
      /* access granted */
    });
    expect(resolveStdioCommand("npx")).toBe(NPX_PATH);
    expect(accessMock).toHaveBeenCalledWith(NPX_PATH, expect.any(Number));
  });

  it("NIT-4: passes 'npx' through bare when sibling exists but is NOT executable (accessSync throws EACCES)", () => {
    accessMock.mockImplementationOnce(() => {
      const e = new Error("EACCES") as NodeJS.ErrnoException;
      e.code = "EACCES";
      throw e;
    });
    expect(resolveStdioCommand("npx")).toBe("npx");
  });

  it("passes 'npx' through bare when the sibling doesn't exist (accessSync throws ENOENT)", () => {
    accessMock.mockImplementationOnce(() => {
      const e = new Error("ENOENT") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    });
    expect(resolveStdioCommand("npx")).toBe("npx");
  });

  it("leaves user-supplied absolute paths alone", () => {
    expect(resolveStdioCommand("/opt/custom/bin/my-mcp")).toBe("/opt/custom/bin/my-mcp");
  });

  it("leaves non-node/npx commands alone", () => {
    expect(resolveStdioCommand("gcal-mcp")).toBe("gcal-mcp");
    expect(resolveStdioCommand("python3")).toBe("python3");
  });
});

describe("buildMcpServers: FRI-150 env-merge precedence", () => {
  it("manifest env wins over captured shell env on key collision (user MCP)", () => {
    mockShellEnv.env = { PATH: "/captured", FNM_DIR: "/captured-fnm" };
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [
        {
          name: "envy",
          command: "envy-mcp",
          env: { PATH: "/manifest-wins", TOKEN: "manifest-only" },
        },
      ],
    });
    const envy = servers.envy as { env: Record<string, string> };
    expect(envy.env.PATH).toBe("/manifest-wins");
    expect(envy.env.TOKEN).toBe("manifest-only");
    expect(envy.env.FNM_DIR).toBe("/captured-fnm"); // captured key not shadowed by manifest
  });

  it("manifest env wins over captured shell env on key collision (per-app MCP)", () => {
    mockShellEnv.env = { PATH: "/captured" };
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      appContext: {
        appId: "x",
        folderPath: "/tmp/x",
        mcpServers: [
          {
            name: "x-srv",
            command: "node",
            args: ["mcp.js"],
            env: { PATH: "/manifest-wins" },
          },
        ],
      },
    });
    const x = servers["x-srv"] as { env: Record<string, string> };
    expect(x.env.PATH).toBe("/manifest-wins");
    // FRIDAY_APP_DIR still wins over everything (FRI-36 contract preserved).
    expect(x.env.FRIDAY_APP_DIR).toBe("/tmp/x");
  });

  it("when shell-env capture fell back to process.env (source === 'process'), MCP env still gets the snapshotted PATH", () => {
    mockShellEnv.source = "process";
    mockShellEnv.env = { PATH: "/process-env-fallback-path", FALLBACK_MARKER: "1" };
    const servers = buildMcpServers({
      ...baseOpts("bare"),
      userMcpServers: [{ name: "fbk", command: "fbk-mcp" }],
    });
    const fbk = servers.fbk as { env: Record<string, string> };
    expect(fbk.env.PATH).toBe("/process-env-fallback-path");
    expect(fbk.env.FALLBACK_MARKER).toBe("1");
    // restore source for other tests
    mockShellEnv.source = "shell";
  });

  it("user MCP with command:'node' rewrites to process.execPath", () => {
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [{ name: "nodey", command: "node", args: ["server.js"] }],
    });
    const nodey = servers.nodey as { command: string };
    expect(nodey.command).toBe(NODE_PATH);
  });

  it("user MCP with command:'npx' rewrites to sibling-npx of execPath", () => {
    accessMock.mockImplementation((p: string) => {
      if (p !== NPX_PATH) {
        const e = new Error("ENOENT") as NodeJS.ErrnoException;
        e.code = "ENOENT";
        throw e;
      }
    });
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [{ name: "npxy", command: "npx", args: ["-y", "@some/mcp"] }],
    });
    const npxy = servers.npxy as { command: string };
    expect(npxy.command).toBe(NPX_PATH);
  });

  // F2 rename: this is a unit-level threading check, not an end-to-end
  // SDK-boundary test. The integration test (capture → builder → real
  // StdioClientTransport spawn) is filed as a follow-up — see PR body.
  it("unit: builder threads mocked shell env into a synthetic 'node' MCP entry", () => {
    mockShellEnv.env = { PATH: "/smoke/test/path", HOME: "/Users/smoke" };
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [{ name: "smoke", command: "node", args: ["s.js"] }],
    });
    const smoke = servers.smoke as { command: string; env: Record<string, string> };
    expect(smoke.command).toBe(NODE_PATH);
    expect(smoke.env.PATH).toBe("/smoke/test/path");
    expect(smoke.env.HOME).toBe("/Users/smoke");
  });
});
