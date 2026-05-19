/**
 * Phase 2 (ADR-024): Zero sync client bound to a Svelte 5 `$state`
 * store. Opens a single WS connection to `zero-cache` (via the JWT
 * minted by `/api/sync/refresh`) and exposes the live `agents` row set
 * as a reactive array.
 *
 * Phase 2 ships only the `agents` slice; Phase 3 layers in additional
 * tables (tickets, schedules, memory, apps, evolve, mail, blocks) by
 * adding queries on this same `Zero` instance and surfacing them via
 * additional reactive properties on the store.
 *
 * Feature flag: `PUBLIC_FRIDAY_USE_ZERO_SIDEBAR=1` (or `true`) flips
 * the sidebar component over to the Zero-driven agent list. Default is
 * still the SSE + REST-poll path so Phase 2 lands behind-the-flag
 * without changing any user-visible behavior.
 */

import { browser } from "$app/environment";
import { Zero } from "@rocicorp/zero";
import { schema, type Schema } from "@friday/shared/sync";
import { chat, type AgentInfo } from "./chat.svelte";

/** Row shape mirrors the `agents` Zero table definition. Kept narrow:
 *  Phase 2 only reads the columns the sidebar needs. */
export interface ZeroAgentRow {
  name: string;
  type: string;
  status: string;
  session_id: string | null;
  created_at: number;
  updated_at: number;
}

interface RefreshResponse {
  token: string;
  deviceId: string;
  expiresAt: number;
}

class ZeroSidebarStore {
  /** Live agent rows from Zero, filtered server-side to non-archived. */
  agents = $state<ZeroAgentRow[]>([]);

  /** Connection status of the underlying Zero client. `pending` until
   *  the first materialization, `live` once a snapshot has been
   *  delivered, `error` when the WS bridge is unhealthy. */
  status = $state<"pending" | "live" | "error">("pending");

  #zero: Zero<Schema> | null = null;
  #unsubscribe: (() => void) | null = null;

  constructor() {
    if (!browser) return;
    if (!useZeroSidebar()) return;
    void this.#init();
  }

  async #init(): Promise<void> {
    try {
      // Mint the first JWT eagerly so the WS handshake succeeds on
      // first connect. The Zero `auth` callback re-fetches on every
      // reconnect — TTL is 15 minutes so the auth callback fires on
      // a long-running session occasionally.
      const r = await fetch("/api/sync/refresh", { method: "POST" });
      if (!r.ok) {
        this.status = "error";
        return;
      }
      const { deviceId } = (await r.json()) as RefreshResponse;
      this.#zero = new Zero<Schema>({
        schema,
        server: zeroServerUrl(),
        auth: refreshToken,
        userID: deviceId,
        kvStore: "mem", // Phase 6 promotes to IDB for offline cache.
      });

      const query = this.#zero.query.agents.where(
        "status",
        "!=",
        "archived",
      );
      // Preload so the query is registered with zero-cache and rows
      // arrive even when no UI is currently observing the materialized
      // view (the listener below subscribes after this point).
      const preload = this.#zero.preload(query);
      // `zero.materialize(query)` is the post-1.5 API; the older
      // `query.materialize()` form is deprecated. Pass the listener
      // arg-style so the callback receives `data` directly (no closure
      // re-read of `.data`).
      const view = this.#zero.materialize(query);
      const update = (data: readonly unknown[]): void => {
        const rows = data as readonly ZeroAgentRow[];
        this.agents = rows as ZeroAgentRow[];
        chat.agents = rows.map(toAgentInfo);
        this.status = "live";
      };
      // Seed from current snapshot then subscribe to deltas.
      update(view.data as readonly unknown[]);
      view.addListener((data) => update(data as readonly unknown[]));

      this.#unsubscribe = () => {
        preload.cleanup();
        view.destroy();
      };
    } catch {
      this.status = "error";
    }
  }

  destroy(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#zero?.close();
    this.#zero = null;
  }
}

/** Convert a Zero row from the `agents` table to the existing
 *  `AgentInfo` shape the sidebar (and the rest of the dashboard)
 *  already consumes. Phase 2: keep the shape compatible so we can
 *  flip the data source without rewriting downstream components. */
function toAgentInfo(r: ZeroAgentRow): AgentInfo {
  return {
    name: r.name,
    type: r.type,
    status: r.status,
    sessionId: r.session_id ?? undefined,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

async function refreshToken(): Promise<string> {
  const r = await fetch("/api/sync/refresh", { method: "POST" });
  if (!r.ok) throw new Error(`refresh failed: ${r.status}`);
  const body = (await r.json()) as RefreshResponse;
  return body.token;
}

function zeroServerUrl(): string {
  // Read at module load — Vite inlines PUBLIC_* env vars at build time.
  // Zero 1.5 expects an http(s) URL (the protocol upgrades to WS during
  // handshake); passing `ws://` throws `must use the "http" or "https"
  // scheme.`
  const env = (
    import.meta as unknown as { env?: Record<string, string | undefined> }
  ).env;
  return env?.PUBLIC_FRIDAY_ZERO_URL ?? "http://localhost:4848";
}

/** Feature flag: opt in to the Zero-driven sidebar. Stays false by
 *  default until Phase 2 ships and we're confident parity is reached. */
export function useZeroSidebar(): boolean {
  if (!browser) return false;
  const env = (
    import.meta as unknown as { env?: Record<string, string | undefined> }
  ).env;
  const raw = env?.PUBLIC_FRIDAY_USE_ZERO_SIDEBAR;
  if (raw === "1" || raw === "true") return true;
  // localStorage override for dev — set
  //   localStorage["friday:flag:use-zero-sidebar"] = "1"
  // and reload to opt in without a rebuild.
  try {
    return localStorage.getItem("friday:flag:use-zero-sidebar") === "1";
  } catch {
    return false;
  }
}

export const zeroSidebar = new ZeroSidebarStore();
