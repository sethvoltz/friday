import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { daemonGet } from "$lib/server/daemon";

export const load: PageServerLoad = async ({ params }) => {
  try {
    const ticket = await daemonGet<unknown>(`/api/tickets/${params.id}`);
    return { ticket };
  } catch {
    throw error(404, "ticket not found");
  }
};
