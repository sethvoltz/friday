import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockLoadConfig = vi.fn();
const mockLoadDotenv = vi.fn();

vi.mock("@friday/shared", () => ({
  loadConfig: (...args: any[]) => mockLoadConfig(...args),
  ENV_PATH: "/fake/.friday/.env",
}));

vi.mock("dotenv", () => ({
  config: (...args: any[]) => mockLoadDotenv(...args),
}));

const { loadRuntimeConfig } = await import("./config.js");

describe("loadRuntimeConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    mockLoadConfig.mockReturnValue({
      slack: { orchestratorChannelId: "C999" },
      agent: { model: "opus" },
      monitoring: {},
      slack_formatting: { emojiReactions: {} },
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns merged config with tokens when all present", () => {
    process.env.SLACK_APP_TOKEN = "xapp-test";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";

    const result = loadRuntimeConfig();

    expect(mockLoadDotenv).toHaveBeenCalledWith({ path: "/fake/.friday/.env" });
    expect(result.slackAppToken).toBe("xapp-test");
    expect(result.slackBotToken).toBe("xoxb-test");
    expect(result.slack.orchestratorChannelId).toBe("C999");
  });

  it("exits when SLACK_APP_TOKEN is missing", () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    delete process.env.SLACK_APP_TOKEN;

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
    const mockErr = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => loadRuntimeConfig()).toThrow("process.exit");
    expect(mockErr).toHaveBeenCalledWith(expect.stringContaining("SLACK_APP_TOKEN"));

    mockExit.mockRestore();
    mockErr.mockRestore();
  });

  it("exits when SLACK_BOT_TOKEN is missing", () => {
    process.env.SLACK_APP_TOKEN = "xapp-test";
    delete process.env.SLACK_BOT_TOKEN;

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
    const mockErr = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => loadRuntimeConfig()).toThrow("process.exit");

    mockExit.mockRestore();
    mockErr.mockRestore();
  });

  it("exits when orchestratorChannelId is missing", () => {
    process.env.SLACK_APP_TOKEN = "xapp-test";
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    mockLoadConfig.mockReturnValue({
      slack: { orchestratorChannelId: "" },
      agent: {},
      monitoring: {},
      slack_formatting: { emojiReactions: {} },
    });

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as any);
    const mockErr = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => loadRuntimeConfig()).toThrow("process.exit");
    expect(mockErr).toHaveBeenCalledWith(expect.stringContaining("orchestratorChannelId"));

    mockExit.mockRestore();
    mockErr.mockRestore();
  });
});
