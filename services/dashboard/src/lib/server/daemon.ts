/**
 * Server-side proxy to the localhost daemon.
 */

import { loadConfig } from "@friday/shared";

const cfg = loadConfig();
const BASE = `http://localhost:${cfg.daemonPort}`;

export async function daemonGet<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`daemon GET ${path} → ${r.status}`);
  return (await r.json()) as T;
}

export async function daemonPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`daemon POST ${path} → ${r.status}`);
  return (await r.json()) as T;
}

export function daemonStream(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, init);
}

export const DAEMON_BASE = BASE;
