import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { daemonGet } from "$lib/server/daemon";

export const load: PageServerLoad = async ({ params }) => {
  try {
    return {
      entry: await daemonGet<unknown>(
        `/api/memory/${encodeURIComponent(params.id)}`,
      ),
    };
  } catch {
    throw error(404, "memory not found");
  }
};
