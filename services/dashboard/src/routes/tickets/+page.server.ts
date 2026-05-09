import type { PageServerLoad } from "./$types";
import { daemonGet } from "$lib/server/daemon";

export const load: PageServerLoad = async () => {
  try {
    const tickets = await daemonGet<unknown[]>("/api/tickets");
    return { tickets };
  } catch {
    return { tickets: [] };
  }
};
