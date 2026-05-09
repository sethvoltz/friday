import type { PageServerLoad } from "./$types";
import { daemonGet } from "$lib/server/daemon";

export const load: PageServerLoad = async () => {
  try {
    return { schedules: await daemonGet<unknown[]>("/api/schedules") };
  } catch {
    return { schedules: [] };
  }
};
