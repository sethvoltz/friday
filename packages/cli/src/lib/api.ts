import {
  DAEMON_SECRET_HEADER,
  getDaemonSecret,
  loadConfig,
  resolveDaemonPort,
  resolveDashboardPort,
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
    const p = port ?? resolveDaemonPort(cfg);
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

/**
 * Localhost dashboard HTTP client for the CLI's BetterAuth-owned operations
 * (Capture-key issuance). The apiKey plugin lives in the dashboard process, so
 * key minting/listing/revocation cannot go through the daemon. The CLI has no
 * session cookie, so it hits the loopback + daemon-secret-gated
 * `/api/internal/capture-keys` route (FRI-171/ADR-047) carrying the same
 * shared secret the daemon uses — both the CLI and the dashboard read it off
 * `~/.friday/.daemon-secret`.
 */
export class DashboardClient {
  private base: string;
  constructor(port?: number) {
    const cfg = loadConfig();
    const p = port ?? resolveDashboardPort(cfg);
    this.base = `http://localhost:${p}`;
  }

  private authHeaders(): Record<string, string> {
    return { [DAEMON_SECRET_HEADER]: getDaemonSecret() };
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

  async del<T>(path: string): Promise<T> {
    const r = await fetch(`${this.base}${path}`, {
      method: "DELETE",
      headers: this.authHeaders(),
    });
    if (!r.ok) throw new Error(`DELETE ${path} → ${r.status}`);
    return (await r.json()) as T;
  }
}
