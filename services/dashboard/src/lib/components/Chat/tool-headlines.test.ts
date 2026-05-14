import { describe, it, expect } from "vitest";
import { compressPath, synthesizeHeadline } from "./tool-headlines";

const HOME = "/Users/seth";

describe("compressPath", () => {
  it("compresses an absolute path under home into ~/X/Y/file", () => {
    expect(
      compressPath(
        "/Users/seth/Development/Seth/Friday/agent-friday/services/daemon/src/api/server.ts",
        HOME,
      ),
    ).toBe("~/D/S/F/a/s/d/s/a/server.ts");
  });

  it("preserves leading dot on hidden directories", () => {
    expect(compressPath("/Users/seth/.friday/memory/entries/x.md", HOME)).toBe(
      "~/.f/m/e/x.md",
    );
  });

  it("renders the home dir itself as ~", () => {
    expect(compressPath("/Users/seth", HOME)).toBe("~");
  });

  it("compresses absolute paths outside home with a leading /", () => {
    expect(compressPath("/etc/hosts", HOME)).toBe("/e/hosts");
    expect(compressPath("/var/log/system.log", HOME)).toBe("/v/l/system.log");
  });

  it("compresses relative paths", () => {
    expect(compressPath("services/dashboard/src/app.css", null)).toBe(
      "s/d/s/app.css",
    );
  });

  it("returns single-segment paths untouched", () => {
    expect(compressPath("server.ts", null)).toBe("server.ts");
    expect(compressPath("/etc", null)).toBe("/etc");
  });

  it("skips home replacement when homeDir is not provided", () => {
    expect(compressPath("/Users/seth/Code/x.ts", null)).toBe("/U/s/C/x.ts");
  });
});

describe("synthesizeHeadline — built-ins", () => {
  it("Read uses file_path with compression", () => {
    expect(
      synthesizeHeadline(
        "Read",
        { file_path: "/Users/seth/Development/x.ts" },
        { homeDir: HOME },
      ),
    ).toBe("Reading ~/D/x.ts");
  });

  it("Edit / Write use the same compression", () => {
    expect(
      synthesizeHeadline(
        "Edit",
        { file_path: "/Users/seth/a/b.ts" },
        { homeDir: HOME },
      ),
    ).toBe("Editing ~/a/b.ts");
    expect(
      synthesizeHeadline(
        "Write",
        { file_path: "/Users/seth/a/b.ts" },
        { homeDir: HOME },
      ),
    ).toBe("Writing ~/a/b.ts");
  });

  it("Glob does not compress its pattern", () => {
    expect(
      synthesizeHeadline("Glob", { pattern: "src/**/*.ts" }),
    ).toBe("Finding src/**/*.ts");
  });

  it("Grep includes path when present", () => {
    expect(
      synthesizeHeadline("Grep", { pattern: "TODO" }),
    ).toBe("Grepping TODO");
    expect(
      synthesizeHeadline(
        "Grep",
        { pattern: "TODO", path: "/Users/seth/repo" },
        { homeDir: HOME },
      ),
    ).toBe("Grepping TODO in ~/repo");
  });

  it("WebFetch shows only the host", () => {
    expect(
      synthesizeHeadline("WebFetch", {
        url: "https://example.com/some/deep/path?q=1",
      }),
    ).toBe("Fetching example.com");
  });

  it("WebSearch truncates long queries", () => {
    const q = "x".repeat(80);
    const out = synthesizeHeadline("WebSearch", { query: q });
    expect(out?.startsWith("Searching: ")).toBe(true);
    expect(out!.length).toBeLessThanOrEqual("Searching: ".length + 60);
    expect(out!.endsWith("…")).toBe(true);
  });

  it("TodoWrite reports the count", () => {
    expect(
      synthesizeHeadline("TodoWrite", {
        todos: [
          { content: "a", activeForm: "a", status: "pending" },
          { content: "b", activeForm: "b", status: "pending" },
        ],
      }),
    ).toBe("Updating todos (2)");
  });

  it("ToolSearch", () => {
    expect(synthesizeHeadline("ToolSearch", { query: "select:Read" })).toBe(
      "Searching tools: select:Read",
    );
  });
});

describe("synthesizeHeadline — Friday MCP tools", () => {
  it("mail_send uses recipient", () => {
    expect(
      synthesizeHeadline("mcp__friday-mail__mail_send", {
        to: "orchestrator",
        body: "hi",
      }),
    ).toBe("Sending mail to orchestrator");
  });

  it("mail_read uses id", () => {
    expect(
      synthesizeHeadline("mcp__friday-mail__mail_read", { id: "abc123" }),
    ).toBe("Reading mail #abc123");
  });

  it("mail_inbox is a fixed string", () => {
    expect(
      synthesizeHeadline("mcp__friday-mail__mail_inbox", {}),
    ).toBe("Checking mail inbox");
  });

  it("ticket_get uses id", () => {
    expect(
      synthesizeHeadline("mcp__friday-tickets__ticket_get", { id: "FRI-10" }),
    ).toBe("Getting ticket FRI-10");
  });

  it("ticket_create truncates title", () => {
    expect(
      synthesizeHeadline("mcp__friday-tickets__ticket_create", {
        title: "Add synthesizer",
      }),
    ).toBe("Creating ticket: Add synthesizer");
  });

  it("memory_search uses query", () => {
    expect(
      synthesizeHeadline("mcp__friday-memory__memory_search", {
        query: "tool cards",
      }),
    ).toBe("Searching memory: tool cards");
  });

  it("schedule_create uses verb + name", () => {
    expect(
      synthesizeHeadline("mcp__friday-schedule__schedule_create", {
        name: "babysit-prs",
      }),
    ).toBe("Creating schedule babysit-prs");
  });

  it("evolve_propose uses verb + id", () => {
    expect(
      synthesizeHeadline("mcp__friday-evolve__evolve_propose", { id: "p7" }),
    ).toBe("Proposing evolve proposal p7");
  });
});

describe("synthesizeHeadline — fallback", () => {
  it("returns undefined for unknown tools", () => {
    expect(synthesizeHeadline("RandomTool", { foo: 1 })).toBeUndefined();
  });

  it("returns undefined when required input field is missing", () => {
    expect(synthesizeHeadline("Read", {})).toBeUndefined();
    expect(synthesizeHeadline("Glob", {})).toBeUndefined();
  });

  it("returns undefined for non-object input", () => {
    expect(synthesizeHeadline("Read", null)).toBeUndefined();
    expect(synthesizeHeadline("Read", "string")).toBeUndefined();
  });
});
