/**
 * Server-side proxy to the localhost daemon.
 */

import {
  DAEMON_SECRET_HEADER,
  getDaemonSecret,
  loadConfig,
  resolveDaemonPort,
} from "@friday/shared";

const cfg = loadConfig();
// Bind to 127.0.0.1 explicitly, NOT `localhost`. The daemon listens on
// `127.0.0.1` only (`server.listen(port, "127.0.0.1")` in
// services/daemon/src/api/server.ts). On a dual-stack host `localhost`
// resolves to `::1` (IPv6) first, where the daemon is NOT listening — so
// every daemon-proxy call lands on whatever else happens to hold that
// port on `::1` (in the test sync-harness, a Fastify service that
// answers `404 Route … not found`) or fails outright. Matching the
// daemon's exact bind address keeps the proxy on the IPv4 loopback the
// daemon actually serves. Surfaced by FRI-126's now-executable AC8
// (history-row navigation), which proxies `/api/agents/<a>/sessions`.
const BASE = `http://127.0.0.1:${resolveDaemonPort(cfg)}`;
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

export async function daemonGet<T>(path: string, opts?: DaemonFetchOpts): Promise<T> {
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

/** The outcome of a non-throwing daemon POST. */
export type DaemonPostOutcome<T> =
  | { kind: "ok"; status: number; body: T }
  | { kind: "rejected"; status: number; body: unknown }
  | { kind: "timeout" }
  | { kind: "transport"; error: Error };

/**
 * Like {@link daemonPost} but never throws: it distinguishes a clean daemon
 * domain rejection (a 4xx whose JSON body carries the reason — e.g. a 409
 * `{ ok:false, error:"payload no longer valid…" }`) from a transport failure
 * (connection refused, DNS, socket reset) and from a timeout/abort.
 *
 * Proxy routes use this so the daemon's SPECIFIC error reaches the UI instead
 * of being flattened to a generic 502 (FRI-171 review #2), and so the capture
 * route can tell "daemon slow → 202 queued" apart from "daemon down → 503
 * retry" (review #3). `daemonPost` (which throws on any non-2xx) stays for
 * callers that don't need the distinction.
 */
export async function daemonPostResult<T>(
  path: string,
  body: unknown,
  opts?: DaemonFetchOpts,
): Promise<DaemonPostOutcome<T>> {
  let r: Response;
  try {
    r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...daemonAuthHeaders() },
      body: JSON.stringify(body),
      signal: buildSignal(opts),
    });
  } catch (err) {
    // `AbortSignal.timeout` aborts with a `TimeoutError`; a caller-signal abort
    // surfaces as `AbortError`. Either means the daemon did not answer in the
    // window — treat as a timeout. Anything else (ECONNREFUSED, socket reset)
    // is a genuine transport failure: the daemon never received the request.
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") return { kind: "timeout" };
    return { kind: "transport", error: err instanceof Error ? err : new Error(String(err)) };
  }
  const parsed = (await r.json().catch(() => undefined)) as unknown;
  if (r.ok) return { kind: "ok", status: r.status, body: parsed as T };
  return { kind: "rejected", status: r.status, body: parsed };
}

export async function daemonPatch<T>(
  path: string,
  body: unknown,
  opts?: DaemonFetchOpts,
): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...daemonAuthHeaders() },
    body: JSON.stringify(body),
    signal: buildSignal(opts),
  });
  if (!r.ok) throw new Error(`daemon PATCH ${path} → ${r.status}`);
  return (await r.json()) as T;
}

export async function daemonDelete<T>(path: string, opts?: DaemonFetchOpts): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "DELETE",
    headers: daemonAuthHeaders(),
    signal: buildSignal(opts),
  });
  if (!r.ok) throw new Error(`daemon DELETE ${path} → ${r.status}`);
  return (await r.json()) as T;
}

export function daemonStream(path: string, init?: RequestInit): Promise<Response> {
  // SSE proxies pass through init.signal verbatim and set NO timeout — the
  // stream is long-lived by design. Aborts come from the upstream request.
  const headers = { ...(init?.headers ?? {}), ...daemonAuthHeaders() };
  return fetch(`${BASE}${path}`, { ...init, headers });
}

export const DAEMON_BASE = BASE;
