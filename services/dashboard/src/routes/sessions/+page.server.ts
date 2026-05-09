import { redirect } from "@sveltejs/kit";

/**
 * /sessions has no standalone view anymore — the per-agent and per-session
 * routes (`/sessions/[agent]`, `/sessions/[agent]/[session]`) are the only
 * ways into a session view. Manually visiting /sessions sends the user to
 * the orchestrator chat at /, which has the sidebar to navigate elsewhere.
 */
export function load() {
  throw redirect(307, "/");
}
