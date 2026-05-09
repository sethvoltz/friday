import type { PageServerLoad } from "./$types";
import { daemonGet } from "$lib/server/daemon";

export const load: PageServerLoad = async () => {
  try {
    return { entries: await daemonGet<unknown[]>("/api/memory") };
  } catch {
    return { entries: [] };
  }
};
