import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { SESSIONS_DIR } from "@friday/shared";
import { join } from "node:path";
import { log } from "../log.js";

const CHANNELS_FILE = join(SESSIONS_DIR, "channels.json");
const HISTORY_FILE = join(SESSIONS_DIR, "channel-history.json");

interface ChannelSessions {
  [channelId: string]: string; // channelId → sessionId
}

interface ChannelHistory {
  [channelId: string]: string[]; // channelId → former sessionIds (most recent first)
}

let sessions: ChannelSessions = {};
let history: ChannelHistory = {};

export function loadSessions(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }
  if (existsSync(CHANNELS_FILE)) {
    sessions = JSON.parse(readFileSync(CHANNELS_FILE, "utf-8"));
    log("info", "sessions_loaded", {
      count: Object.keys(sessions).length,
    });
  }
  if (existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(readFileSync(HISTORY_FILE, "utf-8")); } catch { /* skip */ }
  }
}

function saveSessions(): void {
  writeFileSync(CHANNELS_FILE, JSON.stringify(sessions, null, 2));
}

function saveHistory(): void {
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

export function getSessionId(channelId: string): string | undefined {
  return sessions[channelId];
}

export function setSessionId(channelId: string, sessionId: string): void {
  sessions[channelId] = sessionId;
  saveSessions();
}

export function resetSession(channelId: string): void {
  const oldSessionId = sessions[channelId];
  if (oldSessionId) {
    if (!history[channelId]) history[channelId] = [];
    history[channelId].unshift(oldSessionId);
    saveHistory();
  }
  delete sessions[channelId];
  saveSessions();
}

/** For testing */
export function _resetForTesting(): void {
  sessions = {};
  history = {};
}
