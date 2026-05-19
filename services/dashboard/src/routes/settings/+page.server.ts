import { redirect, type ServerLoad } from "@sveltejs/kit";
import { listActiveSessionsForUser } from "@friday/shared/services";
import {
  getDb,
  loadConfig,
  type Manifest,
  normalizeModelConfig,
  schema,
} from "@friday/shared";

export interface SessionSummary {
  id: string;
  createdAt: number;
  expiresAt: number;
  ipAddress: string | null;
  userAgent: string | null;
  isCurrent: boolean;
}

export interface SettingsSnapshot {
  model: string;
  watchdogRefork: boolean;
}

export interface AppSummary {
  id: string;
  name: string;
  version: string;
  status: string;
  installedAt: number;
  folderPath: string;
  agents: { name: string; type: string; status: string }[];
  schedules: { name: string; cron: string | null }[];
  mcpServers: { name: string }[];
}

async function loadApps(): Promise<AppSummary[]> {
  const db = getDb();
  // Phase 1 regression fix: under ADR-023 Drizzle Postgres these
  // queries return Promises; the original SQLite `.all()` shape was
  // synchronous. The page rendered an empty Apps panel because the
  // `rows.length === 0` check ran on a Promise (which is truthy and
  // doesn't have a `length`). `manifestJson` is jsonb now — Drizzle
  // returns the parsed value directly, so the inner `JSON.parse` was
  // double-parsing and the catch ate the error.
  const rows = await db.select().from(schema.apps);
  if (rows.length === 0) return [];
  const allAgents = await db.select().from(schema.agents);
  const allSchedules = await db.select().from(schema.schedules);
  return rows.map((r) => {
    const manifest: Manifest | null =
      r.manifestJson && typeof r.manifestJson === "object"
        ? (r.manifestJson as Manifest)
        : null;
    return {
      id: r.id,
      name: r.name,
      version: r.version,
      status: r.status,
      installedAt: r.installedAt.getTime(),
      folderPath: r.folderPath,
      agents: allAgents
        .filter((a) => a.appId === r.id)
        .map((a) => ({ name: a.name, type: a.type, status: a.status })),
      schedules: allSchedules
        .filter((s) => s.appId === r.id)
        .map((s) => ({ name: s.name, cron: s.cron })),
      mcpServers: (manifest?.mcpServers ?? []).map((m) => ({ name: m.name })),
    };
  });
}

export const load: ServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/login");

  // FIX_FORWARD 5.11: Active Sessions panel sources from the BetterAuth
  // session table (via the shared helper). The current session is
  // flagged so the UI can render "this device" affordances and the
  // post-revoke redirect.
  const rows = await listActiveSessionsForUser(locals.user.id);
  const sessions: SessionSummary[] = rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    ipAddress: r.ipAddress,
    userAgent: r.userAgent,
    isCurrent: locals.session?.id === r.id,
  }));

  // FIX_FORWARD 6.3: configurable knobs surfaced in the settings page.
  const cfg = loadConfig();
  const settings: SettingsSnapshot = {
    model: normalizeModelConfig(cfg.model).name,
    watchdogRefork: cfg.watchdog?.refork ?? false,
  };

  const apps = await loadApps();

  return { user: locals.user, sessions, settings, apps };
};
