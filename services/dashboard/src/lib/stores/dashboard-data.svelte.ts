/**
 * Dashboard data invalidation signal. Bumps the version on data-mutating SSE
 * events so the dashboard page can re-call its server load function.
 *
 * Debounced 500ms — a turn often produces a flurry of agent_status/turn_done
 * events; coalescing avoids hammering the server load on every one.
 */

const DEBOUNCE_MS = 500;

class DashboardData {
  version = $state(0);
}

export const dashboardData = new DashboardData();

let pending = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export function bumpDashboardData(): void {
  if (pending) return;
  pending = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    pending = false;
    dashboardData.version++;
  }, DEBOUNCE_MS);
}
