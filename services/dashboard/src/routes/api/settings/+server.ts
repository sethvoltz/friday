import { json, type RequestHandler } from "@sveltejs/kit";
import { loadConfig, writeConfig, normalizeModelConfig } from "@friday/shared";

/**
 * Settings GET/PATCH endpoints (FIX_FORWARD 6.3). The dashboard's
 * /settings page reads the current Friday config + writes user-toggled
 * fields back. Writes are atomic — the entire config is rewritten on
 * each PATCH so partial updates don't leave the file half-merged.
 *
 * Only a small allowlist of fields is patchable from the UI: anything
 * structural (mcpServers, daemon/dashboard ports, base URLs) still
 * requires editing `~/.friday/config.json` directly.
 */

export const GET: RequestHandler = ({ locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const cfg = loadConfig();
  return json({
    model: normalizeModelConfig(cfg.model).name,
    watchdogRefork: cfg.watchdog?.refork ?? false,
  });
};

interface SettingsPatch {
  model?: string;
  watchdogRefork?: boolean;
}

export const PATCH: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = (await request.json().catch(() => ({}))) as SettingsPatch;
  const cfg = loadConfig();

  if (typeof body.model === "string" && body.model.length > 0) {
    cfg.model = body.model;
  }
  if (typeof body.watchdogRefork === "boolean") {
    cfg.watchdog = { ...(cfg.watchdog ?? {}), refork: body.watchdogRefork };
  }

  writeConfig(cfg);
  return json({
    ok: true,
    model: normalizeModelConfig(cfg.model).name,
    watchdogRefork: cfg.watchdog?.refork ?? false,
  });
};
