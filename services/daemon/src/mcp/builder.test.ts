import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentType, McpServerConfig } from "@friday/shared";

const logMock = vi.fn();
vi.mock("../log.js", () => ({
  logger: { log: logMock },
}));

const { buildMcpServers } = await import("./builder.js");

beforeEach(() => {
  logMock.mockClear();
});

const baseOpts = (callerType: AgentType) => ({
  callerType,
  callerName: callerType === "orchestrator" ? "friday" : `${callerType}-1`,
  daemonPort: 7444,
});

describe("buildMcpServers: built-in surface", () => {
  it("always includes echo, mail, memory for every agent type", () => {
    for (const t of [
      "orchestrator",
      "builder",
      "helper",
      "scheduled",
      "bare",
    ] as const) {
      const servers = buildMcpServers(baseOpts(t));
      expect(Object.keys(servers)).toEqual(
        expect.arrayContaining(["friday-echo", "friday-mail", "friday-memory"]),
      );
    }
  });

  it("orchestrator alone gets agents/schedule/evolve", () => {
    const orch = buildMcpServers(baseOpts("orchestrator"));
    const helper = buildMcpServers(baseOpts("helper"));
    for (const name of [
      "friday-agents",
      "friday-schedule",
      "friday-evolve",
    ]) {
      expect(orch[name]).toBeDefined();
      expect(helper[name]).toBeUndefined();
    }
  });

  it("friday-integrations is wired for every agent type", () => {
    for (const t of [
      "orchestrator",
      "builder",
      "helper",
      "scheduled",
      "bare",
    ] as const) {
      const servers = buildMcpServers(baseOpts(t));
      expect(servers["friday-integrations"]).toBeDefined();
    }
  });
});

describe("buildMcpServers: built-in browser (playwright)", () => {
  it("is wired for helper/builder/bare/scheduled", () => {
    for (const t of ["builder", "helper", "scheduled", "bare"] as const) {
      const servers = buildMcpServers(baseOpts(t));
      expect(servers.playwright).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
        env: {},
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
    expect(servers.playwright).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
      env: {},
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

  it("includes a user MCP when scope contains the caller type", () => {
    const servers = buildMcpServers({
      ...baseOpts("helper"),
      userMcpServers: [playwright],
    });
    expect(servers.playwright).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
      env: {},
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
    for (const t of [
      "orchestrator",
      "builder",
      "helper",
      "scheduled",
      "bare",
    ] as const) {
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

    // User: stdio shape with command/args/env.
    const pw = servers.playwright;
    expect(pw).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
      env: {},
    });
  });
});
