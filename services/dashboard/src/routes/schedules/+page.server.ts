import type { PageServerLoad } from "./$types";
import { daemonGet } from "$lib/server/daemon";

export interface ScheduleRow {
  name: string;
  cron: string | null;
  runAt: string | null;
  taskPrompt: string;
  paused: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

export const load: PageServerLoad = async () => {
  try {
    const schedules = await daemonGet<ScheduleRow[]>("/api/schedules");
    return { schedules };
  } catch {
    return { schedules: [] as ScheduleRow[] };
  }
};
