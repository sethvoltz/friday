import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const FRIDAY_DIR = join(homedir(), ".friday");
export const CONFIG_PATH = join(FRIDAY_DIR, "config.json");
export const ENV_PATH = join(FRIDAY_DIR, ".env");
export const SESSIONS_DIR = join(FRIDAY_DIR, "sessions");
export const USAGE_LOG_PATH = join(FRIDAY_DIR, "usage.jsonl");

export interface SlackConfig {
  orchestratorChannelId: string;
}

export interface AgentConfig {
  workingDirectory: string;
  allowedTools: string[];
  permissionMode: string;
  model: string;
  systemPrompt?: string;
}

export interface EmojiConfig {
  processing: string;
  queued: string;
  error: string;
  complete: string | null;
}

export interface SlackFormattingConfig {
  maxMessageLength: number;
  streamingEnabled: boolean;
  emojiReactions: EmojiConfig;
}

export interface MonitoringConfig {
  usageLogFile: string;
  warnAtPercentOfDailyLimit: number;
}

export interface FridayConfig {
  slack: SlackConfig;
  agent: AgentConfig;
  independentAgent?: Partial<AgentConfig>;
  slack_formatting: SlackFormattingConfig;
  monitoring: MonitoringConfig;
}

const DEFAULT_CONFIG: FridayConfig = {
  slack: {
    orchestratorChannelId: "",
  },
  agent: {
    workingDirectory: join(homedir(), "Development"),
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"],
    permissionMode: "auto-accept",
    model: "claude-sonnet-4-6",
  },
  independentAgent: {
    allowedTools: ["Read", "Glob", "Grep"],
    permissionMode: "auto-accept",
  },
  slack_formatting: {
    maxMessageLength: 4000,
    streamingEnabled: true,
    emojiReactions: {
      processing: "eyes",
      queued: "clock1",
      error: "x",
      complete: null,
    },
  },
  monitoring: {
    usageLogFile: USAGE_LOG_PATH,
    warnAtPercentOfDailyLimit: 80,
  },
};

export function loadConfig(): FridayConfig {
  if (!existsSync(CONFIG_PATH)) {
    return DEFAULT_CONFIG;
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const userConfig = JSON.parse(raw) as Partial<FridayConfig>;
  return {
    slack: { ...DEFAULT_CONFIG.slack, ...userConfig.slack },
    agent: { ...DEFAULT_CONFIG.agent, ...userConfig.agent },
    independentAgent: userConfig.independentAgent !== undefined
      ? { ...DEFAULT_CONFIG.independentAgent, ...userConfig.independentAgent }
      : DEFAULT_CONFIG.independentAgent,
    slack_formatting: {
      ...DEFAULT_CONFIG.slack_formatting,
      ...userConfig.slack_formatting,
      emojiReactions: {
        ...DEFAULT_CONFIG.slack_formatting.emojiReactions,
        ...userConfig.slack_formatting?.emojiReactions,
      },
    },
    monitoring: { ...DEFAULT_CONFIG.monitoring, ...userConfig.monitoring },
  };
}
