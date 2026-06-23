// Kitchen App — storage layer.
//
// All app data lives under the app folder (resolved at MCP-server boot from
// process.cwd(), which the daemon sets to <app-folder> when it spawns this
// stdio MCP server). Files:
//
//   recipes.json          — recipe library
//   routines.json         — recurring patterns
//   history.json          — what was actually eaten
//   menus/<weekId>.json   — one file per ISO week
//
// Reads: read whole file, parse JSON, validate shape. Missing files
// initialize to an empty collection (the install drops `state/.gitkeep`,
// not the JSON files — first write creates them).
//
// Writes: write to `<path>.tmp`, fsync, rename over the destination.
// Single-writer (only kitchen agents have this MCP server in scope), so no
// lockfile.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, fsyncSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const ISO_WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class KitchenStorageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "KitchenStorageError";
    this.code = code;
  }
}

export function createStorage(rootDir) {
  return new KitchenStorage(rootDir);
}

export class KitchenStorage {
  constructor(rootDir) {
    this.root = rootDir;
    this.recipesPath = join(rootDir, "recipes.json");
    this.routinesPath = join(rootDir, "routines.json");
    this.historyPath = join(rootDir, "history.json");
    this.menusDir = join(rootDir, "menus");
  }

  // ── Recipes ───────────────────────────────────────────────────────────

  listRecipes({ tags, status } = {}) {
    const all = readJsonArray(this.recipesPath);
    return all.filter((r) => {
      if (status && r.status !== status) return false;
      if (tags && tags.length) {
        const have = new Set(r.tags ?? []);
        for (const t of tags) if (!have.has(t)) return false;
      }
      return true;
    });
  }

  addRecipe(input) {
    const recipe = validateRecipeInput(input);
    const all = readJsonArray(this.recipesPath);
    if (all.some((r) => r.id === recipe.id)) {
      throw new KitchenStorageError(
        `recipe id "${recipe.id}" already exists`,
        "duplicate_id",
      );
    }
    all.push(recipe);
    atomicWriteJson(this.recipesPath, all);
    return recipe;
  }

  updateRecipe(id, patch) {
    if (!id || typeof id !== "string") {
      throw new KitchenStorageError("update requires id", "invalid_input");
    }
    const all = readJsonArray(this.recipesPath);
    const idx = all.findIndex((r) => r.id === id);
    if (idx < 0) {
      throw new KitchenStorageError(`recipe "${id}" not found`, "not_found");
    }
    const next = { ...all[idx], ...sanitizeRecipePatch(patch) };
    validateRecipeShape(next);
    all[idx] = next;
    atomicWriteJson(this.recipesPath, all);
    return next;
  }

  archiveRecipe(id) {
    return this.updateRecipe(id, { status: "deferred" });
  }

  // ── Routines ──────────────────────────────────────────────────────────

  listRoutines() {
    return readJsonArray(this.routinesPath);
  }

  addRoutine(input) {
    const routine = validateRoutineInput(input);
    const all = readJsonArray(this.routinesPath);
    if (all.some((r) => r.id === routine.id)) {
      throw new KitchenStorageError(
        `routine id "${routine.id}" already exists`,
        "duplicate_id",
      );
    }
    all.push(routine);
    atomicWriteJson(this.routinesPath, all);
    return routine;
  }

  updateRoutine(id, patch) {
    if (!id || typeof id !== "string") {
      throw new KitchenStorageError("update requires id", "invalid_input");
    }
    const all = readJsonArray(this.routinesPath);
    const idx = all.findIndex((r) => r.id === id);
    if (idx < 0) {
      throw new KitchenStorageError(`routine "${id}" not found`, "not_found");
    }
    const next = { ...all[idx], ...sanitizeRoutinePatch(patch) };
    validateRoutineShape(next);
    all[idx] = next;
    atomicWriteJson(this.routinesPath, all);
    return next;
  }

  // ── Menus (per-week files) ────────────────────────────────────────────

  saveMenu(input) {
    const menu = validateMenuInput(input);
    if (!existsSync(this.menusDir)) mkdirSync(this.menusDir, { recursive: true });
    const path = join(this.menusDir, `${menu.weekId}.json`);
    atomicWriteJson(path, menu);
    return menu;
  }

  getMenu(weekId) {
    if (!ISO_WEEK_RE.test(weekId)) {
      throw new KitchenStorageError(
        `weekId "${weekId}" is not ISO-week shaped (YYYY-Wxx)`,
        "invalid_input",
      );
    }
    const path = join(this.menusDir, `${weekId}.json`);
    if (!existsSync(path)) return null;
    return readJsonObject(path);
  }

  listRecentMenus({ limit = 8 } = {}) {
    if (!existsSync(this.menusDir)) return [];
    const files = readdirSync(this.menusDir)
      .filter((f) => f.endsWith(".json") && ISO_WEEK_RE.test(f.slice(0, -5)))
      .sort()
      .reverse()
      .slice(0, limit);
    return files.map((f) => readJsonObject(join(this.menusDir, f)));
  }

  // ── History ───────────────────────────────────────────────────────────

  addHistory(entry) {
    const e = validateHistoryEntry(entry);
    const all = readJsonArray(this.historyPath);
    all.push(e);
    atomicWriteJson(this.historyPath, all);
    return e;
  }

  listHistory({ limit = 50, sinceDate } = {}) {
    const all = readJsonArray(this.historyPath);
    let filtered = sinceDate
      ? all.filter((e) => e.date >= sinceDate)
      : all;
    filtered = filtered.sort((a, b) => (a.date < b.date ? 1 : -1));
    return filtered.slice(0, limit);
  }
}

// ── Validation ──────────────────────────────────────────────────────────

function validateRecipeInput(raw) {
  if (!raw || typeof raw !== "object") {
    throw new KitchenStorageError("recipe must be an object", "invalid_input");
  }
  const id = typeof raw.id === "string" && raw.id ? raw.id : randomUUID();
  const recipe = {
    id,
    title: requireString(raw.title, "title"),
    ingredients: requireStringArray(raw.ingredients ?? [], "ingredients"),
    method: typeof raw.method === "string" ? raw.method : "",
    activeTime: typeof raw.activeTime === "number" ? raw.activeTime : null,
    tags: requireStringArray(raw.tags ?? [], "tags"),
    status: raw.status === "deferred" ? "deferred" : "active",
    notes: typeof raw.notes === "string" ? raw.notes : "",
    addedAt: typeof raw.addedAt === "string" ? raw.addedAt : new Date().toISOString(),
    lastUsedAt: typeof raw.lastUsedAt === "string" ? raw.lastUsedAt : null,
    mealieSlug: typeof raw.mealieSlug === "string" ? raw.mealieSlug : undefined,
  };
  validateRecipeShape(recipe);
  return recipe;
}

function sanitizeRecipePatch(patch) {
  if (!patch || typeof patch !== "object") return {};
  const out = {};
  if (patch.title !== undefined) out.title = String(patch.title);
  if (patch.ingredients !== undefined) out.ingredients = requireStringArray(patch.ingredients, "ingredients");
  if (patch.method !== undefined) out.method = String(patch.method);
  if (patch.activeTime !== undefined) {
    out.activeTime = patch.activeTime === null ? null : Number(patch.activeTime);
  }
  if (patch.tags !== undefined) out.tags = requireStringArray(patch.tags, "tags");
  if (patch.status !== undefined) {
    if (patch.status !== "active" && patch.status !== "deferred") {
      throw new KitchenStorageError(`status must be "active" or "deferred"`, "invalid_input");
    }
    out.status = patch.status;
  }
  if (patch.notes !== undefined) out.notes = String(patch.notes);
  if (patch.lastUsedAt !== undefined) {
    out.lastUsedAt = patch.lastUsedAt === null ? null : String(patch.lastUsedAt);
  }
  if (patch.mealieSlug !== undefined)
    out.mealieSlug = patch.mealieSlug === null ? null : String(patch.mealieSlug);
  return out;
}

function validateRecipeShape(r) {
  requireString(r.id, "id");
  requireString(r.title, "title");
  if (!Array.isArray(r.tags)) throw new KitchenStorageError("tags must be array", "invalid_input");
  if (r.status !== "active" && r.status !== "deferred") {
    throw new KitchenStorageError(`status must be "active" or "deferred"`, "invalid_input");
  }
}

function validateRoutineInput(raw) {
  if (!raw || typeof raw !== "object") {
    throw new KitchenStorageError("routine must be an object", "invalid_input");
  }
  const id = typeof raw.id === "string" && raw.id ? raw.id : randomUUID();
  const routine = {
    id,
    name: requireString(raw.name, "name"),
    description: typeof raw.description === "string" ? raw.description : "",
    dayOfWeek: typeof raw.dayOfWeek === "string" ? raw.dayOfWeek : null,
    weatherTrigger: typeof raw.weatherTrigger === "string" ? raw.weatherTrigger : null,
    timeBudgetMin: typeof raw.timeBudgetMin === "number" ? raw.timeBudgetMin : null,
    notes: typeof raw.notes === "string" ? raw.notes : "",
  };
  validateRoutineShape(routine);
  return routine;
}

function sanitizeRoutinePatch(patch) {
  if (!patch || typeof patch !== "object") return {};
  const out = {};
  for (const k of ["name", "description", "dayOfWeek", "weatherTrigger", "notes"]) {
    if (patch[k] !== undefined) out[k] = patch[k] === null ? null : String(patch[k]);
  }
  if (patch.timeBudgetMin !== undefined) {
    out.timeBudgetMin = patch.timeBudgetMin === null ? null : Number(patch.timeBudgetMin);
  }
  return out;
}

function validateRoutineShape(r) {
  requireString(r.id, "id");
  requireString(r.name, "name");
}

function validateMenuInput(raw) {
  if (!raw || typeof raw !== "object") {
    throw new KitchenStorageError("menu must be an object", "invalid_input");
  }
  if (typeof raw.weekId !== "string" || !ISO_WEEK_RE.test(raw.weekId)) {
    throw new KitchenStorageError(
      `weekId must match ISO week pattern YYYY-Wxx (got ${JSON.stringify(raw.weekId)})`,
      "invalid_input",
    );
  }
  if (typeof raw.monDate !== "string" || !ISO_DATE_RE.test(raw.monDate)) {
    throw new KitchenStorageError(
      `monDate must be YYYY-MM-DD (got ${JSON.stringify(raw.monDate)})`,
      "invalid_input",
    );
  }
  if (!Array.isArray(raw.nights)) {
    throw new KitchenStorageError("nights must be an array", "invalid_input");
  }
  const nights = raw.nights.map((n, i) => {
    if (!n || typeof n !== "object") {
      throw new KitchenStorageError(`nights[${i}] must be an object`, "invalid_input");
    }
    return {
      day: requireString(n.day, `nights[${i}].day`),
      dish: requireString(n.dish, `nights[${i}].dish`),
      prepSummary: typeof n.prepSummary === "string" ? n.prepSummary : "",
      activeTime: typeof n.activeTime === "number" ? n.activeTime : null,
      weatherNote: typeof n.weatherNote === "string" ? n.weatherNote : "",
      notes: typeof n.notes === "string" ? n.notes : "",
    };
  });
  return {
    weekId: raw.weekId,
    monDate: raw.monDate,
    nights,
    rationale: typeof raw.rationale === "string" ? raw.rationale : "",
    savedAt: typeof raw.savedAt === "string" ? raw.savedAt : new Date().toISOString(),
  };
}

function validateHistoryEntry(raw) {
  if (!raw || typeof raw !== "object") {
    throw new KitchenStorageError("history entry must be an object", "invalid_input");
  }
  if (typeof raw.date !== "string" || !ISO_DATE_RE.test(raw.date)) {
    throw new KitchenStorageError(
      `date must be YYYY-MM-DD (got ${JSON.stringify(raw.date)})`,
      "invalid_input",
    );
  }
  const pva = raw.plannedVsActual;
  if (pva !== "planned" && pva !== "swap" && pva !== "takeout") {
    throw new KitchenStorageError(
      `plannedVsActual must be "planned" | "swap" | "takeout" (got ${JSON.stringify(pva)})`,
      "invalid_input",
    );
  }
  return {
    date: raw.date,
    dishTitle: requireString(raw.dishTitle, "dishTitle"),
    plannedVsActual: pva,
    notes: typeof raw.notes === "string" ? raw.notes : "",
  };
}

function requireString(v, label) {
  if (typeof v !== "string" || v.length === 0) {
    throw new KitchenStorageError(`${label} must be a non-empty string`, "invalid_input");
  }
  return v;
}

function requireStringArray(v, label) {
  if (!Array.isArray(v)) {
    throw new KitchenStorageError(`${label} must be an array`, "invalid_input");
  }
  for (const x of v) {
    if (typeof x !== "string") {
      throw new KitchenStorageError(`${label} entries must be strings`, "invalid_input");
    }
  }
  return v.slice();
}

// ── Low-level JSON IO ───────────────────────────────────────────────────

function readJsonArray(path) {
  if (!existsSync(path)) return [];
  const data = readJsonAny(path);
  if (!Array.isArray(data)) {
    throw new KitchenStorageError(
      `expected array in ${path}, got ${typeof data}`,
      "corrupt_file",
    );
  }
  return data;
}

function readJsonObject(path) {
  const data = readJsonAny(path);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new KitchenStorageError(
      `expected object in ${path}`,
      "corrupt_file",
    );
  }
  return data;
}

function readJsonAny(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new KitchenStorageError(
      `read ${path}: ${err.message}`,
      "read_error",
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new KitchenStorageError(
      `parse ${path}: ${err.message}`,
      "corrupt_file",
    );
  }
}

function atomicWriteJson(path, value) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const text = JSON.stringify(value, null, 2);
  writeFileSync(tmp, text, "utf8");
  // fsync the temp file so the rename promotes durable bytes
  try {
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // best-effort; renameSync below still atomic on POSIX
  }
  renameSync(tmp, path);
}
