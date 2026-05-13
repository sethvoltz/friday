/**
 * Try/catch wrapper for daemon-proxy SvelteKit routes (FIX_FORWARD 3.5).
 *
 * Every `+server.ts` under `routes/api/**` that calls `daemonGet`,
 * `daemonPost`, or `daemonStream` wraps its handler body with this helper.
 * Any thrown error is classified and surfaced as a structured JSON
 * response — the dashboard's fetch sites can pattern-match on `error`
 * without parsing arbitrary daemon traceback prose.
 *
 * Error classification:
 *   - `daemon_unavailable` (502): daemon refused the connection (ECONNREFUSED,
 *     EHOSTUNREACH). The daemon is down or restarting; the dashboard's
 *     connectivity widget surfaces this as a red light.
 *   - `daemon_timeout` (504): the 30s default timeout (or caller-supplied
 *     timeout) elapsed. Surfaced as orange in the widget — daemon's
 *     responsive but slow.
 *   - `daemon_error` (502): anything else daemon-shaped (non-2xx status,
 *     parse failure, etc.). Includes the upstream status text where we
 *     can recover it.
 */

import { json } from "@sveltejs/kit";
import {
  daemonGet,
  daemonPost,
  daemonStream,
  type DaemonFetchOpts,
} from "./daemon";

export interface DaemonClient {
  get<T>(path: string, opts?: DaemonFetchOpts): Promise<T>;
  post<T>(path: string, body: unknown, opts?: DaemonFetchOpts): Promise<T>;
  stream(path: string, init?: RequestInit): Promise<Response>;
}

const daemon: DaemonClient = {
  get: daemonGet,
  post: daemonPost,
  stream: daemonStream,
};

export type DaemonErrorKind =
  | "daemon_unavailable"
  | "daemon_timeout"
  | "daemon_error";

export interface DaemonErrorBody {
  error: DaemonErrorKind;
  detail?: string;
  status: number;
}

function classify(err: unknown): {
  kind: DaemonErrorKind;
  status: number;
  detail: string;
} {
  const e = err as { name?: string; code?: string; message?: string };
  const message = e?.message ?? String(err);
  if (e?.name === "TimeoutError" || /timeout/i.test(message)) {
    return { kind: "daemon_timeout", status: 504, detail: message };
  }
  if (
    e?.code === "ECONNREFUSED" ||
    e?.code === "EHOSTUNREACH" ||
    e?.code === "ENETUNREACH" ||
    /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|fetch failed/i.test(message)
  ) {
    return { kind: "daemon_unavailable", status: 502, detail: message };
  }
  return { kind: "daemon_error", status: 502, detail: message };
}

/**
 * Run a daemon-proxy handler and return either the success Response or a
 * structured DaemonErrorBody JSON response on failure. The handler may
 * return a plain value (which we wrap in `json(...)`) or a Response
 * directly (passthrough — useful for streams).
 */
export async function withDaemon<T>(
  handler: (d: DaemonClient) => Promise<T> | Promise<Response> | Response | T,
): Promise<Response> {
  try {
    const out = await handler(daemon);
    if (out instanceof Response) return out;
    return json(out);
  } catch (err) {
    const cls = classify(err);
    const body: DaemonErrorBody = {
      error: cls.kind,
      detail: cls.detail,
      status: cls.status,
    };
    return json(body, { status: cls.status });
  }
}
