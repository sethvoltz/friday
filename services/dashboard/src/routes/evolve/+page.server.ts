import type { PageServerLoad } from "./$types";
import { daemonGet } from "$lib/server/daemon";

export const load: PageServerLoad = async () => {
  try {
    return { proposals: await daemonGet<unknown[]>("/api/evolve/proposals") };
  } catch {
    return { proposals: [] };
  }
};
