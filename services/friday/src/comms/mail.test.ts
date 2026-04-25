import { describe, it, expect, vi, beforeEach } from "vitest";
import { mailSend, mailCheck, mailRead, mailClose } from "./mail.js";

// Mock execFileSync to capture bd commands
const execResults = new Map<string, string>();
let lastExecArgs: string[] = [];

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn((_cmd: string, args: string[]) => {
    lastExecArgs = args;
    // Match on the bd subcommand (first arg)
    const joined = args.join(" ");
    for (const [pattern, result] of execResults) {
      if (joined.includes(pattern)) {
        return Buffer.from(result);
      }
    }
    return Buffer.from("");
  }),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
}));

vi.mock("../log.js", () => ({
  log: vi.fn(),
}));

beforeEach(() => {
  execResults.clear();
  lastExecArgs = [];
});

describe("mailSend", () => {
  it("creates a beads issue with correct flags", () => {
    execResults.set("create", "friday-abc123");

    const id = mailSend({
      from: "orchestrator",
      to: "builder-blog",
      subject: "Start work",
      body: "Please begin the blog project",
    });

    expect(id).toBe("friday-abc123");
    expect(lastExecArgs[0]).toBe("create");
    expect(lastExecArgs[1]).toBe("Start work");
    expect(lastExecArgs).toContain("--silent");
    expect(lastExecArgs).toContain("builder-blog");
    expect(lastExecArgs).toContain("--ephemeral");
    // Labels are joined as a single arg
    const labelsArg = lastExecArgs[lastExecArgs.indexOf("-l") + 1];
    expect(labelsArg).toContain("type:message");
    expect(labelsArg).toContain("delivery:pending");
    expect(labelsArg).toContain("from:orchestrator");
  });

  it("adds urgent label and priority for urgent messages", () => {
    execResults.set("create", "friday-def456");

    mailSend({
      from: "builder-blog",
      to: "orchestrator",
      subject: "Plan ready",
      body: "Review needed",
      priority: "urgent",
    });

    const labelsArg = lastExecArgs[lastExecArgs.indexOf("-l") + 1];
    expect(labelsArg).toContain("priority:urgent");
    expect(lastExecArgs).toContain("1");
    const priorityIdx = lastExecArgs.indexOf("--priority");
    expect(lastExecArgs[priorityIdx + 1]).toBe("1");
  });

  it("preserves special characters in subject and body", () => {
    execResults.set("create", "friday-quote1");

    mailSend({
      from: "orchestrator",
      to: "helper-research",
      subject: 'Research: "Svelte for CLI" — reactive libs',
      body: 'Found https://example.com but it\'s experimental.\n\nCheck "this" & <that>.',
    });

    // Subject and body are passed as discrete args, not shell-interpolated
    expect(lastExecArgs[1]).toBe('Research: "Svelte for CLI" — reactive libs');
    const bodyIdx = lastExecArgs.indexOf("-d") + 1;
    expect(lastExecArgs[bodyIdx]).toContain('"this"');
    expect(lastExecArgs[bodyIdx]).toContain("&");
    expect(lastExecArgs[bodyIdx]).toContain("<that>");
  });
});

describe("mailCheck", () => {
  it("returns empty array when no mail", () => {
    execResults.set("query", "[]");
    expect(mailCheck("orchestrator")).toEqual([]);
  });

  it("parses pending messages", () => {
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

    const messages = mailCheck("orchestrator");
    expect(messages).toHaveLength(1);
    expect(messages[0].from).toBe("builder-blog");
    expect(messages[0].to).toBe("orchestrator");
    expect(messages[0].subject).toBe("Plan ready");
    expect(messages[0].status).toBe("pending");
  });

  it("returns empty array on query error", () => {
    // No result set — execSync will return empty string
    expect(mailCheck("nonexistent")).toEqual([]);
  });
});

describe("mailRead", () => {
  it("parses message and triggers ack labels", () => {
    execResults.set(
      "show",
      JSON.stringify({
        id: "friday-abc",
        title: "Hello",
        description: "World",
        assignee: "builder-blog",
        labels: ["type:message", "delivery:pending", "from:orchestrator"],
        created: "2026-04-23T10:00:00Z",
      })
    );
    execResults.set("label", "");

    const msg = mailRead("friday-abc");
    expect(msg.from).toBe("orchestrator");
    expect(msg.subject).toBe("Hello");
    expect(msg.status).toBe("acked");
  });
});

describe("mailClose", () => {
  it("closes the beads issue", () => {
    execResults.set("close", "");
    mailClose("friday-abc");
    expect(lastExecArgs).toEqual(["close", "friday-abc"]);
  });
});
