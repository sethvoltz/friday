import { json, type RequestHandler } from "@sveltejs/kit";
import {
  coerceLegacyModelId,
  loadConfig,
  normalizeModelConfig,
  writeConfig,
  type AgentTypeName,
  type EvolveTaskName,
  type ModelConfig,
} from "@friday/shared";

/**
 * Settings GET/PATCH endpoints (FIX_FORWARD 6.3). The dashboard's
 * /settings page reads the current Friday config + writes user-toggled
 * fields back. Writes are atomic — the entire config is rewritten on
 * each PATCH so partial updates don't leave the file half-merged.
 *
 * Only a small allowlist of fields is patchable from the UI: anything
 * structural (mcpServers, daemon/dashboard ports, base URLs) still
 * requires editing `~/.friday/config.json` directly.
 *
 * FRI-16: per-role (`models`) and per-evolve-task (`evolveModels`)
 * override maps follow the Zero `updateSettings` mutator's three-state
 * convention — omitted preserves, `null` clears, a map replaces the
 * whole slot. Model ids are coerced through `coerceLegacyModelId` on
 * read (AC #22b) so a stored legacy `claude-haiku-4-5` surfaces as the
 * dated id the picker knows.
 */

// Runtime key sets for validating the override maps. Declared as
// exhaustive Records so extending the AgentTypeName / EvolveTaskName
// unions is a compile error here until the allowlist learns the new key.
const AGENT_ROLE_KEYS: Record<AgentTypeName, true> = {
  orchestrator: true,
  builder: true,
  helper: true,
  scheduled: true,
  bare: true,
  planner: true,
};
const EVOLVE_TASK_KEYS: Record<EvolveTaskName, true> = {
  enrich: true,
  scanFriction: true,
  scanPreferences: true,
};

type OverrideMap<K extends string> = Partial<Record<K, string | ModelConfig>>;

/**
 * Validate a PATCH override map against its key allowlist. Returns
 * `undefined` for "field absent / unusable" (preserve), `null` for an
 * explicit clear, else the map filtered down to known keys whose values
 * are non-empty strings or `{name}`-shaped ModelConfig objects. Unknown
 * keys and malformed values are dropped rather than 400ing — matching
 * the endpoint's lenient handling of the existing scalar fields.
 */
function sanitizeOverrides<K extends string>(
  input: unknown,
  allowed: Record<K, true>,
): OverrideMap<K> | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: OverrideMap<K> = {};
  for (const key of Object.keys(allowed) as K[]) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    } else if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { name?: unknown }).name === "string" &&
      (value as { name: string }).name.length > 0
    ) {
      out[key] = value as ModelConfig;
    }
  }
  return out;
}

/** Response shape for the pickers: model NAME per slot (ModelConfig
 *  forms collapse to `.name`), legacy ids coerced to their dated form. */
function displayOverrides<K extends string>(
  map: OverrideMap<K> | undefined,
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const [key, value] of Object.entries(map ?? {})) {
    if (value == null) continue;
    out[key as K] = coerceLegacyModelId(normalizeModelConfig(value as string | ModelConfig).name);
  }
  return out;
}

export const GET: RequestHandler = ({ locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const cfg = loadConfig();
  return json({
    model: coerceLegacyModelId(normalizeModelConfig(cfg.model).name),
    watchdogRefork: cfg.watchdog?.refork ?? false,
    models: displayOverrides(cfg.models),
    evolveModels: displayOverrides(cfg.evolve?.models),
  });
};

interface SettingsPatch {
  model?: string;
  watchdogRefork?: boolean;
  models?: OverrideMap<AgentTypeName> | null;
  evolveModels?: OverrideMap<EvolveTaskName> | null;
}

export const PATCH: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) return new Response("unauthorized", { status: 401 });
  const body = (await request.json().catch(() => ({}))) as SettingsPatch;
  const cfg = loadConfig();

  if (typeof body.model === "string" && body.model.length > 0) {
    // Coerce at the write boundary — parity with the Zero mutator
    // (FRI-16 AC #22b) so the stored value always matches the
    // dashboard's MODEL_OPTIONS ids.
    cfg.model = coerceLegacyModelId(body.model);
  }
  if (typeof body.watchdogRefork === "boolean") {
    cfg.watchdog = { ...(cfg.watchdog ?? {}), refork: body.watchdogRefork };
  }

  // FRI-16: override maps — whole-map replace, like the Zero mutator.
  // A `null` (or a map that validates down to empty) clears the slot;
  // the key is removed from config.json rather than left as `{}`.
  const models = sanitizeOverrides(body.models, AGENT_ROLE_KEYS);
  if (models !== undefined) {
    if (models === null || Object.keys(models).length === 0) {
      delete cfg.models;
    } else {
      cfg.models = models;
    }
  }
  const evolveModels = sanitizeOverrides(body.evolveModels, EVOLVE_TASK_KEYS);
  if (evolveModels !== undefined) {
    if (evolveModels === null || Object.keys(evolveModels).length === 0) {
      if (cfg.evolve) delete cfg.evolve.models;
    } else {
      cfg.evolve = { ...(cfg.evolve ?? {}), models: evolveModels };
    }
  }

  writeConfig(cfg);
  return json({
    ok: true,
    model: coerceLegacyModelId(normalizeModelConfig(cfg.model).name),
    watchdogRefork: cfg.watchdog?.refork ?? false,
    models: displayOverrides(cfg.models),
    evolveModels: displayOverrides(cfg.evolve?.models),
  });
};
