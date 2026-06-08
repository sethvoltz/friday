import type { PageServerLoad } from "./$types";
import { daemonGet } from "$lib/server/daemon";
import type { SearchMailResult } from "@friday/shared/services";

export const load: PageServerLoad = async () => {
  try {
    const result = await daemonGet<SearchMailResult>("/api/mail/search?limit=100");
    return { mail: result.results, total: result.total };
  } catch {
    return { mail: [], total: 0 };
  }
};
