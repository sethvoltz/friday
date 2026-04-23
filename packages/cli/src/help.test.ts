import { describe, it, expect, vi } from "vitest";
import { HELP, hasHelpFlag, showHelp } from "./help.js";

describe("help texts", () => {
  it("has help for all known commands", () => {
    const expected = ["main", "usage", "config", "start", "stop", "restart", "status", "dev"];
    for (const cmd of expected) {
      expect(HELP[cmd]).toBeDefined();
    }
  });

  it("main help lists all user-facing commands", () => {
    const main = HELP.main;
    expect(main).toContain("usage");
    expect(main).toContain("config");
    expect(main).toContain("start");
    expect(main).toContain("stop");
    expect(main).toContain("restart");
    expect(main).toContain("status");
    expect(main).toContain("dev");
    expect(main).toContain("help");
  });
});

describe("showHelp", () => {
  it("prints help for a known command", () => {
    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));
    showHelp("usage");
    expect(logs[0]).toContain("friday usage");
    mock.mockRestore();
  });

  it("falls back to main help for unknown command", () => {
    const logs: string[] = [];
    const mock = vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));
    showHelp("nonexistent-command");
    expect(logs[0]).toContain("friday — CLI");
    mock.mockRestore();
  });
});

describe("hasHelpFlag", () => {
  it("detects --help", () => {
    expect(hasHelpFlag(["--help"])).toBe(true);
    expect(hasHelpFlag(["usage", "--help"])).toBe(true);
  });

  it("detects -h", () => {
    expect(hasHelpFlag(["-h"])).toBe(true);
  });

  it("returns false for no flags", () => {
    expect(hasHelpFlag(["usage"])).toBe(false);
    expect(hasHelpFlag([])).toBe(false);
  });
});
