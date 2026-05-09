import { loadConfig } from "@friday/shared";

/**
 * Localhost daemon HTTP client. Auth-free (the OS provides the boundary).
 */
export class DaemonClient {
  private base: string;
  constructor(port?: number) {
    const cfg = loadConfig();
    const p = port ?? cfg.daemonPort;
    this.base = `http://localhost:${p}`;
  }

  async get<T>(path: string): Promise<T> {
    const r = await fetch(`${this.base}${path}`);
    if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
    return (await r.json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST ${path} → ${r.status}`);
    return (await r.json()) as T;
  }

  async ping(): Promise<boolean> {
    try {
      const r = await fetch(`${this.base}/api/health`);
      return r.ok;
    } catch {
      return false;
    }
  }
}
