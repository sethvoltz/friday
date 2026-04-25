import { describe, it, expect, vi, beforeEach } from "vitest";

const execResults = new Map<string, string>();

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn((_cmd: string, args: string[]) => {
    const joined = args.join(" ");
    for (const [pattern, result] of execResults) {
      if (joined.includes(pattern)) return Buffer.from(result);
    }
    return Buffer.from("");
  }),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

const { mailCommand } = await import("./mail.js");

beforeEach(() => {
  execResults.clear();
});

describe("mailCommand", () => {
  it("lists mail for orchestrator by default", () => {
    execResults.set("query", "[]");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    mailCommand([]);

    expect(logs.join("\n")).toContain("No pending messages");
    vi.restoreAllMocks();
  });

  it("lists pending messages with from and subject", () => {
    execResults.set(
      "query",
      JSON.stringify([
        {
          id: "friday-abc",
          title: "Plan ready",
          description: "Please review",
          assignee: "orchestrator",
          labels: ["type:message", "delivery:pending", "from:builder-blog"],
          created: "2026-04-23T10:00:00Z",
        },
      ])
    );
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    mailCommand(["list"]);

    const output = logs.join("\n");
    expect(output).toContain("1 pending");
    expect(output).toContain("friday-abc");
    expect(output).toContain("builder-blog");
    expect(output).toContain("Plan ready");
    vi.restoreAllMocks();
  });

  it("reads a specific message", () => {
    execResults.set(
      "show",
      JSON.stringify({
        id: "friday-abc",
        title: "Hello",
        description: "World body text",
        assignee: "orchestrator",
        labels: ["type:message", "delivery:pending", "from:builder-blog"],
        created: "2026-04-23T10:00:00Z",
      })
    );
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    mailCommand(["read", "friday-abc"]);

    const output = logs.join("\n");
    expect(output).toContain("From:     builder-blog");
    expect(output).toContain("Subject:  Hello");
    expect(output).toContain("World body text");
    vi.restoreAllMocks();
  });

  it("sends a message", () => {
    execResults.set("create", "friday-xyz");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

    mailCommand([
      "send",
      "--to", "builder-blog",
      "--subject", "Start work",
      "--body", "Begin the project",
    ]);

    const output = logs.join("\n");
    expect(output).toContain("Message sent to builder-blog");
    expect(output).toContain("friday-xyz");
    vi.restoreAllMocks();
  });

  it("send requires --to, --subject, --body", () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => mailCommand(["send", "--to", "builder-blog"])).toThrow("process.exit");

    mockExit.mockRestore();
    vi.restoreAllMocks();
  });
});
