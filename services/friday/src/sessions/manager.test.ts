import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testDir = join(tmpdir(), `friday-manager-test-${process.pid}-${Date.now()}`);
const sessionsDir = join(testDir, ".friday", "sessions");
const channelsFile = join(sessionsDir, "channels.json");

// Mock shared paths
vi.mock("@friday/shared", () => ({
  SESSIONS_DIR: sessionsDir,
}));

// Mock logger to silence output
vi.mock("../log.js", () => ({
  log: vi.fn(),
}));

// Import after mocks
const { loadSessions, getSessionId, setSessionId, resetSession } =
  await import("./manager.js");

describe("session manager", () => {
  beforeEach(() => {
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("loadSessions creates sessions dir if missing", () => {
    rmSync(sessionsDir, { recursive: true, force: true });
    loadSessions();
    expect(existsSync(sessionsDir)).toBe(true);
  });

  it("loadSessions handles corrupted channels.json", () => {
    writeFileSync(channelsFile, "{ not valid json }");
    expect(() => loadSessions()).toThrow();
  });

  it("getSessionId returns undefined for unknown channel", () => {
    loadSessions();
    expect(getSessionId("C-unknown")).toBeUndefined();
  });

  it("setSessionId persists and retrieves session", () => {
    loadSessions();
    setSessionId("C123", "session-abc");
    expect(getSessionId("C123")).toBe("session-abc");

    // Verify it was written to disk
    const saved = JSON.parse(readFileSync(channelsFile, "utf-8"));
    expect(saved["C123"]).toBe("session-abc");
  });

  it("resetSession removes a session", () => {
    loadSessions();
    setSessionId("C123", "session-abc");
    expect(getSessionId("C123")).toBe("session-abc");

    resetSession("C123");
    expect(getSessionId("C123")).toBeUndefined();

    // Verify removed from disk
    const saved = JSON.parse(readFileSync(channelsFile, "utf-8"));
    expect(saved["C123"]).toBeUndefined();
  });

  it("loadSessions reads existing channels.json", () => {
    writeFileSync(
      channelsFile,
      JSON.stringify({ "C-pre": "session-pre" })
    );
    loadSessions();
    expect(getSessionId("C-pre")).toBe("session-pre");
  });

  it("supports multiple channels", () => {
    loadSessions();
    setSessionId("C1", "s1");
    setSessionId("C2", "s2");
    setSessionId("C3", "s3");

    expect(getSessionId("C1")).toBe("s1");
    expect(getSessionId("C2")).toBe("s2");
    expect(getSessionId("C3")).toBe("s3");

    resetSession("C2");
    expect(getSessionId("C2")).toBeUndefined();
    expect(getSessionId("C1")).toBe("s1");
    expect(getSessionId("C3")).toBe("s3");
  });
});
