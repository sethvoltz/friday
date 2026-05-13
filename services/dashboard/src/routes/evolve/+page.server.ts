import type { PageServerLoad } from "./$types";
import { daemonGet } from "$lib/server/daemon";
import type { Proposal } from "@friday/evolve";

export const load: PageServerLoad = async () => {
  try {
    const proposals = await daemonGet<Proposal[]>("/api/evolve/proposals");
    return { proposals };
  } catch {
    return { proposals: [] as Proposal[] };
  }
};
