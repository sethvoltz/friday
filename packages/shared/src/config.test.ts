import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We need to mock the homedir so loadConfig reads from our temp dir
const testDir = join(tmpdir(), `friday-test-${process.pid}-${Date.now()}`);
const fridayDir = join(testDir, ".friday");

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => testDir };
});

// Import AFTER the mock is set up
const { loadConfig, CONFIG_PATH, FRIDAY_DIR, USAGE_LOG_PATH, SESSIONS_DIR, ENV_PATH } =
  await import("./config.js");

describe("path constants", () => {
  it("derives all paths from homedir", () => {
    expect(FRIDAY_DIR).toBe(fridayDir);
    expect(CONFIG_PATH).toBe(join(fridayDir, "config.json"));
    expect(ENV_PATH).toBe(join(fridayDir, ".env"));
    expect(USAGE_LOG_PATH).toBe(join(fridayDir, "usage.jsonl"));
    expect(SESSIONS_DIR).toBe(join(fridayDir, "sessions"));
  });
});

describe("loadConfig", () => {
  beforeEach(() => {
    mkdirSync(fridayDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", () => {
    const config = loadConfig();
    expect(config.slack.orchestratorChannelId).toBe("");
    expect(config.agent.model).toBe("claude-sonnet-4-6");
    expect(config.agent.allowedTools).toContain("Read");
    expect(config.slack_formatting.maxMessageLength).toBe(4000);
    expect(config.slack_formatting.streamingEnabled).toBe(true);
    expect(config.slack_formatting.thinkingIndicatorDelaySec).toBe(30);
    expect(config.monitoring.warnAtPercentOfDailyLimit).toBe(80);
  });

  it("allows overriding thinkingIndicatorDelaySec", () => {
    writeFileSync(
      join(fridayDir, "config.json"),
      JSON.stringify({
        slack_formatting: { thinkingIndicatorDelaySec: 10 },
      })
    );
    const config = loadConfig();
    expect(config.slack_formatting.thinkingIndicatorDelaySec).toBe(10);
    // Other defaults preserved
    expect(config.slack_formatting.maxMessageLength).toBe(4000);
    expect(config.slack_formatting.streamingEnabled).toBe(true);
  });

  it("deep-merges user config — overriding one agent field preserves siblings", () => {
    writeFileSync(
      join(fridayDir, "config.json"),
      JSON.stringify({
        agent: { model: "claude-opus-4-6" },
      })
    );
    const config = loadConfig();
    // Overridden field
    expect(config.agent.model).toBe("claude-opus-4-6");
    // Sibling fields preserved from defaults
    expect(config.agent.allowedTools).toContain("Read");
    expect(config.agent.allowedTools).toContain("Bash");
    expect(config.agent.workingDirectory).toBeTruthy();
    expect(config.agent.permissionMode).toBe("auto-accept");
  });

  it("deep-merges slack config without losing defaults", () => {
    writeFileSync(
      join(fridayDir, "config.json"),
      JSON.stringify({
        slack: { orchestratorChannelId: "C123" },
      })
    );
    const config = loadConfig();
    expect(config.slack.orchestratorChannelId).toBe("C123");
    // Other top-level sections intact
    expect(config.agent.model).toBe("claude-sonnet-4-6");
    expect(config.slack_formatting.maxMessageLength).toBe(4000);
  });

  it("deep-merges emoji reactions within slack_formatting", () => {
    writeFileSync(
      join(fridayDir, "config.json"),
      JSON.stringify({
        slack_formatting: {
          emojiReactions: { processing: "hourglass" },
        },
      })
    );
    const config = loadConfig();
    expect(config.slack_formatting.emojiReactions.processing).toBe("hourglass");
    // Other emoji defaults preserved
    expect(config.slack_formatting.emojiReactions.queued).toBe("clock1");
    expect(config.slack_formatting.emojiReactions.error).toBe("x");
    // Parent defaults preserved
    expect(config.slack_formatting.maxMessageLength).toBe(4000);
  });

  it("has correct defaults for status reaction emojis", () => {
    const config = loadConfig();
    const r = config.slack_formatting.emojiReactions;
    expect(r.thinking).toBe("thinking_face");
    expect(r.toolCoding).toBe("technologist");
    expect(r.toolWeb).toBe("zap");
    expect(r.toolGeneric).toBe("fire");
    expect(r.compacting).toBe("writing_hand");
  });

  it("allows overriding individual status reaction emojis", () => {
    writeFileSync(
      join(fridayDir, "config.json"),
      JSON.stringify({
        slack_formatting: {
          emojiReactions: { thinking: "brain", toolCoding: "computer" },
        },
      })
    );
    const config = loadConfig();
    expect(config.slack_formatting.emojiReactions.thinking).toBe("brain");
    expect(config.slack_formatting.emojiReactions.toolCoding).toBe("computer");
    // Other new fields still have defaults
    expect(config.slack_formatting.emojiReactions.toolWeb).toBe("zap");
    expect(config.slack_formatting.emojiReactions.compacting).toBe("writing_hand");
    // Original fields intact
    expect(config.slack_formatting.emojiReactions.processing).toBe("eyes");
  });

  it("preserves full agent config when all fields overridden", () => {
    writeFileSync(
      join(fridayDir, "config.json"),
      JSON.stringify({
        agent: {
          workingDirectory: "/tmp/test",
          allowedTools: ["Read"],
          permissionMode: "auto-accept",
          model: "claude-haiku-4-5",
          systemPrompt: "You are a test agent.",
        },
      })
    );
    const config = loadConfig();
    expect(config.agent.workingDirectory).toBe("/tmp/test");
    expect(config.agent.systemPrompt).toBe("You are a test agent.");
    expect(config.agent.allowedTools).toEqual(["Read"]);
    expect(config.agent.model).toBe("claude-haiku-4-5");
  });

  it("returns default independentAgent when not overridden", () => {
    writeFileSync(
      join(fridayDir, "config.json"),
      JSON.stringify({ slack: { orchestratorChannelId: "C1" } })
    );
    const config = loadConfig();
    expect(config.independentAgent).toBeDefined();
    expect(config.independentAgent!.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(config.independentAgent!.permissionMode).toBe("auto-accept");
  });

  it("deep-merges independentAgent — overriding one field preserves siblings", () => {
    writeFileSync(
      join(fridayDir, "config.json"),
      JSON.stringify({
        independentAgent: { allowedTools: ["Read", "Write"] },
      })
    );
    const config = loadConfig();
    expect(config.independentAgent!.allowedTools).toEqual(["Read", "Write"]);
    // Default permissionMode preserved
    expect(config.independentAgent!.permissionMode).toBe("auto-accept");
  });

  it("handles malformed JSON gracefully by throwing", () => {
    writeFileSync(join(fridayDir, "config.json"), "{ not valid json }");
    expect(() => loadConfig()).toThrow();
  });
});
