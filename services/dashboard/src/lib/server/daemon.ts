/**
 * Server-side proxy to the localhost daemon.
 */

import { DAEMON_SECRET_HEADER, getDaemonSecret, loadConfig } from "@friday/shared";

const cfg = loadConfig();
const BASE = `http://localhost:${cfg.daemonPort}`;
const DEFAULT_TIMEOUT_MS = 2000;

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

export async function daemonGet<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    headers: daemonAuthHeaders(),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`daemon GET ${path} → ${r.status}`);
  return (await r.json()) as T;
}

export async function daemonPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...daemonAuthHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`daemon POST ${path} → ${r.status}`);
  return (await r.json()) as T;
}

export function daemonStream(path: string, init?: RequestInit): Promise<Response> {
  const headers = { ...(init?.headers ?? {}), ...daemonAuthHeaders() };
  return fetch(`${BASE}${path}`, { ...init, headers });
}

export const DAEMON_BASE = BASE;
