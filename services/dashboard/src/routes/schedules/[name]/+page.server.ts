import type { PageServerLoad } from "./$types";
import { daemonGet } from "$lib/server/daemon";
import { error } from "@sveltejs/kit";
import type { ScheduleRow } from "../+page.server";

export interface ScheduleArtifacts {
  state: string | null;
  lastRun: string | null;
  stateDir: string;
}

export const load: PageServerLoad = async ({ params }) => {
  const name = params.name;
  if (!name) throw error(404, "schedule name required");
  try {
    const [schedule, artifacts] = await Promise.all([
      daemonGet<ScheduleRow>(`/api/schedules/${encodeURIComponent(name)}`),
      daemonGet<ScheduleArtifacts>(
        `/api/schedules/${encodeURIComponent(name)}/state`,
      ).catch(() => ({ state: null, lastRun: null, stateDir: "" })),
    ]);
    return { schedule, artifacts };
  } catch (err) {
    throw error(
      404,
      `schedule not found: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
};
