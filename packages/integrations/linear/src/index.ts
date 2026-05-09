/**
 * Linear integration. Phase 6 fills in the reconcile pass + bidirectional sync
 * via Linear's GraphQL API. This phase exposes the integration's "shape" so
 * the daemon's boot path can probe for and call into it.
 */

export interface LinearConfig {
  apiKey: string;
  teamId?: string;
}

export function getLinearConfig(): LinearConfig | null {
  const key = process.env.LINEAR_API_KEY;
  if (!key) return null;
  return { apiKey: key };
}

export async function reconcile(): Promise<void> {
  // Phase 6: query Linear for in-progress tickets, cross-reference with
  // ticket_external_links WHERE system='linear', emit orphan list as a
  // system_banner SSE event.
}

export const LINEAR_SYSTEM_NAME = "linear";
