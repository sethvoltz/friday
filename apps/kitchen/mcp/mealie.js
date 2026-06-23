export class MealieClientError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = "MealieClientError";
    this.code = code;
    this.status = status;
  }
}

function requireEnv() {
  const url = process.env.MEALIE_URL;
  const token = process.env.MEALIE_TOKEN;
  if (!url || !token) {
    throw new MealieClientError(
      "MEALIE_URL or MEALIE_TOKEN not configured. " +
      "Set MEALIE_URL=http://your-host:9000 (no trailing slash, no /api suffix) " +
      "and MEALIE_TOKEN=<long-lived API token> in manifest.json env.",
      "config-missing"
    );
  }
  return { url, token };
}

async function mealieRequest(path) {
  const { url, token } = requireEnv();
  let res;
  try {
    res = await fetch(`${url}/api${path}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
  } catch (err) {
    throw new MealieClientError(`Network error: ${err.message}`, "fetch-failed");
  }
  if (res.status === 404) throw new MealieClientError(`Not found: ${path}`, "not-found", 404);
  if (!res.ok) throw new MealieClientError(`HTTP ${res.status}`, "http-error", res.status);
  return res.json();
}

export async function mealieSearch(query, perPage = 10) {
  const qs = new URLSearchParams({ search: query, perPage: String(perPage) });
  const data = await mealieRequest(`/recipes?${qs}`);
  return (data.items ?? []).map((r) => ({
    slug: r.slug,
    name: r.name,
    description: r.description ?? "",
    tags: (r.tags ?? []).map((t) => t.name),
    totalTime: r.totalTime ?? null,
  }));
}

export async function mealieGetRecipe(slug) {
  const data = await mealieRequest(`/recipes/${encodeURIComponent(slug)}`);
  return {
    slug: data.slug,
    name: data.name,
    description: data.description ?? "",
    tags: (data.tags ?? []).map((t) => t.name),
    totalTime: data.totalTime ?? null,
    prepTime: data.prepTime ?? null,
    cookTime: data.cookTime ?? null,
    recipeIngredient: (data.recipeIngredient ?? []).map((i) => ({
      display: i.display ?? "",
      quantity: i.quantity ?? null,
      unitName: i.unit?.name ?? null,
      foodName: i.food?.name ?? null,
      note: i.note ?? null,
      title: i.title ?? null,
    })),
  };
}
