/**
 * HTTP helper for MCP tool handlers running inside worker forks.
 *
 * Workers reconstruct MCP servers locally after fork; handlers reach the
 * daemon's authoritative state by hitting 127.0.0.1:<daemonPort>. This keeps
 * the daemon as the sole writer of SQLite (per docs/architecture.md) and
 * routes tool invocations through the same endpoints the dashboard uses.
 *
 * Requests inject the same-host shared secret on every call so endpoints
 * gated by `authorizeSameHost` (e.g. `/api/apps/*`, `/api/uploads`) accept
 * them. Non-gated endpoints ignore the header, so injecting unconditionally
 * is safe and keeps the helper uniform.
 */

import { DAEMON_SECRET_HEADER, getDaemonSecret } from "@friday/shared";

export interface DaemonFetchOptions {
  port: number;
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  callerName?: string;
  callerType?: string;
}

export async function daemonFetch<T = unknown>(
  opts: DaemonFetchOptions,
): Promise<T> {
  const url = `http://127.0.0.1:${opts.port}${opts.path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [DAEMON_SECRET_HEADER]: getDaemonSecret(),
  };
  if (opts.callerName) headers["x-friday-caller-name"] = opts.callerName;
  if (opts.callerType) headers["x-friday-caller-type"] = opts.callerType;

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `daemonFetch ${opts.method ?? "GET"} ${opts.path} -> ${res.status}: ${text}`,
    );
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}
