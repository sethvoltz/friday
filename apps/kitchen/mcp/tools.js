// Kitchen App — MCP tool definitions.
//
// Pure functions over a KitchenStorage instance so they can be unit-tested
// without booting a real MCP transport. Each entry: { name, description,
// inputSchema, handler(args, storage) → JSON-serializable result }.

import { mealieSearch, mealieGetRecipe } from "./mealie.js";

export function buildTools() {
  return [
    {
      name: "kitchen_recipe_list",
      description:
        "List recipes from the library. Filter by tags (entries must include ALL listed tags) and/or status (active|deferred). Returns the full recipe objects.",
      inputSchema: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["active", "deferred"] },
        },
      },
      handler: (args, storage) => storage.listRecipes(args ?? {}),
    },
    {
      name: "kitchen_recipe_add",
      description:
        "Add a recipe to the library. id auto-generated if omitted. Required: title. Optional: ingredients[], method, activeTime (minutes), tags[], status (default active), notes.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          ingredients: { type: "array", items: { type: "string" } },
          method: { type: "string" },
          activeTime: { type: "number" },
          tags: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["active", "deferred"] },
          notes: { type: "string" },
          mealieSlug: { type: "string" },
        },
        required: ["title"],
      },
      handler: (args, storage) => storage.addRecipe(args),
    },
    {
      name: "kitchen_recipe_update",
      description:
        "Patch fields on an existing recipe. Required: id. All other fields optional and merged onto the existing row.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          ingredients: { type: "array", items: { type: "string" } },
          method: { type: "string" },
          activeTime: { type: ["number", "null"] },
          tags: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["active", "deferred"] },
          notes: { type: "string" },
          lastUsedAt: { type: ["string", "null"] },
          mealieSlug: { type: ["string", "null"] },
        },
        required: ["id"],
      },
      handler: (args, storage) => {
        const { id, ...patch } = args ?? {};
        return storage.updateRecipe(id, patch);
      },
    },
    {
      name: "kitchen_recipe_archive",
      description:
        "Move a recipe to status=deferred without deleting it (preserve over delete). Required: id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      handler: (args, storage) => storage.archiveRecipe(args.id),
    },
    {
      name: "kitchen_routine_list",
      description:
        "List recurring meal-planning patterns (soup Sunday, grill Friday, etc).",
      inputSchema: { type: "object", properties: {} },
      handler: (_args, storage) => storage.listRoutines(),
    },
    {
      name: "kitchen_routine_add",
      description:
        "Add a routine. Required: name. Optional: description, dayOfWeek (mon..sun), weatherTrigger (free text), timeBudgetMin, notes.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          dayOfWeek: { type: "string" },
          weatherTrigger: { type: "string" },
          timeBudgetMin: { type: "number" },
          notes: { type: "string" },
        },
        required: ["name"],
      },
      handler: (args, storage) => storage.addRoutine(args),
    },
    {
      name: "kitchen_routine_update",
      description: "Patch fields on an existing routine. Required: id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          dayOfWeek: { type: ["string", "null"] },
          weatherTrigger: { type: ["string", "null"] },
          timeBudgetMin: { type: ["number", "null"] },
          notes: { type: "string" },
        },
        required: ["id"],
      },
      handler: (args, storage) => {
        const { id, ...patch } = args ?? {};
        return storage.updateRoutine(id, patch);
      },
    },
    {
      name: "kitchen_menu_save",
      description:
        "Save a week's menu (overwrites the file for that ISO week). weekId is YYYY-Wxx, monDate is YYYY-MM-DD of the week's Monday. nights is an array of { day, dish, prepSummary, activeTime, weatherNote, notes }.",
      inputSchema: {
        type: "object",
        properties: {
          weekId: { type: "string" },
          monDate: { type: "string" },
          nights: { type: "array" },
          rationale: { type: "string" },
          savedAt: { type: "string" },
        },
        required: ["weekId", "monDate", "nights"],
      },
      handler: (args, storage) => storage.saveMenu(args),
    },
    {
      name: "kitchen_menu_get",
      description:
        "Read a single week's menu. Required: weekId (YYYY-Wxx). Returns null when no menu has been saved for that week.",
      inputSchema: {
        type: "object",
        properties: { weekId: { type: "string" } },
        required: ["weekId"],
      },
      handler: (args, storage) => storage.getMenu(args.weekId),
    },
    {
      name: "kitchen_menu_list_recent",
      description:
        "List recent weekly menus, newest first. Optional: limit (default 8).",
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
      handler: (args, storage) => storage.listRecentMenus(args ?? {}),
    },
    {
      name: "kitchen_history_add",
      description:
        "Record what was actually eaten on a given date. Required: date (YYYY-MM-DD), dishTitle, plannedVsActual (planned|swap|takeout). Optional: notes.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string" },
          dishTitle: { type: "string" },
          plannedVsActual: {
            type: "string",
            enum: ["planned", "swap", "takeout"],
          },
          notes: { type: "string" },
        },
        required: ["date", "dishTitle", "plannedVsActual"],
      },
      handler: (args, storage) => storage.addHistory(args),
    },
    {
      name: "kitchen_history_list",
      description:
        "List history entries, newest first. Optional: limit (default 50), sinceDate (YYYY-MM-DD).",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number" },
          sinceDate: { type: "string" },
        },
      },
      handler: (args, storage) => storage.listHistory(args ?? {}),
    },
    {
      name: "kitchen_mealie_search",
      description:
        "Search the Mealie recipe archive by name/keyword. Returns slug, name, description, tags, and totalTime for each match. Use for discovery when planning or exploring new recipes.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          perPage: { type: "number" },
        },
        required: ["query"],
      },
      handler: (args) => mealieSearch(args.query, args.perPage),
    },
    {
      name: "kitchen_mealie_get_ingredients",
      description:
        "Fetch structured ingredient list from Mealie for a recipe slug. 'ingredients' is display-formatted strings (e.g. '3 tbsp sesame oil'). 'rawIngredients' includes quantity, unitName, foodName, note, title for structured use. Empty display strings (section headers) are filtered out.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string" },
        },
        required: ["slug"],
      },
      handler: async (args) => {
        const recipe = await mealieGetRecipe(args.slug);
        return {
          name: recipe.name,
          slug: recipe.slug,
          ingredients: recipe.recipeIngredient.map((i) => i.display).filter((d) => d !== ""),
          rawIngredients: recipe.recipeIngredient,
        };
      },
    },
    {
      name: "kitchen_mealie_import",
      description:
        "Import a Mealie recipe into the local Kitchen library by slug. Fetches full recipe from Mealie, maps name/tags/description/ingredients. Uses the Mealie slug as the local recipe id (so duplicate imports are caught). Fails with duplicate_id if already imported. Optional extraTags[] and notes string prepended to description.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string" },
          extraTags: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
        },
        required: ["slug"],
      },
      handler: async (args, storage) => {
        const recipe = await mealieGetRecipe(args.slug);
        const ingredients = recipe.recipeIngredient.map((i) => i.display).filter((d) => d !== "");
        const tags = [...(args.extraTags ?? []), ...recipe.tags];
        const notes = [args.notes, recipe.description].filter(Boolean).join("\n\n");
        return storage.addRecipe({
          id: args.slug,       // deterministic: enables duplicate_id guard on re-import
          title: recipe.name,
          ingredients,
          mealieSlug: args.slug,
          tags,
          notes,
          activeTime: null,   // Mealie time strings too variable to parse reliably
          method: "",
        });
      },
    },
  ];
}
