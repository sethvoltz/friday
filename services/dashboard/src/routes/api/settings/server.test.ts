/**
 * Contract test for /api/settings — the REST settings read/write
 * endpoint (FRI-16 §6e / AC #21 + AC #22b GET half). Verifies:
 *   1. 401 when there's no session in locals.
 *   2. GET shape: global model + watchdog + the per-role / per-task
 *      override maps (name-extracted, legacy-id coerced).
 *   3. PATCH round-trip: override maps land in config.json and read
 *      back through GET; `null` clears; unknown keys / malformed
 *      values are dropped against the AgentTypeName / EvolveTaskName
 *      allowlists.
 *   4. Legacy `claude-haiku-4-5` coerces to the dated id on read
 *      (idempotent) and at the PATCH write boundary (mutator parity).
 *
 * Drives the endpoint module directly with a stub `RequestEvent` —
 * lighter than spinning up a real HTTP listener (same pattern as
 * routes/api/sync/refresh/server.test.ts).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Bind the shared config machinery to a scratch dir BEFORE any
// @friday/shared import — CONFIG_PATH is captured at module load.
// Both the endpoint and the shared helpers are imported dynamically
// in beforeAll so this assignment wins.
const dataDir = mkdtempSync(join(tmpdir(), "friday-settings-api-"));
process.env.FRIDAY_DATA_DIR = dataDir;

let endpoint: typeof import("./+server.js");
let shared: typeof import("@friday/shared");

beforeAll(async () => {
  shared = await import("@friday/shared");
  endpoint = await import("./+server.js");
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh defaults per test — loadConfig() falls back to DEFAULT_CONFIG
  // when the file is absent.
  rmSync(join(dataDir, "config.json"), { force: true });
});

const user = { id: "user-1", email: "u@x", name: "U" };

interface SettingsBody {
  ok?: boolean;
  model: string;
  watchdogRefork: boolean;
  models: Record<string, string>;
  evolveModels: Record<string, string>;
}

async function callGet(opts: { user?: typeof user | null } = {}): Promise<Response> {
  const event = { locals: { user: opts.user === undefined ? user : opts.user } };
  return (endpoint.GET as unknown as (e: typeof event) => Response | Promise<Response>)(event);
}

async function callPatch(
  body: unknown,
  opts: { user?: typeof user | null } = {},
): Promise<Response> {
  const event = {
    locals: { user: opts.user === undefined ? user : opts.user },
    request: new Request("http://localhost/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
  return (endpoint.PATCH as unknown as (e: typeof event) => Response | Promise<Response>)(event);
}

describe("/api/settings", () => {
  it("GET returns 401 without a session", async () => {
    const r = await callGet({ user: null });
    expect(r.status).toBe(401);
  });

  it("PATCH returns 401 without a session", async () => {
    const r = await callPatch({ model: "claude-sonnet-4-6" }, { user: null });
    expect(r.status).toBe(401);
  });

  it("GET on a fresh config returns the global default with empty override maps", async () => {
    const r = await callGet();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      model: "claude-opus-4-7",
      watchdogRefork: true, // DEFAULT_CONFIG: refork on by default (FIX_FORWARD 4.3)
      models: {},
      evolveModels: {},
    });
  });

  it("PATCH models/evolveModels round-trips through GET and config.json (AC #21)", async () => {
    const models = { builder: "claude-sonnet-4-6", planner: "claude-opus-4-8" };
    const evolveModels = {
      enrich: "claude-sonnet-4-6",
      scanFriction: "claude-haiku-4-5-20251001",
    };
    const patched = await callPatch({ models, evolveModels });
    expect(patched.status).toBe(200);
    const patchBody = (await patched.json()) as SettingsBody;
    expect(patchBody.ok).toBe(true);
    expect(patchBody.models).toEqual(models);
    expect(patchBody.evolveModels).toEqual(evolveModels);

    const got = (await (await callGet()).json()) as SettingsBody;
    expect(got.models).toEqual(models);
    expect(got.evolveModels).toEqual(evolveModels);

    // Canonical file persisted the exact maps.
    const cfg = shared.loadConfig();
    expect(cfg.models).toEqual(models);
    expect(cfg.evolve?.models).toEqual(evolveModels);
  });

  it("PATCH null clears the override maps (and removes the config.json keys)", async () => {
    await callPatch({
      models: { builder: "claude-sonnet-4-6" },
      evolveModels: { enrich: "claude-sonnet-4-6" },
    });
    const cleared = await callPatch({ models: null, evolveModels: null });
    expect(cleared.status).toBe(200);
    const body = (await cleared.json()) as SettingsBody;
    expect(body.models).toEqual({});
    expect(body.evolveModels).toEqual({});

    const cfg = shared.loadConfig();
    expect("models" in cfg && cfg.models !== undefined).toBe(false);
    expect(cfg.evolve?.models).toBeUndefined();
  });

  it("PATCH validates override keys against the role/task unions and drops malformed values", async () => {
    const r = await callPatch({
      models: {
        builder: "claude-sonnet-4-6",
        bogusRole: "claude-opus-4-8", // unknown key — dropped
        helper: "", // empty string — dropped
        scheduled: 42, // wrong type — dropped
      },
      evolveModels: {
        scanFriction: "claude-haiku-4-5-20251001",
        nonsenseTask: "claude-opus-4-8", // unknown key — dropped
        enrich: { notName: "x" }, // ModelConfig without name — dropped
      },
    });
    const body = (await r.json()) as SettingsBody;
    expect(body.models).toEqual({ builder: "claude-sonnet-4-6" });
    expect(body.evolveModels).toEqual({ scanFriction: "claude-haiku-4-5-20251001" });

    const cfg = shared.loadConfig();
    expect(cfg.models).toEqual({ builder: "claude-sonnet-4-6" });
    expect(cfg.evolve?.models).toEqual({ scanFriction: "claude-haiku-4-5-20251001" });
  });

  it("PATCH accepts ModelConfig object values; GET extracts .name for display", async () => {
    const builderCfg = { name: "claude-sonnet-4-6", effort: "high" };
    await callPatch({ models: { builder: builderCfg } });

    // Stored verbatim (polymorphic form preserved for hand-edited configs)…
    const cfg = shared.loadConfig();
    expect(cfg.models).toEqual({ builder: builderCfg });

    // …but surfaced as the bare name for the picker.
    const got = (await (await callGet()).json()) as SettingsBody;
    expect(got.models).toEqual({ builder: "claude-sonnet-4-6" });
  });

  it("GET coerces legacy claude-haiku-4-5 ids to the dated form, idempotently (AC #22b)", async () => {
    const cfg = shared.loadConfig();
    cfg.model = "claude-haiku-4-5";
    cfg.models = { helper: "claude-haiku-4-5", builder: "claude-haiku-4-5-20251001" };
    cfg.evolve = { models: { enrich: "claude-haiku-4-5" } };
    shared.writeConfig(cfg);

    const got = (await (await callGet()).json()) as SettingsBody;
    expect(got.model).toBe("claude-haiku-4-5-20251001");
    expect(got.models).toEqual({
      helper: "claude-haiku-4-5-20251001",
      builder: "claude-haiku-4-5-20251001", // dated id passes through unchanged
    });
    expect(got.evolveModels).toEqual({ enrich: "claude-haiku-4-5-20251001" });

    // Idempotent: a second read returns the identical body.
    expect((await (await callGet()).json()) as SettingsBody).toEqual(got);
  });

  it("PATCH coerces the legacy global model id at the write boundary (mutator parity)", async () => {
    const r = await callPatch({ model: "claude-haiku-4-5" });
    const body = (await r.json()) as SettingsBody;
    expect(body.model).toBe("claude-haiku-4-5-20251001");
    expect(shared.loadConfig().model).toBe("claude-haiku-4-5-20251001");
  });

  it("PATCH with only scalar fields preserves the override maps (omitted = preserve)", async () => {
    const models = { orchestrator: "claude-opus-4-8" };
    const evolveModels = { scanPreferences: "claude-haiku-4-5-20251001" };
    await callPatch({ models, evolveModels });

    const r = await callPatch({ watchdogRefork: true });
    const body = (await r.json()) as SettingsBody;
    expect(body.watchdogRefork).toBe(true);
    expect(body.models).toEqual(models);
    expect(body.evolveModels).toEqual(evolveModels);
  });

  it("PATCH with an empty model string leaves the stored model unchanged", async () => {
    await callPatch({ model: "claude-sonnet-4-6" });
    const r = await callPatch({ model: "" });
    const body = (await r.json()) as SettingsBody;
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(shared.loadConfig().model).toBe("claude-sonnet-4-6");
  });
});
