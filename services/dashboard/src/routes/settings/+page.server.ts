import { redirect, type ServerLoad } from "@sveltejs/kit";
import { listActiveSessionsForUser } from "@friday/shared/services";
import { loadConfig, normalizeModelConfig } from "@friday/shared";

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

export const load: ServerLoad = async ({ locals }) => {
  if (!locals.user) throw redirect(302, "/login");

  // FIX_FORWARD 5.11: Active Sessions panel sources from the BetterAuth
  // session table (via the shared helper). The current session is
  // flagged so the UI can render "this device" affordances and the
  // post-revoke redirect.
  const rows = listActiveSessionsForUser(locals.user.id);
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

  return { user: locals.user, sessions, settings };
};
