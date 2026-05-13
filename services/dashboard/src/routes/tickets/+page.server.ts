import type { PageServerLoad } from "./$types";
import { daemonGet } from "$lib/server/daemon";
import type { Ticket } from "@friday/shared/services";

export const load: PageServerLoad = async () => {
  try {
    const tickets = await daemonGet<Ticket[]>("/api/tickets");
    return { tickets };
  } catch {
    return { tickets: [] as Ticket[] };
  }
};
