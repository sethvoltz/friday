/**
 * Server-side proxy to the localhost daemon.
 */

import { DAEMON_SECRET_HEADER, getDaemonSecret, loadConfig } from "@friday/shared";

const cfg = loadConfig();
const BASE = `http://localhost:${cfg.daemonPort}`;
/**
 * Single default timeout for every non-streaming daemon-proxy fetch
 * (FIX_FORWARD 3.4). The previous 2s was an arbitrary "feels snappy"
 * value that flagged perfectly healthy turns as failed during the daemon
 * boot warmup or any DB-write spike. 30s covers ~all legitimate
 * synchronous daemon ops while still bounding hangs.
 *
 * Callers that want tighter scoping (route change, view unmount, SSE
 * disconnect) pass `signal` instead — those aborts are signal-propagated,
 * not clock-driven, so a navigation cancels in flight without waiting.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Inject the same-host shared secret on every daemon-bound request. The
 * daemon binds 127.0.0.1 but enforces this header on protected routes (the
 * upload endpoints today; potentially more later) so a hostile page using
 * DNS-rebind or a co-resident process can't reach the daemon without first
 * reading the 0600 secret file.
 */
export const DAEMON_AUTH_HEADER = DAEMON_SECRET_HEADER;
export function daemonAuthHeaders(): Record<string, string> {
  return { [DAEMON_AUTH_HEADER]: getDaemonSecret() };
}

export interface DaemonFetchOpts {
  /** Caller-supplied abort signal — typically tied to a route lifecycle
   *  (page navigation, view unmount). Combined with the default timeout. */
  signal?: AbortSignal;
  /** Override the default 30s timeout. Pass `0` to disable entirely. */
  timeoutMs?: number;
}

/** Build the abort signal for a daemon call: caller signal (if any)
 *  combined with the timeout. Either firing aborts the fetch. */
function buildSignal(opts: DaemonFetchOpts | undefined): AbortSignal | undefined {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const callerSignal = opts?.signal;
  if (timeoutMs <= 0) return callerSignal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) return timeoutSignal;
  // Manually combine — `AbortSignal.any` is Node 22+ / recent browsers, and
  // we want broad compatibility. A small controller bridges both sources.
  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  if (callerSignal.aborted) ctrl.abort();
  else callerSignal.addEventListener("abort", onAbort, { once: true });
  if (timeoutSignal.aborted) ctrl.abort();
  else timeoutSignal.addEventListener("abort", onAbort, { once: true });
  return ctrl.signal;
}

export async function daemonGet<T>(
  path: string,
  opts?: DaemonFetchOpts,
): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    headers: daemonAuthHeaders(),
    signal: buildSignal(opts),
  });
  if (!r.ok) throw new Error(`daemon GET ${path} → ${r.status}`);
  return (await r.json()) as T;
}

export async function daemonPost<T>(
  path: string,
  body: unknown,
  opts?: DaemonFetchOpts,
): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...daemonAuthHeaders() },
    body: JSON.stringify(body),
    signal: buildSignal(opts),
  });
  if (!r.ok) throw new Error(`daemon POST ${path} → ${r.status}`);
  return (await r.json()) as T;
}

export function daemonStream(path: string, init?: RequestInit): Promise<Response> {
  // SSE proxies pass through init.signal verbatim and set NO timeout — the
  // stream is long-lived by design. Aborts come from the upstream request.
  const headers = { ...(init?.headers ?? {}), ...daemonAuthHeaders() };
  return fetch(`${BASE}${path}`, { ...init, headers });
}

export const DAEMON_BASE = BASE;
