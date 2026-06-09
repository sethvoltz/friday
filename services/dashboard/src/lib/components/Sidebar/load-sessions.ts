/**
 * Fetch-with-retry for the sidebar's past-session summaries (FRI-162).
 *
 * Extracted from `Sidebar.svelte#loadPastSessions` so the retry/error logic
 * is unit-testable without mounting the component: the component keeps the
 * thin store-mutation wrapper (which maps a result onto
 * `chat.sidebarPastSessions` / `chat.sidebarSessionsError`), and this module
 * owns the network + bounded-retry policy.
 *
 * Why retry at all: the investigation behind FRI-162 (Playwright network
 * probe on the AC8 expand-history flow) pinned the real trigger as a
 * **non-ok response** — a 502 from the dashboard proxy when it forwards to
 * the daemon during a boot/restart race (the dashboard's `daemonGet` throws
 * on `!r.ok`, which the proxy classifies as a 502). A genuine hard
 * `ECONNREFUSED` surfaces instead as a *thrown* fetch. Both are transient
 * and self-heal within a few hundred ms once the daemon's HTTP server is
 * listening, so a bounded auto-retry clears the AC8 flake at the source
 * without any user gesture.
 *
 * Why NOT retry on an empty 200: the daemon reads session summaries straight
 * from Postgres `blocks` (no Zero/replication hop), so a 200 always carries
 * the real array — an empty array is a genuinely-empty agent, not lag. The
 * probe never observed an empty-200-while-sessions-exist case. Retrying on
 * empty would only add latency to the common empty-agent path.
 */

import type { SidebarSessionSummary } from "$lib/stores/chat.svelte";

export type LoadSessionsResult = { ok: true; sessions: SidebarSessionSummary[] } | { ok: false };

export interface LoadSessionsOptions {
  /** Total attempts (initial + retries). Default 3. */
  attempts?: number;
  /** Base backoff in ms between attempts; attempt N waits `backoffMs * N`.
   *  Injectable so the unit test can drive it to 0 and not sleep for real. */
  backoffMs?: number;
  /** Seam for the network call (defaults to global `fetch`). Tests inject a
   *  mock; production passes nothing. */
  fetchImpl?: typeof fetch;
  /** Sleep seam, mirrors `backoffMs` — tests inject a no-op resolver. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch `/api/agents/:name/sessions` with a bounded retry. Resolves to a
 * discriminated result so the caller can distinguish a successful (possibly
 * empty) load from an ultimate failure — the distinction FRI-162 needs so a
 * failed load no longer masquerades as "No past sessions".
 *
 * A result is `{ ok: true }` only when an attempt returned a 2xx whose body
 * parsed to an array. A non-ok status OR a thrown fetch OR a body that didn't
 * parse to an array consumes an attempt; once all attempts are exhausted the
 * result is `{ ok: false }`.
 */
export async function loadPastSessionsWithRetry(
  name: string,
  opts: LoadSessionsOptions = {},
): Promise<LoadSessionsResult> {
  const attempts = opts.attempts ?? 3;
  const backoffMs = opts.backoffMs ?? 150;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const r = await fetchImpl(`/api/agents/${name}/sessions`);
      if (r.ok) {
        const body = (await r.json()) as unknown;
        if (Array.isArray(body)) {
          return { ok: true, sessions: body as SidebarSessionSummary[] };
        }
        // 2xx with an unexpected (non-array) shape — treat as a failed
        // attempt rather than silently caching a malformed value.
      }
      // Non-ok response (the FRI-162 trigger: proxy 502 during a daemon
      // boot/restart race). Fall through to the backoff + retry below.
    } catch {
      // Thrown fetch — hard ECONNREFUSED (daemon truly down) or an abort.
      // Same handling as a non-ok: back off and retry.
    }
    if (attempt < attempts) {
      await sleep(backoffMs * attempt);
    }
  }
  return { ok: false };
}

/** The store maps the sidebar wrapper mutates. Narrowed to exactly the
 *  fields `applyLoadResult` touches so the seam is testable against a plain
 *  object (no ChatState construction) while the component passes the real
 *  reactive `chat` store. */
export interface SessionStoreSeam {
  sidebarPastSessions: Record<string, SidebarSessionSummary[]>;
  sidebarSessionsError: Record<string, boolean>;
}

/**
 * Map a `LoadSessionsResult` onto the store (FRI-162): cache the array on
 * success, set the error flag on ultimate failure. Distinguishing failure
 * from empty is the whole point — a failed load must NOT leave
 * `sidebarPastSessions[name]` undefined-looking-like-empty without the
 * error flag set. Extracted so the wrapper's store-mutation seam stays
 * observable in a unit test without mounting the component.
 */
export function applyLoadResult(
  store: SessionStoreSeam,
  name: string,
  result: LoadSessionsResult,
): void {
  if (result.ok) {
    store.sidebarPastSessions[name] = result.sessions;
    store.sidebarSessionsError[name] = false;
  } else {
    store.sidebarSessionsError[name] = true;
  }
}
