import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { daemonGet } from "$lib/server/daemon";
import type { MemoryEntry } from "@friday/memory";

export const load: PageServerLoad = async ({ params }) => {
  try {
    const entry = await daemonGet<MemoryEntry>(
      `/api/memory/${encodeURIComponent(params.id ?? "")}`,
    );
    return { entry };
  } catch {
    throw error(404, "memory not found");
  }
};
