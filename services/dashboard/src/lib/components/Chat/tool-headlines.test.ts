import { describe, it, expect } from "vitest";
import { aliasPath, synthesizeHeadline } from "./tool-headlines";

const HOME = "/Users/seth";
const DATA = "/Users/seth/.friday";

describe("aliasPath", () => {
  it("aliases workspaces paths to @workspaces/<name>", () => {
    expect(aliasPath("/Users/seth/.friday/workspaces/my-agent/src/foo.ts", HOME, DATA)).toBe(
      "@workspaces/my-agent/src/foo.ts",
    );
  });

  it("aliases apps paths to @apps/<name>", () => {
    expect(aliasPath("/Users/seth/.friday/apps/my-app/index.ts", HOME, DATA)).toBe(
      "@apps/my-app/index.ts",
    );
  });

  it("aliases home paths to ~/...", () => {
    expect(aliasPath("/Users/seth/Development/project/src/main.ts", HOME, DATA)).toBe(
      "~/Development/project/src/main.ts",
    );
  });

  it("passes through paths with no matching alias", () => {
    expect(aliasPath("/etc/hosts", HOME, DATA)).toBe("/etc/hosts");
    expect(aliasPath("/var/log/system.log", null, null)).toBe("/var/log/system.log");
  });

  it("workspace alias takes priority over home alias", () => {
    expect(aliasPath("/Users/seth/.friday/workspaces/foo", HOME, DATA)).toBe("@workspaces/foo");
  });

  it("passes through when dataDir is not provided", () => {
    expect(aliasPath("/Users/seth/.friday/workspaces/foo", HOME, null)).toBe(
      "~/.friday/workspaces/foo",
    );
  });
});

describe("synthesizeHeadline — built-ins", () => {
  it("Read uses file_path with home alias", () => {
    expect(
      synthesizeHeadline("Read", { file_path: "/Users/seth/Development/x.ts" }, { homeDir: HOME }),
    ).toBe("Reading ~/Development/x.ts");
  });

  it("Edit / Write use the same home alias", () => {
    expect(synthesizeHeadline("Edit", { file_path: "/Users/seth/a/b.ts" }, { homeDir: HOME })).toBe(
      "Editing ~/a/b.ts",
    );
    expect(
      synthesizeHeadline("Write", { file_path: "/Users/seth/a/b.ts" }, { homeDir: HOME }),
    ).toBe("Writing ~/a/b.ts");
  });

  it("Glob does not compress its pattern", () => {
    expect(synthesizeHeadline("Glob", { pattern: "src/**/*.ts" })).toBe("Finding src/**/*.ts");
  });

  it("Grep includes path when present", () => {
    expect(synthesizeHeadline("Grep", { pattern: "TODO" })).toBe("Grepping TODO");
    expect(
      synthesizeHeadline("Grep", { pattern: "TODO", path: "/Users/seth/repo" }, { homeDir: HOME }),
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

  it("MultiEdit reports the aliased path and the edit count (FRI-134 AC#7)", () => {
    const out = synthesizeHeadline("MultiEdit", { file_path: "/a/b.ts", edits: [{}, {}] }, {});
    expect(out).toBeDefined();
    expect(out).toContain("/a/b.ts");
    expect(out).toContain("2");
    // Full shape pin (no aliasing without home/dataDir).
    expect(out).toBe("Editing /a/b.ts (2 edits)");
  });

  it("MultiEdit aliases the path like Edit does", () => {
    expect(
      synthesizeHeadline(
        "MultiEdit",
        { file_path: "/Users/seth/a/b.ts", edits: [{}, {}, {}] },
        { homeDir: HOME },
      ),
    ).toBe("Editing ~/a/b.ts (3 edits)");
  });

  it("MultiEdit returns undefined when file_path is missing", () => {
    expect(synthesizeHeadline("MultiEdit", { edits: [{}] })).toBeUndefined();
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
    expect(synthesizeHeadline("mcp__friday-mail__mail_read", { id: "abc123" })).toBe(
      "Reading mail #abc123",
    );
  });

  it("mail_inbox is a fixed string", () => {
    expect(synthesizeHeadline("mcp__friday-mail__mail_inbox", {})).toBe("Checking mail inbox");
  });

  it("ticket_get uses id", () => {
    expect(synthesizeHeadline("mcp__friday-tickets__ticket_get", { id: "FRI-10" })).toBe(
      "Getting ticket FRI-10",
    );
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
    expect(synthesizeHeadline("mcp__friday-evolve__evolve_propose", { id: "p7" })).toBe(
      "Proposing evolve proposal p7",
    );
  });
});

// FRI-137: the file-edit card header (FileEditRenderer → FileDiff) is the
// EXACT output of these existing helpers — `aliasPath` (or `synthesizeHeadline`
// which calls it), NOT a new abbreviation scheme. These pins lock the header
// strings the renderer relies on so a regression in the alias output surfaces
// here rather than only in Playwright.
describe("FRI-137 file-edit header — aliased filename (exact strings)", () => {
  it("aliasPath compresses an apps path to @apps/<topic>/...", () => {
    expect(aliasPath("/Users/seth/.friday/apps/foo/index.html", HOME, DATA)).toBe(
      "@apps/foo/index.html",
    );
  });

  it("Write header for an apps file reads 'Writing @apps/<topic>/...'", () => {
    expect(
      synthesizeHeadline(
        "Write",
        { file_path: "/Users/seth/.friday/apps/foo/index.html" },
        { homeDir: HOME, dataDir: DATA },
      ),
    ).toBe("Writing @apps/foo/index.html");
  });

  it("Edit header for a home file reads 'Editing ~/a/b.ts'", () => {
    expect(synthesizeHeadline("Edit", { file_path: "/Users/seth/a/b.ts" }, { homeDir: HOME })).toBe(
      "Editing ~/a/b.ts",
    );
  });

  it("NotebookEdit header aliases notebook_path like the other file ops", () => {
    expect(
      synthesizeHeadline(
        "NotebookEdit",
        { notebook_path: "/Users/seth/.friday/apps/foo/nb.ipynb" },
        { homeDir: HOME, dataDir: DATA },
      ),
    ).toBe("Editing @apps/foo/nb.ipynb");
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
