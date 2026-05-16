import {
  DAEMON_SECRET_HEADER,
  getDaemonSecret,
  loadConfig,
} from "@friday/shared";

/**
 * Localhost daemon HTTP client. Authenticates with the same-host shared
 * secret (FIX_FORWARD 5.8) so the daemon's authorizeSameHost-gated routes
 * (including /api/health) accept the CLI's calls.
 */
export class DaemonClient {
  private base: string;
  constructor(port?: number) {
    const cfg = loadConfig();
    const p = port ?? cfg.daemonPort;
    this.base = `http://localhost:${p}`;
  }

  private authHeaders(): Record<string, string> {
    try {
      return { [DAEMON_SECRET_HEADER]: getDaemonSecret() };
    } catch {
      // Daemon-secret file may not yet exist on a totally fresh setup —
      // upstream callers (status / ping) handle the resulting 401 the same
      // way they handle "daemon down".
      return {};
    }
  }

  async get<T>(path: string): Promise<T> {
    const r = await fetch(`${this.base}${path}`, {
      headers: this.authHeaders(),
    });
    if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
    return (await r.json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST ${path} → ${r.status}`);
    return (await r.json()) as T;
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(`${this.base}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`PATCH ${path} → ${r.status}`);
    return (await r.json()) as T;
  }

  async del<T>(path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.base}${path}`, {
      method: "DELETE",
      headers:
        body !== undefined
          ? { "content-type": "application/json", ...this.authHeaders() }
          : this.authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`DELETE ${path} → ${r.status}`);
    return (await r.json()) as T;
  }

  async ping(): Promise<boolean> {
    try {
      const r = await fetch(`${this.base}/api/health`, {
        headers: this.authHeaders(),
      });
      return r.ok;
    } catch {
      return false;
    }
  }
}
