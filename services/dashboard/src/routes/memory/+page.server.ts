import type { PageServerLoad } from "./$types";
import { daemonGet } from "$lib/server/daemon";
import type { MemoryEntry } from "@friday/memory";

export const load: PageServerLoad = async () => {
  try {
    const entries = await daemonGet<MemoryEntry[]>("/api/memory");
    return { entries };
  } catch {
    return { entries: [] as MemoryEntry[] };
  }
};
