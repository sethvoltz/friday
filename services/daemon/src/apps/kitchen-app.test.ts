/**
 * Kitchen Friday App — storage + MCP-tool + install tests.
 *
 * The app's MCP server, storage layer, and tool handlers live in
 * `apps/kitchen/mcp/`. Tests import them by relative path and exercise:
 *
 *   - storage.js: atomic-rename writes, missing-file init, validation
 *   - tools.js:   every tool handler against a fresh storage
 *   - installer:  install the manifest into a tmp FRIDAY_DATA_DIR
 *
 * No actual MCP transport is spawned — the SDK runtime is exercised in the
 * platform's own tests. Here we cover what's specific to this app.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = mkdtempSync(join(tmpdir(), "friday-kitchen-app-"));
process.env.FRIDAY_DATA_DIR = dataDir;

vi.mock("../agent/lifecycle.js", () => ({
  archiveAgent: vi.fn(async () => []),
}));

const { runMigrations, closeDb, getRawDb, getDb, schema, appDir } =
  await import("@friday/shared");
const registry = await import("../agent/registry.js");
const { installApp, inspectApp } = await import("./installer.js");

// @ts-expect-error — JS module outside daemon rootDir; vitest resolves it fine
const storageModule = await import("../../../../apps/kitchen/mcp/storage.js");
// @ts-expect-error — JS module outside daemon rootDir
const toolsModule = await import("../../../../apps/kitchen/mcp/tools.js");

const { createStorage, KitchenStorageError } = storageModule;
const { buildTools } = toolsModule;

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_SRC = resolve(__dirname, "../../../../apps/kitchen");

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  const raw = getRawDb();
  raw.prepare("DELETE FROM blocks").run();
  raw.prepare("DELETE FROM schedules").run();
  raw.prepare("DELETE FROM agents").run();
  raw.prepare("DELETE FROM apps").run();
  const appsRoot = appDir("");
  if (existsSync(appsRoot)) rmSync(appsRoot, { recursive: true, force: true });
});

function freshStorageDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kitchen-storage-"));
  return dir;
}

describe("storage: recipes", () => {
  it("returns [] when recipes.json is missing", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    expect(s.listRecipes()).toEqual([]);
    expect(existsSync(join(dir, "recipes.json"))).toBe(false);
  });

  it("adds a recipe and persists exact field values", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    const added = s.addRecipe({
      title: "Tom Kha Gai",
      ingredients: ["coconut milk", "galangal", "chicken"],
      method: "Simmer aromatics, add chicken, finish with lime.",
      activeTime: 25,
      tags: ["thai", "soup", "weeknight"],
      notes: "double the lime",
    });
    expect(added.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(added.title).toBe("Tom Kha Gai");
    expect(added.status).toBe("active");
    expect(added.tags).toEqual(["thai", "soup", "weeknight"]);

    // Persisted file matches exactly
    const onDisk = JSON.parse(readFileSync(join(dir, "recipes.json"), "utf8"));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toMatchObject({
      title: "Tom Kha Gai",
      ingredients: ["coconut milk", "galangal", "chicken"],
      activeTime: 25,
      tags: ["thai", "soup", "weeknight"],
      status: "active",
      notes: "double the lime",
    });
  });

  it("filters by tags (entries must include ALL tags) and status", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    s.addRecipe({ title: "Thai Soup", tags: ["thai", "soup"] });
    s.addRecipe({ title: "Thai Curry", tags: ["thai", "curry"] });
    s.addRecipe({ title: "French Soup", tags: ["french", "soup"] });
    const deferred = s.addRecipe({
      title: "Retired Stew",
      tags: ["stew"],
      status: "deferred",
    });

    const thai = s.listRecipes({ tags: ["thai"] }).map((r: any) => r.title);
    expect(thai.sort()).toEqual(["Thai Curry", "Thai Soup"]);

    const thaiSoup = s.listRecipes({ tags: ["thai", "soup"] }).map((r: any) => r.title);
    expect(thaiSoup).toEqual(["Thai Soup"]);

    const active = s.listRecipes({ status: "active" }).map((r: any) => r.title);
    expect(active).toHaveLength(3);
    expect(active).not.toContain("Retired Stew");

    const deferredList = s.listRecipes({ status: "deferred" });
    expect(deferredList).toHaveLength(1);
    expect(deferredList[0].id).toBe(deferred.id);
  });

  it("updates merge over existing fields and re-validates shape", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    const r = s.addRecipe({ title: "Pad See Ew", tags: ["thai"] });
    const updated = s.updateRecipe(r.id, { activeTime: 20, tags: ["thai", "noodles"] });
    expect(updated.title).toBe("Pad See Ew"); // preserved
    expect(updated.activeTime).toBe(20);
    expect(updated.tags).toEqual(["thai", "noodles"]);
  });

  it("rejects invalid status on update", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    const r = s.addRecipe({ title: "X" });
    expect(() => s.updateRecipe(r.id, { status: "bogus" })).toThrowError(
      /status must be/,
    );
  });

  it("archive sets status to deferred and preserves the row", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    const r = s.addRecipe({ title: "Boring Stew" });
    const archived = s.archiveRecipe(r.id);
    expect(archived.status).toBe("deferred");
    expect(s.listRecipes({ status: "active" })).toEqual([]);
    expect(s.listRecipes({ status: "deferred" })).toHaveLength(1);
  });

  it("rejects duplicate ids on add", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    s.addRecipe({ id: "fixed", title: "A" });
    expect(() => s.addRecipe({ id: "fixed", title: "B" })).toThrowError(
      /already exists/,
    );
  });

  it("throws KitchenStorageError on unknown id update", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    try {
      s.updateRecipe("ghost", { title: "x" });
      throw new Error("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(KitchenStorageError);
      expect(err.code).toBe("not_found");
    }
  });
});

describe("storage: atomic writes", () => {
  it("does not leave a .tmp file behind on success", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    s.addRecipe({ title: "Atom Bomb" });
    const files = readdirSync(dir);
    expect(files.filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(files).toContain("recipes.json");
  });

  it("preserves prior contents when a corrupt file is read", () => {
    const dir = freshStorageDir();
    writeFileSync(join(dir, "recipes.json"), "{ not valid json");
    const s = createStorage(dir);
    try {
      s.listRecipes();
      throw new Error("should have thrown");
    } catch (err: any) {
      expect(err).toBeInstanceOf(KitchenStorageError);
      expect(err.code).toBe("corrupt_file");
    }
    // File untouched
    expect(readFileSync(join(dir, "recipes.json"), "utf8")).toBe(
      "{ not valid json",
    );
  });
});

describe("storage: routines", () => {
  it("add + list + update round trip", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    const r = s.addRoutine({
      name: "Soup Sunday",
      dayOfWeek: "sun",
      notes: "always a brothy thing",
    });
    expect(s.listRoutines()).toHaveLength(1);
    const patched = s.updateRoutine(r.id, { timeBudgetMin: 45 });
    expect(patched.timeBudgetMin).toBe(45);
    expect(patched.name).toBe("Soup Sunday");
  });
});

describe("storage: menus (per-week files)", () => {
  it("saves menus/<weekId>.json and reads them back", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    const saved = s.saveMenu({
      weekId: "2026-W21",
      monDate: "2026-05-18",
      nights: [
        {
          day: "Mon",
          dish: "Tom Kha Gai",
          prepSummary: "Coconut soup",
          activeTime: 25,
          weatherNote: "cool evening",
        },
      ],
      rationale: "easing into the week",
    });
    expect(saved.weekId).toBe("2026-W21");
    expect(existsSync(join(dir, "menus", "2026-W21.json"))).toBe(true);

    const got = s.getMenu("2026-W21");
    expect(got).not.toBeNull();
    expect(got.nights).toHaveLength(1);
    expect(got.nights[0]).toMatchObject({ day: "Mon", dish: "Tom Kha Gai" });
    expect(got.rationale).toBe("easing into the week");
  });

  it("returns null when no menu file exists for a week", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    expect(s.getMenu("2026-W30")).toBeNull();
  });

  it("rejects malformed weekId", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    expect(() => s.getMenu("not-a-week")).toThrowError(/ISO-week/);
    expect(() =>
      s.saveMenu({ weekId: "2026-99", monDate: "2026-05-18", nights: [] }),
    ).toThrowError(/ISO week/);
  });

  it("listRecentMenus returns newest-first, respects limit", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    for (const w of ["2026-W19", "2026-W20", "2026-W21", "2026-W22"]) {
      s.saveMenu({ weekId: w, monDate: "2026-05-18", nights: [] });
    }
    const recent = s.listRecentMenus({ limit: 2 });
    expect(recent.map((m: any) => m.weekId)).toEqual(["2026-W22", "2026-W21"]);
  });

  it("overwrites the same week on save (drafts refresh)", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    s.saveMenu({
      weekId: "2026-W21",
      monDate: "2026-05-18",
      nights: [{ day: "Mon", dish: "Old" }],
    });
    s.saveMenu({
      weekId: "2026-W21",
      monDate: "2026-05-18",
      nights: [{ day: "Mon", dish: "New" }],
      rationale: "refreshed",
    });
    const got = s.getMenu("2026-W21");
    expect(got.nights[0].dish).toBe("New");
    expect(got.rationale).toBe("refreshed");
    // Still only one file for that week
    expect(readdirSync(join(dir, "menus"))).toEqual(["2026-W21.json"]);
  });
});

describe("storage: history", () => {
  it("add + list newest-first; sinceDate filter", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    s.addHistory({ date: "2026-05-10", dishTitle: "A", plannedVsActual: "planned" });
    s.addHistory({ date: "2026-05-12", dishTitle: "B", plannedVsActual: "swap" });
    s.addHistory({ date: "2026-05-15", dishTitle: "C", plannedVsActual: "takeout" });

    const all = s.listHistory();
    expect(all.map((e: any) => e.date)).toEqual([
      "2026-05-15",
      "2026-05-12",
      "2026-05-10",
    ]);

    const recent = s.listHistory({ sinceDate: "2026-05-12" });
    expect(recent.map((e: any) => e.date)).toEqual(["2026-05-15", "2026-05-12"]);

    const limited = s.listHistory({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].date).toBe("2026-05-15");
  });

  it("rejects bad date or plannedVsActual", () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    expect(() =>
      s.addHistory({ date: "yesterday", dishTitle: "x", plannedVsActual: "planned" }),
    ).toThrowError(/YYYY-MM-DD/);
    expect(() =>
      s.addHistory({ date: "2026-05-15", dishTitle: "x", plannedVsActual: "skipped" }),
    ).toThrowError(/plannedVsActual/);
  });
});

describe("MCP tools end-to-end against fresh storage", () => {
  it("exercises every tool handler in one flow", async () => {
    const dir = freshStorageDir();
    const s = createStorage(dir);
    const byName = new Map<string, any>(
      buildTools().map((t: any) => [t.name, t]),
    );
    const call = async (name: string, args: any) => {
      const t = byName.get(name);
      if (!t) throw new Error(`missing tool ${name}`);
      return t.handler(args, s);
    };

    // Recipes
    const r1 = await call("kitchen_recipe_add", {
      title: "Pad Thai",
      tags: ["thai", "weeknight"],
      activeTime: 20,
    });
    expect(r1.title).toBe("Pad Thai");
    const r2 = await call("kitchen_recipe_add", {
      title: "Lentil Soup",
      tags: ["soup", "cold-weather"],
    });
    const list = await call("kitchen_recipe_list", { tags: ["thai"] });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(r1.id);

    const updated = await call("kitchen_recipe_update", {
      id: r2.id,
      activeTime: 35,
    });
    expect(updated.activeTime).toBe(35);

    const archived = await call("kitchen_recipe_archive", { id: r2.id });
    expect(archived.status).toBe("deferred");

    // Routines
    const ro = await call("kitchen_routine_add", {
      name: "Grill Friday",
      dayOfWeek: "fri",
      notes: "weather permitting",
    });
    const routines = await call("kitchen_routine_list", {});
    expect(routines).toHaveLength(1);
    expect(routines[0].id).toBe(ro.id);
    const roPatched = await call("kitchen_routine_update", {
      id: ro.id,
      timeBudgetMin: 60,
    });
    expect(roPatched.timeBudgetMin).toBe(60);

    // Menus
    await call("kitchen_menu_save", {
      weekId: "2026-W21",
      monDate: "2026-05-18",
      nights: [{ day: "Mon", dish: "Pad Thai" }],
      rationale: "easy week",
    });
    const got = await call("kitchen_menu_get", { weekId: "2026-W21" });
    expect(got.weekId).toBe("2026-W21");
    expect(got.nights[0].dish).toBe("Pad Thai");
    const empty = await call("kitchen_menu_get", { weekId: "2030-W01" });
    expect(empty).toBeNull();

    await call("kitchen_menu_save", {
      weekId: "2026-W22",
      monDate: "2026-05-25",
      nights: [],
    });
    const recent = await call("kitchen_menu_list_recent", { limit: 5 });
    expect(recent.map((m: any) => m.weekId)).toEqual(["2026-W22", "2026-W21"]);

    // History
    await call("kitchen_history_add", {
      date: "2026-05-18",
      dishTitle: "Pad Thai",
      plannedVsActual: "planned",
    });
    await call("kitchen_history_add", {
      date: "2026-05-19",
      dishTitle: "Burritos",
      plannedVsActual: "swap",
      notes: "ran out of noodles",
    });
    const history = await call("kitchen_history_list", { limit: 10 });
    expect(history).toHaveLength(2);
    expect(history[0].date).toBe("2026-05-19");
    expect(history[0].notes).toBe("ran out of noodles");

    // On-disk shape
    expect(existsSync(join(dir, "recipes.json"))).toBe(true);
    expect(existsSync(join(dir, "routines.json"))).toBe(true);
    expect(existsSync(join(dir, "menus", "2026-W21.json"))).toBe(true);
    expect(existsSync(join(dir, "menus", "2026-W22.json"))).toBe(true);
    expect(existsSync(join(dir, "history.json"))).toBe(true);
  });
});

describe("installer integration: kitchen manifest", () => {
  it("installs the real kitchen app from apps/kitchen", () => {
    const target = appDir("kitchen");
    mkdirSync(dirname(target), { recursive: true });
    cpSync(APP_SRC, target, { recursive: true });
    // Drop node_modules and any local state copied from the worktree
    rmSync(join(target, "node_modules"), { recursive: true, force: true });

    const result = installApp(target);
    expect(result.id).toBe("kitchen");
    expect(result.status).toBe("installed");
    expect(result.agents.map((a) => a.name).sort()).toEqual([
      "kitchen",
      "scheduled-kitchen-weekly",
    ]);
    expect(result.schedules).toEqual([
      { name: "scheduled-kitchen-weekly", cron: "17 3 * * 0" },
    ]);
    expect(result.mcpServers).toEqual([{ name: "kitchen-app" }]);

    const detail = inspectApp("kitchen");
    expect(detail).not.toBeNull();
    expect(detail!.manifest.summary).toMatch(/Meal-planning/);

    // Registry rows look right
    const k = registry.getAgent("kitchen");
    expect(k!.type).toBe("bare");
    expect(registry.getAppId("kitchen")).toBe("kitchen");
    const w = registry.getAgent("scheduled-kitchen-weekly");
    expect(w!.type).toBe("scheduled");

    // Schedule row registered with the right cron + ownership
    const db = getDb();
    const sched = db.select().from(schema.schedules).all();
    expect(sched).toHaveLength(1);
    expect(sched[0].cron).toBe("17 3 * * 0");
    expect(sched[0].appId).toBe("kitchen");
  });
});
